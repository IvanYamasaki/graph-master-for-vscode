/**
 * Testes da lógica do visualizador de imagens e do formato do show_image. Sem VS Code nem DOM:
 *   npx esbuild src/webview/imageViewer.test.ts --bundle --platform=node --outfile=$TEMP/imageViewer.test.js && node $TEMP/imageViewer.test.js
 */
import * as assert from 'node:assert/strict';
import { MAX_ZOOM, clampPan, clampScale, fitScale, gridLayout, stepIndex, toggleScale, viewableIndex, zoomAt, type Dims, type ViewerItem } from './imageViewer';
import { formatShowImage, imageMime, parseShowImage } from '../chat/imageShare';

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

const big: Dims = { nw: 2000, nh: 1000, sw: 1000, sh: 800 };
const small: Dims = { nw: 200, nh: 100, sw: 1000, sh: 800 };

test('navegação dá a volta nas pontas', () => {
  assert.equal(stepIndex(0, -1, 5), 4);
  assert.equal(stepIndex(4, 1, 5), 0);
  assert.equal(stepIndex(2, 1, 5), 3);
  assert.equal(stepIndex(3, 0, 5), 3);
  assert.equal(stepIndex(0, 1, 0), 0);
});

test('ajuste à tela reduz a grande e não amplia a pequena', () => {
  assert.equal(fitScale(big), 0.5);
  assert.equal(fitScale(small), 1);
  assert.equal(fitScale({ nw: 0, nh: 0, sw: 100, sh: 100 }), 1);
});

test('zoom fica entre o ajuste e o máximo', () => {
  assert.equal(clampScale(0.1, 0.5), 0.5);
  assert.equal(clampScale(100, 0.5), MAX_ZOOM);
  assert.equal(clampScale(2, 0.5), 2);
  assert.equal(clampScale(Number.NaN, 0.5), 0.5);
});

test('imagem menor que o palco fica centrada; maior só anda até a borda', () => {
  assert.deepEqual(clampPan({ scale: 0.5, x: 40, y: -30 }, big), { scale: 0.5, x: 0, y: 0 });
  // 2000 px a 100% num palco de 1000: anda 500 para cada lado; 1000 px de altura em 800: 100.
  assert.deepEqual(clampPan({ scale: 1, x: 900, y: -900 }, big), { scale: 1, x: 500, y: -100 });
});

test('zoom no cursor mantém parado o ponto sob ele', () => {
  const v = zoomAt({ scale: 0.5, x: 0, y: 0 }, 1, 100, 50, big);
  assert.equal(v.scale, 1);
  // O ponto da imagem sob o cursor era (100 - 0) / 0.5 = 200 px do centro; a 100% continua em 100 px na tela.
  assert.equal(100 - v.x, 200);
  assert.equal(50 - v.y, 100);
  const out = zoomAt(v, 0.01, 0, 0, big);
  assert.deepEqual(out, { scale: 0.5, x: 0, y: 0 });
});

test('duplo clique alterna ajuste e 100% (ou 200% se já cabia)', () => {
  assert.equal(toggleScale(0.5, 0.5), 1);
  assert.equal(toggleScale(1, 0.5), 0.5);
  assert.equal(toggleScale(1, 1), 2);
  assert.equal(toggleScale(2, 1), 1);
});

test('grade mostra até 4 e o resto vira +N', () => {
  assert.deepEqual(gridLayout(1), { shown: 1, more: 0 });
  assert.deepEqual(gridLayout(4), { shown: 4, more: 0 });
  assert.deepEqual(gridLayout(7), { shown: 4, more: 3 });
});

test('imagem que não carregou fica fora da navegação sem perder a posição', () => {
  const items: ViewerItem[] = [{ src: 'data:a' }, { error: 'sumiu' }, { src: 'data:c' }];
  const r = viewableIndex(items, 2);
  assert.equal(r.list.length, 2);
  assert.equal(r.index, 1);
  assert.equal(viewableIndex(items, 1).index, 0);
});

test('resultado do show_image ida e volta, com legenda e recusas', () => {
  const text = formatShowImage({ paths: ['C:\\p\\a.png', '/tmp/b c.webp'], caption: 'Tela de login\ncom erro' }, ['x.bmp: formato não aceito']);
  assert.match(text, /2 imagens mostradas/);
  assert.match(text, /x\.bmp/);
  assert.deepEqual(parseShowImage(text), { paths: ['C:\\p\\a.png', '/tmp/b c.webp'], caption: 'Tela de login\ncom erro' });
  assert.deepEqual(parseShowImage(formatShowImage({ paths: ['a.png'] }, [])), { paths: ['a.png'], caption: undefined });
});

test('texto sem a marca ou com marca quebrada não vira bolha', () => {
  assert.equal(parseShowImage('Nenhuma imagem mostrada'), undefined);
  assert.equal(parseShowImage('show_image: {quebrado'), undefined);
  assert.equal(parseShowImage('show_image: {"paths":[]}'), undefined);
});

test('formatos aceitos pela extensão', () => {
  assert.equal(imageMime('a.PNG'), 'image/png');
  assert.equal(imageMime('a.jpeg'), 'image/jpeg');
  assert.equal(imageMime('pasta.v2/a.svg'), 'image/svg+xml');
  assert.equal(imageMime('a.bmp'), undefined);
  assert.equal(imageMime('sem-extensao'), undefined);
});

if (failed) {
  console.log(`\n${failed} falha(s)`);
  process.exit(1);
}
console.log('\ntodos passaram');
