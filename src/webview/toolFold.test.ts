/**
 * Testes do recolhimento de ferramentas no chat. Sem VS Code:
 *   npx esbuild src/webview/toolFold.test.ts --bundle --platform=node --outfile=$TEMP/toolFold.test.js && node $TEMP/toolFold.test.js
 */
import * as assert from 'node:assert/strict';
import { FoldGroup, FoldTool, countLabel, foldLabel, groupState, isAgentSpawn, isFoldable, uniqueLabels } from './toolFold';

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

const tool = (name: string, state: FoldTool['state'] = 'completed', summary = ''): FoldTool => ({ id: `${name}-${summary}`, name, label: name, summary, state });
const show = { showCurrent: true };
const count = { showCurrent: false };

test('pergunta, plano, pesquisa e imagens ficam fora do grupo', () => {
  for (const name of ['AskUserQuestion', 'ExitPlanMode', 'mcp__agents__web_research', 'mcp__agents__generate_image', 'mcp__agents__show_image']) {
    assert.equal(isFoldable(name), false, name);
  }
  for (const name of ['Bash', 'Read', 'Edit', 'Grep', 'WebFetch', 'mcp__claude-in-chrome__computer', 'mcp__agents__spawn_agent']) {
    assert.equal(isFoldable(name), true, name);
  }
});

test('Agent e Task contam como cartão de agente', () => {
  assert.equal(isAgentSpawn('Agent'), true);
  assert.equal(isAgentSpawn('Task'), true);
  assert.equal(isAgentSpawn('Bash'), false);
});

test('estado agregado: rodando vence erro, erro vence ok', () => {
  assert.equal(groupState([tool('Bash'), tool('Read')]), 'completed');
  assert.equal(groupState([tool('Bash'), tool('Read', 'failed')]), 'failed');
  assert.equal(groupState([tool('Bash', 'failed'), tool('Read', 'running')]), 'running');
  assert.equal(groupState([]), 'completed');
});

test('contagem no singular e no plural', () => {
  assert.equal(countLabel(1), '1 ação');
  assert.equal(countLabel(6), '6 ações');
});

test('terminado: "6 ações" e os nomes sem repetir, na ordem', () => {
  const tools = [tool('Bash', 'completed', '1'), tool('Read', 'completed', '2'), tool('Read', 'completed', '3'), tool('Edit', 'completed', '4'), tool('Edit', 'completed', '5'), tool('Bash', 'completed', '6')];
  assert.deepEqual(uniqueLabels(tools), ['Bash', 'Read', 'Edit']);
  const l = foldLabel(tools, show);
  assert.equal(l.head, '6 ações');
  assert.equal(l.tail, 'Bash, Read, Edit');
  assert.equal(l.title, '6 ações · Bash, Read, Edit');
  assert.equal(l.state, 'completed');
});

test('mais de três nomes viram "+N"', () => {
  const l = foldLabel([tool('Bash'), tool('Read'), tool('Edit'), tool('Grep'), tool('Glob')], show);
  assert.equal(l.tail, 'Bash, Read, Edit +2');
});

test('erro aparece na cauda e pinta o estado', () => {
  const l = foldLabel([tool('Bash', 'failed'), tool('Read'), tool('Edit', 'failed')], show);
  assert.equal(l.state, 'failed');
  assert.equal(l.tail, '2 com erro · Bash, Read, Edit');
  assert.equal(foldLabel([tool('Bash', 'failed')], show).tail, '1 com erro · Bash');
});

test('rodando com showCurrent: só a ação atual, sem empilhar', () => {
  const tools = [tool('Bash', 'completed', 'ls'), tool('Read', 'completed', 'a.ts'), tool('Edit', 'running', 'media/chat.css')];
  const l = foldLabel(tools, show);
  assert.equal(l.head, 'Edit media/chat.css');
  assert.equal(l.tail, '3 ações');
  assert.equal(l.state, 'running');
});

test('rodando sem showCurrent (balão de pensamento ligado): só conta', () => {
  const l = foldLabel([tool('Bash', 'completed', 'ls'), tool('Edit', 'running', 'media/chat.css')], count);
  assert.equal(l.head, '2 ações');
  assert.equal(l.tail, 'em andamento');
  assert.ok(!l.title.includes('chat.css'));
});

test('ação atual é a última que roda, mesmo com várias em paralelo', () => {
  const l = foldLabel([tool('Read', 'running', 'a.ts'), tool('Read', 'running', 'b.ts'), tool('Bash', 'completed', 'x')], show);
  assert.equal(l.head, 'Read b.ts');
});

test('ação atual sem resumo ainda (só toolStart) mostra o nome', () => {
  assert.equal(foldLabel([tool('Grep', 'running')], show).head, 'Grep');
});

test('FoldGroup: start é idempotente, describe e finish mudam o estado', () => {
  const g = new FoldGroup();
  g.start('t1', 'Bash', 'Bash');
  g.start('t1', 'Bash', 'Bash');
  g.start('t2', 'Read', 'Read');
  assert.equal(g.size, 2);
  assert.equal(g.state(), 'running');
  g.describe('t1', 'ls');
  g.finish('t1', false);
  assert.equal(g.label(show).head, 'Read');
  g.finish('t2', true);
  assert.equal(g.state(), 'failed');
  assert.equal(g.label(show).title, '2 ações · 1 com erro · Bash, Read');
  g.finish('nao-existe', true);
  assert.equal(g.size, 2);
});

if (failed) {
  console.log(`\n${failed} falharam`);
  process.exit(1);
}
console.log('\ntodos os testes passaram');
