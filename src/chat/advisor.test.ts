/**
 * Testes do advisor tool nos agentes: pareamento executor/advisor, alias → família e a conta do uso do advisor.
 * Sem VS Code:
 *   npx esbuild src/chat/advisor.test.ts --bundle --platform=node --outfile=$TEMP/advisor.test.js && node $TEMP/advisor.test.js
 */
import * as assert from 'node:assert/strict';
import { advisorName, advisorResultText, advisorSpend, checkAdvisor, parseModel } from './advisor';
import { budgetLines } from './guard/format';
import { applyUsd, newUsdTrack } from './usdEstimate';

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

test('alias e id viram família e versão', () => {
  assert.deepEqual(parseModel('opus'), { family: 'opus', version: 5 });
  assert.deepEqual(parseModel('sonnet'), { family: 'sonnet', version: 5 });
  assert.deepEqual(parseModel('haiku'), { family: 'haiku', version: 4.5 });
  assert.deepEqual(parseModel('fable'), { family: 'fable', version: 5.1 });
  assert.deepEqual(parseModel('claude-haiku-4-5-20251001'), { family: 'haiku', version: 4.5 });
  assert.deepEqual(parseModel('claude-opus-4-8[1m]'), { family: 'opus', version: 4.8 });
  assert.deepEqual(parseModel('claude-sonnet-5'), { family: 'sonnet', version: 5 });
  assert.deepEqual(parseModel('claude-mythos-5-1'), { family: 'fable', version: 5.1 });
  assert.deepEqual(parseModel('Opus'), { family: 'opus', version: 5 });
  assert.equal(parseModel('gpt-5'), undefined);
  assert.equal(parseModel(''), undefined);
  assert.equal(parseModel(undefined), undefined);
  assert.equal(advisorName('opus'), 'Opus 5');
  assert.equal(advisorName('claude-sonnet-5-5'), 'Sonnet 5,5');
});

test('a lista viva do CLI decide o alias antes da tabela', () => {
  const live = (alias: string) => ({ sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', haiku: 'haiku' })[alias];
  assert.deepEqual(parseModel('sonnet', live), { family: 'sonnet', version: 5.5 });
  assert.deepEqual(parseModel('fable', live), { family: 'fable', version: 5.1 }, 'fora da lista: a tabela');
  assert.deepEqual(parseModel('haiku', live), { family: 'haiku', version: 4.5 }, 'lista que devolve o próprio alias não entra em laço');
  // Opus 4.8 só aceita Sonnet 5.5: com a lista viva o alias passa, com a tabela (Sonnet 5) não.
  assert.equal(checkAdvisor('claude-opus-4-8', 'sonnet', live).ok, true);
  assert.equal(checkAdvisor('claude-opus-4-8', 'sonnet').ok, false);
});

test('pareamento segue a tabela das docs', () => {
  const ok = (exec: string, adv: string) => assert.equal(checkAdvisor(exec, adv).ok, true, `${adv} aconselha ${exec}`);
  const no = (exec: string, adv: string) => assert.equal(checkAdvisor(exec, adv).ok, false, `${adv} não aconselha ${exec}`);
  // Haiku 4.5 e Sonnet 4.6: Fable, Opus, Sonnet, Haiku 5.5.
  ok('haiku', 'sonnet');
  ok('haiku', 'opus');
  ok('claude-haiku-4-5-20251001', 'claude-haiku-5-5');
  ok('claude-sonnet-4-6', 'claude-opus-4-7');
  no('haiku', 'haiku');
  no('claude-sonnet-4-6', 'claude-haiku-4-5-20251001');
  // Sonnet 5 e Haiku 5.5: Fable, Opus 4.7+, Sonnet 5+, Haiku 5.5.
  ok('claude-sonnet-5', 'claude-haiku-5-5');
  ok('claude-haiku-5-5', 'claude-sonnet-5');
  no('claude-sonnet-5', 'claude-opus-4-6');
  // Opus 4.7/4.8: Fable, Opus 4.7+, Sonnet 5.5.
  ok('claude-opus-4-8', 'claude-sonnet-5-5');
  no('claude-opus-4-7', 'claude-sonnet-5');
  // Sonnet 5.5: Fable, Opus 5+, Sonnet 5.5.
  ok('claude-sonnet-5-5', 'opus');
  ok('claude-sonnet-5-5', 'fable');
  ok('claude-sonnet-5-5', 'claude-sonnet-5-5');
  no('claude-sonnet-5-5', 'sonnet');
  no('claude-sonnet-5-5', 'claude-opus-4-8');
  no('claude-sonnet-5-5', 'haiku');
  // Aliases de hoje (Sonnet 5, Opus 5): a regra do prompt, sonnet com advisor opus, passa.
  ok('sonnet', 'opus');
  ok('sonnet', 'fable');
  ok('haiku', 'sonnet');
  // Opus 5/5.5: Fable, Opus 5+.
  ok('opus', 'fable');
  ok('opus', 'opus');
  no('opus', 'sonnet');
  // Fable 5: Fable 5/5.1. Fable 5.1: só Fable 5.1.
  ok('claude-fable-5', 'claude-fable-5');
  ok('claude-fable-5', 'fable');
  no('claude-fable-5-1', 'claude-fable-5');
  ok('claude-fable-5-1', 'fable');
  no('claude-fable-5-1', 'opus');
});

test('par recusado explica e diz que subiu sem advisor', () => {
  const r = checkAdvisor('opus', 'sonnet');
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.reason, /advisor Sonnet 5 não pode aconselhar Opus 5; subiu sem advisor/);
  const bad = checkAdvisor('sonnet', 'gpt-5');
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? '' : bad.reason, /não é um modelo Claude/);
});

test('executor desconhecido passa, com nota', () => {
  const r = checkAdvisor(undefined, 'opus');
  assert.equal(r.ok, true);
  assert.match(r.ok ? (r.note ?? '') : '', /modelo padrão/);
  const old = checkAdvisor('claude-sonnet-4-5', 'opus');
  assert.equal(old.ok, true);
  assert.ok(old.ok && old.note);
  const known = checkAdvisor('sonnet', 'opus');
  assert.ok(known.ok && !known.note && known.advisor === 'opus');
});

test('uso do advisor sai das iterações, no preço do modelo dele', () => {
  const usage = {
    input_tokens: 100,
    output_tokens: 50,
    iterations: [
      { type: 'message', input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      { type: 'advisor_message', model: 'claude-opus-5-5', input_tokens: 10_000, output_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      { type: 'message', input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ],
  };
  const s = advisorSpend(usage)!;
  assert.equal(s.tokens, 11_000);
  // Opus: US$ 4 por milhão de entrada, 20 de saída.
  assert.ok(Math.abs((s.usd ?? 0) - (10_000 * 4 + 1_000 * 20) / 1e6) < 1e-9);
  assert.equal(s.model, 'claude-opus-5-5');
  assert.equal(advisorSpend({ input_tokens: 5, iterations: [{ type: 'message', input_tokens: 5 }] }), undefined);
  assert.equal(advisorSpend({ input_tokens: 5 }), undefined);
  assert.equal(advisorSpend(undefined), undefined);
});

test('a estimativa do advisor some no total real do fim do turno, sem contar duas vezes', () => {
  const t = newUsdTrack(0);
  let usd = applyUsd(t, undefined, { messageId: 'm1', usdEstimate: 0.01 });
  // O mesmo uso chega de novo (bloco seguinte e message_delta): só soma o que cresceu.
  usd = applyUsd(t, usd, { messageId: 'm1#advisor', usdEstimate: 0.06 }) ?? usd;
  assert.equal(applyUsd(t, usd, { messageId: 'm1#advisor', usdEstimate: 0.06 }), undefined);
  assert.ok(Math.abs((usd ?? 0) - 0.07) < 1e-9);
  // O CLI soma o advisor no total_cost_usd: o real troca as duas estimativas.
  usd = applyUsd(t, usd, { costUsdTotal: 0.08 });
  assert.ok(Math.abs((usd ?? 0) - 0.08) < 1e-9);
});

test('resultado legível, cifrado e erro', () => {
  assert.deepEqual(advisorResultText({ type: 'advisor_result', text: 'Leia o teste antes.' }), { text: 'Leia o teste antes.', isError: false });
  assert.deepEqual(advisorResultText({ type: 'advisor_redacted_result', encrypted_content: 'xx' }), { text: 'orientação cifrada', isError: false });
  assert.deepEqual(advisorResultText({ type: 'advisor_tool_result_error', error_code: 'overloaded' }), { text: 'o advisor falhou: overloaded', isError: true });
});

test('linha do advisor no gasto do agente', () => {
  const lines = budgetLines({ spent: { tokens: 50_000, minutes: 2, usd: 0.9, advisor: { tokens: 12_000, usd: 0.3 } } });
  assert.equal(lines.at(-1), 'advisor: 12k tokens, US$ 0,30');
  assert.ok(!budgetLines({ spent: { tokens: 10, minutes: 1 } }).some((l) => l.startsWith('advisor')));
});

if (failed) {
  console.log(`\n${failed} teste(s) falharam`);
  process.exit(1);
}
console.log('\ntodos os testes passaram');
