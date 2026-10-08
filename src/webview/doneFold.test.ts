/**
 * Testes do recolhimento de concluídos no grafo. Sem VS Code:
 *   npx esbuild src/webview/doneFold.test.ts --bundle --platform=node --outfile=$TEMP/doneFold.test.js && node $TEMP/doneFold.test.js
 */
import * as assert from 'node:assert/strict';
import type { AgentInfo } from '../chat/protocol';
import { foldDone } from './doneFold';

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

const ag = (id: string, status: AgentInfo['status'], creator = 'main', extra: Partial<AgentInfo> = {}): AgentInfo =>
  ({ id, kind: 'routed', description: `tarefa ${id}`, status, creator, totalTokens: 10, durationMs: 0, toolUses: 0, ...extra }) as AgentInfo;
const ids = (list: AgentInfo[]) => list.map((a) => a.id).sort();
const none = { expanded: new Set<string>(), keep: () => false };

test('concluídos do mesmo criador viram um resumo; quem roda fica', () => {
  const out = foldDone([ag('a1', 'completed'), ag('a2', 'failed'), ag('a3', 'running')], none);
  assert.deepEqual(ids(out), ['a3', 'done:main']);
  const sum = out.find((a) => a.id === 'done:main')!;
  assert.equal(sum.foldSummary?.count, 2);
  assert.equal(sum.foldSummary?.failed, 1);
  assert.equal(sum.totalTokens, 20);
});

test('um concluído sozinho não vira resumo', () => {
  assert.deepEqual(ids(foldDone([ag('a1', 'completed'), ag('a2', 'running')], none)), ['a1', 'a2']);
});

test('pai concluído com filho rodando fica à vista; os netos concluídos recolhem nele', () => {
  const list = [ag('a1', 'completed'), ag('b1', 'running', 'a1'), ag('b2', 'completed', 'a1'), ag('b3', 'stopped', 'a1'), ag('a2', 'completed'), ag('a3', 'completed')];
  const out = foldDone(list, none);
  assert.deepEqual(ids(out), ['a1', 'b1', 'done:a1', 'done:main']);
  assert.equal(out.find((a) => a.id === 'done:a1')!.creator, 'a1');
});

test('subárvore toda concluída some junto, contada no total', () => {
  const list = [ag('a1', 'completed'), ag('b1', 'completed', 'a1'), ag('b2', 'completed', 'a1'), ag('a2', 'completed')];
  const out = foldDone(list, none);
  assert.deepEqual(ids(out), ['done:main']);
  assert.equal(out[0].foldSummary?.count, 2);
  assert.equal(out[0].foldSummary?.total, 4);
});

test('aberto pelo usuário: volta tudo e o resumo vira recolher; o nível de baixo continua recolhido', () => {
  const list = [ag('a1', 'completed'), ag('b1', 'completed', 'a1'), ag('b2', 'completed', 'a1'), ag('a2', 'completed')];
  const out = foldDone(list, { expanded: new Set(['main']), keep: () => false });
  assert.deepEqual(ids(out), ['a1', 'a2', 'done:a1', 'done:main']);
  assert.equal(out.find((a) => a.id === 'done:main')!.foldSummary?.expanded, true);
  assert.match(out.find((a) => a.id === 'done:main')!.description, /^Recolher 2/);
});

test('keep mantém à vista (decisão pendente, detalhe aberto, terminou há pouco)', () => {
  const out = foldDone([ag('a1', 'completed'), ag('a2', 'completed'), ag('a3', 'completed')], { expanded: new Set(), keep: (a) => a.id === 'a2' });
  assert.deepEqual(ids(out), ['a2', 'done:main']);
});

test('resumo fica na caixa quando todos são da mesma', () => {
  const out = foldDone([ag('a1', 'completed', 'main', { box: 'b1' }), ag('a2', 'completed', 'main', { box: 'b1' })], none);
  assert.equal(out.find((a) => a.id === 'done:main')!.box, 'b1');
  const mixed = foldDone([ag('a1', 'completed', 'main', { box: 'b1' }), ag('a2', 'completed', 'main', { box: 'b2' })], none);
  assert.equal(mixed.find((a) => a.id === 'done:main')!.box, undefined);
});

test('ciclo na cadeia de criação não trava', () => {
  const out = foldDone([ag('a1', 'completed', 'a2'), ag('a2', 'completed', 'a1')], none);
  assert.ok(out.length >= 1);
});

if (failed) {
  console.log(`\n${failed} falharam`);
  process.exit(1);
}
console.log('\ntodos os testes passaram');
