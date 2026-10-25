/**
 * Testes do monitor de recursos (parsers, árvore, regras, validação do kill). Sem VS Code:
 *   npx esbuild src/chat/resourceMonitor.test.ts --bundle --platform=node --outfile=$TEMP/resourceMonitor.test.js && node $TEMP/resourceMonitor.test.js
 */
import * as assert from 'node:assert/strict';
import { ancestorsOf, descendants, parsePs, parsePsClock, parseWin32Json, shortCommand, type RawProc } from './processTree';
import { IdleTracker, buildChatReport, classifyLevel, DEFAULT_RESOURCE_CONFIG, findSuspects, fmtBytes, fmtDuration, procKind, readResourceConfig, resourceNote, summaryText, validateKillTarget } from './resourceMonitor';
import type { ChatResources } from './resourceMonitorTypes';

let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n     ${(err as Error).message.split('\n').join('\n     ')}`);
  }
}

const MB = 1024 * 1024;
const T0 = Date.UTC(2026, 9, 25, 12, 0, 0);
const H = 3_600_000;
const p = (pid: number, ppid: number, name: string, cmd: string, mb: number, extra: Partial<RawProc> = {}): RawProc => ({ pid, ppid, name, cmd, rssBytes: mb * MB, ...extra });

// ---------- Parsers ----------

test('Win32 JSON: lista, objeto único, CPU em 100 ns e BOM', () => {
  const list = parseWin32Json('\uFEFF' + JSON.stringify([
    { ProcessId: 10, ParentProcessId: 4, Name: 'claude.exe', WorkingSetSize: 223_000_000, CommandLine: 'claude.exe --x', KernelModeTime: '10000000', UserModeTime: 20000000, Started: 1000 },
    { ProcessId: 0, ParentProcessId: 0, Name: 'Idle', WorkingSetSize: 8192, CommandLine: null }
  ]));
  assert.equal(list.length, 1);
  assert.equal(list[0].cpuMs, 3000);
  assert.equal(list[0].rssBytes, 223_000_000);
  assert.equal(parseWin32Json('{"ProcessId":7,"ParentProcessId":1,"Name":"a.exe","WorkingSetSize":null,"CommandLine":null}')[0].cmd, '');
  assert.deepEqual(parseWin32Json('lixo'), []);
});

test('ps: RSS em KB, CPU e tempo de vida', () => {
  const out = parsePs('  100     1  20480 00:01:30 1-02:00:00 /usr/bin/python3 -m graphify.serve --port 1\n   bad line\n  101   100   1024    0:00.50    05:00 bash -c sleep 9\n', T0);
  assert.equal(out.length, 2);
  assert.equal(out[0].rssBytes, 20480 * 1024);
  assert.equal(out[0].cpuMs, 90_000);
  assert.equal(out[0].startedMs, T0 - 93_600_000);
  assert.equal(out[0].name, 'python3');
  assert.equal(parsePsClock('1-02:03:04'), 93784);
  assert.equal(parsePsClock('xx'), undefined);
});

test('shortCommand: módulo python, script node, shell -c, caminho', () => {
  assert.equal(shortCommand({ name: 'python.exe', cmd: '"C:\\Py\\python.exe" -m graphify.serve --x' }), 'graphify.serve');
  assert.equal(shortCommand({ name: 'node.exe', cmd: 'node C:\\a\\b\\server.js --p 1' }), 'server.js');
  assert.equal(shortCommand({ name: 'bash.exe', cmd: 'bash -c "npm run build"' }), 'bash -c npm run build');
  assert.equal(shortCommand({ name: 'ffmpeg.exe', cmd: 'ffmpeg -i C:\\v\\in.mp4 out.gif' }), 'ffmpeg -i in.mp4 out.gif');
});

// ---------- Árvore ----------

const procs: RawProc[] = [
  p(1, 0, 'Code.exe', 'Code.exe', 400, { startedMs: T0 - 10 * H }),
  p(2, 1, 'Code.exe', 'Code.exe --ext', 1700, { startedMs: T0 - 10 * H }),
  p(10, 2, 'claude.exe', 'claude.exe', 213, { startedMs: T0 - 5 * H, cpuMs: 60_000 }),
  p(11, 10, 'python.exe', 'python.exe -m graphify.serve', 3, { startedMs: T0 - 4 * H, cpuMs: 500 }),
  p(12, 11, 'python.exe', 'python.exe -m graphify.serve', 304, { startedMs: T0 - 4 * H, cpuMs: 900 }),
  p(13, 10, 'bash.exe', 'bash -c "npm test"', 4, { startedMs: T0 - 3 * H, cpuMs: 100 }),
  p(14, 10, 'bash.exe', 'bash -c "sleep 1"', 4, { startedMs: T0 - 3 * H, cpuMs: 100 }),
  p(15, 10, 'conhost.exe', 'conhost.exe', 6, { startedMs: T0 - 3 * H, cpuMs: 0 }),
  p(20, 2, 'claude.exe', 'claude.exe', 150, { startedMs: T0 - 2 * H }),
  p(21, 20, 'python.exe', 'python.exe -m graphify.serve', 300, { startedMs: T0 - 2 * H, cpuMs: 100 })
];

test('descendants: só a árvore do CLI, em largura, com profundidade', () => {
  const d = descendants(procs, 10);
  assert.deepEqual(d.map((n) => n.pid), [11, 13, 14, 15, 12]);
  assert.equal(d.find((n) => n.pid === 12)!.depth, 2);
  assert.deepEqual(descendants(procs, 99), []);
});

test('descendants: ciclo e PID reaproveitado não entram', () => {
  const cyc = [p(1, 2, 'a', 'a', 1), p(2, 1, 'b', 'b', 1)];
  assert.equal(descendants(cyc, 1).length, 1);
  const reused = [p(10, 1, 'claude', 'claude', 1, { startedMs: T0 }), p(30, 10, 'velho', 'velho', 1, { startedMs: T0 - H })];
  assert.deepEqual(descendants(reused, 10), []);
});

test('ancestorsOf: sobe até a raiz sem ciclo', () => {
  assert.deepEqual(ancestorsOf(procs, 12), [11, 10, 2, 1]);
  assert.deepEqual(ancestorsOf([p(1, 2, 'a', 'a', 1), p(2, 1, 'b', 'b', 1)], 1), [2, 1]);
});

// ---------- Regras ----------

test('classifyLevel e formatação', () => {
  const cfg = { highMb: 1500, criticalMb: 3000 };
  assert.equal(classifyLevel(1499 * MB, cfg), 'ok');
  assert.equal(classifyLevel(1500 * MB, cfg), 'alto');
  assert.equal(classifyLevel(3000 * MB, cfg), 'critico');
  assert.equal(fmtBytes(1.2 * 1024 * MB), '1,2 GB');
  assert.equal(fmtBytes(213 * MB), '213 MB');
  assert.equal(fmtDuration(2 * H), '2 h');
  assert.equal(fmtDuration(90 * 60_000), '1 h 30 min');
  assert.equal(fmtDuration(5 * 60_000), '5 min');
});

test('procKind', () => {
  assert.equal(procKind({ name: 'python.exe', cmd: 'python -m graphify.serve' }), 'mcp');
  assert.equal(procKind({ name: 'node.exe', cmd: 'node x.js' }), 'runtime');
  assert.equal(procKind({ name: 'bash.exe', cmd: 'bash' }), 'shell');
  assert.equal(procKind({ name: 'ffmpeg.exe', cmd: 'ffmpeg' }), 'media');
  assert.equal(procKind({ name: 'conhost.exe', cmd: '' }), 'console');
});

test('IdleTracker: CPU gasta zera o ocioso; sem CPU, acumula', () => {
  const t = new IdleTracker();
  const a = [p(5, 1, 'x', 'x', 50, { startedMs: T0 - H, cpuMs: 100_000 })];
  t.update(a, T0); // CPU média alta: não presume ocioso
  assert.equal(t.idleMs(5, T0), 0);
  t.update([{ ...a[0], cpuMs: 100_050 }], T0 + 120_000);
  assert.equal(t.idleMs(5, T0 + 120_000), 120_000);
  t.update([{ ...a[0], cpuMs: 105_000 }], T0 + 240_000);
  assert.equal(t.idleMs(5, T0 + 240_000), 0);
  assert.ok((t.cpuPct(5) ?? 0) > 3);
  t.update([], T0 + 300_000);
  assert.equal(t.idleMs(5, T0 + 300_000), 0);
});

test('IdleTracker: primeira amostra de processo quieto desde o início conta como ocioso desde o início', () => {
  const t = new IdleTracker();
  const d = descendants(procs, 10);
  t.update(d, T0);
  assert.equal(t.idleMs(12, T0), 4 * H);
});

test('findSuspects: MCP ocioso (só o topo), shells parados, conhost ignorado', () => {
  const t = new IdleTracker();
  const d = descendants(procs, 10);
  t.update(d, T0);
  const s = findSuspects(d, (pid) => t.idleMs(pid, T0), T0, DEFAULT_RESOURCE_CONFIG);
  const byPid = new Map(s.map((x) => [x.pid, x]));
  assert.ok(byPid.has(11) && !byPid.has(12), 'só o wrapper');
  assert.equal(byPid.get(11)!.reason, 'ocioso');
  assert.equal(byPid.get(11)!.risky, true);
  assert.equal(byPid.get(11)!.treeBytes, 307 * MB);
  assert.equal(byPid.get(13)!.reason, 'shell-parado');
  assert.ok(!byPid.has(15));
});

test('findSuspects: filho ativo impede o pai de ser ocioso; ociosidade curta não conta', () => {
  const d = descendants(procs, 10);
  const idle = (pid: number) => (pid === 12 ? 0 : 4 * H);
  assert.ok(!findSuspects(d, idle, T0, DEFAULT_RESOURCE_CONFIG).some((x) => x.pid === 11));
  assert.equal(findSuspects(d, () => 5 * 60_000, T0, DEFAULT_RESOURCE_CONFIG).length, 0);
});

test('findSuspects: servidor MCP duplicado, o mais velho é sugerido', () => {
  const both = [...descendants(procs, 10), ...descendants(procs, 20).map((n) => ({ ...n, depth: n.depth + 1 }))];
  const s = findSuspects(both, () => 0, T0, DEFAULT_RESOURCE_CONFIG);
  assert.equal(s.length, 1);
  assert.equal(s[0].pid, 11);
  assert.equal(s[0].reason, 'duplicado');
  assert.equal(s[0].risky, false);
});

test('buildChatReport e summaryText', () => {
  const t = new IdleTracker();
  const d = descendants(procs, 10);
  t.update(d, T0);
  const r = buildChatReport({ chatId: 'c1', cliPid: 10 }, { procs, at: T0 }, t, DEFAULT_RESOURCE_CONFIG);
  assert.equal(r.alive, true);
  assert.equal(r.cliBytes, 213 * MB);
  assert.equal(r.totalBytes, (213 + 3 + 304 + 4 + 4 + 6) * MB);
  assert.ok(r.top.some((x) => x.kind === 'cli'));
  assert.equal(r.top[0].pid, 12);
  const text = summaryText(r);
  assert.match(text, /CLI 213 MB; graphify\.serve 307 MB ocioso há 4 h; 2 shells parados/);
  assert.equal(buildChatReport({ chatId: 'x', cliPid: 999 }, { procs, at: T0 }, t, DEFAULT_RESOURCE_CONFIG).alive, false);
});

// ---------- Kill ----------

test('validateKillTarget: só descendente do CLI, nunca CLI, host ou VS Code', () => {
  const ok = (pid: number, exp?: { name?: string; startedMs?: number }) => validateKillTarget(procs, 10, pid, 2, exp);
  assert.equal(ok(12).ok, true);
  assert.equal(ok(10).ok, false, 'o CLI');
  assert.equal(ok(2).ok, false, 'o host');
  assert.equal(ok(1).ok, false, 'o VS Code');
  assert.equal(ok(21).ok, false, 'filho de outro chat');
  assert.equal(ok(999).ok, false, 'inexistente');
  assert.equal(ok(-3).ok, false);
  assert.equal(ok(12, { name: 'node.exe' }).ok, false, 'PID de outro dono');
  assert.equal(ok(12, { name: 'PYTHON.EXE', startedMs: T0 - 4 * H + 500 }).ok, true);
  assert.equal(ok(12, { startedMs: T0 }).ok, false, 'início diferente');
  assert.equal(validateKillTarget(procs, 77, 12, 2).ok, false, 'CLI morto');
  assert.equal(validateKillTarget(procs, undefined, 12, 2).ok, false);
});

// ---------- Config e nota ao modelo ----------

test('readResourceConfig: lê valores, cai no padrão quando inválidos', () => {
  const cfg = readResourceConfig(<T>(k: string, d: T) => ({ intervalMinutes: 5, highMb: 'x', criticalMb: -1, autoKillIdleMinutes: 0 } as Record<string, unknown>)[k] as T ?? d);
  assert.equal(cfg.intervalMinutes, 5);
  assert.equal(cfg.highMb, DEFAULT_RESOURCE_CONFIG.highMb);
  assert.equal(cfg.criticalMb, DEFAULT_RESOURCE_CONFIG.criticalMb);
  assert.equal(cfg.idleMinutes, DEFAULT_RESOURCE_CONFIG.idleMinutes);
  assert.equal(cfg.autoKillIdleMinutes, 0);
});

test('resourceNote: manda uma vez por mudança de estado', () => {
  const base = { chatId: 'main', alive: true, level: 'ok', totalBytes: 0, cliBytes: 0, childrenBytes: 0, top: [], suspects: [], at: 0 } as ChatResources;
  const sus = (pid: number) => ({ pid, reason: 'ocioso' }) as ChatResources['suspects'][number];
  assert.deepEqual(resourceNote(base, 's', undefined), { key: undefined }, 'ok sem suspeitos: nada');
  const alto = { ...base, level: 'alto' } as ChatResources;
  const a = resourceNote(alto, 's1', undefined);
  assert.equal(a.note, 's1');
  assert.equal(resourceNote(alto, 's2', a.key).note, undefined, 'mesmo estado: não repete');
  const b = resourceNote({ ...alto, suspects: [sus(7)] }, 's3', a.key);
  assert.equal(b.note, 's3', 'suspeito novo: manda');
  assert.equal(resourceNote({ ...alto, suspects: [sus(7)] }, 's4', b.key).note, undefined);
  const c = resourceNote(base, 's5', b.key);
  assert.equal(c.key, undefined, 'voltou a ok: zera');
  assert.equal(resourceNote(alto, 's6', c.key).note, 's6', 'problema novo depois: manda de novo');
  assert.equal(resourceNote({ ...alto, alive: false }, 's', undefined).note, undefined);
});

if (failed) {
  console.log(`\n${failed} teste(s) falharam`);
  process.exit(1);
}
console.log('\ntodos passaram');
