/**
 * Alça de arrastar na borda esquerda de um painel lateral fixado à direita.
 * A largura vai para uma variável CSS no :root; quem usa a variável (o painel e o
 * padding do chat) acompanha. Duplo clique volta ao padrão.
 */

export const MIN_PANEL_W = 260;
export const MAX_PANEL_FRACTION = 0.7;

/** Limita a largura a [260px, 70% da janela]. Janela pequena: o mínimo cede ao máximo. */
export function clampPanelWidth(width: number, viewport: number): number {
  const max = Math.max(1, Math.floor(viewport * MAX_PANEL_FRACTION));
  const min = Math.min(MIN_PANEL_W, max);
  if (!Number.isFinite(width)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.round(width)));
}

export interface ResizeHandleOptions {
  /** Painel que ganha a alça (precisa ser position: absolute/relative). */
  panel: HTMLElement;
  /** Variável CSS que guarda a largura, ex.: "--thread-w". */
  cssVar: string;
  /** Largura salva antes, se houver. */
  initial?: number;
  /** Chamado ao soltar o mouse (ou no duplo clique); undefined = voltou ao padrão. */
  onCommit(width: number | undefined): void;
}

export function attachResizeHandle(opts: ResizeHandleOptions): HTMLElement {
  const { panel, cssVar } = opts;
  const root = document.documentElement;
  const handle = document.createElement('div');
  handle.className = 'resize-handle';
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.title = 'Arraste para redimensionar. Duplo clique volta ao padrão.';
  panel.appendChild(handle);

  const apply = (w: number | undefined) => {
    if (w === undefined) {
      root.style.removeProperty(cssVar);
    } else {
      root.style.setProperty(cssVar, `${clampPanelWidth(w, window.innerWidth)}px`);
    }
  };
  if (opts.initial !== undefined) {
    apply(opts.initial);
  }

  let current: number | undefined;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) {
      return;
    }
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    document.body.classList.add('resizing');
    current = undefined;
  });
  handle.addEventListener('pointermove', (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) {
      return;
    }
    // O painel encosta na direita: largura = distância do ponteiro à borda direita da janela.
    current = clampPanelWidth(window.innerWidth - e.clientX, window.innerWidth);
    apply(current);
  });
  const end = (e: PointerEvent) => {
    if (!handle.hasPointerCapture(e.pointerId)) {
      return;
    }
    handle.releasePointerCapture(e.pointerId);
    handle.classList.remove('dragging');
    document.body.classList.remove('resizing');
    if (current !== undefined) {
      opts.onCommit(current);
    }
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('dblclick', () => {
    apply(undefined);
    opts.onCommit(undefined);
  });
  // Janela encolhida: reaplica o limite à largura escolhida.
  window.addEventListener('resize', () => {
    const v = root.style.getPropertyValue(cssVar);
    if (v) {
      apply(parseFloat(v));
    }
  });
  return handle;
}
