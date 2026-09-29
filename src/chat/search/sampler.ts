/**
 * Amostrador embutido, para quando não há Python com Optuna: aleatório nos primeiros trials e depois um TPE
 * simples (Parzen por parâmetro, independente, como o TPE original de Bergstra et al. 2011). Também a mediana
 * para poda, a importância aproximada por η² e a fronteira de Pareto. Sem VS Code: roda em node puro.
 *
 * É um substituto honesto, não o Optuna: sem TPE multivariado, sem CMA-ES nem GP, sem fANOVA, sem storage.
 */
import { rng } from './elo';

export interface ParamSpec {
  name: string;
  type: 'float' | 'int' | 'categorical';
  low?: number;
  high?: number;
  log?: boolean;
  step?: number;
  choices?: (string | number)[];
}

export type ParamValue = number | string;
export type Params = Record<string, ParamValue>;

export interface Observation {
  params: Params;
  /** Um valor por objetivo; ausente enquanto roda. */
  values?: number[];
  state: 'running' | 'complete' | 'fail' | 'pruned';
  /** Valores intermediários informados pelo script (passo → valor), para a poda. */
  steps?: Record<number, number>;
}

export type Direction = 'minimize' | 'maximize';

const CANDIDATES = 24;
const GAMMA = 0.25;

/** Posição do valor em [0, 1] no espaço de busca do parâmetro (log quando pedido). */
function toUnit(p: ParamSpec, v: ParamValue): number {
  if (p.type === 'categorical') {
    const i = (p.choices ?? []).findIndex((c) => String(c) === String(v));
    return (Math.max(0, i) + 0.5) / Math.max(1, p.choices?.length ?? 1);
  }
  const lo = p.low ?? 0;
  const hi = p.high ?? 1;
  const x = Number(v);
  if (p.log) {
    return (Math.log(x) - Math.log(lo)) / (Math.log(hi) - Math.log(lo) || 1);
  }
  return (x - lo) / (hi - lo || 1);
}

function fromUnit(p: ParamSpec, u: number): ParamValue {
  const t = Math.min(1, Math.max(0, u));
  if (p.type === 'categorical') {
    const n = p.choices?.length ?? 1;
    return (p.choices ?? [''])[Math.min(n - 1, Math.floor(t * n))];
  }
  const lo = p.low ?? 0;
  const hi = p.high ?? 1;
  let x = p.log ? Math.exp(Math.log(lo) + t * (Math.log(hi) - Math.log(lo))) : lo + t * (hi - lo);
  if (p.type === 'int') {
    const step = p.step ?? 1;
    x = Math.min(hi, Math.max(lo, lo + Math.round((x - lo) / step) * step));
    return Math.round(x);
  }
  if (p.step) {
    x = Math.min(hi, Math.max(lo, lo + Math.round((x - lo) / p.step) * p.step));
  }
  return x;
}

/** Normal padrão por Box-Muller. */
function gauss(random: () => number): number {
  const u = Math.max(1e-12, random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/** Densidade de uma mistura de gaussianas em [0, 1] com um componente uniforme de peso 1/(n+1) (o "prior"). */
function parzen(points: number[], sigma: number, x: number): number {
  const n = points.length;
  let sum = 1; // prior uniforme em [0, 1]
  for (const m of points) {
    sum += Math.exp(-0.5 * ((x - m) / sigma) ** 2) / (sigma * Math.sqrt(2 * Math.PI));
  }
  return sum / (n + 1);
}

export class BuiltinSampler {
  private readonly random: () => number;

  constructor(
    private readonly params: ParamSpec[],
    private readonly directions: Direction[],
    seed: number,
    private readonly nStartup: number,
  ) {
    this.random = rng(seed);
  }

  get name(): string {
    return this.directions.length > 1 ? 'aleatório (embutido; multiobjetivo)' : 'TPE simples (embutido)';
  }

  /** Próximo ponto. `history` inclui os trials em andamento: eles contam como ruins (a "mentira constante" do Optuna). */
  ask(history: Observation[]): Params {
    const done = history.filter((o) => o.state === 'complete' && o.values);
    if (this.directions.length > 1 || done.length < this.nStartup) {
      return Object.fromEntries(this.params.map((p) => [p.name, fromUnit(p, this.random())]));
    }
    const sign = this.directions[0] === 'maximize' ? -1 : 1;
    const sorted = [...done].sort((a, b) => sign * (a.values![0] - b.values![0]));
    const nGood = Math.max(1, Math.ceil(GAMMA * sorted.length));
    const good = sorted.slice(0, nGood);
    const bad = [...sorted.slice(nGood), ...history.filter((o) => o.state === 'running' || o.state === 'pruned')];
    const out: Params = {};
    for (const p of this.params) {
      out[p.name] = this.sampleParam(p, good.map((o) => o.params[p.name]), bad.map((o) => o.params[p.name]));
    }
    return out;
  }

  private sampleParam(p: ParamSpec, good: ParamValue[], bad: ParamValue[]): ParamValue {
    if (p.type === 'categorical') {
      const choices = p.choices ?? [];
      const k = choices.length || 1;
      const freq = (list: ParamValue[], c: ParamValue) => (list.filter((v) => String(v) === String(c)).length + 1 / k) / (list.length + 1);
      // Sorteia pela distribuição dos bons e fica com o melhor l/g entre os sorteados.
      let best = choices[0];
      let bestScore = -Infinity;
      for (let i = 0; i < CANDIDATES; i++) {
        const r = this.random() * (good.length + 1);
        const c = r < good.length ? good[Math.floor(r)] : choices[Math.floor(this.random() * k)];
        const score = Math.log(freq(good, c)) - Math.log(freq(bad, c));
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      return best;
    }
    const g = good.map((v) => toUnit(p, v));
    const b = bad.map((v) => toUnit(p, v));
    // Largura de banda de Scott com piso: poucos pontos bons não viram agulhas.
    const spread = (xs: number[]) => {
      if (xs.length < 2) {
        return 0.25;
      }
      const m = xs.reduce((s, x) => s + x, 0) / xs.length;
      return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
    };
    const sg = Math.max(0.05, Math.min(0.5, 1.06 * spread(g) * g.length ** -0.2));
    const sb = Math.max(0.05, Math.min(0.5, 1.06 * spread(b) * Math.max(1, b.length) ** -0.2));
    let best = this.random();
    let bestScore = -Infinity;
    for (let i = 0; i < CANDIDATES; i++) {
      const r = this.random() * (g.length + 1);
      const x = r < g.length ? g[Math.floor(r)] + sg * gauss(this.random) : this.random();
      const u = Math.min(1, Math.max(0, x));
      const score = Math.log(parzen(g, sg, u)) - Math.log(parzen(b, sb, u));
      if (score > bestScore) {
        bestScore = score;
        best = u;
      }
    }
    return fromUnit(p, best);
  }
}

/** Poda pela mediana: o trial para se, no mesmo passo, estiver pior que a mediana dos que terminaram. */
export function medianPrune(history: Observation[], current: Observation, step: number, direction: Direction, minFinished = 3): boolean {
  const value = current.steps?.[step];
  if (value === undefined) {
    return false;
  }
  const peers = history.filter((o) => o !== current && o.state === 'complete' && o.steps && o.steps[step] !== undefined).map((o) => o.steps![step]);
  if (peers.length < minFinished) {
    return false;
  }
  peers.sort((a, b) => a - b);
  const mid = peers.length % 2 ? peers[(peers.length - 1) / 2] : (peers[peers.length / 2 - 1] + peers[peers.length / 2]) / 2;
  return direction === 'minimize' ? value > mid : value < mid;
}

/**
 * Importância aproximada: η² (fração da variância do objetivo explicada por faixas do parâmetro), normalizada
 * para somar 1. Faixas: quartis para números, cada escolha para categóricos. Grosseira com poucos trials.
 */
export function etaSquared(params: ParamSpec[], done: { params: Params; value: number }[]): { name: string; value: number }[] {
  if (done.length < 3) {
    return [];
  }
  const ys = done.map((d) => d.value);
  const mean = ys.reduce((s, y) => s + y, 0) / ys.length;
  const total = ys.reduce((s, y) => s + (y - mean) ** 2, 0);
  if (!total) {
    return params.map((p) => ({ name: p.name, value: 0 }));
  }
  const raw = params.map((p) => {
    const groups = new Map<string, number[]>();
    if (p.type === 'categorical') {
      for (const d of done) {
        const k = String(d.params[p.name]);
        groups.set(k, [...(groups.get(k) ?? []), d.value]);
      }
    } else {
      const xs = done.map((d) => Number(d.params[p.name])).sort((a, b) => a - b);
      const bins = Math.min(4, Math.max(2, Math.floor(done.length / 3)));
      const cuts = Array.from({ length: bins - 1 }, (_, i) => xs[Math.floor(((i + 1) * xs.length) / bins)]);
      for (const d of done) {
        const x = Number(d.params[p.name]);
        const k = String(cuts.filter((c) => x >= c).length);
        groups.set(k, [...(groups.get(k) ?? []), d.value]);
      }
    }
    let between = 0;
    for (const g of groups.values()) {
      const m = g.reduce((s, y) => s + y, 0) / g.length;
      between += g.length * (m - mean) ** 2;
    }
    return { name: p.name, value: between / total };
  });
  const sum = raw.reduce((s, r) => s + r.value, 0) || 1;
  return raw.map((r) => ({ name: r.name, value: r.value / sum })).sort((a, b) => b.value - a.value);
}

/** Trials não dominados: nenhum outro é pelo menos tão bom em todos os objetivos e melhor em algum. */
export function paretoFront<T extends { values: number[] }>(items: T[], directions: Direction[]): T[] {
  const better = (a: number, b: number, d: Direction) => (d === 'minimize' ? a < b : a > b);
  const noWorse = (a: number, b: number, d: Direction) => (d === 'minimize' ? a <= b : a >= b);
  return items.filter(
    (x) => !items.some((y) => y !== x && directions.every((d, i) => noWorse(y.values[i], x.values[i], d)) && directions.some((d, i) => better(y.values[i], x.values[i], d))),
  );
}
