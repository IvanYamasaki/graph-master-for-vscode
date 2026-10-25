/**
 * Mede a memória do log de itens por agente antes e depois do teto (itemCap). Cenário: 5 agentes, cada um com
 * 1500 chamadas de ferramenta (resultado de 40 KB) e 60 capturas de tela de 400 KB. Uso:
 *   npx esbuild scripts/measure-item-cap.ts --bundle --platform=node --outfile=$TEMP/m.js && node --expose-gc $TEMP/m.js
 */
import { appendCapped } from '../src/chat/itemCap';
import type { HistoryItem } from '../src/chat/protocol';

const gc = (globalThis as { gc?: () => void }).gc;
const heapMb = () => {
  gc?.();
  return process.memoryUsage().heapUsed / 1048576;
};

/** String plana (sem rope do V8) com o conteúdo único de `tag`, para a medição contar os bytes de verdade. */
function flat(size: number, tag: string): string {
  return Buffer.from(tag.padEnd(size, 'x'), 'latin1').toString('latin1');
}

function run(capped: boolean): number {
  const base = heapMb();
  const agents: HistoryItem[][] = [];
  for (let a = 0; a < 5; a++) {
    const items: HistoryItem[] = [];
    for (let i = 0; i < 1500; i++) {
      // Texto novo a cada chamada (Array.from força cópia): strings iguais seriam compartilhadas pelo V8.
      const text = flat(40_000, `${a}-${i}`);
      const images = i % 25 === 0 ? [flat(400_000, `data:${a}-${i}`)] : undefined;
      const tool: HistoryItem = { kind: 'tool', id: `t${i}`, name: 'Bash', input: { command: 'ls '.repeat(100) } };
      const res: HistoryItem = { kind: 'toolResult', id: `t${i}`, text, isError: false, images };
      if (capped) {
        appendCapped(items, tool);
        appendCapped(items, res);
      } else {
        items.push(tool, res);
      }
    }
    agents.push(items);
  }
  const used = heapMb() - base;
  agents.length = 0;
  return used;
}

const before = run(false);
const after = run(true);
console.log(`sem teto: ${before.toFixed(0)} MB | com teto: ${after.toFixed(0)} MB (5 agentes x 1500 chamadas x 40 KB + 60 capturas de 400 KB)`);
