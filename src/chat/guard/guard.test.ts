/**
 * Testes do semáforo de processos pesados, do cofre, da caixa parada e da checagem de comando de subagente. Sem
 * framework. O SDK entra no bundle (agentGuard.ts) e usa import.meta.url, então vai o mesmo define do esbuild.mjs:
 *   npx esbuild src/chat/guard/guard.test.ts --bundle --platform=node --external:vscode --outfile=$TEMP/guard.test.js --define:import.meta.url=importMetaUrl
 *     "--banner:js=const importMetaUrl = require('url').pathToFileURL(__filename).href;" && node $TEMP/guard.test.js
 */
import { testConfig } from './vscodeStub.test-helper';
import * as assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentInfo, BoxInfo, GuardAlert, HostMessage } from '../protocol';
import { AgentGuard } from './agentGuard';
import { acquireHeavy, heavyLimit, heavyQueueLength, parallelLaunchHint, resetHeavyForTest } from './heavy';
import {
  NO_HYPOTHESIS,
  PROTECT_ALL,
  finishEvaluation,
  lockboxNumbers,
  lockboxPatterns,
  lockboxState,
  nextLockboxId,
  outputNumbers,
  readLockboxes,
  recordBlocked,
  reserveEvaluation,
  resetLockboxCacheForTest,
  writeLockboxes,
  type Lockbox,
} from './lockbox';
import { commandBlocked, patternsWithoutFiles } from './protect';
import { onlyMetric } from '../parallel/seeds';

const tests: [string, () => Promise<void> | void][] = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

test('semáforo: o terceiro espera até uma vaga sair', async () => {
  resetHeavyForTest();
  testConfig['maxHeavyProcesses'] = 2;
  assert.equal(heavyLimit(), 2);
  const a = (await acquireHeavy('a'))!;
  const b = (await acquireHeavy('b'))!;
  let got = false;
  const third = acquireHeavy('c').then((s) => {
    got = true;
    return s!;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(got, false);
  a.release();
  a.release(); // soltar duas vezes não abre vaga a mais
  const c = await third;
  assert.equal(got, true);
  let fourth = false;
  void acquireHeavy('d').then(() => (fourth = true));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fourth, false, 'duas vagas, duas ocupadas');
  b.release();
  c.release();
});

test('semáforo: fios em 1 com mais de um rodando, sem sobrescrever o do usuário', async () => {
  resetHeavyForTest();
  testConfig['maxHeavyProcesses'] = 4;
  const saved = process.env.OMP_NUM_THREADS;
  delete process.env.OMP_NUM_THREADS;
  const first = (await acquireHeavy('x'))!;
  assert.equal(first.env.OMP_NUM_THREADS, undefined, 'sozinho, não mexe');
  const second = (await acquireHeavy('y'))!;
  assert.equal(second.env.OMP_NUM_THREADS, '1');
  assert.equal(second.env.MKL_NUM_THREADS, '1');
  const batch = (await acquireHeavy('z', { concurrent: true }))!;
  assert.equal(batch.env.OPENBLAS_NUM_THREADS, '1');
  process.env.OMP_NUM_THREADS = '3';
  const user = (await acquireHeavy('w'))!;
  assert.equal(user.env.OMP_NUM_THREADS, '3');
  for (const s of [first, second, batch, user]) {
    s.release();
  }
  if (saved === undefined) {
    delete process.env.OMP_NUM_THREADS;
  } else {
    process.env.OMP_NUM_THREADS = saved;
  }
});

test('semáforo: cancelado na fila devolve a vaga', async () => {
  resetHeavyForTest();
  testConfig['maxHeavyProcesses'] = 1;
  const a = (await acquireHeavy('a'))!;
  let stop = false;
  const waiting = acquireHeavy('b', { cancelled: () => stop });
  stop = true;
  a.release();
  assert.equal(await waiting, undefined);
  const c = await acquireHeavy('c');
  assert.ok(c, 'a vaga voltou');
  c!.release();
});

test('semáforo: abortado na fila sai na hora; já abortado nem entra', async () => {
  resetHeavyForTest();
  testConfig['maxHeavyProcesses'] = 1;
  const a = (await acquireHeavy('a'))!;
  const c = new AbortController();
  const waiting = acquireHeavy('b', { signal: c.signal });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(heavyQueueLength(), 1);
  c.abort();
  assert.equal(await waiting, undefined, 'saiu sem esperar a vaga');
  assert.equal(heavyQueueLength(), 0);
  assert.equal(await acquireHeavy('c', { signal: c.signal }), undefined);
  a.release();
  const d = await acquireHeavy('d');
  assert.ok(d, 'a vaga de "a" não foi perdida');
  d!.release();
});

test('semáforo: avaliação do orquestrador (priority) não espera atrás dos seeds', async () => {
  resetHeavyForTest();
  testConfig['maxHeavyProcesses'] = 1;
  const seed = (await acquireHeavy('seed'))!;
  let queued = false;
  const evalSlot = await acquireHeavy('run_evaluation', { priority: true, onQueued: () => (queued = true) });
  assert.ok(evalSlot);
  assert.equal(queued, false);
  assert.equal(evalSlot!.env.OMP_NUM_THREADS ?? '1', '1', 'com outro rodando, um fio');
  seed.release();
  evalSlot!.release();
  const next = await acquireHeavy('depois');
  assert.ok(next);
  next!.release();
});

test('semáforo: o ouvinte de abort sai depois que a vaga chega', async () => {
  resetHeavyForTest();
  testConfig['maxHeavyProcesses'] = 1;
  const c = new AbortController();
  const first = (await acquireHeavy('a'))!;
  const pending = Array.from({ length: 12 }, (_, i) => acquireHeavy(`t${i}`, { signal: c.signal }));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(getEventListeners(c.signal, 'abort').length, 12);
  first.release();
  for (const p of pending) {
    (await p)!.release();
  }
  assert.equal(getEventListeners(c.signal, 'abort').length, 0, 'nenhum ouvinte esquecido');
});

test('run_seeds de agente protegido: só o número da métrica pedida passa', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-only-'));
  const src = path.join(dir, 'm.json');
  fs.writeFileSync(src, JSON.stringify({ acc: 0.91, 'linha 3 do teste: 42,7,x': 1, nota: 'segredo' }));
  const out = onlyMetric(src, 'acc', dir, 'limpo.json');
  assert.ok(!(out instanceof Error));
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { acc: 0.91 });
  fs.writeFileSync(src, '{"x": "conteúdo do teste"}');
  const bad = onlyMetric(src, 'acc', dir, 'b.json');
  assert.ok(bad instanceof Error && !bad.message.includes('conteúdo') && !bad.message.includes('"x"'));
  fs.writeFileSync(src, 'id,label\n1,0');
  const notJson = onlyMetric(src, 'acc', dir, 'c.json');
  assert.ok(notJson instanceof Error && !notJson.message.includes('label'));
  fs.rmSync(dir, { recursive: true, force: true });
});

function lockboxFixture(root: string): Lockbox {
  return {
    id: 'lb1',
    name: 'teste final',
    paths: ['data/test/**'],
    hypotheses: ['h1'],
    command: 'python eval.py --tag {hypothesis}',
    createdAt: new Date().toISOString(),
    createdBy: 'main',
    blockedCount: 0,
    blocked: [],
    evaluations: [],
  };
}

test('cofre: duas avaliações no mesmo turno, a segunda já vê a primeira', () => {
  resetLockboxCacheForTest();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-lockbox-'));
  writeLockboxes(root, [lockboxFixture(root)]);
  // As duas reservas acontecem antes de qualquer await, como nas duas chamadas do mesmo turno.
  const first = reserveEvaluation(root, 'lb1', 'h1', 'main', 'python eval.py --tag h1');
  const second = reserveEvaluation(root, 'lb1', 'h1', 'main', 'python eval.py --tag h1');
  assert.ok(!(first instanceof Error) && !(second instanceof Error));
  assert.equal(first.previous.length, 0);
  assert.equal(second.previous.length, 1, 'a segunda cai na aprovação do usuário');
  assert.equal(second.previous[0].state, 'rodando');
  finishEvaluation(root, 'lb1', second.evalId, undefined); // usuário recusou: a reserva sai
  finishEvaluation(root, 'lb1', first.evalId, { at: new Date().toISOString(), command: 'x', exitCode: 0, timedOut: false, durationMs: 5, stdoutHash: 'abc' });
  const evals = readLockboxes(root)[0].evaluations;
  assert.equal(evals.length, 1);
  assert.equal(evals[0].state, undefined);
  assert.equal(evals[0].exitCode, 0);
  const third = reserveEvaluation(root, 'lb1', 'h1', 'main', 'x');
  assert.ok(!(third instanceof Error) && third.previous.length === 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('cofre: arquivo ilegível falha fechado e não grava nada', () => {
  resetLockboxCacheForTest();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-lockbox-'));
  const file = path.join(root, '.agm', 'lockbox.json');
  // Sem cópia boa: tudo protegido.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ "lockboxes": [ { "id": "lb1", ');
  assert.deepEqual(lockboxPatterns(root), [PROTECT_ALL]);
  assert.match(lockboxState(root).error ?? '', /ilegível/);
  assert.ok(commandBlocked(lockboxPatterns(root), [root], 'python qualquer.py'), '"**" barra qualquer caminho');
  assert.throws(() => writeLockboxes(root, []));
  recordBlocked(root, 'lb1', { at: '', agent: 'a2', tool: 'Read' });
  assert.equal(fs.readFileSync(file, 'utf8'), '{ "lockboxes": [ { "id": "lb1", ', 'o arquivo quebrado fica como está');
  // Com cópia boa (.bak de uma gravação anterior): valem os cofres dela.
  resetLockboxCacheForTest();
  fs.rmSync(file);
  writeLockboxes(root, [lockboxFixture(root)]);
  resetLockboxCacheForTest();
  fs.writeFileSync(file, 'não é json');
  assert.ok(lockboxPatterns(root).includes('data/test/**'));
  assert.ok(!lockboxPatterns(root).includes(PROTECT_ALL));
  assert.ok(reserveEvaluation(root, 'lb1', 'h1', 'main', 'x') instanceof Error, 'nenhuma avaliação com o arquivo quebrado');
  fs.rmSync(root, { recursive: true, force: true });
});

test('cofre: reserva de janela que fechou vira "interrompida" e continua contando', () => {
  resetLockboxCacheForTest();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-lockbox-'));
  const lb = lockboxFixture(root);
  const base = { hypothesisId: 'h1', at: new Date().toISOString(), by: 'main', command: 'x', exitCode: null, timedOut: false, durationMs: 0, stdoutHash: '' };
  lb.evaluations = [
    { ...base, id: 'e1', state: 'rodando', pid: 2147483646 }, // processo que não existe
    { ...base, id: 'e2', state: 'rodando', pid: process.pid, hypothesisId: 'h2' }, // esta janela: continua rodando
  ];
  writeLockboxes(root, [lb]);
  resetLockboxCacheForTest();
  const evals = readLockboxes(root)[0].evaluations;
  assert.equal(evals[0].state, 'interrompida');
  assert.equal(evals[1].state, 'rodando');
  assert.match(fs.readFileSync(path.join(root, '.agm', 'lockbox.json'), 'utf8'), /interrompida/, 'gravada no arquivo');
  const next = reserveEvaluation(root, 'lb1', 'h1', 'main', 'x');
  assert.ok(!(next instanceof Error) && next.previous.length === 1 && next.previous[0].state === 'interrompida', 'a próxima pede aprovação');
  fs.rmSync(root, { recursive: true, force: true });
});

test('run_evaluation com o comando do cofre entra na reserva e na contagem', async () => {
  resetLockboxCacheForTest();
  resetHeavyForTest();
  testConfig['maxHeavyProcesses'] = 2;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-lockbox-'));
  const lb = lockboxFixture(root);
  lb.command = 'node -e "console.log({hypothesis})"';
  lb.hypotheses = ['7'];
  writeLockboxes(root, [lb]);
  const asked: string[] = [];
  let guard: AgentGuard;
  guard = new AgentGuard({
    cwd: root,
    info: () => undefined,
    update: () => undefined,
    post: (msg: HostMessage) => {
      if (msg.type === 'permission') {
        asked.push(String(msg.toolName));
        guard.respondPermission(msg.requestId, { decision: 'deny' } as never);
      }
    },
    isBusy: () => false,
    interrupt: async () => undefined,
    continueAgent: () => undefined,
    stopForGood: async () => undefined,
    sendFromUser: () => undefined,
    stop: async () => undefined,
    log: () => undefined,
  });
  const run = guard.evaluationTool().handler as unknown as (a: { command?: string }) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  const r1 = await run({ command: 'node -e "console.log(7)"' });
  assert.match(r1.content[0].text, /cofre lb1/);
  assert.deepEqual(asked, [], 'a primeira avaliação do cofre roda sem perguntar');
  let evals = readLockboxes(root)[0].evaluations;
  assert.equal(evals.length, 1);
  assert.equal(evals[0].hypothesisId, '7');
  assert.equal(evals[0].exitCode, 0);
  const r2 = await run({ command: 'node -e "console.log(7)"' });
  assert.deepEqual(asked, ['run_evaluation'], 'a segunda pede aprovação');
  assert.equal(r2.isError, true);
  // Comando qualquer que cita o caminho do cofre também conta.
  const r3 = await run({ command: 'node -e "0" data/test/x.csv' });
  assert.match(r3.content[0].text, /\(run_evaluation\)/);
  evals = readLockboxes(root)[0].evaluations;
  assert.equal(evals.length, 2, 'a recusada saiu; a do caminho entrou');
  guard.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

test('caixa parada continua fechada até o usuário reabrir', async () => {
  const box: BoxInfo = { id: 'b1', name: 'Onda 1', createdAt: '', budget: { maxTokens: 100 } };
  const agents = new Map<string, AgentInfo>();
  agents.set('a2', { id: 'a2', kind: 'routed', description: 'busca', status: 'running', box: 'b1', totalTokens: 0, durationMs: 0, toolUses: 0 } as AgentInfo);
  const alerts: GuardAlert[] = [];
  const stopped: string[] = [];
  let interrupted = 0;
  const guard = new AgentGuard({
    cwd: os.tmpdir(),
    info: (id) => agents.get(id),
    update: (id, patch) => {
      const a = agents.get(id);
      if (a) {
        agents.set(id, { ...a, ...patch });
      }
    },
    post: (msg: HostMessage) => {
      if (msg.type === 'guardAlert') {
        alerts.push({ ...msg.alert });
      }
    },
    isBusy: (id) => agents.get(id)?.status === 'running',
    interrupt: async () => {
      interrupted++;
    },
    continueAgent: () => undefined,
    stopForGood: async (id) => {
      stopped.push(id);
      agents.set(id, { ...agents.get(id)!, status: 'stopped' });
    },
    sendFromUser: () => undefined,
    stop: async () => undefined,
    log: () => undefined,
    boxes: () => [box],
    agents: () => [...agents.values()],
    updateBox: (_id, patch) => Object.assign(box, patch),
  });
  guard.onUsage('a2', { messageId: 'm1', tokens: 150 });
  assert.equal(interrupted, 1);
  const exhausted = alerts.find((a) => a.agentId === 'b1' && a.status === 'pending')!;
  assert.ok(exhausted);
  assert.ok(guard.boxSpawnBlock('b1'));
  await guard.resolve(exhausted.id, 'stop');
  assert.deepEqual(stopped, ['a2']);
  assert.equal(box.closed, true, 'gravado na caixa, para valer depois do restore');
  assert.match(guard.boxSpawnBlock('b1') ?? '', /parada pelo usuário/, 'continua bloqueada depois de parar');
  const release = alerts.filter((a) => a.agentId === 'b1' && a.status === 'pending').at(-1)!;
  assert.notEqual(release.id, exhausted.id);
  await guard.resolve(release.id, 'stop');
  assert.ok(guard.boxSpawnBlock('b1'), '"Parar de vez" no cartão de reabrir mantém fechada');
  guard.dispose();

  // Mesmo roteiro, agora reabrindo (caixa recém-criada: o fechamento acima ficou gravado nela).
  delete box.closed;
  box.budget = { maxTokens: 100 };
  const guard2 = new AgentGuard({
    cwd: os.tmpdir(),
    info: (id) => agents.get(id),
    update: () => undefined,
    post: (msg: HostMessage) => {
      if (msg.type === 'guardAlert') {
        alerts.push({ ...msg.alert });
      }
    },
    isBusy: () => false,
    interrupt: async () => undefined,
    continueAgent: () => undefined,
    stopForGood: async () => undefined,
    sendFromUser: () => undefined,
    stop: async () => undefined,
    log: () => undefined,
    boxes: () => [box],
    agents: () => [...agents.values()],
    updateBox: (_id, patch) => Object.assign(box, patch),
  });
  agents.set('a3', { ...agents.get('a2')!, id: 'a3', status: 'running', spent: { tokens: 150, minutes: 0 } });
  guard2.onUsage('a3', { messageId: 'x', tokens: 1 });
  const ex2 = alerts.filter((a) => a.agentId === 'b1' && a.status === 'pending').at(-1)!;
  await guard2.resolve(ex2.id, 'stop');
  const rel2 = alerts.filter((a) => a.agentId === 'b1' && a.status === 'pending').at(-1)!;
  await guard2.resolve(rel2.id, 'extend');
  assert.equal(guard2.boxSpawnBlock('b1'), undefined, 'reaberta');
  assert.ok((box.budget?.maxTokens ?? 0) > 100, 'com orçamento maior');
  assert.equal(box.closed, false, 'o disco também sabe que reabriu');
  guard2.dispose();

  // Conversa reaberta: o guarda novo não tem estado, mas a caixa fechada está gravada.
  box.closed = true;
  const before = alerts.length;
  const guard3 = new AgentGuard({
    cwd: os.tmpdir(),
    info: (id) => agents.get(id),
    update: () => undefined,
    post: (msg: HostMessage) => {
      if (msg.type === 'guardAlert') {
        alerts.push({ ...msg.alert });
      }
    },
    isBusy: () => false,
    interrupt: async () => undefined,
    continueAgent: () => undefined,
    stopForGood: async () => undefined,
    sendFromUser: () => undefined,
    stop: async () => undefined,
    log: () => undefined,
    boxes: () => [box],
    agents: () => [...agents.values()],
    updateBox: (_id, patch) => Object.assign(box, patch),
  });
  assert.ok(guard3.boxSpawnBlock('b1'), 'fechada depois do restore');
  assert.ok(guard3.boxSpawnBlock('b1'));
  const cards = alerts.slice(before).filter((a) => a.status === 'pending');
  assert.equal(cards.length, 1, 'um cartão de reabrir só');
  await guard3.resolve(cards[0].id, 'extend');
  assert.equal(guard3.boxSpawnBlock('b1'), undefined);
  assert.equal(box.closed, false);
  guard3.dispose();
});

test('cofre: grava, soma padrões e conta tentativas', () => {
  resetLockboxCacheForTest();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-lockbox-'));
  assert.deepEqual(lockboxPatterns(root), []);
  const lb: Lockbox = {
    id: nextLockboxId([]),
    name: 'teste final',
    paths: ['data/test/**'],
    hypotheses: ['h1'],
    command: 'python eval.py --tag {hypothesis}',
    createdAt: new Date().toISOString(),
    createdBy: 'main',
    blockedCount: 0,
    blocked: [],
    evaluations: [],
  };
  assert.equal(lb.id, 'lb1');
  writeLockboxes(root, [lb]);
  assert.deepEqual(lockboxPatterns(root), ['data/test/**', '.agm/lockbox.json', '.agm/lockbox.json.bak']);
  recordBlocked(root, 'lb1', { at: new Date().toISOString(), agent: 'a2', tool: 'Read' });
  const again = readLockboxes(root)[0];
  assert.equal(again.blockedCount, 1);
  assert.equal(again.blocked[0].agent, 'a2');
  assert.equal(nextLockboxId([again]), 'lb2');
  fs.rmSync(root, { recursive: true, force: true });
});

type ToolCall = (a: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function lockboxGuard(root: string, extra: Partial<ConstructorParameters<typeof AgentGuard>[0]> = {}): { guard: AgentGuard; asked: { tool: string; reason: string }[]; answer: { decision: string } } {
  const asked: { tool: string; reason: string }[] = [];
  const answer = { decision: 'allow' };
  const ref: { guard?: AgentGuard } = {};
  const guard = new AgentGuard({
    cwd: root,
    info: () => undefined,
    update: () => undefined,
    post: (msg: HostMessage) => {
      if (msg.type === 'permission') {
        asked.push({ tool: String(msg.toolName), reason: String(msg.reason ?? '') });
        ref.guard!.respondPermission(msg.requestId, { decision: answer.decision } as never);
      }
    },
    isBusy: () => false,
    interrupt: async () => undefined,
    continueAgent: () => undefined,
    stopForGood: async () => undefined,
    sendFromUser: () => undefined,
    stop: async () => undefined,
    log: () => undefined,
    ...extra,
  });
  ref.guard = guard;
  return { guard, asked, answer };
}

function toolOf(guard: AgentGuard, name: string): ToolCall {
  return guard.mainTools().find((t) => t.name === name)!.handler as unknown as ToolCall;
}

test('outputNumbers: última linha JSON vira métricas; números soltos também contam', () => {
  const r = outputNumbers('carregando 1000 linhas\nauc por classe: 0.71 0.64\n[aviso] ignorado\n{"auc": 0.8312, "n": 250, "por_classe": {"a": 0.5}}\n');
  assert.deepEqual(r.metrics, { auc: 0.8312, n: 250, 'por_classe.a': 0.5 });
  for (const n of [0.8312, 250, 0.5, 0.71, 0.64, 1000]) {
    assert.ok(r.numbers.includes(n), `falta ${n}`);
  }
  const plain = outputNumbers('acc = 91.5%');
  assert.deepEqual(plain.metrics, {});
  assert.deepEqual(plain.numbers, [91.5]);
});

test('cofre sem hipóteses: conta as avaliações dele, guarda números e não o stdout', async () => {
  resetLockboxCacheForTest();
  resetHeavyForTest();
  testConfig['maxHeavyProcesses'] = 2;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-lockbox-'));
  fs.mkdirSync(path.join(root, 'cofre'));
  fs.writeFileSync(path.join(root, 'cofre', 'y.csv'), 'a,b\n');
  const { guard, asked, answer } = lockboxGuard(root);
  const register = toolOf(guard, 'register_lockbox');
  const evaluate = toolOf(guard, 'lockbox_evaluate');
  const reg = await register({ name: 'final', paths: ['cofre/**', 'nada/**'], command: 'node -e "console.log(JSON.stringify({auc: 0.8312, n: 250}))"' });
  assert.notEqual(reg.isError, true);
  assert.match(reg.content[0].text, /AVISO: Nenhum arquivo ou pasta de .* casa com: nada\/\*\*/);
  assert.ok(reg.content[0].text.includes(root), 'diz a raiz usada');
  assert.match(asked[0].reason, /ATENÇÃO: Nenhum arquivo/, 'o cartão de aprovação também avisa');
  assert.deepEqual(readLockboxes(root)[0].hypotheses, []);

  const e1 = await evaluate({ lockbox: 'lb1' });
  assert.notEqual(e1.isError, true, e1.content[0].text);
  assert.equal(asked.length, 1, 'a primeira avaliação roda sem perguntar');
  const stored = readLockboxes(root)[0].evaluations;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].hypothesisId, NO_HYPOTHESIS);
  assert.deepEqual(stored[0].metrics, { auc: 0.8312, n: 250 });
  assert.ok(stored[0].numbers?.includes(0.8312));
  assert.ok(!fs.readFileSync(path.join(root, '.agm', 'lockbox.json'), 'utf8').includes('"stdout"'), 'só os números, não o stdout');
  assert.ok(lockboxNumbers(root).includes(0.8312));
  assert.deepEqual(lockboxNumbers(root, new Date(Date.now() + 60_000).toISOString()), [], 'filtra por hora');

  answer.decision = 'deny';
  const e2 = await evaluate({ lockbox: 'lb1' });
  assert.equal(e2.isError, true);
  assert.equal(asked.length, 2, 'a segunda avaliação do cofre pede aprovação');
  assert.equal(readLockboxes(root)[0].evaluations.length, 1);
  const badHyp = await evaluate({ lockbox: 'lb1', hypothesis_id: 'h9' });
  assert.equal(badHyp.isError, true);
  guard.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

test('cofre com hipótese: o resultado vira run pelo host; caminho certo não avisa', async () => {
  resetLockboxCacheForTest();
  resetHeavyForTest();
  testConfig['maxHeavyProcesses'] = 2;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-lockbox-'));
  fs.mkdirSync(path.join(root, 'cofre'));
  fs.writeFileSync(path.join(root, 'avaliar.py'), '');
  const runs: Record<string, unknown>[] = [];
  const { guard } = lockboxGuard(root, {
    recordLockboxRun: (a) => {
      runs.push(a);
      return { ok: true, note: `registrado como run r${runs.length} da ${a.hypothesisId}` };
    },
  });
  const reg = await toolOf(guard, 'register_lockbox')({ name: 'final', paths: ['cofre/**', 'avaliar.py'], hypothesis_ids: ['h1'], command: 'node -e "console.log(JSON.stringify({auc: 0.9}))"' });
  assert.doesNotMatch(reg.content[0].text, /AVISO/);
  const evaluate = toolOf(guard, 'lockbox_evaluate');
  assert.equal((await evaluate({ lockbox: 'lb1' })).isError, true, 'cofre com hipóteses exige hypothesis_id');
  const e1 = await evaluate({ lockbox: 'lb1', hypothesis_id: 'h1' });
  assert.match(e1.content[0].text, /registrado como run r1 da h1/);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].metrics, { auc: 0.9 });
  assert.equal(runs[0].lockboxId, 'lb1');
  assert.equal(runs[0].evalId, 'e1');
  guard.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

test('cofre: glob fora do projeto ou sem arquivo é apontado', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-lockbox-'));
  fs.mkdirSync(path.join(root, 'data', 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'test', 'x.csv'), '');
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'skip.txt'), '');
  const r = patternsWithoutFiles(root, ['data/test/**', 'data/*.csv', 'eval.py', '../fora/**', '**/*.txt']);
  assert.deepEqual(r.missing, ['data/*.csv', 'eval.py', '**/*.txt'], 'node_modules não conta');
  assert.deepEqual(r.outside, ['../fora/**']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('caixa: gasto em US$ soma, o resumo mostra todos os tetos e o aviso de 80% dispara', () => {
  const box: BoxInfo = { id: 'b1', name: 'Drones', createdAt: '', budget: { maxTokens: 2_000_000, maxMinutes: 150, maxUsd: 35 } };
  const agents = new Map<string, AgentInfo>();
  for (const id of ['a2', 'a3']) {
    agents.set(id, { id, kind: 'routed', description: id, status: 'running', box: 'b1', totalTokens: 0, durationMs: 0, toolUses: 0 } as AgentInfo);
  }
  const notices: string[] = [];
  const guard = new AgentGuard({
    cwd: os.tmpdir(),
    info: (id) => agents.get(id),
    update: (id, patch) => agents.set(id, { ...agents.get(id)!, ...patch }),
    post: (msg: HostMessage) => {
      if (msg.type === 'notice') {
        notices.push(msg.text);
      }
    },
    isBusy: () => false,
    interrupt: async () => undefined,
    continueAgent: () => undefined,
    stopForGood: async () => undefined,
    sendFromUser: () => undefined,
    stop: async () => undefined,
    log: () => undefined,
    boxes: () => [box],
    agents: () => [...agents.values()],
  });
  const before = guard.boxSpendSummary('b1')!;
  assert.match(before.text, /US\$ 0,00 de US\$ 35,00 estimados/, 'o teto de US$ aparece antes do primeiro custo');
  assert.match(before.text, /de 2\.0M tokens processados/);
  assert.match(before.text, /de 2h 30min de trabalho/);
  assert.equal(before.warn, false);
  assert.equal(guard.boxSpendSummary('nao-existe'), undefined);

  // O SDK manda o total acumulado do query(); o guarda soma só a diferença.
  guard.onUsage('a2', { costUsdTotal: 10 });
  guard.onUsage('a2', { costUsdTotal: 18 });
  guard.onUsage('a3', { costUsdTotal: 9.5 });
  assert.equal(agents.get('a2')!.spent?.usd, 18);
  const mid = guard.boxSpendSummary('b1')!;
  assert.equal(mid.spent.usd, 27.5);
  assert.equal(mid.members, 2);
  assert.match(mid.text, /US\$ 27,50 de US\$ 35,00 estimados/);
  assert.equal(mid.warn, false, '27,5 de 35 = 79%');
  assert.equal(notices.length, 0);
  guard.onUsage('a3', { costUsdTotal: 11 });
  assert.equal(guard.boxSpendSummary('b1')!.warn, true);
  assert.equal(notices.length, 1, 'o aviso de 80% dispara só com US$');
  assert.match(notices[0], /83% do orçamento.*US\$ 29,00 de US\$ 35,00/);
  guard.onUsage('a3', { costUsdTotal: 12 });
  assert.equal(notices.length, 1, 'um aviso só');
  guard.dispose();
});

test('Bash com processos em paralelo ganha aviso; comando comum não', () => {
  for (const cmd of ['python treinar.py --paralelo 5', 'make -j 8', 'python run.py --workers=4', 'seq 1 5 | xargs -P 5 -n1 python job.py', 'python -c "from concurrent.futures import ProcessPoolExecutor"', 'Start-Process a.exe; Start-Process b.exe']) {
    assert.match(parallelLaunchHint(cmd) ?? '', /run_seeds/, cmd);
  }
  for (const cmd of ['python treinar.py --seed 3', 'npm run build', 'make -j1', 'python run.py --workers 1', 'git log -P', 'scp -P 22 a.txt host:/tmp', 'ssh -p 2222 host ls', 'Start-Process notepad', 'Start-Process a.exe -Wait; Start-Process b.exe -Wait', 'grep -P 10 x']) {
    assert.equal(parallelLaunchHint(cmd), undefined, cmd);
  }
});

test('comando de subagente que cita caminho protegido é recusado', () => {
  const root = os.tmpdir();
  assert.ok(commandBlocked(['data/test/**'], [root], 'python train.py --data data/test/x.csv --seed {seed}'));
  assert.ok(commandBlocked(['eval.py'], [root], 'python eval.py --seed {seed}'));
  assert.equal(commandBlocked(['data/test/**'], [root], 'python train.py --data data/train --seed {seed}'), undefined);
  assert.equal(commandBlocked([], [root], 'qualquer coisa'), undefined);
});

void (async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (err) {
      failed++;
      console.log(`FALHOU ${name}\n${err instanceof Error ? err.stack : err}`);
    }
  }
  console.log(failed ? `\n${failed} teste(s) falharam` : '\ntodos os testes do guarda passaram');
  process.exit(failed ? 1 : 0);
})();
