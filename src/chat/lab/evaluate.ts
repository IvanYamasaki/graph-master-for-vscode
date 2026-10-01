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
 *
 * Modo pareado (`comparison: "paired_bootstrap"`): um modelo congelado por braço, avaliado nas mesmas linhas. A
 * condição 1 vira "cada braço tem um run com predições e há pelo menos `minUnits` unidades em comum"; o IC e o p
 * saem do bootstrap por unidade (lab/stats.ts, pairedBootstrap). As condições 2 a 4 e a família BH são as mesmas.
 */
import { compareArms, hashSeed, mean, normInv, pairedBootstrap, requiredN, benjaminiHochberg, sd, signFlipP, tInv, type ArmData } from './stats';
import type { Hypothesis, Run, Verdict } from './store';

const MAX_SEEDS_HINT = 1000;
export const DEFAULT_MIN_UNITS = 20;
/** Fração máxima de linhas sem par em cada braço; acima disso os dois modelos não foram avaliados no mesmo conjunto. */
export const MAX_UNPAIRED_FRACTION = 0.05;

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
  if (h.comparison === 'paired_bootstrap') {
    return evaluatePaired(h, runs, family, ctx);
  }
  if (h.comparison === 'paired_seeds') {
    return evaluatePairedSeeds(h, runs, family, ctx);
  }
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

/** Último run do braço com predições por linha. */
function lastWithRows(runs: readonly Run[], arm: string): Run | undefined {
  return runs.filter((r) => r.arm === arm && r.rows?.score.length).at(-1);
}

/** Alinha os dois braços pelo id da linha. Rótulo e unidade valem os do baseline; divergência vira motivo. */
export function alignRows(
  base: Run,
  variant: Run,
): { unit: string[]; label?: number[]; base: number[]; variant: number[]; notes: string[]; unpaired: [number, number]; totals: [number, number] } {
  const b = base.rows!;
  const v = variant.rows!;
  const vIndex = new Map(v.id.map((id, i) => [id, i]));
  const out = { unit: [] as string[], label: b.label ? ([] as number[]) : undefined, base: [] as number[], variant: [] as number[], notes: [] as string[] };
  let labelDiff = 0;
  let unitDiff = 0;
  for (let i = 0; i < b.id.length; i++) {
    const j = vIndex.get(b.id[i]);
    if (j === undefined) {
      continue;
    }
    out.unit.push(b.unit[i]);
    out.base.push(b.score[i]);
    out.variant.push(v.score[j]);
    out.label?.push(b.label![i]);
    if (b.label && v.label && b.label[i] !== v.label[j]) {
      labelDiff++;
    }
    if (b.unit[i] !== v.unit[j]) {
      unitDiff++;
    }
  }
  const unpaired: [number, number] = [b.id.length - out.base.length, v.id.length - out.base.length];
  const pct = (k: number, n: number) => fmtNum((100 * k) / Math.max(1, n));
  out.notes.push(
    `Linhas sem par no outro braço, fora da comparação: ${base.arm} ${unpaired[0]} de ${b.id.length} (${pct(unpaired[0], b.id.length)}%), ${variant.arm} ${unpaired[1]} de ${v.id.length} (${pct(unpaired[1], v.id.length)}%); ${out.base.length} em comum.`,
  );
  if (labelDiff) {
    out.notes.push(`${labelDiff} linha(s) com rótulo diferente entre os braços: usei o do baseline. Os dois modelos foram avaliados no mesmo conjunto?`);
  }
  if (unitDiff) {
    out.notes.push(`${unitDiff} linha(s) com unidade diferente entre os braços: usei a do baseline.`);
  }
  return { ...out, unpaired, totals: [b.id.length, v.id.length] };
}

function evaluatePaired(h: Hypothesis, runs: readonly Run[], family: readonly FamilyMember[], ctx: { by: string; attempt: number }): Omit<Verdict, 'id'> {
  const [baseArm, varArm] = h.arms;
  const metric = h.rowMetric ?? 'mean';
  const minUnits = h.minUnits ?? DEFAULT_MIN_UNITS;
  const common = { hypothesisId: h.id, at: new Date().toISOString(), by: ctx.by, attempt: ctx.attempt, ciLevel: 0.95, family: h.family };
  const rb = lastWithRows(runs, baseArm);
  const rv = lastWithRows(runs, varArm);
  const aligned = rb && rv ? alignRows(rb, rv) : undefined;
  const units = aligned ? new Set(aligned.unit).size : 0;
  const empty = (reason: string): Omit<Verdict, 'id'> => ({
    ...common,
    verdict: 'inconclusiva',
    mode: 'paired-samples',
    diff: NaN,
    ci: [NaN, NaN],
    effect: NaN,
    p: NaN,
    pAdjusted: NaN,
    familySize: Math.max(1, family.length),
    threshold: h.improvementKind === 'absolute' ? h.minImprovement : NaN,
    arms: [rb, rv].map((r, i) => ({ arm: h.arms[i], n: r ? 1 : 0, mean: r ? r.metrics[h.metric] : NaN, sd: NaN })),
    reasons: [reason, ...(aligned?.notes ?? [])],
    warnings: [],
  });
  if (!rb || !rv || !aligned) {
    return empty(
      `Sem dados para comparar: o modo pareado precisa de um run com predições por linha em cada braço (${baseArm}: ${rb?.id ?? 'nenhum'}, ${varArm}: ${rv?.id ?? 'nenhum'}). Passe predictions_file no log_run.`,
    );
  }
  // Run gravado antes da exigência da coluna unit: sem ela o IC trataria linhas agrupadas como independentes.
  const noUnit = [rb, rv].filter((r) => r.rows!.unitFromRow);
  if (h.unit && noUnit.length) {
    return empty(`${h.id} declara a unidade "${h.unit}", mas ${noUnit.map((r) => r.id).join(' e ')} não tem coluna unit: cada linha viraria uma unidade e o IC sairia estreito demais. Registre de novo com a coluna.`);
  }
  if (aligned.base.length < 2 || units < 2) {
    return empty(`Sem dados para comparar: ${aligned.base.length} linha(s) e ${units} unidade(s) em comum entre ${rb.id} e ${rv.id}.`);
  }

  const bs = pairedBootstrap(aligned, metric, h.direction, { seed: hashSeed(h.id) ^ 0x5eed, alpha: 1 - 0.95 });
  const threshold = h.improvementKind === 'relative' ? h.minImprovement * Math.abs(bs.baseValue) : h.minImprovement;
  const others = family.filter((m) => m.id !== h.id);
  const ps = [bs.p, ...others.map((m) => m.p ?? 1)];
  const pAdjusted = benjaminiHochberg(ps)[0];

  const enough = units >= minUnits;
  const ciPositive = bs.ci[0] > 0;
  const criterion = bs.diff >= threshold;
  const significant = pAdjusted < h.alpha;
  // Linhas sem par demais: os braços não viram o mesmo conjunto, e nem suportada nem refutada valem.
  const worst = Math.max(aligned.unpaired[0] / Math.max(1, aligned.totals[0]), aligned.unpaired[1] / Math.max(1, aligned.totals[1]));
  const matched = worst <= MAX_UNPAIRED_FRACTION;
  const refuted = matched && enough && (bs.ci[1] < 0 || (threshold > 0 && bs.ci[1] < threshold));
  const verdict = matched && enough && ciPositive && criterion && significant ? 'suportada' : refuted ? 'refutada' : 'inconclusiva';

  const fmt = (x: number) => fmtNum(x);
  const reasons = [
    ...(matched
      ? []
      : [
          `falta: ${fmt(worst * 100)}% das linhas de um braço ficaram sem par, acima do limite de ${fmt(MAX_UNPAIRED_FRACTION * 100)}%. Avalie os dois modelos no mesmo conjunto, com os mesmos ids, antes de concluir.`,
        ]),
    `${enough ? 'ok' : 'falta'}: ${units} unidade(s)${h.unit ? ` (${h.unit})` : ''} em comum, ${bs.rows} linhas, mínimo ${minUnits} unidades; runs ${rb.id} (${baseArm}) e ${rv.id} (${varArm})`,
    `${ciPositive ? 'ok' : 'falta'}: IC 95% da diferença [${fmt(bs.ci[0])}, ${fmt(bs.ci[1])}] ${ciPositive ? 'exclui' : 'não exclui'} zero no sentido esperado (bootstrap por unidade, ${bs.iters} réplicas)`,
    `${criterion ? 'ok' : 'falta'}: diferença ${fmt(bs.diff)} contra melhora mínima ${fmt(threshold)}${h.improvementKind === 'relative' ? ` (${fmt(h.minImprovement * 100)}% do baseline)` : ''}`,
    `${significant ? 'ok' : 'falta'}: p ajustado (BH, família "${h.family}" com ${ps.length} hipótese(s)) ${fmt(pAdjusted)} contra alpha ${h.alpha}`,
    ...aligned.notes,
  ];
  if (refuted) {
    reasons.push(bs.ci[1] < 0 ? 'IC todo abaixo de zero: a variante piorou.' : 'IC todo abaixo da melhora mínima: o efeito, se existe, é menor que o exigido.');
  }
  if (bs.skipped) {
    reasons.push(`${bs.skipped} de ${bs.iters} réplicas sem positivo ou sem negativo foram descartadas.`);
  }
  if (others.some((m) => m.p === undefined)) {
    reasons.push(`${others.filter((m) => m.p === undefined).length} hipótese(s) da família ainda sem veredito entraram no BH com p = 1.`);
  }
  if (ctx.attempt > 1) {
    reasons.push(`Tentativa ${ctx.attempt} de declare_result nesta hipótese: repetir até dar certo infla falso positivo.`);
  }
  if (verdict === 'inconclusiva' && matched) {
    // O erro padrão cai com a raiz do número de unidades: estimativa de quantas dariam poder de 80%.
    const target = bs.diff > 0 && bs.diff >= threshold ? bs.diff : threshold > 0 ? threshold : NaN;
    const need = Math.ceil(units * (((normInv(1 - h.alpha / 2) + normInv(0.8)) * bs.se) / target) ** 2);
    reasons.push(
      Number.isFinite(need) && need > units
        ? `Mais seeds não mudam nada neste modo: o que falta são unidades. Seriam precisas cerca de ${need} (há ${units}).`
        : 'Mais seeds não mudam nada neste modo: só mais unidades avaliadas mudariam o resultado.',
    );
  }

  const warnings: string[] = [];
  if (metric === 'auc' && Math.max(bs.baseValue, bs.variantValue) >= 0.995) {
    warnings.push(`AUC quase perfeita (${fmt(Math.max(bs.baseValue, bs.variantValue))}). Confira vazamento entre treino e teste antes de acreditar.`);
  }
  if (Math.abs(bs.effect) > 3) {
    warnings.push(`Efeito muito grande por unidade (d_z = ${fmt(bs.effect)}). Confira vazamento entre treino e teste, bug no avaliador ou cache.`);
  }
  if (aligned.base.every((x, i) => x === aligned.variant[i])) {
    warnings.push('Os dois braços têm exatamente as mesmas predições: é o mesmo modelo?');
  }

  return {
    ...common,
    verdict,
    mode: 'paired-samples',
    diff: bs.diff,
    relDiff: bs.baseValue !== 0 ? bs.diff / Math.abs(bs.baseValue) : undefined,
    ci: bs.ci,
    effect: bs.effect,
    p: bs.p,
    pAdjusted,
    familySize: ps.length,
    threshold,
    arms: [
      { arm: baseArm, n: 1, mean: bs.baseValue, sd: NaN },
      { arm: varArm, n: 1, mean: bs.variantValue, sd: NaN },
    ],
    reasons,
    warnings,
    paired: { metric, unit: h.unit, units, rows: bs.rows, iters: bs.iters, runs: [rb.id, rv.id], unpaired: aligned.unpaired },
  };
}

/** Último valor da métrica por seed no braço. */
function bySeed(h: Hypothesis, runs: readonly Run[], arm: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const r of runs) {
    if (r.arm === arm && Number.isFinite(r.metrics[h.metric])) {
      out.set(r.seed, r.metrics[h.metric]);
    }
  }
  return out;
}

/**
 * Pareado por seed (`comparison: "paired_seeds"`): a seed é a instância, e os dois braços rodaram as mesmas. Cada seed
 * em comum dá uma diferença (variante - baseline, no sentido da direção). O p vem do teste exato de troca de sinais
 * (stats.ts, signFlipP) e o IC 95% da t sobre a média das diferenças. O bootstrap percentil não serve aqui: com poucas
 * seeds do mesmo sinal ele dá p ≈ 1/(réplicas+1) e um IC estreito demais. Com 5 seeds nem o teste exato fica abaixo
 * de 0,05, então o mínimo efetivo é max(min_seeds, PAIRED_SEEDS_MIN). Seed de um braço só fica de fora e aparece nos
 * motivos.
 */
function evaluatePairedSeeds(h: Hypothesis, runs: readonly Run[], family: readonly FamilyMember[], ctx: { by: string; attempt: number }): Omit<Verdict, 'id'> {
  const [baseArm, varArm] = h.arms;
  const b = bySeed(h, runs, baseArm);
  const v = bySeed(h, runs, varArm);
  const seeds = [...b.keys()].filter((s) => v.has(s)).sort((x, y) => x - y);
  const unpaired: [number, number] = [b.size - seeds.length, v.size - seeds.length];
  const unit = h.unit || 'seed';
  const minSeeds = pairedSeedsMin(h);
  const common = { hypothesisId: h.id, at: new Date().toISOString(), by: ctx.by, attempt: ctx.attempt, ciLevel: 0.95, family: h.family };
  const baseVals = seeds.map((s) => b.get(s)!);
  const varVals = seeds.map((s) => v.get(s)!);
  const exact = seeds.length <= 20;
  const unpairedNote = unpaired[0] || unpaired[1] ? [`Seeds sem par no outro braço, fora da comparação: ${baseArm} ${unpaired[0]}, ${varArm} ${unpaired[1]}.`] : [];
  if (seeds.length < 2) {
    return {
      ...common,
      verdict: 'inconclusiva',
      mode: 'paired-samples',
      diff: NaN,
      ci: [NaN, NaN],
      effect: NaN,
      p: NaN,
      pAdjusted: NaN,
      familySize: Math.max(1, family.length),
      threshold: h.improvementKind === 'absolute' ? h.minImprovement : NaN,
      arms: [
        { arm: baseArm, n: seeds.length, mean: meanOr(baseVals), sd: NaN },
        { arm: varArm, n: seeds.length, mean: meanOr(varVals), sd: NaN },
      ],
      seedsMissing: Math.max(0, minSeeds - seeds.length),
      reasons: [`Sem dados para comparar: ${seeds.length} seed(s) em comum entre ${baseArm} e ${varArm}; são precisas ao menos ${minSeeds}.`, ...unpairedNote],
      warnings: [],
      pairedSeeds: { seeds: seeds.length, unit: h.unit, exact, unpaired },
    };
  }

  const sign = h.direction === 'higher' ? 1 : -1;
  const diffs = varVals.map((x, i) => sign * (x - baseVals[i]));
  const n = diffs.length;
  const diff = mean(diffs);
  const s = sd(diffs);
  const half = (tInv(0.975, n - 1) * s) / Math.sqrt(n);
  const ci: [number, number] = [diff - half, diff + half];
  const p = signFlipP(diffs, { seed: hashSeed(h.id) ^ 0x5eed });
  const effect = s === 0 ? (diff === 0 ? 0 : Math.sign(diff) * Infinity) : diff / s;
  const baseMean = mean(baseVals);
  const threshold = h.improvementKind === 'relative' ? h.minImprovement * Math.abs(baseMean) : h.minImprovement;
  const others = family.filter((m) => m.id !== h.id);
  const ps = [p, ...others.map((m) => m.p ?? 1)];
  const pAdjusted = benjaminiHochberg(ps)[0];

  const enough = n >= minSeeds;
  const ciPositive = ci[0] > 0;
  const criterion = diff >= threshold;
  const significant = pAdjusted < h.alpha;
  const refuted = enough && (ci[1] < 0 || (threshold > 0 && ci[1] < threshold));
  const verdict = enough && ciPositive && criterion && significant ? 'suportada' : refuted ? 'refutada' : 'inconclusiva';

  const fmt = (x: number) => fmtNum(x);
  const reasons = [
    `${enough ? 'ok' : 'falta'}: ${n} ${unit}(s) em comum nos dois braços, mínimo ${minSeeds}${minSeeds > h.minSeeds ? ` (o registrado era ${h.minSeeds}; com menos de ${PAIRED_SEEDS_MIN} nem o teste exato fica abaixo de 0,05)` : ''}`,
    `${ciPositive ? 'ok' : 'falta'}: IC 95% da diferença [${fmt(ci[0])}, ${fmt(ci[1])}] ${ciPositive ? 'exclui' : 'não exclui'} zero no sentido esperado (t pareado por ${unit}, ${n - 1} graus de liberdade)`,
    `${criterion ? 'ok' : 'falta'}: diferença ${fmt(diff)} contra melhora mínima ${fmt(threshold)}${h.improvementKind === 'relative' ? ` (${fmt(h.minImprovement * 100)}% do baseline)` : ''}`,
    `${significant ? 'ok' : 'falta'}: p ajustado (BH, família "${h.family}" com ${ps.length} hipótese(s)) ${fmt(pAdjusted)} contra alpha ${h.alpha}; p bruto do teste de troca de sinais ${exact ? 'exato' : 'por Monte Carlo'} ${fmt(p)}`,
    ...unpairedNote,
  ];
  if (refuted) {
    reasons.push(ci[1] < 0 ? 'IC todo abaixo de zero: a variante piorou.' : 'IC todo abaixo da melhora mínima: o efeito, se existe, é menor que o exigido.');
  }
  if (others.some((m) => m.p === undefined)) {
    reasons.push(`${others.filter((m) => m.p === undefined).length} hipótese(s) da família ainda sem veredito entraram no BH com p = 1.`);
  }
  if (ctx.attempt > 1) {
    reasons.push(`Tentativa ${ctx.attempt} de declare_result nesta hipótese: repetir até dar certo infla falso positivo.`);
  }
  let seedsMissing: number | undefined;
  if (verdict === 'inconclusiva') {
    const target = diff > 0 && diff >= threshold ? diff : threshold > 0 ? threshold : NaN;
    const need = requiredN(target, s, { alpha: h.alpha, paired: true });
    const want = Number.isFinite(need) ? Math.max(minSeeds, need) : minSeeds;
    seedsMissing = Math.min(MAX_SEEDS_HINT, Math.max(0, want - n));
    if (!enough) {
      reasons.push(`Faltam ${minSeeds - n} ${unit}(s) em comum para o mínimo; rode as mesmas seeds nos dois braços.`);
    }
  }

  const warnings: string[] = [];
  if (Math.abs(effect) > 3) {
    warnings.push(`Efeito muito grande por ${unit} (d_z = ${fmt(effect)}). Confira bug no avaliador, cache ou braços trocados antes de acreditar.`);
  }
  if (s === 0 && diff !== 0) {
    warnings.push(`A diferença é a mesma em todas as ${n} seeds: o IC pela t fica com largura zero; o p do teste de troca de sinais continua valendo.`);
  }
  if (baseVals.every((x, i) => x === varVals[i])) {
    warnings.push(`Os dois braços deram exatamente o mesmo valor em todas as ${n} seeds: é o mesmo código?`);
  }

  return {
    ...common,
    verdict,
    mode: 'paired-samples',
    diff,
    relDiff: baseMean !== 0 ? diff / Math.abs(baseMean) : undefined,
    ci,
    effect,
    p,
    pAdjusted,
    familySize: ps.length,
    threshold,
    arms: [
      { arm: baseArm, n, mean: baseMean, sd: sd(baseVals) },
      { arm: varArm, n, mean: mean(varVals), sd: sd(varVals) },
    ],
    seedsMissing,
    reasons,
    warnings,
    pairedSeeds: { seeds: n, unit: h.unit, exact, unpaired },
  };
}

/** Com 5 diferenças do mesmo sinal o teste exato de troca de sinais dá 0,0625: abaixo de 6 seeds nada passa a 0,05. */
export const PAIRED_SEEDS_MIN = 6;

/** Seeds em comum exigidas por uma hipótese paired_seeds. */
export function pairedSeedsMin(h: Hypothesis): number {
  return Math.max(h.minSeeds, PAIRED_SEEDS_MIN);
}

/**
 * Hipótese de seeds que parece pareada por instância: os dois braços rodaram o mesmo conjunto de seeds (2 ou mais) e
 * (a) a mesma seed repetida no mesmo braço deu o mesmo valor (determinístico) ou (b) o enunciado ou o comando fala
 * em instância. Devolve o motivo, para sugerir comparison "paired_seeds"; undefined se não parece.
 */
export function pairedHint(h: Hypothesis, runs: readonly Run[]): string | undefined {
  if (h.comparison && h.comparison !== 'seeds') {
    return undefined;
  }
  const [a, b] = h.arms.map((arm) => bySeed(h, runs, arm));
  if (a.size < 2 || a.size !== b.size || [...a.keys()].some((s) => !b.has(s))) {
    return undefined;
  }
  const seen = new Map<string, number>();
  let repeatedSame = false;
  for (const r of runs) {
    const x = r.metrics[h.metric];
    if (!Number.isFinite(x)) {
      continue;
    }
    const key = `${r.arm}#${r.seed}`;
    const prev = seen.get(key);
    if (prev !== undefined && prev === x) {
      repeatedSame = true;
    }
    seen.set(key, x);
  }
  const text = [h.statement, ...runs.map((r) => r.command ?? '')].join('\n');
  const instance = /inst[âa]ncia|instance|determin[íi]stic|deterministic/i.test(text);
  if (!repeatedSame && !instance) {
    return undefined;
  }
  return repeatedSame ? 'a mesma seed repetida deu o mesmo valor (execução determinística)' : 'o enunciado ou o comando indica que a seed é a instância';
}

/**
 * A hipótese já tem dados para declare_result: seeds mínimas em cada braço (seeds), seeds em comum (paired_seeds)
 * ou um run com predições por braço (paired_bootstrap). Avaliação única e varredura nunca.
 */
export function readyToDeclare(h: Hypothesis, runs: readonly Run[]): boolean {
  if (h.sweepId || h.comparison === 'single') {
    return false;
  }
  if (h.comparison === 'paired_bootstrap') {
    return h.arms.every((arm) => runs.some((r) => r.arm === arm && r.rows?.score.length));
  }
  const [a, b] = h.arms.map((arm) => bySeed(h, runs, arm));
  if (h.comparison === 'paired_seeds') {
    return [...a.keys()].filter((s) => b.has(s)).length >= pairedSeedsMin(h);
  }
  return a.size >= h.minSeeds && b.size >= h.minSeeds;
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
