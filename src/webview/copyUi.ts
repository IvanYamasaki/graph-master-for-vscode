import { blockText, codeLang, pickCopyText, type CopyChoice } from './copyLogic';

/** navigator.clipboard e, se o webview negar, o velho textarea + execCommand. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

function icon(name: string): HTMLElement {
  const el = document.createElement('span');
  el.className = `codicon codicon-${name}`;
  el.setAttribute('aria-hidden', 'true');
  return el;
}

/** Troca o ícone do botão por um check por 1,5 s. */
export function flashCopied(btn: HTMLElement, name = 'copy'): void {
  btn.replaceChildren(icon('check'));
  window.setTimeout(() => btn.replaceChildren(icon(name)), 1500);
}

/** Trecho que o usuário selecionou dentro de `root`; recorta o que passar das bordas. Vazio se não há seleção ali. */
export function selectedTextIn(root: HTMLElement): string {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) {
    return '';
  }
  const range = sel.getRangeAt(0);
  if (!range.intersectsNode(root)) {
    return '';
  }
  if (sel.anchorNode && sel.focusNode && root.contains(sel.anchorNode) && root.contains(sel.focusNode)) {
    return sel.toString();
  }
  const bounds = document.createRange();
  bounds.selectNodeContents(root);
  const clipped = range.cloneRange();
  if (clipped.compareBoundaryPoints(Range.START_TO_START, bounds) < 0) {
    clipped.setStart(bounds.startContainer, bounds.startOffset);
  }
  if (clipped.compareBoundaryPoints(Range.END_TO_END, bounds) > 0) {
    clipped.setEnd(bounds.endContainer, bounds.endOffset);
  }
  return clipped.toString();
}

/** O que o botão de copiar da mensagem copia agora: a seleção dentro dela, senão a mensagem inteira. */
export function copyChoice(root: HTMLElement, whole: string): CopyChoice {
  return pickCopyText(selectedTextIn(root), whole);
}

// Nós que o Markdown não escreve: a barra de ações, a marca "N ações", o rodapé da thread e as ferramentas do bloco.
// Ficam fora da contagem de caracteres, porque o repaint os apaga.
const FOREIGN = '.sl-actions, .sl-details-tag, .thread-foot, .code-tools';

function textNodes(root: HTMLElement): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(FOREIGN) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    out.push(n as Text);
  }
  return out;
}

function offsetOf(nodes: Text[], node: Node, at: number): number | undefined {
  let sum = 0;
  for (const t of nodes) {
    if (t === node) {
      return sum + at;
    }
    sum += t.length;
  }
  // Âncora num elemento (clique triplo): conta o texto que vem antes dela.
  if (node.nodeType === Node.ELEMENT_NODE) {
    const before = document.createRange();
    before.setStart(node.ownerDocument!, 0);
    before.setEnd(node, at);
    let total = 0;
    for (const t of nodes) {
      if (before.comparePoint(t, t.length) > 0) {
        break;
      }
      total += t.length;
    }
    return total;
  }
  return undefined;
}

export interface SavedSelection {
  anchor: number;
  focus: number;
}

/** Guarda a seleção como posições de caractere no texto de `root`, para sobreviver a um innerHTML. */
export function saveSelection(root: HTMLElement): SavedSelection | undefined {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.anchorNode || !sel.focusNode || !root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) {
    return undefined;
  }
  const nodes = textNodes(root);
  const anchor = offsetOf(nodes, sel.anchorNode, sel.anchorOffset);
  const focus = offsetOf(nodes, sel.focusNode, sel.focusOffset);
  return anchor === undefined || focus === undefined ? undefined : { anchor, focus };
}

function pointAt(nodes: Text[], offset: number): [Node, number] | undefined {
  let left = offset;
  for (const t of nodes) {
    if (left <= t.length) {
      return [t, left];
    }
    left -= t.length;
  }
  const last = nodes.at(-1);
  return last ? [last, last.length] : undefined;
}

/** Refaz a seleção guardada em cima do texto novo (o streaming só acrescenta no fim, as posições antigas valem). */
export function restoreSelection(root: HTMLElement, saved: SavedSelection | undefined): void {
  if (!saved) {
    return;
  }
  const nodes = textNodes(root);
  const a = pointAt(nodes, saved.anchor);
  const f = pointAt(nodes, saved.focus);
  if (a && f) {
    window.getSelection()?.setBaseAndExtent(a[0], a[1], f[0], f[1]);
  }
}

/** Todo bloco de código (pre) do Markdown ganha um invólucro com a linguagem e o botão de copiar só dele. */
export function decorateCodeBlocks(root: HTMLElement): void {
  for (const pre of Array.from(root.querySelectorAll('pre'))) {
    if (pre.parentElement?.classList.contains('code-block')) {
      continue;
    }
    const code = pre.querySelector('code');
    const lang = codeLang(code?.className ?? '');
    const wrap = document.createElement('div');
    wrap.className = 'code-block';
    const tools = document.createElement('div');
    tools.className = 'code-tools';
    tools.contentEditable = 'false';
    if (lang) {
      const tag = document.createElement('span');
      tag.className = 'code-lang';
      tag.textContent = lang;
      tools.append(tag);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-btn code-copy';
    btn.title = 'Copiar o bloco';
    btn.setAttribute('aria-label', 'Copiar o bloco');
    btn.append(icon('copy'));
    // Não tira o foco nem a seleção que já existe na conversa.
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      void copyText(blockText((code ?? pre).textContent ?? '')).then((ok) => ok && flashCopied(btn));
    });
    tools.append(btn);
    pre.replaceWith(wrap);
    wrap.append(pre, tools);
  }
}
