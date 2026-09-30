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
import { readLockboxes } from '../guard/lockbox';
import { DEFAULT_MIN_UNITS, evaluate, fmtNum, PAIRED_SEEDS_MIN, pairedHint, pairedSeedsMin, readyToDeclare } from './evaluate';
import { checkRows, readPredictionsFile, rowsFromSamples, rowsMetric } from './paired';
import { aggregates, fileNumbers, textNumbers, unregistered } from './provenance';
import { ROW_METRIC_DIRECTION, ROW_METRICS, type RowMetric } from './stats';
import { Hypothesis, isSingleEval, LabStore, Run, RunRows, singleResult, Verdict } from './store';

const MAX_RUNS_IN_STATE = 60;
/** Id do chat principal no hub (MAIN_ID em hub.ts; importar de lá faria ciclo). */
export const MAIN_CALLER = 'main';
/** Braço único da hipótese de avaliação única (o cofre). */
export const SINGLE_ARM = 'cofre';

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
  /**
   * Conversa atual e conversa em que cada hipótese foi registrada (lab/reportHost.ts liga ao integrity). O quadro é do
   * projeto e o id de agente recomeça em a1 a cada conversa: sem isso, o a1 de hoje herdaria as hipóteses do a1 de ontem.
   */
  currentConversation?: () => string;
  conversationOf?: (h: Hypothesis) => string | undefined;
  /** Quando a conversa atual abriu nesta janela (ISO): avaliação do cofre desde então é desta conversa. */
  conversationSince?: string;

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
    if (isSingleEval(h)) {
      return new Error(singleRefusal(h));
    }
    const read = readMetricsFile(args.metricsFile);
    if (read instanceof Error) {
      return read;
    }
    if (!Number.isFinite(read.metrics[h.metric])) {
      return new Error(`Falta a métrica primária "${h.metric}" em ${args.metricsFile} (achei: ${Object.keys(read.metrics).join(', ') || 'nenhuma'}).`);
    }
    const git = gitInfo(args.workdir, args.command, [args.metricsFile]);
    const run = this.store.addRun({
      hypothesisId: h.id,
      arm: args.arm,
      seed: args.seed,
      metrics: read.metrics,
      samples: read.samples,
      command: args.command,
      commit: git.commit,
      dirty: git.dirty,
      dirtyFiles: git.dirtyFiles,
      artifact: path.relative(this.root, args.metricsFile),
      metricsFileHash: read.hash,
      source: 'arquivo',
      agent: args.agent,
    });
    this.changed();
    return run;
  }

  /**
   * Resultado de uma avaliação do cofre (lockbox_evaluate), gravado pelo guard como run da hipótese de avaliação
   * única. `metrics`: números da última linha JSON da saída. ok false (com o motivo em note) se a hipótese não existe,
   * não é de avaliação única ou a métrica primária não veio.
   */
  addLockboxRun(a: { hypothesisId: string; lockboxId: string; evalId: string; command: string; metrics: Record<string, number>; stdoutHash: string; agent: string }): { ok: boolean; note?: string } {
    const h = this.store.hypothesis(a.hypothesisId);
    if (!h) {
      return { ok: false, note: `a hipótese ${a.hypothesisId} não existe no quadro; o resultado não virou run.` };
    }
    if (!isSingleEval(h)) {
      return { ok: false, note: `${h.id} compara braços (${comparisonLabel(h)}); só hipótese de avaliação única (comparison "single") recebe o resultado do cofre como run.` };
    }
    const metrics = Object.fromEntries(Object.entries(a.metrics).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)));
    if (!Number.isFinite(metrics[h.metric])) {
      return { ok: false, note: `a saída do cofre não trouxe a métrica primária "${h.metric}" (achei: ${Object.keys(metrics).join(', ') || 'nenhuma'}); o resultado não virou run.` };
    }
    const git = gitInfo(this.root, a.command);
    const run = this.store.addRun({
      hypothesisId: h.id,
      arm: h.arms[0],
      seed: 0,
      metrics,
      command: a.command,
      commit: git.commit,
      dirty: git.dirty,
      dirtyFiles: git.dirtyFiles,
      artifact: `lockbox:${a.lockboxId}/${a.evalId}`,
      metricsFileHash: a.stdoutHash.slice(0, 16),
      source: 'arquivo',
      agent: a.agent,
      lockbox: { id: a.lockboxId, evalId: a.evalId },
    });
    this.changed();
    const { result, extras } = singleResult(this.store.runs(h.id));
    return {
      ok: true,
      note:
        result && result.id !== run.id
          ? `registrado como run ${run.id} da ${h.id}, avaliação extra ${extras.length} (${h.metric} = ${metrics[h.metric]}). O resultado da hipótese continua sendo o da primeira avaliação, ${result.id}.`
          : `registrado como run ${run.id} da ${h.id} (${h.metric} = ${metrics[h.metric]}); é o resultado da hipótese.`,
    };
  }

  /**
   * Hipóteses registradas por `agentId` nesta conversa que já têm runs para declare_result (evaluate.ts,
   * readyToDeclare) e nenhum veredito. Podada, varredura e avaliação única ficam de fora.
   */
  staleHypotheses(agentId: string): Hypothesis[] {
    return this.store
      .hypotheses()
      .filter((h) => h.createdBy === agentId && this.inThisConversation(h) && !this.store.lastVerdict(h.id) && !this.store.pruned(h.id) && readyToDeclare(h, this.store.runs(h.id)));
  }

  /** Registrada nesta conversa. Sem o gancho (teste, quadro sem reportHost), vale o id do agente sozinho. */
  private inThisConversation(h: Hypothesis): boolean {
    if (!this.currentConversation) {
      return true;
    }
    const now = this.currentConversation();
    return !!now && this.conversationOf?.(h) === now;
  }

  /**
   * Métricas das avaliações do cofre desta conversa: só a última linha JSON da saída (`metrics`), nunca os números
   * soltos do texto. Desta conversa: a hipótese avaliada foi registrada nela, ou a avaliação é de depois que ela abriu.
   */
  private lockboxMetrics(): number[] {
    let list: ReturnType<typeof readLockboxes>;
    try {
      list = readLockboxes(this.root);
    } catch {
      return [];
    }
    const out: number[] = [];
    for (const lb of list) {
      for (const e of lb.evaluations) {
        const h = e.hypothesisId ? this.store.hypothesis(e.hypothesisId) : undefined;
        const here = (h && this.currentConversation && this.inThisConversation(h)) || (!!this.conversationSince && e.at >= this.conversationSince) || (!this.currentConversation && !this.conversationSince);
        if (here && e.metrics) {
          out.push(...Object.values(e.metrics).filter((x) => typeof x === 'number'));
        }
      }
    }
    return out;
  }

  private reminded = new Set<string>();

  /**
   * Lembrete de fim de turno para o hub: texto curto sobre as hipóteses esquecidas de `agentId` que ainda não foram
   * lembradas nesta sessão, ou undefined. Cada hipótese é lembrada uma vez só, então o hub pode chamar a cada turno
   * sem segurar o relatório indefinidamente.
   */
  takeStaleReminder(agentId: string): string | undefined {
    const fresh = this.staleHypotheses(agentId).filter((h) => !this.reminded.has(`${agentId}:${h.id}`));
    if (!fresh.length) {
      return undefined;
    }
    for (const h of fresh) {
      this.reminded.add(`${agentId}:${h.id}`);
    }
    return staleReminder(fresh, (h) => this.store.runs(h.id));
  }

  // ---------- Prompt ----------

  guide(isMain: boolean): string[] {
    if (isMain) {
      return [
        'Laboratório (servidor "agents"): quadro de experimentos do projeto em .agm/lab/. Todo número de resultado tem origem registrada, e conclusão comparativa passa por uma porta estatística, não pela sua opinião.',
        '- Fluxo de um experimento: 1) register_hypothesis antes de rodar qualquer coisa, com métrica primária, direção, melhora mínima, os dois braços (baseline e variante) e seeds mínimas por braço. 2) Crie agentes que rodam os braços com seeds diferentes, com o mesmo script e o mesmo avaliador; cada execução vira um log_run. O melhor é o script gravar um JSON de métricas e o agente passar metrics_file: aí o número vem do arquivo, não do texto do modelo. 3) declare_result({ hypothesis_id }) devolve suportada, inconclusiva ou refutada, com IC, p ajustado e seeds que faltam. 4) post_finding anota o que se aprendeu, ligado aos runs.',
        '- Modelo treinado e congelado (tabular, predição determinística): seeds não medem a incerteza, o conjunto de avaliação mede. Registre com comparison: "paired_bootstrap", row_metric ("auc", "mean", "accuracy", "brier" ou "logloss") e unit (o que agrupa linhas correlacionadas: paciente, cliente, dia). Cada braço tem um log_run só, com predictions_file (CSV ou JSON com id, unit, label, score, as mesmas linhas nos dois braços). O host calcula a métrica, pareia as linhas pelo id e faz o IC reamostrando unidades inteiras; o p entra na mesma família BH e o veredito pode sair "suportada" com um run por braço. Use seeds quando o treino é o que varia (inicialização, amostragem, dropout); use o pareado quando a pergunta é "este modelo pronto é melhor que aquele neste conjunto".',
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
      '- Modelo congelado (predição determinística): a hipótese usa comparison "paired_bootstrap". Aí basta um log_run por braço, com predictions_file (CSV ou JSON com id, unit, label, score; as mesmas linhas nos dois braços); não invente seeds para preencher.',
      '- As ferramentas do laboratório (register_hypothesis, log_run, read_board, post_finding, declare_result, experiment_report) não vêm carregadas: quando precisar, carregue com ToolSearch("select:mcp__agents__log_run,mcp__agents__read_board"), trocando pelos nomes que for usar.',
    ];
  }

  // ---------- Proveniência ----------

  /**
   * Acrescenta o aviso quando o relatório cita número que não está no quadro. `briefing`: o prompt que o agente
   * recebeu; número que já estava lá é parâmetro dado, não resultado dele.
   */
  checkReport(agentId: string, report: string, ctx: { briefing?: string } = {}): string {
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
      const own = h.createdBy === agentId && this.inThisConversation(h);
      known.push(h.minImprovement, h.alpha, ...runAggregates(h, this.store.runs(h.id), { own, agent: agentId }));
    }
    // Avaliações do cofre desta conversa: só as métricas da última linha JSON.
    known.push(...this.lockboxMetrics());
    known.push(...textNumbers(ctx.briefing));
    // Número de um JSON/CSV que o próprio relatório aponta pelo caminho: o leitor confere no arquivo.
    known.push(...fileNumbers(this.root, report).numbers);
    const loose = unregistered(report, known.filter((x) => typeof x === 'number'));
    if (!loose.length) {
      return report;
    }
    const shown = loose.slice(0, 8).join(', ') + (loose.length > 8 ? ` e mais ${loose.length - 8}` : '');
    return `${report}\n\n> Aviso do laboratório: número sem registro (${shown}). Não aparece em log_run deste agente, em agregado de runs (média, soma, mínimo, máximo, mediana), em veredito do quadro, em avaliação do cofre, no prompt do agente nem em arquivo JSON/CSV citado no relatório; trate como não verificado.`;
  }

  // ---------- Ferramentas ----------

  tools(callerId: string): SdkMcpToolDefinition<any>[] {
    // Só o chat principal carrega os schemas de cara; subagente acha as ferramentas com ToolSearch (guide(false) avisa).
    const load = { alwaysLoad: callerId === MAIN_CALLER };
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
          comparison: z
            .enum(['seeds', 'paired_bootstrap', 'paired_seeds', 'single'])
            .optional()
            .describe(
              '"seeds" (padrão): vários runs por braço, um valor por seed, braços independentes. "paired_seeds": a seed é a instância (solver ou avaliação determinística, as mesmas instâncias nos dois braços); um log_run escalar por seed em cada braço, pareado pela seed, bootstrap sobre as seeds em comum; min_seeds é o mínimo de seeds em comum. "paired_bootstrap": um modelo congelado por braço, avaliado nas mesmas linhas; cada log_run leva predictions_file e o IC vem de reamostrar unidades. Uma execução por braço basta. "single": avaliação única (cofre), sem braços nem declare_result; o resultado do lockbox_evaluate vira o run',
            ),
          row_metric: z
            .enum(ROW_METRICS as [RowMetric, ...RowMetric[]])
            .optional()
            .describe('Só no paired_bootstrap: como a métrica sai das linhas. "auc" (label 0/1 e score), "mean" (média do score, que já é a métrica da linha), "accuracy" (score >= 0.5 contra label), "brier", "logloss". Omitido: "mean"'),
          unit: z.string().optional().describe('Só no paired_bootstrap e no paired_seeds: o que é uma unidade (paciente, cliente, dia; no paired_seeds, o que a seed identifica, como "instância"). Linhas da mesma unidade são reamostradas juntas'),
          min_units: z.number().int().min(2).optional().describe(`Só no paired_bootstrap: unidades mínimas em comum antes de concluir. Omitido: ${DEFAULT_MIN_UNITS}`),
        },
        async (args) => {
          const paired = args.comparison === 'paired_bootstrap';
          const pairedSeeds = args.comparison === 'paired_seeds';
          const single = args.comparison === 'single';
          const rowMetric = args.row_metric ?? 'mean';
          if (!paired && (args.row_metric || args.min_units)) {
            return fail('row_metric e min_units só valem com comparison: "paired_bootstrap".');
          }
          if (args.unit && !paired && !pairedSeeds) {
            return fail('unit só vale com comparison "paired_bootstrap" ou "paired_seeds".');
          }
          if (single && (args.baseline_arm || args.variant_arm || args.min_seeds)) {
            return fail('Avaliação única (comparison "single") não tem braços nem min_seeds: registre sem baseline_arm, variant_arm e min_seeds.');
          }
          const natural = ROW_METRIC_DIRECTION[rowMetric];
          if (paired && natural && natural !== args.direction) {
            return fail(`row_metric "${rowMetric}" é ${natural === 'higher' ? 'maior' : 'menor'} é melhor; a direção "${args.direction}" contradiz.`);
          }
          const baseline = single ? SINGLE_ARM : (args.baseline_arm ?? 'baseline').trim();
          const variant = single ? SINGLE_ARM : (args.variant_arm ?? 'variante').trim();
          if (!single && (!baseline || !variant || baseline === variant)) {
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
            minSeeds: paired || single ? 1 : (args.min_seeds ?? 5),
            alpha: args.alpha ?? 0.05,
            budget: args.max_runs || args.budget_note ? { maxRuns: args.max_runs, note: args.budget_note } : undefined,
            family: args.family?.trim() || gitBranch(this.root) || 'padrão',
            derivedFrom: args.derived_from,
            createdBy: callerId,
            ...(paired ? { comparison: 'paired_bootstrap' as const, rowMetric, unit: args.unit?.trim() || undefined, minUnits: args.min_units ?? DEFAULT_MIN_UNITS } : {}),
            ...(pairedSeeds ? { comparison: 'paired_seeds' as const, unit: args.unit?.trim() || undefined } : {}),
            ...(single ? { comparison: 'single' as const } : {}),
          });
          const integrity = this.onHypothesis?.(h, callerId);
          this.changed();
          if (single) {
            return text(
              `Hipótese ${h.id} registrada: "${h.title}", avaliação única de ${h.metric} (${h.direction === 'higher' ? 'maior' : 'menor'} é melhor), família "${h.family}". Sem braços e sem declare_result: registre o cofre com register_lockbox apontando para ${h.id}; o resultado do lockbox_evaluate vira o run desta hipótese.${integrity ? `\n${integrity}` : ''}`,
            );
          }
          const hint = h.comparison ? undefined : statementHint(h);
          return text(
            `Hipótese ${h.id} registrada: "${h.title}". Métrica ${h.metric} (${h.direction === 'higher' ? 'maior' : 'menor'} é melhor), melhora mínima ${h.minImprovement}${h.improvementKind === 'relative' ? ' relativa' : ''}, braços ${h.arms[0]} x ${h.arms[1]}, ${comparisonLabel(h)}, alpha ${h.alpha}, família "${h.family}". ${
              paired
                ? `Registre um run por braço com log_run({ hypothesis_id: "${h.id}", arm, seed: 0, command, predictions_file }); o host calcula ${h.metric} (${rowMetric}) das linhas.`
                : pairedSeeds
                  ? `Registre um run por seed em cada braço, com as mesmas seeds nos dois (pelo menos ${pairedSeedsMin(h)}): log_run({ hypothesis_id: "${h.id}", arm, seed, ... }). A seed é o par.`
                  : `Registre cada execução com log_run({ hypothesis_id: "${h.id}", arm, seed, ... }).`
            }${hint ? `\n${pairedSuggestion(h, hint, true)}` : ''}${integrity ? `\n${integrity}` : ''}`,
          );
        },
        load,
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
          predictions_file: z
            .string()
            .optional()
            .describe(
              'Só em hipótese paired_bootstrap: CSV ou JSON com uma linha por item avaliado, colunas id, unit, label, score. O host lê, guarda o sha256 e calcula a métrica primária. Relativo a workdir ou ao projeto',
            ),
          artifact: z.string().optional().describe('Caminho do log ou artefato'),
          commit: z.string().optional().describe('Commit git do código que rodou. Omitido: lido do repositório'),
          workdir: z.string().optional().describe('Pasta onde o comando rodou (worktree, por exemplo), para achar o commit e o metrics_file'),
        },
        async (args) => {
          const h = this.store.hypothesis(args.hypothesis_id);
          if (!h) {
            return fail(`Hipótese "${args.hypothesis_id}" não existe. Registre com register_hypothesis ou veja read_board.`);
          }
          if (isSingleEval(h)) {
            return fail(singleRefusal(h));
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
          let rows: RunRows | undefined;
          let rowsNote = '';
          if (args.predictions_file && h.comparison !== 'paired_bootstrap') {
            return fail(`${h.id} compara seeds; predictions_file só vale em hipótese registrada com comparison: "paired_bootstrap".`);
          }
          if (h.comparison === 'paired_bootstrap') {
            const metric = h.rowMetric ?? 'mean';
            if (args.predictions_file) {
              const file = path.resolve(workdir, args.predictions_file);
              const read = readPredictionsFile(file);
              if (read instanceof Error) {
                return fail(read.message);
              }
              rows = read.rows;
              // Sem metrics_file, o arquivo de predições é o artefato conferido pelo sha256 na verificação independente.
              if (!metricsFileHash) {
                metricsFileHash = read.hash;
                artifact = path.relative(this.root, file);
              }
              rowsNote = `, ${rows.score.length} linhas e ${new Set(rows.unit).size} unidades lidas de ${path.relative(this.root, file)} (sha256 ${read.hash})`;
            } else if (samples?.[h.metric]?.length) {
              rows = rowsFromSamples(samples[h.metric]);
              rowsNote = `, ${rows.score.length} amostras, cada uma a própria unidade`;
            } else {
              return fail(`${h.id} é pareada por unidade: passe predictions_file (CSV ou JSON com id, unit, label, score) ou samples de "${h.metric}".`);
            }
            // Sem a coluna, cada linha viraria a própria unidade e o IC sairia estreito demais para dados agrupados.
            if (h.unit && rows.unitFromRow) {
              return fail(
                `${h.id} declara a unidade "${h.unit}", mas ${args.predictions_file ? `${args.predictions_file} não tem coluna unit (ou cluster, group, grupo, unidade)` : 'samples não trazem unidade'}. Grave a coluna unit com o ${h.unit} de cada linha e registre de novo.`,
              );
            }
            const problem = checkRows(rows, metric);
            if (problem) {
              return fail(problem);
            }
            const computed = rowsMetric(rows, metric);
            if (Number.isFinite(metrics[h.metric]) && Math.abs(metrics[h.metric] - computed) > 1e-6 * Math.max(1, Math.abs(computed))) {
              rowsNote += `; o ${h.metric} informado (${metrics[h.metric]}) difere do calculado das linhas, vale o calculado`;
            }
            metrics = { ...metrics, [h.metric]: computed };
          }
          if (!Number.isFinite(metrics[h.metric])) {
            return fail(`Falta a métrica primária "${h.metric}" (recebi: ${Object.keys(metrics).join(', ') || 'nenhuma'}).`);
          }
          const git = gitInfo(workdir, args.command, [args.metrics_file, args.predictions_file, args.artifact].filter((f): f is string => !!f).map((f) => path.resolve(workdir, f)));
          const run = this.store.addRun({
            hypothesisId: h.id,
            arm: args.arm,
            seed: args.seed,
            metrics,
            samples,
            command: args.command,
            commit: args.commit ?? git.commit,
            // Commit informado pelo agente: o estado do worktree não diz nada sobre ele, mas arquivo citado fora do git continua valendo.
            dirty: args.commit ? (git.dirtyFiles?.length ? true : undefined) : git.dirty,
            dirtyFiles: git.dirtyFiles,
            artifact,
            metricsFileHash,
            source: metricsFileHash ? 'arquivo' : 'declarado',
            agent: callerId,
            rows,
          });
          const dup = existing.some((r) => r.arm === run.arm && r.seed === run.seed);
          const perArm = h.arms.map((a) => `${a} ${new Set([...existing, run].filter((r) => r.arm === a).map((r) => r.seed)).size}/${h.comparison === 'paired_seeds' ? pairedSeedsMin(h) : h.minSeeds}`).join(', ');
          this.changed();
          // Dica de pareado só quando o sinal aparece agora: seed repetida com o mesmo valor, ou os braços acabaram de fechar o mesmo conjunto de seeds.
          const hintNow = pairedHint(h, [...existing, run]);
          const hint = hintNow && hintNow !== pairedHint(h, existing) ? `\n${pairedSuggestion(h, hintNow, false)}` : '';
          const dirtyNote = run.dirtyFiles?.length
            ? `\nAtenção: ${run.dirtyFiles.slice(0, 5).join(', ')}${run.dirtyFiles.length > 5 ? ` e mais ${run.dirtyFiles.length - 5}` : ''}, citado(s) no comando, tem mudança não commitada ou não está no git. O commit ${run.commit?.slice(0, 10) ?? 'gravado'} não identifica o código que rodou; gravei dirty: true. Commite antes das próximas execuções.`
            : run.dirty
              ? `\nAtenção: o worktree tem mudança não commitada; o commit ${run.commit?.slice(0, 10) ?? 'gravado'} pode não ser o código que rodou (gravei dirty: true).`
              : '';
          const tail = rows
            ? ` Braços com predições: ${h.arms.map((a) => `${a} ${[...existing, run].some((r) => r.arm === a && r.rows) ? 'sim' : 'não'}`).join(', ')}.${existing.some((r) => r.arm === run.arm && r.rows) ? ' Este braço já tinha predições: vale o último run.' : ''}`
            : ` Seeds por braço: ${perArm}.${dup ? ' Esta seed já tinha run neste braço: vale a última.' : ''}`;
          return text(
            `Run ${run.id} registrado (${h.id}, ${run.arm}, seed ${run.seed}, ${h.metric} = ${metrics[h.metric]}${rows ? ' calculado pelo host' : metricsFileHash ? `, lido de ${artifact}` : ''}${rowsNote}${run.commit ? `, commit ${run.commit.slice(0, 10)}${run.dirty ? ' com alterações não commitadas' : ''}` : ''}).${tail}${dirtyNote}${hint}`,
          );
        },
        load,
      ),
      tool(
        'read_board',
        'Resumo do quadro do laboratório: hipóteses, status, vereditos e runs. Com hypothesis_id, mostra os runs com comando e commit.',
        {
          hypothesis_id: z.string().optional(),
          status: z.enum(['registrada', 'rodando', 'concluída', 'inconclusiva', 'refutada']).optional(),
          agent: z.string().optional().describe('Só runs deste agente'),
        },
        async (args) => text(this.board(args, callerId)),
        load,
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
        load,
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
          if (isSingleEval(h)) {
            const { result } = singleResult(this.store.runs(h.id));
            const shown = result && (callerId === MAIN_CALLER ? `${h.metric} = ${result.metrics[h.metric]}` : lockboxHidden(result));
            return fail(`${h.id} é de avaliação única (cofre): não compara braços nem passa por declare_result. ${result ? `O resultado é o run ${result.id} (${shown}).` : 'Ainda sem resultado: o lockbox_evaluate grava o run.'}`);
          }
          // A família inclui as hipóteses da mesma conversa, ramo ou derivação (lab/integrity.ts), não só o mesmo texto `family`.
          const fam = this.familyOf?.(h) ?? { members: this.store.hypotheses().filter((o) => o.family === h.family), label: h.family };
          const family = fam.members.map((o) => ({ id: o.id, p: numberOr(this.store.lastVerdict(o.id)?.p) }));
          const v = this.store.addVerdict(evaluate({ ...h, family: fam.label }, this.store.runs(h.id), family, { by: callerId, attempt: this.store.verdicts(h.id).length + 1 }));
          const verifying = this.onVerdict?.(h, v, callerId);
          this.changed();
          const hint = pairedHint(h, this.store.runs(h.id));
          return text(`${formatVerdict(h, v)}${hint ? `\n${pairedSuggestion(h, hint, false)}` : ''}${typeof verifying === 'string' ? `\n${verifying}` : ''}`);
        },
        load,
      ),
    ];
  }

  /** `callerId`: quem não é o main não vê os números do cofre, só que a avaliação aconteceu. */
  private board(filter: { hypothesis_id?: string; status?: string; agent?: string }, callerId = MAIN_CALLER): string {
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
      const single = isSingleEval(h) ? singleResult(runs) : undefined;
      const counts = single
        ? `${single.result ? 1 + single.extras.length : 0} avaliação(ões) do cofre${single.result ? `, resultado ${single.result.id}${single.extras.length ? ` (extras: ${single.extras.map((r) => r.id).join(', ')}, não trocam o resultado)` : ''}` : ''}`
        : h.arms.map((a) => `${a} ${runs.filter((r) => r.arm === a).length}`).join(', ');
      lines.push(
        `${h.id} | ${h.title} | ${this.store.status(h)} | ${h.metric} (${h.direction === 'higher' ? 'maior' : 'menor'} é melhor), melhora mínima ${h.minImprovement}${h.improvementKind === 'relative' ? ' relativa' : ''} | runs: ${counts} (${comparisonLabel(h)}) | família ${h.family}${h.derivedFrom ? ` | derivada de ${h.derivedFrom}` : ''}${this.store.pruned(h.id) ? ' | podada pelo usuário (não gaste mais runs aqui sem pedir)' : ''}`,
      );
      if (v) {
        lines.push(`   veredito: ${v.verdict}, diferença ${fmtNum(v.diff)} IC95% [${fmtNum(v.ci[0])}, ${fmtNum(v.ci[1])}], p ajustado ${fmtNum(v.pAdjusted)} (tentativa ${v.attempt}${v.paired ? `, pareado por ${v.paired.units} unidades` : ''})`);
      }
      if (filter.hypothesis_id) {
        for (const r of runs) {
          lines.push(
            `   ${r.id} ${r.arm} seed ${r.seed}: ${r.lockbox && callerId !== MAIN_CALLER ? lockboxHidden(r) : Object.entries(r.metrics).map(([k, x]) => `${k}=${x}`).join(' ')} | ${r.source} | ${r.command ?? '-'} | commit ${r.commit?.slice(0, 10) ?? '-'}${r.dirty ? `+sujo${r.dirtyFiles?.length ? ` (${r.dirtyFiles.join(', ')})` : ''}` : ''} | ${r.agent}`,
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

/** Como a hipótese compara os braços, em poucas palavras. */
export function comparisonLabel(h: Hypothesis): string {
  switch (h.comparison) {
    case 'paired_bootstrap':
      return `modelo congelado, um run por braço, bootstrap pareado por ${h.unit || 'unidade'} (${h.rowMetric ?? 'mean'}, mínimo ${h.minUnits ?? DEFAULT_MIN_UNITS} unidades)`;
    case 'paired_seeds':
      return `pareada por seed${h.unit ? ` (${h.unit})` : ''}, mínimo ${pairedSeedsMin(h)} seeds em comum nos dois braços, IC pela t e p do teste de troca de sinais`;
    case 'single':
      return 'avaliação única (cofre), sem braços a comparar';
    default:
      return `mínimo ${h.minSeeds} seeds por braço`;
  }
}

/** Sugestão de trocar para comparison "paired_seeds", com o motivo. `early`: na hora do registro, antes de qualquer run. */
function pairedSuggestion(h: Hypothesis, why: string, early: boolean): string {
  return `Sugestão: ${why}. Se a seed é a instância e os dois braços rodam as mesmas, ${
    early ? 'registre' : 'a próxima hipótese deve ser registrada'
  } com comparison: "paired_seeds" (e unit: "instância"): o veredito pareia os braços pela seed (IC pela t, p do teste exato de troca de sinais, mínimo de ${PAIRED_SEEDS_MIN} instâncias). Com "seeds", ${h.id} trata os braços como amostras independentes e perde poder.${
    early ? ` Para isso, registre de novo com derived_from: "${h.id}".` : ` Para refazer a análise, registre uma hipótese com derived_from: "${h.id}" e comparison: "paired_seeds", e registre os runs nela.`
  }`;
}

/** O enunciado diz que a seed é a instância ou que a execução é determinística? */
function statementHint(h: Hypothesis): string | undefined {
  return /inst[âa]ncia|instance|determin[íi]stic|deterministic/i.test(h.statement) ? 'o enunciado fala em instância ou execução determinística' : undefined;
}

/**
 * Agregados citáveis de uma hipótese, por braço e na hipótese inteira, com a última execução de cada seed e com todas
 * as execuções: média, mediana e soma de grupos com 2 ou mais runs (grupo de um run só daria o próprio valor, que é
 * do agente que o registrou). Mínimo e máximo só na hipótese do próprio agente (`own`) ou nos runs dele (`agent`),
 * senão um extremo de outro agente passaria como citável. Mais a diferença entre as médias dos braços. Runs do
 * cofre e hipótese de avaliação única ficam de fora: esses números seguem outra regra (lockboxMetrics).
 */
export function runAggregates(h: Hypothesis, runs: readonly Run[], opts: { own: boolean; agent?: string } = { own: false }): number[] {
  const usable = runs.filter((r) => !r.lockbox);
  if (isSingleEval(h) || !usable.length) {
    return [];
  }
  const out: number[] = [];
  const lastBySeed = (rs: readonly Run[]) => [...new Map(rs.map((r) => [`${r.arm}#${r.seed}`, r])).values()];
  const groupsOf = (rs: readonly Run[]) => {
    const gs: Run[][] = [];
    for (const arm of new Set(rs.map((r) => r.arm))) {
      const a = rs.filter((r) => r.arm === arm);
      gs.push(a, lastBySeed(a));
    }
    gs.push([...rs], lastBySeed(rs));
    return gs.filter((g) => g.length >= 2);
  };
  const all = groupsOf(usable);
  const mine = opts.own || !opts.agent ? [] : groupsOf(usable.filter((r) => r.agent === opts.agent));
  for (const m of new Set(usable.flatMap((r) => Object.keys(r.metrics)))) {
    for (const g of all) {
      const a = aggregates(g.map((r) => r.metrics[m]));
      if (a && a.n >= 2) {
        out.push(a.mean, a.median, a.sum, ...(opts.own ? [a.min, a.max] : []));
      }
    }
    for (const g of mine) {
      const a = aggregates(g.map((r) => r.metrics[m]));
      if (a) {
        out.push(a.min, a.max);
      }
    }
    const [x, y] = h.arms.map((arm) => aggregates(lastBySeed(usable.filter((r) => r.arm === arm)).map((r) => r.metrics[m])));
    if (x && y && x.n >= 2 && y.n >= 2) {
      out.push(y.mean - x.mean);
    }
  }
  return out;
}

/** Run do cofre visto por quem não é o main: só que a avaliação aconteceu, sem o número. */
function lockboxHidden(r: Run): string {
  return `avaliado no cofre em ${r.at} (valor só para o main)`;
}

/** Recusa de log_run e run_seeds em hipótese de avaliação única. */
function singleRefusal(h: Hypothesis): string {
  return `${h.id} é de avaliação única (cofre): só o lockbox_evaluate grava o resultado dela, e vale a primeira avaliação. Para medir fora do cofre, registre uma hipótese com braços.`;
}

/** Lembrete de hipóteses com runs suficientes e sem veredito, para o fim do turno do agente que as registrou. */
export function staleReminder(hs: readonly Hypothesis[], runsOf: (h: Hypothesis) => Run[]): string {
  const lines = hs.map((h) => {
    const runs = runsOf(h);
    const counts = h.arms.map((a) => `${a} ${new Set(runs.filter((r) => r.arm === a).map((r) => r.seed)).size}`).join(', ');
    const hint = pairedHint(h, runs);
    return `- ${h.id} "${h.title}": ${runs.length} runs (${counts}; ${comparisonLabel(h)}), sem veredito.${hint ? ` ${pairedSuggestion(h, hint, false)}` : ''}`;
  });
  return [
    `Lembrete do laboratório: ${hs.length === 1 ? 'uma hipótese sua tem' : `${hs.length} hipóteses suas têm`} runs suficientes e nenhum declare_result. Sem veredito ela fica "rodando" no quadro e o relatório não pode dizer que um braço é melhor.`,
    ...lines,
    `Chame declare_result({ hypothesis_id }) ${hs.length === 1 ? 'nela' : 'em cada uma'} antes do relatório final, ou diga no relatório por que não vai declarar. Este lembrete não se repete.`,
  ].join('\n');
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
    v.paired
      ? `${b.arm}: ${h.metric} ${fmtNum(b.mean)} (${v.paired.runs[0]}) | ${va.arm}: ${h.metric} ${fmtNum(va.mean)} (${v.paired.runs[1]}) | ${v.paired.rows} linhas pareadas, ${v.paired.units} unidades${v.paired.unpaired ? `, sem par ${v.paired.unpaired[0]} (${b.arm}) e ${v.paired.unpaired[1]} (${va.arm})` : ''}`
      : v.pairedSeeds
        ? `${arm(b)} | ${arm(va)} | pareados por ${v.pairedSeeds.unit || 'seed'}, ${v.pairedSeeds.seeds} em comum${v.pairedSeeds.unpaired[0] || v.pairedSeeds.unpaired[1] ? `, sem par ${v.pairedSeeds.unpaired[0]} (${b.arm}) e ${v.pairedSeeds.unpaired[1]} (${va.arm})` : ''}`
        : `${arm(b)} | ${arm(va)}`,
    `Diferença (${va.arm} - ${b.arm}, positivo = melhora em ${h.metric}): ${fmtNum(v.diff)}${v.relDiff !== undefined && v.relDiff !== null ? ` (${fmtNum(v.relDiff * 100)}% do baseline)` : ''}, IC 95% bootstrap ${ciLabel(v)} [${fmtNum(v.ci[0])}, ${fmtNum(v.ci[1])}]`,
    `Efeito ${v.mode === 'seeds' ? 'd de Cohen' : v.paired ? 'd_z por unidade' : v.pairedSeeds ? 'd_z por seed' : 'd_z'} ${fmtNum(v.effect)}; p ${v.paired || v.pairedSeeds ? 'do bootstrap ' : ''}${fmtNum(v.p)}, p ajustado BH ${fmtNum(v.pAdjusted)} (família "${v.family}", ${v.familySize} hipótese(s))`,
    ...v.reasons.map((r) => `- ${r}`),
    ...(v.seedsMissing !== undefined && v.verdict === 'inconclusiva' ? [`Seeds que faltam por braço (estimativa, poder 80%): ${v.seedsMissing}`] : []),
    ...v.warnings.map((w) => `Atenção: ${w}`),
    `Gravado como ${v.id} em .agm/lab/verdicts.jsonl. Cite estes números, não outros.`,
  ].join('\n');
}

/** Como o IC foi calculado, para texto. */
export function ciLabel(v: Verdict): string {
  if (v.pairedSeeds) {
    return `t pareado por ${v.pairedSeeds.unit || 'seed'} (${v.pairedSeeds.seeds} seeds em comum; p do teste de troca de sinais ${v.pairedSeeds.exact === false ? 'por Monte Carlo' : 'exato'})`;
  }
  if (v.paired) {
    return `pareado por ${v.paired.unit || 'unidade'} (${v.paired.units} unidades reamostradas, ${v.paired.iters} réplicas)`;
  }
  return v.mode === 'paired-samples' ? 'pareado por amostra' : 'por seed';
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

/**
 * Commit do diretório e se ele identifica o código que rodou, com um processo git só (status porcelain v2, que traz
 * o commit na linha "# branch.oid"). `dirty`: mudança não commitada em arquivo rastreado, ou arquivo citado no comando
 * (`dirtyFiles`) modificado, fora do git ou ignorado. Não contam: arquivo novo não citado (saída, log), a saída citada
 * no comando (--out x.json, > log.txt) que não é código, e `exclude` (o metrics_file e o artefato do próprio run).
 */
export function gitInfo(cwd: string, command?: string, exclude: readonly string[] = []): { commit?: string; dirty?: boolean; dirtyFiles?: string[] } {
  let out: string;
  try {
    out = execFileSync('git', ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal', '--ignored=matching'], {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch {
    return {};
  }
  const st = parseStatusV2(out);
  if (!st.commit) {
    return {};
  }
  const cited = commandFiles(cwd, command, exclude);
  let dirtyFiles: string[] | undefined;
  if (cited.length) {
    // O porcelain dá o caminho a partir da raiz do repositório; diretório inteiro fora do git aparece como "dir/".
    const root = repoRoot(cwd);
    const prefix = root ? path.relative(root, cwd).split(path.sep).join('/') : '';
    const full = (f: string) => (prefix ? `${prefix}/${f}` : f);
    const under = (list: readonly string[], f: string) => list.some((l) => l === f || (l.endsWith('/') && f.startsWith(l)));
    const hit = cited.filter((f) => st.changed.includes(full(f)) || under(st.untracked, full(f)) || under(st.ignored, full(f)));
    dirtyFiles = hit.length ? hit : undefined;
  }
  return { commit: st.commit, dirty: st.changed.length > 0 || !!dirtyFiles, dirtyFiles };
}

/** Lê `git status --porcelain=v2 --branch -z`: commit, arquivos rastreados com mudança, não rastreados e ignorados. */
export function parseStatusV2(out: string): { commit?: string; changed: string[]; untracked: string[]; ignored: string[] } {
  const res = { commit: undefined as string | undefined, changed: [] as string[], untracked: [] as string[], ignored: [] as string[] };
  const parts = out.split('\0');
  // Caminho depois de `n` campos separados por espaço (o caminho pode ter espaço).
  const after = (e: string, n: number) => {
    let at = 0;
    for (let k = 0; k < n && at >= 0; k++) {
      at = e.indexOf(' ', at) + 1 || -1;
    }
    return at > 0 ? e.slice(at) : '';
  };
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.startsWith('# branch.oid ')) {
      const oid = e.slice('# branch.oid '.length).trim();
      res.commit = /^[0-9a-f]{7,}$/.test(oid) ? oid : undefined;
    } else if (e.startsWith('1 ')) {
      res.changed.push(after(e, 8));
    } else if (e.startsWith('2 ')) {
      res.changed.push(after(e, 9));
      i++; // o próximo campo é o caminho antigo do renomeado
    } else if (e.startsWith('u ')) {
      res.changed.push(after(e, 10));
    } else if (e.startsWith('? ')) {
      res.untracked.push(e.slice(2));
    } else if (e.startsWith('! ')) {
      res.ignored.push(e.slice(2));
    }
  }
  return res;
}

function repoRoot(cwd: string): string | undefined {
  for (let dir = path.resolve(cwd); ; ) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      return dir;
    }
    const up = path.dirname(dir);
    if (up === dir) {
      return undefined;
    }
    dir = up;
  }
}

const CODE_FILE = /\.(py|pyx|ipynb|ts|tsx|js|mjs|cjs|sh|bash|zsh|ps1|bat|cmd|r|jl|rb|go|rs|java|kt|scala|c|cc|cpp|h|hpp|cs|lua|pl|php|m|swift|sql)$/i;
// Opção cujo valor é arquivo que o comando grava: --out, --output-file, --save-to, --metrics, -o...
const OUTPUT_FLAG = /^(-o|--?(out|output|outdir|save|dump|log|metrics|results?|dest|report|write)([-_](file|dir|path|to|json|csv))?)$/i;

/**
 * Arquivos existentes que o comando cita (python solver.py, --config cfg/x.yaml), relativos a `cwd`, com barra normal.
 * Fica de fora a saída que não é código: valor de --out/-o/--metrics..., destino de "> arquivo" ou "tee arquivo", e os
 * caminhos absolutos em `exclude` (metrics_file do run).
 */
export function commandFiles(cwd: string, command: string | undefined, exclude: readonly string[] = []): string[] {
  if (!command) {
    return [];
  }
  const skip = new Set(exclude.map((f) => path.resolve(cwd, f)));
  const out = new Set<string>();
  const add = (raw: string, output: boolean) => {
    const tok = raw.replace(/^["']|["']$/g, '');
    if (!/[\w-]\.[A-Za-z0-9]{1,6}$/.test(tok) || /^[a-z]+:\/\//i.test(tok)) {
      return;
    }
    const abs = path.resolve(cwd, tok);
    const rel = path.relative(cwd, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || (!CODE_FILE.test(tok) && (output || skip.has(abs)))) {
      return;
    }
    try {
      if (fs.statSync(abs).isFile()) {
        out.add(rel.split(path.sep).join('/'));
      }
    } catch {
      // Não existe (saída que o comando vai gravar, por exemplo): nada a conferir.
    }
  };
  const tokens = (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).slice(0, 80);
  let outputNext = false;
  for (const tok of tokens) {
    const redirect = /^(\d?>>?|&>)(.*)$/.exec(tok);
    if (redirect) {
      if (redirect[2]) {
        add(redirect[2], true);
      } else {
        outputNext = true;
      }
      continue;
    }
    if (/^tee$/i.test(tok) || OUTPUT_FLAG.test(tok)) {
      outputNext = true;
      continue;
    }
    const eq = /^(--?[\w-]+)=(.+)$/.exec(tok);
    if (eq) {
      add(eq[2], OUTPUT_FLAG.test(eq[1]));
      outputNext = false;
      continue;
    }
    for (const piece of tok.split(/[;|&<>()]+/)) {
      if (piece) {
        add(piece, outputNext);
      }
    }
    outputNext = false;
  }
  return [...out];
}

export function gitBranch(cwd: string): string | undefined {
  const b = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return b && b !== 'HEAD' ? b : undefined;
}
