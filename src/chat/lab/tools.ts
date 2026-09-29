/**
 * Ferramentas MCP do laboratório (register_hypothesis, log_run, read_board, post_finding, declare_result),
 * o trecho de prompt que as explica e o aviso de número sem registro. O hub registra `tools()` no servidor
 * `agents` e chama `checkReport` no relatório final de cada agente.
 *
 * Sem VS Code aqui: o hub passa o diretório do projeto e a função que manda mensagem ao webview.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { LabHypothesisInfo, LabState } from '../protocol';
import { evaluate, fmtNum } from './evaluate';
import { unregistered } from './provenance';
import { Hypothesis, LabStore, Run, Verdict } from './store';

const MAX_RUNS_IN_STATE = 60;

type Text = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (t: string): Text => ({ content: [{ type: 'text', text: t }] });
const fail = (t: string): Text => ({ ...text(t), isError: true });

export class Lab {
  readonly store: LabStore;
  /** Chamado a cada veredito gravado; o hub dispara o verificador independente quando é "suportada". */
  onVerdict?: (h: Hypothesis, v: Verdict, by: string) => string | undefined;
  /** Campos a mais por hipótese no estado do webview (a verificação, em src/chat/parallel). */
  extraInfo?: (h: Hypothesis, v: Verdict | undefined) => Partial<LabHypothesisInfo>;
  /** Hipótese nova gravada (register_hypothesis ou promote_to_hypothesis): contexto e avisos de p-hacking (lab/integrity.ts). */
  onHypothesis?: (h: Hypothesis, by: string) => string | undefined;
  /** Família da correção BH de `h` (lab/integrity.ts). Ausente: hipóteses com o mesmo texto `family`. */
  familyOf?: (h: Hypothesis) => { members: Hypothesis[]; label: string };

  constructor(
    private readonly root: string,
    private readonly post: (state: LabState, initial?: boolean) => void,
  ) {
    this.store = new LabStore(root);
  }

  /** Estado inicial para o webview, se o projeto já tem quadro. */
  postInitial(): void {
    if (this.store.hasData()) {
      this.post(this.state(), true);
    }
  }

  state(): LabState {
    const runs = this.store.runs();
    return {
      hypotheses: this.store.hypotheses().map((h) => this.info(h, runs.filter((r) => r.hypothesisId === h.id))),
      runs: runs.length,
      findings: this.store.findings().length,
    };
  }

  private info(h: Hypothesis, runs: Run[]): LabHypothesisInfo {
    const runCounts: Record<string, number> = {};
    for (const r of runs) {
      runCounts[r.arm] = (runCounts[r.arm] ?? 0) + 1;
    }
    const v = this.store.lastVerdict(h.id);
    const pruned = this.store.pruned(h.id);
    return {
      id: h.id,
      title: h.title,
      statement: h.statement,
      metric: h.metric,
      direction: h.direction,
      minImprovement: h.minImprovement,
      improvementKind: h.improvementKind,
      arms: h.arms,
      minSeeds: h.minSeeds,
      alpha: h.alpha,
      status: this.store.status(h),
      createdBy: h.createdBy,
      createdAt: h.createdAt,
      derivedFrom: h.derivedFrom,
      family: h.family,
      runCounts,
      verdict: v && (({ id: _id, hypothesisId: _h, ...rest }) => rest)(v),
      runs: runs.slice(-MAX_RUNS_IN_STATE).map((r) => ({
        id: r.id,
        arm: r.arm,
        seed: r.seed,
        value: r.metrics[h.metric],
        command: r.command,
        commit: r.commit,
        dirty: r.dirty,
        artifact: r.artifact,
        metricsFileHash: r.metricsFileHash,
        agent: r.agent,
        at: r.at,
        source: r.source,
      })),
      pruned: pruned && { at: pruned.at, by: pruned.by },
      ...this.extraInfo?.(h, v),
    };
  }

  private changed(): void {
    this.post(this.state());
  }

  /**
   * Poda ou restaura uma hipótese (clique do usuário na árvore de hipóteses). Só marca: runs e vereditos ficam,
   * e o read_board passa a mostrar a hipótese como podada.
   */
  setPruned(hypothesisId: string, pruned: boolean, by = 'user'): boolean {
    if (!this.store.hypothesis(hypothesisId) || !!this.store.pruned(hypothesisId) === pruned) {
      return false;
    }
    this.store.setPruned(hypothesisId, pruned, by);
    this.changed();
    return true;
  }

  /** Manda o quadro de novo ao webview (verificação mudou, por exemplo). */
  notify(): void {
    this.changed();
  }

  /**
   * Run registrado pelo próprio host (run_seeds): mesmo caminho do log_run com metrics_file, com o número
   * lido do arquivo, sha256 e commit do diretório onde o comando rodou.
   */
  addHostRun(args: { hypothesisId: string; arm: string; seed: number; command: string; metricsFile: string; workdir: string; agent: string }): Run | Error {
    const h = this.store.hypothesis(args.hypothesisId);
    if (!h) {
      return new Error(`Hipótese "${args.hypothesisId}" não existe.`);
    }
    const read = readMetricsFile(args.metricsFile);
    if (read instanceof Error) {
      return read;
    }
    if (!Number.isFinite(read.metrics[h.metric])) {
      return new Error(`Falta a métrica primária "${h.metric}" em ${args.metricsFile} (achei: ${Object.keys(read.metrics).join(', ') || 'nenhuma'}).`);
    }
    const git = gitInfo(args.workdir);
    const run = this.store.addRun({
      hypothesisId: h.id,
      arm: args.arm,
      seed: args.seed,
      metrics: read.metrics,
      samples: read.samples,
      command: args.command,
      commit: git.commit,
      dirty: git.dirty,
      artifact: path.relative(this.root, args.metricsFile),
      metricsFileHash: read.hash,
      source: 'arquivo',
      agent: args.agent,
    });
    this.changed();
    return run;
  }

  // ---------- Prompt ----------

  guide(isMain: boolean): string[] {
    if (isMain) {
      return [
        'Laboratório (servidor "agents"): quadro de experimentos do projeto em .agm/lab/. Todo número de resultado tem origem registrada, e conclusão comparativa passa por uma porta estatística, não pela sua opinião.',
        '- Fluxo de um experimento: 1) register_hypothesis antes de rodar qualquer coisa, com métrica primária, direção, melhora mínima, os dois braços (baseline e variante) e seeds mínimas por braço. 2) Crie agentes que rodam os braços com seeds diferentes, com o mesmo script e o mesmo avaliador; cada execução vira um log_run. O melhor é o script gravar um JSON de métricas e o agente passar metrics_file: aí o número vem do arquivo, não do texto do modelo. 3) declare_result({ hypothesis_id }) devolve suportada, inconclusiva ou refutada, com IC, p ajustado e seeds que faltam. 4) post_finding anota o que se aprendeu, ligado aos runs.',
        '- Métrica e critério não mudam depois de registrados. Para mudar, registre outra hipótese com derived_from; a família (mesmo ramo) cresce e a correção de múltiplas comparações fica mais exigente. É de propósito.',
        '- Só cite número de resultado que esteja num log_run ou num veredito de declare_result. Afirmação do tipo "A é melhor que B" só depois de declare_result, e com o veredito dele.',
        '- Inconclusiva não é refutada. Diga ao usuário quantas seeds faltam (o veredito estima) e pergunte se vale gastar mais antes de rodar.',
        '- Resultado bom demais (efeito enorme, variância zero, salto que ninguém esperava) merece verificação antes de ser comunicado: vazamento entre treino e teste, bug no avaliador, cache, seeds que não mudam nada. O veredito avisa quando vê esses sinais.',
        '- read_board mostra o quadro (filtre por hypothesis_id para ver os runs com comando e commit).',
        '- experiment_report({ scope, id? }) grava e abre um relatório em Markdown só com dados registrados (hipótese, ramo ou esta conversa). Quando o usuário pedir um relatório de experimento, use ele em vez de escrever os números você mesmo.',
        '- O laboratório avisa troca de métrica depois de um resultado ruim, muitas hipóteses sem ordem pré-registrada e declare_result repetido com mais seeds. Leve o aviso ao usuário; a família da correção BH já conta todas as hipóteses da conversa e do ramo.',
      ];
    }
    return [
      'Laboratório (servidor "agents"): se a tarefa envolve experimento ou medição, registre cada execução com log_run (hypothesis_id, arm, seed, command, e metrics_file com o JSON que o script gravou, ou metrics). Uma execução por seed; não invente seed nem valor.',
      '- Seu relatório só pode citar número de resultado que esteja registrado com log_run ou num veredito de declare_result. Relatório com número sem registro recebe um aviso automático.',
      '- Conclusão comparativa ("A é melhor que B") só com declare_result. Métrica e critério de uma hipótese registrada não mudam; read_board mostra o quadro.',
    ];
  }

  // ---------- Proveniência ----------

  /** Acrescenta o aviso quando o relatório cita número que não está no quadro. */
  checkReport(agentId: string, report: string): string {
    if (!report || !this.store.hasData()) {
      return report;
    }
    const known: number[] = [];
    for (const r of this.store.runs()) {
      // Trial de varredura foi medido pelo hub, não declarado por um agente: qualquer um pode citar.
      if (r.agent === agentId || r.trial !== undefined) {
        known.push(...Object.values(r.metrics));
      }
    }
    known.push(...this.store.verdicts().flatMap(verdictNumbers));
    for (const h of this.store.hypotheses()) {
      known.push(h.minImprovement, h.alpha);
    }
    const loose = unregistered(report, known.filter((x) => typeof x === 'number'));
    if (!loose.length) {
      return report;
    }
    const shown = loose.slice(0, 8).join(', ') + (loose.length > 8 ? ` e mais ${loose.length - 8}` : '');
    return `${report}\n\n> Aviso do laboratório: número sem registro (${shown}). Não aparece em log_run deste agente nem em veredito do quadro; trate como não verificado.`;
  }

  // ---------- Ferramentas ----------

  tools(callerId: string): SdkMcpToolDefinition<any>[] {
    return [
      tool(
        'register_hypothesis',
        'Pré-registra uma hipótese no quadro do laboratório, antes de rodar o experimento. Métrica primária, direção, critério e braços ficam congelados: para mudar, registre outra com derived_from.',
        {
          title: z.string().describe('Título curto'),
          statement: z.string().describe('Enunciado: o que se espera observar e por quê'),
          metric: z.string().describe('Nome da métrica primária, igual ao usado no log_run (ex.: "accuracy", "tempo_ms")'),
          direction: z.enum(['higher', 'lower']).describe('"higher": maior é melhor; "lower": menor é melhor'),
          min_improvement: z.number().min(0).optional().describe('Melhora mínima para contar como sucesso, no sentido da direção. Omitido: 0 (qualquer melhora significativa)'),
          improvement_kind: z.enum(['absolute', 'relative']).optional().describe('"absolute" (padrão): na unidade da métrica; "relative": fração da média do baseline (0.05 = 5%)'),
          baseline_arm: z.string().optional().describe('Nome do braço de referência. Omitido: "baseline"'),
          variant_arm: z.string().optional().describe('Nome do braço testado. Omitido: "variante"'),
          min_seeds: z.number().int().min(2).max(200).optional().describe('Seeds mínimas por braço antes de qualquer conclusão. Omitido: 5'),
          alpha: z.number().gt(0).lt(0.5).optional().describe('Nível de significância depois da correção BH. Omitido: 0.05'),
          max_runs: z.number().int().min(1).optional().describe('Orçamento: total de runs aceitos nesta hipótese'),
          budget_note: z.string().optional().describe('Orçamento em texto livre (tempo, GPU, custo)'),
          family: z.string().optional().describe('Família para a correção de múltiplas comparações. Omitido: o ramo git atual'),
          derived_from: z.string().optional().describe('Id da hipótese que esta ajusta (ex.: "h3")'),
        },
        async (args) => {
          const baseline = (args.baseline_arm ?? 'baseline').trim();
          const variant = (args.variant_arm ?? 'variante').trim();
          if (!baseline || !variant || baseline === variant) {
            return fail('Os dois braços precisam de nomes diferentes e não vazios.');
          }
          if (args.derived_from && !this.store.hypothesis(args.derived_from)) {
            return fail(`Hipótese "${args.derived_from}" não existe. Use read_board.`);
          }
          const h = this.store.addHypothesis({
            title: args.title.trim(),
            statement: args.statement.trim(),
            metric: args.metric.trim(),
            direction: args.direction,
            minImprovement: args.min_improvement ?? 0,
            improvementKind: args.improvement_kind ?? 'absolute',
            arms: [baseline, variant],
            minSeeds: args.min_seeds ?? 5,
            alpha: args.alpha ?? 0.05,
            budget: args.max_runs || args.budget_note ? { maxRuns: args.max_runs, note: args.budget_note } : undefined,
            family: args.family?.trim() || gitBranch(this.root) || 'padrão',
            derivedFrom: args.derived_from,
            createdBy: callerId,
          });
          const integrity = this.onHypothesis?.(h, callerId);
          this.changed();
          return text(
            `Hipótese ${h.id} registrada: "${h.title}". Métrica ${h.metric} (${h.direction === 'higher' ? 'maior' : 'menor'} é melhor), melhora mínima ${h.minImprovement}${h.improvementKind === 'relative' ? ' relativa' : ''}, braços ${h.arms[0]} x ${h.arms[1]}, ${h.minSeeds} seeds por braço, alpha ${h.alpha}, família "${h.family}". Registre cada execução com log_run({ hypothesis_id: "${h.id}", arm, seed, ... }).${integrity ? `\n${integrity}` : ''}`,
          );
        },
        { alwaysLoad: true },
      ),
      tool(
        'log_run',
        'Registra uma execução de um braço com uma seed: métricas, comando, commit e artefato. Prefira metrics_file (JSON gravado pelo script): o host lê o número do arquivo e guarda o hash.',
        {
          hypothesis_id: z.string(),
          arm: z.string().describe('Um dos dois braços da hipótese'),
          seed: z.number().int(),
          command: z.string().describe('Comando exato que rodou'),
          // z.record quebra a conversão de schema do SDK (e derruba o servidor inteiro): lista de pares.
          metrics: z
            .array(z.object({ name: z.string(), value: z.number() }))
            .optional()
            .describe('Métricas, se não houver metrics_file: [{ "name": "accuracy", "value": 0.9 }]'),
          metrics_file: z
            .string()
            .optional()
            .describe('JSON gravado pelo experimento: {"accuracy": 0.9} ou {"metrics": {...}, "samples": {"accuracy": [1,0,1,...]}}. Relativo a workdir ou ao projeto'),
          samples: z
            .array(z.object({ name: z.string(), values: z.array(z.number()) }))
            .optional()
            .describe('Valores por amostra de uma métrica, alinhados entre braços e seeds (habilita o teste pareado): [{ "name": "accuracy", "values": [1, 0, 1] }]'),
          artifact: z.string().optional().describe('Caminho do log ou artefato'),
          commit: z.string().optional().describe('Commit git do código que rodou. Omitido: lido do repositório'),
          workdir: z.string().optional().describe('Pasta onde o comando rodou (worktree, por exemplo), para achar o commit e o metrics_file'),
        },
        async (args) => {
          const h = this.store.hypothesis(args.hypothesis_id);
          if (!h) {
            return fail(`Hipótese "${args.hypothesis_id}" não existe. Registre com register_hypothesis ou veja read_board.`);
          }
          if (!h.arms.includes(args.arm)) {
            return fail(`Braço "${args.arm}" não é desta hipótese. Braços registrados: ${h.arms.join(', ')}.`);
          }
          const existing = this.store.runs(h.id);
          if (h.budget?.maxRuns && existing.length >= h.budget.maxRuns) {
            return fail(`Orçamento esgotado: a hipótese ${h.id} aceita ${h.budget.maxRuns} runs e já tem ${existing.length}.`);
          }
          const workdir = args.workdir ? path.resolve(this.root, args.workdir) : this.root;
          const given = Object.fromEntries((args.metrics ?? []).map((m) => [m.name.trim(), m.value]));
          let metrics: Record<string, number> = { ...given };
          let samples = args.samples?.length ? Object.fromEntries(args.samples.map((x) => [x.name.trim(), x.values])) : undefined;
          let metricsFileHash: string | undefined;
          let artifact = args.artifact;
          if (args.metrics_file) {
            const read = readMetricsFile(path.resolve(workdir, args.metrics_file));
            if (read instanceof Error) {
              return fail(read.message);
            }
            metrics = { ...metrics, ...read.metrics };
            samples = read.samples ?? samples;
            metricsFileHash = read.hash;
            artifact ??= path.relative(this.root, path.resolve(workdir, args.metrics_file));
            if (Object.entries(given).some(([k, v]) => k in read.metrics && read.metrics[k] !== v)) {
              return fail('metrics contradiz o metrics_file. Passe só o arquivo: o número registrado vem dele.');
            }
          }
          if (!Number.isFinite(metrics[h.metric])) {
            return fail(`Falta a métrica primária "${h.metric}" (recebi: ${Object.keys(metrics).join(', ') || 'nenhuma'}).`);
          }
          const git = gitInfo(workdir);
          const run = this.store.addRun({
            hypothesisId: h.id,
            arm: args.arm,
            seed: args.seed,
            metrics,
            samples,
            command: args.command,
            commit: args.commit ?? git.commit,
            dirty: args.commit ? undefined : git.dirty,
            artifact,
            metricsFileHash,
            source: metricsFileHash ? 'arquivo' : 'declarado',
            agent: callerId,
          });
          const dup = existing.some((r) => r.arm === run.arm && r.seed === run.seed);
          const perArm = h.arms.map((a) => `${a} ${new Set([...existing, run].filter((r) => r.arm === a).map((r) => r.seed)).size}/${h.minSeeds}`).join(', ');
          this.changed();
          return text(
            `Run ${run.id} registrado (${h.id}, ${run.arm}, seed ${run.seed}, ${h.metric} = ${metrics[h.metric]}${metricsFileHash ? `, lido de ${artifact}` : ''}${run.commit ? `, commit ${run.commit.slice(0, 10)}${run.dirty ? ' com alterações não commitadas' : ''}` : ''}). Seeds por braço: ${perArm}.${dup ? ' Esta seed já tinha run neste braço: vale a última.' : ''}`,
          );
        },
        { alwaysLoad: true },
      ),
      tool(
        'read_board',
        'Resumo do quadro do laboratório: hipóteses, status, vereditos e runs. Com hypothesis_id, mostra os runs com comando e commit.',
        {
          hypothesis_id: z.string().optional(),
          status: z.enum(['registrada', 'rodando', 'concluída', 'inconclusiva', 'refutada']).optional(),
          agent: z.string().optional().describe('Só runs deste agente'),
        },
        async (args) => text(this.board(args)),
        { alwaysLoad: true },
      ),
      tool(
        'post_finding',
        'Anota um achado curto no quadro, ligado aos runs que o sustentam.',
        {
          text: z.string().describe('O achado, em uma ou duas frases'),
          run_ids: z.array(z.string()).min(1).describe('Runs que sustentam o achado (ex.: ["r3", "r4"])'),
          hypothesis_id: z.string().optional(),
        },
        async (args) => {
          const known = new Set(this.store.runs().map((r) => r.id));
          const missing = args.run_ids.filter((id) => !known.has(id));
          if (missing.length) {
            return fail(`Runs inexistentes: ${missing.join(', ')}. Achado precisa apontar para runs registrados.`);
          }
          if (args.hypothesis_id && !this.store.hypothesis(args.hypothesis_id)) {
            return fail(`Hipótese "${args.hypothesis_id}" não existe.`);
          }
          const f = this.store.addFinding({ text: args.text.trim(), runIds: args.run_ids, hypothesisId: args.hypothesis_id, agent: callerId });
          this.changed();
          const linked = this.store.runs().filter((r) => args.run_ids.includes(r.id)).flatMap((r) => Object.values(r.metrics));
          const unreg = unregistered(f.text, [...linked, ...this.store.verdicts().flatMap(verdictNumbers)]);
          return text(`Achado ${f.id} registrado.${unreg.length ? ` Atenção: o texto cita ${unreg.join(', ')}, que não está nos runs ligados.` : ''}`);
        },
        { alwaysLoad: true },
      ),
      tool(
        'declare_result',
        'Roda a estatística da hipótese (IC por bootstrap, efeito, correção Benjamini-Hochberg na família, poder) e grava o veredito: suportada, inconclusiva ou refutada. Única forma de concluir uma comparação.',
        { hypothesis_id: z.string() },
        async (args) => {
          const h = this.store.hypothesis(args.hypothesis_id);
          if (!h) {
            return fail(`Hipótese "${args.hypothesis_id}" não existe.`);
          }
          if (h.sweepId) {
            return fail(
              `${h.id} é a hipótese exploratória da varredura ${h.sweepId}: guarda os trials, não compara braços. Para afirmar melhora, registre uma hipótese confirmatória (melhores parâmetros contra o baseline, várias seeds) e declare o resultado dela.`,
            );
          }
          // A família inclui as hipóteses da mesma conversa, ramo ou derivação (lab/integrity.ts), não só o mesmo texto `family`.
          const fam = this.familyOf?.(h) ?? { members: this.store.hypotheses().filter((o) => o.family === h.family), label: h.family };
          const family = fam.members.map((o) => ({ id: o.id, p: numberOr(this.store.lastVerdict(o.id)?.p) }));
          const v = this.store.addVerdict(evaluate({ ...h, family: fam.label }, this.store.runs(h.id), family, { by: callerId, attempt: this.store.verdicts(h.id).length + 1 }));
          const verifying = this.onVerdict?.(h, v, callerId);
          this.changed();
          return text(`${formatVerdict(h, v)}${typeof verifying === 'string' ? `\n${verifying}` : ''}`);
        },
        { alwaysLoad: true },
      ),
    ];
  }

  private board(filter: { hypothesis_id?: string; status?: string; agent?: string }): string {
    const all = this.store.hypotheses();
    if (!all.length) {
      return 'Quadro vazio. Registre uma hipótese com register_hypothesis.';
    }
    const picked = all.filter((h) => (!filter.hypothesis_id || h.id === filter.hypothesis_id) && (!filter.status || this.store.status(h) === filter.status));
    if (!picked.length) {
      return 'Nenhuma hipótese com esse filtro.';
    }
    const lines: string[] = [];
    for (const h of picked) {
      const runs = this.store.runs(h.id).filter((r) => !filter.agent || r.agent === filter.agent);
      const v = this.store.lastVerdict(h.id);
      const counts = h.arms.map((a) => `${a} ${runs.filter((r) => r.arm === a).length}`).join(', ');
      lines.push(
        `${h.id} | ${h.title} | ${this.store.status(h)} | ${h.metric} (${h.direction === 'higher' ? 'maior' : 'menor'} é melhor), melhora mínima ${h.minImprovement}${h.improvementKind === 'relative' ? ' relativa' : ''} | runs: ${counts} (mínimo ${h.minSeeds} seeds) | família ${h.family}${h.derivedFrom ? ` | derivada de ${h.derivedFrom}` : ''}${this.store.pruned(h.id) ? ' | podada pelo usuário (não gaste mais runs aqui sem pedir)' : ''}`,
      );
      if (v) {
        lines.push(`   veredito: ${v.verdict}, diferença ${fmtNum(v.diff)} IC95% [${fmtNum(v.ci[0])}, ${fmtNum(v.ci[1])}], p ajustado ${fmtNum(v.pAdjusted)} (tentativa ${v.attempt})`);
      }
      if (filter.hypothesis_id) {
        for (const r of runs) {
          lines.push(
            `   ${r.id} ${r.arm} seed ${r.seed}: ${Object.entries(r.metrics).map(([k, x]) => `${k}=${x}`).join(' ')} | ${r.source} | ${r.command ?? '-'} | commit ${r.commit?.slice(0, 10) ?? '-'}${r.dirty ? '+sujo' : ''} | ${r.agent}`,
          );
        }
        const findings = this.store.findings().filter((f) => f.hypothesisId === h.id);
        for (const f of findings) {
          lines.push(`   achado ${f.id}: ${f.text} (runs ${f.runIds.join(', ')})`);
        }
      }
    }
    return lines.join('\n');
  }
}

/** Números de um veredito que podem ser citados: diferença, IC, efeito, p, critério, médias e desvios. */
function verdictNumbers(v: Verdict): number[] {
  return [v.diff, v.relDiff ?? NaN, ...v.ci, v.effect, v.p, v.pAdjusted, v.threshold, ...v.arms.flatMap((a) => [a.mean, a.sd])];
}

function numberOr(x: number | null | undefined): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
}

export function formatVerdict(h: Hypothesis, v: Verdict): string {
  const [b, va] = v.arms;
  const arm = (a: typeof b) => `${a.arm}: n=${a.n}, média ${fmtNum(a.mean)} ± ${fmtNum(a.sd)}`;
  return [
    `Veredito de ${h.id} ("${h.title}"): ${v.verdict.toUpperCase()}`,
    `${arm(b)} | ${arm(va)}`,
    `Diferença (${va.arm} - ${b.arm}, positivo = melhora em ${h.metric}): ${fmtNum(v.diff)}${v.relDiff !== undefined && v.relDiff !== null ? ` (${fmtNum(v.relDiff * 100)}% do baseline)` : ''}, IC 95% bootstrap ${v.mode === 'paired-samples' ? 'pareado por amostra' : 'por seed'} [${fmtNum(v.ci[0])}, ${fmtNum(v.ci[1])}]`,
    `Efeito ${v.mode === 'seeds' ? 'd de Cohen' : 'd_z'} ${fmtNum(v.effect)}; p ${fmtNum(v.p)}, p ajustado BH ${fmtNum(v.pAdjusted)} (família "${v.family}", ${v.familySize} hipótese(s))`,
    ...v.reasons.map((r) => `- ${r}`),
    ...(v.seedsMissing !== undefined && v.verdict === 'inconclusiva' ? [`Seeds que faltam por braço (estimativa, poder 80%): ${v.seedsMissing}`] : []),
    ...v.warnings.map((w) => `Atenção: ${w}`),
    `Gravado como ${v.id} em .agm/lab/verdicts.jsonl. Cite estes números, não outros.`,
  ].join('\n');
}

export function readMetricsFile(file: string): { metrics: Record<string, number>; samples?: Record<string, number[]>; hash: string } | Error {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return new Error(`Não achei o metrics_file ${file}.`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return new Error(`metrics_file ${file} não é JSON válido.`);
  }
  if (!data || typeof data !== 'object') {
    return new Error(`metrics_file ${file} precisa ser um objeto JSON.`);
  }
  const obj = data as Record<string, unknown>;
  const src = obj.metrics && typeof obj.metrics === 'object' ? (obj.metrics as Record<string, unknown>) : obj;
  const metrics: Record<string, number> = {};
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      metrics[k] = v;
    }
  }
  let samples: Record<string, number[]> | undefined;
  if (obj.samples && typeof obj.samples === 'object') {
    samples = {};
    for (const [k, v] of Object.entries(obj.samples as Record<string, unknown>)) {
      if (Array.isArray(v) && v.every((x) => typeof x === 'number')) {
        samples[k] = v as number[];
      }
    }
  }
  return { metrics, samples, hash: createHash('sha256').update(raw).digest('hex').slice(0, 16) };
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
  } catch {
    return undefined;
  }
}

export function gitInfo(cwd: string): { commit?: string; dirty?: boolean } {
  const commit = git(cwd, ['rev-parse', 'HEAD']);
  if (!commit) {
    return {};
  }
  return { commit, dirty: !!git(cwd, ['status', '--porcelain', '--untracked-files=no']) };
}

export function gitBranch(cwd: string): string | undefined {
  const b = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return b && b !== 'HEAD' ? b : undefined;
}
