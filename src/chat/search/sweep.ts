/**
 * Varredura de hiperparâmetros sem modelo no laço: o hub pede um ponto (Optuna ou o amostrador embutido), roda o
 * comando com os parâmetros, lê a métrica do JSON que o script gravou, devolve o valor e registra o trial como
 * run no laboratório. Paralelismo, tempo por trial, tempo total e interrupção ficam aqui.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BuiltinSampler, etaSquared, medianPrune, paretoFront, type Direction, type Observation, type ParamSpec, type Params } from './sampler';
import { OptunaBridge, sqliteUrl, type OptunaSummary, type PythonInfo } from './optuna';

export interface Objective {
  metric: string;
  direction: Direction;
}

export interface SweepSpec {
  name: string;
  commandTemplate: string;
  params: ParamSpec[];
  objectives: Objective[];
  nTrials: number;
  parallel: number;
  sampler: string;
  pruner: string;
  /** Caminho do JSON de métricas com placeholders; vazio: {out}, ou a última linha JSON do stdout. */
  metricsFile?: string;
  workdir: string;
  timeoutMinutes: number;
  maxMinutes?: number;
  seed: number;
  creator: string;
  reportTo: string;
}

export interface Trial {
  number: number;
  params: Params;
  state: 'running' | 'complete' | 'fail' | 'pruned';
  values?: number[];
  command: string;
  startedAt: string;
  durationMs?: number;
  error?: string;
  /** Run do laboratório. */
  runId?: string;
  steps?: Record<number, number>;
}

export interface SweepSummary {
  best?: { number: number; params: Params; values: number[] };
  pareto: { number: number; params: Params; values: number[] }[];
  importances: { objective: number; items: { name: string; value: number }[] }[];
  evaluator: string;
  note?: string;
}

export type SweepStatus = 'rodando' | 'concluída' | 'interrompida' | 'orçamento' | 'falhou';

export interface SweepState {
  id: string;
  kind: 'sweep';
  spec: SweepSpec;
  backend: 'optuna' | 'embutido';
  backendNote: string;
  status: SweepStatus;
  trials: Trial[];
  hypothesisId?: string;
  startedAt: string;
  endedAt?: string;
  summary?: SweepSummary;
  note?: string;
}

export interface SweepHooks {
  /** Pasta da varredura (.agm/search/<id>). */
  dir: string;
  changed(state: SweepState): void;
  log(text: string): void;
  /** Grava o trial concluído no laboratório; devolve o id do run. */
  logRun(trial: Trial, metrics: Record<string, number>, file: { artifact: string; hash: string } | undefined): string | undefined;
  readMetrics(file: string): { metrics: Record<string, number>; hash: string } | Error;
}

const POLL_MS = 1000;

/** Valor de parâmetro dentro do comando. Categóricos já foram validados (sem espaço nem aspas). */
function fmtParam(v: string | number): string {
  if (typeof v === 'number') {
    return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(10)));
  }
  return v;
}

function quoteIfNeeded(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? values[key] : all));
}

/** Última linha do stdout que é um objeto JSON com números. */
function jsonFromStdout(stdout: string): Record<string, number> | undefined {
  const lines = stdout.trim().split(/\r?\n/).reverse();
  for (const l of lines) {
    const t = l.trim();
    if (!t.startsWith('{')) {
      continue;
    }
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      const src = obj.metrics && typeof obj.metrics === 'object' ? (obj.metrics as Record<string, unknown>) : obj;
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(src)) {
        if (typeof v === 'number' && Number.isFinite(v)) {
          out[k] = v;
        }
      }
      return out;
    } catch {
      continue;
    }
  }
  return undefined;
}

export class Sweep {
  readonly state: SweepState;
  private readonly children = new Set<ChildProcess>();
  private sampler?: BuiltinSampler;
  private bridge?: OptunaBridge;
  private launched = 0;
  private readonly t0 = Date.now();

  constructor(
    id: string,
    spec: SweepSpec,
    private readonly python: PythonInfo | undefined,
    backendNote: string,
    private readonly hooks: SweepHooks,
  ) {
    this.state = {
      id,
      kind: 'sweep',
      spec,
      backend: python ? 'optuna' : 'embutido',
      backendNote,
      status: 'rodando',
      trials: [],
      startedAt: new Date().toISOString(),
    };
  }

  get running(): boolean {
    return this.state.status === 'rodando';
  }

  get dbFile(): string {
    return path.join(this.hooks.dir, 'study.db');
  }

  stop(): void {
    if (!this.running) {
      return;
    }
    this.state.status = 'interrompida';
    this.state.note = 'interrompida pelo usuário ou pelo orquestrador';
    for (const c of this.children) {
      kill(c);
    }
    this.hooks.changed(this.state);
  }

  private get directions(): Direction[] {
    return this.state.spec.objectives.map((o) => o.direction);
  }

  private nStartup(): number {
    return Math.max(3, Math.min(10, Math.floor(this.state.spec.nTrials / 3)));
  }

  async run(): Promise<void> {
    const s = this.state.spec;
    try {
      fs.mkdirSync(this.hooks.dir, { recursive: true });
      if (this.python) {
        this.bridge = new OptunaBridge(this.python, this.hooks.dir);
        await this.bridge.init({
          storage: sqliteUrl(this.dbFile),
          studyName: this.state.id,
          directions: this.directions,
          sampler: s.sampler,
          pruner: s.pruner,
          seed: s.seed,
          nStartup: this.nStartup(),
          params: s.params,
        });
      } else {
        this.sampler = new BuiltinSampler(s.params, this.directions, s.seed, this.nStartup());
      }
      this.hooks.changed(this.state);
      await Promise.all(Array.from({ length: Math.max(1, Math.min(s.parallel, s.nTrials)) }, () => this.worker()));
      if (this.running) {
        this.state.status = this.overTime() ? 'orçamento' : 'concluída';
        if (this.state.status === 'orçamento') {
          this.state.note = `tempo total de ${s.maxMinutes} min esgotado`;
        }
      }
      this.state.summary = await this.summarize();
    } catch (err) {
      this.state.status = 'falhou';
      this.state.note = err instanceof Error ? err.message : String(err);
      for (const c of this.children) {
        kill(c);
      }
    } finally {
      this.bridge?.close();
      this.state.endedAt = new Date().toISOString();
      this.hooks.changed(this.state);
    }
  }

  private overTime(): boolean {
    const m = this.state.spec.maxMinutes;
    return !!m && Date.now() - this.t0 > m * 60_000;
  }

  private async worker(): Promise<void> {
    const s = this.state.spec;
    while (this.running && this.launched < s.nTrials && !this.overTime()) {
      this.launched++;
      let number: number;
      let params: Params;
      if (this.bridge) {
        ({ number, params } = await this.bridge.ask());
      } else {
        number = this.state.trials.length;
        params = this.sampler!.ask(this.state.trials);
      }
      const trial: Trial = { number, params, state: 'running', command: '', startedAt: new Date().toISOString() };
      this.state.trials.push(trial);
      await this.runTrial(trial);
      if (this.bridge) {
        await this.bridge.tell(trial.number, trial.state === 'running' ? 'fail' : trial.state, trial.values);
      }
      this.hooks.changed(this.state);
    }
  }

  private async runTrial(trial: Trial): Promise<void> {
    const s = this.state.spec;
    const out = path.join(this.hooks.dir, `trial_${trial.number}.json`);
    const progress = path.join(this.hooks.dir, `trial_${trial.number}.progress.jsonl`);
    for (const f of [out, progress]) {
      fs.rmSync(f, { force: true });
    }
    const rel = (f: string) => quoteIfNeeded(path.relative(s.workdir, f) || f);
    const values: Record<string, string> = { trial: String(trial.number), out: rel(out), progress: rel(progress) };
    for (const [k, v] of Object.entries(trial.params)) {
      values[k] = fmtParam(v);
    }
    trial.command = fillTemplate(s.commandTemplate, values);
    const metricsPath = s.metricsFile ? path.resolve(s.workdir, fillTemplate(s.metricsFile, { ...values, out, progress })) : s.commandTemplate.includes('{out}') ? out : undefined;
    const started = Date.now();
    const result = await this.exec(trial, progress);
    trial.durationMs = Date.now() - started;
    if (!this.running && trial.state === 'running') {
      trial.state = 'fail';
      trial.error = 'interrompido';
      return;
    }
    if (trial.state === 'pruned') {
      this.hooks.log(`Trial ${trial.number} podado no passo ${Math.max(...Object.keys(trial.steps ?? {}).map(Number))}.`);
      return;
    }
    if (result.timedOut || result.code !== 0) {
      trial.state = 'fail';
      trial.error = result.timedOut ? `passou de ${s.timeoutMinutes} min` : `código ${result.code}: ${result.stderr.trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 300)}`;
      this.hooks.log(`Trial ${trial.number} falhou (${trial.error}). Comando: ${trial.command}`);
      return;
    }
    let metrics: Record<string, number> | undefined;
    let file: { artifact: string; hash: string } | undefined;
    if (metricsPath) {
      const read = this.hooks.readMetrics(metricsPath);
      if (read instanceof Error) {
        trial.state = 'fail';
        trial.error = read.message;
        this.hooks.log(`Trial ${trial.number}: ${read.message}`);
        return;
      }
      metrics = read.metrics;
      file = { artifact: metricsPath, hash: read.hash };
    } else {
      metrics = jsonFromStdout(result.stdout);
    }
    const vals = s.objectives.map((o) => metrics?.[o.metric]);
    if (!metrics || vals.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      trial.state = 'fail';
      trial.error = `faltou ${s.objectives.map((o) => o.metric).join(', ')} na saída (achei: ${Object.keys(metrics ?? {}).join(', ') || 'nada'})`;
      this.hooks.log(`Trial ${trial.number}: ${trial.error}`);
      return;
    }
    trial.values = vals as number[];
    trial.state = 'complete';
    trial.runId = this.hooks.logRun(trial, metrics, file);
    this.hooks.log(
      `Trial ${trial.number}: ${s.objectives.map((o, i) => `${o.metric} = ${fmtValue(trial.values![i])}`).join(', ')} com ${fmtParams(trial.params)}${trial.runId ? ` (run ${trial.runId})` : ''}.`,
    );
  }

  private exec(trial: Trial, progress: string): Promise<{ code: number | null; timedOut: boolean; stdout: string; stderr: string }> {
    const s = this.state.spec;
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const keep = (acc: string, b: Buffer) => (acc + b.toString('utf8')).slice(-20_000);
      const child = spawn(trial.command, {
        cwd: s.workdir,
        shell: true,
        windowsHide: true,
        env: { ...process.env, AGM_TRIAL: String(trial.number), AGM_PROGRESS: progress },
      });
      this.children.add(child);
      child.stdout?.on('data', (b: Buffer) => (stdout = keep(stdout, b)));
      child.stderr?.on('data', (b: Buffer) => (stderr = keep(stderr, b)));
      const timer = setTimeout(() => {
        timedOut = true;
        kill(child);
      }, s.timeoutMinutes * 60_000);
      // Poda: o script acrescenta {"step": k, "value": v} em {progress}; o hub informa e pergunta se para.
      let seen = 0;
      let checking = false;
      const poll =
        s.pruner !== 'none'
          ? setInterval(() => {
              if (checking) {
                return;
              }
              checking = true;
              void this.checkProgress(trial, progress, seen)
                .then((r) => {
                  seen = r.seen;
                  if (r.prune && trial.state === 'running') {
                    trial.state = 'pruned';
                    kill(child);
                  }
                })
                .finally(() => (checking = false));
            }, POLL_MS)
          : undefined;
      const finish = (code: number | null, extra = '') => {
        clearTimeout(timer);
        if (poll) {
          clearInterval(poll);
        }
        this.children.delete(child);
        resolve({ code, timedOut, stdout, stderr: stderr + extra });
      };
      child.on('error', (e) => finish(null, e.message));
      child.on('close', (code) => finish(code));
    });
  }

  private async checkProgress(trial: Trial, file: string, seen: number): Promise<{ seen: number; prune: boolean }> {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return { seen, prune: false };
    }
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    let prune = false;
    for (const l of lines.slice(seen)) {
      try {
        const { step, value } = JSON.parse(l) as { step: number; value: number };
        if (!Number.isFinite(step) || !Number.isFinite(value)) {
          continue;
        }
        trial.steps = { ...trial.steps, [step]: value };
        if (this.bridge) {
          prune = (await this.bridge.report(trial.number, step, value)).prune || prune;
        } else {
          prune = medianPrune(this.state.trials as Observation[], trial as Observation, step, this.directions[0]) || prune;
        }
      } catch {
        continue;
      }
    }
    return { seen: lines.length, prune };
  }

  private async summarize(): Promise<SweepSummary> {
    const s = this.state.spec;
    const done = this.state.trials.filter((t) => t.state === 'complete' && t.values) as (Trial & { values: number[] })[];
    if (this.bridge) {
      try {
        const o: OptunaSummary = await this.bridge.summary();
        return { best: o.best ?? undefined, pareto: o.pareto, importances: o.importances, evaluator: `Optuna (${o.evaluator})`, note: o.importance_error };
      } catch (err) {
        this.hooks.log(`Resumo do Optuna falhou (${err instanceof Error ? err.message : err}); uso o cálculo embutido.`);
      }
    }
    const pick = (t: Trial & { values: number[] }) => ({ number: t.number, params: t.params, values: t.values });
    if (s.objectives.length > 1) {
      return {
        pareto: paretoFront(done, this.directions).map(pick),
        importances: s.objectives.map((_, i) => ({ objective: i, items: etaSquared(s.params, done.map((t) => ({ params: t.params, value: t.values[i] }))) })),
        evaluator: 'η² por faixas (embutido)',
      };
    }
    const sign = this.directions[0] === 'maximize' ? -1 : 1;
    const best = [...done].sort((a, b) => sign * (a.values[0] - b.values[0]))[0];
    return {
      best: best && pick(best),
      pareto: [],
      importances: [{ objective: 0, items: etaSquared(s.params, done.map((t) => ({ params: t.params, value: t.values[0] }))) }],
      evaluator: 'η² por faixas (embutido)',
    };
  }
}

function kill(child: ChildProcess): void {
  if (child.exitCode !== null) {
    return;
  }
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGKILL');
  }
}

// ---------- Texto ----------

export function fmtValue(x: number): string {
  if (!Number.isFinite(x)) {
    return String(x);
  }
  const a = Math.abs(x);
  return a !== 0 && (a < 1e-3 || a >= 1e6) ? x.toExponential(3) : String(Number(x.toPrecision(5)));
}

export function fmtParams(p: Params): string {
  return Object.entries(p)
    .map(([k, v]) => `${k}=${typeof v === 'number' ? fmtValue(v) : v}`)
    .join(', ');
}

function bestSoFar(state: SweepState): Trial | undefined {
  const d = state.spec.objectives[0].direction;
  const done = state.trials.filter((t) => t.state === 'complete' && t.values);
  return done.sort((a, b) => (d === 'minimize' ? a.values![0] - b.values![0] : b.values![0] - a.values![0]))[0];
}

export function sweepProgress(state: SweepState): string {
  const done = state.trials.filter((t) => t.state !== 'running').length;
  const best = bestSoFar(state);
  return `${done}/${state.spec.nTrials} trials${best ? ` · melhor ${fmtValue(best.values![0])}` : ''}`;
}

function trialTable(state: SweepState, limit: number): string {
  const s = state.spec;
  const d = s.objectives[0].direction;
  const rows = [...state.trials]
    .sort((a, b) => {
      const va = a.values?.[0];
      const vb = b.values?.[0];
      if (va === undefined || vb === undefined) {
        return va === undefined ? (vb === undefined ? a.number - b.number : 1) : -1;
      }
      return d === 'minimize' ? va - vb : vb - va;
    })
    .slice(0, limit)
    .map((t) => `| ${t.number} | ${t.values ? t.values.map(fmtValue).join(' / ') : t.state === 'running' ? 'rodando' : t.state === 'pruned' ? 'podado' : 'falhou'} | ${fmtParams(t.params).replace(/\|/g, '/')} |`);
  return [`| trial | ${s.objectives.map((o) => `${o.metric} (${o.direction === 'minimize' ? 'menor' : 'maior'})`).join(' / ')} | parâmetros |`, '|---|---|---|', ...rows].join('\n');
}

export function sweepMarkdown(state: SweepState): string {
  const counts = (['running', 'complete', 'pruned', 'fail'] as const).map((k) => state.trials.filter((t) => t.state === k).length);
  return [
    `**${state.status}** · ${sweepProgress(state)} · ${state.backend === 'optuna' ? `Optuna, ${state.spec.sampler}` : 'amostrador embutido'} · paralelo ${state.spec.parallel}`,
    `rodando ${counts[0]}, concluídos ${counts[1]}, podados ${counts[2]}, falhos ${counts[3]}${state.hypothesisId ? ` · laboratório ${state.hypothesisId}` : ''}`,
    '',
    trialTable(state, 10),
    ...(state.note ? ['', `_${state.note}_`] : []),
  ].join('\n');
}

export function sweepReport(state: SweepState, where: string): string {
  const s = state.spec;
  const sum = state.summary;
  const done = state.trials.filter((t) => t.state === 'complete').length;
  const multi = s.objectives.length > 1;
  const head =
    state.status === 'concluída'
      ? `Varredura ${state.id} ("${s.name}") concluída: ${done} de ${s.nTrials} trials completos${sum?.best ? `, melhor ${s.objectives[0].metric} = ${fmtValue(sum.best.values[0])} com ${fmtParams(sum.best.params)} (trial ${sum.best.number})` : ''}${multi ? `, ${sum?.pareto.length ?? 0} trials na fronteira de Pareto` : ''}.`
      : `Varredura ${state.id} ("${s.name}") ${state.status}${state.note ? ` (${state.note})` : ''}: ${done} trials completos.`;
  const lines = [
    head,
    '',
    `Comando: ${s.commandTemplate}`,
    `Motor: ${state.backend === 'optuna' ? `Optuna, sampler ${s.sampler}, pruner ${s.pruner}, estudo em ${path.join(where, 'study.db')}` : `amostrador embutido (${state.backendNote})`}.`,
    `Objetivo${multi ? 's' : ''}: ${s.objectives.map((o) => `${o.metric} (${o.direction === 'minimize' ? 'menor' : 'maior'} é melhor)`).join(', ')}.`,
  ];
  if (sum?.best) {
    lines.push('', `Melhores parâmetros: ${fmtParams(sum.best.params)}.`);
  }
  if (multi && sum?.pareto.length) {
    lines.push('', 'Fronteira de Pareto:', ...sum.pareto.map((t) => `- trial ${t.number}: ${t.values.map(fmtValue).join(' / ')} com ${fmtParams(t.params)}`));
  }
  if (sum?.importances.length) {
    lines.push('', `Importância dos parâmetros (${sum.evaluator}; com poucos trials é só indicação):`);
    for (const imp of sum.importances) {
      lines.push(`- ${multi ? `${s.objectives[imp.objective].metric}: ` : ''}${imp.items.map((i) => `${i.name} ${(i.value * 100).toFixed(0)}%`).join(', ') || 'sem dados suficientes'}`);
    }
  }
  if (sum?.note) {
    lines.push(`(${sum.note})`);
  }
  lines.push('', 'Melhores trials:', trialTable(state, 8));
  const failed = state.trials.filter((t) => t.state === 'fail');
  if (failed.length) {
    lines.push('', `Falharam ${failed.length}: ${failed.slice(0, 3).map((t) => `trial ${t.number} (${t.error})`).join('; ')}.`);
  }
  lines.push(
    '',
    `Cada trial completo virou run no laboratório${state.hypothesisId ? ` (hipótese exploratória ${state.hypothesisId})` : ''}, com o comando, o commit e o hash do JSON de métricas.`,
    'O melhor de muitos trials é uma estimativa otimista (o vencedor foi escolhido pelo mesmo número que o mede). Para afirmar melhora, registre uma hipótese confirmatória com register_hypothesis (melhores parâmetros contra o baseline, várias seeds) e conclua com declare_result.',
    `Arquivos: ${where}.`,
  );
  return lines.join('\n');
}
