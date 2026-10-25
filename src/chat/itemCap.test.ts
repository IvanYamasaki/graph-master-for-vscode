/**
 * Testes do teto de itens por agente (itemCap). Sem VS Code:
 *   npx esbuild src/chat/itemCap.test.ts --bundle --platform=node --outfile=$TEMP/itemCap.test.js && node $TEMP/itemCap.test.js
 */
import * as assert from 'node:assert/strict';
import { ITEM_LIMITS, appendCapped, capItem, clipInput, clipText, dropOldImages, windowHistory } from './itemCap';
import type { HistoryItem } from './protocol';

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

const L = { maxItems: 8, resultChars: 100, inputChars: 50, keepImages: 2 };
const result = (id: string, text = 'ok', images?: string[]): HistoryItem => ({ kind: 'toolResult', id, text, isError: false, images });
const tool = (id: string): HistoryItem => ({ kind: 'tool', id, name: 'Bash', input: { command: 'ls' } });

test('clipText corta e diz quanto saiu; texto curto volta igual', () => {
  assert.equal(clipText('abc', 10), 'abc');
  const out = clipText('x'.repeat(130), 100);
  assert.ok(out.startsWith('x'.repeat(100)));
  assert.match(out, /30 caracteres omitidos/);
});

test('capItem corta resultado de ferramenta e deixa fala do agente inteira', () => {
  const big = 'y'.repeat(500);
  const r = capItem(result('1', big), L);
  assert.equal(r.kind, 'toolResult');
  assert.ok(r.kind === 'toolResult' && r.text.length < 200 && r.text.includes('400 caracteres omitidos'));
  const t: HistoryItem = { kind: 'text', text: big };
  assert.equal(capItem(t, L), t, 'o relatório sai da fala: não pode ser cortada');
  const u: HistoryItem = { kind: 'user', text: big };
  assert.equal(capItem(u, L), u);
});

test('clipInput corta strings fundas e mantém o objeto quando nada passa do limite', () => {
  const small = { command: 'ls', n: 3 };
  assert.equal(clipInput(small, 50), small);
  const big = { edits: [{ old_string: 'a'.repeat(200), new_string: 'b' }], keep: 1 };
  const out = clipInput(big, 50) as typeof big;
  assert.notEqual(out, big);
  assert.ok(out.edits[0].old_string.length < 100 && out.edits[0].old_string.includes('150 caracteres omitidos'));
  assert.equal(out.edits[0].new_string, 'b');
  assert.equal(big.edits[0].old_string.length, 200, 'o original não muda');
});

test('appendCapped guarda o item cortado e só tira capturas das mais antigas', () => {
  const items: HistoryItem[] = [];
  for (let i = 0; i < 5; i++) {
    appendCapped(items, tool(`t${i}`), L);
    appendCapped(items, result(`t${i}`, 'ok', [`img${i}`]), L);
  }
  const withImages = items.filter((i) => i.kind === 'toolResult' && i.images?.length).map((i) => (i as { id: string }).id);
  assert.deepEqual(withImages, ['t3', 't4'], 'keepImages = 2 mais recentes');
  const gone = items.find((i) => i.kind === 'toolResult' && i.id === 't0');
  assert.ok(gone && gone.kind === 'toolResult' && gone.images === undefined && gone.text === 'ok', 'o texto fica, só a imagem sai');
});

test('appendCapped mantém o teto de itens, em lote, e conta o que saiu', () => {
  const items: HistoryItem[] = [];
  let dropped = 0;
  for (let i = 0; i < 100; i++) {
    dropped += appendCapped(items, { kind: 'text', text: `msg ${i}` }, L).dropped;
  }
  assert.ok(items.length <= L.maxItems + Math.ceil(L.maxItems / 4), `ficou com ${items.length}`);
  assert.ok(items.length >= L.maxItems);
  assert.equal(dropped + items.length, 100, 'nada some sem ser contado');
  const last = items.at(-1);
  assert.deepEqual(last, { kind: 'text', text: 'msg 99' }, 'o mais novo fica');
});

test('o corte não deixa resultado órfão no começo nem perde a última fala', () => {
  const items: HistoryItem[] = [];
  let dropped = 0;
  const total = (n: number) => dropped + items.length === n;
  let n = 0;
  for (let i = 0; i < 12; i++) {
    for (const it of [tool(`t${i}`), result(`t${i}`)]) {
      dropped += appendCapped(items, it, L).dropped;
      n++;
    }
  }
  dropped += appendCapped(items, { kind: 'text', text: 'relatório final' }, L).dropped;
  n++;
  assert.ok(items[0].kind !== 'toolResult', 'primeiro item não é resultado sem ferramenta');
  assert.equal(items.filter((i) => i.kind === 'text').at(-1)?.kind === 'text' && (items.at(-1) as { text: string }).text, 'relatório final');
  assert.ok(total(n));
});

test('o limite padrão aguenta 3000 chamadas de 200 KB com memória limitada', () => {
  const items: HistoryItem[] = [];
  const blob = 'z'.repeat(200_000);
  for (let i = 0; i < 3000; i++) {
    appendCapped(items, tool(`t${i}`));
    appendCapped(items, result(`t${i}`, blob));
  }
  const chars = items.reduce((n, it) => n + (it.kind === 'toolResult' ? it.text.length : 0), 0);
  assert.ok(items.length <= ITEM_LIMITS.maxItems * 1.25 + 1);
  assert.ok(chars <= (ITEM_LIMITS.maxItems * 1.25 * (ITEM_LIMITS.resultChars + 60)) / 2 + 1000, `guardou ${chars} caracteres`);
});

test('windowHistory pega os últimos itens, corta, e não mexe no array de entrada', () => {
  const items: HistoryItem[] = [];
  for (let i = 0; i < 6; i++) {
    items.push({ kind: 'user', text: `u${i}` }, tool(`t${i}`), result(`t${i}`, 'w'.repeat(300), [`img${i}`]));
  }
  const w = windowHistory(items, { maxItems: 7, resultChars: 100, inputChars: 50, keepImages: 2 });
  assert.equal(w.items.length + w.dropped, items.length);
  assert.ok(w.items[0].kind !== 'toolResult');
  const imgs = w.items.filter((i) => i.kind === 'toolResult' && i.images?.length);
  assert.equal(imgs.length, 2);
  assert.ok(w.items.every((i) => i.kind !== 'toolResult' || i.text.length < 200));
  const orig = items.filter((i) => i.kind === 'toolResult' && i.images?.length);
  assert.equal(orig.length, 6, 'o transcrito completo segue com as imagens (as threads leem dele)');
});

test('windowHistory não corta nada quando cabe', () => {
  const items: HistoryItem[] = [{ kind: 'user', text: 'oi' }, { kind: 'text', text: 'olá' }];
  const w = windowHistory(items);
  assert.equal(w.dropped, 0);
  assert.deepEqual(w.items, items);
});

test('dropOldImages devolve quantas imagens soltou', () => {
  const items = [result('a', 'x', ['1', '2']), result('b', 'x', ['3']), result('c', 'x', ['4'])];
  assert.equal(dropOldImages(items, 1), 3);
});

if (failed) {
  console.log(`\n${failed} teste(s) falharam`);
  process.exit(1);
}
console.log('\ntudo certo');
