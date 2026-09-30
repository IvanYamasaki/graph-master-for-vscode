/**
 * Verificador independente. Quando declare_result dá "suportada" (ou alguém pede), o hub cria um agente só de
 * leitura, num worktree próprio, que reexecuta ao menos uma run de cada braço com seed nova, procura vazamento
 * entre treino e teste e devolve um parecer com submit_verification.
 *
 * O selo não depende só do parecer do modelo. Antes de criar o agente o host já confere, sem LLM:
 * - se o veredito recalculado com os runs gravados até aquele instante dá os mesmos números;
 * - se cada arquivo de métricas ainda tem o sha256 registrado;
 * - se os caminhos protegidos (avaliador congelado) são iguais entre os commits dos runs.
 * E, no submit, lê do arquivo o número de cada reexecução e confere se ele cai no intervalo de predição do braço.
 * "verificado" exige parecer "confirmado", reexecução dentro do intervalo nos dois braços e nenhuma checagem dura
 * falhando. Qualquer falha dura ou reexecução fora do intervalo vira "divergente".
 *
 * Modo pareado por unidade (veredito com `paired`): não há seed nova. O verificador regera o predictions_file de
 * cada braço, o host recalcula a métrica com rowsMetric e exige que bata com o run original (tolerância relativa
 * 1e-9, pairedCheck.ts). Como a reexecução é determinística, o peso passa à procura de vazamento: "verificado"
 * exige leakage "nenhum" declarado.
 *
 * Os pareceres ficam em .agm/lab/verifications.jsonl, só de acréscimo, como o resto do quadro.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { LabHypothesisInfo, LabVerificationInfo, VerificationVerdict } from '../protocol';
import { evaluate, fmtNum } from '../lab/evaluate';
import { tTwoSided } from '../lab/stats';
import type { Hypothesis, Run, Verdict } from '../lab/store';
import { readProjectGuard } from '../guard/protect';
import { createWorktree } from '../worktree';
import { readResult } from './attempts';
import { PAIRED_REL_TOL, checkPairedRerun } from './pairedCheck';
import type { ParallelHost } from './host';

interface VerificationRecord extends LabVerificationInfo {
  id: string;
  hypothesisId: string;
  leakage?: 'nenhum' | 'suspeito' | 'encontrado';
}

export interface SubmitArgs {
  hypothesis_id: string;
  verdict: VerificationVerdict;
  notes: string;
  reruns?: { arm: string; seed: number; command: string; metrics_file?: string; predictions_file?: string }[];
  leakage?: 'nenhum' | 'suspeito' | 'encontrado';
}

interface HostChecks {
  lines: string[];
  /** Falha que sozinha já torna o resultado divergente. */
  hard: string[];
}

/** Ferramentas que o verificador não recebe: ele lê, roda o experimento com seed nova e dá o parecer. */
export const VERIFIER_BLOCKED_TOOLS = [
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  ...['spawn_agent', 'spawn_attempts', 'run_seeds', 'start_sweep', 'setup_optuna', 'stop_search', 'send_to_agent', 'register_hypothesis', 'log_run', 'declare_result', 'post_finding', 'request_verification', 'web_research', 'generate_image'].map(
    (t) => `mcp__agents__${t}`,
  ),
];

export class Verifier {
  /** Veredito em verificação → agente verificador. */
  private readonly pending = new Map<string, { agent: string; hypothesisId: string; at: string }>();

  constructor(private readonly host: ParallelHost) {}

  private get file(): string {
    return path.join(this.host.lab.store.dir, 'verifications.jsonl');
  }

  /** Campo `verification` da hipótese no estado do webview: a que roda agora ou a última do veredito atual. */
  infoFor(h: Hypothesis, v: Verdict | undefined): Partial<LabHypothesisInfo> {
    if (!v) {
      return {};
    }
    const p = this.pending.get(v.id);
    if (p) {
      return { verification: { seal: 'verificando', verdictId: v.id, agent: p.agent, at: p.at } };
    }
    const rec = this.records().filter((r) => r.hypothesisId === h.id && r.verdictId === v.id).at(-1);
    if (!rec) {
      return {};
    }
    const { id: _id, hypothesisId: _h, leakage: _l, ...info } = rec;
    return { verification: info };
  }

  /** Cria o verificador do último veredito da hipótese. Devolve o texto para quem pediu (ou o erro). */
  start(hypothesisId: string, why: string, opts: { model?: string; effort?: string } = {}): string | Error {
    const h = this.host.lab.store.hypothesis(hypothesisId);
    const v = h && this.host.lab.store.lastVerdict(h.id);
    if (!h || !v) {
      return new Error(h ? `A hipótese ${hypothesisId} ainda não tem veredito: chame declare_result antes.` : `Hipótese "${hypothesisId}" não existe.`);
    }
    const running = this.pending.get(v.id);
    if (running) {
      return `O veredito ${v.id} de ${h.id} já está em verificação pelo agente ${running.agent}.`;
    }
    if (this.host.freeSlots() < 1) {
      return new Error('Limite de agentes rodando atingido (agentGraphMaster.maxRoutedAgents): a verificação não começou. Chame request_verification quando algum agente terminar.');
    }
    const checks = hostChecks(this.host, h, v);
    const id = this.host.reserveId();
    const at = new Date().toISOString();
    this.pending.set(v.id, { agent: id, hypothesisId: h.id, at });
    this.host.lab.notify();
    const cfg = { model: opts.model ?? verifierSetting('verifierModel', 'sonnet'), effort: opts.effort ?? verifierSetting('verifierEffort', 'medium') };
    void (async () => {
      const wt = await createWorktree(this.host.cwd, id, `verifica ${h.id}`);
      const worktree = wt instanceof Error ? undefined : wt;
      const agent = this.host.spawn({
        id: worktree ? id : undefined,
        creator: 'main',
        description: `Verifica ${h.id}: ${h.title}`.slice(0, 60),
        prompt: verifierPrompt(this.host, h, v, checks, worktree?.cwd, wt instanceof Error ? wt.message : undefined, why),
        reportTo: 'main',
        model: cfg.model,
        effort: cfg.effort,
        worktree,
        extra: { verifier: { hypothesisId: h.id, verdictId: v.id } },
      });
      // Sem worktree o id reservado ficou sem uso: o pendente passa para o id real.
      if (agent !== id) {
        this.pending.set(v.id, { agent, hypothesisId: h.id, at });
        this.host.lab.notify();
      }
    })().catch((err) => {
      this.pending.delete(v.id);
      this.host.lab.notify();
      this.host.post({ type: 'notice', level: 'error', text: `Não consegui criar o verificador de ${h.id}: ${err instanceof Error ? err.message : String(err)}` });
    });
    const hardNote = checks.hard.length ? ` As checagens do host já acharam problema: ${checks.hard.join('; ')}.` : '';
    return `Verificação independente de ${h.id} (veredito ${v.id}) iniciada: agente ${id}, ${cfg.model}/${cfg.effort}, só leitura, ${v.paired ? 'regera as predições de cada braço e procura vazamento' : 'reexecuta cada braço com seed nova'}. O selo sai no cartão da hipótese e o relatório dele chega a você.${hardNote}`;
  }

  /** submit_verification: lê as reexecuções dos arquivos, compara com o intervalo de cada braço e grava o selo. */
  submit(callerId: string, args: SubmitArgs): string | Error {
    const me = this.host.info(callerId)?.verifier;
    if (!me) {
      return new Error('Só o agente verificador criado pelo hub usa submit_verification.');
    }
    if (me.hypothesisId !== args.hypothesis_id) {
      return new Error(`Você verifica a hipótese ${me.hypothesisId}, não ${args.hypothesis_id}.`);
    }
    const h = this.host.lab.store.hypothesis(me.hypothesisId);
    const v = h && this.host.lab.store.verdicts(h.id).find((x) => x.id === me.verdictId);
    if (!h || !v) {
      return new Error('A hipótese ou o veredito sumiu do quadro.');
    }
    const checks = hostChecks(this.host, h, v);
    const base = this.host.info(callerId)?.worktree?.cwd ?? this.host.cwd;
    const used = new Set(this.host.lab.store.runs(h.id).map((r) => `${r.arm}#${r.seed}`));
    const reruns: NonNullable<LabVerificationInfo['reruns']> = [];
    const lines = [...checks.lines];
    const paired = v.paired;
    for (const r of args.reruns ?? []) {
      const arm = v.arms.find((a) => a.arm === r.arm);
      if (!arm) {
        lines.push(`reexecução ignorada: braço "${r.arm}" não existe`);
        continue;
      }
      if (paired) {
        const given = r.predictions_file ?? r.metrics_file;
        if (!given) {
          lines.push(`${r.arm}: reexecução sem predictions_file; nada comparado`);
          reruns.push({ arm: r.arm, seed: r.seed, command: r.command });
          continue;
        }
        const file = path.resolve(base, given);
        const runsNow = this.host.lab.store.runs(h.id);
        const original = runsNow.find((x) => paired.runs.includes(x.id) && x.arm === r.arm);
        const c = checkPairedRerun(r.arm, file, path.relative(base, file) || file, original, paired.metric, h.metric);
        const tol = c.original !== undefined ? PAIRED_REL_TOL * Math.max(1, Math.abs(c.original)) : 0;
        reruns.push({ arm: r.arm, seed: r.seed, value: c.value, interval: c.original !== undefined ? [c.original - tol, c.original + tol] : undefined, inside: c.inside, command: r.command });
        lines.push(c.line);
        continue;
      }
      if (!r.metrics_file) {
        lines.push(`${r.arm} seed ${r.seed}: reexecução sem metrics_file; nada lido`);
        continue;
      }
      const file = path.resolve(base, r.metrics_file);
      const read = readResult(file, h.metric);
      const interval = predictionInterval(arm.mean, arm.sd, arm.n);
      const inside = read ? read.value >= interval[0] - 1e-12 && read.value <= interval[1] + 1e-12 : undefined;
      const reused = used.has(`${r.arm}#${r.seed}`);
      reruns.push({ arm: r.arm, seed: r.seed, value: read?.value, interval, inside: reused ? undefined : inside, command: r.command });
      lines.push(
        read
          ? `${r.arm} seed ${r.seed}${reused ? ' (seed já usada nos runs: não conta como independente)' : ''}: ${h.metric} = ${fmtNum(read.value)} lido de ${path.relative(base, file) || file} (sha256 ${read.hash}); intervalo de predição 95% do braço [${fmtNum(interval[0])}, ${fmtNum(interval[1])}] → ${inside ? 'dentro' : 'FORA'}`
          : `${r.arm} seed ${r.seed}: não li ${h.metric} em ${file}`,
      );
    }
    const armsOk = v.arms.every((a) => reruns.some((r) => r.arm === a.arm && r.inside === true));
    const outside = reruns.some((r) => r.inside === false);
    const leak = args.leakage ? [`vazamento treino/teste segundo o verificador: ${args.leakage}`] : [];
    lines.push(...leak);
    // Pareado: a reexecução só reproduz um cálculo determinístico, então o vazamento tem de ter sido procurado.
    const leakOk = paired ? args.leakage === 'nenhum' : args.leakage !== 'suspeito';
    const seal =
      args.verdict === 'divergente' || outside || checks.hard.length || args.leakage === 'encontrado'
        ? 'divergente'
        : args.verdict === 'confirmado' && armsOk && leakOk
          ? 'verificado'
          : 'inconclusivo';
    const rec: Omit<VerificationRecord, 'id'> = {
      hypothesisId: h.id,
      verdictId: v.id,
      seal,
      verdict: args.verdict,
      notes: args.notes.trim(),
      // As reexecuções vão estruturadas em `reruns`; aqui ficam as checagens do host e o vazamento.
      checks: [...checks.lines, ...leak],
      reruns,
      leakage: args.leakage,
      agent: callerId,
      at: new Date().toISOString(),
    };
    this.append(rec);
    this.pending.delete(v.id);
    this.host.lab.notify();
    const why =
      seal === 'verificado'
        ? paired
          ? 'parecer confirmado, predições regeradas dos dois braços reproduzem a métrica e nenhum vazamento'
          : 'parecer confirmado, reexecução de cada braço dentro do intervalo e nenhuma checagem do host falhou'
        : seal === 'divergente'
          ? [
              args.verdict === 'divergente' ? 'o seu parecer é divergente' : '',
              outside ? (paired ? 'predição regerada não reproduz a métrica do run original' : 'reexecução fora do intervalo do braço') : '',
              ...checks.hard,
              args.leakage === 'encontrado' ? 'vazamento encontrado' : '',
            ]
              .filter(Boolean)
              .join('; ')
          : !armsOk
            ? paired
              ? 'falta predictions_file regerado que reproduza a métrica em algum braço'
              : 'falta reexecução lida de arquivo e dentro do intervalo em algum braço'
            : args.leakage === 'suspeito'
              ? 'vazamento suspeito'
              : paired && args.leakage !== 'nenhum'
                ? 'no modo pareado o selo exige leakage "nenhum" declarado depois da procura'
                : 'parecer inconclusivo';
    return [`Parecer gravado para ${h.id} (veredito ${v.id}). Selo: ${seal.toUpperCase()} (${why}).`, ...lines.map((l) => `- ${l}`), 'Escreva agora o relatório final, começando pelo selo.'].join('\n');
  }

  /** O verificador parou sem submit_verification: o veredito fica com selo inconclusivo, com o motivo. */
  onSettled(id: string): void {
    const entry = [...this.pending.entries()].find(([, p]) => p.agent === id);
    const info = this.host.info(id);
    if (!entry || !info || info.status === 'running') {
      return;
    }
    const [verdictId, p] = entry;
    this.pending.delete(verdictId);
    this.append({
      hypothesisId: p.hypothesisId,
      verdictId,
      seal: 'inconclusivo',
      verdict: 'inconclusivo',
      notes: `O verificador ${id} terminou (${info.status}) sem chamar submit_verification.`,
      checks: [],
      agent: id,
      at: new Date().toISOString(),
    });
    this.host.lab.notify();
  }

  reset(): void {
    this.pending.clear();
  }

  private records(): VerificationRecord[] {
    let raw = '';
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    const out: VerificationRecord[] = [];
    for (const line of raw.split('\n')) {
      try {
        if (line.trim()) {
          out.push(JSON.parse(line) as VerificationRecord);
        }
      } catch {
        // Linha cortada por gravação interrompida: o resto vale.
      }
    }
    return out;
  }

  private append(rec: Omit<VerificationRecord, 'id'>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const max = this.records().reduce((m, r) => Math.max(m, Number(/^x(\d+)$/.exec(r.id)?.[1] ?? 0)), 0);
    fs.appendFileSync(this.file, JSON.stringify({ id: `x${max + 1}`, ...rec }) + '\n', 'utf8');
  }
}

// ---------- Checagens do host, sem LLM ----------

function hostChecks(host: ParallelHost, h: Hypothesis, v: Verdict): HostChecks {
  const lines: string[] = [];
  const hard: string[] = [];
  const runs = host.lab.store.runs(h.id).filter((r) => r.at <= v.at);

  // 1. Recalcula com os runs gravados até o veredito: a porta é determinística, então os números têm de bater.
  const again = evaluate(h, runs, [{ id: h.id, p: undefined }], { by: 'verificação', attempt: v.attempt });
  const same = (a: number, b: number) => (Number.isNaN(a) && Number.isNaN(b)) || (a === null && b === null) || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  if (same(again.diff, v.diff) && same(again.ci[0], v.ci[0]) && same(again.ci[1], v.ci[1])) {
    lines.push(`recálculo com os ${runs.length} runs gravados até o veredito: diferença ${fmtNum(again.diff)} e IC [${fmtNum(again.ci[0])}, ${fmtNum(again.ci[1])}] batem com ${v.id}`);
  } else {
    const msg = `recálculo não bate com ${v.id}: diferença ${fmtNum(again.diff)} contra ${fmtNum(v.diff)}, IC [${fmtNum(again.ci[0])}, ${fmtNum(again.ci[1])}] contra [${fmtNum(v.ci[0])}, ${fmtNum(v.ci[1])}]`;
    lines.push(msg);
    hard.push(msg);
  }

  // 2. Arquivos de métricas: o sha256 gravado no log_run tem de ser o do arquivo de hoje.
  let hashed = 0;
  const changed: string[] = [];
  const missing: string[] = [];
  for (const r of runs) {
    if (!r.metricsFileHash || !r.artifact) {
      continue;
    }
    hashed++;
    try {
      const raw = fs.readFileSync(path.resolve(host.cwd, r.artifact), 'utf8');
      if (createHash('sha256').update(raw).digest('hex').slice(0, 16) !== r.metricsFileHash) {
        changed.push(`${r.id} (${r.artifact})`);
      }
    } catch {
      missing.push(`${r.id} (${r.artifact})`);
    }
  }
  if (changed.length) {
    const msg = `arquivo de métricas alterado depois do registro: ${changed.join(', ')}`;
    lines.push(msg);
    hard.push(msg);
  }
  if (missing.length) {
    lines.push(`arquivo de métricas não encontrado (pode ter sido gravado num worktree): ${missing.join(', ')}`);
  }
  if (hashed && !changed.length) {
    lines.push(`${hashed - missing.length} de ${hashed} arquivos de métricas conferidos pelo sha256`);
  }
  const declared = runs.filter((r) => r.source === 'declarado').length;
  if (declared) {
    lines.push(`${declared} run(s) com valor declarado pelo agente, sem arquivo`);
  }
  const dirty = runs.filter((r) => r.dirty).length;
  if (dirty) {
    lines.push(`${dirty} run(s) rodaram com alterações não commitadas: o commit não descreve o código exato`);
  }

  // 3. Avaliador congelado: os caminhos protegidos têm de ser os mesmos em todos os commits dos runs.
  const patterns = [...new Set([...readProjectGuard(host.cwd).patterns, ...runs.flatMap((r) => host.info(r.agent)?.protectedPaths ?? [])])];
  const commits = [...new Set(runs.map((r) => r.commit).filter((c): c is string => !!c))];
  if (!patterns.length) {
    lines.push('nenhum caminho protegido configurado: não há avaliador congelado para conferir');
  } else if (!commits.length) {
    lines.push(`caminhos protegidos (${patterns.join(', ')}) não conferidos: os runs não têm commit`);
  } else {
    const spec = patterns.map((p) => (/[*?[{]/.test(p) ? `:(glob)${p.replace(/\\/g, '/')}` : p.replace(/\\/g, '/')));
    const diffs = commits.map((c) => ({ c, files: gitLines(host.cwd, ['diff', '--name-only', c, '--', ...spec]) }));
    if (diffs.some((d) => d.files === undefined)) {
      lines.push('não consegui rodar git diff nos caminhos protegidos');
    } else {
      const sig = new Set(diffs.map((d) => d.files!.join('|')));
      const touched = [...new Set(diffs.flatMap((d) => d.files!))];
      if (sig.size > 1) {
        const msg = `o avaliador (caminhos protegidos) difere entre os commits dos runs: ${touched.join(', ')}`;
        lines.push(msg);
        hard.push(msg);
      } else if (touched.length) {
        lines.push(`caminhos protegidos iguais em todos os runs, mas mudaram depois deles: ${touched.join(', ')}`);
      } else {
        lines.push(`caminhos protegidos (${patterns.join(', ')}) sem mudança entre os commits dos runs e o estado atual`);
      }
    }
  }
  return { lines, hard };
}

function gitLines(cwd: string, args: string[]): string[] | undefined {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .sort();
  } catch {
    return undefined;
  }
}

/** Quantil 0.975 da t de Student com `df` graus de liberdade, por bissecção no p bicaudal do stats.ts. */
function t975(df: number): number {
  if (!(df >= 1)) {
    return NaN;
  }
  let lo = 0;
  let hi = 100;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (tTwoSided(mid, df) > 0.05) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

/** Onde uma execução nova do braço deve cair com 95%: média ± t·sd·√(1 + 1/n). */
export function predictionInterval(mean: number, sd: number, n: number): [number, number] {
  const half = t975(n - 1) * sd * Math.sqrt(1 + 1 / n);
  return Number.isFinite(half) ? [mean - half, mean + half] : [mean, mean];
}

function verifierSetting(key: string, fallback: string): string {
  return vscode.workspace.getConfiguration('agentGraphMaster').get<string>(key, fallback) || fallback;
}

function verifierPrompt(host: ParallelHost, h: Hypothesis, v: Verdict, checks: HostChecks, cwd: string | undefined, noWorktree: string | undefined, why: string): string {
  const runs = host.lab.store.runs(h.id).filter((r) => r.at <= v.at);
  const maxSeed = runs.reduce((m, r) => Math.max(m, r.seed), 0);
  const perArm = (arm: string) => runs.filter((r: Run) => r.arm === arm);
  const example = (arm: string) => perArm(arm).at(-1)?.command ?? '(sem comando registrado)';
  if (v.paired) {
    return pairedPrompt(h, v, runs, checks, cwd, noWorktree, why);
  }
  return [
    `Verificação independente da hipótese ${h.id} ("${h.title}"), veredito ${v.id}: ${v.verdict.toUpperCase()}. Motivo: ${why}.`,
    `Enunciado: ${h.statement}`,
    `Métrica ${h.metric} (${h.direction === 'higher' ? 'maior' : 'menor'} é melhor), braços ${h.arms[0]} (baseline) x ${h.arms[1]} (variante), melhora mínima ${h.minImprovement}${h.improvementKind === 'relative' ? ' relativa' : ''}.`,
    `Veredito: diferença ${fmtNum(v.diff)}, IC 95% [${fmtNum(v.ci[0])}, ${fmtNum(v.ci[1])}], p ajustado ${fmtNum(v.pAdjusted)}. ${v.arms.map((a) => `${a.arm}: n=${a.n}, média ${fmtNum(a.mean)} ± ${fmtNum(a.sd)}, intervalo de predição 95% de uma execução nova [${predictionInterval(a.mean, a.sd, a.n).map(fmtNum).join(', ')}]`).join('; ')}.`,
    '',
    'Runs registrados (id, braço, seed, valor, comando, commit):',
    ...runs.map((r) => `- ${r.id} ${r.arm} seed ${r.seed}: ${fmtNum(r.metrics[h.metric])} | ${r.command ?? '-'} | ${r.commit?.slice(0, 10) ?? 'sem commit'}${r.dirty ? ' (sujo)' : ''} | ${r.source}`),
    '',
    'Checagens que o host já fez (não precisa refazer):',
    ...checks.lines.map((l) => `- ${l}`),
    '',
    cwd
      ? `Você trabalha num worktree próprio, em "${cwd}". Rode tudo aqui dentro e grave os arquivos de saída aqui dentro.`
      : `Não foi possível criar um worktree (${noWorktree ?? 'motivo desconhecido'}): você está no diretório do projeto. Grave as saídas das reexecuções só numa pasta nova .agm/verify-tmp/ e não mexa em mais nada.`,
    'Sua tarefa, nesta ordem:',
    `1. Reexecute pelo menos uma run de cada braço com seed NOVA, nunca usada acima (por exemplo ${maxSeed + 101} e ${maxSeed + 102}), com o mesmo comando dos runs trocando só a seed e o arquivo de saída. Exemplos de comando: ${h.arms.map((a) => `${a}: ${example(a)}`).join(' | ')}. Não altere código, dados nem configuração para isso.`,
    '2. Leia o código do experimento e procure vazamento entre treino e teste (dado de teste usado no treino ou na seleção de hiperparâmetro, normalização calculada com o teste, cache reaproveitado entre braços, seed que não muda nada). Os caminhos protegidos você não lê: o host já conferiu o avaliador.',
    '3. Confira se os números do veredito batem com os runs acima.',
    '4. Chame submit_verification({ hypothesis_id, verdict, notes, reruns, leakage }) uma vez. verdict: "confirmado" (as reexecuções caem no intervalo e não há vazamento), "divergente" (algo não bate) ou "inconclusivo" (não deu para verificar). reruns: [{ arm, seed, command, metrics_file }] com o caminho do JSON que cada reexecução gravou, relativo ao seu diretório; o host lê o número do arquivo e decide se cai no intervalo. leakage: "nenhum", "suspeito" ou "encontrado". notes: o que você viu, curto.',
    '5. Relatório final em até 8 linhas, começando pelo selo que o submit_verification devolveu.',
    'Você não edita arquivos, não registra runs e não declara resultado: só lê, reexecuta e dá o parecer. Não cite número que não esteja nos runs acima ou nos arquivos das suas reexecuções.',
  ].join('\n');
}

/** Prompt do verificador no modo pareado: sem seed nova; regera as predições e procura vazamento. */
function pairedPrompt(h: Hypothesis, v: Verdict, runs: Run[], checks: HostChecks, cwd: string | undefined, noWorktree: string | undefined, why: string): string {
  const p = v.paired!;
  const original = (arm: string) => runs.find((r) => p.runs.includes(r.id) && r.arm === arm);
  return [
    `Verificação independente da hipótese ${h.id} ("${h.title}"), veredito ${v.id}: ${v.verdict.toUpperCase()}. Motivo: ${why}.`,
    `Enunciado: ${h.statement}`,
    `Modo pareado por unidade: um modelo congelado por braço, avaliado nas mesmas linhas; métrica ${p.metric} calculada pelo host das predições (${p.rows} linhas, ${p.units} unidades${p.unit ? ` por ${p.unit}` : ''}, ${p.iters} reamostragens). Braços ${h.arms[0]} (baseline) x ${h.arms[1]} (variante).`,
    `Veredito: diferença ${fmtNum(v.diff)}, IC 95% [${fmtNum(v.ci[0])}, ${fmtNum(v.ci[1])}], p ajustado ${fmtNum(v.pAdjusted)}.`,
    '',
    'Runs comparados (id, braço, valor, comando, arquivo de predições, commit):',
    ...h.arms.map((a) => {
      const r = original(a);
      return r ? `- ${r.id} ${a}: ${fmtNum(r.metrics[h.metric])} | ${r.command ?? '-'} | ${r.artifact ?? '-'} | ${r.commit?.slice(0, 10) ?? 'sem commit'}${r.dirty ? ' (sujo)' : ''}` : `- ${a}: run não encontrado`;
    }),
    '',
    'Checagens que o host já fez (não precisa refazer):',
    ...checks.lines.map((l) => `- ${l}`),
    '',
    cwd
      ? `Você trabalha num worktree próprio, em "${cwd}". Rode tudo aqui dentro e grave os arquivos de saída aqui dentro.`
      : `Não foi possível criar um worktree (${noWorktree ?? 'motivo desconhecido'}): você está no diretório do projeto. Grave as saídas só numa pasta nova .agm/verify-tmp/ e não mexa em mais nada.`,
    'Sua tarefa, nesta ordem. Aqui não há seed nova: a predição de um modelo congelado é determinística.',
    `1. Regere o arquivo de predições de cada braço com o mesmo comando do run, mudando só o caminho de saída. O host recalcula ${p.metric} das linhas e exige que bata com o run original (tolerância relativa ${PAIRED_REL_TOL}) e com os mesmos ids de linha; também compara o sha256.`,
    '2. Esta é a parte principal: procure vazamento. Linhas de avaliação que aparecem no treino ou na escolha de hiperparâmetro e de limiar; a mesma unidade (paciente, usuário, sessão) dos dois lados da divisão; atributo calculado com o conjunto inteiro; rótulo ou informação do futuro entrando nas features; os dois braços com splits diferentes. Leia o código que gera as predições e o que separa os dados. Os caminhos protegidos você não lê.',
    '3. Chame submit_verification({ hypothesis_id, verdict, notes, reruns, leakage }) uma vez. reruns: [{ arm, seed: 0, command, predictions_file }] com o caminho do arquivo regerado, relativo ao seu diretório. leakage é obrigatório: "nenhum" só depois de procurar de verdade (o selo "verificado" exige isso), "suspeito" ou "encontrado". notes: onde procurou e o que viu, curto.',
    '4. Relatório final em até 8 linhas, começando pelo selo que o submit_verification devolveu.',
    'Você não edita arquivos, não registra runs e não declara resultado. Não cite número que não esteja nos runs acima ou nos arquivos que você regerou.',
  ].join('\n');
}
