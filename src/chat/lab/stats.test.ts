/**
 * Testes do stats.ts contra valores do scipy 1.17 e do statsmodels. Sem framework:
 *   npx esbuild src/chat/lab/stats.test.ts --bundle --platform=node --outfile=$TEMP/stats.test.js && node $TEMP/stats.test.js
 * (fora de out/, para o teste não entrar no .vsix)
 */
import * as assert from 'node:assert/strict';
import {
  benjaminiHochberg,
  bootstrapDiffCI,
  bootstrapMeanCI,
  cohenD,
  compareArms,
  mean,
  normInv,
  pairedT,
  requiredN,
  sd,
  tTwoSided,
  welch,
} from './stats';

let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n     ${err instanceof Error ? err.message : String(err)}`);
  }
}
function near(actual: number, expected: number, tol: number, what: string): void {
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} longe de ${expected} (tolerância ${tol})`);
}

test('média e desvio amostral', () => {
  near(mean([1, 2, 3, 4, 5]), 3, 1e-12, 'média');
  near(sd([1, 2, 3, 4, 5]), Math.sqrt(2.5), 1e-12, 'sd');
  assert.equal(sd([7]), 0);
});

test('p bilateral da t (scipy: 2*t.sf(2, 10) = 0.0733880347707)', () => {
  near(tTwoSided(2, 10), 0.07338803477074039, 1e-9, 'p');
  near(tTwoSided(2.228138851986274, 10), 0.05, 1e-9, 'p crítico');
  near(tTwoSided(0, 5), 1, 1e-12, 'p em t=0');
});

test('inversa da normal', () => {
  near(normInv(0.975), 1.959963984540054, 1e-8, 'z 0.975');
  near(normInv(0.8), 0.8416212335729143, 1e-8, 'z 0.8');
  near(normInv(0.01), -2.3263478740408408, 1e-8, 'z 0.01');
});

test('Welch (scipy ttest_ind equal_var=False)', () => {
  const r = welch([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
  near(r.t, 1.8973665961010275, 1e-9, 't');
  near(r.df, 5.882352941176471, 1e-9, 'df');
  near(r.p, 0.10753119493062728, 1e-8, 'p');
});

test('t pareado (scipy ttest_1samp)', () => {
  const r = pairedT([0.5, 1.2, -0.3, 0.8, 1.1, 0.4]);
  near(r.t, 2.7501883411145154, 1e-9, 't');
  near(r.p, 0.0403012081350972, 1e-8, 'p');
});

test('variância zero não vira NaN', () => {
  assert.equal(welch([1, 1, 1], [2, 2, 2]).p, 0);
  assert.equal(welch([1, 1, 1], [1, 1, 1]).p, 1);
});

test('Benjamini-Hochberg (statsmodels fdr_bh)', () => {
  const adj = benjaminiHochberg([0.01, 0.04, 0.03, 0.005]);
  [0.02, 0.04, 0.04, 0.02].forEach((e, i) => near(adj[i], e, 1e-12, `p_adj[${i}]`));
  near(benjaminiHochberg([0.03])[0], 0.03, 1e-12, 'família de um');
});

test('Cohen d', () => {
  near(cohenD([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]), 3 / Math.sqrt((4 * 2.5 + 4 * 10) / 8), 1e-12, 'd');
});

test('poder (statsmodels: d=1 → 16.7, d=0.5 → 63.8, pareado d=0.5 → 33.4)', () => {
  assert.equal(requiredN(1, 1), 17);
  assert.ok(Math.abs(requiredN(0.5, 1) - 64) <= 1, `d=0.5: ${requiredN(0.5, 1)}`);
  assert.ok(Math.abs(requiredN(0.5, 1, { paired: true }) - 34) <= 1, `pareado: ${requiredN(0.5, 1, { paired: true })}`);
  assert.equal(requiredN(0, 1), Infinity);
});

test('bootstrap é reprodutível e cobre a diferença', () => {
  const a = [0.70, 0.72, 0.69, 0.71, 0.73];
  const b = [0.78, 0.80, 0.77, 0.79, 0.81];
  const ci1 = bootstrapDiffCI(a, b, { seed: 42 });
  const ci2 = bootstrapDiffCI(a, b, { seed: 42 });
  assert.deepEqual(ci1, ci2);
  assert.ok(ci1[0] > 0 && ci1[0] < 0.08 && ci1[1] > 0.08, `IC ${ci1}`);
  const ci3 = bootstrapMeanCI([1, 1, 1, 1], { seed: 7 });
  assert.deepEqual(ci3, [1, 1]);
});

test('compareArms respeita a direção (menor é melhor)', () => {
  const base = { arm: 'baseline', values: [10, 11, 10.5, 10.2, 10.8] };
  const variant = { arm: 'variante', values: [8, 8.4, 8.1, 8.3, 7.9] };
  const c = compareArms(base, variant, 'lower', { seed: 1 });
  assert.equal(c.mode, 'seeds');
  assert.ok(c.diff > 2 && c.ci[0] > 0 && c.effect > 0 && c.t > 0, JSON.stringify(c));
});

test('compareArms usa o pareado com amostras alinhadas', () => {
  const samples = (off: number) =>
    new Map([
      [1, [0.1, 0.5, 0.9, 0.3].map((x) => x + off)],
      [2, [0.2, 0.4, 0.8, 0.4].map((x) => x + off)],
    ]);
  const c = compareArms({ arm: 'b', values: [0.45, 0.45], samples: samples(0) }, { arm: 'v', values: [0.5, 0.5], samples: samples(0.05) }, 'higher', { seed: 3 });
  assert.equal(c.mode, 'paired-samples');
  near(c.diff, 0.05, 1e-12, 'diff');
  assert.equal(c.units, 4);
});

if (failed) {
  console.log(`\n${failed} teste(s) falharam`);
  process.exit(1);
}
console.log('\ntodos os testes do stats passaram');
