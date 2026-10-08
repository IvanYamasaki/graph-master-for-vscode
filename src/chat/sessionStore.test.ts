/**
 * Testes da pasta por conversa e da persistência dos agentes do mapa. Sem VS Code:
 *   npx esbuild src/chat/sessionStore.test.ts --bundle --platform=node --outfile=$TEMP/sessionStore.test.js && node $TEMP/sessionStore.test.js
 */
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Memento } from 'vscode';
import { AgentStore } from './agentStore';
import type { AgentInfo, BoxInfo } from './protocol';
import { SessionStore } from './sessionStore';

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

/** workspaceState de mentira: um Map com a mesma interface. */
function memento(initial: Record<string, unknown> = {}): Memento {
  const data = new Map(Object.entries(initial));
  return {
    keys: () => [...data.keys()],
    get: <T>(key: string, def?: T) => (data.has(key) ? (data.get(key) as T) : def),
    update: (key: string, value: unknown) => {
      if (value === undefined) {
        data.delete(key);
      } else {
        data.set(key, value);
      }
      return Promise.resolve();
    },
  } as Memento;
}

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agm-sessions-'));
}

function agent(n: number, extra: Partial<AgentInfo> = {}): AgentInfo {
  return { id: `a${n}`, kind: 'routed', description: `agente ${n}`, status: 'completed', totalTokens: n, durationMs: 0, toolUses: 0, ...extra } as AgentInfo;
}

const SID = '1846c4d1-07c9-46c6-ab45-7c608f7ba100';

test('conversa com 42 agentes volta com os 42 (antes o slice(-40) jogava fora a1 e a2)', () => {
  const sessions = new SessionStore(tmpRoot());
  const store = new AgentStore(memento(), sessions);
  store.save(SID, Array.from({ length: 42 }, (_, i) => agent(i + 1)));
  store.flush();
  const back = new AgentStore(memento(), sessions).load(SID);
  assert.equal(back.length, 42);
  assert.equal(back[0].id, 'a1');
  assert.equal(sessions.meta(SID)?.agents, 42);
});

test('dois painéis na mesma conversa: o que grava por último com lista velha não apaga o agente novo do outro', () => {
  const sessions = new SessionStore(tmpRoot());
  const a = new AgentStore(memento(), sessions);
  const b = new AgentStore(memento(), sessions);
  a.save(SID, [agent(1), agent(2), agent(3)]);
  a.flush();
  b.save(SID, [agent(1, { status: 'stopped' }), agent(2)]);
  b.flush();
  const back = a.load(SID);
  assert.deepEqual(back.map((x) => x.id), ['a1', 'a2', 'a3']);
  assert.equal(back[0].status, 'stopped', 'a versão de quem grava vale para os ids que ele tem');
});

test('lista vazia não apaga a conversa do disco', () => {
  const sessions = new SessionStore(tmpRoot());
  const store = new AgentStore(memento(), sessions);
  store.save(SID, [agent(1)]);
  store.flush();
  store.save(SID, []);
  store.flush();
  assert.equal(store.load(SID).length, 1);
});

test('trocar de chave no meio do debounce grava as duas conversas', () => {
  const sessions = new SessionStore(tmpRoot());
  const store = new AgentStore(memento(), sessions);
  store.save('conv-a', [agent(1)]);
  store.save('conv-b', [agent(1), agent(2)]);
  store.flush();
  assert.equal(store.load('conv-a').length, 1);
  assert.equal(store.load('conv-b').length, 2);
});

test('id novo com a conversa viva (fork, /clear) copia a pasta: threads e imagens vão junto', () => {
  const sessions = new SessionStore(tmpRoot());
  const store = new AgentStore(memento(), sessions);
  store.save('conv-a', [agent(1)]);
  store.flush();
  sessions.write('conv-a', 'threads', [{ agentId: 'a1' }]);
  store.save('conv-a', [agent(1)]);
  store.save('conv-b', [agent(1), agent(2)]);
  store.flush();
  assert.deepEqual(sessions.read('conv-b', 'threads'), [{ agentId: 'a1' }]);
  assert.equal(sessions.meta('conv-b')?.forkOf, 'conv-a');
  assert.equal(store.load('conv-b').length, 2);
  // A origem fica como estava.
  assert.equal(store.load('conv-a').length, 1);
});

test('troca de conversa de propósito (flush antes) não conta como fork', () => {
  const sessions = new SessionStore(tmpRoot());
  const store = new AgentStore(memento(), sessions);
  sessions.write('conv-a', 'threads', [1]);
  store.save('conv-a', [agent(1)]);
  store.flush();
  store.save('conv-b', [agent(5)]);
  store.flush();
  assert.equal(sessions.read('conv-b', 'threads'), undefined);
  assert.equal(sessions.meta('conv-b')?.forkOf, undefined);
});

test('migração: a chave antiga do workspaceState vai para a pasta de cada conversa e sai do state', () => {
  const sessions = new SessionStore(tmpRoot());
  const box: BoxInfo = { id: 'b1', name: 'Onda 1', createdAt: new Date(0).toISOString() };
  const state = memento({
    'agentGraphMaster.routedAgents': {
      [SID]: { savedAt: 1, agents: [agent(3), agent(4)], boxes: [box] },
      'conv-x': { savedAt: 2, agents: [agent(1)] },
      lixo: { agents: 'não é lista' },
    },
  });
  const store = new AgentStore(state, sessions);
  assert.deepEqual(store.load(SID).map((a) => a.id), ['a3', 'a4']);
  assert.equal(store.loadBoxes(SID)[0]?.name, 'Onda 1');
  assert.equal(store.load('conv-x').length, 1);
  assert.equal(state.get('agentGraphMaster.routedAgents'), undefined);
  assert.deepEqual(sessions.list().map((m) => m.id).sort(), ['conv-x', SID].sort());
});

test('sessionStore: gravação atômica, meta, arquivos e .gitignore', () => {
  const root = tmpRoot();
  const sessions = new SessionStore(root);
  sessions.write('s1', 'images', [{ path: 'files/x.png' }]);
  assert.deepEqual(sessions.read('s1', 'images'), [{ path: 'files/x.png' }]);
  assert.ok(sessions.meta('s1')?.updatedAt);
  const leftovers = fs.readdirSync(sessions.dir('s1')).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
  const f1 = sessions.saveFile('s1', 'foto.png', Buffer.from([1, 2]));
  const f2 = sessions.saveFile('s1', 'foto.png', Buffer.from([3]));
  assert.notEqual(f1, f2);
  assert.equal(fs.readFileSync(f2).length, 1);
  assert.match(fs.readFileSync(path.join(root, '.agm', 'sessions', '.gitignore'), 'utf8'), /^\*$/m);
  // Arquivo corrompido não derruba quem lê.
  fs.writeFileSync(path.join(sessions.dir('s1'), 'agents.json'), '{meio');
  assert.equal(sessions.read('s1', 'agents'), undefined);
  assert.deepEqual(new AgentStore(memento(), sessions).load('s1'), []);
  assert.throws(() => sessions.write('../fora', 'x', 1));
  assert.throws(() => sessions.write('s1', '../x', 1));
});

if (failed) {
  console.log(`\n${failed} teste(s) falharam`);
  process.exit(1);
}
console.log('\ntodos os testes passaram');
