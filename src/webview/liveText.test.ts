/**
 * Testes das falas em streaming (deltas, texto final e stream que caiu no meio). Sem VS Code:
 *   npx esbuild src/webview/liveText.test.ts --bundle --platform=node --outfile=$TEMP/liveText.test.js && node $TEMP/liveText.test.js
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LiveTexts } from './liveText';

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

/** Uma "bolha" é só o texto que ela mostra; `log` é a ordem em que entraram no chat. */
interface Bubble {
  shown: string;
}

/** Reproduz o que o main.ts faz com cada mensagem do host e devolve o que ficou na tela. */
function chat(adopt = true) {
  const log: Bubble[] = [];
  const live = new LiveTexts<Bubble>(() => ({ shown: '' }), () => adopt);
  return {
    log,
    live,
    delta(msgId: string, index: number, text: string) {
      const { block, created } = live.delta(msgId, index, text);
      if (created) {
        log.push(block.el);
      }
      if (!block.final) {
        block.el.shown = block.text;
      }
    },
    final(msgId: string, text: string) {
      const block = live.final(msgId);
      if (block) {
        block.el.shown = text;
      } else if (text.trim()) {
        log.push({ shown: text });
      }
    },
    screen: () => log.map((b) => b.shown),
  };
}

const FULL =
  '5. **Ameaças à validade.** Por exemplo: closer que pergunta mais a quem já ia comprar, quem tem transcrição ser diferente de quem não tem.\n6. **Desenho do estudo definitivo.**';
const pieces = (s: string, n: number) => s.match(new RegExp(`[\\s\\S]{1,${n}}`, 'g'))!;
const CUT = FULL.slice(0, FULL.indexOf('quem tem') + 2);

test('caminho normal: deltas e depois o texto final, uma bolha com o texto inteiro', () => {
  const c = chat();
  for (const p of pieces(FULL, 7)) {
    c.delta('msg_B', 0, p);
  }
  c.final('msg_B', FULL);
  assert.deepEqual(c.screen(), [FULL]);
});

test('stream caiu em "qu" e a resposta voltou sem streaming, com outro id: uma bolha, texto inteiro', () => {
  const c = chat();
  for (const p of pieces(CUT, 9)) {
    c.delta('msg_dead', 0, p);
  }
  assert.ok(c.screen()[0].endsWith('comprar, qu'));
  c.final('msg_B', FULL);
  // Antes da correção: ['...comprar, qu', FULL] (a cortada ficava e a inteira entrava embaixo).
  assert.deepEqual(c.screen(), [FULL]);
});

test('stream caiu e a nova tentativa veio em streaming com outro id: assume a bolha cortada', () => {
  const c = chat();
  for (const p of pieces(CUT, 9)) {
    c.delta('msg_dead', 0, p);
  }
  c.delta('msg_B', 0, '5. **Amea');
  assert.deepEqual(c.screen(), ['5. **Amea']);
  for (const p of pieces(FULL.slice('5. **Amea'.length), 5)) {
    c.delta('msg_B', 0, p);
  }
  c.final('msg_B', FULL);
  assert.deepEqual(c.screen(), [FULL]);
});

test('duas mensagens do mesmo turno (texto, ferramenta, texto) continuam em duas bolhas', () => {
  const c = chat();
  c.delta('msg_A', 1, 'Vou criar o agente.');
  c.final('msg_A', 'Vou criar o agente.');
  c.delta('msg_B', 0, 'Criei o agente a13.');
  c.final('msg_B', 'Criei o agente a13.');
  assert.deepEqual(c.screen(), ['Vou criar o agente.', 'Criei o agente a13.']);
});

test('dois trechos de texto da mesma mensagem: cada final vai para o seu', () => {
  const c = chat();
  c.delta('msg_A', 0, 'um');
  c.final('msg_A', 'um.');
  c.delta('msg_A', 2, 'dois');
  c.final('msg_A', 'dois.');
  assert.deepEqual(c.screen(), ['um.', 'dois.']);
});

test('delta atrasado depois do texto final não repinta o parcial', () => {
  const c = chat();
  c.delta('msg_B', 0, '5. **Ameaças');
  c.final('msg_B', FULL);
  c.delta('msg_B', 0, ' à valid');
  assert.deepEqual(c.screen(), [FULL]);
});

test('fim do turno: o órfão não é assumido pela fala do turno seguinte', () => {
  const c = chat();
  c.delta('msg_dead', 0, 'texto que se perdeu, qu');
  c.live.settle();
  c.final('msg_next', 'Resposta do turno seguinte.');
  assert.deepEqual(c.screen(), ['texto que se perdeu, qu', 'Resposta do turno seguinte.']);
});

test('Codex (sem assumir órfão): um bloco por item, como antes', () => {
  const c = chat(false);
  c.delta('item_1', 0, 'primeiro');
  c.delta('item_2', 0, 'segundo');
  c.final('item_1', 'primeiro.');
  c.final('item_2', 'segundo.');
  assert.deepEqual(c.screen(), ['primeiro.', 'segundo.']);
});

test('main.ts: a pintura da fala nunca fica no argumento de uma chamada opcional', () => {
  // `companionUi?.markRaw(el, mainMd(el, text))` não avalia mainMd no chat principal (companionUi não existe): o texto
  // final nunca repintava a bolha, que ficava com o que os deltas tinham pintado, cortada se faltasse algum.
  const src = fs.readFileSync(path.join(__dirname.includes('src') ? __dirname : path.resolve('src/webview'), 'main.ts'), 'utf8');
  const bad = src.split('\n').filter((line) => /\?\.\w+\([^;]*\b(mainMd|md)\(/.test(line));
  assert.deepEqual(bad, []);
});

if (failed) {
  console.log(`\n${failed} falharam`);
  process.exit(1);
}
console.log('\ntodos os testes passaram');
