/**
 * Testes da estimativa dos processos em segundo plano (progresso pela saída, assinatura do comando, mediana). Sem VS Code:
 *   npx esbuild src/chat/bgEta.test.ts --bundle --platform=node --outfile=$TEMP/bgEta.test.js && node $TEMP/bgEta.test.js
 */
import * as assert from 'node:assert/strict';
import { KEEP_RUNS, commandSignature, estimate, etaSource, etaView, fmtLeft, leadingCd, median, parseProgress, recordDuration, redirectTarget, resolveShellPath } from './bgEta';

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

const near = (a: number | undefined, b: number) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-9, `${a} != ${b}`);

// ---------- Progresso pela saída ----------

test('vitest: Test Files com passed e failed sobre o total', () => {
  const p = parseProgress(' RUN  v2.1.0 /repo\n ✓ src/a.test.ts (3)\n Test Files  3 passed | 1 failed (12)\n      Tests  40 passed (120)\n');
  // A última linha com progresso vence: a de testes.
  near(p?.fraction, 40 / 120);
  assert.equal(p?.label, '40 de 120 testes');
});

test('vitest: só a linha de arquivos', () => {
  const p = parseProgress('\u001b[2m Test Files \u001b[22m \u001b[32m3 passed\u001b[39m | 1 skipped (12)');
  near(p?.fraction, 4 / 12);
  assert.equal(p?.label, '4 de 12 arquivos de teste');
});

test('jest: Tests com failed, passed e total', () => {
  const p = parseProgress('Test Suites: 1 failed, 2 passed, 3 total\nTests:       1 failed, 12 passed, 40 total\n');
  near(p?.fraction, 13 / 40);
});

test('N passed, M remaining', () => {
  near(parseProgress('12 passed, 3 remaining')?.fraction, 12 / 15);
});

test('pytest: porcentagem entre colchetes no fim da linha', () => {
  const p = parseProgress('tests/test_a.py ....F...                     [ 45%]\ntests/test_b.py ..');
  near(p?.fraction, 0.45);
  assert.equal(p?.label, '45%');
});

test('[N/M] e N/M soltos', () => {
  near(parseProgress('[3/8] Compiling foo')?.fraction, 3 / 8);
  near(parseProgress('step 7/10 done')?.fraction, 0.7);
  near(parseProgress('Downloading 12 of 48')?.fraction, 0.25);
});

test('pip: tamanho baixado sobre o total', () => {
  near(parseProgress('   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 45.0/100.0 MB 5.0 MB/s eta 0:00:11')?.fraction, 0.45);
});

test('porcentagem solta e a última da linha', () => {
  near(parseProgress('Receiving objects:  10% (1/10)\rReceiving objects:  63% (63/100)')?.fraction, 0.63);
  near(parseProgress('build 72.5 %')?.fraction, 0.725);
});

test('barra desenhada sem número', () => {
  near(parseProgress('[######....]')?.fraction, 0.6);
});

test('data e caminho não viram N/M', () => {
  assert.equal(parseProgress('2026/10/11 iniciado'), undefined);
  assert.equal(parseProgress('lendo src/12/40/x.ts'), undefined);
  assert.equal(parseProgress('rodou em 10/11/2026'), undefined);
});

test('sem progresso reconhecível: nada, nunca uma porcentagem inventada', () => {
  assert.equal(parseProgress(''), undefined);
  assert.equal(parseProgress('Verificando fuso UTC...\nok: api/src/x.ts\n'), undefined);
  assert.equal(parseProgress('300% de cpu'), undefined);
});

test('N maior que M não conta', () => {
  assert.equal(parseProgress('[9/3] x'), undefined);
});

// ---------- Assinatura do comando ----------

test('assinatura ignora redirecionamento, /tmp e cd do começo', () => {
  const a = commandSignature('cd "C:/x/.agm/worktrees/a19-fuso" && bash .github/scripts/gate-fuso-utc.sh origin/dev HEAD > /tmp/a19-fuso-api.txt 2>&1');
  const b = commandSignature('bash .github/scripts/gate-fuso-utc.sh origin/dev HEAD > /tmp/a23-fuso.txt 2>&1');
  assert.equal(a, b);
  assert.equal(a, 'bash .github/scripts/gate-fuso-utc.sh origin/dev HEAD');
});

test('assinatura troca hash, uuid, temp do Windows e números longos', () => {
  assert.equal(commandSignature('git diff 3612f8c0 HEAD'), 'git diff <hash> HEAD');
  assert.equal(commandSignature('node x.js --run 5221d7bb-1a3b-4cd4-b0f7-180b05271aeb'), 'node x.js --run <id>');
  assert.equal(commandSignature('node C:\\Users\\ivang\\AppData\\Local\\Temp\\t1.js'), 'node <tmp>');
  assert.equal(commandSignature('python run.py --seed 123456'), 'python run.py --seed <n>');
  assert.equal(commandSignature('npm test | tee out.log'), 'npm test');
});

test('comandos diferentes continuam diferentes', () => {
  assert.notEqual(commandSignature('npm test'), commandSignature('npm run build'));
  assert.equal(commandSignature('npx vitest run'), 'npx vitest run');
});

// ---------- Histórico ----------

test('mediana com quantidade par e ímpar', () => {
  assert.equal(median([]), undefined);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('recordDuration guarda as últimas e ignora as curtas', () => {
  let book = {};
  for (let i = 1; i <= KEEP_RUNS + 2; i++) {
    book = recordDuration(book, 'npm test', i * 60000, i);
  }
  assert.deepEqual((book as Record<string, { ms: number[] }>)['npm test'].ms, [3, 4, 5, 6, 7].map((i) => i * 60000));
  assert.deepEqual(recordDuration({}, 'x', 1200), {});
});

// ---------- Estimativa e o que a barra mostra ----------

test('a saída manda sobre o histórico', () => {
  assert.equal(estimate({ fraction: 0.5, label: '50%' }, [60000])?.source, 'output');
  const h = estimate(undefined, [600000, 780000, 900000]);
  assert.equal(h?.source, 'history');
  assert.equal(h?.expectedMs, 780000);
  assert.equal(h?.runs, 3);
});

test('sem saída nem histórico: sem estimativa e barra indeterminada', () => {
  assert.equal(estimate(undefined, undefined), undefined);
  assert.equal(estimate(undefined, []), undefined);
  assert.deepEqual(etaView(undefined, 30000), { over: false });
  assert.match(etaSource(undefined), /Sem estimativa/);
});

test('histórico: fração, quanto falta e passou da média', () => {
  const est = estimate(undefined, [600000])!;
  const v = etaView(est, 360000);
  near(v.fraction, 0.6);
  assert.equal(v.leftMs, 240000);
  assert.equal(fmtLeft(v.leftMs!), 'falta ~4 min');
  assert.deepEqual(etaView(est, 700000), { fraction: 1, over: true });
  assert.match(etaSource(est), /última execução/);
});

test('saída: falta pelo ritmo, só depois de 5% e de 10 s', () => {
  const est = estimate({ fraction: 0.25, label: '25%' }, undefined)!;
  assert.equal(etaView(est, 60000).leftMs, 180000);
  assert.equal(etaView(est, 5000).leftMs, undefined);
  assert.equal(etaView(estimate({ fraction: 0.02, label: '2%' }, undefined), 60000).leftMs, undefined);
});

test('fmtLeft em segundos, minutos e horas', () => {
  assert.equal(fmtLeft(12000), 'falta ~10 s');
  assert.equal(fmtLeft(90000), 'falta ~2 min');
  assert.equal(fmtLeft(4500000), 'falta ~1h 15min');
});

// ---------- Onde ler a saída ----------

test('redirectTarget acha > arquivo, >> e tee; ignora 2> e /dev/null', () => {
  assert.equal(redirectTarget('bash gate.sh origin/dev HEAD > /tmp/a19-fuso-api.txt 2>&1'), '/tmp/a19-fuso-api.txt');
  assert.equal(redirectTarget('npm test >> "out dir/log.txt"'), 'out dir/log.txt');
  assert.equal(redirectTarget('npm test 2>&1 | tee run.log'), 'run.log');
  assert.equal(redirectTarget('npm test 2> err.txt'), undefined);
  assert.equal(redirectTarget('npm test > /dev/null'), undefined);
  assert.equal(redirectTarget('npm test'), undefined);
});

test('resolveShellPath: /tmp, /c/, ~, relativo e cd do começo', () => {
  const env = { cwd: 'C:/proj', tmp: 'C:\\Users\\u\\AppData\\Local\\Temp', home: 'C:/Users/u', win: true };
  assert.equal(resolveShellPath('/tmp/a.txt', env), 'C:\\Users\\u\\AppData\\Local\\Temp/a.txt');
  assert.equal(resolveShellPath('/c/x/y.txt', env), 'C:/x/y.txt');
  assert.equal(resolveShellPath('~/log.txt', env), 'C:/Users/u/log.txt');
  assert.equal(resolveShellPath('out/log.txt', env), 'C:/proj/out/log.txt');
  assert.equal(resolveShellPath('/var/log/x', { ...env, win: false }), '/var/log/x');
  assert.equal(leadingCd('cd "C:/a b" && npm test > x'), 'C:/a b');
  assert.equal(leadingCd('npm test'), undefined);
});

if (failed) {
  console.log(`\n${failed} teste(s) falharam`);
  process.exit(1);
}
console.log('\ntodos passaram');
