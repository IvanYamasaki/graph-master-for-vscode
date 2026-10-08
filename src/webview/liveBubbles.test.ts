/**
 * Testes da lógica dos balões de vida do chat. Sem VS Code:
 *   npx esbuild src/webview/liveBubbles.test.ts --bundle --platform=node --outfile=$TEMP/liveBubbles.test.js && node $TEMP/liveBubbles.test.js
 */
import * as assert from 'node:assert/strict';
import { LiveModel, TextPacer, agentNow, clip, describeTool, flatLine, fmtElapsed, mcpToolLabel, openTool, tail } from './liveLogic';

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

test('clip junta espaços e corta com reticências em até 120 caracteres', () => {
  assert.equal(clip('  uma   frase\ncurta '), 'uma frase curta');
  const long = clip('palavra '.repeat(40));
  assert.ok(long.length <= 120, String(long.length));
  assert.ok(long.endsWith('…'));
  assert.ok(!long.includes('  '));
});

test('clip corta palavra gigante sem espaço', () => {
  const out = clip('x'.repeat(300), 50);
  assert.equal(out.length, 50);
  assert.ok(out.endsWith('…'));
});

test('tail guarda o fim do texto, não o começo', () => {
  const out = tail(`${'a '.repeat(100)}fim do raciocínio`, 40);
  assert.ok(out.startsWith('…'));
  assert.ok(out.endsWith('fim do raciocínio'));
  assert.ok(out.length <= 40);
  assert.equal(tail('curto'), 'curto');
});

test('describeTool: leitura, edição e busca em português', () => {
  assert.equal(describeTool('Read', { file_path: 'C:\\x\\src\\chat\\hub.ts' }), 'lendo hub.ts');
  assert.equal(describeTool('Edit', { file_path: '/a/b/main.ts' }), 'editando main.ts');
  assert.equal(describeTool('Write', { file_path: '/a/novo.md' }), 'escrevendo novo.md');
  assert.equal(describeTool('Grep', { pattern: 'lightbox' }), "procurando 'lightbox'");
  assert.equal(describeTool('Glob', { pattern: '**/*.ts' }), 'listando arquivos **/*.ts');
  assert.equal(describeTool('WebFetch', { url: 'https://example.com/a/b' }), 'abrindo example.com');
});

test('describeTool: Bash vira testes, build ou o comando curto', () => {
  assert.equal(describeTool('Bash', { command: 'npm test -- --watch=false' }), 'rodando os testes');
  assert.equal(describeTool('Bash', { command: 'npx tsc -p . --noEmit' }), 'compilando o projeto');
  assert.equal(describeTool('Bash', { command: 'npm install' }), 'instalando dependências');
  assert.equal(describeTool('Bash', { command: 'git status --short' }), 'olhando o git (status)');
  assert.equal(describeTool('Bash', { command: 'ls -la', description: 'Lista a pasta' }), 'lista a pasta');
  assert.equal(describeTool('Bash', { command: 'ls -la' }), 'rodando ls -la');
});

test('describeTool: ferramentas do servidor agents e desconhecidas', () => {
  assert.equal(describeTool('mcp__agents__report_progress', { text: 'lendo calls de setembro' }), 'lendo calls de setembro');
  assert.equal(describeTool('mcp__agents__spawn_agent', { description: 'Imagens no chat' }), 'criando agente: Imagens no chat');
  assert.equal(describeTool('mcp__agents__brain_search', { query: 'x' }), 'consultando o cérebro');
  assert.equal(describeTool('mcp__agents__brain_fact', {}), 'anotando no cérebro');
  assert.equal(describeTool('mcp__outro__faz_coisa', {}), 'usando faz coisa');
  assert.equal(describeTool('Estranha', null), 'usando Estranha');
  assert.equal(describeTool('Read', null), 'lendo um arquivo');
});

test('fmtElapsed', () => {
  assert.equal(fmtElapsed(-5), '0s');
  assert.equal(fmtElapsed(7400), '7s');
  assert.equal(fmtElapsed(65_000), '1m 05s');
  assert.equal(fmtElapsed(3_720_000), '1h 02m');
});

test('TextPacer: primeira troca na hora, as seguintes esperam o intervalo', () => {
  const p = new TextPacer(1500);
  assert.equal(p.push('a', 0), true);
  assert.equal(p.text, 'a');
  assert.equal(p.push('b', 400), false);
  assert.equal(p.text, 'a');
  assert.equal(p.wait(400), 1100);
  assert.equal(p.poll(1000), false);
  assert.equal(p.poll(1500), true);
  assert.equal(p.text, 'b');
  assert.equal(p.wait(1500), undefined);
});

test('TextPacer: rajada fica só com o texto mais novo', () => {
  const p = new TextPacer(1500);
  p.push('a', 0);
  p.push('b', 100);
  p.push('c', 200);
  p.push('d', 300);
  assert.equal(p.poll(1500), true);
  assert.equal(p.text, 'd');
  assert.equal(p.poll(1600), false);
});

test('TextPacer: texto igual ao visível cancela o pendente', () => {
  const p = new TextPacer(1500);
  p.push('a', 0);
  p.push('b', 100);
  p.push('a', 200);
  assert.equal(p.wait(200), undefined);
  assert.equal(p.poll(2000), false);
  assert.equal(p.text, 'a');
});

test('LiveModel: evento de quem não trabalha é ignorado', () => {
  const m = new LiveModel();
  assert.equal(m.typing('a1'), false);
  assert.equal(m.tool('a1', 'Read', { file_path: 'x.ts' }, 0), false);
  assert.equal(m.active, false);
  assert.equal(m.view('a1', 0), undefined);
});

test('LiveModel: digitando some quando a mensagem chega', () => {
  const m = new LiveModel();
  m.start('main', 0);
  assert.equal(m.view('main', 0)?.kind, 'none');
  assert.equal(m.typing('main'), true);
  assert.equal(m.typing('main'), false);
  assert.equal(m.view('main', 10)?.kind, 'typing');
  assert.equal(m.message('main'), true);
  assert.equal(m.view('main', 20)?.kind, 'none');
});

test('LiveModel: ferramenta troca digitando por pensamento, com o tempo do turno', () => {
  const m = new LiveModel();
  m.start('a1', 1000);
  m.typing('a1');
  assert.equal(m.tool('a1', 'Read', { file_path: '/x/hub.ts' }, 2000), true);
  const v = m.view('a1', 4000)!;
  assert.equal(v.kind, 'thought');
  assert.equal(v.text, 'lendo hub.ts');
  assert.equal(v.elapsedMs, 3000);
});

test('LiveModel: troca de balão respeita 1,5 s e o relógio de poll', () => {
  const m = new LiveModel(1500, 120);
  m.start('a1', 0);
  m.tool('a1', 'Read', { file_path: 'a.ts' }, 0);
  m.tool('a1', 'Read', { file_path: 'b.ts' }, 500);
  m.tool('a1', 'Read', { file_path: 'c.ts' }, 900);
  assert.equal(m.view('a1', 900)?.text, 'lendo a.ts');
  assert.equal(m.nextWake(900), 600);
  assert.equal(m.poll(1500), true);
  assert.equal(m.view('a1', 1500)?.text, 'lendo c.ts');
  assert.equal(m.nextWake(1500), undefined);
});

test('LiveModel: thinking corta no limite e sem texto cai em "pensando…"', () => {
  const m = new LiveModel(1500, 40);
  m.start('main', 0);
  m.thinking('main', 'x '.repeat(200), 0);
  assert.ok((m.view('main', 0)?.text.length ?? 0) <= 40);
  const n = new LiveModel();
  n.start('main', 0);
  n.thinking('main', undefined, 0);
  assert.equal(n.view('main', 0)?.text, 'pensando…');
});

test('LiveModel: stop apaga tudo e nada sobra ativo', () => {
  const m = new LiveModel();
  m.start('a1', 0);
  m.start('a2', 0);
  assert.deepEqual(m.ids(), ['a1', 'a2']);
  m.stop('a1');
  m.stop('a2');
  assert.equal(m.active, false);
  assert.equal(m.nextWake(0), undefined);
  assert.equal(m.stop('a1'), false);
});

test('linha "Agora": ferramenta aberta, texto, última ferramenta ou começando', () => {
  const describe = (name: string) => `resumo de ${name.length}`;
  const open = [{ kind: 'tool', id: 't1', name: 'Read', input: {} }, { kind: 'toolResult', id: 't1' }, { kind: 'tool', id: 't2', name: 'mcp__agents__brain_read', input: {} }];
  assert.deepEqual(agentNow(open, undefined, describe), { tag: 'usando', name: 'agents · brain_read', sum: 'resumo de 23' });
  assert.equal(openTool(open)?.id, 't2');
  const closed = [...open, { kind: 'toolResult', id: 't2' }];
  assert.equal(openTool(closed), undefined);
  assert.deepEqual(agentNow([...closed, { kind: 'text', text: '**Achei** o bug\nna linha 3' }], 'Read', describe), { tag: 'escrevendo', name: '', sum: 'Achei o bug na linha 3' });
  assert.deepEqual(agentNow(closed, 'mcp__agents__brain_read', describe), { tag: 'pensando · última ferramenta', name: 'agents · brain_read', sum: '' });
  assert.deepEqual(agentNow([], undefined, describe), { tag: 'começando', name: '', sum: '' });
  assert.equal(mcpToolLabel('Bash'), 'Bash');
  assert.equal(flatLine('a'.repeat(10), 5), 'aaaa…');
});

if (failed) {
  console.log(`\n${failed} teste(s) falharam`);
  process.exit(1);
}
console.log('\ntodos passaram');
