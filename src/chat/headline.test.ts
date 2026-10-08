/**
 * Testes da conclusão curta do relatório. Sem VS Code:
 *   npx esbuild src/chat/headline.test.ts --bundle --platform=node --outfile=$TEMP/headline.test.js && node $TEMP/headline.test.js
 */
import * as assert from 'node:assert/strict';
import { reportHeadline } from './headline';

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

test('linha "Resumo:" ganha, com markdown limpo', () => {
  assert.equal(reportHeadline('# Relatório\n\n**Resumo:** 84 calls lidas, `3` sem transcrição.\n\nDetalhes...'), '84 calls lidas, 3 sem transcrição.');
  assert.equal(reportHeadline('- Conclusão — score v0 acerta 71% dos fechamentos'), 'score v0 acerta 71% dos fechamentos');
});

test('sem marcador: primeira frase de verdade, pulando título', () => {
  assert.equal(reportHeadline('## Resultado da análise\n\nO Hotlead superestima leads frios. Isso acontece porque...'), 'O Hotlead superestima leads frios.');
});

test('texto longo é cortado na palavra', () => {
  const out = reportHeadline(`Resumo: ${'palavra '.repeat(40)}`, 50);
  assert.ok(out.length <= 50);
  assert.ok(out.endsWith('…'));
  assert.ok(!out.includes('palavr…'));
});

test('vazio fica vazio', () => {
  assert.equal(reportHeadline(undefined), '');
  assert.equal(reportHeadline('   '), '');
});

if (failed) {
  console.log(`\n${failed} falharam`);
  process.exit(1);
}
console.log('\ntodos os testes passaram');
