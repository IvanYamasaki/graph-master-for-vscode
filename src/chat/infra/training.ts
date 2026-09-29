/**
 * Vigia de treino barato: o hub lê o log (ou o histórico do MLflow/W&B) em intervalos fixos e aplica regras
 * determinísticas. Nenhum modelo roda enquanto está tudo normal; só quando uma regra dispara o host pode pedir
 * um resumo curto a um modelo pequeno. Nunca para o job sozinho: o usuário decide no cartão.
 *
 * Sem VS Code: as funções de leitura e as regras rodam no teste com node puro.
 */
import * as fs from 'node:fs';
import { MlflowClient } from './mlflow';

export interface Reading {
  step: number;
  value: number;
}

export interface TrainingRules {
  /** NaN ou Inf na métrica. Padrão: ligado. */
  nan: boolean;
  /** Leituras seguidas piorando (no sentido da direção) que contam como divergência. 0 desliga. Padrão 5. */
  divergeSteps: number;
  /** Valor pior que o melhor visto por este fator (perda 3x a mínima, por exemplo). 0 desliga. Padrão 0. */
  divergeFactor: number;
  /** Passos sem melhora maior que minDelta que contam como platô. 0 desliga (padrão). */
  plateauSteps: number;
  minDelta: number;
  /** Minutos sem leitura nova até o job ser dado como parado. 0 desliga. Padrão 10. */
  stallMinutes: number;
}

export type Direction = 'lower' | 'higher';
export type AlertKind = 'nan' | 'diverge' | 'plateau' | 'stall';

export interface Detection {
  kind: AlertKind;
  text: string;
}

const NUM = String.raw`([-+]?(?:nan|inf(?:inity)?|\d+(?:\.\d*)?(?:e[-+]?\d+)?|\.\d+(?:e[-+]?\d+)?))`;
const STEP_KEYS = ['step', '_step', 'global_step', 'iteration', 'iter', 'it', 'epoch'];

function toNumber(raw: string | number | null | undefined): number | undefined {
  if (typeof raw === 'number') {
    return raw;
  }
  if (raw === null) {
    // JSON não tem NaN: vários loggers gravam null quando o valor é NaN.
    return NaN;
  }
  if (raw === undefined) {
    return undefined;
  }
  const s = raw.trim().toLowerCase();
  if (s === 'nan' || s === '+nan' || s === '-nan') {
    return NaN;
  }
  if (/^[+]?inf/.test(s)) {
    return Infinity;
  }
  if (/^-inf/.test(s)) {
    return -Infinity;
  }
  const n = Number(s);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * Lê a métrica de uma linha de log. Aceita JSON por linha ({"step": 10, "loss": 0.5}, com NaN, Infinity ou null),
 * e texto livre ("step 10 | loss=0.5", "loss: nan"). Devolve undefined quando a linha não traz a métrica.
 */
export function parseLine(line: string, metric: string, fallbackStep: number): Reading | undefined {
  const t = line.trim();
  if (!t) {
    return undefined;
  }
  if (t.startsWith('{')) {
    // Python grava NaN e Infinity sem aspas, que JSON.parse recusa: troca por strings antes.
    const fixed = t.replace(/:\s*(-?Infinity|NaN)\b/g, ': "$1"');
    try {
      const obj = JSON.parse(fixed) as Record<string, unknown>;
      if (metric in obj) {
        const value = toNumber(obj[metric] as string | number | null);
        if (value === undefined) {
          return undefined;
        }
        const stepKey = STEP_KEYS.find((k) => typeof obj[k] === 'number');
        return { step: stepKey ? (obj[stepKey] as number) : fallbackStep, value };
      }
      return undefined;
    } catch {
      // Cai para o texto livre.
    }
  }
  const escaped = metric.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(String.raw`(?:^|[^\w.])${escaped}["']?\s*[:=]?\s*${NUM}`, 'i').exec(t);
  if (!m) {
    return undefined;
  }
  const value = toNumber(m[1]);
  if (value === undefined) {
    return undefined;
  }
  const s = /\b(?:global_step|step|iteration|iter|it)\b["']?\s*[:=]?\s*(\d+)/i.exec(t);
  return { step: s ? Number(s[1]) : fallbackStep, value };
}

/** Estado das regras entre leituras. */
export interface RuleState {
  best?: number;
  /** Valor e passo da última melhora que contou para o platô. */
  plateauRef?: number;
  bestStep?: number;
  /** Leituras seguidas piorando. */
  worse: number;
  prev?: number;
  lastNewAt: number;
  /** Tipos já avisados; só avisa de novo quando a condição some e volta. */
  fired: Set<AlertKind>;
  /** Tipos que o usuário mandou ignorar. */
  muted: Set<AlertKind>;
}

export function newRuleState(now = Date.now()): RuleState {
  return { worse: 0, lastNewAt: now, fired: new Set(), muted: new Set() };
}

const fmt = (x: number) => (Number.isFinite(x) ? (Math.abs(x) >= 1000 || (Math.abs(x) < 1e-3 && x !== 0) ? x.toExponential(3) : String(Math.round(x * 10000) / 10000)) : String(x));

/** Aplica as regras às leituras novas. Devolve o que disparou agora (cada tipo uma vez até a condição sumir). */
export function applyRules(state: RuleState, readings: Reading[], metric: string, direction: Direction, rules: TrainingRules, now = Date.now()): Detection[] {
  const out: Detection[] = [];
  const better = (a: number, b: number) => (direction === 'lower' ? a < b : a > b);
  const fire = (kind: AlertKind, text: string) => {
    if (!state.fired.has(kind) && !state.muted.has(kind)) {
      out.push({ kind, text });
    }
    state.fired.add(kind);
  };
  if (readings.length) {
    state.lastNewAt = now;
    state.fired.delete('stall');
  }
  for (const r of readings) {
    if (!Number.isFinite(r.value)) {
      if (rules.nan) {
        fire('nan', `${metric} = ${r.value} no passo ${r.step}.`);
      }
      state.prev = undefined;
      continue;
    }
    if (state.best === undefined || better(r.value, state.best)) {
      state.best = r.value;
    }
    // O platô conta a partir da última melhora maior que minDelta sobre a referência, não de qualquer melhora mínima.
    if (state.plateauRef === undefined || (better(r.value, state.plateauRef) && Math.abs(r.value - state.plateauRef) > rules.minDelta)) {
      state.plateauRef = r.value;
      state.bestStep = r.step;
      state.fired.delete('plateau');
    }
    if (state.prev !== undefined && better(state.prev, r.value)) {
      state.worse++;
    } else if (state.prev !== undefined) {
      state.worse = 0;
      state.fired.delete('diverge');
    }
    state.prev = r.value;
    if (rules.divergeSteps > 0 && state.worse >= rules.divergeSteps) {
      fire('diverge', `${metric} piorou ${state.worse} leituras seguidas (agora ${fmt(r.value)} no passo ${r.step}; melhor até aqui ${fmt(state.best!)}).`);
    }
    if (rules.divergeFactor > 0 && state.best !== undefined && state.best !== 0) {
      const ratio = direction === 'lower' ? r.value / state.best : state.best / r.value;
      if (state.best > 0 && ratio >= rules.divergeFactor) {
        fire('diverge', `${metric} = ${fmt(r.value)} no passo ${r.step}, ${fmt(ratio)}x pior que o melhor (${fmt(state.best)}).`);
      }
    }
    if (rules.plateauSteps > 0 && state.bestStep !== undefined && r.step - state.bestStep >= rules.plateauSteps) {
      fire('plateau', `${metric} sem melhora maior que ${rules.minDelta} há ${r.step - state.bestStep} passos (última melhora: ${fmt(state.plateauRef!)} no passo ${state.bestStep}).`);
    }
  }
  if (rules.stallMinutes > 0 && now - state.lastNewAt >= rules.stallMinutes * 60_000) {
    fire('stall', `nenhuma leitura nova de ${metric} há ${Math.round((now - state.lastNewAt) / 60_000)} min.`);
  }
  return out;
}

// ---------- Fontes ----------

export interface Source {
  /** Leituras novas desde a última chamada, e as últimas linhas cruas para o resumo. */
  poll(): Promise<{ readings: Reading[]; tail: string[]; finished?: string }>;
  describe(): string;
}

/** Log em arquivo, lido do ponto onde parou. Arquivo que encolhe (reescrito) volta ao começo. */
export class LogFileSource implements Source {
  private offset = 0;
  private partial = '';
  private lines = 0;
  private readonly tail: string[] = [];

  constructor(
    private readonly file: string,
    private readonly metric: string,
  ) {}

  describe(): string {
    return this.file;
  }

  async poll(): Promise<{ readings: Reading[]; tail: string[] }> {
    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return { readings: [], tail: this.tail };
    }
    if (size < this.offset) {
      this.offset = 0;
      this.partial = '';
    }
    if (size === this.offset) {
      return { readings: [], tail: this.tail };
    }
    const fd = fs.openSync(this.file, 'r');
    const buf = Buffer.alloc(Math.min(size - this.offset, 8 * 1024 * 1024));
    try {
      fs.readSync(fd, buf, 0, buf.length, this.offset);
    } finally {
      fs.closeSync(fd);
    }
    this.offset += buf.length;
    const text = this.partial + buf.toString('utf8');
    const parts = text.split(/\r?\n/);
    this.partial = parts.pop() ?? '';
    const readings: Reading[] = [];
    for (const line of parts) {
      this.lines++;
      this.tail.push(line);
      if (this.tail.length > 40) {
        this.tail.shift();
      }
      const r = parseLine(line, this.metric, this.lines);
      if (r) {
        readings.push(r);
      }
    }
    return { readings, tail: this.tail };
  }
}

/** Histórico de uma métrica de um run do MLflow, pela API REST. */
export class MlflowSource implements Source {
  private lastStep = -Infinity;

  constructor(
    private readonly uri: string,
    private readonly runId: string,
    private readonly metric: string,
  ) {}

  describe(): string {
    return `MLflow ${this.uri}, run ${this.runId}`;
  }

  async poll(): Promise<{ readings: Reading[]; tail: string[]; finished?: string }> {
    const client = new MlflowClient(this.uri);
    const points = await client.metricHistory(this.runId, this.metric);
    const fresh = points.filter((p) => p.step > this.lastStep);
    if (fresh.length) {
      this.lastStep = fresh[fresh.length - 1].step;
    }
    const status = await client.runStatus(this.runId).catch(() => undefined);
    return {
      readings: fresh.map((p) => ({ step: p.step, value: p.value })),
      tail: points.slice(-20).map((p) => `step ${p.step} ${this.metric}=${p.value}`),
      finished: status && status !== 'RUNNING' && status !== 'SCHEDULED' ? status : undefined,
    };
  }
}

/** Histórico amostrado de um run do W&B pela API GraphQL pública. Precisa de WANDB_API_KEY. */
export class WandbSource implements Source {
  private lastStep = -Infinity;

  constructor(
    private readonly runPath: string,
    private readonly metric: string,
    private readonly apiKey: string,
    private readonly host = 'https://api.wandb.ai',
  ) {}

  describe(): string {
    return `W&B ${this.runPath}`;
  }

  async poll(): Promise<{ readings: Reading[]; tail: string[]; finished?: string }> {
    const [entity, project, name] = this.runPath.split('/');
    const query = `query R($entity: String!, $project: String!, $name: String!, $specs: [JSONString!]!) { project(name: $project, entityName: $entity) { run(name: $name) { state sampledHistory(specs: $specs) } } }`;
    const res = await fetch(`${this.host}/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`api:${this.apiKey}`).toString('base64')}` },
      body: JSON.stringify({ query, variables: { entity, project, name, specs: [JSON.stringify({ keys: ['_step', this.metric], samples: 2000 })] } }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      throw new Error(`W&B: HTTP ${res.status}`);
    }
    const data = (await res.json()) as { data?: { project?: { run?: { state?: string; sampledHistory?: Record<string, unknown>[][] } } }; errors?: { message: string }[] };
    if (data.errors?.length) {
      throw new Error(`W&B: ${data.errors[0].message}`);
    }
    const run = data.data?.project?.run;
    if (!run) {
      throw new Error(`W&B: run ${this.runPath} não encontrado.`);
    }
    const rows = (run.sampledHistory?.[0] ?? []).map((r) => ({ step: Number(r._step), value: toNumber(r[this.metric] as number | string | null) ?? NaN })).sort((a, b) => a.step - b.step);
    const fresh = rows.filter((r) => r.step > this.lastStep);
    if (fresh.length) {
      this.lastStep = fresh[fresh.length - 1].step;
    }
    return {
      readings: fresh,
      tail: rows.slice(-20).map((r) => `step ${r.step} ${this.metric}=${r.value}`),
      finished: run.state && run.state !== 'running' ? run.state : undefined,
    };
  }
}
