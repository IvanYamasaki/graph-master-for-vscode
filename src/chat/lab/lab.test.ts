/**
 * Testes do veredito, do quadro e do aviso de proveniência. Sem framework e sem VS Code:
 *   npx esbuild src/chat/lab/lab.test.ts --bundle --platform=node --outfile=$TEMP/lab.test.js && node $TEMP/lab.test.js
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { evaluate } from './evaluate';
import { citedNumbers, unregistered } from './provenance';
import { LabStore, type Hypothesis } from './store';

let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n     ${err instanceof Error ? err.stack : String(err)}`);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-lab-'));
const store = new LabStore(dir);
const base: Omit<Hypothesis, 'id' | 'createdAt'> = {
  title: 't',
  statement: 's',
  metric: 'acc',
  direction: 'higher',
  minImprovement: 0.02,
  improvementKind: 'absolute',
  arms: ['baseline', 'variante'],
  minSeeds: 5,
  alpha: 0.05,
  family: 'f',
  createdBy: 'main',
};
function logArm(hid: string, arm: string, values: number[]): void {
  values.forEach((v, i) => store.addRun({ hypothesisId: hid, arm, seed: i + 1, metrics: { acc: v }, source: 'declarado', agent: 'a1' }));
}

test('quadro grava em JSONL com ids sequenciais e status derivado', () => {
  const h = store.addHypothesis(base);
  assert.equal(h.id, 'h1');
  assert.equal(store.status(h), 'registrada');
  logArm('h1', 'baseline', [0.70, 0.72, 0.69, 0.71, 0.73]);
  logArm('h1', 'variante', [0.78, 0.80, 0.77, 0.79, 0.81]);
  assert.equal(store.status(h), 'rodando');
  assert.equal(store.runs('h1').length, 10);
  assert.ok(fs.readFileSync(path.join(dir, '.agm/lab/runs.jsonl'), 'utf8').split('\n').filter(Boolean).length === 10);
});

test('efeito claro com seeds suficientes: suportada', () => {
  const h = store.hypothesis('h1')!;
  const v = evaluate(h, store.runs('h1'), [{ id: 'h1' }], { by: 'main', attempt: 1 });
  assert.equal(v.verdict, 'suportada', v.reasons.join(' | '));
  assert.ok(v.ci[0] > 0 && Math.abs(v.diff - 0.08) < 1e-9);
});

test('poucas seeds: inconclusiva com seeds que faltam', () => {
  const h = store.addHypothesis({ ...base, title: 'poucas' });
  logArm(h.id, 'baseline', [0.70, 0.74]);
  logArm(h.id, 'variante', [0.73, 0.75]);
  const v = evaluate(h, store.runs(h.id), [{ id: h.id }], { by: 'main', attempt: 1 });
  assert.equal(v.verdict, 'inconclusiva');
  assert.ok((v.seedsMissing ?? 0) >= 3, `faltam ${v.seedsMissing}`);
});

test('variante pior com seeds suficientes: refutada', () => {
  const h = store.addHypothesis({ ...base, title: 'pior' });
  logArm(h.id, 'baseline', [0.80, 0.81, 0.79, 0.80, 0.82]);
  logArm(h.id, 'variante', [0.70, 0.71, 0.69, 0.72, 0.70]);
  const v = evaluate(h, store.runs(h.id), [{ id: h.id }], { by: 'main', attempt: 1 });
  assert.equal(v.verdict, 'refutada', v.reasons.join(' | '));
  assert.ok(v.warnings.length > 0, 'efeito enorme deveria gerar aviso');
});

test('BH na família: p limítrofe deixa de passar com muitas hipóteses', () => {
  const h = store.addHypothesis({ ...base, title: 'limítrofe', minImprovement: 0 });
  logArm(h.id, 'baseline', [0.70, 0.73, 0.69, 0.72, 0.71]);
  logArm(h.id, 'variante', [0.72, 0.745, 0.71, 0.735, 0.725]);
  const alone = evaluate(h, store.runs(h.id), [{ id: h.id }], { by: 'main', attempt: 1 });
  const crowded = evaluate(h, store.runs(h.id), [{ id: h.id }, ...Array.from({ length: 9 }, (_, i) => ({ id: `x${i}`, p: 0.9 }))], { by: 'main', attempt: 1 });
  assert.ok(crowded.pAdjusted > alone.pAdjusted, `${crowded.pAdjusted} vs ${alone.pAdjusted}`);
  assert.equal(crowded.familySize, 10);
});

test('números citados: decimais e porcentagens, fora de código e versões', () => {
  const cited = citedNumbers('A acurácia foi 0.87 e melhorou 12.5%. Versão 0.7.1, seed 3, `--lr 0.01`, tempo 1.5s, lista 0,91.');
  assert.deepEqual(
    cited.map((c) => c.text),
    ['0.87', '12.5%', '0,91'],
  );
});

test('aviso só para número sem registro', () => {
  const known = [0.8734, 0.125, 0.91];
  assert.deepEqual(unregistered('acc 0.87, ganho 12.5%, outra 0.91 e 0.93', known), ['0.93']);
  assert.deepEqual(unregistered('87%', known), []);
  assert.deepEqual(unregistered('com 100.000 amostras e 1,500 passos, erro 0.500', known), ['0.500']);
});

test('poda marca e restaura sem apagar nada; vale o último evento', () => {
  const h = store.addHypothesis({ ...base, title: 'podável' });
  const before = store.runs().length;
  assert.equal(store.pruned(h.id), undefined);
  store.setPruned(h.id, true, 'user');
  assert.equal(store.pruned(h.id)?.by, 'user');
  store.setPruned(h.id, false, 'user');
  assert.equal(store.pruned(h.id), undefined);
  store.setPruned(h.id, true, 'user');
  assert.ok(store.pruned(h.id));
  assert.equal(store.hypothesis(h.id)?.title, 'podável');
  assert.equal(store.runs().length, before);
  assert.equal(fs.readFileSync(path.join(store.dir, 'prunes.jsonl'), 'utf8').trim().split('\n').length, 3);
});

fs.rmSync(dir, { recursive: true, force: true });
if (failed) {
  console.log(`\n${failed} teste(s) falharam`);
  process.exit(1);
}
console.log('\ntodos os testes do laboratório passaram');
