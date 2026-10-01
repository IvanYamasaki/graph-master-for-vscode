/**
 * Grafo dos agentes da conversa: a raiz (conversa principal), cada agente e o nó "você".
 *
 * Duas relações, com traços diferentes. Criação é tracejada e fina, sem seta. Entrega do relatório
 * é sólida e grossa, com seta em quem recebe; enquanto o agente trabalha, a entrega ainda não
 * aconteceu e a linha fica apagada, com pontos correndo na direção do destino. Uma legenda no canto
 * explica os traços. Duas camadas de cor: a cor própria do agente, que pinta o nó e as arestas que
 * saem dele, e um anel de estado por cima (verde quando está trabalhando, vermelho quando parou).
 *
 * O componente é autossuficiente: cria o próprio SVG por script, injeta o próprio <style>
 * com prefixo `agm-graph-` e não depende de nada do main.ts nem do chat.css.
 */
import { agentColor, isWorking, STATUS_LABEL, STATUS_RING, pendingText, watchLabel, repeatLabel, onOtherAccount, shortAccountName, type AgentInfo, type BoxInfo } from '../chat/protocol';
import { autoCollapsed, boxCountText, boxSpend, boxStats, spendDetail, groupAgents, LOOSE_BOX, type Grouping } from './boxModel';
import { markGraphNode } from './worktreeUi';
import { markAttemptNode } from './parallelUi';
import { budgetMeter, markGuardNode, type GraphMeter } from './guardUi';
import { markInfraNode } from './infraUi';
import { markSynthNode } from './synthUi';

export interface AgentGraphOptions {
  /**
   * Clique (ou Enter) num nó de agente ou na raiz (`main`). `anchor` é o retângulo do nó na tela,
   * para quem abre um popup ao lado dele. `byKey` diz que veio do teclado.
   */
  onSelect?: (id: string, anchor: DOMRect, byKey: boolean) => void;
  /** Câmera ou nós mudaram de lugar na tela (zoom, arrasto, relayout): popups ancorados se reposicionam. */
  onViewChange?: () => void;
  /** Rótulo do nó raiz (a conversa principal). */
  rootLabel?: string;
  /**
   * O grafo ocupa a altura que o container der (100%) em vez de crescer com o conteúdo.
   * É o modo da vista principal do mapa.
   */
  fill?: boolean;
  /** O usuário ligou ou desligou um tipo de linha pela legenda; quem usa o grafo guarda a escolha. */
  onEdgeVisibilityChange?: (v: EdgeVisibility) => void;
  /** Escolha salva do usuário para a caixa (true = recolhida). Sem escolha, vale a regra automática. */
  getFold?: (boxId: string) => boolean | undefined;
  /** O usuário recolheu ou expandiu uma caixa; quem usa o grafo guarda a escolha. */
  onFoldChange?: (boxId: string, collapsed: boolean) => void;
  /** Agente com decisão pendente do usuário: a caixa dele fica aberta. */
  needsAttention?: (agentId: string) => boolean;
  /**
   * Enquanto devolver true (mapa aberto e visível), a regra automática não muda o recolhimento de uma caixa
   * que já apareceu: mudar sozinho faz a lista e o grafo pularem. Vale de novo depois de releaseAutoFolds.
   */
  holdAutoFold?: () => boolean;
}

/** Quais linhas aparecem. Esconder não muda o layout: só as linhas somem. */
export interface EdgeVisibility {
  creation: boolean;
  delivery: boolean;
}

export interface AgentGraph {
  /** Elemento a inserir no DOM. Já vem com os estilos aplicados. */
  readonly element: HTMLElement;
  /** Redesenha com a lista atual. Chamado a cada atualização de agente. */
  update(agents: AgentInfo[]): void;
  /** Destaca um nó (por exemplo, o agente aberto no painel de detalhe). */
  select(id: string | undefined): void;
  /** Retângulo do nó na tela, ou undefined se ele não existe. */
  nodeRect(id: string): DOMRect | undefined;
  /** Mostra ou esconde as linhas de criação e de entrega (o mesmo que clicar na legenda, sem avisar de volta). */
  setEdgeVisibility(v: EdgeVisibility): void;
  /** Caixas da conversa. Vale a partir do próximo update. */
  setBoxes(boxes: BoxInfo[]): void;
  /** Recolhe ou expande a caixa (id da caixa, sem o prefixo "box:") e avisa onFoldChange. */
  toggleBox(boxId: string): void;
  isBoxCollapsed(boxId: string): boolean;
  /** Esquece os recolhimentos automáticos segurados: o próximo update recalcula (o mapa abrindo de novo). */
  releaseAutoFolds(): void;
  destroy(): void;
}

/** Id do nó (ou da moldura) de uma caixa no grafo. O popup e o onSelect recebem este id. */
export const BOX_NODE = 'box:';

const NS = 'http://www.w3.org/2000/svg';
const P = 'agm-graph';

// Geometria dos nós. Uniforme entre raiz e agentes para as colunas ficarem alinhadas.
const NODE_W = 172;
const NODE_H = 54;
const USER_W = 92;
const USER_H = 36;
const GAP_Y = 20;
/** Espaço entre colunas: é onde as arestas fazem a curva, então não pode ser apertado. */
const GAP_X = 96;
const PAD = 18;
/** Recuo por nível no modo estreito, onde cada nó ocupa uma linha só. */
const INDENT = 18;
const ROW_GAP = 18;
/** Caracteres por linha do título, em duas linhas: cabe a descrição inteira da maioria dos agentes. */
const TITLE_CHARS = 25;
const TITLE_LINES = 2;
/** Altura de linha do título, em unidades do SVG. */
const TITLE_LEAD = 11.5;
/** Abaixo disso o grafo vira lista recuada: uma coluna só cabe num painel de 320px. */
const NARROW = 420;
const MIN_SCALE = 0.5;
const MAX_SCALE = 2.5;
/** No modo `fill` sobra espaço: o enquadramento automático pode ampliar um pouco um grafo pequeno. */
const FILL_MAX_FIT = 1.25;
/** Distância entre arestas paralelas do mesmo par de nós (criação na ida, entrega na volta). */
const PAIR_GAP = 10;
const ACCENT = '#d97757';
const BLOCKED = '#a85450';
/** Raiz e "você" ficam fora da paleta dos agentes para não competir com eles. */
const NEUTRAL = '#8b8f96';

// Caixas. Nó-resumo de caixa recolhida: um pouco maior que o de agente, com a fila de pontos embaixo.
const SUM_W = 188;
const SUM_H = 66;
/** Moldura de caixa aberta: margem lateral, faixa do título e margem de baixo. */
const FR_PAD = 14;
const FR_HEAD = 30;
const FR_BOTTOM = 14;
/** Espaço entre os nós dentro da caixa: cabe o anel de estado dos dois vizinhos. */
const IN_GAP_X = 26;
const IN_GAP_Y = 24;
/** Entre colunas de caixas (é o canal por onde a aresta desce) e entre caixas empilhadas numa coluna. */
const COL_GAP = 34;
const STACK_GAP = 16;
/** Metade do vão entre fileiras de caixas: a calha por onde as arestas correm fica no meio dele. */
const GUTTER_HALF = 18;
/** Da raiz até a área das caixas; o tronco das arestas fica no meio. */
const TRUNK_GAP = 60;
/** Abaixo desta largura (em pixels da tela), a raiz vai para cima das caixas em vez de ficar à esquerda. */
const ROOT_TOP_BELOW = 720;
/** Árvore de avulsos (um agente e os que ele criou): distância entre as colunas. */
const TREE_GAP_X = 56;
/** Pontos de status no nó-resumo. Passando disso, "+N". */
const MAX_DOTS = 14;
/** Glifos codicon. */
const GLYPH_CHEV_RIGHT = '\ueab6';
const GLYPH_CHEV_DOWN = '\ueab4';
const GLYPH_BRANCH = '\uec6f';
/** Relógio (codicon-clock): agente aguardando processo, filhos ou resposta. */
const GLYPH_CLOCK = '\uea82';
/**
 * Espaço entre a borda do nó e o anel de estado. Precisa ser folgado: com `rosa` ou `terracota`
 * na frente do anel vermelho, duas faixas coladas viram uma mancha só.
 */
const RING_GAP = 5;
/** Onde fica o fosso: colado na borda escura do nó, por dentro do anel. */
const MOAT_GAP = 2.3;
/** Contorno escuro colado na cor própria, para ela nunca encostar no anel de estado. */
const EDGE_DARK = 'rgba(0,0,0,0.55)';

let instanceSeq = 0;

// ---------- estilos ----------

const CSS = `
.${P} {
  position: relative;
  width: 100%;
  height: 300px;
  overflow: hidden;
  border-radius: 10px;
  border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.28));
  background: var(--vscode-editor-background, #1e1e1e);
  user-select: none;
  contain: strict;
}
.${P}-canvas { display: block; width: 100%; height: 100%; cursor: grab; touch-action: none; }
.${P}.is-panning .${P}-canvas { cursor: grabbing; }
.${P}-fit {
  position: absolute; top: 8px; right: 8px; width: 26px; height: 26px;
  display: inline-flex; align-items: center; justify-content: center; padding: 0;
  font: 11px var(--vscode-font-family, sans-serif);
  color: var(--vscode-descriptionForeground, #9aa0a6);
  background: var(--vscode-editorWidget-background, #252526);
  border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
  border-radius: 6px; cursor: pointer;
}
.${P}-fit .codicon { font-size: 14px; }
.${P}-fit:hover { color: var(--vscode-foreground, #ccc); border-color: ${ACCENT}; }
.${P}-fit:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: 1px; }
.${P}-fit[hidden] { display: none; }
.${P}-probe { position: absolute; left: 0; top: 0; width: 100%; height: 0; pointer-events: none; }
/* Sem agentes: a raiz fica sozinha no meio e a frase logo abaixo dela diz por quê. */
.${P}-empty {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  padding-top: 110px; pointer-events: none; text-align: center;
  font: 13px var(--vscode-font-family, sans-serif);
  color: var(--vscode-descriptionForeground, #9aa0a6);
}

.${P}-node { cursor: pointer; outline: none; }
.${P}-box { stroke-width: 1.6; }
.${P}-node.is-neutral .${P}-box {
  fill: var(--vscode-editorWidget-background, #252526);
  stroke: var(--vscode-widget-border, rgba(140,140,140,0.5));
}
.${P}-node.is-user .${P}-box { fill: none; stroke-dasharray: 4 3; }
/* Concluído fica mais quieto que o ativo, sem perder a cor de identidade. No claro o fundo branco já clareia a
   cor: esmaecer menos mantém o título legível. */
.${P}-quiet { opacity: 0.66; }
.vscode-light .${P}-quiet { opacity: 0.8; }
/* Tentativa perdedora de um Best-of-N: esmaece mais que "concluído", sem sumir. */
.${P}-quiet.${P}-faded, .${P}-faded { opacity: 0.34; }
.${P}-node:focus-visible .${P}-sel, .${P}-node.is-selected .${P}-sel { opacity: 1; }
.${P}-sel { fill: none; stroke: var(--vscode-focusBorder, #ffffff); stroke-width: 1.6; opacity: 0; }
.${P}-title { font: 600 10.5px var(--vscode-font-family, "Segoe UI", sans-serif); }
.${P}-sub { font: 9.5px var(--vscode-font-family, "Segoe UI", sans-serif); }
/* Ícone de tipo dos nós sintéticos: glifo da fonte codicon, discreto. */
.${P}-icon { font: 12px codicon; opacity: 0.8; pointer-events: none; }
/* Marcador do dono do navegador: globo num círculo, no canto de cima à direita do nó. */
.${P}-badge circle.bg { fill: var(--vscode-editor-background, #1e1e1e); stroke: var(--vscode-foreground, #cccccc); stroke-width: 1.2; }
.${P}-badge .globe { fill: none; stroke: var(--vscode-foreground, #cccccc); stroke-width: 1.1; }
.${P}-node.is-neutral .${P}-title { fill: var(--vscode-foreground, #cccccc); }
.${P}-node.is-neutral .${P}-sub { fill: var(--vscode-descriptionForeground, #9aa0a6); }
.${P}-ring { fill: none; stroke-width: 2; }
.${P}-meterbg { fill: rgba(0,0,0,0.35); }
/* Fosso entre a cor própria e o anel: pintado na cor do fundo do grafo, nunca some no tema claro. */
.${P}-moat { fill: none; stroke: var(--vscode-editor-background, #1e1e1e); stroke-width: 3; }
.${P}-halo { fill: none; stroke-width: 2; opacity: 0; }

.${P}-edge { fill: none; stroke-linecap: round; transition: opacity 160ms ease, stroke-width 160ms ease; }
/* Criação: tracejada e fina, sem seta. Entrega: sólida, grossa, com seta em quem recebe. */
.${P}-edge.is-create { stroke-opacity: 0.8; stroke-width: 1.6; stroke-dasharray: 5 4; stroke-linecap: butt; }
.${P}-edge.is-deliver { stroke-opacity: 1; stroke-width: 2.6; }
/* Entrega que ainda não aconteceu (agente rodando): trilho apagado, os pontos da camada de fluxo andam por cima. */
.${P}-edge.is-deliver.is-pending { stroke-opacity: 0.32; }
/* Parou sem entregar: a rota prometida fica, bem apagada. */
.${P}-edge.is-deliver.is-dim { stroke-opacity: 0.28; stroke-width: 2; }
.${P}-edge.is-blocked { stroke: ${BLOCKED}; stroke-opacity: 0.9; stroke-width: 2; stroke-dasharray: 5 4; }
.${P}-flow { fill: none; stroke-width: 3.4; stroke-linecap: round; stroke-dasharray: 0.1 10; pointer-events: none;
  animation: ${P}-flow 900ms linear infinite; transition: opacity 160ms ease; }
@keyframes ${P}-flow { from { stroke-dashoffset: 20.2; } to { stroke-dashoffset: 0; } }
.${P}-cut { stroke: ${BLOCKED}; stroke-opacity: 0.9; stroke-width: 1.8; stroke-linecap: round; fill: none; }
.${P}-cutlabel { fill: ${BLOCKED}; font: 8.5px var(--vscode-font-family, sans-serif); text-anchor: middle; }
.${P}-node > g { transition: opacity 160ms ease; }

/* Realce por hover: as arestas do nó engrossam e o resto esmaece, sem sumir de todo. */
.${P}-canvas.is-hovering .${P}-node:not(.is-hot) > g,
.${P}-canvas.is-hovering .${P}-edge:not(.is-hot),
.${P}-canvas.is-hovering .${P}-flow:not(.is-hot),
.${P}-canvas.is-hovering .${P}-cut:not(.is-hot),
.${P}-canvas.is-hovering .${P}-cutlabel:not(.is-hot) { opacity: 0.14; }
.${P}-canvas.is-hovering .${P}-edge.is-hot.is-create { stroke-opacity: 1; stroke-width: 2.2; }
.${P}-canvas.is-hovering .${P}-edge.is-hot.is-deliver { stroke-width: 3.4; }
.${P}-canvas.is-hovering .${P}-edge.is-hot.is-deliver.is-pending { stroke-opacity: 0.5; }

.${P}-legend {
  position: absolute; left: 8px; bottom: 8px; max-width: calc(100% - 16px);
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px;
  padding: 4px 9px; border-radius: 6px; pointer-events: none;
  font: 10.5px var(--vscode-font-family, sans-serif);
  color: var(--vscode-descriptionForeground, #9aa0a6);
  background: color-mix(in srgb, var(--vscode-editorWidget-background, #252526) 88%, transparent);
  border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
}
.${P}-legend-item { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
/* "criou" e "entregou" são interruptores: clicar esconde aquele tipo de linha no grafo. */
.${P}-legend-toggle {
  pointer-events: auto; cursor: pointer; font: inherit; color: inherit; background: none;
  border: 1px solid transparent; border-radius: 4px; padding: 1px 4px; margin: -2px -5px;
  transition: opacity 160ms ease, border-color 160ms ease;
}
.${P}-legend-toggle:hover { border-color: var(--vscode-widget-border, rgba(128,128,128,0.5)); color: var(--vscode-foreground, #ccc); }
.${P}-legend-toggle:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: 1px; }
.${P}-legend-toggle[aria-pressed="false"] { opacity: 0.4; text-decoration: line-through; }
/* Linhas escondidas somem com a mesma transição do hover e deixam de receber o ponteiro. Vence o realce do hover. */
.${P}.hide-create .${P}-edge.is-create,
.${P}.hide-deliver .${P}-edge.is-deliver,
.${P}.hide-deliver .${P}-flow,
.${P}.hide-deliver .${P}-particle { opacity: 0 !important; pointer-events: none; }
.${P}-legend svg { display: block; overflow: visible; }
.${P}-legend-hint { opacity: 0.8; }
/* Painel estreito: a legenda encolhe para não cobrir a coluna de nós. */
.${P}.is-narrow .${P}-legend { gap: 2px 8px; padding: 3px 7px; font-size: 10px; }
.${P}.is-narrow .${P}-legend-hint { display: none; }
.${P}.is-narrow .${P}-legend svg { width: 20px; }
.${P}.is-fill { height: 100%; min-height: 220px; }

.${P}-enter { animation: ${P}-in 380ms ease-out both; }
@keyframes ${P}-in { from { opacity: 0; transform: scale(0.82); } to { opacity: 1; transform: scale(1); } }
.${P}-pulse.is-running { animation: ${P}-breathe 2.6s ease-in-out infinite; }
@keyframes ${P}-breathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.03); } }
.${P}-halo.is-running { animation: ${P}-halo 2.6s ease-out infinite; }
@keyframes ${P}-halo {
  0% { opacity: 0.6; transform: scale(0.95); }
  70% { opacity: 0; transform: scale(1.1); }
  100% { opacity: 0; transform: scale(1.1); }
}

/* Caixas: moldura da caixa aberta (título clicável recolhe) e nó-resumo da caixa recolhida (pilha de cartões). */
.${P}-frame-bg { stroke-width: 1.2; }
.${P}-frame.is-selected .${P}-frame-bg { stroke-width: 2.4; }
.${P}-frame-head { cursor: pointer; outline: none; }
.${P}-frame-hit { fill: transparent; }
.${P}-frame-head:focus-visible .${P}-frame-hit { stroke: var(--vscode-focusBorder, #007fd4); stroke-width: 1.4; }
.${P}-frame-head:hover .${P}-frame-chev { fill: var(--vscode-foreground, #cccccc); }
.${P}-frame-title { font: 600 11px var(--vscode-font-family, "Segoe UI", sans-serif); fill: var(--vscode-foreground, #cccccc); pointer-events: none; }
.${P}-frame-count { font-weight: 400; fill: var(--vscode-descriptionForeground, #9aa0a6); }
.${P}-frame-chev { font: 13px codicon; fill: var(--vscode-descriptionForeground, #9aa0a6); pointer-events: none; }
.${P}-node.is-boxnode .${P}-title { fill: var(--vscode-foreground, #cccccc); }
.${P}-node.is-boxnode .${P}-sub { fill: var(--vscode-descriptionForeground, #9aa0a6); }
.${P}-boxglyph { font: 12px codicon; fill: var(--vscode-descriptionForeground, #9aa0a6); pointer-events: none; }
.${P}-node.is-boxnode:hover .${P}-boxchev { fill: var(--vscode-foreground, #cccccc); }
.${P}-dotsmore { font: 9px var(--vscode-font-family, sans-serif); fill: var(--vscode-descriptionForeground, #9aa0a6); }

@media (prefers-reduced-motion: reduce) {
  .${P}-enter, .${P}-pulse.is-running, .${P}-halo.is-running, .${P}-flow { animation: none; }
  .${P}-halo.is-running { opacity: 0.35; }
}
`;

function ensureStyles(): void {
  if (document.getElementById(`${P}-style`)) {
    return;
  }
  const style = document.createElement('style');
  style.id = `${P}-style`;
  style.textContent = CSS;
  document.head.append(style);
}

// ---------- utilidades ----------

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      node.setAttribute(k, String(v));
    }
  }
  return node;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Título em até `maxLines` linhas, quebrando por palavra. Só a última linha leva reticências,
 * e só quando o que sobrou ainda não cabe: "Revisar o diff inteiro do webview" cabe todo em duas.
 */
function wrapTitle(text: string, perLine: number, maxLines: number): string[] {
  let rest = text.replace(/\s+/g, ' ').trim();
  const lines: string[] = [];
  while (rest.length > perLine && lines.length < maxLines - 1) {
    const cut = rest.lastIndexOf(' ', perLine);
    if (cut <= 0) {
      // Palavra sozinha maior que a linha: não há onde quebrar, o corte vai para a última linha.
      break;
    }
    lines.push(rest.slice(0, cut));
    rest = rest.slice(cut + 1);
  }
  lines.push(truncate(rest, perLine));
  return lines;
}

/**
 * Texto escrito por cima da cor do agente: preto ou branco, o que tiver mais contraste.
 * A paleta é fixa, então o cálculo vale igual em tema claro e escuro.
 */
function readableOn(hex: string): string {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return (L + 0.05) / 0.05 >= 1.05 / (L + 0.05) ? '#14161a' : '#ffffff';
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const KIND_LABEL: Record<AgentInfo['kind'], string> = {
  subagent: 'subagente',
  routed: 'agente',
  fork: 'continuação',
};

const WHO: Record<string, string> = {
  main: 'conversa principal',
  user: 'só você',
  bloqueado: 'entrega bloqueada',
  parent: 'quem criou',
};

function whoLabel(id: string | undefined, rootLabel: string): string {
  if (!id) {
    return 'ninguém';
  }
  if (id === 'main') {
    return rootLabel;
  }
  return WHO[id] ?? id;
}

function prettyModel(id: string): string {
  // Modelos do Codex (gpt-5.6-terra) não seguem o família-versão do Claude: só capitaliza.
  if (/^(gpt|codex|o\d)/i.test(id)) {
    return id.replace(/^gpt/i, 'GPT').replace(/-([a-z])/g, (_m, c: string) => `-${c.toUpperCase()}`);
  }
  const long = /\[(\d+)m\]$/i.exec(id);
  const [family, ...rest] = (long ? id.slice(0, long.index) : id).replace(/^claude-/, '').split('-');
  if (!/^[a-z]/i.test(family ?? '')) {
    return id;
  }
  const version = rest.filter((p) => /^\d{1,3}$/.test(p)).join('.');
  return `${family.charAt(0).toUpperCase()}${family.slice(1)}${version ? ` ${version}` : ''}${long ? ` (${long[1]}M)` : ''}`;
}

/**
 * Anel de estado: verde pulsando enquanto trabalha, âmbar claro parado enquanto aguarda (processo, filhos ou
 * resposta; não é o âmbar forte do "possivelmente preso"), vermelho parado quando parou ou falhou.
 */
function ringFor(status: AgentInfo['status']): { color: string; pulse: boolean } | undefined {
  if (status === 'running') {
    return { color: STATUS_RING.running, pulse: true };
  }
  if (status === 'waiting') {
    return { color: STATUS_RING.waiting, pulse: false };
  }
  if (status === 'failed' || status === 'stopped') {
    return { color: STATUS_RING.halted, pulse: false };
  }
  return undefined;
}

// ---------- modelo do grafo ----------

type NodeKind = 'root' | 'agent' | 'user' | 'box';

interface NodeModel {
  id: string;
  kind: NodeKind;
  /** Título já quebrado em linhas. */
  title: string[];
  sub: string;
  detail: string;
  aria: string;
  /** Cor própria: preenche o nó e tinge as arestas que saem dele. */
  color: string;
  text: string;
  ring?: { color: string; pulse: boolean };
  running: boolean;
  quiet: boolean;
  /** Tentativa que perdeu um Best-of-N: bem mais apagada que `quiet`. */
  faded?: boolean;
  /** Está com o navegador (Claude in Chrome) agora: ganha o marcador de globo. */
  browser?: boolean;
  /** Barra fina de consumo do orçamento, na base do nó. */
  meter?: GraphMeter;
  /** Nó sintético (tentativa, busca, job, vigia de treino, verificador): glifo codicon do tipo, antes do título. */
  icon?: string;
  /** Progresso do nó sintético, de 0 a 1: barra fina na base quando não há barra de orçamento. */
  progress?: number;
  /** Nó-resumo de caixa recolhida: um ponto por agente (cor própria e anel de estado) e o que sobrar. */
  dots?: { color: string; ring?: string }[];
  moreDots?: number;
  /** Nó-resumo: algum agente da caixa tem worktree. */
  branch?: boolean;
  parent?: string;
  depth: number;
  /** Posição entre os irmãos: separa as calhas no modo estreito. */
  lane: number;
  w: number;
  h: number;
  x: number;
  y: number;
}

type EdgeKind = 'create' | 'deliver' | 'blocked';

/** Entrega: `done` já aconteceu, `pending` o agente ainda trabalha, `dim` parou sem entregar. */
type DeliverState = 'done' | 'pending' | 'dim';

interface EdgeModel {
  id: string;
  from: string;
  /** Vazio na entrega bloqueada: a seta morre num toco ao lado do nó. */
  to: string;
  kind: EdgeKind;
  state?: DeliverState;
  color: string;
  detail: string;
  /**
   * Deslocamento perpendicular, no sentido da própria aresta. Criação e entrega entre o mesmo par
   * correm lado a lado em vez de uma cobrir a outra.
   */
  offset: number;
  /**
   * Aresta entre a raiz e um bloco do primeiro nível (caixa ou avulso), no modo de caixas. Corre pelo tronco,
   * pela calha acima da fileira e pelo canal da coluna, sem atravessar caixa nenhuma. `block` é o bloco;
   * as coordenadas vêm do layout.
   */
  bus?: { block: string; xt: number; ya: number; gy?: number; xc?: number };
}

/** Moldura de uma caixa aberta. x e y são o canto de cima à esquerda. */
interface FrameModel {
  id: string;
  name: string;
  color: string;
  count: string;
  detail: string;
  /** 0: caixa do primeiro nível; 1: caixa filha, desenhada por cima da mãe. */
  depth: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Bloco do primeiro nível no modo de caixas: uma caixa (moldura ou nó-resumo) ou uma árvore de avulsos. */
interface BlockModel {
  /** `box:<id>` para caixa; id do agente que é a raiz da árvore de avulsos. */
  id: string;
  kind: 'group' | 'tree';
  w: number;
  h: number;
  x: number;
  y: number;
  /** Onde a aresta da raiz entra: y absoluto e borda esquerda. Preenchidos pelo layout. */
  entryY: number;
  row: number;
  col: number;
  stack: number;
}

interface Model {
  nodes: NodeModel[];
  edges: EdgeModel[];
  byId: Map<string, NodeModel>;
  /** Modo de caixas: há ao menos uma caixa (ou a caixa "Avulsos"). Sem ele, o grafo é a árvore de sempre. */
  blocks?: BlockModel[];
  frames: FrameModel[];
  grouping?: Grouping;
  /** Caixas recolhidas agora (ids sem o prefixo). */
  collapsed: Set<string>;
  /** Nó visível que representa cada agente: ele mesmo, ou o nó-resumo da caixa recolhida. */
  anchorOf: Map<string, string>;
  /** Raiz da árvore de avulsos de cada agente solto. */
  treeOf: Map<string, string>;
  /** Tronco e raiz, para as arestas de barramento. */
  route?: { rootX: number; rootY: number; rootW: number; rootH: number; vertical: boolean };
}

/** Fork não carrega `creator`; o nome dele é o do original mais " (continuação)". */
function inferForkOrigin(agent: AgentInfo, byDescription: Map<string, string>): string | undefined {
  const m = /^(.*)\s*\(continuaç[ãa]o\)\s*$/i.exec(agent.description ?? '');
  return m ? byDescription.get(m[1].trim()) : undefined;
}

function buildModel(agents: AgentInfo[], rootLabel: string, boxes: BoxInfo[] = [], collapsedOf: (id: string, all: AgentInfo[]) => boolean = () => false): Model {
  const ids = new Set(agents.map((a) => a.id));
  const byDescription = new Map<string, string>();
  for (const a of agents) {
    if (a.description && !byDescription.has(a.description.trim())) {
      byDescription.set(a.description.trim(), a.id);
    }
  }

  const parentOf = new Map<string, string>();
  for (const a of agents) {
    let parent = a.creator && (a.creator === 'main' || ids.has(a.creator)) ? a.creator : undefined;
    if (!parent && a.kind === 'fork') {
      parent = inferForkOrigin(a, byDescription);
    }
    parentOf.set(a.id, parent && parent !== a.id ? parent : 'main');
  }
  // Ciclo na cadeia de criação penduraria os dois nós um no outro e o layout entraria em loop.
  for (const a of agents) {
    const seen = new Set<string>([a.id]);
    let cur = parentOf.get(a.id);
    while (cur && cur !== 'main') {
      if (seen.has(cur)) {
        parentOf.set(a.id, 'main');
        break;
      }
      seen.add(cur);
      cur = parentOf.get(cur);
    }
  }

  const destOf = new Map<string, string>();
  let needsUser = false;
  for (const a of agents) {
    const raw = a.reportedTo ?? a.reportTo;
    if (!raw) {
      continue;
    }
    const dest = raw === 'parent' ? (parentOf.get(a.id) ?? 'main') : raw;
    if (dest === 'user') {
      needsUser = true;
      destOf.set(a.id, 'user');
    } else if (dest === 'bloqueado') {
      destOf.set(a.id, 'bloqueado');
    } else if (dest === 'main' || ids.has(dest)) {
      destOf.set(a.id, dest);
    }
  }

  const nodes: NodeModel[] = [];
  const running = agents.filter(isWorking).length;
  const waiting = agents.filter((a) => a.status === 'waiting').length;
  const waitingText = waiting ? ` · ${waiting} aguardando` : '';
  nodes.push({
    id: 'main',
    kind: 'root',
    title: wrapTitle(rootLabel, TITLE_CHARS, TITLE_LINES),
    sub: agents.length ? `${agents.length} ${agents.length === 1 ? 'agente' : 'agentes'} · ${running} rodando${waitingText}` : 'sem agentes',
    detail: `${rootLabel}\nraiz da árvore de agentes\n${agents.length} agente(s), ${running} rodando${waitingText}`,
    aria: `${rootLabel}, raiz, ${agents.length} agentes`,
    color: NEUTRAL,
    text: NEUTRAL,
    running: false,
    quiet: false,
    depth: 0,
    lane: 0,
    w: NODE_W,
    h: NODE_H,
    x: 0,
    y: 0,
  });

  for (const a of agents) {
    const parent = parentOf.get(a.id) ?? 'main';
    const color = agentColor(a.color, a.id);
    const name = a.description?.trim() || 'Agente';
    const detail = [
      name,
      `id: ${a.id}`,
      `tipo: ${KIND_LABEL[a.kind]}${a.subagentType ? ` (${a.subagentType})` : ''}`,
      `criado por: ${whoLabel(parent, rootLabel)}`,
      `entrega para: ${whoLabel(a.reportedTo ?? a.reportTo, rootLabel)}`,
      `status: ${STATUS_LABEL[a.status]}${a.status === 'waiting' && a.pending ? ` (${pendingText(a).replace(/^aguardando /, '')})` : ''}`,
      `tempo: ${a.durationMs ? fmtDuration(a.durationMs) : '—'}`,
      `tokens: ${fmtTokens(a.totalTokens)}`,
      `modelo: ${a.model ? prettyModel(a.model) : '—'}`,
      `conta: ${a.profileName ?? '—'}${a.provider === 'codex' ? ' (Codex)' : onOtherAccount(a) ? ' (não é a do chat)' : ''}`,
    ].join('\n');
    // Vigia: a linha de baixo vira a recorrência com a contagem regressiva, que o tique do mapa atualiza.
    const watch = watchLabel(a, Date.now());
    // Marcador do fornecedor: só o Codex ganha, no começo da linha de baixo; o Claude é o caso comum.
    const codex = a.provider === 'codex';
    // Conta Claude diferente da do chat: o nome curto da conta abre a linha de baixo, como o "Codex".
    const acct = onOtherAccount(a) ? `@${shortAccountName(a.profileName ?? a.accountId ?? '')} · ` : '';
    nodes.push({
      id: a.id,
      kind: 'agent',
      title: wrapTitle(name, TITLE_CHARS, TITLE_LINES),
      // Torneio e varredura: a linha de baixo é o progresso (partidas ou trials), não tokens.
      sub: a.search
        ? truncate(a.search.progress, 30)
        : watch
        ? truncate(`${codex ? 'Codex · ' : acct}↻ ${watch.replace(/^a cada /, '')}`, 30)
        : a.status === 'waiting'
          ? truncate(`${codex ? 'Codex · ' : acct}${pendingText(a) || 'aguardando'}`, 30)
          : codex
            ? truncate(`Codex · ${STATUS_LABEL[a.status]} · ${fmtTokens(a.totalTokens)}`, 30)
            : acct
              ? truncate(`${acct}${STATUS_LABEL[a.status]} · ${fmtTokens(a.totalTokens)}`, 30)
              : truncate(`${STATUS_LABEL[a.status]} · ${fmtTokens(a.totalTokens)} tokens`, 30),
      detail: `${a.repeatEveryMinutes ? `${detail}\nvigia: ${repeatLabel(a.repeatEveryMinutes)}${a.checks ? `, ${a.checks} verificações` : ''}` : detail}${a.browserActive ? '\ncom o navegador (Claude in Chrome)' : ''}`,
      aria: `${name}. ${a.status === 'waiting' ? pendingText(a) || 'aguardando' : STATUS_LABEL[a.status]}, ${fmtTokens(a.totalTokens)} tokens, criado por ${whoLabel(parent, rootLabel)}, entrega para ${whoLabel(
        a.reportedTo ?? a.reportTo,
        rootLabel,
      )}`,
      color,
      text: readableOn(color),
      ring: ringFor(a.status),
      running: a.status === 'running',
      quiet: a.status === 'completed',
      browser: !!a.browserActive,
      parent,
      depth: 0,
      lane: 0,
      w: NODE_W,
      h: NODE_H,
      x: 0,
      y: 0,
    });
    // Agente isolado num worktree: símbolo de ramificação na linha de baixo e a branch no detalhe.
    markGraphNode(nodes[nodes.length - 1], a, 30);
    // Orçamento e detector de agente preso: barra de consumo e anel âmbar.
    markGuardNode(nodes[nodes.length - 1], a);
    // Job de GPU ou vigia de treino: estado, tempo e custo, ou a última leitura da métrica.
    markInfraNode(nodes[nodes.length - 1], a, 30);
    // Tentativa de Best-of-N: grupo e posição na linha de baixo; vencedora com anel dourado, as outras esmaecidas.
    markAttemptNode(nodes[nodes.length - 1], a, 30);
    // Todos os nós sintéticos no mesmo formato: ícone de tipo antes do título e progresso numa linha.
    const groupDone = a.attempt ? agents.filter((x) => x.attempt?.group === a.attempt!.group && x.status !== 'running').length : undefined;
    const last = nodes[nodes.length - 1];
    markSynthNode(last, a, Date.now(), 30, groupDone);
    // Aguardando: relógio antes do título, para não confundir com o âmbar forte do "preso" nem com o verde de rodando.
    if (a.status === 'waiting' && !last.icon) {
      last.icon = GLYPH_CLOCK;
    }
    if (last.icon) {
      last.title = wrapTitle(name, TITLE_CHARS - 3, TITLE_LINES);
    }
  }

  if (needsUser) {
    nodes.push({
      id: 'user',
      kind: 'user',
      title: ['você'],
      sub: '',
      detail: 'você\nrelatório entregue direto a você, fora do contexto dos agentes',
      aria: 'você, destino final de relatórios',
      color: NEUTRAL,
      text: NEUTRAL,
      running: false,
      quiet: false,
      depth: 0,
      lane: 0,
      w: USER_W,
      h: USER_H,
      x: 0,
      y: 0,
    });
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  /** A aresta herda a cor de quem a emite: dá para seguir cada frente de trabalho com o olho. */
  const colorOf = (id: string): string => byId.get(id)?.color ?? NEUTRAL;

  const edges: EdgeModel[] = [];
  for (const a of agents) {
    const parent = parentOf.get(a.id) ?? 'main';
    const dest = destOf.get(a.id);
    const name = a.description?.trim() || a.id;
    // Quem criou é quem recebe (o caso comum): a linha de entrega já liga os dois, e a de criação só dobraria
    // o traço. Ela fica quando a origem difere do destino, que é quando conta algo novo. A rota inteira está no popup.
    if (dest !== parent) {
      edges.push({
        id: `create:${parent}>${a.id}`,
        from: parent,
        to: a.id,
        kind: 'create',
        color: colorOf(parent),
        detail: `${whoLabel(parent, rootLabel)} criou "${name}"`,
        offset: 0,
      });
    }
    if (dest === 'bloqueado') {
      edges.push({ id: `blocked:${a.id}`, from: a.id, to: '', kind: 'blocked', color: BLOCKED, detail: `${name}: entrega bloqueada`, offset: 0 });
      continue;
    }
    if (!dest) {
      continue;
    }
    // O relatório existe ou foi marcado como entregue: a entrega aconteceu, mesmo que o agente
    // tenha voltado a rodar depois (recebeu outra mensagem).
    const done = !!a.reportedTo || !!a.report?.trim();
    const state: DeliverState = a.status === 'running' || a.status === 'waiting' ? 'pending' : done ? 'done' : 'dim';
    const who = whoLabel(dest, rootLabel);
    edges.push({
      id: `deliver:${a.id}>${dest}`,
      from: a.id,
      to: dest,
      kind: 'deliver',
      state,
      color: colorOf(a.id),
      detail:
        state === 'pending'
          ? `"${name}" ainda trabalha; o relatório vai para ${who}`
          : state === 'done'
            ? `"${name}" entregou o relatório para ${who}`
            : `"${name}" parou sem entregar o relatório para ${who}`,
      offset: 0,
    });
  }

  // Arestas entre o mesmo par de nós (o caso comum: main cria o agente e recebe o relatório dele)
  // viram faixas paralelas. O sinal é relativo ao sentido de cada aresta; normalizar pelo par em
  // ordem fixa garante que ida e volta caiam em lados opostos, não uma em cima da outra.
  const pairs = new Map<string, EdgeModel[]>();
  for (const e of edges) {
    if (!e.to) {
      continue;
    }
    const key = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
    const list = pairs.get(key);
    if (list) {
      list.push(e);
    } else {
      pairs.set(key, [e]);
    }
  }
  for (const list of pairs.values()) {
    if (list.length < 2) {
      continue;
    }
    // Criação primeiro: fica sempre do mesmo lado, e o olho aprende onde procurar cada uma.
    list.sort((x, y) => (x.kind === y.kind ? 0 : x.kind === 'create' ? -1 : 1));
    list.forEach((e, i) => {
      const o = (i - (list.length - 1) / 2) * PAIR_GAP;
      e.offset = e.from < e.to ? o : -o;
    });
  }
  const model: Model = { nodes, edges, byId, frames: [], collapsed: new Set(), anchorOf: new Map(), treeOf: new Map() };
  const grouping = groupAgents(agents, boxes);
  if (grouping.top.length) {
    withBoxes(model, agents, grouping, collapsedOf, rootLabel);
  }
  return model;
}

/**
 * Modo de caixas: esconde os agentes das caixas recolhidas atrás de um nó-resumo, cria as molduras das abertas
 * e troca as arestas entre a raiz e os agentes de uma caixa por uma aresta só, entre a raiz e a caixa.
 * Arestas entre agentes de caixas diferentes continuam, ligando o que estiver visível de cada lado.
 */
function withBoxes(model: Model, agents: AgentInfo[], grouping: Grouping, collapsedOf: (id: string, all: AgentInfo[]) => boolean, rootLabel: string): void {
  const { groups } = grouping;
  model.grouping = grouping;
  for (const g of groups.values()) {
    if (collapsedOf(g.id, g.all)) {
      model.collapsed.add(g.id);
    }
  }
  const topOf = (gid: string): string => groups.get(gid)?.parent ?? gid;
  /** Caixa visível mais de fora que está recolhida, ou nenhuma. */
  const hiddenIn = (gid: string): string | undefined => {
    const top = topOf(gid);
    if (model.collapsed.has(top)) {
      return top;
    }
    return model.collapsed.has(gid) ? gid : undefined;
  };
  for (const a of agents) {
    const gid = grouping.boxOf.get(a.id);
    const hidden = gid ? hiddenIn(gid) : undefined;
    model.anchorOf.set(a.id, hidden ? BOX_NODE + hidden : a.id);
  }
  // Árvores de avulsos: sobe pelo pai enquanto ele for outro avulso visível fora de caixa.
  const loose = new Set(grouping.loose.map((a) => a.id));
  for (const a of grouping.loose) {
    let cur = a.id;
    const seen = new Set<string>();
    for (;;) {
      seen.add(cur);
      const parent = model.byId.get(cur)?.parent;
      if (!parent || !loose.has(parent) || seen.has(parent)) {
        break;
      }
      cur = parent;
    }
    model.treeOf.set(a.id, cur);
  }

  // Nós: some quem está numa caixa recolhida; entra um nó-resumo por caixa recolhida visível.
  const keep = model.nodes.filter((n) => n.kind !== 'agent' || model.anchorOf.get(n.id) === n.id);
  const summaries: NodeModel[] = [];
  for (const g of groups.values()) {
    const shown = !g.parent || !model.collapsed.has(g.parent);
    if (!shown || !model.collapsed.has(g.id)) {
      continue;
    }
    const st = boxStats(g.all);
    const ring = st.running ? { color: STATUS_RING.running, pulse: true } : st.waiting ? { color: STATUS_RING.waiting, pulse: false } : st.failed ? { color: STATUS_RING.halted, pulse: false } : undefined;
    const count = boxCountText(st);
    const spend = boxSpend(g);
    summaries.push({
      id: BOX_NODE + g.id,
      kind: 'box',
      title: wrapTitle(g.name, TITLE_CHARS, TITLE_LINES),
      sub: truncate(`${count}${st.running ? '' : ` · ${fmtTokens(st.tokens)} tokens`}`, 34),
      detail: [g.name, g.description ?? '', `caixa recolhida: ${count}`, `${fmtTokens(st.tokens)} tokens somados`, spendDetail(spend), 'clique no título para expandir; no resto, para ver a caixa'].filter(Boolean).join('\n'),
      meter: spend.frac !== undefined ? budgetMeter(spend.frac) : undefined,
      aria: `Caixa ${g.name}, recolhida, ${count}`,
      color: g.color,
      text: NEUTRAL,
      ring,
      running: st.running > 0,
      quiet: false,
      icon: !st.running && st.waiting ? GLYPH_CLOCK : undefined,
      dots: g.all.slice(0, MAX_DOTS).map((a) => ({ color: agentColor(a.color, a.id), ring: ringFor(a.status)?.color })),
      moreDots: Math.max(0, g.all.length - MAX_DOTS),
      branch: st.worktrees > 0,
      depth: 1,
      lane: 0,
      w: SUM_W,
      h: SUM_H,
      x: 0,
      y: 0,
    });
  }
  model.nodes = [...keep.filter((n) => n.kind !== 'user'), ...summaries, ...keep.filter((n) => n.kind === 'user')];
  model.byId = new Map(model.nodes.map((n) => [n.id, n]));

  // Molduras das caixas abertas (a mãe antes das filhas: a filha fica por cima).
  for (const gid of grouping.top) {
    for (const id of [gid, ...(groups.get(gid)?.children ?? [])]) {
      const g = groups.get(id);
      if (!g || model.collapsed.has(id) || (g.parent && model.collapsed.has(g.parent))) {
        continue;
      }
      const count = boxCountText(boxStats(g.all));
      model.frames.push({ id, name: g.name, color: g.color, count, detail: [g.name, g.description ?? '', count, spendDetail(boxSpend(g))].filter(Boolean).join('\n'), depth: g.parent ? 1 : 0, x: 0, y: 0, w: 0, h: 0 });
    }
  }

  // Arestas: cada ponta vai para o nó visível. Entre a raiz e uma caixa, uma aresta só por caixa do primeiro nível.
  const blockOf = (id: string): string | undefined => {
    if (id.startsWith(BOX_NODE)) {
      return BOX_NODE + topOf(id.slice(BOX_NODE.length));
    }
    const gid = grouping.boxOf.get(id);
    if (gid) {
      return BOX_NODE + topOf(gid);
    }
    return model.treeOf.get(id);
  };
  const out = new Map<string, EdgeModel>();
  const bus = new Map<string, { kind: 'deliver' | 'create'; states: DeliverState[]; names: string[]; color: string }>();
  const colorOfBlock = (block: string): string => (block.startsWith(BOX_NODE) ? (groups.get(block.slice(BOX_NODE.length))?.color ?? NEUTRAL) : (model.byId.get(block)?.color ?? NEUTRAL));
  for (const e of model.edges) {
    const from = e.from === 'main' || e.from === 'user' ? e.from : (model.anchorOf.get(e.from) ?? e.from);
    const to = !e.to || e.to === 'main' || e.to === 'user' ? e.to : (model.anchorOf.get(e.to) ?? e.to);
    if (from === to) {
      continue;
    }
    const other = from === 'main' ? to : to === 'main' ? from : undefined;
    const block = other ? blockOf(other) : undefined;
    // Aresta da raiz com um agente de caixa (ou com o resumo dela) vira a aresta da caixa.
    if (block && block.startsWith(BOX_NODE) && e.kind !== 'blocked') {
      const known = bus.get(block);
      const kind = e.kind === 'deliver' ? 'deliver' : 'create';
      if (known) {
        if (kind === 'deliver') {
          known.kind = 'deliver';
          known.states.push(e.state ?? 'done');
        }
      } else {
        bus.set(block, { kind, states: kind === 'deliver' ? [e.state ?? 'done'] : [], names: [], color: colorOfBlock(block) });
      }
      continue;
    }
    // Aresta da raiz com a raiz de uma árvore de avulsos: barramento também, uma por aresta.
    if (block && other === block) {
      out.set(e.id, { ...e, from, to, offset: 0, bus: { block, xt: 0, ya: 0 } });
      continue;
    }
    const id = `${e.kind}:${from}>${to}`;
    const prev = out.get(id);
    if (prev) {
      prev.state = mergeState(prev.state, e.state);
      continue;
    }
    out.set(id, { ...e, id, from, to, offset: from === e.from && to === e.to ? e.offset : 0 });
  }
  for (const [block, b] of bus) {
    const name = groups.get(block.slice(BOX_NODE.length))?.name ?? block;
    const state = b.kind === 'deliver' ? b.states.reduce<DeliverState | undefined>((acc, st) => mergeState(acc, st), undefined) : undefined;
    const root = whoLabel('main', rootLabel);
    out.set(`bus:${block}`, {
      id: `bus:${block}`,
      from: b.kind === 'deliver' ? block : 'main',
      to: b.kind === 'deliver' ? 'main' : block,
      kind: b.kind,
      state,
      color: b.color,
      detail:
        b.kind === 'create'
          ? `${root} criou os agentes da caixa "${name}"`
          : state === 'pending'
            ? `A caixa "${name}" ainda trabalha; os relatórios vão para ${root}`
            : state === 'done'
              ? `A caixa "${name}" entregou os relatórios para ${root}`
              : `A caixa "${name}" parou sem entregar tudo para ${root}`,
      offset: 0,
      bus: { block, xt: 0, ya: 0 },
    });
  }
  model.edges = [...out.values()];
  model.blocks = [];
}

/** Junta estados de entrega: rodando vence, depois entregue, depois apagada. */
function mergeState(a: DeliverState | undefined, b: DeliverState | undefined): DeliverState | undefined {
  if (a === 'pending' || b === 'pending') {
    return 'pending';
  }
  if (a === 'done' || b === 'done') {
    return 'done';
  }
  return a ?? b;
}

// ---------- layout ----------

type Orient = 'h' | 'v';

interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Árvore arrumada: folhas ocupam faixas sequenciais e o pai fica no meio dos filhos.
 * Como cada nível vira uma coluna própria e as subárvores são contíguas, as linhas de
 * criação não se cruzam.
 */
function layout(model: Model, orient: Orient, pinned: Map<string, { x: number; y: number }>): Bounds {
  const children = new Map<string, string[]>();
  for (const n of model.nodes) {
    if (n.kind === 'agent' && n.parent) {
      const list = children.get(n.parent);
      if (list) {
        list.push(n.id);
      } else {
        children.set(n.parent, [n.id]);
      }
    }
  }

  const order: string[] = [];
  let cursor = 0;
  const center = new Map<string, number>();

  const walk = (id: string, depth: number): number => {
    const node = model.byId.get(id);
    if (!node) {
      return 0;
    }
    node.depth = depth;
    order.push(id);
    const kids = children.get(id) ?? [];
    if (!kids.length) {
      const c = cursor + node.h / 2;
      cursor += node.h + GAP_Y;
      center.set(id, c);
      return c;
    }
    kids.forEach((k, i) => {
      const kid = model.byId.get(k);
      if (kid) {
        kid.lane = i;
      }
    });
    const ys = kids.map((k) => walk(k, depth + 1));
    const c = (ys[0] + ys[ys.length - 1]) / 2;
    center.set(id, c);
    return c;
  };
  walk('main', 0);

  // Agente órfão (pai sumiu da lista) ainda precisa aparecer: vai para o fim, no nível 1.
  for (const n of model.nodes) {
    if (n.kind === 'agent' && !center.has(n.id)) {
      n.depth = 1;
      center.set(n.id, cursor + n.h / 2);
      cursor += n.h + GAP_Y;
      order.push(n.id);
    }
  }

  const maxDepth = Math.max(0, ...model.nodes.filter((n) => n.kind !== 'user').map((n) => n.depth));
  const user = model.byId.get('user');
  if (user) {
    // Coluna própria depois de tudo: é o fim da linha de qualquer entrega.
    const reporters = model.edges.filter((e) => e.to === 'user').map((e) => center.get(e.from) ?? 0);
    user.depth = maxDepth + 1;
    center.set('user', reporters.length ? reporters.reduce((s, v) => s + v, 0) / reporters.length : cursor + user.h / 2);
    order.push('user');
  }

  if (orient === 'h') {
    const colX: number[] = [];
    let x = PAD;
    for (let d = 0; d <= maxDepth + 1; d++) {
      const width = Math.max(...model.nodes.filter((n) => n.depth === d).map((n) => n.w), 0) || NODE_W;
      colX[d] = x + width / 2;
      x += width + GAP_X;
    }
    for (const n of model.nodes) {
      n.x = colX[n.depth] ?? PAD + NODE_W / 2;
      n.y = (center.get(n.id) ?? 0) + PAD;
    }
  } else {
    // Modo estreito: uma linha por nó, recuo marcando a profundidade.
    let row = PAD;
    for (const id of order) {
      const n = model.byId.get(id);
      if (!n) {
        continue;
      }
      n.x = PAD + n.depth * INDENT + n.w / 2;
      n.y = row + n.h / 2;
      row += n.h + ROW_GAP;
    }
  }

  for (const n of model.nodes) {
    const fixed = pinned.get(n.id);
    if (fixed) {
      n.x = fixed.x;
      n.y = fixed.y;
    }
  }

  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const n of model.nodes) {
    x0 = Math.min(x0, n.x - n.w / 2);
    y0 = Math.min(y0, n.y - n.h / 2);
    x1 = Math.max(x1, n.x + n.w / 2);
    y1 = Math.max(y1, n.y + n.h / 2);
  }
  if (!Number.isFinite(x0)) {
    return { x: 0, y: 0, w: 1, h: 1 };
  }
  // Espaço extra do lado do fluxo para o toco da entrega bloqueada caber.
  if (model.edges.some((e) => e.kind === 'blocked')) {
    x1 += 78;
  }
  return { x: x0 - PAD, y: y0 - PAD, w: x1 - x0 + PAD * 2, h: y1 - y0 + PAD * 2 };
}

// ---------- layout do modo de caixas ----------

interface Size {
  w: number;
  h: number;
}

/**
 * Modo de caixas. A raiz fica à esquerda (no estreito, em cima) e os blocos do primeiro nível (caixas e
 * árvores de avulsos) vão em fileiras à direita dela, na ordem em que foram criados. Blocos baixos se
 * empilham numa coluna enquanto cabem na altura da fileira. A largura das fileiras é a que deixa o conjunto
 * maior na tela; dentro da caixa, os agentes ficam numa grade curta. As arestas da raiz correm por fora dos
 * blocos: tronco, calha acima da fileira, canal entre colunas.
 */
function layoutBlocks(model: Model, orient: Orient, view: Size): Bounds {
  const grouping = model.grouping!;
  const { groups } = grouping;
  const vertical = orient === 'v';
  const sizes = new Map<string, Size>();
  const frameOf = new Map(model.frames.map((f) => [f.id, f]));

  // Painel estreito: a raiz vai para cima (a coluna só dela custaria um quarto da largura).
  const rootTop = vertical || view.w < ROOT_TOP_BELOW;
  const areaX0 = rootTop ? PAD + 30 : PAD + NODE_W + TRUNK_GAP;
  // Colunas da grade: poucas o bastante para a caixa caber na largura com o texto legível (escala ~0.8).
  const fitCols = Math.max(1, Math.floor((view.w / 0.8 - areaX0 - PAD - FR_PAD * 2 + IN_GAP_X) / (NODE_W + IN_GAP_X)));
  const gridCols = (n: number): number => (vertical || n <= 1 ? 1 : Math.min(fitCols, n <= 3 ? n : n === 4 ? 2 : n <= 9 ? 3 : 4));

  /** Tamanho de uma caixa: nó-resumo se recolhida; moldura com a grade dos agentes e as filhas embaixo, se aberta. */
  const measureGroup = (gid: string): Size => {
    const known = sizes.get(gid);
    if (known) {
      return known;
    }
    const g = groups.get(gid)!;
    let size: Size;
    if (!frameOf.has(gid)) {
      size = { w: SUM_W, h: SUM_H };
    } else {
      const n = g.agents.length;
      const cols = gridCols(n);
      const rows = Math.ceil(n / cols);
      const gridW = n ? cols * NODE_W + (cols - 1) * IN_GAP_X : 0;
      const gridH = n ? rows * NODE_H + (rows - 1) * IN_GAP_Y : 0;
      const kids = g.children.map((c) => measureGroup(c));
      const kidsPack = packRow(kids, Math.max(gridW, ...kids.map((k) => k.w), vertical ? 0 : SUM_W * 2 + IN_GAP_X));
      const f = frameOf.get(gid)!;
      const titleW = (f.name.length + f.count.length) * 6.4 + 58;
      const w = Math.max(gridW, kidsPack.w, Math.min(titleW, 420), SUM_W) + FR_PAD * 2;
      const h = FR_HEAD + gridH + (n && kids.length ? IN_GAP_Y : 0) + kidsPack.h + FR_BOTTOM;
      size = { w, h };
    }
    sizes.set(gid, size);
    return size;
  };

  /** Posiciona a caixa com o canto de cima à esquerda em (x, y). */
  const placeGroup = (gid: string, x: number, y: number): void => {
    const g = groups.get(gid)!;
    const size = measureGroup(gid);
    const f = frameOf.get(gid);
    if (!f) {
      const node = model.byId.get(BOX_NODE + gid);
      if (node) {
        node.x = x + size.w / 2;
        node.y = y + size.h / 2;
      }
      return;
    }
    f.x = x;
    f.y = y;
    f.w = size.w;
    f.h = size.h;
    const n = g.agents.length;
    const cols = gridCols(n);
    g.agents.forEach((a, i) => {
      const node = model.byId.get(a.id);
      if (node) {
        node.x = x + FR_PAD + (i % cols) * (NODE_W + IN_GAP_X) + NODE_W / 2;
        node.y = y + FR_HEAD + Math.floor(i / cols) * (NODE_H + IN_GAP_Y) + NODE_H / 2;
      }
    });
    const rows = Math.ceil(n / cols);
    const gridH = n ? rows * NODE_H + (rows - 1) * IN_GAP_Y : 0;
    const kids = g.children.map((c) => measureGroup(c));
    const gridW = n ? cols * NODE_W + (cols - 1) * IN_GAP_X : 0;
    const packed = packRow(kids, Math.max(gridW, ...kids.map((k) => k.w), vertical ? 0 : SUM_W * 2 + IN_GAP_X));
    const top = y + FR_HEAD + gridH + (n && kids.length ? IN_GAP_Y : 0);
    g.children.forEach((c, i) => placeGroup(c, x + FR_PAD + packed.at[i].x, top + packed.at[i].y));
  };

  // Árvores de avulsos: a raiz da árvore à esquerda, os filhos numa coluna à direita, como na árvore de sempre.
  const kidsOf = new Map<string, string[]>();
  for (const [id, root] of model.treeOf) {
    const parent = model.byId.get(id)?.parent;
    if (id !== root && parent && model.treeOf.get(parent) === root) {
      const list = kidsOf.get(parent);
      if (list) {
        list.push(id);
      } else {
        kidsOf.set(parent, [id]);
      }
    }
  }
  const treeSize = (root: string): Size & { place: (x: number, y: number) => void } => {
    const rel = new Map<string, { x: number; y: number }>();
    let cursor = 0;
    let maxDepth = 0;
    const walk = (id: string, depth: number, seen: Set<string>): number => {
      seen.add(id);
      maxDepth = Math.max(maxDepth, depth);
      const kids = (kidsOf.get(id) ?? []).filter((k) => !seen.has(k));
      let cy: number;
      if (!kids.length) {
        cy = cursor + NODE_H / 2;
        cursor += NODE_H + GAP_Y;
      } else {
        const ys = kids.map((k) => walk(k, depth + 1, seen));
        cy = (ys[0] + ys[ys.length - 1]) / 2;
      }
      rel.set(id, { x: depth * (NODE_W + TREE_GAP_X) + NODE_W / 2, y: cy });
      return cy;
    };
    walk(root, 0, new Set());
    return {
      w: (maxDepth + 1) * NODE_W + maxDepth * TREE_GAP_X,
      h: cursor - GAP_Y,
      place: (x, y) => {
        for (const [id, p] of rel) {
          const node = model.byId.get(id);
          if (node) {
            node.x = x + p.x;
            node.y = y + p.y;
          }
        }
      },
    };
  };

  // Blocos do primeiro nível, na ordem de criação do primeiro agente de cada um. "Avulsos" por último.
  const order = new Map([...model.anchorOf.keys()].map((id, i) => [id, i]));
  const blocks: (BlockModel & { place: (x: number, y: number) => void; first: number })[] = [];
  for (const gid of grouping.top) {
    const size = measureGroup(gid);
    const g = groups.get(gid)!;
    blocks.push({
      id: BOX_NODE + gid,
      kind: 'group',
      ...size,
      x: 0,
      y: 0,
      entryY: 0,
      row: 0,
      col: 0,
      stack: 0,
      place: (x, y) => placeGroup(gid, x, y),
      first: gid === LOOSE_BOX ? Infinity : Math.min(...g.all.map((a) => order.get(a.id) ?? Infinity)),
    });
  }
  for (const root of new Set(model.treeOf.values())) {
    const t = treeSize(root);
    blocks.push({ id: root, kind: 'tree', w: t.w, h: t.h, x: 0, y: 0, entryY: 0, row: 0, col: 0, stack: 0, place: t.place, first: order.get(root) ?? Infinity });
  }
  blocks.sort((a, b) => a.first - b.first);

  const root = model.byId.get('main')!;
  const user = model.byId.get('user');
  const rootY = PAD + NODE_H / 2;
  const areaY0 = rootTop ? PAD + NODE_H + GUTTER_HALF + 12 : rootY + GUTTER_HALF;
  root.x = PAD + NODE_W / 2;
  root.y = rootY;

  // Largura das fileiras: a que deixa o conjunto maior na tela (até o tamanho natural), e entre as
  // empatadas, a de proporção mais parecida com a da tela.
  let best: Packed | undefined;
  if (vertical) {
    best = packBlocks(blocks, 0);
  } else {
    const extraW = user ? USER_W + GAP_X * 0.6 : 0;
    const widest = Math.max(...blocks.map((b) => b.w));
    const candidates = new Set<number>([widest]);
    let acc = 0;
    for (const b of blocks) {
      acc += (acc ? COL_GAP : 0) + b.w;
      candidates.add(acc);
    }
    for (let w = widest; w < acc; w += 110) {
      candidates.add(w);
    }
    let bestScore = -1;
    let bestAspect = Infinity;
    const want = view.w / Math.max(1, view.h);
    for (const maxW of candidates) {
      const packed = packBlocks(blocks, maxW);
      const W = areaX0 + packed.w + extraW + PAD;
      const H = areaY0 + packed.h + PAD;
      const score = Math.min(1, view.w / W, view.h / H);
      const aspect = Math.abs(Math.log(W / H / want));
      if (score > bestScore + 0.01 || (Math.abs(score - bestScore) <= 0.01 && aspect < bestAspect)) {
        best = packed;
        bestScore = Math.max(score, bestScore);
        bestAspect = aspect;
      }
    }
  }
  const packed = best!;
  for (const [i, b] of blocks.entries()) {
    const at = packed.at[i];
    b.x = areaX0 + at.x;
    b.y = areaY0 + at.y;
    b.row = at.row;
    b.col = at.col;
    b.stack = at.stack;
    b.place(b.x, b.y);
    if (b.kind === 'tree') {
      const node = model.byId.get(b.id);
      b.entryY = node ? node.y : b.y + NODE_H / 2;
    } else {
      b.entryY = frameOf.has(b.id.slice(BOX_NODE.length)) ? b.y + FR_HEAD / 2 : b.y + b.h / 2;
    }
  }
  model.blocks = blocks.map(({ place: _p, first: _f, ...rest }) => rest);

  if (user) {
    if (rootTop) {
      user.x = areaX0 + USER_W / 2;
      user.y = areaY0 + packed.h + 26 + USER_H / 2;
    } else {
      user.x = areaX0 + packed.w + GAP_X * 0.6 + USER_W / 2;
      user.y = areaY0 + Math.min(packed.h / 2, 160);
    }
  }

  routeBus(model, packed, rootTop, vertical, areaX0, areaY0, rootY);
  model.route = { rootX: root.x, rootY, rootW: root.w, rootH: root.h, vertical: rootTop };

  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const grow = (x: number, y: number, w: number, h: number): void => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + w);
    y1 = Math.max(y1, y + h);
  };
  for (const n of model.nodes) {
    grow(n.x - n.w / 2, n.y - n.h / 2, n.w, n.h);
  }
  for (const f of model.frames) {
    grow(f.x, f.y, f.w, f.h);
  }
  if (model.edges.some((e) => e.kind === 'blocked')) {
    x1 += 78;
  }
  return { x: x0 - PAD, y: y0 - PAD, w: x1 - x0 + PAD * 2, h: y1 - y0 + PAD * 2 };
}

interface Packed {
  w: number;
  h: number;
  at: { x: number; y: number; row: number; col: number; stack: number }[];
  rows: { top: number; h: number }[];
  /** Borda esquerda de cada coluna, por fileira. */
  cols: number[][];
}

/**
 * Fileiras de largura até `maxW` (0: uma coluna só). Cada bloco vai para o primeiro vão que o comporta:
 * embaixo do último bloco de uma coluna já aberta (em qualquer fileira), se é no máximo tão largo quanto ela
 * e cabe na altura da fileira. Sem vão, abre coluna na fileira atual ou uma fileira nova. A fileira atual
 * aceita pelo menos dois nós-resumo empilhados, mesmo que ainda seja baixa.
 */
function packBlocks(blocks: Size[], maxW: number): Packed {
  const at: Packed['at'] = [];
  const rows: Packed['rows'] = [{ top: 0, h: 0 }];
  const cols: { x: number; w: number; h: number; stack: number }[][] = [[]];
  for (const b of blocks) {
    let placed = false;
    for (let r = 0; r < cols.length && !placed; r++) {
      const current = r === cols.length - 1;
      const limit = current ? Math.max(rows[r].h, SUM_H * 2 + STACK_GAP) : rows[r].h;
      for (let c = 0; c < cols[r].length; c++) {
        const col = cols[r][c];
        // Só a última coluna da última fileira pode alargar: não tem ninguém à direita dela.
        const last = current && c === cols[r].length - 1;
        const fitsW = b.w <= col.w + 0.5 || (last && (maxW === 0 || col.x + b.w <= maxW));
        if (fitsW && col.h + STACK_GAP + b.h <= limit) {
          at.push({ x: col.x, y: rows[r].top + col.h + STACK_GAP, row: r, col: c, stack: ++col.stack });
          col.h += STACK_GAP + b.h;
          col.w = Math.max(col.w, b.w);
          rows[r].h = Math.max(rows[r].h, col.h);
          placed = true;
          break;
        }
      }
    }
    if (placed) {
      continue;
    }
    let r = cols.length - 1;
    let prev: (typeof cols)[number][number] | undefined = cols[r][cols[r].length - 1];
    if (prev && prev.x + prev.w + COL_GAP + b.w > maxW) {
      rows.push({ top: rows[r].top + rows[r].h + GUTTER_HALF * 2, h: 0 });
      cols.push([]);
      r++;
      prev = undefined;
    }
    const x = prev ? prev.x + prev.w + COL_GAP : 0;
    cols[r].push({ x, w: b.w, h: b.h, stack: 0 });
    at.push({ x, y: rows[r].top, row: r, col: cols[r].length - 1, stack: 0 });
    rows[r].h = Math.max(rows[r].h, b.h);
  }
  const width = Math.max(0, ...cols.map((row) => (row.length ? row[row.length - 1].x + row[row.length - 1].w : 0)), ...cols.flat().map((c) => c.x + c.w));
  const lastRow = rows[rows.length - 1];
  return { w: width, h: lastRow.top + lastRow.h, at, rows, cols: cols.map((row) => row.map((c) => c.x)) };
}

/** Fileiras simples, para as caixas filhas dentro da mãe. */
function packRow(items: Size[], maxW: number): { w: number; h: number; at: { x: number; y: number }[] } {
  const at: { x: number; y: number }[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  let w = 0;
  for (const it of items) {
    if (x > 0 && x + it.w > maxW) {
      x = 0;
      y += rowH + IN_GAP_Y;
      rowH = 0;
    }
    at.push({ x, y });
    x += it.w + IN_GAP_X;
    w = Math.max(w, x - IN_GAP_X);
    rowH = Math.max(rowH, it.h);
  }
  return { w, h: items.length ? y + rowH : 0, at };
}

/**
 * Deslocamentos das arestas de barramento, para correrem lado a lado sem se cruzar. Quem sai do tronco
 * primeiro (mais em cima) corre mais à direita no tronco e chega mais alto na raiz; na calha, a caixa mais
 * distante corre mais alto; no canal, a caixa de cima corre mais à direita.
 */
function routeBus(model: Model, packed: Packed, rootTop: boolean, vertical: boolean, areaX0: number, areaY0: number, rootY: number): void {
  const blocks = new Map((model.blocks ?? []).map((b) => [b.id, b]));
  const edges = model.edges.filter((e) => e.bus && blocks.has(e.bus.block));
  if (!edges.length) {
    return;
  }
  const trunkX = rootTop ? PAD + 14 : areaX0 - TRUNK_GAP / 2;
  const turn = (e: EdgeModel): { y: number; col: number; stack: number } => {
    const b = blocks.get(e.bus!.block)!;
    const direct = vertical || b.col === 0;
    return { y: direct ? b.entryY : areaY0 + packed.rows[b.row].top - GUTTER_HALF, col: b.col, stack: b.stack };
  };
  const ranked = [...edges].sort((a, b) => {
    const ta = turn(a);
    const tb = turn(b);
    return ta.y - tb.y || tb.col - ta.col || ta.stack - tb.stack || a.id.localeCompare(b.id);
  });
  const n = ranked.length;
  const spT = Math.min(3.2, (rootTop ? 20 : 34) / Math.max(1, n));
  const spA = Math.min(3.2, (NODE_H - 16) / Math.max(1, n - 1));
  ranked.forEach((e, i) => {
    e.bus!.xt = trunkX + ((n - 1) / 2 - i) * spT;
    e.bus!.ya = rootY + (i - (n - 1) / 2) * spA;
    e.bus!.gy = undefined;
    e.bus!.xc = undefined;
  });
  if (vertical) {
    return;
  }
  // Calha de cada fileira e canal de cada coluna, só para quem não está na primeira coluna.
  const byRow = new Map<number, EdgeModel[]>();
  for (const e of ranked) {
    const b = blocks.get(e.bus!.block)!;
    if (b.col === 0) {
      continue;
    }
    const list = byRow.get(b.row);
    if (list) {
      list.push(e);
    } else {
      byRow.set(b.row, [e]);
    }
  }
  for (const [row, list] of byRow) {
    const gutter = areaY0 + packed.rows[row].top - GUTTER_HALF;
    const m = list.length;
    const spG = Math.min(3.2, (GUTTER_HALF * 2 - 12) / Math.max(1, m));
    list.forEach((e, j) => {
      e.bus!.gy = gutter + (j - (m - 1) / 2) * spG;
    });
    const byCol = new Map<number, EdgeModel[]>();
    for (const e of list) {
      const c = blocks.get(e.bus!.block)!.col;
      const l = byCol.get(c);
      if (l) {
        l.push(e);
      } else {
        byCol.set(c, [e]);
      }
    }
    for (const [c, l] of byCol) {
      const channel = areaX0 + packed.cols[row][c] - COL_GAP / 2;
      l.sort((a, b) => blocks.get(a.bus!.block)!.stack - blocks.get(b.bus!.block)!.stack);
      const q = l.length;
      const spC = Math.min(3.2, (COL_GAP - 12) / Math.max(1, q));
      l.forEach((e, k) => {
        e.bus!.xc = channel + ((q - 1) / 2 - k) * spC;
      });
    }
  }
}

// ---------- geometria das arestas ----------

interface Pt {
  x: number;
  y: number;
}

function clipToBox(cx: number, cy: number, w: number, h: number, dx: number, dy: number, margin: number): Pt {
  const sx = dx === 0 ? Infinity : w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy) + margin;
  return { x: cx + dx * s, y: cy + dy * s };
}

type Box = Pt & { w: number; h: number };

function edgePath(a: Box, b: Box, orient: Orient, bow: number, endMargin: number, offset = 0): string {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  // Desloca os dois centros na perpendicular antes de recortar: a aresta paralela nasce e morre
  // na borda do nó, só que ao lado da outra.
  const ox = -dy * offset;
  const oy = dx * offset;
  const p1 = clipToBox(a.x + ox, a.y + oy, a.w, a.h, dx, dy, 3);
  const p2 = clipToBox(b.x + ox, b.y + oy, b.w, b.h, -dx, -dy, endMargin);
  const flowX = orient === 'h';
  const span = flowX ? Math.abs(p2.x - p1.x) : Math.abs(p2.y - p1.y);
  const k = Math.max(14, span * 0.4);
  const dir = flowX ? Math.sign(p2.x - p1.x) || 1 : Math.sign(p2.y - p1.y) || 1;
  const c1 = flowX ? { x: p1.x + dir * k, y: p1.y + bow } : { x: p1.x + bow, y: p1.y + dir * k };
  const c2 = flowX ? { x: p2.x - dir * k, y: p2.y + bow } : { x: p2.x + bow, y: p2.y - dir * k };
  return `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} C ${c1.x.toFixed(1)} ${c1.y.toFixed(1)}, ${c2.x.toFixed(1)} ${c2.y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
}

/**
 * Onde a aresta encosta na lateral do nó: puxada para o lado do outro nó, para que várias arestas
 * chegando ao mesmo nó (a raiz recebe quase todas as entregas) não empilhem as setas num ponto só.
 */
function sideY(self: Box, other: Box, shift: number): number {
  const room = Math.max(4, self.h / 2 - 6);
  return self.y + clamp((other.y - self.y) * 0.3 + shift, -room, room);
}

/**
 * Aresta do layout horizontal: sai da lateral voltada para o destino e entra pela lateral voltada
 * para a origem, com tangentes horizontais. Entre nós da mesma coluna, contorna pela direita em vez
 * de atravessar os nós do meio.
 */
function edgePathH(a: Box, b: Box, endMargin: number, offset: number): string {
  let p1: Pt;
  let p2: Pt;
  let c1: Pt;
  let c2: Pt;
  if (Math.abs(a.x - b.x) < 1) {
    p1 = { x: a.x + a.w / 2 + 3, y: sideY(a, b, offset) };
    p2 = { x: b.x + b.w / 2 + endMargin, y: sideY(b, a, offset) };
    const k = 34 + Math.abs(p2.y - p1.y) * 0.12;
    c1 = { x: p1.x + k, y: p1.y };
    c2 = { x: p2.x + k, y: p2.y };
  } else {
    const dir = Math.sign(b.x - a.x);
    // O deslocamento é relativo ao sentido da aresta (ver buildModel); na horizontal vira vertical.
    const shift = offset * dir;
    p1 = { x: a.x + dir * (a.w / 2 + 3), y: sideY(a, b, shift) };
    p2 = { x: b.x - dir * (b.w / 2 + endMargin), y: sideY(b, a, shift) };
    const k = Math.max(20, Math.abs(p2.x - p1.x) * 0.45);
    c1 = { x: p1.x + dir * k, y: p1.y };
    c2 = { x: p2.x - dir * k, y: p2.y };
  }
  const f = (p: Pt): string => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  return `M ${f(p1)} C ${f(c1)}, ${f(c2)}, ${f(p2)}`;
}

/** Caminho ortogonal com cantos arredondados. */
function orth(points: Pt[], r: number): string {
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const p = points[i];
    const next = points[i + 1];
    const inLen = Math.hypot(p.x - prev.x, p.y - prev.y) || 1;
    const outLen = Math.hypot(next.x - p.x, next.y - p.y) || 1;
    const a = Math.min(r, inLen / 2);
    const b = Math.min(r, outLen / 2);
    const px = p.x - ((p.x - prev.x) / inLen) * a;
    const py = p.y - ((p.y - prev.y) / inLen) * a;
    const nx = p.x + ((next.x - p.x) / outLen) * b;
    const ny = p.y + ((next.y - p.y) / outLen) * b;
    d += ` L ${px.toFixed(1)} ${py.toFixed(1)} Q ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${nx.toFixed(1)} ${ny.toFixed(1)}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x.toFixed(1)} ${last.y.toFixed(1)}`;
  return d;
}

// ---------- views ----------

interface NodeView {
  g: SVGGElement;
  pulse: SVGGElement;
  quiet: SVGGElement;
  box: SVGRectElement;
  sel: SVGRectElement;
  moat: SVGRectElement;
  ring: SVGRectElement;
  halo: SVGRectElement;
  title: SVGTextElement;
  sub: SVGTextElement;
  tip: SVGTitleElement;
  badge: SVGGElement;
  meter: SVGRectElement;
  meterBg: SVGRectElement;
  icon: SVGTextElement;
  /** Só no nó-resumo de caixa: cartões de trás (a pilha), pontos de status, seta de expandir e ramificação. */
  stack: SVGGElement;
  dots: SVGGElement;
  chev: SVGTextElement;
  branch: SVGTextElement;
  /** Posição desenhada agora; anda até a posição do layout. */
  cx: number;
  cy: number;
  w: number;
  h: number;
  signature: string;
}

interface EdgeView {
  path: SVGPathElement;
  /** Pontos correndo por cima da entrega pendente. Só existe enquanto o agente trabalha. */
  flow?: SVGPathElement;
  cut?: SVGPathElement;
  cutLabel?: SVGTextElement;
  tip: SVGTitleElement;
  color: string;
}

/** Moldura de uma caixa aberta. Anda e muda de tamanho junto com os nós. */
interface FrameView {
  g: SVGGElement;
  tip: SVGTitleElement;
  bg: SVGRectElement;
  band: SVGPathElement;
  head: SVGGElement;
  hit: SVGRectElement;
  chev: SVGTextElement;
  name: SVGTSpanElement;
  count: SVGTSpanElement;
  cx: number;
  cy: number;
  w: number;
  h: number;
  sig: string;
}

interface Particle {
  dot: SVGCircleElement;
  path: SVGPathElement;
  start: number;
}

export function createAgentGraph(options?: AgentGraphOptions): AgentGraph {
  ensureStyles();
  const uid = `${P}-${++instanceSeq}`;
  const rootLabel = options?.rootLabel ?? 'Conversa principal';
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  const element = document.createElement('div');
  element.className = P;

  const svg = el('svg', { class: `${P}-canvas`, role: 'group', 'aria-label': 'Grafo dos agentes' });
  const defs = el('defs');
  const viewport = el('g');
  const frameLayer = el('g');
  const edgeLayer = el('g');
  const particleLayer = el('g');
  const nodeLayer = el('g');
  viewport.append(frameLayer, edgeLayer, particleLayer, nodeLayer);
  svg.append(defs, viewport);

  const fitBtn = document.createElement('button');
  fitBtn.className = `${P}-fit`;
  fitBtn.type = 'button';
  // Ícone da fonte codicon, que o painel já carrega. O title explica o que a palavra "centralizar" não explicava.
  const fitIcon = document.createElement('span');
  fitIcon.className = 'codicon codicon-screen-full';
  fitIcon.setAttribute('aria-hidden', 'true');
  fitBtn.append(fitIcon);
  fitBtn.title = 'Centralizar o grafo (mostra todos os nós)';
  fitBtn.setAttribute('aria-label', 'Centralizar o grafo (mostra todos os nós)');
  fitBtn.hidden = true;

  const empty = document.createElement('div');
  empty.className = `${P}-empty`;
  empty.textContent = 'Nenhum agente nesta conversa ainda';

  // Só a largura interessa. Observar o próprio elemento entraria em laço, porque o layout
  // ajusta a altura dele; a sonda tem altura zero e não reage a isso.
  const probe = document.createElement('div');
  probe.className = `${P}-probe`;

  const fill = !!options?.fill;
  if (fill) {
    element.classList.add('is-fill');
  }

  // Legenda dos traços, com amostras desenhadas do mesmo jeito que as arestas de verdade.
  const legend = document.createElement('div');
  legend.className = `${P}-legend`;
  const swatch = (attrs: Record<string, string | number>, arrow: boolean): SVGSVGElement => {
    const s = el('svg', { width: 28, height: 8, viewBox: '0 0 28 8' });
    s.append(el('path', { d: arrow ? 'M 1 4 L 21 4' : 'M 1 4 L 27 4', fill: 'none', stroke: 'currentColor', ...attrs }));
    if (arrow) {
      s.append(el('path', { d: 'M 19 0 L 27 4 L 19 8 L 21 4 z', fill: 'currentColor', 'fill-opacity': Number(attrs['stroke-opacity'] ?? 1) }));
    }
    return s;
  };
  const legendItem = (sample: SVGSVGElement, label: string): HTMLSpanElement => {
    const item = document.createElement('span');
    item.className = `${P}-legend-item`;
    sample.setAttribute('aria-hidden', 'true');
    item.append(sample, label);
    return item;
  };
  let visibility: EdgeVisibility = { creation: true, delivery: true };
  /** Item da legenda que liga e desliga um tipo de linha. */
  const legendToggle = (sample: SVGSVGElement, label: string, key: keyof EdgeVisibility, noun: string): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `${P}-legend-item ${P}-legend-toggle`;
    sample.setAttribute('aria-hidden', 'true');
    btn.append(sample, label);
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('click', () => {
      setEdgeVisibility({ ...visibility, [key]: !visibility[key] });
      options?.onEdgeVisibilityChange?.(visibility);
    });
    btn.dataset.noun = noun;
    return btn;
  };
  const legendPending = legendItem(swatch({ 'stroke-width': 3, 'stroke-dasharray': '0.1 6', 'stroke-linecap': 'round' }, true), 'entregando (rodando)');
  const legendBlocked = legendItem(swatch({ 'stroke-width': 2, 'stroke-dasharray': '4 3', stroke: BLOCKED }, false), 'entrega bloqueada');
  const legendHint = document.createElement('span');
  legendHint.className = `${P}-legend-hint`;
  legendHint.textContent = 'clique num nó para detalhes';
  const toggleCreate = legendToggle(swatch({ 'stroke-width': 1.6, 'stroke-dasharray': '5 4' }, false), 'criou', 'creation', 'criação');
  const toggleDeliver = legendToggle(swatch({ 'stroke-width': 2.6 }, true), 'entregou o relatório', 'delivery', 'entrega');
  legend.append(
    toggleCreate,
    toggleDeliver,
    legendPending,
    legendBlocked,
    legendHint,
  );

  element.append(svg, probe, fitBtn, empty, legend);

  /** Uma ponta de seta por cor: marker não herda o stroke da linha de forma confiável. */
  const markers = new Map<string, string>();
  /** `alpha` acompanha o traço: stroke-opacity da linha não chega na ponta de seta. */
  function markerFor(color: string, alpha = 1): string {
    const key = `${color}|${alpha}`;
    const known = markers.get(key);
    if (known) {
      return known;
    }
    const id = `${uid}-a${markers.size}`;
    // Ponta larga e cheia: é o que diz de relance para onde o relatório foi.
    const marker = el('marker', {
      id,
      viewBox: '0 0 12 12',
      refX: 10,
      refY: 6,
      markerWidth: 11,
      markerHeight: 11,
      markerUnits: 'userSpaceOnUse',
      orient: 'auto-start-reverse',
    });
    marker.append(el('path', { d: 'M 0.5 1 L 11 6 L 0.5 11 L 3 6 z', fill: color, 'fill-opacity': alpha }));
    defs.append(marker);
    markers.set(key, id);
    return id;
  }

  // ---------- estado ----------

  let model: Model = { nodes: [], edges: [], byId: new Map(), frames: [], collapsed: new Set(), anchorOf: new Map(), treeOf: new Map() };
  let boxes: BoxInfo[] = [];
  let lastAgents: AgentInfo[] = [];
  const frameViews = new Map<string, FrameView>();
  /** Escolhas feitas aqui quando quem usa o grafo não guarda (sem getFold). */
  const localFolds = new Map<string, boolean>();
  /** Recolhimento automático de cada caixa na última vez que foi calculado; segurado enquanto holdAutoFold. */
  const heldFolds = new Map<string, boolean>();
  let orient: Orient = 'h';
  let bounds: Bounds = { x: 0, y: 0, w: 1, h: 1 };
  const nodeViews = new Map<string, NodeView>();
  const edgeViews = new Map<string, EdgeView>();
  const pinned = new Map<string, { x: number; y: number }>();
  const particles: Particle[] = [];
  /** Última entrega conhecida por agente; quando muda, a partícula corre a aresta uma vez. */
  const lastDelivery = new Map<string, string>();
  const timers = new Set<number>();
  let selected: string | undefined;
  let hovered: string | undefined;
  let scale = 1;
  let tx = 0;
  let ty = 0;
  /** Depois que o usuário mexe na câmera, o grafo para de reenquadrar sozinho. */
  let userView = false;
  let raf = 0;
  let lastWidth = 0;
  /** Pista de desvio à esquerda de todos os nós, usada no modo estreito. */
  let laneX = 0;
  let destroyed = false;
  let firstRender = true;

  const skipMotion = (): boolean => reduced.matches;

  // ---------- desenho ----------

  function makeNode(n: NodeModel): NodeView {
    const g = el('g', { class: `${P}-node`, tabindex: 0, role: 'button' });
    const tip = el('title');
    const enter = el('g', { class: `${P}-enter` });
    const pulse = el('g', { class: `${P}-pulse` });
    const quiet = el('g');
    const halo = el('rect', { class: `${P}-halo`, rx: 15 });
    const moat = el('rect', { class: `${P}-moat`, rx: 12 });
    const ring = el('rect', { class: `${P}-ring`, rx: 15 });
    const sel = el('rect', { class: `${P}-sel`, rx: 16 });
    const box = el('rect', { class: `${P}-box`, rx: 9 });
    const title = el('text', { class: `${P}-title` });
    const sub = el('text', { class: `${P}-sub` });
    const badge = el('g', { class: `${P}-badge`, 'aria-hidden': 'true' });
    badge.append(
      el('circle', { class: 'bg', r: 8 }),
      el('circle', { class: 'globe', r: 4.6 }),
      el('ellipse', { class: 'globe', rx: 2, ry: 4.6 }),
      el('line', { class: 'globe', x1: -4.6, y1: 0, x2: 4.6, y2: 0 }),
    );
    const meterBg = el('rect', { class: `${P}-meterbg`, rx: 1.5 });
    const meter = el('rect', { class: `${P}-meter`, rx: 1.5 });
    const icon = el('text', { class: `${P}-icon`, 'aria-hidden': 'true' });
    const stack = el('g', { 'aria-hidden': 'true' });
    stack.append(el('rect', { rx: 9 }), el('rect', { rx: 9 }));
    const dots = el('g', { 'aria-hidden': 'true' });
    const chev = el('text', { class: `${P}-boxglyph ${P}-boxchev`, 'aria-hidden': 'true' });
    const branch = el('text', { class: `${P}-boxglyph`, 'aria-hidden': 'true' });
    quiet.append(stack, box, icon, title, sub, meterBg, meter, dots, chev, branch);
    pulse.append(halo, ring, quiet, moat, badge);
    enter.append(sel, pulse);
    g.append(tip, enter);
    nodeLayer.append(g);

    g.addEventListener('pointerdown', (e) => startNodeDrag(e, n.id));
    g.addEventListener('pointerenter', () => setHover(n.id));
    g.addEventListener('pointerleave', () => setHover(undefined));
    g.addEventListener('focus', () => setHover(n.id));
    g.addEventListener('blur', () => setHover(undefined));
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pick(n.id, true);
      }
    });
    const timer = window.setTimeout(() => enter.classList.remove(`${P}-enter`), 420);
    timers.add(timer);
    return { g, pulse, quiet, box, sel, moat, ring, halo, title, sub, tip, badge, meter, meterBg, icon, stack, dots, chev, branch, cx: n.x, cy: n.y, w: n.w, h: n.h, signature: '' };
  }

  function paintNode(view: NodeView, n: NodeModel): void {
    const sig = `${n.title.join('¦')}|${n.sub}|${n.color}|${n.ring?.color ?? ''}|${n.running}|${n.quiet}|${!!n.faded}|${n.kind}|${n.w}x${n.h}|${n.detail.length}|${!!n.browser}|${n.meter ? `${n.meter.frac.toFixed(3)}${n.meter.color}` : ''}|${n.icon ?? ''}|${n.progress?.toFixed(3) ?? ''}|${n.dots?.map((d) => d.color + (d.ring ?? '')).join(',') ?? ''}${n.moreDots ?? ''}|${!!n.branch}`;
    if (view.signature === sig) {
      return;
    }
    view.signature = sig;
    view.w = n.w;
    view.h = n.h;
    const hw = n.w / 2;
    const hh = n.h / 2;
    const neutral = n.kind !== 'agent';

    for (const [rect, grow, radius] of [
      [view.box, 0, 9],
      [view.moat, MOAT_GAP, 11],
      [view.ring, RING_GAP, 14],
      [view.halo, RING_GAP, 14],
      [view.sel, RING_GAP + 4, 18],
    ] as const) {
      rect.setAttribute('x', String(-hw - grow));
      rect.setAttribute('y', String(-hh - grow));
      rect.setAttribute('width', String(n.w + grow * 2));
      rect.setAttribute('height', String(n.h + grow * 2));
      rect.setAttribute('rx', String(n.kind === 'user' ? hh + grow : radius));
    }

    const boxNode = n.kind === 'box';
    // Nó-resumo de caixa: fundo no tom da caixa, borda na cor dela e dois cartões atrás (a pilha).
    view.box.style.fill = boxNode ? `color-mix(in srgb, ${n.color} 20%, var(--vscode-editor-background, #1e1e1e))` : '';
    view.box.style.stroke = boxNode ? n.color : '';
    view.stack.setAttribute('display', boxNode ? 'inline' : 'none');
    for (const [i, r] of [...view.stack.children].entries()) {
      const d = 7 - i * 3.5;
      r.setAttribute('x', String(-hw + d));
      r.setAttribute('y', String(-hh + d));
      r.setAttribute('width', String(n.w));
      r.setAttribute('height', String(n.h));
      (r as SVGRectElement).style.fill = boxNode ? `color-mix(in srgb, ${n.color} ${10 + i * 5}%, var(--vscode-editor-background, #1e1e1e))` : '';
      (r as SVGRectElement).style.stroke = boxNode ? `color-mix(in srgb, ${n.color} ${45 + i * 15}%, transparent)` : '';
      r.setAttribute('stroke-width', '1.2');
    }
    if (neutral) {
      view.box.removeAttribute('fill');
      view.box.removeAttribute('stroke');
    } else {
      view.box.setAttribute('fill', n.color);
      // Contorno escuro colado na cor própria: separa do fundo e, com anel, fecha a cor por dentro.
      view.box.setAttribute('stroke', EDGE_DARK);
    }
    if (n.ring) {
      view.ring.setAttribute('stroke', n.ring.color);
      view.ring.setAttribute('opacity', '1');
      view.halo.setAttribute('stroke', n.ring.color);
    } else {
      view.ring.setAttribute('opacity', '0');
    }
    // Sem anel não há o que separar, e o fosso só engordaria a pegada do nó.
    view.moat.setAttribute('opacity', n.ring ? '1' : '0');
    view.pulse.classList.toggle('is-running', !!n.ring?.pulse);
    view.halo.classList.toggle('is-running', !!n.ring?.pulse);
    view.quiet.classList.toggle(`${P}-quiet`, n.quiet);
    view.quiet.classList.toggle(`${P}-faded`, !!n.faded);

    // Nó sintético: o ícone de tipo ocupa o começo da linha do título e o texto anda para a direita.
    const textX = n.kind === 'user' ? 0 : -hw + (n.icon ? 27 : 12);
    for (const t of [view.title, view.sub, view.icon]) {
      t.setAttribute('x', String(textX));
      t.setAttribute('text-anchor', n.kind === 'user' ? 'middle' : 'start');
      if (neutral) {
        t.removeAttribute('fill');
      } else {
        t.setAttribute('fill', n.text);
      }
    }
    // Bloco de texto centrado na vertical: título (uma ou duas linhas) e a linha de métricas embaixo.
    // No nó-resumo o bloco sobe: embaixo fica a fila de pontos.
    const block = n.title.length * TITLE_LEAD + (n.sub ? 13 : 0);
    const first = boxNode ? -hh + 17 : -block / 2 + 8.5;
    view.title.setAttribute('y', first.toFixed(1));
    view.sub.setAttribute('y', (first + (n.title.length - 1) * TITLE_LEAD + 13).toFixed(1));
    view.sub.setAttribute('opacity', neutral ? '1' : '0.8');
    // tspan por linha, e textContent em vez de innerHTML porque a descrição pode ter <, & ou aspas.
    view.title.textContent = '';
    for (const [i, line] of n.title.entries()) {
      const span = el('tspan', { x: textX, dy: i ? TITLE_LEAD : 0 });
      span.textContent = line;
      view.title.append(span);
    }
    view.sub.textContent = n.sub;
    view.icon.textContent = n.icon ?? '';
    view.icon.setAttribute('x', String(-hw + 10));
    view.icon.setAttribute('text-anchor', 'start');
    view.icon.setAttribute('y', (first + 2).toFixed(1));
    // Barra de orçamento, ou, no nó sintético sem orçamento, o progresso na cor do texto.
    const bar = n.meter ?? (n.progress !== undefined ? { frac: n.progress, color: n.text } : undefined);
    const barW = n.w - 18;
    for (const [rect, width] of [
      [view.meterBg, barW],
      [view.meter, barW * (bar?.frac ?? 0)],
    ] as const) {
      rect.setAttribute('x', String(-hw + 9));
      rect.setAttribute('y', String(hh - 5.5));
      rect.setAttribute('width', Math.max(0, width).toFixed(1));
      rect.setAttribute('height', '3');
      rect.setAttribute('display', bar ? 'inline' : 'none');
    }
    if (bar) {
      view.meter.setAttribute('fill', bar.color);
      view.meter.setAttribute('fill-opacity', n.meter ? '1' : '0.75');
    }
    view.dots.replaceChildren();
    if (boxNode && n.dots) {
      const y = hh - 11;
      n.dots.forEach((d, i) => {
        view.dots.append(
          el('circle', { cx: (-hw + 15 + i * 10).toFixed(1), cy: y, r: 3.4, fill: d.color, stroke: d.ring ?? 'rgba(0,0,0,0.35)', 'stroke-width': d.ring ? 1.6 : 0.8 }),
        );
      });
      if (n.moreDots) {
        const more = el('text', { class: `${P}-dotsmore`, x: (-hw + 15 + n.dots.length * 10 - 2).toFixed(1), y: y + 3 });
        more.textContent = `+${n.moreDots}`;
        view.dots.append(more);
      }
    }
    view.chev.textContent = boxNode ? GLYPH_CHEV_RIGHT : '';
    view.chev.setAttribute('x', String(hw - 18));
    view.chev.setAttribute('y', (first + 2).toFixed(1));
    view.branch.textContent = boxNode && n.branch ? GLYPH_BRANCH : '';
    view.branch.setAttribute('x', String(hw - 18));
    view.branch.setAttribute('y', String(hh - 6));
    view.g.classList.toggle('is-boxnode', boxNode);
    view.badge.setAttribute('transform', `translate(${(hw - 4).toFixed(1)},${(-hh + 4).toFixed(1)})`);
    view.badge.setAttribute('display', n.browser ? 'inline' : 'none');
    view.tip.textContent = n.detail;
    view.g.setAttribute('aria-label', n.aria);
    view.g.classList.toggle('is-neutral', neutral);
    view.g.classList.toggle('is-user', n.kind === 'user');
  }

  function makeEdge(e: EdgeModel): EdgeView {
    const path = el('path', { class: `${P}-edge is-${e.kind}` });
    const tip = el('title');
    path.append(tip);
    // Criação por baixo: onde as duas se cruzam, a entrega (que carrega a seta) fica visível.
    if (e.kind === 'create') {
      edgeLayer.prepend(path);
    } else {
      edgeLayer.append(path);
    }
    const view: EdgeView = { path, tip, color: '' };
    if (e.kind === 'blocked') {
      view.cut = el('path', { class: `${P}-cut` });
      view.cutLabel = el('text', { class: `${P}-cutlabel` });
      view.cutLabel.textContent = 'bloqueado';
      edgeLayer.append(view.cut, view.cutLabel);
    }
    paintEdge(view, e);
    return view;
  }

  function paintEdge(view: EdgeView, e: EdgeModel): void {
    view.tip.textContent = e.detail;
    const pending = e.state === 'pending';
    view.path.classList.toggle('is-pending', pending);
    view.path.classList.toggle('is-dim', e.state === 'dim');
    if (pending && !view.flow) {
      view.flow = el('path', { class: `${P}-flow` });
      view.path.after(view.flow);
    } else if (!pending && view.flow) {
      view.flow.remove();
      view.flow = undefined;
    }
    view.flow?.setAttribute('stroke', e.color);
    const look = `${e.color}|${e.state ?? ''}`;
    if (view.color === look) {
      return;
    }
    view.color = look;
    view.path.setAttribute('stroke', e.color);
    if (e.kind === 'deliver') {
      view.path.setAttribute('marker-end', `url(#${markerFor(e.color, pending ? 0.6 : e.state === 'dim' ? 0.35 : 1)})`);
    }
  }

  function makeFrame(f: FrameModel): FrameView {
    const g = el('g', { class: `${P}-frame`, 'data-frame': f.id });
    const tip = el('title');
    const bg = el('rect', { class: `${P}-frame-bg`, rx: 12, 'data-zone': 'body' });
    const band = el('path', { 'data-zone': 'head' });
    const head = el('g', { class: `${P}-frame-head`, tabindex: 0, role: 'button', 'data-zone': 'head' });
    const hit = el('rect', { class: `${P}-frame-hit`, rx: 10, x: 0, y: 0, height: FR_HEAD });
    const chev = el('text', { class: `${P}-frame-chev`, x: 11, y: FR_HEAD / 2 + 5 });
    chev.textContent = GLYPH_CHEV_DOWN;
    const title = el('text', { class: `${P}-frame-title`, x: 29, y: FR_HEAD / 2 + 4 });
    const name = el('tspan');
    const count = el('tspan', { class: `${P}-frame-count` });
    title.append(name, count);
    head.append(hit, chev, title);
    g.append(tip, bg, band, head);
    frameLayer.append(g);
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleBox(f.id);
      }
    });
    return { g, tip, bg, band, head, hit, chev, name, count, cx: f.x, cy: f.y, w: f.w, h: f.h, sig: '' };
  }

  function paintFrame(v: FrameView, f: FrameModel): void {
    const sig = `${f.name}|${f.count}|${f.color}|${f.depth}|${f.detail}`;
    if (v.sig === sig) {
      return;
    }
    v.sig = sig;
    // Tom da caixa bem transparente no corpo e um pouco mais forte na faixa do título.
    v.bg.style.fill = `color-mix(in srgb, ${f.color} ${f.depth ? 9 : 6}%, transparent)`;
    v.bg.style.stroke = `color-mix(in srgb, ${f.color} 55%, transparent)`;
    v.band.style.fill = `color-mix(in srgb, ${f.color} ${f.depth ? 20 : 16}%, transparent)`;
    v.name.textContent = f.name;
    v.count.textContent = `  ·  ${f.count}`;
    v.tip.textContent = `${f.detail}\nclique no título para recolher; no resto da caixa, para ver o resumo`;
    v.head.setAttribute('aria-label', `Caixa ${f.name}, ${f.count}. Enter recolhe.`);
  }

  function placeFrame(v: FrameView): void {
    v.g.setAttribute('transform', `translate(${v.cx.toFixed(1)} ${v.cy.toFixed(1)})`);
    v.bg.setAttribute('width', v.w.toFixed(1));
    v.bg.setAttribute('height', v.h.toFixed(1));
    v.hit.setAttribute('width', v.w.toFixed(1));
    const r = 12;
    const w = v.w;
    v.band.setAttribute('d', `M 0 ${FR_HEAD} V ${r} Q 0 0 ${r} 0 H ${(w - r).toFixed(1)} Q ${w.toFixed(1)} 0 ${w.toFixed(1)} ${r} V ${FR_HEAD} Z`);
  }

  /** Caixa desenhada agora (não a do layout): as arestas acompanham o nó enquanto ele desliza. */
  function boxOf(id: string): Box | undefined {
    const v = nodeViews.get(id);
    if (v) {
      return { x: v.cx, y: v.cy, w: v.w, h: v.h };
    }
    const f = id.startsWith(BOX_NODE) ? frameViews.get(id.slice(BOX_NODE.length)) : undefined;
    return f ? { x: f.cx + f.w / 2, y: f.cy + f.h / 2, w: f.w, h: f.h } : undefined;
  }

  /** Aresta entre a raiz e um bloco, pelo tronco, pela calha e pelo canal, com cantos arredondados. */
  function busPath(e: EdgeModel): string | undefined {
    const route = model.route;
    const bus = e.bus;
    if (!route || !bus) {
      return undefined;
    }
    const gid = bus.block.startsWith(BOX_NODE) ? bus.block.slice(BOX_NODE.length) : undefined;
    const frame = gid ? frameViews.get(gid) : undefined;
    const node = nodeViews.get(bus.block);
    let left: number;
    let entry: number;
    let ringed = false;
    if (frame) {
      left = frame.cx;
      entry = frame.cy + FR_HEAD / 2;
    } else if (node) {
      left = node.cx - node.w / 2;
      entry = node.cy;
      ringed = !!model.byId.get(bus.block)?.ring;
    } else {
      return undefined;
    }
    const deliver = e.from !== 'main';
    const blockEnd = { x: left - (deliver ? 3 : ringed ? RING_GAP + 2 : 3), y: entry };
    const rootEnd = route.vertical
      ? { x: bus.xt, y: route.rootY + route.rootH / 2 + (deliver ? RING_GAP + 4 : 3) }
      : { x: route.rootX + route.rootW / 2 + (deliver ? RING_GAP + 4 : 3), y: bus.ya };
    const pts: Pt[] = [rootEnd];
    if (!route.vertical) {
      pts.push({ x: bus.xt, y: bus.ya });
    }
    if (bus.gy !== undefined && bus.xc !== undefined) {
      pts.push({ x: bus.xt, y: bus.gy }, { x: bus.xc, y: bus.gy }, { x: bus.xc, y: entry });
    } else {
      pts.push({ x: bus.xt, y: entry });
    }
    pts.push(blockEnd);
    // Pontos repetidos ou alinhados deixariam o arredondamento torto.
    const clean: Pt[] = [];
    for (const p of pts) {
      const last = clean[clean.length - 1];
      if (last && Math.abs(last.x - p.x) < 0.5 && Math.abs(last.y - p.y) < 0.5) {
        continue;
      }
      const prev = clean[clean.length - 2];
      if (prev && last && ((Math.abs(prev.x - last.x) < 0.5 && Math.abs(last.x - p.x) < 0.5) || (Math.abs(prev.y - last.y) < 0.5 && Math.abs(last.y - p.y) < 0.5))) {
        clean[clean.length - 1] = p;
        continue;
      }
      clean.push(p);
    }
    if (deliver) {
      clean.reverse();
    }
    return clean.length > 1 ? orth(clean, 7) : undefined;
  }

  function drawEdges(): void {
    for (const e of model.edges) {
      const view = edgeViews.get(e.id);
      const a = boxOf(e.from);
      if (!view || !a) {
        continue;
      }
      if (e.kind === 'blocked') {
        // Sempre para a direita: no modo empilhado, para baixo bateria na linha seguinte.
        const p1 = clipToBox(a.x, a.y, a.w, a.h, 1, 0, RING_GAP + 3);
        const p2 = { x: p1.x + 38, y: p1.y };
        view.path.setAttribute('d', `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} L ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`);
        // Corte: duas barras curtas atravessando a ponta da rota.
        const cx = p2.x + 10;
        const cy = p2.y;
        view.cut?.setAttribute('d', `M ${cx - 5} ${cy - 6} L ${cx + 5} ${cy + 6} M ${cx + 5} ${cy - 6} L ${cx - 5} ${cy + 6}`);
        view.cutLabel?.setAttribute('x', String(cx));
        view.cutLabel?.setAttribute('y', String(cy + 19));
        continue;
      }
      const b = boxOf(e.to);
      if (!b) {
        continue;
      }
      let d: string;
      if (e.bus) {
        const bus = busPath(e);
        if (!bus) {
          continue;
        }
        d = bus;
      } else if (model.blocks) {
        // Modo de caixas: dentro da mesma árvore de avulsos, a curva lateral de sempre; entre caixas, a reta recortada.
        const tree = model.treeOf.get(e.from);
        const margin = e.kind === 'deliver' ? RING_GAP + 4 : RING_GAP + 1;
        d = tree && tree === model.treeOf.get(e.to) && orient === 'h' ? edgePathH(a, b, margin, e.offset) : edgePath(a, b, 'h', 0, margin, e.offset);
      } else if (orient === 'v') {
        // Empilhado, uma reta entre duas linhas distantes passaria por cima dos nós do meio.
        d = routeV(e, a, b);
      } else if (pinned.size) {
        // Nó arrastado pelo usuário pode estar em qualquer lugar: a reta recortada na caixa se vira
        // melhor que as laterais fixas.
        const sameCol = model.byId.get(e.from)?.depth === model.byId.get(e.to)?.depth;
        const bow = e.kind === 'deliver' && sameCol ? 28 : 0;
        d = edgePath(a, b, orient, bow, e.kind === 'deliver' ? RING_GAP + 4 : RING_GAP + 1, e.offset);
      } else {
        d = edgePathH(a, b, e.kind === 'deliver' ? RING_GAP + 4 : RING_GAP + 1, e.offset);
      }
      view.path.setAttribute('d', d);
      view.flow?.setAttribute('d', d);
    }
  }

  /**
   * Modo estreito: a linha desce pela calha do pai (a faixa do recuo, livre de nós) e entra pela
   * lateral do filho. O que não é par pai/filho desvia pela pista à esquerda de tudo.
   */
  function routeV(e: EdgeModel, a: Box, b: Box): string {
    const from = model.byId.get(e.from);
    const to = model.byId.get(e.to);
    const m = RING_GAP + 2;
    // Criação e entrega do mesmo filho usam a mesma calha; o deslocamento separa as duas. A calha
    // inteira cabe no recuo (INDENT), à esquerda de onde a seta entra no filho.
    const shift = e.kind === 'create' ? -2 : 2;
    const gutter = (parent: Box, child: NodeModel | undefined): number => parent.x - parent.w / 2 + 4 + ((child?.lane ?? 0) % 3) * 2 + shift;
    if (to && to.parent === e.from) {
      // Criação: sai pela base do pai, desce pela calha e entra pela esquerda do filho.
      const gx = gutter(a, to);
      return orth([{ x: gx, y: a.y + a.h / 2 + 2 }, { x: gx, y: b.y }, { x: b.x - b.w / 2 - m, y: b.y }], 7);
    }
    if (from && from.parent === e.to) {
      // Entrega para quem criou: sobe pela mesma calha e a seta entra pela base do pai.
      const gx = gutter(b, from);
      return orth([{ x: a.x - a.w / 2 - m, y: a.y }, { x: gx, y: a.y }, { x: gx, y: b.y + b.h / 2 + m }], 7);
    }
    const lane = laneX;
    return orth([{ x: a.x - a.w / 2 - m, y: a.y }, { x: lane, y: a.y }, { x: lane, y: b.y }, { x: b.x - b.w / 2 - m, y: b.y }], 7);
  }

  function applyTransform(): void {
    viewport.setAttribute('transform', `translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scale.toFixed(3)})`);
    viewChanged();
  }

  function fit(): void {
    const vw = element.clientWidth || 300;
    // A legenda mora no rodapé: o enquadramento desconta a altura dela para não pôr nó por baixo.
    const vh = Math.max(80, (element.clientHeight || 300) - (legend.style.display === 'none' ? 0 : legend.offsetHeight + 8));
    const maxFit = fill ? FILL_MAX_FIT : 1;
    // Empilhado e ocupando a altura do painel: vale a largura. Encolher uma coluna longa até caber
    // na altura deixaria o texto ilegível; ela começa no topo e o resto se alcança arrastando.
    const tall = fill && orient === 'v';
    const s = clamp(tall ? vw / bounds.w : Math.min(vw / bounds.w, vh / bounds.h), MIN_SCALE, maxFit);
    scale = s;
    tx = (vw - bounds.w * s) / 2 - bounds.x * s;
    ty = tall && bounds.h * s > vh ? -bounds.y * s : (vh - bounds.h * s) / 2 - bounds.y * s;
    applyTransform();
  }

  // ---------- animação ----------

  function ensureTick(): void {
    if (!raf && !destroyed) {
      raf = requestAnimationFrame(tick);
    }
  }

  function tick(): void {
    raf = 0;
    let busy = false;
    let moved = false;
    const now = performance.now();
    for (const n of model.nodes) {
      const v = nodeViews.get(n.id);
      if (!v) {
        continue;
      }
      const dx = n.x - v.cx;
      const dy = n.y - v.cy;
      if (Math.abs(dx) < 0.4 && Math.abs(dy) < 0.4) {
        moved ||= dx !== 0 || dy !== 0;
        v.cx = n.x;
        v.cy = n.y;
      } else {
        v.cx += dx * 0.22;
        v.cy += dy * 0.22;
        busy = true;
        moved = true;
      }
      v.g.setAttribute('transform', `translate(${v.cx.toFixed(1)} ${v.cy.toFixed(1)})`);
    }
    for (const f of model.frames) {
      const v = frameViews.get(f.id);
      if (!v) {
        continue;
      }
      const deltas = [f.x - v.cx, f.y - v.cy, f.w - v.w, f.h - v.h];
      if (deltas.every((d) => Math.abs(d) < 0.4)) {
        moved ||= deltas.some((d) => d !== 0);
        [v.cx, v.cy, v.w, v.h] = [f.x, f.y, f.w, f.h];
      } else {
        v.cx += deltas[0] * 0.22;
        v.cy += deltas[1] * 0.22;
        v.w += deltas[2] * 0.22;
        v.h += deltas[3] * 0.22;
        busy = true;
        moved = true;
      }
      placeFrame(v);
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      const t = (now - p.start) / 1100;
      if (t >= 1 || !p.path.isConnected) {
        p.dot.remove();
        particles.splice(i, 1);
        continue;
      }
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const pt = p.path.getPointAtLength(p.path.getTotalLength() * eased);
      p.dot.setAttribute('cx', pt.x.toFixed(1));
      p.dot.setAttribute('cy', pt.y.toFixed(1));
      p.dot.setAttribute('opacity', String(t > 0.85 ? (1 - t) / 0.15 : 1));
      busy = true;
    }
    drawEdges();
    if (moved) {
      viewChanged();
    }
    if (busy) {
      ensureTick();
    }
  }

  function snap(): void {
    for (const n of model.nodes) {
      const v = nodeViews.get(n.id);
      if (v) {
        v.cx = n.x;
        v.cy = n.y;
        v.g.setAttribute('transform', `translate(${v.cx.toFixed(1)} ${v.cy.toFixed(1)})`);
      }
    }
    for (const f of model.frames) {
      const v = frameViews.get(f.id);
      if (v) {
        [v.cx, v.cy, v.w, v.h] = [f.x, f.y, f.w, f.h];
        placeFrame(v);
      }
    }
    drawEdges();
    viewChanged();
  }

  function fireParticle(edge: EdgeModel): void {
    if (skipMotion()) {
      return;
    }
    const view = edgeViews.get(edge.id);
    if (!view || !view.path.getAttribute('d')) {
      return;
    }
    const dot = el('circle', { class: `${P}-particle`, r: 4.2, cx: 0, cy: 0, fill: edge.color });
    particleLayer.append(dot);
    particles.push({ dot, path: view.path, start: performance.now() });
    ensureTick();
  }

  // ---------- interação ----------

  function edgeShown(e: EdgeModel): boolean {
    return e.kind === 'create' ? visibility.creation : e.kind === 'deliver' ? visibility.delivery : true;
  }

  /** Só conta linha visível: com a criação escondida, o hover não acende quem só está ligado por ela. */
  function isLinked(a: string, b: string): boolean {
    return model.edges.some((e) => edgeShown(e) && ((e.from === a && e.to === b) || (e.from === b && e.to === a)));
  }

  function setEdgeVisibility(v: EdgeVisibility): void {
    visibility = { creation: v.creation, delivery: v.delivery };
    element.classList.toggle('hide-create', !visibility.creation);
    element.classList.toggle('hide-deliver', !visibility.delivery);
    for (const [btn, shown] of [
      [toggleCreate, visibility.creation],
      [toggleDeliver, visibility.delivery],
    ] as const) {
      btn.setAttribute('aria-pressed', String(shown));
      btn.title = `${shown ? 'Ocultar' : 'Mostrar'} linhas de ${btn.dataset.noun}`;
    }
    // Hover em curso: refaz o realce com as linhas que valem agora.
    const h = hovered;
    hovered = undefined;
    setHover(h);
  }

  function setHover(id: string | undefined): void {
    if (hovered === id) {
      return;
    }
    hovered = id;
    svg.classList.toggle('is-hovering', !!id);
    for (const [nid, v] of nodeViews) {
      v.g.classList.toggle('is-hot', !!id && (nid === id || isLinked(id, nid)));
    }
    for (const e of model.edges) {
      const v = edgeViews.get(e.id);
      if (!v) {
        continue;
      }
      const hot = !!id && (e.from === id || e.to === id);
      v.path.classList.toggle('is-hot', hot);
      v.flow?.classList.toggle('is-hot', hot);
      v.cut?.classList.toggle('is-hot', hot);
      v.cutLabel?.classList.toggle('is-hot', hot);
    }
  }

  function pick(id: string, byKey: boolean): void {
    if (id === 'user') {
      return;
    }
    const rect = nodeRect(id);
    if (!rect) {
      return;
    }
    select(id);
    options?.onSelect?.(id, rect, byKey);
  }

  function nodeRect(id: string): DOMRect | undefined {
    const v = nodeViews.get(id);
    if (v) {
      return v.box.isConnected ? v.box.getBoundingClientRect() : undefined;
    }
    // Caixa aberta: o popup se ancora na faixa do título da moldura.
    const f = id.startsWith(BOX_NODE) ? frameViews.get(id.slice(BOX_NODE.length)) : undefined;
    return f?.hit.isConnected ? f.hit.getBoundingClientRect() : undefined;
  }

  // ---------- caixas ----------

  function foldOf(gid: string, all: AgentInfo[]): boolean {
    const chosen = options?.getFold ? options.getFold(gid) : localFolds.get(gid);
    if (chosen !== undefined) {
      return chosen;
    }
    const held = heldFolds.get(gid);
    if (held !== undefined && options?.holdAutoFold?.()) {
      return held;
    }
    const auto = autoCollapsed(all, (id) => !!options?.needsAttention?.(id));
    heldFolds.set(gid, auto);
    return auto;
  }

  function releaseAutoFolds(): void {
    heldFolds.clear();
  }

  function toggleBox(gid: string): void {
    const next = !model.collapsed.has(gid);
    localFolds.set(gid, next);
    options?.onFoldChange?.(gid, next);
    update(lastAgents);
    // A caixa que mudou continua em foco para o teclado (a moldura nova ou o nó-resumo).
    const focus = next ? nodeViews.get(BOX_NODE + gid)?.g : frameViews.get(gid)?.head;
    focus?.focus({ preventScroll: true });
  }

  function isBoxCollapsed(gid: string): boolean {
    return model.collapsed.has(gid);
  }

  function setBoxes(list: BoxInfo[]): void {
    boxes = list;
  }

  /** Só depois que createAgentGraph devolveu: quem recebe o aviso costuma ainda nem existir antes disso. */
  let constructed = false;
  let agentCount = 0;
  function viewChanged(): void {
    // O botão de enquadrar só aparece quando há o que enquadrar ou quando a câmera saiu do lugar.
    const showFit = agentCount > 0 || userView;
    if (fitBtn.hidden === showFit) {
      fitBtn.hidden = !showFit;
    }
    if (constructed) {
      options?.onViewChange?.();
    }
  }

  function toGraph(clientX: number, clientY: number): Pt {
    const r = svg.getBoundingClientRect();
    return { x: (clientX - r.left - tx) / scale, y: (clientY - r.top - ty) / scale };
  }

  let dragId: string | undefined;
  let dragMoved = false;
  let dragOffset: Pt = { x: 0, y: 0 };
  /** Clique no título do nó-resumo: expande em vez de abrir o popup. */
  let dragHead = false;
  /** Onde o ponteiro desceu, para distinguir clique de arrasto no modo de caixas. */
  let downAt: Pt = { x: 0, y: 0 };
  /** Moldura em que o ponteiro desceu (título ou corpo). */
  let downFrame: { id: string; head: boolean } | undefined;

  let panning = false;
  let panStart: Pt = { x: 0, y: 0 };

  function startNodeDrag(e: PointerEvent, id: string): void {
    e.stopPropagation();
    const n = model.byId.get(id);
    if (!n) {
      return;
    }
    dragId = id;
    dragMoved = false;
    downFrame = undefined;
    downAt = { x: e.clientX, y: e.clientY };
    const p = toGraph(e.clientX, e.clientY);
    dragOffset = { x: n.x - p.x, y: n.y - p.y };
    dragHead = n.kind === 'box' && p.y < n.y - n.h / 2 + 26;
    if (model.blocks) {
      // Modo de caixas: o layout é da estrutura, nó não se arrasta. Arrastar em cima dele move a câmera.
      panning = true;
      panStart = { x: e.clientX - tx, y: e.clientY - ty };
      element.classList.add('is-panning');
    }
    svg.setPointerCapture(e.pointerId);
  }

  svg.addEventListener('pointerdown', (e) => {
    if (dragId) {
      return;
    }
    const zone = (e.target as Element).closest?.('[data-zone]');
    const frame = (e.target as Element).closest?.('[data-frame]') as SVGGElement | null;
    downFrame = frame?.dataset.frame ? { id: frame.dataset.frame, head: zone?.getAttribute('data-zone') === 'head' } : undefined;
    downAt = { x: e.clientX, y: e.clientY };
    panning = true;
    panStart = { x: e.clientX - tx, y: e.clientY - ty };
    element.classList.add('is-panning');
    svg.setPointerCapture(e.pointerId);
  });

  svg.addEventListener('pointermove', (e) => {
    if (dragId && model.blocks) {
      if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) {
        dragMoved = true;
      }
    } else if (dragId) {
      const n = model.byId.get(dragId);
      if (!n) {
        return;
      }
      const p = toGraph(e.clientX, e.clientY);
      n.x = p.x + dragOffset.x;
      n.y = p.y + dragOffset.y;
      // A posição vale para os próximos updates: o usuário pode arrumar o grafo do jeito dele.
      pinned.set(dragId, { x: n.x, y: n.y });
      dragMoved = true;
      userView = true;
      snap();
      return;
    }
    if (panning) {
      tx = e.clientX - panStart.x;
      ty = e.clientY - panStart.y;
      userView = true;
      applyTransform();
    }
  });

  function endPointer(e: PointerEvent): void {
    const still = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) <= 4;
    if (dragId) {
      const id = dragId;
      dragId = undefined;
      if (!dragMoved) {
        if (dragHead && id.startsWith(BOX_NODE)) {
          toggleBox(id.slice(BOX_NODE.length));
        } else {
          pick(id, false);
        }
      }
    } else if (downFrame && still && e.type === 'pointerup') {
      const f = downFrame;
      if (f.head) {
        toggleBox(f.id);
      } else {
        pick(BOX_NODE + f.id, false);
      }
    }
    downFrame = undefined;
    panning = false;
    element.classList.remove('is-panning');
    if (svg.hasPointerCapture(e.pointerId)) {
      svg.releasePointerCapture(e.pointerId);
    }
  }
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', endPointer);

  svg.addEventListener(
    'wheel',
    (e) => {
      // Sem preventDefault a roda rolaria o container do mapa em vez de dar zoom.
      e.preventDefault();
      if (fill && orient === 'v' && !e.ctrlKey && !e.metaKey) {
        // Coluna empilhada ocupando o painel: a roda anda pela coluna, como numa lista.
        // Zoom continua no Ctrl+roda (e na pinça do touchpad, que chega com ctrlKey).
        ty -= e.deltaY;
        userView = true;
        applyTransform();
        return;
      }
      const r = svg.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const next = clamp(scale * Math.exp(-e.deltaY * 0.0016), MIN_SCALE, MAX_SCALE);
      if (next === scale) {
        return;
      }
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

  let lastHeight = 0;
  const ro = new ResizeObserver((entries) => {
    const box = entries[0]?.contentRect;
    const w = box?.width ?? element.clientWidth;
    if (!w) {
      return;
    }
    const nextOrient: Orient = w < NARROW ? 'v' : 'h';
    if (nextOrient !== orient || Math.abs(w - lastWidth) > 1) {
      lastWidth = w;
      lastHeight = box?.height ?? 0;
      orient = nextOrient;
      element.classList.toggle('is-narrow', orient === 'v');
      // Trocar de orientação move tudo de uma vez; animar isso vira bagunça, então salta.
      relayout(false);
    } else if (fill && box && Math.abs(box.height - lastHeight) > 1) {
      // Só a altura mudou (o painel cresceu): reenquadra sem refazer o layout.
      lastHeight = box.height;
      if (!userView) {
        fit();
      }
    }
  });
  // No modo fill a altura vem do container, não do conteúdo, então observar o próprio elemento
  // não entra em laço. No modo normal a altura segue o layout e só a sonda (altura zero) serve.
  ro.observe(fill ? element : probe);

  // ---------- ciclo de atualização ----------

  function viewSize(): Size {
    const w = element.clientWidth || 900;
    const h = fill ? Math.max(200, (element.clientHeight || 600) - (legend.style.display === 'none' ? 0 : legend.offsetHeight + 8)) : 460;
    return { w, h };
  }

  function relayout(animate: boolean): void {
    bounds = model.blocks ? layoutBlocks(model, orient, viewSize()) : layout(model, orient, pinned);
    laneX = bounds.x + 7;
    // Altura acompanha o conteúdo até um teto, para uma dúzia de agentes não virar letra de formiga.
    // No modo fill quem manda na altura é o container.
    const height = fill ? '' : `${clamp(Math.round(bounds.h) + 8, 210, 460)}px`;
    if (element.style.height !== height) {
      element.style.height = height;
    }
    if (!userView) {
      fit();
    }
    if (animate && !skipMotion() && !firstRender) {
      ensureTick();
    } else {
      snap();
    }
  }

  function update(agents: AgentInfo[]): void {
    if (destroyed) {
      return;
    }
    lastAgents = agents;
    const next = buildModel(agents, rootLabel, boxes, foldOf);
    model = next;
    const liveFrames = new Set(next.frames.map((f) => f.id));
    for (const [id, v] of frameViews) {
      if (!liveFrames.has(id)) {
        v.g.remove();
        frameViews.delete(id);
      }
    }
    for (const f of next.frames) {
      let v = frameViews.get(f.id);
      if (!v) {
        v = makeFrame(f);
        frameViews.set(f.id, v);
        // Mãe antes das filhas no DOM: a filha fica por cima.
        if (f.depth === 0) {
          frameLayer.prepend(v.g);
        }
      }
      paintFrame(v, f);
      v.g.classList.toggle('is-selected', selected === BOX_NODE + f.id);
    }

    for (const [id, v] of nodeViews) {
      if (!next.byId.has(id)) {
        v.g.remove();
        nodeViews.delete(id);
        pinned.delete(id);
      }
    }
    const liveEdges = new Set(next.edges.map((e) => e.id));
    for (const [id, v] of edgeViews) {
      if (!liveEdges.has(id)) {
        v.path.remove();
        v.flow?.remove();
        v.cut?.remove();
        v.cutLabel?.remove();
        edgeViews.delete(id);
      }
    }
    const fresh = new Set<string>();
    for (const n of next.nodes) {
      let v = nodeViews.get(n.id);
      if (!v) {
        v = makeNode(n);
        nodeViews.set(n.id, v);
        fresh.add(n.id);
      }
      paintNode(v, n);
      v.g.classList.toggle('is-selected', selected === n.id);
    }
    for (const e of next.edges) {
      const known = edgeViews.get(e.id);
      if (known) {
        paintEdge(known, e);
      } else {
        edgeViews.set(e.id, makeEdge(e));
      }
    }

    agentCount = agents.length;
    empty.style.display = agents.length ? 'none' : '';
    legend.style.display = agents.length ? '' : 'none';
    legendPending.style.display = next.edges.some((e) => e.state === 'pending') ? '' : 'none';
    toggleCreate.style.display = next.edges.some((e) => e.kind === 'create') ? '' : 'none';
    legendBlocked.style.display = next.edges.some((e) => e.kind === 'blocked') ? '' : 'none';
    relayout(true);
    // Nó recém-criado aparece direto no lugar dele (com o fade de entrada); só quem já estava na
    // tela é que desliza para a posição nova.
    for (const id of fresh) {
      const v = nodeViews.get(id);
      const n = next.byId.get(id);
      if (v && n) {
        v.cx = n.x;
        v.cy = n.y;
        v.g.setAttribute('transform', `translate(${v.cx.toFixed(1)} ${v.cy.toFixed(1)})`);
      }
    }
    // Moldura nova (caixa que acabou de abrir) também nasce no lugar.
    for (const f of next.frames) {
      const v = frameViews.get(f.id);
      if (v && !v.g.dataset.placed) {
        v.g.dataset.placed = '1';
        [v.cx, v.cy, v.w, v.h] = [f.x, f.y, f.w, f.h];
        placeFrame(v);
      }
    }
    drawEdges();

    // Entrega nova: a partícula corre a aresta uma vez.
    for (const a of agents) {
      const dest = a.reportedTo ?? a.reportTo;
      const key = a.reportedAt ?? (a.report ? `r${a.report.length}` : '');
      if (!dest || !key) {
        continue;
      }
      const stamp = `${dest}|${key}`;
      if (lastDelivery.get(a.id) === stamp) {
        continue;
      }
      lastDelivery.set(a.id, stamp);
      // Agente que já chega entregue (ao abrir o mapa, por exemplo) não dispara nada:
      // a partícula marca a entrega acontecendo agora, com o nó já na tela.
      if (fresh.has(a.id)) {
        continue;
      }
      // Agente de caixa: a entrega pode estar na aresta da caixa (recolhida, ou a aresta única até a raiz).
      const gid = next.grouping?.boxOf.get(a.id);
      const top = gid ? (next.grouping?.groups.get(gid)?.parent ?? gid) : undefined;
      const from = [next.anchorOf.get(a.id) ?? a.id, ...(top ? [BOX_NODE + top] : [])];
      const edge = next.edges.find((e) => from.includes(e.from) && e.kind !== 'create');
      if (edge) {
        drawEdges();
        fireParticle(edge);
      }
    }
    firstRender = false;
  }

  function select(id: string | undefined): void {
    selected = id;
    for (const [nid, v] of nodeViews) {
      v.g.classList.toggle('is-selected', nid === id);
    }
    for (const [fid, v] of frameViews) {
      v.g.classList.toggle('is-selected', BOX_NODE + fid === id);
    }
  }

  function destroy(): void {
    destroyed = true;
    ro.disconnect();
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    for (const t of timers) {
      clearTimeout(t);
    }
    timers.clear();
    nodeViews.clear();
    edgeViews.clear();
    frameViews.clear();
    particles.length = 0;
    element.remove();
  }

  update([]);
  constructed = true;

  setEdgeVisibility(visibility);
  return { element, update, select, nodeRect, setEdgeVisibility, setBoxes, toggleBox, isBoxCollapsed, releaseAutoFolds, destroy };
}
