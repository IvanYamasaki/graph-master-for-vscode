/**
 * Testes da conferência do verificador no modo pareado (pairedCheck.ts). Sem framework e sem VS Code:
 *   npx esbuild src/chat/parallel/parallel.test.ts --bundle --platform=node --outfile=$TEMP/parallel.test.js && node $TEMP/parallel.test.js
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readPredictionsFile, rowsMetric } from '../lab/paired';
import type { Run } from '../lab/store';
import { checkPairedRerun, sameRel } from './pairedCheck';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-paired-'));
const write = (name: string, text: string) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, text);
  return f;
};
const csv = (rows: [string, number, number][]) => ['id,label,score', ...rows.map((r) => r.join(','))].join('\n');
const base: [string, number, number][] = [
  ['a', 1, 0.9],
  ['b', 0, 0.2],
  ['c', 1, 0.7],
  ['d', 0, 0.4],
  ['e', 1, 0.35],
  ['f', 0, 0.6],
];

const origFile = write('orig.csv', csv(base));
const orig = readPredictionsFile(origFile);
assert.ok(!(orig instanceof Error));
const run = {
  id: 'r1',
  arm: 'variante',
  seed: 0,
  metrics: { auc: rowsMetric(orig.rows, 'auc') },
  rows: orig.rows,
  artifact: origFile,
  metricsFileHash: orig.hash,
} as unknown as Run;

let n = 0;
const test = (name: string, fn: () => void) => {
  fn();
  n++;
  console.log(`ok   ${name}`);
};

test('arquivo idêntico: bate, mesmo sha256', () => {
  const f = write('same.csv', csv(base));
  const c = checkPairedRerun('variante', f, 'same.csv', run, 'auc', 'auc');
  assert.equal(c.inside, true);
  assert.equal(c.sameHash, true);
  assert.equal(c.value, run.metrics.auc);
});

test('mesma predição em outra ordem e com ruído de 1e-13: bate, sha256 diferente', () => {
  const shuffled = [...base].reverse().map(([id, y, s]) => [id, y, s + 1e-13] as [string, number, number]);
  const c = checkPairedRerun('variante', write('shuf.csv', csv(shuffled)), 'shuf.csv', run, 'auc', 'auc');
  assert.equal(c.inside, true);
  assert.equal(c.sameHash, false);
});

test('predição que muda o ranking: não bate', () => {
  const changed = base.map(([id, y, s]) => [id, y, id === 'e' ? 0.95 : s] as [string, number, number]);
  const c = checkPairedRerun('variante', write('diff.csv', csv(changed)), 'diff.csv', run, 'auc', 'auc');
  assert.equal(c.inside, false);
  assert.match(c.line, /NÃO BATE/);
});

test('mesmo valor, mas ids de linha diferentes: não bate', () => {
  const renamed = base.map(([id, y, s]) => [`${id}x`, y, s] as [string, number, number]);
  const c = checkPairedRerun('variante', write('ids.csv', csv(renamed)), 'ids.csv', run, 'auc', 'auc');
  assert.equal(c.inside, false);
  assert.match(c.line, /ids de linha/);
});

test('arquivo que não existe: sem valor e sem veredito', () => {
  const c = checkPairedRerun('variante', path.join(dir, 'nada.csv'), 'nada.csv', run, 'auc', 'auc');
  assert.equal(c.value, undefined);
  assert.equal(c.inside, undefined);
});

test('tolerância relativa', () => {
  assert.ok(sameRel(0.8123456789, 0.8123456789 + 1e-12));
  assert.ok(!sameRel(0.81, 0.8101));
  assert.ok(sameRel(12345.678, 12345.678 * (1 + 5e-10)));
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${n} testes do paralelismo passaram`);
