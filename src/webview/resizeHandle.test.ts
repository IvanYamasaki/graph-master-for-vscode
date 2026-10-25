import { clampPanelWidth } from './resizeHandle';

function eq(a: unknown, b: unknown, msg: string): void {
  if (a !== b) {
    console.error(`FALHOU ${msg}: ${a} != ${b}`);
    process.exit(1);
  }
}
eq(clampPanelWidth(100, 1000), 260, 'mínimo');
eq(clampPanelWidth(900, 1000), 700, 'máximo 70%');
eq(clampPanelWidth(420, 1000), 420, 'dentro');
eq(clampPanelWidth(500, 300), 210, 'janela pequena: máximo vence');
eq(clampPanelWidth(NaN, 1000), 260, 'NaN');
console.log('ok');
