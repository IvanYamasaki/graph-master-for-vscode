/**
 * A porta estatística do declare_result. Determinística: mesmos runs, mesmo veredito, mesmos números.
 *
 * Suportada só quando as quatro condições valem juntas:
 *   1. cada braço tem pelo menos `minSeeds` seeds com a métrica primária;
 *   2. o IC de 95% da diferença (variante - baseline, no sentido da direção) fica todo acima de zero;
 *   3. a diferença estimada atinge a melhora mínima registrada;
 *   4. o p ajustado por Benjamini-Hochberg na família (hipóteses registradas no mesmo ramo) fica abaixo de alpha.
 * Refutada: seeds suficientes e o IC todo abaixo de zero, ou todo abaixo da melhora mínima (quando ela é > 0).
 * O resto é inconclusiva, com a estimativa de seeds que faltam.
 *
 * Limites conhecidos, ditos no veredito quando pesam:
 * - Hipótese da família ainda sem veredito entra no BH com p = 1 (conservador). O p ajustado de uma
 *   hipótese já declarada não é recalculado quando outra da família é declarada depois.
 * - Declarar de novo depois de mais seeds é parada opcional; o número da tentativa fica gravado.
 * - Seed repetida no mesmo braço: vale a última execução.
 * - A análise de poder usa a aproximação normal com correção de Guenther e alpha sem ajuste de família.
 */
import { compareArms, hashSeed, requiredN, benjaminiHochberg, type ArmData } from './stats';
import type { Hypothesis, Run, Verdict } from './store';

const MAX_SEEDS_HINT = 1000;

/** Última execução de cada seed no braço, só as que têm a métrica. */
export function armData(h: Hypothesis, runs: readonly Run[], arm: string): ArmData {
  const bySeed = new Map<number, Run>();
  for (const r of runs) {
    if (r.arm === arm && Number.isFinite(r.metrics[h.metric])) {
      bySeed.set(r.seed, r);
    }
  }
  const seeds = [...bySeed.keys()].sort((a, b) => a - b);
  const withSamples = seeds.filter((s) => bySeed.get(s)!.samples?.[h.metric]?.length);
  return {
    arm,
    values: seeds.map((s) => bySeed.get(s)!.metrics[h.metric]),
    samples: withSamples.length === seeds.length && seeds.length ? new Map(seeds.map((s) => [s, bySeed.get(s)!.samples![h.metric]])) : undefined,
  };
}

export interface FamilyMember {
  id: string;
  /** p bruto do último veredito; ausente se ainda não foi declarada. */
  p?: number;
}

export function evaluate(
  h: Hypothesis,
  runs: readonly Run[],
  family: readonly FamilyMember[],
  ctx: { by: string; attempt: number },
): Omit<Verdict, 'id'> {
  const [baseArm, varArm] = h.arms;
  const base = armData(h, runs, baseArm);
  const variant = armData(h, runs, varArm);
  const nMin = Math.min(base.values.length, variant.values.length);
  const at = new Date().toISOString();
  const common = { hypothesisId: h.id, at, by: ctx.by, attempt: ctx.attempt, ciLevel: 0.95, family: h.family };

  if (nMin < 2) {
    return {
      ...common,
      verdict: 'inconclusiva',
      mode: 'seeds',
      diff: NaN,
      ci: [NaN, NaN],
      effect: NaN,
      p: NaN,
      pAdjusted: NaN,
      familySize: Math.max(1, family.length),
      threshold: h.improvementKind === 'absolute' ? h.minImprovement : NaN,
      arms: [base, variant].map((d) => ({ arm: d.arm, n: d.values.length, mean: meanOr(d.values), sd: NaN })),
      seedsMissing: Math.max(0, h.minSeeds - nMin),
      reasons: [`Sem dados para comparar: ${baseArm} tem ${base.values.length} seed(s) e ${varArm} tem ${variant.values.length}; são precisas ao menos 2 por braço (mínimo registrado: ${h.minSeeds}).`],
      warnings: [],
    };
  }

  const cmp = compareArms(base, variant, h.direction, { seed: hashSeed(h.id) ^ 0x5eed, alpha: 1 - 0.95 });
  const threshold = h.improvementKind === 'relative' ? h.minImprovement * Math.abs(cmp.baseline.mean) : h.minImprovement;
  const others = family.filter((m) => m.id !== h.id);
  const ps = [cmp.p, ...others.map((m) => m.p ?? 1)];
  const pAdjusted = benjaminiHochberg(ps)[0];

  const enough = base.values.length >= h.minSeeds && variant.values.length >= h.minSeeds;
  const ciPositive = cmp.ci[0] > 0;
  const criterion = cmp.diff >= threshold;
  const significant = pAdjusted < h.alpha;
  const refuted = enough && (cmp.ci[1] < 0 || (threshold > 0 && cmp.ci[1] < threshold));
  const verdict = enough && ciPositive && criterion && significant ? 'suportada' : refuted ? 'refutada' : 'inconclusiva';

  const fmt = (x: number) => fmtNum(x);
  const reasons = [
    `${enough ? 'ok' : 'falta'}: seeds por braço ${base.values.length} e ${variant.values.length}, mínimo ${h.minSeeds}`,
    `${ciPositive ? 'ok' : 'falta'}: IC 95% da diferença [${fmt(cmp.ci[0])}, ${fmt(cmp.ci[1])}] ${ciPositive ? 'exclui' : 'não exclui'} zero no sentido esperado`,
    `${criterion ? 'ok' : 'falta'}: diferença ${fmt(cmp.diff)} contra melhora mínima ${fmt(threshold)}${h.improvementKind === 'relative' ? ` (${fmt(h.minImprovement * 100)}% do baseline)` : ''}`,
    `${significant ? 'ok' : 'falta'}: p ajustado (BH, família "${h.family}" com ${ps.length} hipótese(s)) ${fmt(pAdjusted)} contra alpha ${h.alpha}`,
  ];
  if (refuted) {
    reasons.push(cmp.ci[1] < 0 ? 'IC todo abaixo de zero: a variante piorou.' : 'IC todo abaixo da melhora mínima: o efeito, se existe, é menor que o exigido.');
  }
  if (others.some((m) => m.p === undefined)) {
    reasons.push(`${others.filter((m) => m.p === undefined).length} hipótese(s) da família ainda sem veredito entraram no BH com p = 1.`);
  }
  if (ctx.attempt > 1) {
    reasons.push(`Tentativa ${ctx.attempt} de declare_result nesta hipótese: repetir até dar certo infla falso positivo.`);
  }

  let seedsMissing: number | undefined;
  if (verdict === 'inconclusiva') {
    const target = cmp.diff > 0 && cmp.diff >= threshold ? cmp.diff : threshold > 0 ? threshold : NaN;
    if (cmp.mode === 'paired-samples') {
      seedsMissing = Math.max(0, h.minSeeds - nMin);
      const needUnits = requiredN(target, cmp.spread, { alpha: h.alpha, paired: true });
      if (Number.isFinite(needUnits) && needUnits > cmp.units) {
        reasons.push(`Pareado por amostra: seriam precisas cerca de ${needUnits} amostras (há ${cmp.units}).`);
      }
    } else {
      const need = requiredN(target, cmp.spread, { alpha: h.alpha });
      if (Number.isFinite(need)) {
        seedsMissing = Math.min(MAX_SEEDS_HINT, Math.max(h.minSeeds, need) - nMin);
        seedsMissing = Math.max(seedsMissing, h.minSeeds - nMin, 0);
      } else {
        reasons.push('A diferença observada não vai no sentido esperado e não há melhora mínima para mirar: mais seeds dificilmente mudam o resultado.');
      }
    }
  }

  const warnings: string[] = [];
  if (Math.abs(cmp.effect) > 3) {
    warnings.push(`Efeito muito grande (${cmp.mode === 'seeds' ? 'd' : 'd_z'} = ${fmt(cmp.effect)}). Confira vazamento entre treino e teste, bug no avaliador, cache ou seeds repetidas antes de acreditar.`);
  }
  if (cmp.baseline.sd === 0 && cmp.variant.sd === 0 && cmp.mode === 'seeds') {
    warnings.push('Variância zero nos dois braços: as seeds podem não estar mudando nada no experimento.');
  }

  return {
    ...common,
    verdict,
    mode: cmp.mode,
    diff: cmp.diff,
    relDiff: cmp.baseline.mean !== 0 ? cmp.diff / Math.abs(cmp.baseline.mean) : undefined,
    ci: cmp.ci,
    effect: cmp.effect,
    p: cmp.p,
    pAdjusted,
    familySize: ps.length,
    threshold,
    arms: [cmp.baseline, cmp.variant],
    seedsMissing,
    reasons,
    warnings,
  };
}

function meanOr(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN;
}

/** Quatro algarismos significativos, sem notação científica para valores do dia a dia. */
export function fmtNum(x: number | null | undefined): string {
  // NaN vira null no JSON gravado: os dois são "sem valor".
  if (typeof x !== 'number' || Number.isNaN(x)) {
    return '-';
  }
  if (!Number.isFinite(x)) {
    return x > 0 ? '∞' : '-∞';
  }
  if (x === 0) {
    return '0';
  }
  const abs = Math.abs(x);
  if (abs < 1e-4) {
    return x.toExponential(2);
  }
  return String(Number(x.toPrecision(4)));
}
