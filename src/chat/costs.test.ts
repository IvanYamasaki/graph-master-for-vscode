/**
 * Testes do custo por modelo, do gasto contra o teto e da nota de progresso antiga. Sem VS Code:
 *   npx esbuild src/chat/costs.test.ts --bundle --platform=node --outfile=$TEMP/costs.test.js && node $TEMP/costs.test.js
 */
import * as assert from 'node:assert/strict';
import { codexNote, heavyNudge, heavyStreak, HEAVY_STREAK, isHeavySpawn, modelCostLine, modelTier, progressLabel, relativeToSonnet, settleProgress, spendLines, sumSpent } from './costs';
import { inheritProtected, reportOnStop } from './turnRules';

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

test('família do modelo pelo alias ou pelo id', () => {
  assert.equal(modelTier('sonnet'), 'sonnet');
  assert.equal(modelTier('claude-opus-5-5'), 'opus');
  assert.equal(modelTier('claude-haiku-4-5-20251001'), 'haiku');
  assert.equal(modelTier('claude-fable-5-1'), 'fable');
  assert.equal(modelTier('claude-mythos-5-1'), 'fable');
  assert.equal(modelTier('gpt-5'), undefined);
  assert.equal(modelTier(undefined), undefined);
  assert.equal(relativeToSonnet('opus'), 2);
  assert.equal(relativeToSonnet('fable'), 5);
});

test('linha de modelo com preço e custo relativo', () => {
  const opus = modelCostLine('opus', 'high');
  assert.match(opus, /^modelo opus \(Opus 5\.5, US\$ 4\/20 por milhão/);
  assert.match(opus, /2x o sonnet/);
  assert.match(opus, /raciocínio high$/);
  assert.doesNotMatch(modelCostLine('sonnet', 'medium'), /o sonnet\)/);
  assert.match(modelCostLine('claude-haiku-4-5-20251001', undefined, true), /\(herdado\).*0,5x o sonnet.*raciocínio padrão/);
  assert.equal(modelCostLine('gpt-5', 'low'), 'modelo gpt-5, raciocínio low');
});

test('filho pesado: opus ou fable com raciocínio high ou acima', () => {
  assert.equal(isHeavySpawn('opus', 'high'), true);
  assert.equal(isHeavySpawn('claude-fable-5-1', 'xhigh'), true);
  assert.equal(isHeavySpawn('opus', undefined), true);
  assert.equal(isHeavySpawn('opus', 'medium'), false);
  assert.equal(isHeavySpawn('sonnet', 'max'), false);
  assert.equal(isHeavySpawn(undefined, 'high'), false);
});

test('sugestão só a partir do terceiro filho pesado seguido', () => {
  assert.equal(heavyStreak([]), 0);
  assert.equal(heavyStreak([true, true, false, true]), 1);
  assert.equal(heavyStreak([false, true, true, true]), 3);
  assert.equal(heavyNudge(HEAVY_STREAK - 1), '');
  assert.match(heavyNudge(3), /3º subagente seguido/);
  assert.match(heavyNudge(3), /sonnet \(medium\)/);
});

test('teto em US$ aparece antes do primeiro custo', () => {
  const lines = spendLines({ maxMinutes: 150, maxUsd: 35 }, { tokens: 0, minutes: 0 });
  assert.equal(lines.length, 3);
  assert.match(lines[2], /US\$ 0,00 de US\$ 35,00 estimados/);
  // Sem teto em US$ e sem custo: não inventa linha de custo.
  assert.equal(spendLines(undefined, { tokens: 10, minutes: 1 }).length, 2);
  // Codex não informa custo: a linha diz isso em vez de US$ 0.
  assert.match(spendLines({ maxUsd: 5 }, { tokens: 0, minutes: 0 }, 'codex')[2], /Codex não informa/);
});

test('soma de gasto: custo só se alguém informou', () => {
  assert.deepEqual(sumSpent([{ tokens: 10, minutes: 1.234 }, undefined, { tokens: 5, minutes: 2 }]), { tokens: 15, minutes: 3.23 });
  assert.deepEqual(sumSpent([{ tokens: 1, minutes: 0, usd: 0.5 }, { tokens: 1, minutes: 0 }, { tokens: 1, minutes: 0, usd: 1.25 }]), { tokens: 3, minutes: 0, usd: 1.75 });
});

test('nota de progresso vira antiga quando o agente conclui', () => {
  const p = { text: 'seeds 11-40 still going', at: '2026-09-30T10:00:00Z' };
  assert.equal(settleProgress(p, 'running'), p);
  assert.equal(settleProgress(p, 'waiting'), p);
  assert.deepEqual(settleProgress(p, 'completed'), { ...p, stale: true });
  assert.equal(settleProgress(undefined, 'completed'), undefined);
  assert.equal(progressLabel({ status: 'running', progress: p }), 'progresso: seeds 11-40 still going');
  assert.equal(progressLabel({ status: 'completed', progress: { ...p, stale: true } }), 'último progresso, antes de concluir: seeds 11-40 still going');
  assert.equal(progressLabel({ status: 'failed', progress: { ...p, stale: true } }), 'último progresso, antes de falhar: seeds 11-40 still going');
  // Retomado e rodando de novo sem nota nova: a antiga continua marcada.
  assert.equal(progressLabel({ status: 'running', progress: { ...p, stale: true } }), 'progresso anterior: seeds 11-40 still going');
  assert.equal(progressLabel({ status: 'completed' }), '');
});

test('protected_paths: filho soma aos do criador e não tira nenhum', () => {
  assert.equal(inheritProtected(undefined, undefined), undefined);
  assert.equal(inheritProtected([], ['  ']), undefined);
  assert.deepEqual(inheritProtected(['MESTRE.md', 'OBSERVACOES.md'], undefined), ['MESTRE.md', 'OBSERVACOES.md']);
  assert.deepEqual(inheritProtected(['MESTRE.md'], [' eval/** ', 'MESTRE.md']), ['MESTRE.md', 'eval/**']);
  // Neto: o criador já traz os do avô, então a cadeia inteira chega.
  const child = inheritProtected(['MESTRE.md'], ['data/test/**']);
  assert.deepEqual(inheritProtected(child, []), ['MESTRE.md', 'data/test/**']);
});

test('Parar entrega o relatório segurado só pelo lembrete e descarta o segurado por pendência', () => {
  assert.equal(reportOnStop('  Conclusão: pronto.  ', true), 'Conclusão: pronto.');
  assert.equal(reportOnStop('Conclusão: pronto.', false), undefined);
  assert.equal(reportOnStop('   ', true), undefined);
  assert.equal(reportOnStop(undefined, true), undefined);
});

test('US$ de grupo misto avisa que o Codex fica de fora', () => {
  assert.equal(codexNote([undefined, 'codex'], true), ' (sem Codex)');
  // Só Claude, só Codex (a linha já diz que o Codex não informa) ou sem custo: nada.
  assert.equal(codexNote([undefined, undefined], true), '');
  assert.equal(codexNote(['codex', 'codex'], false), '');
  assert.equal(codexNote([undefined, 'codex'], false), '');
});

if (failed) {
  console.log(`\n${failed} teste(s) falharam`);
  process.exit(1);
}
console.log('\ntodos os testes passaram');
