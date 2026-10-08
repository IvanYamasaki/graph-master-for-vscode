/**
 * Visualizador de imagens do chat (capturas de ferramenta, generate_image, show_image, anexos do usuário):
 * tela cheia escura, navegação entre as imagens da mesma mensagem, zoom com a roda e duplo clique, arrastar
 * quando ampliado. Também monta a grade de miniaturas das bolhas de imagem. A lógica de zoom e navegação é
 * pura e fica no topo, testada em imageViewer.test.ts; o DOM só nasce na primeira abertura.
 */

export interface ViewerItem {
  /** Data URL ou URI de recurso do webview. Sem src: a imagem não carregou e `error` diz por quê. */
  src?: string;
  caption?: string;
  /** Caminho absoluto no disco, quando há: liga "Abrir no editor" e o "Salvar" copia o arquivo. */
  path?: string;
  name?: string;
  error?: string;
}

export interface ViewerActions {
  open?(item: ViewerItem): void;
  save?(item: ViewerItem): void;
}

// ---------- Lógica pura ----------

export const MAX_ZOOM = 8;
/** Grade da bolha: até 4 miniaturas; a quarta leva "+N" quando há mais. */
export const GRID_MAX = 4;

export interface ZoomView {
  scale: number;
  x: number;
  y: number;
}

export interface Dims {
  /** Tamanho natural da imagem. */
  nw: number;
  nh: number;
  /** Área disponível no palco. */
  sw: number;
  sh: number;
}

/** Índice seguinte ou anterior, dando a volta nas pontas. */
export function stepIndex(i: number, delta: number, n: number): number {
  if (n <= 0) {
    return 0;
  }
  return (((i + delta) % n) + n) % n;
}

/** Escala que faz a imagem caber no palco, sem ampliar imagem pequena além de 100%. */
export function fitScale(d: Dims): number {
  if (d.nw <= 0 || d.nh <= 0 || d.sw <= 0 || d.sh <= 0) {
    return 1;
  }
  return Math.min(1, d.sw / d.nw, d.sh / d.nh);
}

/** Zoom entre o ajuste à tela e MAX_ZOOM. */
export function clampScale(scale: number, fit: number): number {
  if (!Number.isFinite(scale)) {
    return fit;
  }
  return Math.min(Math.max(MAX_ZOOM, fit), Math.max(fit, scale));
}

/** Deslocamento máximo para a imagem ampliada não sair do palco; menor que o palco, fica centrada. */
export function clampPan(v: ZoomView, d: Dims): ZoomView {
  const mx = Math.max(0, (d.nw * v.scale - d.sw) / 2);
  const my = Math.max(0, (d.nh * v.scale - d.sh) / 2);
  // `|| 0` tira o -0 que sai de Math.max(-0, ...).
  return { scale: v.scale, x: Math.min(mx, Math.max(-mx, v.x)) || 0, y: Math.min(my, Math.max(-my, v.y)) || 0 };
}

/** Zoom mantendo parado o ponto sob o cursor. `px`, `py`: posição do cursor relativa ao centro do palco. */
export function zoomAt(v: ZoomView, nextScale: number, px: number, py: number, d: Dims): ZoomView {
  const fit = fitScale(d);
  const scale = clampScale(nextScale, fit);
  const k = scale / v.scale;
  return clampPan({ scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k }, d);
}

/** Duplo clique: ajustada vai para 100% (ou 200% se já cabia inteira); ampliada volta ao ajuste. */
export function toggleScale(scale: number, fit: number): number {
  if (scale > fit + 0.001) {
    return fit;
  }
  return fit < 1 ? 1 : Math.min(MAX_ZOOM, 2);
}

/** Miniaturas visíveis na grade e quantas ficam no "+N". */
export function gridLayout(n: number): { shown: number; more: number } {
  const shown = Math.min(n, GRID_MAX);
  return { shown, more: Math.max(0, n - GRID_MAX) };
}

/** Índice de `start` na lista só com as imagens que carregaram (as quebradas não entram no visualizador). */
export function viewableIndex(items: ViewerItem[], start: number): { list: ViewerItem[]; index: number } {
  const list = items.filter((it) => !!it.src);
  const target = items[start];
  const at = target ? list.indexOf(target) : -1;
  return { list, index: at >= 0 ? at : 0 };
}

// ---------- DOM ----------

type Child = Node | string | null | undefined | false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c !== null && c !== undefined && c !== false) {
      node.append(c);
    }
  }
  return node;
}

function ico(name: string): HTMLSpanElement {
  return el('span', { class: `codicon codicon-${name}`, 'aria-hidden': 'true' });
}

function btn(iconName: string, title: string, onClick: () => void, extra = ''): HTMLButtonElement {
  const b = el('button', { class: `iv-btn${extra ? ` ${extra}` : ''}`, type: 'button', title, 'aria-label': title }, ico(iconName));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

let actions: ViewerActions = {};

/** Liga os botões que dependem do host (abrir no editor, salvar). Chamado uma vez pelo chat. */
export function setImageViewerActions(a: ViewerActions): void {
  actions = a;
}

interface Viewer {
  root: HTMLDivElement;
  stage: HTMLDivElement;
  img: HTMLImageElement;
  count: HTMLSpanElement;
  name: HTMLSpanElement;
  zoomLabel: HTMLButtonElement;
  caption: HTMLDivElement;
  note: HTMLSpanElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
  openBtn: HTMLButtonElement;
  saveBtn: HTMLButtonElement;
}

let viewer: Viewer | undefined;
let items: ViewerItem[] = [];
let index = 0;
let view: ZoomView = { scale: 1, x: 0, y: 0 };
let noteTimer: ReturnType<typeof setTimeout> | undefined;

function dims(): Dims {
  const v = viewer!;
  const r = v.stage.getBoundingClientRect();
  return { nw: v.img.naturalWidth, nh: v.img.naturalHeight, sw: r.width, sh: r.height };
}

function apply(): void {
  const v = viewer!;
  v.img.style.transform = `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  v.zoomLabel.textContent = `${Math.round(view.scale * 100)}%`;
  const zoomed = view.scale > fitScale(dims()) + 0.001;
  v.root.classList.toggle('zoomed', zoomed);
}

function fit(): void {
  view = { scale: fitScale(dims()), x: 0, y: 0 };
  apply();
}

function zoomBy(factor: number, px = 0, py = 0): void {
  view = zoomAt(view, view.scale * factor, px, py, dims());
  apply();
}

function flash(text: string): void {
  const v = viewer!;
  v.note.textContent = text;
  v.note.classList.add('on');
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => v.note.classList.remove('on'), 1600);
}

/** Copia a imagem como PNG; sem permissão (imagem de outra origem, área de transferência negada), copia o caminho. */
async function copyCurrent(): Promise<void> {
  const v = viewer!;
  const item = items[index];
  try {
    const canvas = document.createElement('canvas');
    canvas.width = v.img.naturalWidth;
    canvas.height = v.img.naturalHeight;
    canvas.getContext('2d')!.drawImage(v.img, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) {
      throw new Error('sem imagem');
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    flash('Imagem copiada');
  } catch {
    if (item?.path) {
      try {
        await navigator.clipboard.writeText(item.path);
        flash('Caminho copiado');
        return;
      } catch {
        // cai no aviso abaixo
      }
    }
    flash('Não deu para copiar');
  }
}

function show(i: number): void {
  const v = viewer!;
  index = stepIndex(i, 0, items.length);
  const item = items[index];
  const many = items.length > 1;
  v.count.textContent = many ? `${index + 1}/${items.length}` : '';
  v.name.textContent = item.name ?? item.path?.split(/[\\/]/).pop() ?? '';
  v.name.title = item.path ?? '';
  v.caption.textContent = item.caption ?? '';
  v.caption.classList.toggle('hidden', !item.caption);
  v.prev.classList.toggle('hidden', !many);
  v.next.classList.toggle('hidden', !many);
  v.openBtn.classList.toggle('hidden', !item.path || !actions.open);
  v.saveBtn.classList.toggle('hidden', !actions.save || (!item.path && !item.src?.startsWith('data:')));
  v.root.classList.add('loading');
  v.img.onload = () => {
    v.root.classList.remove('loading');
    fit();
  };
  v.img.onerror = () => {
    v.root.classList.remove('loading');
    flash('A imagem não carregou');
  };
  v.img.alt = item.name ?? item.caption ?? 'Imagem';
  // Sem tirar o src antes, o mesmo endereço de novo não dispara load e a imagem ficaria escondida.
  v.img.removeAttribute('src');
  v.img.src = item.src ?? '';
}

function build(): Viewer {
  const img = el('img', { class: 'iv-img', draggable: 'false' });
  const stage = el('div', { class: 'iv-stage' }, img);
  const count = el('span', { class: 'iv-count' });
  const name = el('span', { class: 'iv-name' });
  const note = el('span', { class: 'iv-note', role: 'status' });
  const zoomLabel = el('button', { class: 'iv-btn iv-zoom', type: 'button', title: 'Ajustar à tela ou 100% (duplo clique na imagem)' });
  zoomLabel.addEventListener('click', (e) => {
    e.stopPropagation();
    view = zoomAt(view, toggleScale(view.scale, fitScale(dims())), 0, 0, dims());
    apply();
  });
  const openBtn = btn('go-to-file', 'Abrir no editor', () => actions.open?.(items[index]));
  const saveBtn = btn('save', 'Salvar uma cópia', () => actions.save?.(items[index]));
  const top = el(
    'div',
    { class: 'iv-top' },
    count,
    name,
    note,
    el('span', { class: 'iv-spacer' }),
    btn('zoom-out', 'Diminuir (-)', () => zoomBy(1 / 1.25)),
    zoomLabel,
    btn('zoom-in', 'Ampliar (+)', () => zoomBy(1.25)),
    openBtn,
    btn('copy', 'Copiar imagem', () => void copyCurrent()),
    saveBtn,
    btn('close', 'Fechar (Esc)', () => closeImageViewer()),
  );
  const prev = btn('chevron-left', 'Anterior (←)', () => show(index - 1), 'iv-nav prev');
  const next = btn('chevron-right', 'Próxima (→)', () => show(index + 1), 'iv-nav next');
  const caption = el('div', { class: 'iv-caption hidden' });
  const root = el('div', { class: 'iv hidden', role: 'dialog', 'aria-modal': 'true', tabindex: '-1', 'aria-label': 'Visualizador de imagens' }, stage, top, prev, next, caption);

  // Clique fora da imagem fecha; clique que terminou um arrasto não conta.
  let dragged = false;
  stage.addEventListener('click', (e) => {
    if (e.target === stage && !dragged) {
      closeImageViewer();
    }
  });
  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
    },
    { passive: false },
  );
  img.addEventListener('dblclick', (e) => {
    const r = stage.getBoundingClientRect();
    view = zoomAt(view, toggleScale(view.scale, fitScale(dims())), e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2, dims());
    apply();
  });
  img.addEventListener('pointerdown', (e) => {
    if (!root.classList.contains('zoomed') || e.button !== 0) {
      return;
    }
    e.preventDefault();
    dragged = false;
    const sx = e.clientX - view.x;
    const sy = e.clientY - view.y;
    const startX = e.clientX;
    const startY = e.clientY;
    img.setPointerCapture(e.pointerId);
    root.classList.add('dragging');
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 3) {
        dragged = true;
      }
      view = clampPan({ scale: view.scale, x: ev.clientX - sx, y: ev.clientY - sy }, dims());
      apply();
    };
    const up = () => {
      root.classList.remove('dragging');
      img.removeEventListener('pointermove', move);
      img.removeEventListener('pointerup', up);
      img.removeEventListener('pointercancel', up);
      setTimeout(() => (dragged = false), 0);
    };
    img.addEventListener('pointermove', move);
    img.addEventListener('pointerup', up);
    img.addEventListener('pointercancel', up);
  });
  // Captura no window: o Esc fecha só o visualizador e não chega ao chat (lá ele interromperia o turno).
  window.addEventListener(
    'keydown',
    (e) => {
      if (root.classList.contains('hidden')) {
        return;
      }
      const keys: Record<string, () => void> = {
        Escape: () => closeImageViewer(),
        ArrowLeft: () => show(index - 1),
        ArrowRight: () => show(index + 1),
        '+': () => zoomBy(1.25),
        '=': () => zoomBy(1.25),
        '-': () => zoomBy(1 / 1.25),
        '0': () => fit(),
      };
      const run = keys[e.key];
      if (run) {
        e.preventDefault();
        e.stopPropagation();
        run();
      }
    },
    true,
  );
  window.addEventListener('resize', () => {
    if (!root.classList.contains('hidden')) {
      view = clampPan({ ...view, scale: clampScale(view.scale, fitScale(dims())) }, dims());
      apply();
    }
  });
  document.body.append(root);
  return { root, stage, img, count, name, zoomLabel, caption, note, prev, next, openBtn, saveBtn };
}

/** Abre o visualizador em `startIndex`. Imagens sem src (que não carregaram) ficam de fora da navegação. */
export function openImageViewer(list: ViewerItem[], startIndex = 0): void {
  const { list: ok, index: at } = viewableIndex(list, startIndex);
  if (!ok.length) {
    return;
  }
  viewer ??= build();
  items = ok;
  viewer.root.classList.remove('hidden');
  show(at);
  viewer.root.focus();
}

/** Fecha o visualizador. False se ele já estava fechado. */
export function closeImageViewer(): boolean {
  if (!viewer || viewer.root.classList.contains('hidden')) {
    return false;
  }
  viewer.root.classList.add('hidden');
  viewer.img.removeAttribute('src');
  items = [];
  return true;
}

/**
 * Grade de miniaturas estilo WhatsApp: 1 imagem grande, 2 lado a lado, 3 ou 4 em 2x2; a quarta leva "+N"
 * quando há mais. O clique abre o visualizador com todas as imagens da grade.
 */
export function imageGrid(list: ViewerItem[], label = 'imagem'): HTMLElement {
  const { shown, more } = gridLayout(list.length);
  const grid = el('div', { class: `ig n${shown}` });
  for (let i = 0; i < shown; i++) {
    const item = list[i];
    const tile = el('button', { class: `ig-tile${item.src ? '' : ' broken'}`, type: 'button', title: item.error ?? item.caption ?? item.name ?? `Ampliar ${label}` });
    tile.setAttribute('aria-label', `Ampliar ${label} ${i + 1} de ${list.length}`);
    if (item.src) {
      tile.append(el('img', { src: item.src, alt: item.name ?? `${label} ${i + 1}`, loading: 'lazy' }));
    } else {
      tile.append(ico(item.error ? 'warning' : 'loading'), el('span', { class: 'ig-err' }, item.error ?? 'carregando'));
      if (!item.error) {
        tile.classList.add('pending');
      }
    }
    if (i === shown - 1 && more) {
      tile.append(el('span', { class: 'ig-more' }, `+${more}`));
    }
    tile.addEventListener('click', () => openImageViewer(list, i));
    grid.append(tile);
  }
  return grid;
}
