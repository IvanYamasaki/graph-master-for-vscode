/**
 * Testes do veredito, do quadro e do aviso de proveniência. Sem framework e sem VS Code. O SDK entra no bundle (tools.ts)
 * e usa import.meta.url, então o esbuild precisa do mesmo define do esbuild.mjs:
 *   npx esbuild src/chat/lab/lab.test.ts --bundle --platform=node --outfile=$TEMP/lab.test.js --define:import.meta.url=importMetaUrl
 *     "--banner:js=const importMetaUrl = require('url').pathToFileURL(__filename).href;" && node $TEMP/lab.test.js
 */
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resetLockboxCacheForTest } from '../guard/lockbox';
import { evaluate, pairedHint, readyToDeclare } from './evaluate';
import { LabIntegrity } from './integrity';
import { parsePredictions, rowsMetric } from './paired';
import { citedNumbers, fileNumbers, textNumbers, unregistered } from './provenance';
import { mean, rng, signFlipP, tInv } from './stats';
import { isSingleEval, LabStore, type Hypothesis, type Run, type RunRows } from './store';
import { buildReport } from './report';
import { commandFiles, Lab, parseStatusV2 } from './tools';

let failed = 0;
// Teste assíncrono (ferramentas MCP) roda em fila, um depois do outro, antes do resumo final.
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-lab-'));
const store = new LabStore(dir);
const base: Omit<Hypothesis, 'id' | 'createdAt'> = {
  title: 't',
  statement: 's',
  metric: 'acc',
  direction: 'higher',
  minImprovement: 0.02,
  improvementKind: 'absolute',
  arms: ['baseline', 'variante'],
  minSeeds: 5,
  alpha: 0.05,
  family: 'f',
  createdBy: 'main',
};
function logArm(hid: string, arm: string, values: number[]): void {
  values.forEach((v, i) => store.addRun({ hypothesisId: hid, arm, seed: i + 1, metrics: { acc: v }, source: 'declarado', agent: 'a1' }));
}

test('quadro grava em JSONL com ids sequenciais e status derivado', () => {
  const h = store.addHypothesis(base);
  assert.equal(h.id, 'h1');
  assert.equal(store.status(h), 'registrada');
  logArm('h1', 'baseline', [0.70, 0.72, 0.69, 0.71, 0.73]);
  logArm('h1', 'variante', [0.78, 0.80, 0.77, 0.79, 0.81]);
  assert.equal(store.status(h), 'rodando');
  assert.equal(store.runs('h1').length, 10);
  assert.ok(fs.readFileSync(path.join(dir, '.agm/lab/runs.jsonl'), 'utf8').split('\n').filter(Boolean).length === 10);
});

test('efeito claro com seeds suficientes: suportada', () => {
  const h = store.hypothesis('h1')!;
  const v = evaluate(h, store.runs('h1'), [{ id: 'h1' }], { by: 'main', attempt: 1 });
  assert.equal(v.verdict, 'suportada', v.reasons.join(' | '));
  assert.ok(v.ci[0] > 0 && Math.abs(v.diff - 0.08) < 1e-9);
});

test('poucas seeds: inconclusiva com seeds que faltam', () => {
  const h = store.addHypothesis({ ...base, title: 'poucas' });
  logArm(h.id, 'baseline', [0.70, 0.74]);
  logArm(h.id, 'variante', [0.73, 0.75]);
  const v = evaluate(h, store.runs(h.id), [{ id: h.id }], { by: 'main', attempt: 1 });
  assert.equal(v.verdict, 'inconclusiva');
  assert.ok((v.seedsMissing ?? 0) >= 3, `faltam ${v.seedsMissing}`);
});

test('variante pior com seeds suficientes: refutada', () => {
  const h = store.addHypothesis({ ...base, title: 'pior' });
  logArm(h.id, 'baseline', [0.80, 0.81, 0.79, 0.80, 0.82]);
  logArm(h.id, 'variante', [0.70, 0.71, 0.69, 0.72, 0.70]);
  const v = evaluate(h, store.runs(h.id), [{ id: h.id }], { by: 'main', attempt: 1 });
  assert.equal(v.verdict, 'refutada', v.reasons.join(' | '));
  assert.ok(v.warnings.length > 0, 'efeito enorme deveria gerar aviso');
});

test('BH na família: p limítrofe deixa de passar com muitas hipóteses', () => {
  const h = store.addHypothesis({ ...base, title: 'limítrofe', minImprovement: 0 });
  logArm(h.id, 'baseline', [0.70, 0.73, 0.69, 0.72, 0.71]);
  logArm(h.id, 'variante', [0.72, 0.745, 0.71, 0.735, 0.725]);
  const alone = evaluate(h, store.runs(h.id), [{ id: h.id }], { by: 'main', attempt: 1 });
  const crowded = evaluate(h, store.runs(h.id), [{ id: h.id }, ...Array.from({ length: 9 }, (_, i) => ({ id: `x${i}`, p: 0.9 }))], { by: 'main', attempt: 1 });
  assert.ok(crowded.pAdjusted > alone.pAdjusted, `${crowded.pAdjusted} vs ${alone.pAdjusted}`);
  assert.equal(crowded.familySize, 10);
});

test('números citados: decimais e porcentagens, fora de código e versões', () => {
  const cited = citedNumbers('A acurácia foi 0.87 e melhorou 12.5%. Versão 0.7.1, seed 3, `--lr 0.01`, tempo 1.5s, lista 0,91.');
  assert.deepEqual(
    cited.map((c) => c.text),
    ['0.87', '12.5%', '0,91'],
  );
});

test('aviso só para número sem registro', () => {
  const known = [0.8734, 0.125, 0.91];
  assert.deepEqual(unregistered('acc 0.87, ganho 12.5%, outra 0.91 e 0.93', known), ['0.93']);
  assert.deepEqual(unregistered('87%', known), []);
  assert.deepEqual(unregistered('com 100.000 amostras e 1,500 passos, erro 0.500', known), ['0.500']);
});

test('poda marca e restaura sem apagar nada; vale o último evento', () => {
  const h = store.addHypothesis({ ...base, title: 'podável' });
  const before = store.runs().length;
  assert.equal(store.pruned(h.id), undefined);
  store.setPruned(h.id, true, 'user');
  assert.equal(store.pruned(h.id)?.by, 'user');
  store.setPruned(h.id, false, 'user');
  assert.equal(store.pruned(h.id), undefined);
  store.setPruned(h.id, true, 'user');
  assert.ok(store.pruned(h.id));
  assert.equal(store.hypothesis(h.id)?.title, 'podável');
  assert.equal(store.runs().length, before);
  assert.equal(fs.readFileSync(path.join(store.dir, 'prunes.jsonl'), 'utf8').trim().split('\n').length, 3);
});

/** Predições sintéticas: `units` pacientes com 2 linhas cada; `sep` é o quanto o score separa as classes. */
function predictions(units: number, sep: number, seed: number): RunRows {
  const rand = rng(seed);
  const rows: RunRows = { id: [], unit: [], label: [], score: [] };
  for (let u = 0; u < units; u++) {
    const y = u % 3 === 0 ? 1 : 0;
    for (let k = 0; k < 2; k++) {
      rows.id.push(`p${u}-${k}`);
      rows.unit.push(`p${u}`);
      rows.label!.push(y);
      rows.score.push(sep * y + rand());
    }
  }
  return rows;
}
const pairedBase: Omit<Hypothesis, 'id' | 'createdAt'> = { ...base, metric: 'auc', minImprovement: 0.01, minSeeds: 1, comparison: 'paired_bootstrap', rowMetric: 'auc', unit: 'paciente', minUnits: 20 };
function logPaired(hid: string, arm: string, rows: RunRows): void {
  store.addRun({ hypothesisId: hid, arm, seed: 0, metrics: { auc: rowsMetric(rows, 'auc') }, rows, source: 'arquivo', agent: 'a1' });
}

test('pareado por unidade: um run por braço basta para "suportada"', () => {
  const h = store.addHypothesis({ ...pairedBase, title: 'congelado', family: 'tab' });
  logPaired(h.id, 'baseline', predictions(150, 0.3, 1));
  logPaired(h.id, 'variante', predictions(150, 0.9, 1));
  const v = evaluate(h, store.runs(h.id), [{ id: h.id }], { by: 'main', attempt: 1 });
  assert.equal(v.verdict, 'suportada', v.reasons.join(' | '));
  assert.equal(v.mode, 'paired-samples');
  assert.equal(v.paired?.units, 150);
  assert.equal(v.paired?.rows, 300);
  assert.ok(v.ci[0] > 0 && v.p < 0.01 && v.seedsMissing === undefined, JSON.stringify(v));
  // Mesma família BH das hipóteses por seed: p ruins ao lado aumentam o ajustado.
  const crowded = evaluate(h, store.runs(h.id), [{ id: h.id }, ...Array.from({ length: 5 }, (_, i) => ({ id: `y${i}`, p: 0.8 }))], { by: 'main', attempt: 1 });
  assert.ok(crowded.pAdjusted > v.pAdjusted && crowded.familySize === 6);
  // Determinístico: o recálculo da verificação independente tem de bater.
  const again = evaluate(h, store.runs(h.id), [{ id: h.id }], { by: 'verificação', attempt: 1 });
  assert.deepEqual([again.diff, ...again.ci], [v.diff, ...v.ci]);
});

test('pareado por unidade: poucas unidades é inconclusiva e diz quantas faltam', () => {
  const h = store.addHypothesis({ ...pairedBase, title: 'poucos pacientes', minUnits: 50 });
  logPaired(h.id, 'baseline', predictions(12, 0.3, 2));
  logPaired(h.id, 'variante', predictions(12, 0.5, 3));
  const v = evaluate(h, store.runs(h.id), [{ id: h.id }], { by: 'main', attempt: 1 });
  assert.equal(v.verdict, 'inconclusiva');
  assert.ok(v.reasons.some((r) => r.startsWith('falta: 12 unidade(s)')), v.reasons.join(' | '));
  assert.ok(v.reasons.some((r) => r.includes('o que falta são unidades') || r.includes('só mais unidades')), v.reasons.join(' | '));
});

/** Tira as `k` primeiras linhas (todas as colunas). */
function dropFirst(rows: RunRows, k: number): RunRows {
  return { id: rows.id.slice(k), unit: rows.unit.slice(k), label: rows.label?.slice(k), score: rows.score.slice(k) };
}

test('pareado por unidade: sem predições num braço não compara', () => {
  const h = store.addHypothesis({ ...pairedBase, title: 'um braço só' });
  logPaired(h.id, 'baseline', predictions(30, 0.3, 4));
  assert.match(evaluate(h, store.runs(h.id), [{ id: h.id }], { by: 'main', attempt: 1 }).reasons[0], /predições por linha em cada braço/);
});

test('pareado por unidade: linhas sem par abaixo de 5% são contadas por braço e o veredito vale', () => {
  const h = store.addHypothesis({ ...pairedBase, title: 'poucas sem par' });
  logPaired(h.id, 'baseline', predictions(60, 0.3, 4));
  logPaired(h.id, 'variante', dropFirst(predictions(60, 1.2, 5), 4));
  const v = evaluate(h, store.runs(h.id), [{ id: h.id }], { by: 'main', attempt: 1 });
  assert.deepEqual(v.paired?.unpaired, [4, 0]);
  assert.equal(v.paired?.rows, 116);
  assert.equal(v.verdict, 'suportada', v.reasons.join(' | '));
  assert.ok(v.reasons.some((r) => r.includes('baseline 4 de 120') && r.includes('variante 0 de 116')), v.reasons.join(' | '));
});

test('pareado por unidade: linhas sem par acima de 5% deixam o veredito inconclusivo', () => {
  const h = store.addHypothesis({ ...pairedBase, title: 'muitas sem par' });
  logPaired(h.id, 'baseline', dropFirst(predictions(60, 0.3, 4), 10));
  logPaired(h.id, 'variante', predictions(60, 1.2, 5));
  const v = evaluate(h, store.runs(h.id), [{ id: h.id }], { by: 'main', attempt: 1 });
  assert.deepEqual(v.paired?.unpaired, [0, 10]);
  assert.ok(v.ci[0] > 0, 'o efeito existe, mas o conjunto não bate');
  assert.equal(v.verdict, 'inconclusiva');
  assert.match(v.reasons[0], /acima do limite de 5%/);
});

test('pareado por unidade: run sem coluna unit não vale quando a hipótese declara unit', () => {
  const h = store.addHypothesis({ ...pairedBase, title: 'sem unit' });
  logPaired(h.id, 'baseline', { ...predictions(60, 0.3, 4), unitFromRow: true });
  logPaired(h.id, 'variante', predictions(60, 1.2, 5));
  const v = evaluate(h, store.runs(h.id), [{ id: h.id }], { by: 'main', attempt: 1 });
  assert.equal(v.verdict, 'inconclusiva');
  assert.match(v.reasons[0], /não tem coluna unit/);
});

test('predições: CSV com sinônimos e ponto e vírgula, JSON em linhas ou colunas', () => {
  const csv = parsePredictions('row_id;cluster;y;prob\na;u1;1;0,9\nb;u1;0;0.2\n"c";u2;0;0.4\n', 'p.csv');
  assert.ok(!(csv instanceof Error), String(csv));
  assert.deepEqual(csv, { id: ['a', 'b', 'c'], unit: ['u1', 'u1', 'u2'], label: [1, 0, 0], score: [0.9, 0.2, 0.4] });
  const list = parsePredictions(JSON.stringify([{ id: 1, label: 1, score: 0.7 }, { id: 2, label: 0, score: 0.1 }]), 'p.json');
  assert.deepEqual(list, { id: ['1', '2'], unit: ['1', '2'], label: [1, 0], score: [0.7, 0.1], unitFromRow: true });
  const cols = parsePredictions(JSON.stringify({ predictions: { id: ['x', 'y'], unit: ['g', 'g'], score: [2, 3] } }), 'p.json');
  assert.deepEqual(cols, { id: ['x', 'y'], unit: ['g', 'g'], score: [2, 3] });
  assert.ok(parsePredictions('id,score\na,1\na,2\n', 'p.csv') instanceof Error, 'id repetido');
  assert.ok(parsePredictions('id,unit\na,1\n', 'p.csv') instanceof Error, 'sem score');
});

test('parâmetro de protocolo não é número sem registro', () => {
  const report = 'Usei IC de 95%, alpha 0.05, poder de 80% e 15% de orçamento (holdout de 20%). O 95% CI saiu do veredito. Acurácia 95% e erro 0.05.';
  assert.deepEqual(unregistered(report, []), ['95%', '0.05']);
});

test('número do prompt do agente conta como dado', () => {
  const briefing = 'Rode com lr 0.003 e pare em 12.5% das épocas.';
  assert.deepEqual(unregistered('lr 0.003, parei em 12.5%, acc 0.91', textNumbers(briefing)), ['0.91']);
});

test('número de JSON/CSV citado pelo caminho, só dentro do projeto', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-prov-'));
  fs.mkdirSync(path.join(root, 'out'));
  fs.writeFileSync(path.join(root, 'out', 'metrics.json'), JSON.stringify({ auc: 0.8123, brier: 0.141 }));
  fs.mkdirSync(path.join(root, '.agm', 'worktrees', 'a9', 'res'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agm', 'worktrees', 'a9', 'res', 'tab.csv'), 'k,v\nf1,0.66\n');
  const outside = path.join(os.tmpdir(), `agm-fora-${process.pid}.json`);
  fs.writeFileSync(outside, JSON.stringify({ x: 0.777 }));
  const got = fileNumbers(root, `Resultados em \`out/metrics.json\`, tabela em res/tab.csv e ${outside}.`);
  assert.deepEqual(got.files.map((f) => f.replace(/\\/g, '/')), ['out/metrics.json', '.agm/worktrees/a9/res/tab.csv']);
  assert.ok(got.numbers.includes(0.8123) && got.numbers.includes(0.66) && !got.numbers.includes(0.777));

  // De ponta a ponta no checkReport: briefing, arquivo citado e o que sobra.
  const lab = new Lab(root, () => {});
  lab.store.addHypothesis({ ...base, title: 'prov' });
  const report = 'AUC 0.81 e Brier 0.141 (out/metrics.json), limiar 0.35 do protocolo, F1 0.66 em res/tab.csv, e 0.777 inventado.';
  const checked = lab.checkReport('a9', report, { briefing: 'Use limiar 0.35.' });
  assert.match(checked, /número sem registro \(0\.777\)/);
  assert.equal(lab.checkReport('a9', 'AUC 0.81 em out/metrics.json.'), 'AUC 0.81 em out/metrics.json.');
  fs.rmSync(outside, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('ferramentas: register_hypothesis pareada, log_run com predictions_file e declare_result', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-tools-'));
  const lab = new Lab(root, () => {});
  const tools = Object.fromEntries(lab.tools('a7').map((t) => [t.name, t]));
  const call = async (name: string, args: object) => {
    const r = await tools[name].handler(args as never, {});
    return { text: r.content.map((c) => ('text' in c ? c.text : '')).join('\n'), isError: !!r.isError };
  };
  const bad = await call('register_hypothesis', { title: 'x', statement: 'x', metric: 'auc', direction: 'lower', comparison: 'paired_bootstrap', row_metric: 'auc' });
  assert.ok(bad.isError && /contradiz/.test(bad.text), bad.text);
  const reg = await call('register_hypothesis', { title: 'xgb x lr', statement: 's', metric: 'auc', direction: 'higher', comparison: 'paired_bootstrap', row_metric: 'auc', unit: 'paciente', family: 'tab' });
  assert.ok(!reg.isError && /bootstrap pareado por paciente/.test(reg.text), reg.text);
  const h = lab.store.hypotheses().at(-1)!;
  assert.equal(h.minSeeds, 1);
  const write = (name: string, rows: RunRows) => {
    const lines = ['id,unit,label,score', ...rows.id.map((id, i) => `${id},${rows.unit[i]},${rows.label![i]},${rows.score[i]}`)];
    fs.writeFileSync(path.join(root, name), lines.join('\n'));
  };
  write('base.csv', predictions(120, 0.3, 11));
  write('var.csv', predictions(120, 0.9, 11));
  fs.writeFileSync(path.join(root, 'nounit.csv'), 'id,label,score\na,1,0.9\nb,0,0.2\n');
  const noUnit = await call('log_run', { hypothesis_id: h.id, arm: 'baseline', seed: 0, command: 'x', predictions_file: 'nounit.csv' });
  assert.ok(noUnit.isError && /declara a unidade "paciente"/.test(noUnit.text), noUnit.text);
  const seedsOnly = await call('log_run', { hypothesis_id: h.id, arm: 'baseline', seed: 1, command: 'x', metrics: [{ name: 'auc', value: 0.7 }] });
  assert.ok(seedsOnly.isError && /predictions_file/.test(seedsOnly.text), seedsOnly.text);
  const r1 = await call('log_run', { hypothesis_id: h.id, arm: 'baseline', seed: 0, command: 'python score.py lr', predictions_file: 'base.csv' });
  assert.ok(!r1.isError && /240 linhas e 120 unidades/.test(r1.text), r1.text);
  await call('log_run', { hypothesis_id: h.id, arm: 'variante', seed: 0, command: 'python score.py xgb', predictions_file: 'var.csv' });
  const run = lab.store.runs(h.id).at(-1)!;
  assert.equal(run.source, 'arquivo');
  assert.equal(run.artifact, 'var.csv');
  assert.ok(run.metricsFileHash && run.rows?.score.length === 240);
  const v = await call('declare_result', { hypothesis_id: h.id });
  assert.ok(/SUPORTADA/.test(v.text) && /pareado por paciente \(120 unidades/.test(v.text), v.text);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------- Teste da missão de drones: pareado por seed, hipótese esquecida, agregados, commit sujo, cofre ----------

/** Dez instâncias com dificuldade muito diferente e uma variante sempre um pouco melhor: só o pareamento enxerga. */
const instances = [415.7, 487.4, 688.0, 350.2, 602.9, 455.1, 530.6, 580.3, 470.8, 536.0];
const gains = [3.1, 2.4, 4.0, 1.9, 3.6, 2.8, 3.3, 2.2, 3.9, 2.7];

test('paired_seeds: pareia pela seed e acha a melhora que o modo seeds não vê', () => {
  const s = new LabStore(fs.mkdtempSync(path.join(os.tmpdir(), 'agm-ps-')));
  const mk = (comparison?: 'paired_seeds') => {
    const h = s.addHypothesis({ ...base, metric: 'score', minImprovement: 0, arms: ['pool', 'final'], minSeeds: 10, comparison, unit: comparison ? 'instância' : undefined });
    instances.forEach((x, i) => {
      s.addRun({ hypothesisId: h.id, arm: 'pool', seed: i + 1, metrics: { score: x }, source: 'declarado', agent: 'a1' });
      s.addRun({ hypothesisId: h.id, arm: 'final', seed: i + 1, metrics: { score: x + gains[i] }, source: 'declarado', agent: 'a1' });
    });
    return h;
  };
  const hp = mk('paired_seeds');
  const vp = evaluate(hp, s.runs(hp.id), [{ id: hp.id }], { by: 'a1', attempt: 1 });
  assert.equal(vp.verdict, 'suportada');
  assert.equal(vp.pairedSeeds?.seeds, 10);
  assert.equal(vp.paired, undefined);
  assert.ok(Math.abs(vp.diff - mean(gains)) < 1e-9);
  assert.ok(vp.ci[0] > 0 && vp.ci[0] < vp.diff);
  const hs = mk();
  const vs = evaluate(hs, s.runs(hs.id), [{ id: hs.id }], { by: 'a1', attempt: 1 });
  assert.equal(vs.verdict, 'inconclusiva');
  // Seed de um braço só fica de fora e aparece nos motivos.
  s.addRun({ hypothesisId: hp.id, arm: 'final', seed: 11, metrics: { score: 999 }, source: 'declarado', agent: 'a1' });
  const v2 = evaluate(hp, s.runs(hp.id), [{ id: hp.id }], { by: 'a1', attempt: 2 });
  assert.deepEqual(v2.pairedSeeds?.unpaired, [0, 1]);
  assert.ok(v2.reasons.some((r) => /sem par/.test(r)));
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('paired_seeds: p da troca de sinais e mínimo de 6 seeds em comum', () => {
  assert.equal(signFlipP([0.01, 0.02]), 0.5);
  assert.equal(signFlipP([0.01, 0.02, 0.03]), 0.25);
  assert.equal(signFlipP([1, 2, 3, 4, 5]), 0.0625);
  assert.equal(signFlipP([1, 2, 3, 4, 5, 6]), 2 / 64);
  assert.ok(Math.abs(signFlipP([1, 2, -0.5, 4, 5]) - 4 / 32) < 1e-12);
  assert.ok(Math.abs(tInv(0.975, 9) - 2.2622) < 1e-3 && Math.abs(tInv(0.025, 4) + 2.7764) < 1e-3);
  const s = new LabStore(fs.mkdtempSync(path.join(os.tmpdir(), 'agm-ps2-')));
  const h = s.addHypothesis({ ...base, metric: 'score', minImprovement: 0, arms: ['pool', 'final'], minSeeds: 2, comparison: 'paired_seeds' });
  for (let i = 1; i <= 5; i++) {
    s.addRun({ hypothesisId: h.id, arm: 'pool', seed: i, metrics: { score: 100 * i }, source: 'declarado', agent: 'a1' });
    s.addRun({ hypothesisId: h.id, arm: 'final', seed: i, metrics: { score: 100 * i + 0.01 * i }, source: 'declarado', agent: 'a1' });
  }
  const v = evaluate(h, s.runs(h.id), [{ id: h.id }], { by: 'a1', attempt: 1 });
  assert.equal(v.verdict, 'inconclusiva');
  assert.equal(v.p, 0.0625);
  assert.ok(v.reasons.some((r) => /Faltam 1 seed/.test(r)), v.reasons.join('\n'));
  assert.equal(readyToDeclare(h, s.runs(h.id)), false);
  s.addRun({ hypothesisId: h.id, arm: 'pool', seed: 6, metrics: { score: 600 }, source: 'declarado', agent: 'a1' });
  s.addRun({ hypothesisId: h.id, arm: 'final', seed: 6, metrics: { score: 600.06 }, source: 'declarado', agent: 'a1' });
  const v6 = evaluate(h, s.runs(h.id), [{ id: h.id }], { by: 'a1', attempt: 2 });
  assert.equal(v6.verdict, 'suportada');
  assert.equal(v6.p, 2 / 64);
  assert.ok(v6.ci[0] > 0 && v6.ci[0] < v6.diff);
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('pairedHint: mesmas seeds com instância no enunciado ou seed repetida com o mesmo valor', () => {
  const h = { ...base, id: 'hx', createdAt: '', metric: 'score', arms: ['a', 'b'] as [string, string] };
  const run = (arm: string, seed: number, score: number, command = 'python run.py'): Run => ({ id: `r${arm}${seed}`, hypothesisId: 'hx', arm, seed, metrics: { score }, command, source: 'declarado', agent: 'a1', at: '' });
  const same = [run('a', 1, 1), run('a', 2, 2), run('b', 1, 1.5), run('b', 2, 2.5)];
  assert.equal(pairedHint(h, same), undefined);
  assert.match(pairedHint({ ...h, statement: 'A seed é a semente da instância.' }, same) ?? '', /instância/);
  assert.match(pairedHint(h, [...same, run('a', 1, 1)]) ?? '', /determinística/);
  assert.equal(pairedHint({ ...h, statement: 'instância' }, [run('a', 1, 1), run('a', 2, 2), run('b', 1, 1), run('b', 3, 3)]), undefined);
  assert.equal(pairedHint({ ...h, statement: 'instância', comparison: 'paired_seeds' }, same), undefined);
});

test('hipótese esquecida: staleHypotheses e lembrete uma vez por hipótese', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-stale-'));
  const lab = new Lab(root, () => {});
  const h = lab.store.addHypothesis({ ...base, metric: 'score', arms: ['pool', 'final'], minSeeds: 3, statement: 'A seed é a instância.', createdBy: 'a1' });
  lab.store.addHypothesis({ ...base, title: 'de outro', createdBy: 'a2' });
  for (let s = 1; s <= 3; s++) {
    lab.store.addRun({ hypothesisId: h.id, arm: 'pool', seed: s, metrics: { score: s }, source: 'declarado', agent: 'a3' });
  }
  assert.deepEqual(lab.staleHypotheses('a1'), []);
  for (let s = 1; s <= 3; s++) {
    lab.store.addRun({ hypothesisId: h.id, arm: 'final', seed: s, metrics: { score: s + 1 }, source: 'declarado', agent: 'a3' });
  }
  assert.deepEqual(lab.staleHypotheses('a1').map((x) => x.id), [h.id]);
  assert.deepEqual(lab.staleHypotheses('a2'), []);
  const msg = lab.takeStaleReminder('a1');
  assert.ok(msg && new RegExp(`${h.id} "t": 6 runs`).test(msg) && /declare_result/.test(msg) && /paired_seeds/.test(msg), msg);
  assert.equal(lab.takeStaleReminder('a1'), undefined);
  // Outra conversa: o a1 de agora não é o a1 que registrou a hipótese.
  lab.currentConversation = () => 'conversa-2';
  lab.conversationOf = () => 'conversa-1';
  assert.deepEqual(lab.staleHypotheses('a1'), []);
  lab.conversationOf = () => 'conversa-2';
  assert.deepEqual(lab.staleHypotheses('a1').map((x) => x.id), [h.id]);
  lab.store.addVerdict(evaluate(h, lab.store.runs(h.id), [{ id: h.id }], { by: 'a1', attempt: 1 }));
  assert.deepEqual(lab.staleHypotheses('a1'), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('aviso de número: agregados de runs, formato brasileiro e números do cofre', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-agg-'));
  const lab = new Lab(root, () => {});
  const h = lab.store.addHypothesis({ ...base, metric: 'score', arms: ['pool', 'final'], createdBy: 'a1' });
  instances.forEach((x, i) => {
    lab.store.addRun({ hypothesisId: h.id, arm: 'final', seed: i + 1, metrics: { score: x + gains[i] }, source: 'arquivo', agent: 'a1' });
    lab.store.addRun({ hypothesisId: h.id, arm: 'pool', seed: i + 1, metrics: { score: x }, source: 'arquivo', agent: 'a2' });
  });
  const finals = instances.map((x, i) => x + gains[i]);
  const br = (x: number) => x.toFixed(2).replace('.', ',');
  const avg = br(mean(finals));
  const total = mean(finals) * 10;
  const totalBr = `${Math.floor(total / 1000)}.${String(Math.floor(total) % 1000).padStart(3, '0')},${total.toFixed(2).split('.')[1]}`;
  const sorted = [...finals].sort((a, b) => a - b);
  const report = `Média ${avg} nas sementes 1 a 10, soma ${totalBr}, mediana ${((sorted[4] + sorted[5]) / 2).toFixed(1)}, melhor ${Math.max(...finals).toFixed(1)}, ganho médio ${mean(gains).toFixed(2)} e 777,77 inventado. Cofre 527,5591.`;
  assert.match(lab.checkReport('a1', report), /número sem registro \(777,77, 527,5591\)/);
  fs.mkdirSync(path.join(root, '.agm'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.agm', 'lockbox.json'),
    JSON.stringify({ lockboxes: [{ id: 'lb1', paths: ['cofre/**'], hypotheses: [], command: 'python avaliar.py', evaluations: [{ id: 'e1', hypothesisId: '', at: new Date().toISOString(), numbers: [527.5591, 5, 0.4242], metrics: { score_medio_cofre: 527.5591 } }] }] }),
  );
  resetLockboxCacheForTest();
  assert.match(lab.checkReport('a1', report), /número sem registro \(777,77\)/);
  // Só as métricas da última linha JSON, não os números soltos da saída.
  assert.match(lab.checkReport('a1', 'Tabela do cofre: 0.4242.'), /número sem registro \(0\.4242\)/);
  // Só avaliação desta conversa: a conversa abriu depois da avaliação e a hipótese dela não é daqui.
  lab.currentConversation = () => 'conversa-2';
  lab.conversationOf = () => undefined;
  lab.conversationSince = new Date(Date.now() + 3600_000).toISOString();
  assert.match(lab.checkReport('a1', 'Cofre 527,5591.'), /número sem registro \(527,5591\)/);
  lab.conversationOf = () => 'conversa-2';
  // Máximo dos runs de a1 na hipótese de a1: vale para a1, não para a2.
  const best = `Melhor ${Math.max(...finals).toFixed(1)}.`;
  assert.equal(lab.checkReport('a1', best), best);
  assert.match(lab.checkReport('a2', best), /número sem registro/);
  // Grupo de um run só não vira agregado citável por outro agente.
  const lone = lab.store.addHypothesis({ ...base, metric: 'score', createdBy: 'a3' });
  lab.store.addRun({ hypothesisId: lone.id, arm: 'baseline', seed: 1, metrics: { score: 12.34 }, source: 'arquivo', agent: 'a3' });
  assert.match(lab.checkReport('a1', 'Valor 12.34 de a3.'), /número sem registro \(12\.34\)/);
  assert.equal(citedNumbers('soma 1.234,56 e 1,234.56 e 100.000').map((n) => n.value).join(' '), '1234.56 1234.56');
  fs.rmSync(root, { recursive: true, force: true });
});

test('log_run grava dirty quando arquivo citado no comando não está no commit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-dirty-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(root, 'rodar.py'), 'print(1)\n');
  git('add', 'rodar.py');
  git('commit', '-q', '-m', 'x');
  fs.writeFileSync(path.join(root, 'solver.py'), 'print(2)\n');
  fs.writeFileSync(path.join(root, 'm.json'), '{"score": 3.5}');
  assert.deepEqual(commandFiles(root, 'python rodar.py solver.py --out m.json --tag x.final'), ['rodar.py', 'solver.py']);
  assert.deepEqual(commandFiles(root, 'python rodar.py > m.json'), ['rodar.py']);
  assert.deepEqual(commandFiles(root, 'python rodar.py --metrics=m.json solver.py'), ['rodar.py', 'solver.py']);
  const lab = new Lab(root, () => {});
  const tools = Object.fromEntries(lab.tools('a1').map((t) => [t.name, t]));
  const call = async (name: string, args: object) => {
    const r = await tools[name].handler(args as never, {});
    return { text: r.content.map((c) => ('text' in c ? c.text : '')).join('\n'), isError: !!r.isError };
  };
  await call('register_hypothesis', { title: 'x', statement: 's', metric: 'score', direction: 'higher' });
  const clean = await call('log_run', { hypothesis_id: 'h1', arm: 'baseline', seed: 1, command: 'python rodar.py', metrics: [{ name: 'score', value: 1 }] });
  assert.ok(!/Atenção/.test(clean.text) && lab.store.runs().at(-1)!.dirty === false, clean.text);
  const dirty = await call('log_run', { hypothesis_id: 'h1', arm: 'baseline', seed: 2, command: 'python rodar.py solver.py', metrics_file: 'm.json' });
  const run = lab.store.runs().at(-1)!;
  assert.equal(run.dirty, true);
  assert.deepEqual(run.dirtyFiles, ['solver.py']);
  assert.match(dirty.text, /solver\.py, citado\(s\) no comando, tem mudança não commitada/);
  // Arquivo rastreado modificado: o porcelain começa com espaço (" M"), e o primeiro da lista não pode sumir.
  git('add', 'solver.py');
  fs.writeFileSync(path.join(root, '.gitignore'), '*.json\ngen.py\n');
  git('add', '.gitignore');
  git('commit', '-q', '-m', 'y');
  fs.writeFileSync(path.join(root, 'rodar.py'), 'print(3)\n');
  await call('log_run', { hypothesis_id: 'h1', arm: 'baseline', seed: 3, command: 'python rodar.py solver.py', metrics: [{ name: 'score', value: 1 }] });
  assert.deepEqual(lab.store.runs().at(-1)!.dirtyFiles, ['rodar.py']);
  git('add', 'rodar.py');
  git('commit', '-q', '-m', 'z');
  // Saída ignorada pelo git (o metrics_file e o --out) não suja; código ignorado suja.
  fs.writeFileSync(path.join(root, 'gen.py'), 'print(4)\n');
  await call('log_run', { hypothesis_id: 'h1', arm: 'baseline', seed: 4, command: 'python rodar.py --out m.json', metrics_file: 'm.json' });
  const out = lab.store.runs().at(-1)!;
  assert.ok(out.dirty === false && !out.dirtyFiles, JSON.stringify(out));
  await call('log_run', { hypothesis_id: 'h1', arm: 'baseline', seed: 5, command: 'python gen.py m.json', metrics_file: 'm.json' });
  assert.deepEqual(lab.store.runs().at(-1)!.dirtyFiles, ['gen.py']);
  assert.deepEqual(parseStatusV2(['# branch.oid abc1234', '# branch.head main', '1 .M N... 100644 100644 100644 aa bb a b.py', '? novo.py', '! out/', ''].join('\x00')).changed, ['a b.py']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('avaliação única: register single, run do cofre, sem declare_result e fora da família', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-single-'));
  const lab = new Lab(root, () => {});
  const tools = Object.fromEntries(lab.tools('main').map((t) => [t.name, t]));
  const call = async (name: string, args: object) => {
    const r = await tools[name].handler(args as never, {});
    return { text: r.content.map((c) => ('text' in c ? c.text : '')).join('\n'), isError: !!r.isError };
  };
  const bad = await call('register_hypothesis', { title: 'cofre', statement: 's', metric: 'score_medio_cofre', direction: 'higher', comparison: 'single', min_seeds: 5 });
  assert.ok(bad.isError, bad.text);
  const reg = await call('register_hypothesis', { title: 'cofre', statement: 's', metric: 'score_medio_cofre', direction: 'higher', comparison: 'single' });
  assert.ok(!reg.isError && /avaliação única/.test(reg.text), reg.text);
  const h = lab.store.hypothesis('h1')!;
  assert.ok(isSingleEval(h));
  assert.equal(lab.store.status(h), 'registrada');
  // Só o cofre grava na hipótese de avaliação única.
  const sub = Object.fromEntries(lab.tools('a5').map((t) => [t.name, t]));
  const callSub = async (name: string, args: object) => {
    const r = await sub[name].handler(args as never, {});
    return { text: r.content.map((c) => ('text' in c ? c.text : '')).join('\n'), isError: !!r.isError };
  };
  const forged = await callSub('log_run', { hypothesis_id: h.id, arm: 'cofre', seed: 0, command: 'x', metrics: [{ name: 'score_medio_cofre', value: 0.93 }] });
  assert.ok(forged.isError && /só o lockbox_evaluate/.test(forged.text), forged.text);
  assert.ok(lab.addHostRun({ hypothesisId: h.id, arm: 'cofre', seed: 0, command: 'x', metricsFile: 'm.json', workdir: root, agent: 'a5' }) instanceof Error);
  assert.equal(lab.store.status(h), 'registrada');
  const arms = lab.store.addHypothesis({ ...base });
  assert.equal(lab.addLockboxRun({ hypothesisId: arms.id, lockboxId: 'lb1', evalId: 'e1', command: 'c', metrics: { acc: 1 }, stdoutHash: 'ab', agent: 'main' }).ok, false);
  assert.equal(lab.addLockboxRun({ hypothesisId: h.id, lockboxId: 'lb1', evalId: 'e1', command: 'c', metrics: { outra: 1 }, stdoutHash: 'ab', agent: 'main' }).ok, false);
  const ok = lab.addLockboxRun({ hypothesisId: h.id, lockboxId: 'lb1', evalId: 'e1', command: 'python avaliar.py', metrics: { score_medio_cofre: 527.5591, validos: 5 }, stdoutHash: '0123456789abcdef0123', agent: 'main' });
  assert.ok(ok.ok && /run r1 da h1/.test(ok.note ?? ''), ok.note);
  const run = lab.store.runs(h.id)[0];
  assert.deepEqual(run.lockbox, { id: 'lb1', evalId: 'e1' });
  assert.equal(run.metricsFileHash, '0123456789abcdef');
  assert.equal(lab.store.status(h), 'concluída');
  const dec = await call('declare_result', { hypothesis_id: h.id });
  assert.ok(dec.isError && /avaliação única/.test(dec.text) && /527\.5591/.test(dec.text), dec.text);
  // Segunda avaliação (repetição aprovada) fica como extra; o resultado continua o da primeira.
  const again = lab.addLockboxRun({ hypothesisId: h.id, lockboxId: 'lb1', evalId: 'e2', command: 'python avaliar.py', metrics: { score_medio_cofre: 600.25 }, stdoutHash: 'ff', agent: 'main' });
  assert.ok(again.ok && /avaliação extra 1/.test(again.note ?? '') && /r1/.test(again.note ?? ''), again.note);
  const dec2 = await call('declare_result', { hypothesis_id: h.id });
  assert.ok(/r1/.test(dec2.text) && /527\.5591/.test(dec2.text) && !/600/.test(dec2.text), dec2.text);
  // Subagente não vê o número do cofre no quadro, no declare_result nem no relatório de experimento.
  const board = await callSub('read_board', { hypothesis_id: h.id });
  assert.ok(!/527|600/.test(board.text) && /valor só para o main/.test(board.text) && /extras: r2/.test(board.text), board.text);
  const decSub = await callSub('declare_result', { hypothesis_id: h.id });
  assert.ok(!/527/.test(decSub.text) && /valor só para o main/.test(decSub.text), decSub.text);
  const mainBoard = await call('read_board', { hypothesis_id: h.id });
  assert.match(mainBoard.text, /527\.5591/);
  const input = { root, store: lab.store, state: lab.state(), integrity: new LabIntegrity(root, lab.store), scope: 'hypothesis' as const, id: h.id };
  const hidden = buildReport({ ...input, hideLockbox: true });
  const shown = buildReport(input);
  assert.ok(!(hidden instanceof Error) && !/527|600\.25/.test(hidden.markdown) && /valor só para o main/.test(hidden.markdown));
  assert.ok(!(shown instanceof Error) && /527\.5591/.test(shown.markdown) && /primeira avaliação/.test(shown.markdown));
  assert.deepEqual(lab.staleHypotheses('main'), []);
  assert.ok(!new LabIntegrity(root, lab.store).family(arms).members.some((m) => m.id === h.id));
  assert.equal(lab.checkReport('main', 'Cofre: 527,5591.'), 'Cofre: 527,5591.');
  fs.rmSync(root, { recursive: true, force: true });
});

void queue.then(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (failed) {
    console.log(`\n${failed} teste(s) falharam`);
    process.exit(1);
  }
  console.log('\ntodos os testes do laboratório passaram');
});
