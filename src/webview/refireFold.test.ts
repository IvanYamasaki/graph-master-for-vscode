/**
 * Testes da regra de dobrar re-disparos vazios. Sem VS Code:
 *   npx esbuild src/webview/refireFold.test.ts --bundle --platform=node --outfile=$TEMP/refireFold.test.js && node $TEMP/refireFold.test.js
 */
import * as assert from 'node:assert/strict';
import { freshSurge, isNoNovelty, normalize, similar, step } from './refireFold';

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

test('normalize tira acento, caixa e pontuação', () => {
  assert.equal(normalize('Resumo dado. Nada a acrescentar!'), 'resumo dado nada a acrescentar');
  assert.equal(normalize('Nothing further.'), 'nothing further');
});

test('similar: iguais 1, nada em comum 0', () => {
  assert.equal(similar('nada a acrescentar', 'nada a acrescentar'), 1);
  assert.equal(similar('nada a acrescentar', 'tudo diferente aqui'), 0);
});

test('frase-sinal curta conta como sem novidade', () => {
  assert.equal(isNoNovelty('Nothing further.', []), true);
  assert.equal(isNoNovelty('Done. No further response.', []), true);
  assert.equal(isNoNovelty('Resumo dado. Nada mais a acrescentar.', []), true);
});

test('"done" não bate dentro de outra palavra (abandoned)', () => {
  assert.equal(isNoNovelty('I abandoned the earlier approach and rewrote the parser from scratch.', []), false);
});

test('fala parecida com uma recente conta como sem novidade', () => {
  const recent = [normalize('Entendi, não há mais o que fazer aqui.')];
  assert.equal(isNoNovelty('Não há mais o que fazer aqui.', recent), true);
});

test('fala nova (longa, código, lista, link, pergunta) nunca é vazia', () => {
  assert.equal(isNoNovelty('```ts\nconst x = 1;\n```', []), false);
  assert.equal(isNoNovelty('- item novo\n- outro item', []), false);
  assert.equal(isNoNovelty('Veja https://exemplo.com para detalhes.', []), false);
  assert.equal(isNoNovelty('Done, mas você quer que eu continue?', []), false);
  assert.equal(isNoNovelty('x'.repeat(300), []), false);
});

test('surto: primeira fala nunca dobra, mesmo curta e repetida', () => {
  let s = freshSurge();
  const r = step(s, 'Nothing further.');
  assert.equal(r.fold, false);
});

test('surto típico: conteúdo real, primeira vazia aparece, da segunda em diante dobra', () => {
  let s = freshSurge();
  let r = step(s, 'Entreguei o feedback no arquivo relatorio.md com os pontos achados.');
  assert.equal(r.fold, false); // conteúdo real
  s = r.state;
  r = step(s, 'Nothing further.');
  assert.equal(r.fold, false); // primeira vazia aparece
  s = r.state;
  r = step(s, 'Nothing further. This is complete.');
  assert.equal(r.fold, true); // segunda vazia dobra
  s = r.state;
  r = step(s, 'Done. No further response.');
  assert.equal(r.fold, true); // terceira também
});

test('fala com novidade no meio quebra a sequência de vazias', () => {
  let s = freshSurge();
  s = step(s, 'Primeira resposta de verdade com conteúdo.').state;
  s = step(s, 'Nada a acrescentar.').state; // primeira vazia (aparece)
  let r = step(s, 'Nada a acrescentar.'); // dobra
  assert.equal(r.fold, true);
  s = r.state;
  r = step(s, 'Na verdade, encontrei um ponto novo: o endpoint /login aceita senha vazia.');
  assert.equal(r.fold, false); // novidade quebra
  s = r.state;
  r = step(s, 'Nada a acrescentar.'); // volta a ser a primeira vazia: aparece
  assert.equal(r.fold, false);
});

if (failed) {
  console.error(`\n${failed} teste(s) falharam`);
  process.exit(1);
}
console.log('\ntodos ok');
