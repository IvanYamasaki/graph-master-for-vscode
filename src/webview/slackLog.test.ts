/**
 * Testes do agrupamento do log no estilo Slack. Sem VS Code:
 *   npx esbuild src/webview/slackLog.test.ts --bundle --platform=node --outfile=$TEMP/slackLog.test.js && node $TEMP/slackLog.test.js
 */
import * as assert from 'node:assert/strict';
import { GROUP_MS, authorOf, continuesRun, dayLabel } from './slackLog';

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

const cls = (...names: string[]) => ({ contains: (c: string) => names.includes(c) });
const T = new Date(2026, 9, 8, 15, 0).getTime();

test('autor pelas classes do elemento', () => {
  assert.equal(authorOf(cls('msg', 'user')), 'user');
  assert.equal(authorOf(cls('msg', 'assistant', 'md')), 'claude');
  assert.equal(authorOf(cls('tool-group')), 'claude');
  assert.equal(authorOf(cls('tool', 'slim')), 'claude');
  assert.equal(authorOf(cls('msg', 'report', 'has-agent')), 'agent');
  assert.equal(authorOf(cls('post')), 'agent');
  assert.equal(authorOf(cls('ag-card', 'chat-slot', 'compact')), 'agent');
  assert.equal(authorOf(cls('perm', 'decision')), 'meta');
  assert.equal(authorOf(cls('result')), 'meta');
});

test('mesmo autor em até 5 min continua; outro autor, agente ou intervalo longo abre cabeçalho', () => {
  assert.equal(continuesRun(undefined, { author: 'user', at: T }), false);
  assert.equal(continuesRun({ author: 'user', at: T }, { author: 'user', at: T + GROUP_MS - 1 }), true);
  assert.equal(continuesRun({ author: 'user', at: T }, { author: 'user', at: T + GROUP_MS }), false);
  assert.equal(continuesRun({ author: 'user', at: T }, { author: 'claude', at: T + 1 }), false);
  assert.equal(continuesRun({ author: 'agent', at: T }, { author: 'agent', at: T + 1 }), false);
  // Histórico sem hora junta pelo autor; a primeira ao vivo depois dele abre cabeçalho com hora.
  assert.equal(continuesRun({ author: 'claude' }, { author: 'claude' }), true);
  assert.equal(continuesRun({ author: 'claude' }, { author: 'claude', at: T }), false);
});

test('divisor de dia: Hoje, Ontem e a data por extenso', () => {
  assert.equal(dayLabel(T, T + 60_000), 'Hoje');
  assert.equal(dayLabel(new Date(2026, 9, 7, 23, 59).getTime(), T), 'Ontem');
  assert.match(dayLabel(new Date(2026, 9, 1, 12, 0).getTime(), T), /outubro/);
});

if (failed) {
  console.log(`\n${failed} teste(s) falharam`);
  process.exit(1);
}
console.log('\ntodos passaram');
