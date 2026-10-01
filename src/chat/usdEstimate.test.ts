/**
 * Testes da estimativa de US$ por mensagem e da troca pelo valor real no fim do turno. Sem VS Code:
 *   npx esbuild src/chat/usdEstimate.test.ts --bundle --platform=node --outfile=$TEMP/usdEstimate.test.js && node $TEMP/usdEstimate.test.js
 */
import * as assert from 'node:assert/strict';
import { applyUsd, estimateUsd, newUsdTrack } from './usdEstimate';

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

const close = (a: number | undefined, b: number): void => assert.ok(a !== undefined && Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('estimativa: entrada, leitura de cache a 10%, escrita a 125% e saída, pelo preço do modelo', () => {
  // opus: US$ 4 entrada, 20 saída por milhão.
  const usd = estimateUsd({ input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'claude-opus-5-5');
  close(usd, 4 + 0.4 + 5 + 20);
});

test('modelo fora da tabela não estima', () => {
  assert.equal(estimateUsd({ input_tokens: 10 }, 'gpt-x'), undefined);
  assert.equal(estimateUsd(undefined, 'sonnet'), undefined);
});

test('mensagem repetida a cada bloco conta uma vez só', () => {
  const t = newUsdTrack(undefined);
  let usd = applyUsd(t, undefined, { messageId: 'm1', usdEstimate: 0.5 });
  close(usd, 0.5);
  assert.equal(applyUsd(t, usd, { messageId: 'm1', usdEstimate: 0.5 }), undefined);
  usd = applyUsd(t, usd, { messageId: 'm1', usdEstimate: 0.7 }) ?? usd;
  close(usd, 0.7);
});

test('turno longo: o gasto cresce durante o turno, sem esperar o result', () => {
  const t = newUsdTrack(undefined);
  let usd: number | undefined;
  for (let i = 0; i < 10; i++) {
    usd = applyUsd(t, usd, { messageId: `m${i}`, usdEstimate: 1 }) ?? usd;
  }
  close(usd, 10);
});

test('fim do turno troca a estimativa pelo valor real', () => {
  const t = newUsdTrack(2); // já gastou US$ 2 em turnos anteriores (total salvo)
  let usd: number | undefined = 2;
  usd = applyUsd(t, usd, { messageId: 'a', usdEstimate: 1.5 }) ?? usd;
  usd = applyUsd(t, usd, { messageId: 'b', usdEstimate: 1 }) ?? usd;
  close(usd, 4.5);
  usd = applyUsd(t, usd, { costUsdTotal: 4.2 }) ?? usd; // real do turno: 2,2
  close(usd, 4.2);
  // Turno seguinte começa do zero na estimativa.
  usd = applyUsd(t, usd, { messageId: 'a', usdEstimate: 0.3 }) ?? usd;
  close(usd, 4.5);
});

test('turno interrompido mantém a estimativa (o result nunca chega)', () => {
  const t = newUsdTrack(undefined);
  const usd = applyUsd(t, undefined, { messageId: 'x', usdEstimate: 3.25 });
  close(usd, 3.25);
});

test('processo que recomeça o total do zero: o total novo é todo gasto novo', () => {
  const t = newUsdTrack(5);
  let usd: number | undefined = 5;
  usd = applyUsd(t, usd, { messageId: 'a', usdEstimate: 0.4 }) ?? usd;
  usd = applyUsd(t, usd, { costUsdTotal: 0.5 }) ?? usd;
  close(usd, 5.5);
});

test('CLI que cai no meio do turno: a estimativa do turno morto fica quando o processo novo fecha um turno', () => {
  const t = newUsdTrack(undefined);
  let usd: number | undefined;
  usd = applyUsd(t, usd, { messageId: 'a', usdEstimate: 2 }) ?? usd; // turno morto, sem result
  applyUsd(t, usd, { processStart: true });
  usd = applyUsd(t, usd, { messageId: 'b', usdEstimate: 0.4 }) ?? usd;
  usd = applyUsd(t, usd, { costUsdTotal: 0.5 }) ?? usd; // processo novo: real do turno 0,5
  close(usd, 2.5);
});

if (failed) {
  console.log(`\n${failed} teste(s) falharam`);
  process.exit(1);
}
console.log('\ntodos os testes da estimativa de custo passaram');
