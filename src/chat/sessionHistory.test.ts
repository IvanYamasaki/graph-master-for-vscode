/**
 * Testes do histórico do topo do chat (sessionHistory). Sem VS Code:
 *   npx esbuild src/chat/sessionHistory.test.ts --bundle --platform=node --outfile=$TEMP/sh.test.js && node $TEMP/sh.test.js
 */
import * as assert from 'node:assert/strict';
import { agentIdsFromStore, endedMidTurn, mergeHistory } from './sessionHistory';

let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FALHA ${name}\n${err instanceof Error ? err.stack : String(err)}`);
  }
}

test('junta contas, tira agentes e ordena pela mais recente', () => {
  const out = mergeHistory(
    [
      { profileId: 'devs', profileName: 'devs', sessions: [{ sessionId: 'a', firstPrompt: 'chat a', lastModified: 10 }, { sessionId: 'ag1', firstPrompt: 'agente', lastModified: 99 }] },
      { profileId: 'ops', profileName: 'ops', sessions: [{ sessionId: 'b', summary: 'chat b', customTitle: 'Título b', lastModified: 20 }] },
    ],
    new Set(['ag1']),
  );
  assert.deepEqual(out.map((e) => [e.id, e.title, e.profileId]), [['b', 'Título b', 'ops'], ['a', 'chat a', 'devs']]);
});

test('a mesma conversa em duas contas aparece uma vez, na conta mexida por último', () => {
  const out = mergeHistory(
    [
      { profileId: 'devs', profileName: 'devs', sessions: [{ sessionId: 'x', firstPrompt: 'p', lastModified: 50 }] },
      { profileId: 'ops', profileName: 'ops', sessions: [{ sessionId: 'x', firstPrompt: 'p', lastModified: 80 }] },
    ],
    new Set(),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].profileId, 'ops');
  assert.deepEqual(out[0].alsoIn, ['devs']);
});

test('respeita o máximo e corta título longo', () => {
  const sessions = Array.from({ length: 10 }, (_, i) => ({ sessionId: `s${i}`, firstPrompt: 'x'.repeat(200), lastModified: i }));
  const out = mergeHistory([{ profileId: 'p', profileName: 'p', sessions }], new Set(), 3);
  assert.deepEqual(out.map((e) => e.id), ['s9', 's8', 's7']);
  assert.ok(out[0].title.length <= 80);
});

test('agentIdsFromStore lê o agents.json do AgentStore', () => {
  assert.deepEqual(agentIdsFromStore({ savedAt: 'x', agents: [{ id: 'a1', sessionId: 's1' }, { id: 'a2' }, { id: 'a3', sessionId: '' }] }), ['s1']);
  assert.deepEqual(agentIdsFromStore([{ sessionId: 's2' }]), ['s2']);
  assert.deepEqual(agentIdsFromStore(undefined), []);
  assert.deepEqual(agentIdsFromStore({ agents: 'quebrado' }), []);
});

test('endedMidTurn: só a resposta final do modelo fecha o turno', () => {
  assert.equal(endedMidTurn([]), false);
  assert.equal(endedMidTurn([{ kind: 'user' }, { kind: 'text' }]), false);
  assert.equal(endedMidTurn([{ kind: 'user' }]), true);
  assert.equal(endedMidTurn([{ kind: 'user' }, { kind: 'text' }, { kind: 'tool' }]), true);
  assert.equal(endedMidTurn([{ kind: 'user' }, { kind: 'tool' }, { kind: 'toolResult' }]), true);
});

if (failed) {
  console.log(`\n${failed} teste(s) falharam`);
  process.exit(1);
}
console.log('\ntodos passaram');
