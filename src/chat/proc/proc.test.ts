/**
 * Testes do módulo de processos: parsers com fixture, árvore, órfãos, raiz de tarefa e a proteção do killTree.
 * Sem framework e sem VS Code. A última parte lê o sistema de verdade (PowerShell no Windows, ps no resto).
 *   npx esbuild src/chat/proc/proc.test.ts --bundle --platform=node --outfile=$TEMP/proc.test.js && node $TEMP/proc.test.js
 */
import * as assert from 'node:assert/strict';
import { findOrphans, findRootPid, findRootPids, mentionsDir, type RootHint } from './find';
import { killTree, killTrees, matchesSnap, snapOf, type KillIo } from './kill';
import { parseLsof, parseNetstat, parsePortsJson, parsePs, parseSs, parseWin32Json } from './parse';
import { listProcesses, listeningPorts, scanPorts, scanProcesses } from './system';
import { ancestors, ancestorsWhile, descendants, isCommandShell, isLauncher, isPackageRunner, protectedPids, treeOf, flatten } from './tree';
import type { ProcInfo } from './types';

let failed = 0;
let queue: Promise<void> = Promise.resolve();
function test(name: string, fn: () => void | Promise<void>): void {
  const report = (err?: unknown) => {
    if (err === undefined) {
      console.log(`ok   ${name}`);
      return;
    }
    failed++;
    console.log(`FAIL ${name}\n     ${err instanceof Error ? err.stack : String(err)}`);
  };
  let result: void | Promise<void>;
  try {
    result = fn();
  } catch (err) {
    report(err);
    return;
  }
  if (result instanceof Promise) {
    const pending = result;
    queue = queue.then(() => pending.then(() => report(), report));
  } else {
    report();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Fixture: a máquina do relato. O extension host (110) e o Code.exe (100) citam a pasta do projeto.
// ---------------------------------------------------------------------------------------------------------------------
const PROJ = 'C:\\Users\\u\\proj';
const WT = `${PROJ}\\.agm\\worktrees\\a1-foo`;
const WT2 = `${PROJ}\\.wt`;
const T0 = Date.UTC(2026, 8, 30, 10, 0, 0);
const at = (sec: number): Date => new Date(T0 + sec * 1000);
const P = (pid: number, ppid: number, name: string, commandLine: string, sec: number, cwd?: string): ProcInfo => ({ pid, ppid, name, commandLine, startedAt: at(sec), cwd });

function machine(): ProcInfo[] {
  return [
    P(4, 0, 'System', '', 0),
    P(90, 4, 'explorer.exe', 'C:\\Windows\\explorer.exe', 1),
    P(100, 90, 'Code.exe', `"C:\\Code\\Code.exe" ${PROJ}`, 10),
    P(110, 100, 'Code.exe', `"C:\\Code\\Code.exe" --type=utility --extensionDevelopmentPath=${PROJ}`, 11), // extension host
    P(111, 110, 'node.exe', `node tsserver.js --project ${PROJ}\\tsconfig.json`, 12),
    P(120, 110, 'node.exe', 'node claude-cli.js', 13), // CLI do Claude Code
    P(121, 120, 'bash.exe', 'bash -c run', 14), // shell da tarefa viva (possuída)
    P(122, 121, 'node.exe', `node C:\\npm\\npm-cli.js run dev --prefix ${WT}`, 15),
    P(123, 122, 'node.exe', `node ${WT}\\node_modules\\vite\\bin\\vite.js`, 16),
    // Árvore órfã do npm run start:dev: o pai (9999) morreu.
    P(200, 9999, 'node.exe', 'node C:\\npm\\node_modules\\npm\\bin\\npm-cli.js run start:dev', 20),
    P(201, 200, 'cmd.exe', 'C:\\Windows\\system32\\cmd.exe /d /s /c nest start --watch', 21),
    P(202, 201, 'node.exe', `node ${WT}\\node_modules\\@nestjs\\cli\\bin\\nest.js start --watch`, 22),
    P(203, 202, 'node.exe', `node ${WT}\\dist\\main`, 23),
    P(204, 202, 'esbuild.exe', 'esbuild.exe --service=0.19.0 --ping', 24),
    P(205, 201, 'conhost.exe', '\\??\\C:\\Windows\\system32\\conhost.exe 0x4', 25),
    // Start-Process: nenhum rastreio, pai morto.
    P(300, 8888, 'node.exe', `node ${WT2}\\node_modules\\vite\\bin\\vite.js`, 30),
    P(301, 300, 'esbuild.exe', 'esbuild.exe --service=0.19.0 --ping', 31),
    // Outro projeto e pasta de nome parecido: não entram.
    P(400, 9999, 'node.exe', 'node C:\\other\\server.js', 40),
    P(401, 9999, 'node.exe', `node ${WT}-other\\server.js`, 41),
    // PID reaproveitado: o "pai" 611 nasceu depois do filho, então 610 é raiz.
    P(610, 611, 'node.exe', `node ${WT}\\worker.js`, 50),
    P(611, 90, 'svchost.exe', 'svchost.exe -k x', 60),
    // Terminal interativo externo: o pai vivo de um servidor de teste.
    P(700, 90, 'powershell.exe', 'powershell.exe', 70),
    P(701, 700, 'node.exe', `node ${WT}\\scripts\\serve.js`, 71),
  ];
}

// ---------------------------------------------------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------------------------------------------------
test('parseWin32Json lê lista, objeto único, BOM, datas do PowerShell 5.1 e CommandLine nula', () => {
  const list = parseWin32Json(
    '\ufeff' +
      JSON.stringify([
        { ProcessId: 10, ParentProcessId: 4, Name: 'node.exe', CommandLine: 'node "a b"', Started: 1_700_000_000_000 },
        { ProcessId: 11, ParentProcessId: 10, Name: 'cmd.exe', CommandLine: null, Started: null },
        { ProcessId: 12, ParentProcessId: 10, Name: 'x.exe', CommandLine: 'x', CreationDate: '/Date(1700000001000)/' },
        { ProcessId: 13, ParentProcessId: 10, Name: 'y.exe', CommandLine: 'y', CreationDate: '20260930101500.000000-180' },
        { nada: true },
      ]),
  );
  assert.deepEqual(list.map((p) => p.pid), [10, 11, 12, 13]);
  assert.equal(list[0].commandLine, 'node "a b"');
  assert.equal(list[0].startedAt?.getTime(), 1_700_000_000_000);
  assert.equal(list[1].commandLine, '');
  assert.equal(list[1].startedAt, undefined);
  assert.equal(list[2].startedAt?.getTime(), 1_700_000_001_000);
  assert.equal(list[3].startedAt?.toISOString(), '2026-09-30T13:15:00.000Z');
  const one = parseWin32Json('{"ProcessId":5,"ParentProcessId":1,"Name":"a.exe","CommandLine":"a"}');
  assert.equal(one.length, 1);
  assert.deepEqual(parseWin32Json(''), []);
  assert.deepEqual(parseWin32Json('isto nao e json'), []);
});

test('parsePs lê pid, ppid, lstart, comm e args (com espaços e caminho no comm do macOS)', () => {
  const out = [
    '    1     0 Tue Sep 30 10:00:00 2026 systemd         /sbin/init splash',
    ' 2345  1200 Tue Sep 30 10:15:07 2026 node            node /home/u/proj/.wt/a/node_modules/.bin/vite --port 5173',
    '  777  2345 Wed Oct  1 08:05:09 2026 /usr/bin/bash   bash -c "npm run dev"',
    'linha quebrada',
  ].join('\n');
  const procs = parsePs(out);
  assert.equal(procs.length, 3);
  assert.deepEqual([procs[1].pid, procs[1].ppid, procs[1].name], [2345, 1200, 'node']);
  assert.equal(procs[1].commandLine, 'node /home/u/proj/.wt/a/node_modules/.bin/vite --port 5173');
  assert.equal(procs[1].startedAt?.getFullYear(), 2026);
  assert.equal(procs[1].startedAt?.getMonth(), 8);
  assert.equal(procs[1].startedAt?.getHours(), 10);
  assert.equal(procs[2].name, 'bash');
  assert.equal(procs[2].startedAt?.getDate(), 1);
});

test('parsers de portas: PowerShell JSON, netstat (qualquer idioma), lsof e ss', () => {
  const json = parsePortsJson('[{"LocalPort":3000,"OwningProcess":42},{"LocalPort":3000,"OwningProcess":42},{"LocalPort":9229,"OwningProcess":42},{"LocalPort":80,"OwningProcess":4}]');
  assert.deepEqual(json.get(42), [3000, 9229]);
  assert.deepEqual(json.get(4), [80]);
  assert.deepEqual(parsePortsJson('{"LocalPort":5173,"OwningProcess":7}').get(7), [5173]);
  assert.equal(parsePortsJson('').size, 0);

  const net = parseNetstat(
    [
      '  Proto  Endereço local          Endereço externo        Estado           PID',
      '  TCP    0.0.0.0:3000           0.0.0.0:0              OUVINDO         42',
      '  TCP    [::]:5173              [::]:0                 LISTENING       43',
      '  TCP    127.0.0.1:3000         127.0.0.1:51234        ESTABLISHED     42',
      '  UDP    0.0.0.0:5353           *:*                                    99',
    ].join('\r\n'),
  );
  assert.deepEqual(net.get(42), [3000]);
  assert.deepEqual(net.get(43), [5173]);
  assert.equal(net.has(99), false);

  const lsof = parseLsof(
    [
      'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
      'node    12345 u      23u  IPv4 0x1      0t0  TCP *:3000 (LISTEN)',
      'node    12345 u      24u  IPv6 0x2      0t0  TCP [::1]:9229 (LISTEN)',
      'node    12345 u      25u  IPv4 0x3      0t0  TCP 127.0.0.1:3000->127.0.0.1:50000 (ESTABLISHED)',
    ].join('\n'),
  );
  assert.deepEqual(lsof.get(12345), [3000, 9229]);

  const ss = parseSs(
    [
      'State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
      'LISTEN 0      511          0.0.0.0:3000      0.0.0.0:*     users:(("node",pid=555,fd=19))',
      'LISTEN 0      128             [::]:22           [::]:*     users:(("sshd",pid=10,fd=3),("sshd",pid=11,fd=3))',
      'ESTAB  0      0         127.0.0.1:3000  127.0.0.1:41000     users:(("node",pid=555,fd=20))',
    ].join('\n'),
  );
  assert.deepEqual(ss.get(555), [3000]);
  assert.deepEqual(ss.get(11), [22]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Árvore
// ---------------------------------------------------------------------------------------------------------------------
test('descendants e treeOf percorrem npm → cmd → node → esbuild', () => {
  const procs = machine();
  assert.deepEqual(descendants(200, procs).map((p) => p.pid).sort((a, b) => a - b), [201, 202, 203, 204, 205]);
  const tree = treeOf(200, procs)!;
  assert.equal(tree.proc.pid, 200);
  assert.deepEqual(tree.children.map((c) => c.proc.pid), [201]);
  assert.deepEqual(tree.children[0].children.map((c) => c.proc.pid).sort(), [202, 205]);
  assert.deepEqual(flatten(tree).map((p) => p.pid).sort((a, b) => a - b), [200, 201, 202, 203, 204, 205]);
  assert.equal(treeOf(123456, procs), undefined);
  assert.deepEqual(descendants(203, procs), []);
});

test('o pai iniciado depois do filho (PID reaproveitado) não é pai', () => {
  const procs = machine();
  assert.deepEqual(descendants(611, procs), []);
  assert.deepEqual(ancestors(610, procs), []);
});

test('descendants sobrevive a ciclos', () => {
  const procs = [P(1, 2, 'a', '', 1), P(2, 1, 'b', '', 1)];
  assert.deepEqual(descendants(1, procs).map((p) => p.pid), [2]);
  assert.deepEqual(ancestors(1, procs).map((p) => p.pid), [2]);
});

test('ancestorsWhile sobe do node pelos executores e para no primeiro que não é', () => {
  const procs = machine();
  assert.deepEqual(ancestorsWhile(203, procs, () => true).map((p) => p.pid), [202, 201, 200]);
  assert.deepEqual(ancestorsWhile(202, procs, isLauncher).map((p) => p.pid), [201, 200]);
  // Do vite vivo: npm (122) e o bash -c da tarefa (121) são lançadores; o CLI (120) é node puro e a subida para aí.
  assert.deepEqual(ancestorsWhile(123, procs, isLauncher).map((p) => p.pid), [122, 121]);
  assert.deepEqual(ancestorsWhile(200, procs, () => true), []);
});

test('predicados: executor de pacote e shell de comando', () => {
  const x = (name: string, commandLine: string): ProcInfo => P(1, 0, name, commandLine, 0);
  assert.ok(isPackageRunner(x('node.exe', 'node C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js run dev')));
  assert.ok(isPackageRunner(x('node.exe', 'node /usr/lib/node_modules/pnpm/bin/pnpm.cjs dev')));
  assert.ok(isPackageRunner(x('node.exe', 'yarn start')));
  assert.ok(!isPackageRunner(x('node.exe', 'node server.js --npmrc-not')));
  assert.ok(!isPackageRunner(x('node.exe', 'node C:\\proj\\dist\\main.js')));
  assert.ok(isCommandShell(x('cmd.exe', 'cmd.exe /d /s /c nest start')));
  assert.ok(isCommandShell(x('bash', 'bash -c "npm run dev"')));
  assert.ok(!isCommandShell(x('powershell.exe', 'powershell.exe')));
  assert.ok(!isCommandShell(x('bash', '/bin/bash')));
});

// ---------------------------------------------------------------------------------------------------------------------
// Pastas
// ---------------------------------------------------------------------------------------------------------------------
test('mentionsDir respeita os limites da pasta, barras e maiúsculas', () => {
  assert.ok(mentionsDir(`node ${WT}\\x.js`, WT, true));
  assert.ok(mentionsDir(`node "c:/users/u/PROJ/.agm/worktrees/a1-foo/x.js"`, WT, true));
  assert.ok(mentionsDir(`{"p":"C:\\\\Users\\\\u\\\\proj\\\\.agm\\\\worktrees\\\\a1-foo\\\\x.js"}`, WT, true));
  assert.ok(mentionsDir(WT, WT + '\\', true));
  assert.ok(!mentionsDir(`node ${WT}-other\\x.js`, WT, true));
  assert.ok(!mentionsDir(`node ${WT}0\\x.js`, WT, true));
  assert.ok(!mentionsDir('node /x/app/y.js', '/app', false));
  assert.ok(!mentionsDir('node /Home/U/Proj/x.js', '/home/u/proj', false));
  assert.ok(mentionsDir('node /home/u/proj/x.js', '/home/u/proj', false));
  assert.ok(!mentionsDir('qualquer coisa', '', true));
});

// ---------------------------------------------------------------------------------------------------------------------
// Órfãos
// ---------------------------------------------------------------------------------------------------------------------
const pids = (l: ProcInfo[]): number[] => l.map((p) => p.pid).sort((a, b) => a - b);

test('findOrphans agrupa a árvore npm/cmd/node/esbuild/conhost e o vite do Start-Process, sem tocar no editor', () => {
  const groups = findOrphans(machine(), { roots: [WT, WT2], ownedPids: new Set([121]), excludeAncestorsOf: 110, caseInsensitive: true });
  const byRoot = new Map(groups.map((g) => [g.root.pid, g]));
  // 200 (npm) entra por ser o executor que lançou o 202, e leva cmd, node, esbuild e conhost junto.
  assert.deepEqual(pids(byRoot.get(200)!.members), [200, 201, 202, 203, 204, 205]);
  assert.deepEqual(byRoot.get(200)!.matchedPids.sort(), [202, 203]);
  assert.equal(byRoot.get(200)!.parentAlive, false);
  assert.deepEqual(pids(byRoot.get(300)!.members), [300, 301]);
  assert.deepEqual([...byRoot.keys()].sort((a, b) => a - b), [200, 300, 610, 701]);
  const all = new Set(groups.flatMap((g) => g.members.map((m) => m.pid)));
  for (const never of [90, 100, 110, 111, 120, 121, 122, 123, 400, 401, 4]) {
    assert.ok(!all.has(never), `${never} não pode ser órfão`);
  }
  // O servidor do terminal externo tem pai vivo (700): é candidato, mas o grupo avisa.
  assert.equal(byRoot.get(701)!.parentAlive, true);
  assert.equal(byRoot.get(610)!.parentAlive, false);
});

test('findOrphans com a raiz do projeto como pasta ainda exclui Code.exe, extension host e language server', () => {
  const groups = findOrphans(machine(), { roots: [PROJ], ownedPids: [121], excludeAncestorsOf: 110, caseInsensitive: true });
  const all = new Set(groups.flatMap((g) => g.members.map((m) => m.pid)));
  for (const never of [100, 110, 111, 120, 121, 122, 123]) {
    assert.ok(!all.has(never), `${never} é do VS Code ou está possuído`);
  }
  assert.ok(all.has(203) && all.has(300));
});

test('findOrphans exclui o host e sua árvore mesmo quando nenhum nome lembra o editor', () => {
  const procs = machine().map((p) => (p.name === 'Code.exe' ? { ...p, name: 'electron-host.exe' } : p));
  const groups = findOrphans(procs, { roots: [PROJ], ownedPids: [], excludeAncestorsOf: 110, caseInsensitive: true });
  const all = new Set(groups.flatMap((g) => g.members.map((m) => m.pid)));
  for (const never of [100, 110, 111, 120, 121, 122, 123]) {
    assert.ok(!all.has(never), `${never} é ancestral do host ou desce dele`);
  }
});

test('findOrphans: possuídos com descendentes, portas e lista vazia', () => {
  const ports = new Map([[203, [3000]], [202, [9229]], [301, [5173]]]);
  const groups = findOrphans(machine(), { roots: [WT, WT2], ownedPids: new Set([200]), excludeAncestorsOf: 110, ports, caseInsensitive: true });
  const all = new Set(groups.flatMap((g) => g.members.map((m) => m.pid)));
  assert.ok(![200, 201, 202, 203, 204, 205].some((p) => all.has(p)), 'a árvore possuída inteira fica de fora');
  assert.deepEqual(groups.find((g) => g.root.pid === 300)!.ports, [5173]);
  const g200 = findOrphans(machine(), { roots: [WT], ownedPids: [], excludeAncestorsOf: 110, ports, caseInsensitive: true }).find((g) => g.root.pid === 200)!;
  assert.deepEqual(g200.ports, [3000, 9229]);
  assert.deepEqual(findOrphans([], { roots: [WT], ownedPids: [], excludeAncestorsOf: 110 }), []);
  assert.deepEqual(findOrphans(machine(), { roots: [], ownedPids: [], excludeAncestorsOf: 110 }), []);
  assert.deepEqual(findOrphans(machine(), { roots: ['C:\\nada\\aqui'], ownedPids: [], excludeAncestorsOf: 110, caseInsensitive: true }), []);
});

test('findOrphans casa pelo cwd no Linux (sem caminho na linha de comando)', () => {
  const procs = [
    P(10, 1, 'code', '/usr/share/code/code', 1),
    P(11, 10, 'node', 'node ext-host', 2, '/home/u/proj'),
    P(20, 99, 'node', 'node server.js', 3, '/home/u/proj/.agm/worktrees/a1'),
    P(21, 20, 'esbuild', 'esbuild --service', 4, '/home/u/proj/.agm/worktrees/a1'),
    P(30, 99, 'node', 'node outro.js', 5, '/home/u/proj/.agm/worktrees/a10'),
  ];
  const groups = findOrphans(procs, { roots: ['/home/u/proj/.agm/worktrees/a1'], ownedPids: [], excludeAncestorsOf: 11, caseInsensitive: false });
  assert.deepEqual(groups.map((g) => [g.root.pid, pids(g.members)]), [[20, [20, 21]]]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Raiz da tarefa
// ---------------------------------------------------------------------------------------------------------------------
test('findRootPid acha a raiz da tarefa pelo comando, pela pasta e pelo pai, e sobe até o npm com climb', () => {
  const procs = machine();
  // 'nest.js' só aparece na linha do 202; o 203 (dist\main) e o cmd (201) não casam.
  assert.equal(findRootPid(procs, { commandIncludes: 'nest.js', selfPid: 110 }), 202);
  assert.equal(findRootPid(procs, { commandIncludes: 'nest.js', climb: true, selfPid: 110 }), 200);
  assert.equal(findRootPid(procs, { cwd: WT2, selfPid: 110 }), 300);
  assert.equal(findRootPid(procs, { commandIncludes: 'vite', parentPid: 120, selfPid: 110 }), 123);
  // climb sobe pelo npm (122) até o bash -c da tarefa (121) e para no CLI (120), que é node sem ser executor.
  assert.equal(findRootPid(procs, { commandIncludes: 'vite', parentPid: 120, climb: true, selfPid: 110 }), 121);
  // Com o shell da tarefa como parentPid, a subida para nele.
  assert.equal(findRootPid(procs, { commandIncludes: 'vite', parentPid: 121, climb: true, selfPid: 110 }), 122);
  assert.equal(findRootPid(procs, { commandIncludes: 'nada-disso', selfPid: 110 }), undefined);
  assert.equal(findRootPid(procs, { selfPid: 110 }), undefined);
});

test('findRootPid com startedAfter prefere o mais perto do marco; sem janela, o mais recente', () => {
  const procs = machine();
  assert.equal(findRootPid(procs, { commandIncludes: 'vite', startedAfter: at(20), selfPid: 110 }), 300);
  assert.deepEqual(findRootPids(procs, { commandIncludes: 'vite', selfPid: 110 }), [300, 123]);
  assert.deepEqual(findRootPids(procs, { commandIncludes: 'vite', startedAfter: at(0), selfPid: 110 }), [123, 300]);
});

test('findRootPid: dois servidores de mesmo comando 400 ms um do outro, com janela fechada e sem recuo', () => {
  const t = (ms: number): Date => new Date(T0 + 100_000 + ms);
  const procs = [
    ...machine(),
    { ...P(800, 120, 'node.exe', 'node server.js --port 3000', 0), startedAt: t(0) },
    { ...P(801, 120, 'node.exe', 'node server.js --port 3000', 0), startedAt: t(400) },
  ];
  const q = (hint: Partial<RootHint>): number[] => findRootPids(procs, { commandIncludes: 'server.js --port', selfPid: 110, ...hint });
  assert.deepEqual(q({}), [801, 800], 'sem janela: o mais recente primeiro');
  assert.deepEqual(q({ startedAfter: t(-100) }), [800, 801], 'o mais perto do marco, não o mais recente');
  assert.deepEqual(q({ startedAfter: t(300) }), [801], '800 nasceu antes do marco');
  assert.deepEqual(q({ startedAfter: t(-100), startedBefore: t(200) }), [800], 'janela fechada');
  assert.deepEqual(q({ startedAfter: t(450), startedBefore: t(900) }), [], 'nada na janela: vazio, nunca o mais recente');
  assert.equal(findRootPid(procs, { commandIncludes: 'server.js --port', startedBefore: t(-50), selfPid: 110 }), undefined);
  assert.deepEqual(q({ startedNear: t(380), windowMs: 100 }), [801]);
  assert.deepEqual(q({ startedNear: t(100), windowMs: 1000 }), [800, 801]);
  assert.deepEqual(q({ startedNear: t(300), windowMs: 1000 }), [801, 800]);
  assert.deepEqual(q({ startedNear: t(20_000), windowMs: 100 }), []);
  assert.deepEqual(q({ startedNear: t(0) }), [800, 801], 'windowMs padrão é 5 s');
  // Sem hora de início o processo não casa com janela nenhuma.
  const noTime = [{ ...P(802, 120, 'node.exe', 'node server.js --port 3000', 0), startedAt: undefined }];
  assert.deepEqual(findRootPids(noTime, { commandIncludes: 'server.js', startedNear: t(0), selfPid: 110 }), []);
  // A ordem usa a hora do processo que casou, não a do executor acima dele (climb).
  const wrapped = [
    P(900, 9999, 'node.exe', 'node C:\\npm\\npm-cli.js run dev', 1),
    { ...P(901, 900, 'node.exe', 'node vite.js', 0), startedAt: t(0) },
    { ...P(902, 9999, 'cmd.exe', 'cmd /c vite2', 0), startedAt: t(300) },
    { ...P(903, 902, 'node.exe', 'node vite.js', 0), startedAt: t(310) },
  ];
  assert.deepEqual(findRootPids(wrapped, { commandIncludes: 'vite.js', startedNear: t(320), climb: true, selfPid: 110 }), [902, 900]);
});

test('findRootPid nunca devolve o host, seus ancestrais nem o editor, e climb não passa por shell interativo', () => {
  const procs = machine();
  assert.equal(findRootPid(procs, { commandIncludes: 'extensionDevelopmentPath', selfPid: 110 }), undefined);
  assert.equal(findRootPid(procs, { cwd: PROJ, commandIncludes: 'Code.exe', selfPid: 110 }), undefined);
  // 701 tem o powershell interativo (700) como pai: climb não sobe por ele.
  assert.equal(findRootPid(procs, { commandIncludes: 'serve.js', climb: true, selfPid: 110 }), 701);
});

test('protectedPids inclui o processo e todos os ancestrais', () => {
  assert.deepEqual([...protectedPids(machine(), 123)].sort((a, b) => a - b), [4, 90, 100, 110, 120, 121, 122, 123]);
});

// ---------------------------------------------------------------------------------------------------------------------
// killTree
// ---------------------------------------------------------------------------------------------------------------------
function fakeIo(platform: NodeJS.Platform, selfPid: number, opts: { stubborn?: number[]; deaf?: number[]; list?: () => ProcInfo[]; procs?: ProcInfo[] } = {}) {
  let live = opts.procs ?? machine();
  const attempts = new Map<number, number>();
  const log: string[] = [];
  const dead = (pid: number) => {
    live = live.filter((p) => p.pid !== pid);
  };
  const io: Partial<KillIo> = {
    platform,
    selfPid,
    listProcs: async () => (opts.list ? opts.list() : live.map((p) => ({ ...p }))),
    signal: (pid, sig) => {
      log.push(`${sig}:${pid}`);
      if (!live.some((p) => p.pid === pid)) {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      }
      if (sig === 'SIGKILL' || !opts.stubborn?.includes(pid)) {
        dead(pid);
      }
    },
    isAlive: (pid) => live.some((p) => p.pid === pid),
    taskkill: async (args) => {
      log.push(`taskkill ${args.join(' ')}`);
      const target = Number(args[args.length - 1]);
      const n = (attempts.get(target) ?? 0) + 1;
      attempts.set(target, n);
      if (opts.deaf?.includes(target)) {
        return { code: 1, stderr: 'Acesso negado' };
      }
      // O teimoso ignora a primeira tentativa e cai na segunda.
      if (!(opts.stubborn?.includes(target) && n === 1)) {
        dead(target);
      }
      return { code: 0, stderr: '' };
    },
    sleep: () => new Promise((r) => setTimeout(r, 1)),
  };
  return { io, log, alive: () => live.map((p) => p.pid) };
}

test('killTree recusa o extension host, seus ancestrais, PIDs de sistema e PIDs inválidos, sem tocar em nada', async () => {
  for (const platform of ['win32', 'linux'] as const) {
    const f = fakeIo(platform, 110);
    for (const pid of [110, 100, 90, 4, 0, -1, 1.5]) {
      const r = await killTree(pid, { io: f.io, graceMs: 5 });
      assert.ok(r.refused, `${platform}: ${pid} devia ser recusado`);
      assert.deepEqual(r.killed, []);
    }
    assert.deepEqual(f.log, [], `${platform}: nenhum sinal nem taskkill`);
  }
});

test('killTree recusa quando a lista de processos não veio (não dá para provar que é seguro)', async () => {
  const f = fakeIo('win32', 110, { list: () => [] });
  const r = await killTree(200, { io: f.io });
  assert.ok(r.refused);
  assert.deepEqual(f.log, []);
});

test('killTree no Windows: um taskkill /F por vítima, sem /T, pai antes dos filhos, e devolve os mortos', async () => {
  const f = fakeIo('win32', 110);
  const r = await killTree(200, { io: f.io });
  assert.deepEqual(r.killed.sort((a, b) => a - b), [200, 201, 202, 203, 204, 205]);
  assert.deepEqual(r.failed, []);
  assert.ok(f.log.every((l) => /^taskkill \/F \/PID \d+$/.test(l)), `nenhum /T: ${f.log.join(' | ')}`);
  const order = f.log.map((l) => Number(l.split(' ').pop()));
  assert.equal(order[0], 200);
  assert.ok(order.indexOf(201) < order.indexOf(202) && order.indexOf(202) < order.indexOf(203), 'pai antes do filho');
  assert.ok(f.alive().includes(110) && f.alive().includes(300), 'o resto da máquina continua');
});

test('killTree no Windows: o /T não é usado nem quando o ppid aponta para PID reaproveitado', async () => {
  // 610 tem ppid 611 (nasceu depois dele): 611 não é pai e não pode morrer junto.
  const f = fakeIo('win32', 110);
  const r = await killTree(610, { io: f.io });
  assert.deepEqual(r.killed, [610]);
  assert.deepEqual(f.log, ['taskkill /F /PID 610']);
  assert.ok(f.alive().includes(611));
});

test('killTree no Windows: teimoso cai na segunda tentativa, e o que recusa sempre vira falha', async () => {
  const f = fakeIo('win32', 110, { stubborn: [203] });
  const r = await killTree(200, { io: f.io });
  assert.equal(f.log.filter((l) => l === 'taskkill /F /PID 203').length, 2);
  assert.deepEqual(r.failed, []);
  assert.ok(r.killed.includes(203));
  const g = fakeIo('win32', 110, { deaf: [203] });
  const r2 = await killTree(200, { io: g.io });
  assert.deepEqual(r2.failed.map((x) => x.pid), [203]);
  assert.match(r2.failed[0].error, /Acesso negado/);
  assert.ok(!r2.killed.includes(203) && r2.killed.includes(202));
});

test('killTree com foto: raiz com PID reaproveitado é recusada; descendente fora da foto fica vivo', async () => {
  for (const platform of ['win32', 'linux'] as const) {
    const base = machine();
    // Foto tirada quando a tarefa foi vista: 200, 201 e 202 (o 203, 204 e 205 nasceram depois).
    const snap = snapOf(base.filter((p) => [200, 201, 202].includes(p.pid)));
    const f = fakeIo(platform, 110);
    const r = await killTree(200, { io: f.io, graceMs: 5, snapshot: snap });
    assert.deepEqual(r.killed.sort(), [200, 201, 202], platform);
    assert.deepEqual(r.skipped?.sort(), [203, 204, 205], platform);
    assert.ok(f.alive().includes(203) && f.alive().includes(205));

    // PID reaproveitado: outro processo com o PID da foto (nome e início diferentes).
    const reused = machine().map((p) => (p.pid === 200 ? { ...p, name: 'chrome.exe', startedAt: at(500) } : p));
    const g = fakeIo(platform, 110, { procs: reused });
    const r2 = await killTree(200, { io: g.io, graceMs: 5, snapshot: snap });
    assert.ok(r2.refused && /reaproveitado/.test(r2.refused));
    assert.deepEqual(g.log, []);
  }
  const b0 = machine()[0];
  assert.equal(matchesSnap({ ...b0, pid: 200, name: 'node.exe', startedAt: at(22) }, { pid: 200, name: 'NODE.EXE', startedAt: at(20) }), false);
  assert.equal(matchesSnap({ ...b0, pid: 200, name: 'node.exe', startedAt: at(20.5) }, { pid: 200, name: 'NODE.EXE', startedAt: at(20) }), true);
});

test('killTree no POSIX: SIGTERM nos filhos primeiro, SIGKILL no teimoso, nunca fora da árvore', async () => {
  const f = fakeIo('linux', 110, { stubborn: [202] });
  const r = await killTree(200, { io: f.io, graceMs: 20 });
  assert.deepEqual(r.killed.sort((a, b) => a - b), [200, 201, 202, 203, 204, 205]);
  assert.deepEqual(r.failed, []);
  const term = f.log.filter((l) => l.startsWith('SIGTERM')).map((l) => Number(l.split(':')[1]));
  assert.equal(term[term.length - 1], 200, 'a raiz é a última');
  assert.ok(term.indexOf(203) < term.indexOf(202) && term.indexOf(202) < term.indexOf(201), 'filho antes do pai');
  assert.deepEqual(f.log.filter((l) => l.startsWith('SIGKILL')), ['SIGKILL:202']);
  const touched = new Set(f.log.map((l) => Number(l.split(/[: ]/).pop())));
  for (const safe of [90, 100, 110, 111, 120, 121, 300, 400]) {
    assert.ok(!touched.has(safe), `${safe} não pode ser tocado`);
  }
});

test('killTree: PID inexistente é "gone" e falha de permissão vira failed', async () => {
  const f = fakeIo('linux', 110);
  const gone = await killTree(54321, { io: f.io });
  assert.equal(gone.gone, true);
  const f2 = fakeIo('linux', 110);
  f2.io.signal = () => {
    throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  };
  const r = await killTree(300, { io: f2.io, graceMs: 10 });
  assert.deepEqual(r.killed, []);
  assert.deepEqual(r.failed.map((x) => x.pid).sort(), [300, 301]);
  assert.match(r.failed[0].error, /not permitted/);
});

test('killTrees passa cada raiz pela mesma proteção', async () => {
  const f = fakeIo('win32', 110);
  const r = await killTrees([300, 110, 100], { io: f.io });
  assert.deepEqual(r.killed.sort(), [300, 301]);
  assert.ok(r.refused && /ancestral/.test(r.refused));
  assert.ok(f.alive().includes(110) && f.alive().includes(100));
});

// ---------------------------------------------------------------------------------------------------------------------
// Sistema de verdade
// ---------------------------------------------------------------------------------------------------------------------
test('scanProcesses e scanPorts leem esta máquina', async () => {
  const p = await scanProcesses();
  assert.equal(p.error, undefined, p.error);
  assert.ok(p.value.length > 10, `só ${p.value.length} processos`);
  const me = p.value.find((x) => x.pid === process.pid);
  assert.ok(me, 'o próprio processo aparece');
  assert.ok(/node/i.test(me!.name), `nome ${me!.name}`);
  assert.ok(me!.commandLine.length > 0);
  assert.ok(me!.startedAt instanceof Date);
  assert.ok(ancestors(process.pid, p.value).length > 0, 'a cadeia de pais do teste existe');
  assert.ok(protectedPids(p.value).has(process.ppid));

  // Um servidor de verdade: a porta tem de aparecer no PID do teste.
  const net = await import('node:net');
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  const q = await scanPorts();
  srv.close();
  assert.equal(q.error, undefined, q.error);
  assert.ok(q.value.get(process.pid)?.includes(port), `porta ${port} não apareceu para o PID ${process.pid}`);
  console.log(`     (${p.value.length} processos em ${p.ms} ms; ${q.value.size} PIDs com porta em ${q.ms} ms)`);
  // As funções simples devolvem o mesmo tipo e nunca lançam.
  assert.ok(Array.isArray(await listProcesses()));
  assert.ok((await listeningPorts()) instanceof Map);
});

test('killTree de verdade: mata um servidor filho e o filho dele, e recusa o próprio processo', async () => {
  const { spawn } = await import('node:child_process');
  // Pai node que sobe um neto node; ambos ficam dormindo.
  const child = spawn(process.execPath, ['-e', "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000)"], { stdio: 'ignore', windowsHide: true });
  try {
    // No Windows o neto vem com um conhost junto (o mesmo do relato), então o que vale é achar o node neto.
    let tree: ProcInfo[] = [];
    for (let i = 0; i < 30 && !tree.some((p) => /^node/i.test(p.name)); i++) {
      await new Promise((r) => setTimeout(r, 300));
      tree = descendants(child.pid!, await listProcesses());
    }
    assert.ok(tree.some((p) => /^node/i.test(p.name)), 'o neto apareceu');
    const self = await killTree(process.pid);
    assert.ok(self.refused);
    const r = await killTree(child.pid!);
    assert.deepEqual(r.failed, []);
    for (const p of [child.pid!, ...tree.map((t) => t.pid)]) {
      assert.ok(r.killed.includes(p), `${p} devia estar entre os mortos ${r.killed}`);
    }
    const after = await listProcesses();
    assert.ok(!after.some((p) => p.pid === child.pid || tree.some((t) => t.pid === p.pid)));
  } finally {
    child.kill('SIGKILL');
  }
});

void queue.then(() => {
  if (failed) {
    console.log(`\n${failed} teste(s) falharam`);
    process.exit(1);
  }
  console.log('\ntodos os testes de processos passaram');
});
