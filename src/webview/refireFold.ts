/**
 * Regra pura para dobrar re-disparos vazios do Claude. Quando um Stop hook de sessão (o /goal do Claude Code instala
 * um) re-dispara o Claude turno após turno sem que a condição feche, ele responde falas curtas e repetidas ("nada a
 * acrescentar", "nothing further", "done"). Aqui se decide, sem tocar no DOM, quando uma fala não traz novidade e
 * quando ela deve sumir dentro de uma linha recolhida. O main.ts cuida do desenho; os testes cobrem só estas funções.
 */

/** Frases (já normalizadas) que, numa fala curta, são sinal forte de que o Claude não acrescentou nada. */
export const SIGNALS: readonly string[] = [
  'nada a acrescentar',
  'nada mais a acrescentar',
  'nada mais a dizer',
  'resumo dado',
  'resposta final',
  'ja respondi',
  'nothing further',
  'no further response',
  'no further',
  'nothing more to add',
  'nothing to add',
  'nothing else to add',
  'final answer',
  'this is complete',
  'this is done',
  'done',
  'complete',
  'completo',
];

/** Acima disto a fala é longa demais para contar como sem novidade. */
export const MAX_PLAIN = 240;

/** Caixa baixa, sem acento, sem pontuação, espaços colapsados: a base para comparar duas falas. */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A fala tem bloco de código? */
function hasCode(text: string): boolean {
  return /```|~~~|(^|\n) {4,}\S/.test(text);
}

/** A fala tem item de lista (marcador ou número no começo de uma linha)? */
function hasList(text: string): boolean {
  return /(^|\n)\s*([-*+]|\d+[.)])\s+\S/.test(text);
}

/** A fala tem link (Markdown ou URL crua)? */
function hasLink(text: string): boolean {
  return /\]\(|https?:\/\//.test(text);
}

/** Semelhança de Jaccard entre os conjuntos de palavras de duas falas normalizadas (0 a 1). */
export function similar(a: string, b: string): number {
  const sa = new Set(a.split(' ').filter(Boolean));
  const sb = new Set(b.split(' ').filter(Boolean));
  if (sa.size === 0 || sb.size === 0) {
    return 0;
  }
  let inter = 0;
  for (const w of sa) {
    if (sb.has(w)) {
      inter++;
    }
  }
  return inter / (sa.size + sb.size - inter);
}

/**
 * A fala é "vazia de novidade"? Só quando é curta (sem código, lista, link nem pergunta, abaixo de MAX_PLAIN) E ou bate
 * uma frase-sinal ou é muito parecida com uma fala recente do mesmo surto. Conservador: na dúvida, devolve false (o
 * main mostra a fala inteira).
 */
export function isNoNovelty(text: string, recent: readonly string[]): boolean {
  const plain = text.trim();
  if (!plain || plain.length >= MAX_PLAIN) {
    return false;
  }
  if (hasCode(text) || hasList(text) || hasLink(text) || plain.includes('?')) {
    return false;
  }
  const n = normalize(text);
  const padded = ` ${n} `;
  if (SIGNALS.some((s) => padded.includes(` ${s} `))) {
    return true;
  }
  return recent.some((r) => similar(n, r) >= 0.6);
}

/** Estado do surto atual (sequência de falas do Claude sem input do usuário no meio). */
export interface SurgeState {
  /** Falas recentes do surto, já normalizadas, para comparar semelhança (guarda as últimas). */
  recent: string[];
  /** Falas sem novidade seguidas até aqui. */
  emptyChain: number;
}

export function freshSurge(): SurgeState {
  return { recent: [], emptyChain: 0 };
}

/** Quantas falas normalizadas do surto guardar para a comparação. */
const RECENT = 6;

/**
 * Decide o que fazer com uma fala nova do surto. `fold` true: ela some dentro da linha recolhida; false: aparece
 * inteira. A primeira fala do surto nunca dobra, e a primeira fala sem novidade de uma sequência também aparece (a
 * dobra começa da segunda seguida). Devolve o estado atualizado, para a próxima fala.
 */
export function step(state: SurgeState, text: string): { fold: boolean; state: SurgeState } {
  const first = state.recent.length === 0;
  const empty = isNoNovelty(text, state.recent);
  const recent = [...state.recent, normalize(text)].slice(-RECENT);
  const emptyChain = empty ? state.emptyChain + 1 : 0;
  const fold = !first && empty && emptyChain >= 2;
  return { fold, state: { recent, emptyChain } };
}
