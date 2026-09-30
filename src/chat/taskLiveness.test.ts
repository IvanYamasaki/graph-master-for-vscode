/**
 * Testes das regras de vida das tarefas do SDK (reconciliação, contador, aviso de órfãs do CLI). Sem VS Code:
 *   npx esbuild src/chat/taskLiveness.test.ts --bundle --platform=node --outfile=$TEMP/taskLiveness.test.js && node $TEMP/taskLiveness.test.js
 */
import * as assert from 'node:assert/strict';
import { LEVEL_GRACE_MS, ReconcileItem, commandNeedle, commandPorts, isOrphanNotice, orphanNoticeIds, reconcileTasks, workingCount } from './taskLiveness';
import { isWorking } from './protocol';

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

const t0 = 1_000_000;
const shell = (id: string, epoch: number, lastLifeAt = t0, status: ReconcileItem['status'] = 'running'): ReconcileItem => ({
  id,
  taskId: `task-${id}`,
  status,
  life: { epoch, lastLifeAt, backgrounded: true },
});

test('item de um processo anterior do CLI vira lost', () => {
  const v = reconcileTasks([shell('a', 1), shell('b', 2)], { epoch: 2, now: t0 });
  assert.deepEqual(v.map((x) => [x.id, x.status]), [['a', 'lost']]);
});

test('só running é reconciliado; concluído, parado e lost ficam como estão', () => {
  const v = reconcileTasks([shell('a', 1, t0, 'completed'), shell('b', 1, t0, 'stopped'), shell('c', 1, t0, 'lost')], { epoch: 2, now: t0 });
  assert.deepEqual(v, []);
});

test('item sem rastreio (CLI sem eventos de tarefa) não é tocado', () => {
  assert.deepEqual(reconcileTasks([{ id: 'x', status: 'running' }], { epoch: 5, now: t0 }), []);
});

test('nível sem a tarefa encerra só depois da carência', () => {
  const level = { ids: new Set<string>(), at: t0 + 10 };
  assert.deepEqual(reconcileTasks([shell('a', 1)], { epoch: 1, now: t0 + 10 + LEVEL_GRACE_MS - 1, level }), []);
  const v = reconcileTasks([shell('a', 1)], { epoch: 1, now: t0 + 10 + LEVEL_GRACE_MS, level });
  assert.deepEqual(v.map((x) => [x.id, x.status]), [['a', 'completed']]);
});

test('nível anterior ao último sinal de vida não encerra (o nível costuma vir antes do task_started)', () => {
  const level = { ids: new Set<string>(), at: t0 - 1 };
  assert.deepEqual(reconcileTasks([shell('a', 1)], { epoch: 1, now: t0 + 60_000, level }), []);
});

test('nível que lista a tarefa a mantém viva', () => {
  const level = { ids: new Set(['task-a']), at: t0 + 10 };
  assert.deepEqual(reconcileTasks([shell('a', 1)], { epoch: 1, now: t0 + 60_000, level }), []);
});

test('tarefa em primeiro plano não é julgada pelo nível', () => {
  const item: ReconcileItem = { id: 'f', taskId: 'task-f', status: 'running', life: { epoch: 1, lastLifeAt: t0, backgrounded: false } };
  assert.deepEqual(reconcileTasks([item], { epoch: 1, now: t0 + 60_000, level: { ids: new Set(), at: t0 + 10 } }), []);
});

test('relato real: 3 fantasmas + 2 roteados rodando = 2 trabalhando', () => {
  const ghosts = [shell('g1', 1), shell('g2', 1), shell('g3', 1)];
  const verdicts = reconcileTasks(ghosts, { epoch: 2, now: t0 + 3 * 3600_000 });
  const after = ghosts.map((g) => ({ status: verdicts.find((v) => v.id === g.id)?.status ?? g.status }));
  const list = [...after, { status: 'running' as const }, { status: 'running' as const }, { status: 'completed' as const }];
  assert.equal(workingCount(list), 2);
});

test('contador: waiting, lost e restaurado não contam', () => {
  assert.equal(workingCount([{ status: 'waiting' }, { status: 'lost' }, { status: 'running', restored: true }, { status: 'running' }]), 1);
  assert.equal(isWorking({ status: 'running' }), true);
  assert.equal(isWorking({ status: 'lost' }), false);
  assert.equal(isWorking({ status: 'running', restored: true }), false);
});

const cliNotice = `<task-notification>
<task-id>__orphan_summary__:shell</task-id>
<status>stopped</status>
<summary>3 background shell command tasks didn't finish before the previous session ended: bcqtmtui5, b96a91ek7, bbkwjuese.</summary>
<note>They may have been stopped (via the UI, Monitor timeout, or agent teardown). They have been marked stopped. Task ids: bcqtmtui5, b96a91ek7, bbkwjuese.</note>
</task-notification>`;

test('aviso de órfãs do CLI: reconhece e extrai os ids, sem o marcador interno', () => {
  assert.equal(isOrphanNotice(cliNotice), true);
  assert.deepEqual(orphanNoticeIds(cliNotice).sort(), ['b96a91ek7', 'bbkwjuese', 'bcqtmtui5']);
});

test('aviso de uma tarefa só: id na tag', () => {
  const one = '<task-notification>\n<task-id>bx1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>stopped</status>\n<summary>Background shell command didn\'t finish before the previous session ended</summary>\n</task-notification>';
  assert.deepEqual(orphanNoticeIds(one), ['bx1']);
});

test('texto comum não é aviso de órfãs', () => {
  assert.equal(isOrphanNotice('Background command "npm run dev" completed (exit code 0)'), false);
  assert.deepEqual(orphanNoticeIds('Task ids: a, b.'), []);
});

test('portas citadas no comando', () => {
  assert.deepEqual(commandPorts('npx vite --port 3002 --host'), [3002]);
  assert.deepEqual(commandPorts('PORT=3000 npm run start:dev && curl localhost:3000/health'), [3000]);
  assert.deepEqual(commandPorts('python -m http.server -p 8080; echo 127.0.0.1:5173'), [8080, 5173]);
  assert.deepEqual(commandPorts('ls -la 80'), []);
});

test('trecho do comando para achar a raiz', () => {
  assert.equal(commandNeedle('cd apps/api && npm run start:dev > /tmp/api.log 2>&1 &'), 'npm run start:dev');
  assert.equal(commandNeedle('ls'), undefined);
  assert.equal(commandNeedle(undefined), undefined);
});

if (failed) {
  console.log(`\n${failed} teste(s) falharam`);
  process.exit(1);
}
console.log('\ntodos os testes passaram');
