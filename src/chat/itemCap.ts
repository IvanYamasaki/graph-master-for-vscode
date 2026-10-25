/**
 * Teto do log de itens que o host e o webview guardam por agente (HistoryItem). O transcrito completo está no disco do
 * CLI; aqui ficam só os últimos itens, com resultado de ferramenta cortado e captura de tela só nos mais recentes.
 * Funções puras, sem VS Code nem DOM: o host (hub, session, panel) e o webview usam as mesmas.
 */
import type { HistoryItem } from './protocol';

export interface ItemLimits {
  /** Itens que ficam por agente. Passou de maxItems + folga, os mais antigos saem de uma vez. */
  maxItems: number;
  /** Caracteres de um resultado de ferramenta. O webview mostra 6000; o resto é folga para quem quer o texto inteiro. */
  resultChars: number;
  /** Caracteres de cada texto dentro do input de uma ferramenta (conteúdo de Write, old/new_string de Edit). */
  inputChars: number;
  /** Quantos resultados com captura de tela guardam as imagens; as mais antigas saem. */
  keepImages: number;
}

export const ITEM_LIMITS: ItemLimits = { maxItems: 400, resultChars: 12000, inputChars: 12000, keepImages: 6 };

/** Teto do histórico mandado ao webview ao abrir uma conversa: o DOM do log cresce com cada item. */
export const HISTORY_LIMITS: ItemLimits = { maxItems: 800, resultChars: 12000, inputChars: 12000, keepImages: 6 };

/** Corta o texto no limite e diz quanto saiu. Mesmo texto de volta quando cabe. */
export function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} caracteres omitidos)` : text;
}

/** Corta as strings longas de um input de ferramenta (até 4 níveis). Devolve o mesmo objeto quando nada passa do limite. */
export function clipInput(input: unknown, max: number, depth = 0): unknown {
  if (typeof input === 'string') {
    return clipText(input, max);
  }
  if (!input || typeof input !== 'object' || depth > 4) {
    return input;
  }
  if (Array.isArray(input)) {
    let changed = false;
    const out = input.map((v) => {
      const c = clipInput(v, max, depth + 1);
      changed ||= c !== v;
      return c;
    });
    return changed ? out : input;
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    const c = clipInput(v, max, depth + 1);
    changed ||= c !== v;
    out[k] = c;
  }
  return changed ? out : input;
}

/** O item com texto e input cortados. Fala do agente (`text`) e mensagem do usuário nunca são cortadas: o relatório sai delas. */
export function capItem(item: HistoryItem, limits: ItemLimits = ITEM_LIMITS): HistoryItem {
  if (item.kind === 'toolResult' && item.text.length > limits.resultChars) {
    return { ...item, text: clipText(item.text, limits.resultChars) };
  }
  if (item.kind === 'tool') {
    const input = clipInput(item.input, limits.inputChars);
    return input === item.input ? item : { ...item, input };
  }
  return item;
}

/** Tira as capturas dos resultados mais antigos, deixando as `keep` mais recentes. Muda os itens no lugar. */
export function dropOldImages(items: HistoryItem[], keep: number): number {
  let seen = 0;
  let dropped = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== 'toolResult' || !it.images?.length) {
      continue;
    }
    if (++seen > keep) {
      dropped += it.images.length;
      delete it.images;
    }
  }
  return dropped;
}

/** Resultado sem a ferramenta que o pediu (ela saiu do começo): ninguém consegue mostrá-lo. */
function dropOrphanResults(items: HistoryItem[]): void {
  let n = 0;
  while (n < items.length && items[n].kind === 'toolResult') {
    n++;
  }
  if (n) {
    items.splice(0, n);
  }
}

/**
 * Acrescenta o item (cortado) ao log do agente e mantém o teto. Devolve o item guardado e quantos itens antigos saíram
 * desta vez. Os antigos saem em lote (a cada maxItems/4 acima do teto), então o custo por item é baixo.
 */
export function appendCapped(items: HistoryItem[], item: HistoryItem, limits: ItemLimits = ITEM_LIMITS): { stored: HistoryItem; dropped: number } {
  const stored = capItem(item, limits);
  items.push(stored);
  if (stored.kind === 'toolResult' && stored.images?.length) {
    dropOldImages(items, limits.keepImages);
  }
  let dropped = 0;
  if (items.length > limits.maxItems + Math.ceil(limits.maxItems / 4)) {
    dropped = items.length - limits.maxItems;
    items.splice(0, dropped);
    const before = items.length;
    dropOrphanResults(items);
    dropped += before - items.length;
  }
  return { stored, dropped };
}

/** Janela do transcrito para mandar ao webview: os últimos itens, cortados, sem resultado órfão no começo. */
export function windowHistory(items: HistoryItem[], limits: ItemLimits = HISTORY_LIMITS): { items: HistoryItem[]; dropped: number } {
  const start = Math.max(0, items.length - limits.maxItems);
  const out = items.slice(start).map((item) => capItem(item, limits));
  const before = out.length;
  dropOrphanResults(out);
  // Copia rasa antes de mexer nas capturas: o array de entrada segue inteiro para quem lê o transcrito completo.
  const copies = out.map((it) => (it.kind === 'toolResult' && it.images ? { ...it } : it));
  dropOldImages(copies, limits.keepImages);
  return { items: copies, dropped: start + (before - out.length) };
}

/** `map.set` com teto: passou de `max` entradas, saem as mais antigas (a ordem de inserção do Map). */
export function setCapped<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    map.delete(map.keys().next().value as K);
  }
}
