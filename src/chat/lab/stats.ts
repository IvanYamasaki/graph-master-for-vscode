/**
 * Estatística do laboratório. TypeScript puro, sem VS Code e sem dependência: o teste roda com node.
 *
 * Tudo aqui é determinístico. O bootstrap usa um gerador com semente fixa, então o mesmo conjunto de runs
 * devolve o mesmo intervalo em qualquer máquina e em qualquer ordem de chamada.
 *
 * Convenção de sinal: `diff` é variante menos baseline, multiplicado por +1 quando maior é melhor e por -1
 * quando menor é melhor. Diferença positiva quer dizer "a variante melhorou", nas duas direções.
 */

export type Direction = 'higher' | 'lower';

export function mean(xs: readonly number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN;
}

/** Desvio padrão amostral (n - 1). Com um valor só, 0. */
export function sd(xs: readonly number[]): number {
  if (xs.length < 2) {
    return 0;
  }
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Mulberry32: 32 bits de estado, rápido e reprodutível. Não é criptográfico, nem precisa. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash FNV-1a de um texto, para derivar a semente do bootstrap do id da hipótese. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Quantil por interpolação linear (o tipo 7 do R, padrão do numpy). `sorted` já ordenado. */
export function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) {
    return NaN;
  }
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function resampleMean(xs: readonly number[], rand: () => number): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) {
    s += xs[Math.floor(rand() * xs.length)];
  }
  return s / xs.length;
}

/** IC percentil da média de uma amostra de diferenças (caso pareado). */
export function bootstrapMeanCI(diffs: readonly number[], opts: { iters?: number; seed?: number; alpha?: number } = {}): [number, number] {
  const { iters = 10000, seed = 1, alpha = 0.05 } = opts;
  const rand = rng(seed);
  const stats = new Array<number>(iters);
  for (let i = 0; i < iters; i++) {
    stats[i] = resampleMean(diffs, rand);
  }
  stats.sort((x, y) => x - y);
  return [quantile(stats, alpha / 2), quantile(stats, 1 - alpha / 2)];
}

/** IC percentil de mean(b) - mean(a), reamostrando cada braço por conta própria (caso não pareado). */
export function bootstrapDiffCI(
  a: readonly number[],
  b: readonly number[],
  opts: { iters?: number; seed?: number; alpha?: number } = {},
): [number, number] {
  const { iters = 10000, seed = 1, alpha = 0.05 } = opts;
  const rand = rng(seed);
  const stats = new Array<number>(iters);
  for (let i = 0; i < iters; i++) {
    stats[i] = resampleMean(b, rand) - resampleMean(a, rand);
  }
  stats.sort((x, y) => x - y);
  return [quantile(stats, alpha / 2), quantile(stats, 1 - alpha / 2)];
}

// ---------- Distribuições ----------

function logGamma(x: number): number {
  // Lanczos, g = 7. Erro relativo abaixo de 1e-13 no intervalo que usamos.
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  x -= 1;
  let s = c[0];
  for (let i = 1; i < 9; i++) {
    s += c[i] / (x + i);
  }
  const t = x + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(s);
}

/** Fração contínua da beta incompleta (Numerical Recipes, método de Lentz). */
function betacf(a: number, b: number, x: number): number {
  const TINY = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  d = Math.abs(d) < TINY ? TINY : d;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    d = Math.abs(d) < TINY ? TINY : d;
    c = 1 + aa / c;
    c = Math.abs(c) < TINY ? TINY : c;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    d = Math.abs(d) < TINY ? TINY : d;
    c = 1 + aa / c;
    c = Math.abs(c) < TINY ? TINY : c;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) {
      break;
    }
  }
  return h;
}

/** Beta incompleta regularizada I_x(a, b). */
export function incBeta(x: number, a: number, b: number): number {
  if (x <= 0) {
    return 0;
  }
  if (x >= 1) {
    return 1;
  }
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (front * betacf(a, b, x)) / a : 1 - (front * betacf(b, a, 1 - x)) / b;
}

/** p bilateral da t de Student com `df` graus de liberdade. */
export function tTwoSided(t: number, df: number): number {
  if (!Number.isFinite(t)) {
    return Number.isNaN(t) ? 1 : 0;
  }
  return incBeta(df / (df + t * t), df / 2, 0.5);
}

/** Inversa da normal padrão (Acklam). Erro relativo abaixo de 1.2e-9. */
export function normInv(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lowP = 0.02425;
  if (p < lowP) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lowP) {
    return -normInv(1 - p);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// ---------- Testes ----------

export interface TestResult {
  t: number;
  df: number;
  p: number;
}

/** Teste t de Welch, bilateral, para mean(b) - mean(a). Variância zero nos dois braços vira p 0 ou 1. */
export function welch(a: readonly number[], b: readonly number[]): TestResult {
  const va = sd(a) ** 2 / a.length;
  const vb = sd(b) ** 2 / b.length;
  const diff = mean(b) - mean(a);
  const se = Math.sqrt(va + vb);
  if (se === 0) {
    return { t: diff === 0 ? 0 : Math.sign(diff) * Infinity, df: a.length + b.length - 2, p: diff === 0 ? 1 : 0 };
  }
  const df = (va + vb) ** 2 / ((va * va) / (a.length - 1) + (vb * vb) / (b.length - 1));
  const t = diff / se;
  return { t, df, p: tTwoSided(t, df) };
}

/** Teste t de uma amostra (média 0), bilateral: o teste pareado sobre as diferenças. */
export function pairedT(diffs: readonly number[]): TestResult {
  const m = mean(diffs);
  const se = sd(diffs) / Math.sqrt(diffs.length);
  const df = diffs.length - 1;
  if (se === 0) {
    return { t: m === 0 ? 0 : Math.sign(m) * Infinity, df, p: m === 0 ? 1 : 0 };
  }
  const t = m / se;
  return { t, df, p: tTwoSided(t, df) };
}

/** Quantil da t de Student: o t com P(T <= t) = q, por bisseção sobre tTwoSided. */
export function tInv(q: number, df: number): number {
  if (q === 0.5) {
    return 0;
  }
  const upper = q > 0.5;
  const tail = 2 * (upper ? 1 - q : q);
  let lo = 0;
  let hi = 1;
  while (tTwoSided(hi, df) > tail && hi < 1e6) {
    hi *= 2;
  }
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (tTwoSided(mid, df) > tail) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const t = (lo + hi) / 2;
  return upper ? t : -t;
}

const SIGN_FLIP_EXACT_MAX = 20;
const SIGN_FLIP_DRAWS = 20000;

/**
 * Teste de troca de sinais (permutação pareada), bilateral, para média das diferenças = 0. Exato até 20 diferenças
 * (2^n sinais), Monte Carlo com semente acima. Não supõe normalidade e com n pequeno não passa de 2/2^n: com 5
 * diferenças do mesmo sinal o p é 0,0625, e só com 6 ou mais dá para ficar abaixo de 0,05.
 */
export function signFlipP(diffs: readonly number[], opts: { seed?: number } = {}): number {
  const n = diffs.length;
  const total = diffs.reduce((s, x) => s + x, 0);
  if (!n || total === 0) {
    return 1;
  }
  const target = Math.abs(total) * (1 - 1e-12);
  let extreme = 0;
  if (n <= SIGN_FLIP_EXACT_MAX) {
    // Soma de cada subconjunto de sinais trocados, pelo bit mais baixo: a soma do padrão é total - 2 * subconjunto.
    const size = 1 << n;
    const sub = new Float64Array(size);
    for (let mask = 1; mask < size; mask++) {
      const low = mask & -mask;
      sub[mask] = sub[mask ^ low] + diffs[31 - Math.clz32(low)];
      if (Math.abs(total - 2 * sub[mask]) >= target) {
        extreme++;
      }
    }
    return (extreme + 1) / size;
  }
  const rand = rng(opts.seed ?? 0x5eed);
  for (let b = 0; b < SIGN_FLIP_DRAWS; b++) {
    let s = 0;
    for (const d of diffs) {
      s += rand() < 0.5 ? -d : d;
    }
    if (Math.abs(s) >= target) {
      extreme++;
    }
  }
  return (extreme + 1) / (SIGN_FLIP_DRAWS + 1);
}

/** d de Cohen com desvio combinado. Sem variância, 0 (ou infinito com sinal se as médias diferem). */
export function cohenD(a: readonly number[], b: readonly number[]): number {
  const na = a.length;
  const nb = b.length;
  const pooled = Math.sqrt(((na - 1) * sd(a) ** 2 + (nb - 1) * sd(b) ** 2) / Math.max(1, na + nb - 2));
  const diff = mean(b) - mean(a);
  return pooled === 0 ? (diff === 0 ? 0 : Math.sign(diff) * Infinity) : diff / pooled;
}

/**
 * Benjamini-Hochberg: p ajustado de cada posição, na ordem de entrada. Controla a taxa de falsas descobertas
 * da família. `p_adj(i) = min_{j >= i} (m / j) * p_(j)`, limitado a 1.
 */
export function benjaminiHochberg(ps: readonly number[]): number[] {
  const m = ps.length;
  const order = ps.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p);
  const adj = new Array<number>(m);
  let running = 1;
  for (let k = m - 1; k >= 0; k--) {
    running = Math.min(running, (order[k].p * m) / (k + 1));
    adj[order[k].i] = Math.min(1, running);
  }
  return adj;
}

/**
 * Seeds (ou amostras pareadas) por braço para detectar um efeito `delta` com o desvio `s`, poder `power`,
 * teste bilateral a `alpha`. Aproximação normal com a correção de Guenther (+ z²/4), que compensa a t em
 * amostras pequenas. `paired`: uma amostra de diferenças em vez de dois braços.
 */
export function requiredN(delta: number, s: number, opts: { alpha?: number; power?: number; paired?: boolean } = {}): number {
  const { alpha = 0.05, power = 0.8, paired = false } = opts;
  if (!(delta > 0)) {
    return Infinity;
  }
  if (s === 0) {
    return 2;
  }
  const za = normInv(1 - alpha / 2);
  const zb = normInv(power);
  const k = paired ? 1 : 2;
  return Math.max(2, Math.ceil((k * ((za + zb) * s) ** 2) / delta ** 2 + (za * za) / 4));
}

// ---------- Comparação completa de dois braços ----------

export interface ArmSummary {
  arm: string;
  n: number;
  mean: number;
  sd: number;
}

export interface Comparison {
  mode: 'paired-samples' | 'seeds';
  baseline: ArmSummary;
  variant: ArmSummary;
  /** Variante menos baseline, com sinal da direção: positivo é melhora. */
  diff: number;
  ci: [number, number];
  /** Cohen d (seeds) ou d_z (pareado), com o mesmo sinal de `diff`. */
  effect: number;
  t: number;
  df: number;
  p: number;
  /** Unidades usadas no pareado (amostras); nas seeds, igual ao n do menor braço. */
  units: number;
  /** Desvio usado na análise de poder: combinado das seeds ou das diferenças pareadas. */
  spread: number;
}

export interface ArmData {
  arm: string;
  /** Um valor por seed. */
  values: number[];
  /** Valores por amostra de cada seed, quando houver: seed → vetor. */
  samples?: Map<number, number[]>;
}

/**
 * Diferenças pareadas por amostra, quando dá para parear: as mesmas seeds nos dois braços, cada uma com vetor
 * de amostras do mesmo tamanho. A diferença de cada amostra é a média, entre as seeds, de variante - baseline.
 */
export function pairedDiffs(base: ArmData, variant: ArmData): number[] | undefined {
  if (!base.samples?.size || !variant.samples?.size) {
    return undefined;
  }
  const seeds = [...base.samples.keys()].filter((s) => variant.samples!.has(s)).sort((x, y) => x - y);
  if (!seeds.length || seeds.length !== base.samples.size || seeds.length !== variant.samples.size) {
    return undefined;
  }
  const len = base.samples.get(seeds[0])!.length;
  if (len < 2 || seeds.some((s) => base.samples!.get(s)!.length !== len || variant.samples!.get(s)!.length !== len)) {
    return undefined;
  }
  const out = new Array<number>(len).fill(0);
  for (const s of seeds) {
    const a = base.samples.get(s)!;
    const b = variant.samples.get(s)!;
    for (let i = 0; i < len; i++) {
      out[i] += (b[i] - a[i]) / seeds.length;
    }
  }
  return out;
}

export function compareArms(base: ArmData, variant: ArmData, direction: Direction, opts: { seed: number; alpha?: number; iters?: number }): Comparison {
  const sign = direction === 'higher' ? 1 : -1;
  const alpha = opts.alpha ?? 0.05;
  const summary = (d: ArmData): ArmSummary => ({ arm: d.arm, n: d.values.length, mean: mean(d.values), sd: sd(d.values) });
  const flip = ([lo, hi]: [number, number]): [number, number] => (sign > 0 ? [lo, hi] : [-hi, -lo]);
  const paired = pairedDiffs(base, variant);
  if (paired) {
    const test = pairedT(paired);
    const m = mean(paired);
    const s = sd(paired);
    return {
      mode: 'paired-samples',
      baseline: summary(base),
      variant: summary(variant),
      diff: sign * m,
      ci: flip(bootstrapMeanCI(paired, { seed: opts.seed, alpha, iters: opts.iters })),
      effect: s === 0 ? (m === 0 ? 0 : sign * Math.sign(m) * Infinity) : (sign * m) / s,
      t: sign * test.t,
      df: test.df,
      p: test.p,
      units: paired.length,
      spread: s,
    };
  }
  const test = welch(base.values, variant.values);
  const na = base.values.length;
  const nb = variant.values.length;
  const pooled = Math.sqrt(((na - 1) * sd(base.values) ** 2 + (nb - 1) * sd(variant.values) ** 2) / Math.max(1, na + nb - 2));
  return {
    mode: 'seeds',
    baseline: summary(base),
    variant: summary(variant),
    diff: sign * (mean(variant.values) - mean(base.values)),
    ci: flip(bootstrapDiffCI(base.values, variant.values, { seed: opts.seed, alpha, iters: opts.iters })),
    effect: sign * cohenD(base.values, variant.values),
    t: sign * test.t,
    df: test.df,
    p: test.p,
    units: Math.min(na, nb),
    spread: pooled,
  };
}

// ---------- Modelo congelado: bootstrap pareado por unidade ----------

/**
 * Como a métrica sai das linhas: `auc` usa rótulo 0/1 e score; `mean` é a média do score (o score já é a métrica
 * da linha, como acerto ou perda); `accuracy` compara score >= 0.5 com o rótulo; `brier` e `logloss` usam o score
 * como probabilidade da classe 1.
 */
export type RowMetric = 'auc' | 'mean' | 'accuracy' | 'brier' | 'logloss';
export const ROW_METRICS: readonly RowMetric[] = ['auc', 'mean', 'accuracy', 'brier', 'logloss'];

/** Direção natural de cada métrica por linha; `mean` depende do que o score mede. */
export const ROW_METRIC_DIRECTION: Record<RowMetric, Direction | undefined> = { auc: 'higher', accuracy: 'higher', brier: 'lower', logloss: 'lower', mean: undefined };

/** Valor da linha nas métricas que são média; `auc` não é média de linhas e fica de fora. */
export function rowValue(metric: Exclude<RowMetric, 'auc'>, score: number, label: number): number {
  switch (metric) {
    case 'accuracy':
      return (score >= 0.5 ? 1 : 0) === label ? 1 : 0;
    case 'brier':
      return (score - label) ** 2;
    case 'logloss': {
      const p = Math.min(1 - 1e-15, Math.max(1e-15, score));
      return -(label * Math.log(p) + (1 - label) * Math.log(1 - p));
    }
    default:
      return score;
  }
}

/**
 * AUC com peso por linha, a partir da ordem já calculada (índices em ordem crescente de score, com os limites
 * dos grupos de empate). Empate conta meio par. O(n): o bootstrap só troca os pesos, nunca reordena.
 */
function weightedAuc(sorted: SortedScores, labels: readonly number[], w: ArrayLike<number>): number {
  let negBelow = 0;
  let pos = 0;
  let neg = 0;
  let acc = 0;
  for (let g = 0; g < sorted.groups.length - 1; g++) {
    let gp = 0;
    let gn = 0;
    for (let k = sorted.groups[g]; k < sorted.groups[g + 1]; k++) {
      const i = sorted.order[k];
      if (labels[i] === 1) {
        gp += w[i];
      } else {
        gn += w[i];
      }
    }
    acc += gp * (negBelow + gn / 2);
    negBelow += gn;
    pos += gp;
    neg += gn;
  }
  return pos > 0 && neg > 0 ? acc / (pos * neg) : NaN;
}

interface SortedScores {
  order: Int32Array;
  /** Início de cada grupo de score igual em `order`, mais o fim (n). */
  groups: number[];
}

function sortScores(scores: readonly number[]): SortedScores {
  const order = Int32Array.from(scores.keys()).sort((a, b) => scores[a] - scores[b]);
  const groups = [0];
  for (let k = 1; k < order.length; k++) {
    if (scores[order[k]] !== scores[order[k - 1]]) {
      groups.push(k);
    }
  }
  groups.push(order.length);
  return { order, groups };
}

/** AUC sem peso (todas as linhas valem 1). */
export function auc(labels: readonly number[], scores: readonly number[]): number {
  return weightedAuc(sortScores(scores), labels, new Float64Array(labels.length).fill(1));
}

export interface PairedRows {
  /** Unidade (cluster) de cada linha: paciente, cliente, dia. Linhas da mesma unidade saem juntas na reamostragem. */
  unit: readonly string[];
  /** Rótulo 0/1; obrigatório para auc, accuracy, brier e logloss. */
  label?: readonly number[];
  base: readonly number[];
  variant: readonly number[];
}

export interface PairedBootstrap {
  /** Variante menos baseline, com o sinal da direção. */
  diff: number;
  ci: [number, number];
  /** p bilateral do bootstrap deslocado: fração das réplicas com |d* - d| >= |d|, com correção +1. */
  p: number;
  baseValue: number;
  variantValue: number;
  /** Erro padrão da diferença entre as réplicas (sem sinal). */
  se: number;
  /** d_z por unidade (média das diferenças por unidade sobre o desvio delas); NaN na AUC, que não é média de linhas. */
  effect: number;
  units: number;
  rows: number;
  iters: number;
  /** Réplicas descartadas porque a AUC não existia nelas (sem positivo ou sem negativo). */
  skipped: number;
}

/** Réplicas: 10000 em conjunto pequeno, menos quando as linhas são muitas (custo O(linhas) por réplica), nunca abaixo de 1000. */
export function pairedIters(rows: number): number {
  return Math.max(1000, Math.min(10000, Math.floor(2e7 / Math.max(1, rows))));
}

/**
 * Compara dois modelos congelados avaliados nas mesmas linhas. Reamostra unidades inteiras com reposição (bootstrap
 * por cluster) e recalcula a métrica dos dois braços com os mesmos pesos em cada réplica, então a diferença é pareada.
 * Determinístico pela semente.
 */
export function pairedBootstrap(rows: PairedRows, metric: RowMetric, direction: Direction, opts: { seed: number; alpha?: number; iters?: number }): PairedBootstrap {
  const n = rows.base.length;
  const sign = direction === 'higher' ? 1 : -1;
  const alpha = opts.alpha ?? 0.05;
  const iters = opts.iters ?? pairedIters(n);
  const unitIndex = new Map<string, number>();
  const unitOf = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let u = unitIndex.get(rows.unit[i]);
    if (u === undefined) {
      u = unitIndex.size;
      unitIndex.set(rows.unit[i], u);
    }
    unitOf[i] = u;
  }
  const K = unitIndex.size;
  const labels = rows.label ?? [];

  let stat: (w: ArrayLike<number>) => [number, number];
  if (metric === 'auc') {
    const sb = sortScores(rows.base);
    const sv = sortScores(rows.variant);
    stat = (w) => [weightedAuc(sb, labels, w), weightedAuc(sv, labels, w)];
  } else {
    const vb = rows.base.map((s, i) => rowValue(metric, s, labels[i]));
    const vv = rows.variant.map((s, i) => rowValue(metric, s, labels[i]));
    stat = (w) => {
      let sw = 0;
      let b = 0;
      let v = 0;
      for (let i = 0; i < n; i++) {
        sw += w[i];
        b += w[i] * vb[i];
        v += w[i] * vv[i];
      }
      return sw > 0 ? [b / sw, v / sw] : [NaN, NaN];
    };
  }

  const ones = new Float64Array(n).fill(1);
  const [baseValue, variantValue] = stat(ones);
  const raw = variantValue - baseValue;

  const rand = rng(opts.seed);
  const counts = new Float64Array(K);
  const w = new Float64Array(n);
  const reps: number[] = [];
  let skipped = 0;
  for (let b = 0; b < iters; b++) {
    counts.fill(0);
    for (let k = 0; k < K; k++) {
      counts[Math.floor(rand() * K)]++;
    }
    for (let i = 0; i < n; i++) {
      w[i] = counts[unitOf[i]];
    }
    const [x, y] = stat(w);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      reps.push(y - x);
    } else {
      skipped++;
    }
  }
  reps.sort((x, y) => x - y);
  const lo = quantile(reps, alpha / 2);
  const hi = quantile(reps, 1 - alpha / 2);
  const extreme = reps.filter((d) => Math.abs(d - raw) >= Math.abs(raw) - 1e-15).length;

  let effect = NaN;
  if (metric !== 'auc') {
    // d_z por unidade: diferença média de cada unidade, e a média e o desvio delas.
    const sum = new Float64Array(K);
    const cnt = new Float64Array(K);
    for (let i = 0; i < n; i++) {
      sum[unitOf[i]] += rowValue(metric, rows.variant[i], labels[i]) - rowValue(metric, rows.base[i], labels[i]);
      cnt[unitOf[i]]++;
    }
    const perUnit = Array.from(sum, (s, k) => s / cnt[k]);
    const m = mean(perUnit);
    const s = sd(perUnit);
    effect = s === 0 ? (m === 0 ? 0 : sign * Math.sign(m) * Infinity) : (sign * m) / s;
  }

  return {
    diff: sign * raw,
    ci: sign > 0 ? [lo, hi] : [-hi, -lo],
    p: raw === 0 || !reps.length ? 1 : Math.min(1, (1 + extreme) / (reps.length + 1)),
    baseValue,
    variantValue,
    se: sd(reps),
    effect,
    units: K,
    rows: n,
    iters,
    skipped,
  };
}
