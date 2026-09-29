/**
 * Vista "Hipóteses" do mapa: a árvore de hipóteses do laboratório e, embaixo, o painel do laboratório.
 *
 * Árvore. Cada nó é uma hipótese, pintada pelo veredito (suportada verde, refutada vermelho, inconclusiva cinza,
 * sem veredito neutra), com a métrica primária e a diferença ± meia largura do IC na linha de baixo, anel verde
 * pulsando enquanto tem runs sem veredito e o selo da verificação independente no canto. Arestas sólidas ligam
 * a hipótese de origem à derivada (`derived_from`); tracejadas ligam um torneio à hipótese promovida dele (o
 * promote_to_hypothesis escreve "Candidato cN do torneio tN" no enunciado, e é daí que a ligação sai). Ramo podado
 * fica esmaecido, com a borda tracejada, e não some. Mesmo layout em árvore do graph.ts: colunas por nível no
 * painel largo, lista recuada abaixo de 420px, arrastar move a câmera, roda dá zoom.
 *
 * Painel. Uma faixa com as hipóteses por status (clique destaca aquelas na árvore), runs e verificações
 * pendentes; aberta, mostra buscas e jobs com o progresso (clique abre o popup do nó, o mesmo do grafo), as
 * verificações pendentes e a tabela das hipóteses (clique abre o popup da hipótese). Fica embaixo da árvore em
 * vez de numa pílula do composer porque é a mesma informação vista de outro jeito: quem abriu a árvore quer o
 * resumo ali, e o composer já tem pílulas demais. A gaveta rola sozinha; a árvore nunca mexe no scroll dela.
 *
 * Popup da hipótese: braços, seeds, média ± desvio, IC, p ajustado, verificação, runs com comando, commit e sha
 * do arquivo de métricas, agentes que trabalharam nela e as ações Ramificar, Rodar mais seeds e Podar. Usa as
 * classes `agm-pop` do nodePopup.ts (o main.ts cria o nodePopup antes, e ele injeta esse CSS).
 *
 * Texto vindo do modelo entra por textContent. Estilo próprio com prefixo `agm-lt`.
 */
import { agentColor, STATUS_RING, type AgentInfo, type LabHypothesisInfo, type LabRunInfo, type LabState, type WebviewMessage } from '../chat/protocol';
import { paintSeal, verificationSection } from './parallelUi';
import { SYNTH_ICON } from './synthUi';

export interface LabViewDeps {
  send(msg: WebviewMessage): void;
  /** Põe o texto no composer do chat principal e fecha o mapa até o usuário mandar. */
  insertText(text: string): void;
  /** Abre o popup de nó do mapa (busca, job, agente) ancorado num elemento desta vista. */
  openAgentPopup(id: string, anchor: Element): void;
  /** Abre o painel de um agente (log e caixa de mensagem). */
  openAgent(id: string): void;
}

export interface LabView {
  readonly element: HTMLElement;
  update(state: LabState): void;
  /** Agentes da conversa: nós de torneio, buscas e jobs do painel e os nomes no popup. */
  setAgents(agents: AgentInfo[]): void;
  closePopup(): void;
  /** Há hipótese, busca ou job para mostrar. */
  readonly hasData: boolean;
}

const P = 'agm-lt';
const POP = 'agm-pop';
const NS = 'http://www.w3.org/2000/svg';

// Geometria igual à dos nós do grafo de agentes, para as duas vistas parecerem a mesma coisa.
const NODE_W = 172;
const NODE_H = 54;
const GAP_Y = 18;
const GAP_X = 70;
const PAD = 18;
const INDENT = 18;
const ROW_GAP = 14;
const TITLE_CHARS = 25;
const TITLE_LEAD = 11.5;
const NARROW = 420;
const RING_GAP = 5;
const MIN_SCALE = 0.4;
const MAX_SCALE = 2.5;
const MAX_FIT = 1.2;
const NEUTRAL = '#8b8f96';
const EDGE_DARK = 'rgba(0,0,0,0.55)';
const MAX_RUNS_SHOWN = 30;

/** Preenchimento por veredito. Tons médios: o texto por cima sai preto ou branco pelo contraste. */
const VERDICT_FILL = {
  suportada: '#3fa35b',
  refutada: '#d0584e',
  inconclusiva: '#7a7f87',
} as const;

const STATUS_LABEL: Record<LabHypothesisInfo['status'], string> = {
  registrada: 'registrada',
  rodando: 'rodando',
  concluída: 'suportada',
  inconclusiva: 'inconclusiva',
  refutada: 'refutada',
};

/** Ordem e cor das pílulas de status no painel. */
const STATUS_ORDER: { key: LabHypothesisInfo['status'] | 'podada'; label: string; color: string }[] = [
  { key: 'rodando', label: 'rodando', color: STATUS_RING.running },
  { key: 'registrada', label: 'registradas', color: NEUTRAL },
  { key: 'concluída', label: 'suportadas', color: VERDICT_FILL.suportada },
  { key: 'inconclusiva', label: 'inconclusivas', color: VERDICT_FILL.inconclusiva },
  { key: 'refutada', label: 'refutadas', color: VERDICT_FILL.refutada },
  { key: 'podada', label: 'podadas', color: NEUTRAL },
];

const SEAL_GLYPH: Record<NonNullable<LabHypothesisInfo['verification']>['seal'], { ch: string; color: string; label: string }> = {
  verificado: { ch: '✓', color: '#3fb950', label: 'verificada' },
  divergente: { ch: '≠', color: '#f85149', label: 'verificação divergente' },
  inconclusivo: { ch: '?', color: '#9aa0a6', label: 'verificação inconclusiva' },
  verificando: { ch: '…', color: '#4d8fd6', label: 'verificando' },
};

const STYLE = `
.${P} { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; padding: 0 12px 12px; }
.${P}-tree {
  position: relative; flex: 1; min-height: 150px; overflow: hidden; border-radius: 10px; contain: strict;
  border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.28));
  background: var(--vscode-editor-background, #1e1e1e); user-select: none;
}
.${P}-canvas { display: block; width: 100%; height: 100%; cursor: grab; touch-action: none; }
.${P}-tree.is-panning .${P}-canvas { cursor: grabbing; }
.${P}-fit {
  position: absolute; top: 8px; right: 8px; width: 26px; height: 26px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center; cursor: pointer; border-radius: 6px;
  color: var(--vscode-descriptionForeground, #9aa0a6); background: var(--vscode-editorWidget-background, #252526);
  border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
}
.${P}-fit:hover { color: var(--vscode-foreground, #ccc); }
.${P}-fit:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: 1px; }
.${P}-empty {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px;
  text-align: center; line-height: 1.5; pointer-events: none;
  font: 13px var(--vscode-font-family, sans-serif); color: var(--vscode-descriptionForeground, #9aa0a6);
}
.${P}-legend {
  position: absolute; left: 8px; bottom: 8px; max-width: calc(100% - 16px); pointer-events: none;
  display: flex; flex-wrap: wrap; gap: 3px 12px; padding: 4px 9px; border-radius: 6px;
  font: 10.5px var(--vscode-font-family, sans-serif); color: var(--vscode-descriptionForeground, #9aa0a6);
  background: color-mix(in srgb, var(--vscode-editorWidget-background, #252526) 88%, transparent);
  border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
}
.${P}-legend span { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.${P}-legend i { display: inline-block; width: 9px; height: 9px; border-radius: 3px; }
.${P}-legend svg { display: block; }
/* Lista recuada: a legenda fica numa linha só, com as cores; o tipo de linha se vê no tooltip da aresta. */
.${P}-tree.is-narrow .${P}-legend { gap: 2px 8px; padding: 3px 7px; font-size: 10px; }
.${P}-tree.is-narrow .${P}-legend-line { display: none; }

.${P}-node { cursor: pointer; outline: none; }
.${P}-node > g { transition: opacity 160ms ease; }
.${P}-box { stroke-width: 1.6; }
.${P}-node.is-neutral .${P}-box { fill: var(--vscode-editorWidget-background, #252526); stroke: var(--vscode-widget-border, rgba(140,140,140,0.55)); }
.${P}-node.is-neutral .${P}-title { fill: var(--vscode-foreground, #cccccc); }
.${P}-node.is-neutral .${P}-sub, .${P}-node.is-neutral .${P}-icon { fill: var(--vscode-descriptionForeground, #9aa0a6); }
.${P}-node.is-pruned .${P}-box { stroke-dasharray: 4 3; stroke: var(--vscode-descriptionForeground, #9aa0a6); }
.${P}-node.is-faded > g { opacity: 0.34; }
.${P}-node.is-dim > g { opacity: 0.16; }
.${P}-node:focus-visible .${P}-sel, .${P}-node.is-selected .${P}-sel { opacity: 1; }
.${P}-sel { fill: none; stroke: var(--vscode-focusBorder, #ffffff); stroke-width: 1.6; opacity: 0; }
.${P}-title { font: 600 10.5px var(--vscode-font-family, "Segoe UI", sans-serif); }
.${P}-sub { font: 9.5px var(--vscode-font-family, "Segoe UI", sans-serif); font-variant-numeric: tabular-nums; }
.${P}-icon { font: 12px codicon; opacity: 0.8; }
.${P}-ring { fill: none; stroke-width: 2; }
.${P}-moat { fill: none; stroke: var(--vscode-editor-background, #1e1e1e); stroke-width: 3; }
.${P}-halo { fill: none; stroke-width: 2; opacity: 0; }
.${P}-halo.is-running { animation: ${P}-halo 2.6s ease-out infinite; }
@keyframes ${P}-halo { 0% { opacity: 0.6; transform: scale(0.95); } 70%, 100% { opacity: 0; transform: scale(1.1); } }
.${P}-seal circle { stroke-width: 1.3; fill: var(--vscode-editor-background, #1e1e1e); }
.${P}-seal text { font: 700 9.5px var(--vscode-font-family, sans-serif); text-anchor: middle; }
.${P}-seal.is-verificando { animation: ${P}-blink 1.4s ease-in-out infinite; }
@keyframes ${P}-blink { 50% { opacity: 0.35; } }
.${P}-edge { fill: none; stroke-width: 1.6; stroke-linecap: round; transition: opacity 160ms ease; }
.${P}-edge.is-promoted { stroke-dasharray: 5 4; stroke-linecap: butt; }
.${P}-edge.is-faded { opacity: 0.3; }
.${P}-edge.is-dim { opacity: 0.12; }
@media (prefers-reduced-motion: reduce) { .${P}-halo.is-running, .${P}-seal.is-verificando { animation: none; } .${P}-halo.is-running { opacity: 0.35; } }

.${P}-panel {
  flex: none; display: flex; flex-direction: column; min-height: 0; max-height: 42%;
  border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.28)); border-radius: 10px;
  background: var(--vscode-editorWidget-background, #252526);
  font-size: 0.92em;
}
.${P}-panel[hidden] { display: none; }
.${P}-bar { flex: none; display: flex; align-items: center; flex-wrap: wrap; gap: 4px 6px; padding: 6px 8px; }
.${P}-toggle {
  display: inline-flex; align-items: center; gap: 4px; margin-right: 4px; padding: 2px 6px 2px 2px;
  font: inherit; font-weight: 600; color: var(--vscode-foreground, #ccc); background: none; border: none; border-radius: 4px; cursor: pointer;
}
.${P}-toggle:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
.${P}-toggle .codicon { font-size: 14px; transition: transform 120ms ease; }
.${P}-panel:not(.is-open) .${P}-toggle .codicon { transform: rotate(-90deg); }
.${P}-chip {
  display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px; border-radius: 10px; cursor: pointer;
  font: inherit; font-size: 0.95em; color: var(--vscode-descriptionForeground, #9aa0a6); background: none;
  border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
}
.${P}-chip b { color: var(--vscode-foreground, #ccc); font-weight: 600; font-variant-numeric: tabular-nums; }
.${P}-chip:hover { color: var(--vscode-foreground, #ccc); }
.${P}-chip[aria-pressed="true"] { color: var(--vscode-foreground, #ccc); border-color: var(--vscode-focusBorder, #007fd4); background: color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 14%, transparent); }
.${P}-chip i { width: 7px; height: 7px; border-radius: 50%; background: var(--${P}-c); }
.${P}-stat { color: var(--vscode-descriptionForeground, #9aa0a6); padding: 0 4px; white-space: nowrap; }
.${P}-stat b { color: var(--vscode-foreground, #ccc); font-weight: 600; font-variant-numeric: tabular-nums; }
.${P}-drawer { min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 0 8px 8px; border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.22)); }
.${P}-panel:not(.is-open) .${P}-drawer { display: none; }
.${P}-label { font-size: 0.78em; letter-spacing: 0.07em; text-transform: uppercase; color: var(--vscode-descriptionForeground, #9aa0a6); margin: 9px 4px 3px; }
.${P}-row {
  display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; align-items: center; gap: 2px 8px; width: 100%;
  padding: 3px 4px; border: none; border-radius: 4px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.${P}-row:hover, .${P}-row:focus-visible { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.14)); outline: none; }
.${P}-row .codicon { font-size: 13px; color: var(--vscode-descriptionForeground, #9aa0a6); }
.${P}-row.is-running .codicon { color: ${STATUS_RING.running}; }
.${P}-row-dot { justify-self: center; width: 8px; height: 8px; border-radius: 50%; background: var(--${P}-c); }
.${P}-row-dot.is-pruned { background: none; border: 1.5px dashed var(--${P}-c); width: 6px; height: 6px; }
.${P}-row-main { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${P}-row-main small { color: var(--vscode-descriptionForeground, #9aa0a6); margin-left: 6px; }
.${P}-row-side { color: var(--vscode-descriptionForeground, #9aa0a6); font-variant-numeric: tabular-nums; white-space: nowrap; }
.${P}-row.is-pruned .${P}-row-main { opacity: 0.55; text-decoration: line-through; }

.${P}-pop { width: 420px; }
.${P}-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; font-size: 0.92em; }
.${P}-table th { text-align: left; font-weight: 400; color: var(--vscode-descriptionForeground, #9aa0a6); padding: 2px 8px 2px 0; }
.${P}-table td { padding: 2px 8px 2px 0; }
.${P}-kv { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; font-size: 0.92em; font-variant-numeric: tabular-nums; }
.${P}-kv span:nth-child(odd) { color: var(--vscode-descriptionForeground, #9aa0a6); }
.${P}-reasons { margin: 6px 0 0; padding-left: 1.2em; font-size: 0.9em; line-height: 1.45; color: var(--vscode-descriptionForeground, #9aa0a6); }
.${P}-warn { color: var(--vscode-editorWarning-foreground, #cca700); font-size: 0.9em; line-height: 1.45; margin-top: 6px; }
.${P}-run { font-size: 0.88em; line-height: 1.45; padding: 3px 0; border-bottom: 1px solid rgba(128,128,128,0.12); overflow-wrap: anywhere; }
.${P}-run code { font-family: var(--vscode-editor-font-family, Consolas, monospace); font-size: 0.95em; }
.${P}-muted { color: var(--vscode-descriptionForeground, #9aa0a6); }
.${P}-agents { display: flex; flex-wrap: wrap; gap: 4px; }
.${P}-agent {
  display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px 1px 6px; border-radius: 10px; font: inherit; font-size: 0.9em;
  color: var(--vscode-foreground, #ccc); background: rgba(128,128,128,0.12); border: 1px solid transparent; cursor: pointer;
}
.${P}-agent:hover { border-color: var(--vscode-widget-border, rgba(128,128,128,0.5)); }
.${P}-agent:disabled { cursor: default; opacity: 0.7; }
.${P}-agent i { width: 7px; height: 7px; border-radius: 50%; background: var(--${P}-c); }
.${P}-agent small { color: var(--vscode-descriptionForeground, #9aa0a6); }
`;

function ensureStyles(): void {
  if (document.getElementById(`${P}-style`)) {
    return;
  }
  const style = document.createElement('style');
  style.id = `${P}-style`;
  style.textContent = STYLE;
  document.head.append(style);
}

// ---------- utilidades ----------

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) {
    e.className = cls;
  }
  for (const c of children) {
    if (c) {
      e.append(c);
    }
  }
  return e;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    e.setAttribute(k, String(v));
  }
  return e;
}

function codicon(name: string): HTMLSpanElement {
  const s = h('span', `codicon codicon-${name}`);
  s.setAttribute('aria-hidden', 'true');
  return s;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function wrapTitle(text: string, perLine: number, maxLines: number): string[] {
  let rest = text.replace(/\s+/g, ' ').trim();
  const lines: string[] = [];
  while (rest.length > perLine && lines.length < maxLines - 1) {
    const cut = rest.lastIndexOf(' ', perLine);
    if (cut <= 0) {
      break;
    }
    lines.push(rest.slice(0, cut));
    rest = rest.slice(cut + 1);
  }
  lines.push(truncate(rest, perLine));
  return lines;
}

/** Preto ou branco, o que tiver mais contraste com a cor de fundo (mesma conta do graph.ts). */
function readableOn(hex: string): string {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return (L + 0.05) / 0.05 >= 1.05 / (L + 0.05) ? '#14161a' : '#ffffff';
}

/** Quatro algarismos significativos, como o fmtNum do host. */
function fmt(x: number | null | undefined): string {
  if (typeof x !== 'number' || Number.isNaN(x)) {
    return '-';
  }
  if (!Number.isFinite(x)) {
    return x > 0 ? '∞' : '-∞';
  }
  if (x === 0) {
    return '0';
  }
  return Math.abs(x) < 1e-4 ? x.toExponential(2) : String(Number(x.toPrecision(4)));
}

const signed = (x: number | null | undefined): string => (typeof x === 'number' && x > 0 ? `+${fmt(x)}` : fmt(x));

/** Última execução de cada seed, por braço: é o que o veredito usa. */
function armStats(hyp: LabHypothesisInfo): { arm: string; n: number; mean: number; sd: number }[] {
  return hyp.arms.map((arm) => {
    const bySeed = new Map<number, number>();
    for (const r of hyp.runs) {
      if (r.arm === arm && typeof r.value === 'number') {
        bySeed.set(r.seed, r.value);
      }
    }
    const xs = [...bySeed.values()];
    const mean = xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : NaN;
    const sd = xs.length > 1 ? Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / (xs.length - 1)) : NaN;
    return { arm, n: xs.length, mean, sd };
  });
}

/** "Candidato c2 do torneio t1" no enunciado: a hipótese veio do promote_to_hypothesis. */
function promotedFrom(hyp: LabHypothesisInfo): { tournament: string; candidate: string } | undefined {
  const m = /\(Candidato (\S+) do torneio (\S+?):/.exec(hyp.statement);
  return m ? { candidate: m[1], tournament: m[2] } : undefined;
}

/** Seeds que faltam para o próximo passo: a estimativa do veredito inconclusivo, ou o mínimo que não foi rodado. */
function missingSeeds(hyp: LabHypothesisInfo): number {
  const v = hyp.verdict;
  if (v?.verdict === 'inconclusiva' && typeof v.seedsMissing === 'number' && v.seedsMissing > 0) {
    return v.seedsMissing;
  }
  if (!v) {
    return Math.max(0, hyp.minSeeds - Math.min(...armStats(hyp).map((a) => a.n)));
  }
  return 0;
}

function hypColor(hyp: LabHypothesisInfo): string | undefined {
  return hyp.verdict ? VERDICT_FILL[hyp.verdict.verdict] : undefined;
}

/** Linha de baixo do nó: métrica e diferença ± meia largura do IC, ou o andamento das seeds. */
function hypSub(hyp: LabHypothesisInfo): string {
  const v = hyp.verdict;
  const metric = truncate(hyp.metric, 12);
  if (v && Number.isFinite(v.diff)) {
    const half = (v.ci[1] - v.ci[0]) / 2;
    return `${metric} ${signed(v.diff)} ± ${fmt(half)}`;
  }
  const arms = armStats(hyp);
  if (!hyp.runs.length) {
    return `${metric} · sem runs`;
  }
  return `${metric} · seeds ${Math.min(...arms.map((a) => a.n))}/${hyp.minSeeds}`;
}

// ---------- modelo da árvore ----------

interface TNode {
  id: string;
  kind: 'hyp' | 'tournament';
  hyp?: LabHypothesisInfo;
  title: string[];
  sub: string;
  detail: string;
  /** Sem cor: nó neutro (hipótese sem veredito, torneio). */
  fill?: string;
  text: string;
  ring?: { color: string; pulse: boolean };
  seal?: NonNullable<LabHypothesisInfo['verification']>['seal'];
  icon?: string;
  pruned: boolean;
  /** Podada ou descendente de podada. */
  faded: boolean;
  parent?: string;
  /** Aresta que chega neste nó: derivada de outra hipótese ou promovida de um torneio. */
  via?: 'derived' | 'promoted';
  depth: number;
  x: number;
  y: number;
}

function buildTree(hyps: LabHypothesisInfo[], agents: AgentInfo[]): TNode[] {
  const ids = new Set(hyps.map((x) => x.id));
  const nodes: TNode[] = [];
  const tournaments = new Map<string, TNode>();

  for (const hyp of hyps) {
    const from = promotedFrom(hyp);
    let parent: string | undefined;
    let via: TNode['via'];
    if (hyp.derivedFrom && ids.has(hyp.derivedFrom) && hyp.derivedFrom !== hyp.id) {
      parent = hyp.derivedFrom;
      via = 'derived';
    } else if (from) {
      parent = `t:${from.tournament}`;
      via = 'promoted';
      if (!tournaments.has(parent)) {
        const agent = agents.find((a) => a.id === from.tournament && a.search?.kind === 'tournament');
        const name = agent?.description?.replace(/^Torneio:\s*/, '') || `Torneio ${from.tournament}`;
        tournaments.set(parent, {
          id: parent,
          kind: 'tournament',
          title: wrapTitle(name, TITLE_CHARS - 3, 2),
          sub: agent?.search ? truncate(agent.search.progress, 30) : `torneio ${from.tournament}`,
          detail: `${agent?.description ?? `Torneio ${from.tournament}`}\nhipóteses promovidas dele aparecem ligadas por linha tracejada`,
          text: NEUTRAL,
          icon: SYNTH_ICON.tournament,
          ring: agent?.status === 'running' ? { color: STATUS_RING.running, pulse: true } : undefined,
          pruned: false,
          faded: false,
          depth: 0,
          x: 0,
          y: 0,
        });
      }
    }
    const fill = hypColor(hyp);
    const running = hyp.status === 'rodando' && !hyp.pruned;
    const v = hyp.verdict;
    nodes.push({
      id: hyp.id,
      kind: 'hyp',
      hyp,
      title: wrapTitle(`${hyp.id} · ${hyp.title}`, TITLE_CHARS, 2),
      sub: hyp.pruned ? truncate(`podada · ${hypSub(hyp)}`, 32) : hypSub(hyp),
      detail: [
        `${hyp.id} · ${hyp.title}`,
        `status: ${STATUS_LABEL[hyp.status]}${hyp.pruned ? ' (podada)' : ''}`,
        `${hyp.metric}, ${hyp.direction === 'higher' ? 'maior' : 'menor'} é melhor`,
        v && Number.isFinite(v.diff) ? `diferença ${signed(v.diff)}, IC95% [${fmt(v.ci[0])}, ${fmt(v.ci[1])}], p aj. ${fmt(v.pAdjusted)}` : '',
        hyp.verification ? SEAL_GLYPH[hyp.verification.seal].label : '',
        'clique para detalhes',
      ]
        .filter(Boolean)
        .join('\n'),
      fill,
      text: fill ? readableOn(fill) : NEUTRAL,
      ring: running ? { color: STATUS_RING.running, pulse: true } : undefined,
      seal: hyp.verification?.seal,
      pruned: !!hyp.pruned,
      faded: false,
      parent,
      via,
      depth: 0,
      x: 0,
      y: 0,
    });
  }
  const all = [...tournaments.values(), ...nodes];
  const byId = new Map(all.map((n) => [n.id, n]));
  // Ciclo em derived_from (não deveria existir, mas o arquivo é editável): o nó vira raiz.
  for (const n of all) {
    const seen = new Set([n.id]);
    let cur = n.parent;
    while (cur) {
      if (seen.has(cur)) {
        n.parent = undefined;
        n.via = undefined;
        break;
      }
      seen.add(cur);
      cur = byId.get(cur)?.parent;
    }
  }
  // Ramo podado: tudo abaixo de uma podada esmaece junto.
  for (const n of all) {
    let cur: TNode | undefined = n;
    while (cur) {
      if (cur.pruned) {
        n.faded = true;
        break;
      }
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
  }
  return all;
}

interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Árvore arrumada (folhas em faixas, pai no meio dos filhos), ou lista recuada no painel estreito. */
function layout(nodes: TNode[], narrow: boolean): Bounds {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map<string, TNode[]>();
  const roots: TNode[] = [];
  for (const n of nodes) {
    const p = n.parent ? byId.get(n.parent) : undefined;
    if (p) {
      kids.set(p.id, [...(kids.get(p.id) ?? []), n]);
    } else {
      roots.push(n);
    }
  }
  const order: TNode[] = [];
  let cursor = PAD;
  const walk = (n: TNode, depth: number): number => {
    n.depth = depth;
    order.push(n);
    const list = kids.get(n.id) ?? [];
    if (!list.length) {
      const c = cursor + NODE_H / 2;
      cursor += NODE_H + GAP_Y;
      n.y = c;
      return c;
    }
    const ys = list.map((k) => walk(k, depth + 1));
    n.y = (ys[0] + ys[ys.length - 1]) / 2;
    return n.y;
  };
  for (const r of roots) {
    walk(r, 0);
  }
  if (narrow) {
    let row = PAD;
    for (const n of order) {
      n.x = PAD + n.depth * INDENT + NODE_W / 2;
      n.y = row + NODE_H / 2;
      row += NODE_H + ROW_GAP;
    }
  } else {
    for (const n of nodes) {
      n.x = PAD + n.depth * (NODE_W + GAP_X) + NODE_W / 2;
    }
  }
  if (!nodes.length) {
    return { x: 0, y: 0, w: 1, h: 1 };
  }
  const x0 = Math.min(...nodes.map((n) => n.x - NODE_W / 2));
  const y0 = Math.min(...nodes.map((n) => n.y - NODE_H / 2));
  const x1 = Math.max(...nodes.map((n) => n.x + NODE_W / 2));
  const y1 = Math.max(...nodes.map((n) => n.y + NODE_H / 2));
  return { x: x0 - PAD, y: y0 - PAD, w: x1 - x0 + PAD * 2, h: y1 - y0 + PAD * 2 };
}

function edgeD(a: TNode, b: TNode, narrow: boolean): string {
  const f = (x: number, y: number): string => `${x.toFixed(1)} ${y.toFixed(1)}`;
  if (narrow) {
    // Desce pela calha do pai (o recuo) e entra pela esquerda do filho, como no grafo empilhado.
    const gx = a.x - NODE_W / 2 + 6;
    const y1 = a.y + NODE_H / 2 + 2;
    const ex = b.x - NODE_W / 2 - RING_GAP - 3;
    const r = Math.min(7, (b.y - y1) / 2);
    return `M ${f(gx, y1)} L ${f(gx, b.y - r)} Q ${f(gx, b.y)} ${f(gx + r, b.y)} L ${f(ex, b.y)}`;
  }
  const p1 = { x: a.x + NODE_W / 2 + 3, y: a.y };
  const p2 = { x: b.x - NODE_W / 2 - RING_GAP - 4, y: b.y };
  const k = Math.max(20, (p2.x - p1.x) * 0.45);
  return `M ${f(p1.x, p1.y)} C ${f(p1.x + k, p1.y)}, ${f(p2.x - k, p2.y)}, ${f(p2.x, p2.y)}`;
}

// ---------- componente ----------

export function createLabView(deps: LabViewDeps): LabView {
  ensureStyles();
  let lab: LabState = { hypotheses: [], runs: 0, findings: 0 };
  let agents: AgentInfo[] = [];
  let nodes: TNode[] = [];
  let bounds: Bounds = { x: 0, y: 0, w: 1, h: 1 };
  let narrow = false;
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let userView = false;
  let selected: string | undefined;
  /** Status destacado pela pílula do painel; os outros nós apagam. */
  let highlight: string | undefined;
  let open = true;
  let treeSig = '';
  let panelSig = '';

  const element = h('div', P);
  const tree = h('div', `${P}-tree`);
  const canvas = svg('svg', { class: `${P}-canvas`, role: 'group', 'aria-label': 'Árvore de hipóteses' });
  const defs = svg('defs');
  const viewport = svg('g');
  const edgeLayer = svg('g');
  const nodeLayer = svg('g');
  viewport.append(edgeLayer, nodeLayer);
  canvas.append(defs, viewport);
  const arrow = `${P}-arrow`;
  const marker = svg('marker', { id: arrow, viewBox: '0 0 12 12', refX: 10, refY: 6, markerWidth: 9, markerHeight: 9, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' });
  marker.append(svg('path', { d: 'M 0.5 1 L 11 6 L 0.5 11 L 3 6 z', fill: NEUTRAL }));
  defs.append(marker);

  const fitBtn = h('button', `${P}-fit`, codicon('screen-full'));
  fitBtn.type = 'button';
  fitBtn.title = 'Centralizar a árvore';
  fitBtn.setAttribute('aria-label', 'Centralizar a árvore');
  const empty = h('div', `${P}-empty`, 'Nenhuma hipótese registrada. Elas aparecem aqui quando o orquestrador chama register_hypothesis.');
  const legend = h('div', `${P}-legend`);
  const swatch = (color: string, label: string): HTMLElement => {
    const i = h('i');
    i.style.background = color;
    return h('span', undefined, i, label);
  };
  const line = (dash: boolean, label: string): HTMLElement => {
    const s = svg('svg', { width: 24, height: 8, viewBox: '0 0 24 8' });
    s.append(svg('path', { d: 'M 1 4 L 23 4', stroke: 'currentColor', 'stroke-width': 1.6, ...(dash ? { 'stroke-dasharray': '4 3' } : {}) }));
    return h('span', `${P}-legend-line`, s, label);
  };
  // Cada item da legenda só aparece quando há algo na árvore com aquela cor ou aquele traço.
  const legendItems = {
    suportada: swatch(VERDICT_FILL.suportada, 'suportada'),
    refutada: swatch(VERDICT_FILL.refutada, 'refutada'),
    inconclusiva: swatch(VERDICT_FILL.inconclusiva, 'inconclusiva'),
    derived: line(false, 'derivada'),
    promoted: line(true, 'do torneio'),
  };
  legend.append(...Object.values(legendItems));
  tree.append(canvas, fitBtn, empty, legend);

  const panel = h('div', `${P}-panel is-open`);
  const toggle = h('button', `${P}-toggle`, codicon('chevron-down'), 'Laboratório');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'true');
  const bar = h('div', `${P}-bar`);
  const drawer = h('div', `${P}-drawer`);
  panel.append(bar, drawer);
  element.append(tree, panel);

  toggle.addEventListener('click', () => {
    open = !open;
    panel.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  });

  // ---------- popup da hipótese ----------

  const pop = h('div', `${POP} ${P}-pop`);
  pop.hidden = true;
  pop.setAttribute('role', 'dialog');
  pop.tabIndex = -1;
  document.body.append(pop);
  let popId: string | undefined;
  let popAnchor: (() => DOMRect | undefined) | undefined;
  let popAnchorEl: Element | undefined;
  let popSig = '';
  /** Poda pedida ao host e ainda não confirmada (id → estado pedido): o botão fica ocupado. */
  const pending = new Map<string, boolean>();
  let agentsSig = '';

  function nodeRect(id: string): DOMRect | undefined {
    const g = nodeLayer.querySelector<SVGGElement>(`[data-id="${CSS.escape(id)}"] .${P}-box`);
    return g?.isConnected && element.offsetParent !== null ? g.getBoundingClientRect() : undefined;
  }

  function openHyp(id: string, anchorEl: Element, anchor: () => DOMRect | undefined, focus: boolean): void {
    if (popId === id && popAnchorEl === anchorEl && !pop.hidden) {
      closePopup();
      return;
    }
    popId = id;
    popAnchor = anchor;
    popAnchorEl = anchorEl;
    popSig = '';
    fillPopup();
    pop.hidden = false;
    place();
    if (focus) {
      pop.focus({ preventScroll: true });
    }
  }

  function closePopup(): void {
    if (pop.hidden) {
      return;
    }
    pop.hidden = true;
    popId = undefined;
    popAnchorEl = undefined;
    select(undefined);
  }

  function select(id: string | undefined): void {
    selected = id;
    for (const g of nodeLayer.querySelectorAll<SVGGElement>(`.${P}-node`)) {
      g.classList.toggle('is-selected', g.dataset.id === id);
    }
  }

  function place(): void {
    if (pop.hidden) {
      return;
    }
    const a = popAnchor?.();
    if (!a) {
      closePopup();
      return;
    }
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const w = Math.min(420, vw - 16);
    pop.style.width = `${w}px`;
    pop.style.maxHeight = `${Math.min(600, vh - 16)}px`;
    const hgt = pop.offsetHeight;
    let left: number;
    let top: number;
    if (vw - a.right - 12 >= w + 8) {
      left = a.right + 12;
      top = a.top + a.height / 2 - 40;
    } else if (a.left - 12 >= w + 8) {
      left = a.left - 12 - w;
      top = a.top + a.height / 2 - 40;
    } else {
      left = a.left;
      const below = vh - a.bottom;
      top = below >= hgt + 16 || below >= a.top ? a.bottom + 8 : a.top - 8 - hgt;
    }
    pop.style.left = `${Math.round(clamp(left, 8, vw - w - 8))}px`;
    pop.style.top = `${Math.round(clamp(top, 8, Math.max(8, vh - hgt - 8)))}px`;
  }

  function agentName(id: string): { label: string; color: string; known: boolean } {
    if (id === 'main' || id === 'user') {
      return { label: id === 'main' ? 'conversa principal' : 'você', color: NEUTRAL, known: false };
    }
    const a = agents.find((x) => x.id === id);
    return { label: a?.description ? truncate(a.description, 28) : id, color: agentColor(a?.color, id), known: !!a };
  }

  function fillPopup(): void {
    const hyp = lab.hypotheses.find((x) => x.id === popId);
    if (!hyp) {
      closePopup();
      return;
    }
    const sig = JSON.stringify([hyp, pending.has(hyp.id), agents.map((a) => `${a.id}:${a.status}`)]);
    if (sig === popSig) {
      return;
    }
    popSig = sig;
    const v = hyp.verdict;
    const color = hypColor(hyp) ?? NEUTRAL;
    pop.style.setProperty(`--${POP}-color`, color);

    const x = h('button', `${POP}-x`, '×');
    x.type = 'button';
    x.title = 'Fechar (Esc)';
    x.setAttribute('aria-label', 'Fechar');
    x.addEventListener('click', () => closePopup());
    const seal = h('span');
    paintSeal(seal, hyp.verification);
    const kind = h('div', `${POP}-kind`, `Hipótese ${hyp.id} · ${STATUS_LABEL[hyp.status]}${hyp.pruned ? ' · podada' : ''} · registrada por ${hyp.createdBy}`);
    const head = h('div', `${POP}-head`, h('span', `${POP}-dot`), h('div', `${POP}-titles`, h('div', `${POP}-title`, hyp.title), kind), seal, x);

    const from = promotedFrom(hyp);
    const meta = h(
      'div',
      `${POP}-meta`,
      h('span', undefined, `${hyp.metric}, ${hyp.direction === 'higher' ? 'maior' : 'menor'} é melhor`),
      h('span', undefined, `melhora mínima ${hyp.minImprovement}${hyp.improvementKind === 'relative' ? ' (relativa)' : ''}`),
      h('span', undefined, `família ${hyp.family}`),
      hyp.derivedFrom && h('span', undefined, `derivada de ${hyp.derivedFrom}`),
      from && h('span', undefined, `promovida de ${from.candidate} (torneio ${from.tournament})`),
    );

    // Braços: do veredito quando há um (é o que a estatística usou), senão calculado dos runs.
    const arms = v?.arms ?? armStats(hyp);
    const armsTable = h('table', `${P}-table`, h('tr', undefined, h('th', undefined, 'Braço'), h('th', undefined, 'Seeds'), h('th', undefined, 'Média ± desvio')));
    for (const a of arms) {
      armsTable.append(h('tr', undefined, h('td', undefined, a.arm), h('td', undefined, `${a.n}/${hyp.minSeeds}`), h('td', undefined, a.n ? `${fmt(a.mean)} ± ${fmt(a.sd)}` : '-')));
    }

    const sections: HTMLElement[] = [
      h('div', `${POP}-section`, h('div', `${POP}-label`, 'Enunciado'), h('div', `${POP}-note is-strong`, hyp.statement)),
      h('div', `${POP}-section`, h('div', `${POP}-label`, 'Braços'), armsTable),
    ];
    if (v) {
      const kv = h('div', `${P}-kv`);
      const pair = (k: string, val: string): void => {
        kv.append(h('span', undefined, k), h('span', undefined, val));
      };
      pair('Veredito', `${v.verdict} · tentativa ${v.attempt} · ${new Date(v.at).toLocaleString('pt-BR')}`);
      pair('Diferença', `${signed(v.diff)}${typeof v.relDiff === 'number' ? ` (${signed(v.relDiff * 100)}%)` : ''}`);
      pair('IC 95%', `[${fmt(v.ci[0])}, ${fmt(v.ci[1])}] · ${v.mode === 'paired-samples' ? 'pareado por amostra' : 'por seed'}`);
      pair(v.mode === 'seeds' ? 'd de Cohen' : 'd_z', fmt(v.effect));
      pair('p ajustado', `${fmt(v.pAdjusted)} (p ${fmt(v.p)}, BH em ${v.familySize} hipótese(s))`);
      if (v.verdict === 'inconclusiva' && typeof v.seedsMissing === 'number') {
        pair('Seeds que faltam', `~${v.seedsMissing} por braço (poder 80%)`);
      }
      const reasons = h('ul', `${P}-reasons`);
      for (const r of v.reasons) {
        reasons.append(h('li', undefined, r));
      }
      sections.push(h('div', `${POP}-section`, h('div', `${POP}-label`, 'Estatística'), kv, reasons, ...v.warnings.map((w) => h('div', `${P}-warn`, `Atenção: ${w}`))));
    }
    const verif = verificationSection(hyp.verification, `${POP}-section`, `${POP}-label`);
    if (verif) {
      sections.push(verif);
    }

    // Quem trabalhou nela: quem registrou, quem rodou, quem declarou e quem verificou.
    const who = new Map<string, string>();
    const add = (id: string | undefined, role: string): void => {
      if (id && !who.has(id)) {
        who.set(id, role);
      }
    };
    add(hyp.createdBy, 'registrou');
    for (const r of hyp.runs) {
      add(r.agent, 'rodou');
    }
    add(v?.by, 'declarou');
    add(hyp.verification?.agent, 'verificou');
    const chips = h('div', `${P}-agents`);
    for (const [id, role] of who) {
      const n = agentName(id);
      const i = h('i');
      i.style.setProperty(`--${P}-c`, n.color);
      const b = h('button', `${P}-agent`, i, n.label, h('small', undefined, role));
      b.type = 'button';
      b.disabled = !n.known;
      b.title = n.known ? `Abrir o painel de ${id}` : id;
      b.addEventListener('click', () => {
        closePopup();
        deps.openAgent(id);
      });
      chips.append(b);
    }
    sections.push(h('div', `${POP}-section`, h('div', `${POP}-label`, 'Agentes'), chips));

    const runs = h('div');
    const list = hyp.runs.slice(-MAX_RUNS_SHOWN);
    if (!list.length) {
      runs.append(h('div', `${P}-muted`, 'Nenhum run registrado.'));
    }
    for (const r of list) {
      runs.append(runLine(hyp, r));
    }
    const runLabel = hyp.runs.length > list.length ? `Runs (últimos ${list.length} de ${hyp.runs.length})` : `Runs (${hyp.runs.length})`;
    sections.push(h('div', `${POP}-section`, h('div', `${POP}-label`, runLabel), runs));

    const body = h('div', `${POP}-body`, ...sections);
    const actions = h('div', `${POP}-actions`);
    const btn = (label: string, cls: string, title: string, on: () => void): HTMLButtonElement => {
      const b = h('button', `${POP}-btn ${cls}`.trim(), label);
      b.type = 'button';
      b.title = title;
      b.addEventListener('click', on);
      return b;
    };
    actions.append(
      btn('Ramificar a partir daqui', 'is-primary', 'Prepara no composer o pedido de uma hipótese derivada desta', () => {
        closePopup();
        deps.insertText(
          `Registre uma hipótese derivada de ${hyp.id} ("${hyp.title}") com register_hypothesis e derived_from "${hyp.id}". Mesma métrica (${hyp.metric}, ${hyp.direction === 'higher' ? 'maior' : 'menor'} é melhor) e braços ${hyp.arms[0]} x ${hyp.arms[1]}, salvo o que eu mudar aqui. O que muda: `,
        );
      }),
    );
    const missing = missingSeeds(hyp);
    if (missing > 0 && !hyp.pruned) {
      const used = new Set(hyp.runs.map((r) => r.seed));
      const next: number[] = [];
      for (let s = 1; next.length < missing && s < 10_000; s++) {
        if (!used.has(s)) {
          next.push(s);
        }
      }
      actions.append(
        btn(`Rodar mais ${missing} seeds`, '', `Prepara no composer o pedido de run_seeds com ${missing} seeds novas por braço`, () => {
          closePopup();
          deps.insertText(
            `Rode mais ${missing} seeds por braço na hipótese ${hyp.id} ("${hyp.title}") com run_seeds, nos braços ${hyp.arms[0]} e ${hyp.arms[1]}, seeds [${next.join(', ')}], com o mesmo comando dos runs anteriores. Depois chame declare_result de novo.`,
          );
        }),
      );
    }
    const busy = pending.has(hyp.id);
    const prune = btn(
      busy ? 'Aguardando…' : hyp.pruned ? 'Restaurar ramo' : 'Podar',
      hyp.pruned ? '' : 'is-danger',
      hyp.pruned ? 'Tira a marca de podada; o ramo volta ao normal' : 'Marca a hipótese como abandonada no laboratório. Nada é apagado; o ramo fica esmaecido',
      () => {
        pending.set(hyp.id, !hyp.pruned);
        deps.send({ type: 'labAction', kind: hyp.pruned ? 'unprune' : 'prune', hypothesis_id: hyp.id });
        fillPopup();
      },
    );
    prune.disabled = busy;
    actions.append(prune);
    pop.replaceChildren(head, meta, body, actions);
  }

  function runLine(hyp: LabHypothesisInfo, r: LabRunInfo): HTMLElement {
    const cmd = r.command ? h('code', undefined, r.command) : h('span', `${P}-muted`, 'sem comando');
    const prov = [
      r.commit ? `commit ${r.commit.slice(0, 10)}${r.dirty ? ' (sujo)' : ''}` : 'sem commit',
      r.metricsFileHash ? `sha ${r.metricsFileHash}` : '',
      r.source === 'arquivo' ? `lido de ${r.artifact ?? 'arquivo'}` : 'valor declarado',
      r.agent,
    ].filter(Boolean);
    return h('div', `${P}-run`, h('div', undefined, `${r.id} · ${r.arm} · seed ${r.seed} · ${hyp.metric} ${fmt(r.value)}`), cmd, h('div', `${P}-muted`, prov.join(' · ')));
  }

  document.addEventListener('mousedown', (e) => {
    if (!pop.hidden && !pop.contains(e.target as Node) && !popAnchorEl?.contains(e.target as Node)) {
      closePopup();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.hidden) {
      closePopup();
    }
  });
  window.addEventListener('resize', () => place());
  document.addEventListener('scroll', () => place(), { capture: true, passive: true });

  // ---------- desenho da árvore ----------

  function paintTree(): void {
    const sig = JSON.stringify([nodes.map((n) => [n.id, n.title, n.sub, n.fill, n.ring?.color, n.seal, n.pruned, n.faded, n.parent, n.detail]), narrow]);
    if (sig !== treeSig) {
      treeSig = sig;
      render();
    }
    paintHighlight();
  }

  function render(): void {
    tree.classList.toggle('is-narrow', narrow);
    bounds = layout(nodes, narrow);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    edgeLayer.replaceChildren();
    nodeLayer.replaceChildren();
    for (const n of nodes) {
      const p = n.parent ? byId.get(n.parent) : undefined;
      if (!p) {
        continue;
      }
      const path = svg('path', {
        class: `${P}-edge${n.via === 'promoted' ? ' is-promoted' : ''}${n.faded ? ' is-faded' : ''}`,
        d: edgeD(p, n, narrow),
        stroke: p.fill ?? NEUTRAL,
        'marker-end': `url(#${arrow})`,
      });
      path.dataset.to = n.id;
      path.dataset.from = p.id;
      const tip = svg('title');
      tip.textContent = n.via === 'promoted' ? `${n.id} foi promovida do ${p.title.join(' ')}` : `${n.id} deriva de ${p.id}`;
      path.append(tip);
      edgeLayer.append(path);
    }
    for (const n of nodes) {
      nodeLayer.append(drawNode(n));
    }
    empty.style.display = lab.hypotheses.length ? 'none' : '';
    const verdicts = new Set(lab.hypotheses.map((x) => x.verdict?.verdict));
    const vias = new Set(nodes.map((n) => n.via));
    const shown: Record<keyof typeof legendItems, boolean> = {
      suportada: verdicts.has('suportada'),
      refutada: verdicts.has('refutada'),
      inconclusiva: verdicts.has('inconclusiva'),
      derived: vias.has('derived'),
      promoted: vias.has('promoted'),
    };
    for (const [key, item] of Object.entries(legendItems)) {
      item.style.display = shown[key as keyof typeof legendItems] ? '' : 'none';
    }
    legend.style.display = Object.values(shown).some(Boolean) ? '' : 'none';
    fitBtn.hidden = !lab.hypotheses.length;
    if (!userView) {
      fit();
    } else {
      applyTransform();
    }
  }

  function drawNode(n: TNode): SVGGElement {
    const neutral = !n.fill;
    const g = svg('g', { class: `${P}-node${neutral ? ' is-neutral' : ''}${n.pruned ? ' is-pruned' : ''}${n.faded ? ' is-faded' : ''}`, transform: `translate(${n.x.toFixed(1)} ${n.y.toFixed(1)})` });
    g.dataset.id = n.id;
    if (n.kind === 'hyp') {
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'button');
    }
    g.setAttribute('aria-label', n.detail.split('\n').slice(0, 4).join('. '));
    g.classList.toggle('is-selected', selected === n.id);
    const tip = svg('title');
    tip.textContent = n.detail;
    const inner = svg('g');
    const hw = NODE_W / 2;
    const hh = NODE_H / 2;
    const rect = (cls: string, grow: number, rx: number): SVGRectElement =>
      svg('rect', { class: cls, x: -hw - grow, y: -hh - grow, width: NODE_W + grow * 2, height: NODE_H + grow * 2, rx });
    const sel = rect(`${P}-sel`, RING_GAP + 4, 18);
    const box = rect(`${P}-box`, 0, 9);
    if (n.fill) {
      box.setAttribute('fill', n.fill);
      box.setAttribute('stroke', EDGE_DARK);
    }
    inner.append(sel);
    if (n.ring) {
      const halo = rect(`${P}-halo${n.ring.pulse ? ' is-running' : ''}`, RING_GAP, 14);
      halo.setAttribute('stroke', n.ring.color);
      const ring = rect(`${P}-ring`, RING_GAP, 14);
      ring.setAttribute('stroke', n.ring.color);
      inner.append(halo, ring, rect(`${P}-moat`, 2.3, 11));
    }
    inner.append(box);
    const textX = -hw + (n.icon ? 27 : 12);
    const block = n.title.length * TITLE_LEAD + 13;
    const first = -block / 2 + 8.5;
    const title = svg('text', { class: `${P}-title`, x: textX, y: first.toFixed(1) });
    for (const [i, t] of n.title.entries()) {
      const span = svg('tspan', { x: textX, dy: i ? TITLE_LEAD : 0 });
      span.textContent = t;
      title.append(span);
    }
    const sub = svg('text', { class: `${P}-sub`, x: textX, y: (first + (n.title.length - 1) * TITLE_LEAD + 13).toFixed(1), opacity: neutral ? 1 : 0.85 });
    sub.textContent = n.sub;
    if (!neutral) {
      title.setAttribute('fill', n.text);
      sub.setAttribute('fill', n.text);
    }
    inner.append(title, sub);
    if (n.icon) {
      const icon = svg('text', { class: `${P}-icon`, x: -hw + 10, y: (first + 2).toFixed(1), 'aria-hidden': 'true' });
      icon.textContent = n.icon;
      inner.append(icon);
    }
    if (n.seal) {
      const s = SEAL_GLYPH[n.seal];
      const badge = svg('g', { class: `${P}-seal is-${n.seal}`, transform: `translate(${(hw - 4).toFixed(1)},${(-hh + 4).toFixed(1)})`, 'aria-hidden': 'true' });
      const c = svg('circle', { r: 8 });
      c.setAttribute('stroke', s.color);
      const t = svg('text', { y: 3.4 });
      t.setAttribute('fill', s.color);
      t.textContent = s.ch;
      badge.append(c, t);
      inner.append(badge);
    }
    g.append(tip, inner);
    if (n.kind === 'hyp') {
      const openIt = (focus: boolean): void => {
        select(n.id);
        openHyp(n.id, g, () => nodeRect(n.id), focus);
      };
      g.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        downAt = { x: e.clientX, y: e.clientY, id: n.id };
      });
      g.addEventListener('pointerup', (e) => {
        if (downAt?.id === n.id && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 5) {
          openIt(false);
        }
        downAt = undefined;
      });
      g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openIt(true);
        }
      });
    } else {
      // Torneio: abre o popup do nó do grafo, com o ranking e o "Promover líder".
      const tid = n.id.slice(2);
      g.dataset.agent = tid;
      g.addEventListener('pointerdown', (e) => e.stopPropagation());
      g.addEventListener('click', () => {
        if (agents.some((a) => a.id === tid)) {
          closePopup();
          deps.openAgentPopup(tid, g);
        }
      });
    }
    return g;
  }

  let downAt: { x: number; y: number; id: string } | undefined;

  function paintHighlight(): void {
    const match = (n: TNode): boolean =>
      !highlight || (highlight === 'podada' ? n.pruned : n.kind === 'hyp' && !!n.hyp && n.hyp.status === highlight && !n.pruned);
    const lit = new Set(nodes.filter(match).map((n) => n.id));
    for (const g of nodeLayer.querySelectorAll<SVGGElement>(`.${P}-node`)) {
      g.classList.toggle('is-dim', !!highlight && !lit.has(g.dataset.id ?? ''));
    }
    for (const p of edgeLayer.querySelectorAll<SVGPathElement>(`.${P}-edge`)) {
      p.classList.toggle('is-dim', !!highlight && !lit.has(p.dataset.to ?? ''));
    }
  }

  // ---------- câmera ----------

  function applyTransform(): void {
    viewport.setAttribute('transform', `translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scale.toFixed(3)})`);
    place();
  }

  function fit(): void {
    const vw = tree.clientWidth;
    const vh = Math.max(80, tree.clientHeight - (legend.style.display === 'none' ? 0 : legend.offsetHeight + 8));
    if (!vw) {
      return;
    }
    // Lista recuada: vale a largura, e a coluna começa no topo (como no grafo empilhado).
    const s = clamp(narrow ? vw / bounds.w : Math.min(vw / bounds.w, vh / bounds.h), MIN_SCALE, MAX_FIT);
    scale = s;
    tx = (vw - bounds.w * s) / 2 - bounds.x * s;
    ty = narrow && bounds.h * s > vh ? -bounds.y * s : (vh - bounds.h * s) / 2 - bounds.y * s;
    applyTransform();
  }

  let panning = false;
  let panStart = { x: 0, y: 0 };
  canvas.addEventListener('pointerdown', (e) => {
    panning = true;
    panStart = { x: e.clientX - tx, y: e.clientY - ty };
    tree.classList.add('is-panning');
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!panning) {
      return;
    }
    tx = e.clientX - panStart.x;
    ty = e.clientY - panStart.y;
    userView = true;
    applyTransform();
  });
  const endPan = (e: PointerEvent): void => {
    panning = false;
    tree.classList.remove('is-panning');
    if (canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
  };
  canvas.addEventListener('pointerup', endPan);
  canvas.addEventListener('pointercancel', endPan);
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (narrow && !e.ctrlKey && !e.metaKey) {
        ty -= e.deltaY;
        userView = true;
        applyTransform();
        return;
      }
      const r = canvas.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const next = clamp(scale * Math.exp(-e.deltaY * 0.0016), MIN_SCALE, MAX_SCALE);
      tx = px - (px - tx) * (next / scale);
      ty = py - (py - ty) * (next / scale);
      scale = next;
      userView = true;
      applyTransform();
    },
    { passive: false },
  );
  fitBtn.addEventListener('click', () => {
    userView = false;
    fit();
  });

  let lastW = 0;
  let lastH = 0;
  const ro = new ResizeObserver(() => {
    const w = tree.clientWidth;
    const hgt = tree.clientHeight;
    if (!w) {
      return;
    }
    const nextNarrow = w < NARROW;
    if (nextNarrow !== narrow) {
      narrow = nextNarrow;
      treeSig = '';
      paintTree();
    } else if ((Math.abs(w - lastW) > 1 || Math.abs(hgt - lastH) > 1) && !userView) {
      fit();
    }
    lastW = w;
    lastH = hgt;
    place();
  });
  ro.observe(tree);

  // ---------- painel ----------

  function paintPanel(): void {
    const searches = agents.filter((a) => a.search);
    const jobs = agents.filter((a) => a.infra?.kind === 'job');
    const hyps = lab.hypotheses;
    const pendingVerif = hyps.filter((x) => x.verification?.seal === 'verificando' || (x.verdict?.verdict === 'suportada' && !x.verification));
    const sig = JSON.stringify([
      hyps.map((x) => [x.id, x.title, x.status, x.pruned, x.verdict?.at, x.verdict?.diff, x.verification?.seal, x.runs.length]),
      lab.runs,
      searches.map((a) => [a.id, a.status, a.search!.progress, a.description]),
      jobs.map((a) => [a.id, a.status, a.infra!.state, a.infra!.costUsd]),
      highlight,
    ]);
    panel.hidden = !hyps.length && !searches.length && !jobs.length;
    if (sig === panelSig) {
      return;
    }
    panelSig = sig;

    // Faixa: pílulas de status (clique destaca na árvore), runs e verificações pendentes.
    const chips: HTMLElement[] = [toggle];
    const count = (key: string): number => (key === 'podada' ? hyps.filter((x) => x.pruned).length : hyps.filter((x) => x.status === key && !x.pruned).length);
    for (const s of STATUS_ORDER) {
      const n = count(s.key);
      if (!n) {
        continue;
      }
      const i = h('i');
      i.style.setProperty(`--${P}-c`, s.color);
      const chip = h('button', `${P}-chip`, i, h('b', undefined, String(n)), s.label);
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(highlight === s.key));
      chip.title = highlight === s.key ? 'Mostrar todas' : `Destacar na árvore as ${s.label}`;
      chip.addEventListener('click', () => {
        highlight = highlight === s.key ? undefined : s.key;
        paintHighlight();
        paintPanel();
      });
      chips.push(chip);
    }
    const stat = (n: number, label: string): HTMLElement => h('span', `${P}-stat`, h('b', undefined, String(n)), ` ${label}`);
    chips.push(stat(lab.runs, lab.runs === 1 ? 'run' : 'runs'));
    if (pendingVerif.length) {
      chips.push(stat(pendingVerif.length, pendingVerif.length === 1 ? 'verificação pendente' : 'verificações pendentes'));
    }
    const liveSearches = searches.filter((a) => a.status === 'running').length;
    const liveJobs = jobs.filter((a) => a.infra?.state === 'running' || a.infra?.state === 'pending').length;
    if (liveSearches + liveJobs) {
      chips.push(stat(liveSearches + liveJobs, 'em andamento'));
    }
    bar.replaceChildren(...chips);

    const parts: HTMLElement[] = [];
    if (searches.length || jobs.length) {
      parts.push(h('div', `${P}-label`, 'Buscas e jobs'));
      const ordered = [...searches, ...jobs].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running'));
      for (const a of ordered) {
        parts.push(agentRow(a));
      }
    }
    if (pendingVerif.length) {
      parts.push(h('div', `${P}-label`, 'Verificações pendentes'));
      for (const x of pendingVerif) {
        parts.push(hypRow('v', x, x.verification?.seal === 'verificando' ? `verificando · ${x.verification.agent}` : 'suportada, sem verificação'));
      }
    }
    if (hyps.length) {
      parts.push(h('div', `${P}-label`, `Hipóteses (${hyps.length})`));
      for (const x of hyps) {
        const v = x.verdict;
        const arms = armStats(x);
        const side = v && Number.isFinite(v.diff) ? `${signed(v.diff)} [${fmt(v.ci[0])}, ${fmt(v.ci[1])}]` : `seeds ${Math.min(...arms.map((a) => a.n))}/${x.minSeeds}`;
        parts.push(hypRow('h', x, side));
      }
    }
    // Linha que saiu do painel (busca removida, verificação concluída) sai do cache também.
    for (const [key, row] of rows) {
      if (!parts.includes(row)) {
        rows.delete(key);
      }
    }
    drawer.replaceChildren(...parts);
  }

  function agentRow(a: AgentInfo): HTMLElement {
    const kind = a.search?.kind ?? 'job';
    const iconName = kind === 'tournament' ? 'law' : kind === 'sweep' ? 'settings-gear' : 'server-process';
    const running = a.status === 'running' || a.infra?.state === 'running' || a.infra?.state === 'pending';
    const progress = a.search?.progress ?? jobLine(a);
    const row = stableRow(
      `a:${a.id}`,
      `${P}-row${running ? ' is-running' : ''}`,
      [codicon(iconName), h('span', `${P}-row-main`, a.description, h('small', undefined, a.id)), h('span', `${P}-row-side`, progress)],
      (el) => {
        closePopup();
        deps.openAgentPopup(a.id, el);
      },
    );
    row.dataset.agent = a.id;
    row.title = `${a.description}${a.summary ? `\n${a.summary}` : ''}\nclique para detalhes`;
    return row;
  }

  /**
   * Linhas reaproveitadas por chave: o popup aberto numa linha continua ancorado nela quando o painel se
   * redesenha (run novo, progresso da busca). Só o conteúdo e a ação do clique trocam.
   */
  const rows = new Map<string, HTMLButtonElement & { act?: () => void }>();
  function stableRow(key: string, cls: string, children: Node[], onClick: (row: HTMLButtonElement) => void): HTMLButtonElement {
    let row = rows.get(key);
    if (!row) {
      const fresh: HTMLButtonElement & { act?: () => void } = h('button');
      fresh.type = 'button';
      fresh.addEventListener('click', () => fresh.act?.());
      rows.set(key, fresh);
      row = fresh;
    }
    const r = row;
    r.className = cls;
    r.act = () => onClick(r);
    r.replaceChildren(...children);
    return r;
  }

  function jobLine(a: AgentInfo): string {
    const x = a.infra!;
    const state = { pending: 'na fila', running: 'rodando', completed: 'terminou', failed: 'falhou', cancelled: 'cancelado', lost: 'perdido' }[x.state ?? 'pending'];
    return `${x.backend ?? ''} · ${state}${x.costUsd !== undefined ? ` · US$ ${x.costUsd.toFixed(2)}` : ''}`;
  }

  function hypRow(section: string, x: LabHypothesisInfo, side: string): HTMLElement {
    const dot = h('span', `${P}-row-dot${x.pruned ? ' is-pruned' : ''}`);
    dot.style.setProperty(`--${P}-c`, hypColor(x) ?? (x.status === 'rodando' ? STATUS_RING.running : NEUTRAL));
    return stableRow(
      `${section}:${x.id}`,
      `${P}-row${x.pruned ? ' is-pruned' : ''}`,
      [dot, h('span', `${P}-row-main`, `${x.id} · ${x.title}`, h('small', undefined, `${STATUS_LABEL[x.status]}${x.pruned ? ' · podada' : ''}`)), h('span', `${P}-row-side`, side)],
      (row) => {
        select(x.id);
        openHyp(x.id, row, () => (row.isConnected && row.offsetParent !== null ? row.getBoundingClientRect() : undefined), false);
      },
    );
  }

  // ---------- entrada ----------

  function refresh(): void {
    nodes = buildTree(lab.hypotheses, agents);
    // Poda confirmada pelo host: libera o botão.
    for (const [id, want] of [...pending]) {
      const hyp = lab.hypotheses.find((x) => x.id === id);
      if (!hyp || !!hyp.pruned === want) {
        pending.delete(id);
      }
    }
    paintTree();
    paintPanel();
    if (!pop.hidden) {
      fillPopup();
      place();
    }
  }

  return {
    element,
    update(state: LabState): void {
      lab = state;
      refresh();
    },
    setAgents(list: AgentInfo[]): void {
      agents = list;
      // Agentes mudam o tempo todo (tokens, tique): só as buscas, os jobs e os nomes interessam aqui.
      const sig = JSON.stringify(list.filter((a) => a.search || a.infra?.kind === 'job').map((a) => [a.id, a.status, a.search?.progress, a.infra?.state, a.infra?.costUsd]));
      if (sig !== agentsSig) {
        agentsSig = sig;
        refresh();
      }
    },
    closePopup,
    get hasData(): boolean {
      return lab.hypotheses.length > 0 || agents.some((a) => a.search || a.infra?.kind === 'job');
    },
  };
}

