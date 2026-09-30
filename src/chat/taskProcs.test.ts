/**
 * Testes da busca da raiz de uma tarefa de shell e do detalhe do modal de órfãos, com listas de processos montadas à
 * mão (sem ler o sistema). Sem VS Code:
 *   npx esbuild src/chat/taskProcs.test.ts --bundle --platform=node --outfile=$TEMP/taskProcs.test.js && node $TEMP/taskProcs.test.js
 */
import * as assert from 'node:assert/strict';
import type { ProcInfo } from './proc';
import { orphanDetail, searchTaskRoot, snapFromView, wrapLines } from './taskProcs';
import { commandNeedle } from './taskLiveness';

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

const T = Date.parse('2026-09-30T10:00:00.000Z');
const at = (s: number): Date => new Date(T + s * 1000);
const HOST = process.pid;
const proc = (pid: number, ppid: number, name: string, commandLine: string, startedAt: Date): ProcInfo => ({ pid, ppid, name, commandLine, startedAt });

// Extension host → dois CLIs (dois chats) → cada um com o seu `bash -c "npm run dev"` → node.
const procs: ProcInfo[] = [
  proc(HOST, 1, 'node.exe', 'extension host', at(-3600)),
  proc(100, HOST, 'claude.exe', 'claude --output-format stream-json', at(-600)),
  proc(200, HOST, 'claude.exe', 'claude --output-format stream-json', at(-500)),
  proc(110, 100, 'bash.exe', 'bash -c "npm run dev"', at(0)),
  proc(111, 110, 'node.exe', 'node npm-cli.js run dev', at(0.3)),
  proc(210, 200, 'bash.exe', 'bash -c "npm run dev"', at(3)),
  proc(211, 210, 'node.exe', 'node npm-cli.js run dev', at(3.2)),
  proc(120, 100, 'bash.exe', 'bash -c "npm run dev"', at(60)),
];

test('A1: a busca fica nos filhos do CLI desta sessão', () => {
  const info = { command: 'npm run dev', startedAt: at(3).toISOString() };
  assert.equal(searchTaskRoot(info, procs, 200)?.pid, 210);
  // O CLI 100 também tem um "npm run dev" a 3 s: o da outra sessão (210) não entra.
  assert.equal(searchTaskRoot(info, procs, 100)?.pid, 110);
});

test('A1: fora da janela de 5 s não há raiz (sem recuo para o mais recente)', () => {
  const info = { command: 'npm run dev', startedAt: at(30).toISOString() };
  assert.equal(searchTaskRoot(info, procs, 100), undefined);
});

test('M1: entre dois candidatos no mesmo CLI, vence o mais perto do início da tarefa', () => {
  const same = [...procs, proc(130, 100, 'bash.exe', 'bash -c "npm run dev"', at(2))];
  assert.equal(searchTaskRoot({ command: 'npm run dev', startedAt: at(2.2).toISOString() }, same, 100)?.pid, 130);
  assert.equal(searchTaskRoot({ command: 'npm run dev', startedAt: at(0.1).toISOString() }, same, 100)?.pid, 110);
});

test('sem PID do CLI ou sem início, não busca', () => {
  assert.equal(searchTaskRoot({ command: 'npm run dev', startedAt: at(0).toISOString() }, procs, undefined), undefined);
  assert.equal(searchTaskRoot({ command: 'npm run dev' }, procs, 100), undefined);
});

test('trecho do comando sobrevive às aspas do embrulho do shell', () => {
  assert.equal(commandNeedle(`node -e "require('http').createServer().listen(3999)"`), ').createServer().listen(3999)');
  assert.equal(commandNeedle('cd api && npm run start:dev'), 'npm run start:dev');
});

test('M3: modal mostra pai (vivo ou não), início, portas e o comando inteiro em linhas', () => {
  const long = `C:\\Program Files\\nodejs\\node.exe C:\\Users\\x\\proj\\node_modules\\vite\\bin\\vite.js --port 5173 ${'--flag '.repeat(20)}`;
  const detail = orphanDetail([
    { root: { pid: 9, ppid: 8, name: 'node.exe', commandLine: long, startedAt: at(0).toISOString(), ports: [5173] }, members: [], ports: [5173], parentAlive: true, parent: { pid: 8, name: 'pwsh.exe', alive: true } },
    { root: { pid: 19, ppid: 18, name: 'cmd.exe', commandLine: 'cmd /c npm run dev', ports: [] }, members: [], ports: [], parentAlive: false, parent: { pid: 18, alive: false } },
  ]);
  assert.match(detail, /pai: pwsh\.exe PID 8, ainda aberto/);
  assert.match(detail, /pai: PID 18, encerrado/);
  assert.match(detail, /portas: 5173/);
  assert.match(detail, /início: desconhecido/);
  assert.ok(detail.includes('--flag --flag'), 'comando inteiro');
  assert.ok(detail.split('\n').every((l) => l.length <= 110), 'linhas quebradas');
});

test('wrapLines quebra em pedaços e junta espaços', () => {
  assert.deepEqual(wrapLines('a  b', 100), ['a b']);
  assert.deepEqual(wrapLines('x'.repeat(250), 100).map((l) => l.length), [100, 100, 50]);
});

test('foto vinda do webview volta com a data', () => {
  const s = snapFromView({ pid: 5, name: 'node.exe', startedAt: at(1).toISOString() });
  assert.equal(s.startedAt?.getTime(), at(1).getTime());
  assert.equal(snapFromView({ pid: 5, name: 'x' }).startedAt, undefined);
});

if (failed) {
  console.log(`\n${failed} teste(s) falharam`);
  process.exit(1);
}
console.log('\ntodos os testes de processos das tarefas passaram');
