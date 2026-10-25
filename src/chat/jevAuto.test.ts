/**
 * Testes dos usos automáticos do Jev (jevAuto): estado, perguntas e leitura das respostas. Sem VS Code e sem rede:
 *   npx esbuild src/chat/jevAuto.test.ts --bundle --platform=node --outfile=$TEMP/jevAuto.test.js && node $TEMP/jevAuto.test.js
 */
import * as assert from 'node:assert/strict';
import { JevAnswer, checkQuestions } from './jev';
import {
  clipMiddle,
  latencyStats,
  noulVerdict,
  proposalQuestions,
  proposalState,
  readProposal,
  readReport,
  readRouting,
  readStuck,
  reportQuestions,
  reportState,
  routingQuestions,
  routingState,
  stuckQuestions,
  stuckState,
  withTimeout,
} from './jevAuto';

let failed = 0;
const pending: Promise<void>[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  pending.push(
    (async () => {
      try {
        await fn();
        console.log(`ok   ${name}`);
      } catch (err) {
        failed++;
        console.log(`FALHA ${name}\n${err instanceof Error ? err.stack : String(err)}`);
      }
    })(),
  );
}

const noul = (name: string, p: number): JevAnswer => ({ name, type: 'noul', noul: p });

test('as perguntas de todos os usos passam no checkQuestions', () => {
  assert.equal(checkQuestions(routingState({ description: 'd', prompt: 'p' }), routingQuestions()), undefined);
  assert.equal(checkQuestions(stuckState({ description: 'd', recentCalls: ['Read a'], reason: 'r' }), stuckQuestions()), undefined);
  assert.equal(checkQuestions(reportState({ description: 'd', prompt: 'p', report: 'r' }), reportQuestions()), undefined);
  assert.equal(checkQuestions(proposalState({ proposal: 'x', previous: [] }), proposalQuestions(false)), undefined);
  assert.deepEqual(Object.keys(proposalQuestions(true)), ['isTask', 'duplicate']);
  assert.deepEqual(Object.keys(proposalQuestions(false)), ['isTask']);
});

test('clipMiddle guarda começo e fim', () => {
  assert.equal(clipMiddle('curto', 100), 'curto');
  const long = `INICIO${'x'.repeat(1000)}FIM`;
  const c = clipMiddle(long, 100);
  assert.ok(c.startsWith('INICIO') && c.endsWith('FIM'));
  assert.ok(c.includes('caracteres cortados'));
});

test('noulVerdict só decide nas pontas', () => {
  assert.equal(noulVerdict(noul('a', 0.9)), 'yes');
  assert.equal(noulVerdict(noul('a', 0.1)), 'no');
  assert.equal(noulVerdict(noul('a', 0.5)), 'unsure');
  assert.equal(noulVerdict(undefined), 'unsure');
  assert.equal(noulVerdict({ name: 'a', type: 'noul', missing: true }), 'unsure');
});

const routeAnswers = (model: string, mConf: number, effortIdx: string, eConf: number): JevAnswer[] => [
  { name: 'model', type: 'choice', choice: model, probabilities: { [model]: 0.9, opus: 0.1 }, confidence: mConf },
  { name: 'effort', type: 'score', score: Number(effortIdx), probabilities: { [effortIdx]: 0.9, '3': 0.1 }, confidence: eConf },
];

test('roteamento aplica só o que o Claude não disse e com confiança', () => {
  const r = readRouting(routeAnswers('haiku', 0.9, '0', 0.8), { description: 'd', prompt: 'p' });
  assert.equal(r.model, 'haiku');
  assert.equal(r.effort, 'low');
  assert.match(r.summary!, /haiku \(90%\).*low \(80%\)/);
  const given = readRouting(routeAnswers('haiku', 0.9, '0', 0.8), { description: 'd', prompt: 'p', model: 'sonnet', effort: 'high' });
  assert.equal(given.model, undefined);
  assert.equal(given.effort, undefined);
  assert.equal(given.summary, undefined);
  assert.equal(given.note, undefined, 'um nível de diferença não gera nota');
});

test('roteamento com confiança baixa ou sem probabilidades não mexe em nada', () => {
  const r = readRouting(routeAnswers('haiku', 0.5, '0', 0.6), { description: 'd', prompt: 'p' });
  assert.deepEqual(r, {});
  const fallback = readRouting([{ name: 'model', type: 'choice', choice: 'haiku', probabilities: {}, confidence: 0 }], { description: 'd', prompt: 'p' });
  assert.deepEqual(fallback, {});
  assert.deepEqual(readRouting([], { description: 'd', prompt: 'p' }), {});
});

test('roteamento avisa quando o Claude pediu modelo dois níveis acima', () => {
  const r = readRouting(routeAnswers('haiku', 0.9, '0', 0.8), { description: 'd', prompt: 'p', model: 'claude-opus-5-5' });
  assert.equal(r.model, undefined);
  assert.match(r.note!, /haiku basta.*claude-opus-5-5/);
});

test('preso: só segura o cartão com resposta decisiva de progresso', () => {
  assert.equal(readStuck([noul('progressing', 0.95)]).verdict, 'progressing');
  assert.equal(readStuck([noul('progressing', 0.05)]).verdict, 'stuck');
  assert.equal(readStuck([noul('progressing', 0.6)]).verdict, 'unsure');
  assert.equal(readStuck([]).verdict, 'unsure');
  const s = stuckState({ description: 'd', recentCalls: Array.from({ length: 30 }, (_, i) => `call ${i}`), reason: 'mesma chamada 4 vezes' });
  assert.ok(!s.includes('call 9\n') && s.includes('call 29'), 'só as 20 últimas');
});

test('relatório: incompleto só com P baixo', () => {
  assert.equal(readReport([noul('delivers', 0.1)]).verdict, 'incomplete');
  assert.equal(readReport([noul('delivers', 0.5)]).verdict, 'unsure');
  assert.equal(readReport([noul('delivers', 0.9)]).verdict, 'ok');
  assert.equal(readReport([]).verdict, 'unsure');
});

test('proposta: segura repetida ou que não é tarefa, libera o resto', () => {
  assert.equal(readProposal([noul('isTask', 0.9), noul('duplicate', 0.95)]).verdict, 'drop');
  assert.equal(readProposal([noul('isTask', 0.05)]).verdict, 'drop');
  assert.equal(readProposal([noul('isTask', 0.5), noul('duplicate', 0.5)]).verdict, 'pass');
  assert.equal(readProposal([]).verdict, 'pass');
});

test('withTimeout devolve undefined no atraso e no erro', async () => {
  assert.equal(await withTimeout(Promise.resolve(3), 50), 3);
  assert.equal(await withTimeout(new Promise((r) => setTimeout(() => r(1), 200)), 20), undefined);
  assert.equal(await withTimeout(Promise.reject(new Error('x')), 50), undefined);
});

test('latencyStats', () => {
  assert.equal(latencyStats([]), undefined);
  const s = latencyStats([100, 300, 200, 400, 1000])!;
  assert.equal(s.n, 5);
  assert.equal(s.meanMs, 400);
  assert.equal(s.p50Ms, 300);
  assert.equal(s.p95Ms, 1000);
  assert.equal(s.maxMs, 1000);
});

void Promise.all(pending).then(() => {
  if (failed) {
    console.log(`\n${failed} teste(s) falharam`);
    process.exit(1);
  }
  console.log('\ntodos passaram');
});
