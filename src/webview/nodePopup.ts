/**
 * Popup de um nó do mapa de agentes: abre ao lado do nó (ou do cartão) clicado e mostra o que
 * importa naquele estado.
 *
 * - Concluído, falhou ou parado com relatório: rota, status, tempo, tokens e o relatório final em
 *   markdown, com rolagem própria. Botões Abrir chat, Copiar relatório e Retomar (se restaurado).
 * - Rodando: rota, tempo correndo e a seção "Agora" (ferramenta em uso, resumo de progresso e as
 *   últimas ações do log). Atualiza no lugar, sem piscar e sem mexer na rolagem. Botões Abrir chat e Parar.
 * - Parado sem relatório: diz isso com todas as letras, com Abrir chat e Retomar quando dá.
 * - Raiz (`main`): contagem de agentes, quantos rodam, tokens somados e a lista dos agentes.
 * - Caixa (`box:<id>`): descrição, totais, a lista dos agentes dela com status, tempo e tokens, e os botões
 *   Recolher/Expandir e "Parar os que estão rodando" (este pede um segundo clique para confirmar).
 *
 * Um popup por vez. Fecha com clique fora, Esc, ou quando abre outro. Fica em `position: fixed`
 * no <body>, fora de qualquer container que rola: não mexe no scrollTop do mapa nem do log.
 * Texto vindo do modelo entra por textContent ou pelo `renderMarkdown` recebido (que escapa HTML).
 *
 * Autossuficiente como o graph.ts: injeta o próprio <style> com prefixo `agm-pop`.
 */
import { agentColor, STATUS_RING, lastCheckLabel, repeatLabel, watchLabel, type AgentInfo, type HistoryItem } from '../chat/protocol';
import type { WorktreeAction } from '../chat/protocol';
import { createWorktreeRow, paintWorktreeRow } from './worktreeUi';
import { createGuardRow, paintGuardRow } from './guardUi';
import { createAttemptRow, paintAttemptRow } from './parallelUi';

export interface NodePopupDeps {
  getAgent(id: string): AgentInfo | undefined;
  /** Todos os agentes da conversa, para o popup da raiz. */
  getAgents(): AgentInfo[];
  /** Log do agente (textos, ferramentas, resultados), na ordem em que chegou. */
  getItems(id: string): HistoryItem[];
  /** Markdown já escapado. Recebe o elemento e escreve nele. */
  renderMarkdown(el: HTMLElement, text: string): void;
  /** Abre o painel do agente (log completo e caixa de mensagem). */
  openChat(id: string): void;
  /** Para o agente. Num vigia, desliga a recorrência. */
  stop(id: string): void;
  /** Sobe de novo um agente restaurado do disco, ou religa um vigia parado. */
  resume(id: string): void;
  /** Retângulo atual do nó na tela. Com ele o popup acompanha zoom, arrasto e relayout. */
  getAnchor?(id: string): DOMRect | undefined;
  /** Tempo a mostrar agora. O main.ts passa o relógio dele, que anda entre as notícias do host. */
  liveDuration?(a: AgentInfo): number;
  /** Resumo curto de uma chamada de ferramenta (caminho, comando, padrão). */
  describeTool?(name: string, input: unknown): string;
  /** Linhas extras no popup da raiz (conta, contexto). */
  rootLines?(): string[];
  rootLabel?: string;
  /** Chamado ao fechar, com o id que estava aberto. */
  onClose?(id: string): void;
  /** Botões Ver diff, Mesclar e Descartar de um agente isolado (worktree). */
  worktreeAction?(id: string, action: WorktreeAction): void;
  /** Põe um texto no composer do chat principal (botão "Promover líder" de um torneio). */
  insertText?(text: string): void;
  /** Caixa do mapa (id sem o prefixo "box:"). Ausente: a caixa sumiu e o popup fecha. */
  getBox?(boxId: string): BoxPopupInfo | undefined;
  /** Recolhe ou expande a caixa no grafo. */
  toggleBox?(boxId: string): void;
  /** Abre o chat lateral de consulta com uma pergunta sobre este agente já na caixa (sem enviar). */
  askAbout?(id: string): void;
  /** O projeto tem cérebro compartilhado: o popup de agente oferece "Nota no cérebro". */
  brainReady?(): boolean;
  /** Abre a nota do agente no cérebro (preview de Markdown). */
  openBrainNote?(id: string): void;
}

/** O que o popup de uma caixa mostra. */
export interface BoxPopupInfo {
  name: string;
  color: string;
  description?: string;
  /** Agentes da caixa e das filhas, na ordem de criação. */
  agents: AgentInfo[];
  collapsed: boolean;
  parentName?: string;
  childNames?: string[];
}

export interface NodePopup {
  /** Abre o popup do nó `id` ao lado de `anchor`. `focus` leva o foco para dentro (abertura por teclado). */
  open(id: string, anchor: DOMRect, opts?: { focus?: boolean }): void;
  /** Dado novo do agente `id` (ou de qualquer um, sem id). Só repinta se for o aberto ou a raiz. */
  refresh(id?: string): void;
  /** Recalcula a posição pelo `getAnchor` (zoom, arrasto, janela redimensionada). */
  reposition(): void;
  /** Avança o tempo mostrado. Chamado pelo tique de 1s da página. */
  tick(): void;
  close(): void;
  readonly openId: string | undefined;
  readonly element: HTMLElement;
}

const P = 'agm-pop';
/** Id de caixa no mapa (igual ao BOX_NODE do grafo). */
const BOX_PREFIX = 'box:';
const MARGIN = 8;
const GAP = 12;
const MAX_W = 400;
const MAX_H = 560;
const RECENT = 5;

const CSS = `
.${P} {
  position: fixed; z-index: 40; box-sizing: border-box;
  display: flex; flex-direction: column;
  color: var(--vscode-foreground, #ccc);
  font: var(--vscode-font-size, 13px) var(--vscode-font-family, "Segoe UI", sans-serif);
  background: var(--vscode-editorWidget-background, #252526);
  border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35));
  border-left: 3px solid var(--${P}-color, #8b8f96);
  border-radius: 8px;
  box-shadow: var(--float-shadow, 0 8px 28px rgba(0,0,0,0.42), 0 1px 3px rgba(0,0,0,0.3));
  animation: ${P}-in 120ms ease-out;
}
@keyframes ${P}-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .${P} { animation: none; } }
.${P}[hidden] { display: none; }
/* O popup recebe o foco para o teclado navegar dentro dele; o contorno fica nos botões, não na caixa inteira. */
.${P}:focus { outline: none; }
.${P}-caret {
  position: absolute; width: 10px; height: 10px; transform: rotate(45deg);
  background: var(--vscode-editorWidget-background, #252526);
  border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35));
  pointer-events: none;
}
.${P}-caret.is-right { left: -7px; border-top: none; border-right: none; }
.${P}-caret.is-left { right: -6px; border-bottom: none; border-left: none; }
.${P}-caret.is-below { top: -6px; border-bottom: none; border-right: none; }
.${P}-caret.is-above { bottom: -6px; border-top: none; border-left: none; }
.${P}-caret.is-right { border-color: var(--${P}-color, #8b8f96); background: var(--${P}-color, #8b8f96); width: 8px; height: 8px; left: -6.5px; }

.${P}-head { display: flex; align-items: flex-start; gap: 8px; padding: 10px 10px 4px 12px; }
.${P}-dot {
  flex: none; width: 10px; height: 10px; margin-top: 4px; border-radius: 50%;
  background: var(--${P}-color, #8b8f96);
}
.${P}-dot.has-ring { box-shadow: 0 0 0 2px var(--vscode-editorWidget-background, #252526), 0 0 0 3.5px var(--${P}-ring); }
.${P}-titles { flex: 1; min-width: 0; }
.${P}-title { font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
.${P}-kind { font-size: 0.85em; color: var(--vscode-descriptionForeground, #9aa0a6); margin-top: 1px; }
.${P}-x {
  flex: none; border: none; background: none; cursor: pointer; padding: 2px 5px; margin: -2px -4px 0 0;
  color: var(--vscode-descriptionForeground, #9aa0a6); font-size: 16px; line-height: 1; border-radius: 4px;
}
.${P}-x:hover { color: var(--vscode-foreground, #ccc); background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }

.${P}-route, .${P}-meta { padding: 0 12px; font-size: 0.9em; color: var(--vscode-descriptionForeground, #9aa0a6); line-height: 1.5; }
.${P}-route b { font-weight: 600; color: var(--vscode-foreground, #ccc); }
.${P}-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 0; padding-bottom: 8px; }
.${P}-meta > span + span::before { content: "·"; margin: 0 6px; opacity: 0.7; }
.${P}-status { font-weight: 600; }
.${P}-status.is-running { color: ${STATUS_RING.running}; }
.${P}-status.is-failed, .${P}-status.is-stopped { color: ${STATUS_RING.halted}; }
.${P}-time { font-variant-numeric: tabular-nums; }

.${P}-body {
  flex: 1 1 auto; min-height: 0; overflow: auto; overscroll-behavior: contain;
  padding: 8px 12px 10px; border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.22));
}
.${P}-label {
  font-size: 0.75em; letter-spacing: 0.07em; text-transform: uppercase;
  color: var(--vscode-descriptionForeground, #9aa0a6); margin: 2px 0 6px;
}
.${P}-label + .${P}-label { margin-top: 0; }
.${P}-section + .${P}-section { margin-top: 12px; }
.${P}-note { color: var(--vscode-descriptionForeground, #9aa0a6); line-height: 1.45; }
.${P}-note.is-strong { color: var(--vscode-foreground, #ccc); }
.${P}-summary { font-style: italic; color: var(--vscode-descriptionForeground, #9aa0a6); margin-top: 6px; line-height: 1.45; overflow-wrap: anywhere; }

.${P}-now {
  display: flex; align-items: baseline; gap: 7px; min-width: 0;
  padding: 6px 8px; border-radius: 6px;
  background: color-mix(in srgb, var(--${P}-color, #8b8f96) 12%, transparent);
}
.${P}-now-tag { flex: none; font-size: 0.8em; color: var(--vscode-descriptionForeground, #9aa0a6); }
.${P}-now-name { flex: none; font-weight: 600; }
.${P}-now-sum { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground, #9aa0a6); }
.${P}-live {
  flex: none; align-self: center; width: 7px; height: 7px; border-radius: 50%; background: ${STATUS_RING.running};
  animation: ${P}-blink 1.4s ease-in-out infinite;
}
@keyframes ${P}-blink { 50% { opacity: 0.3; } }
@media (prefers-reduced-motion: reduce) { .${P}-live { animation: none; } }

.${P}-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.${P}-row { display: flex; align-items: baseline; gap: 7px; min-width: 0; line-height: 1.45; }
.${P}-ico { flex: none; width: 12px; text-align: center; font-size: 0.85em; color: var(--vscode-descriptionForeground, #9aa0a6); }
.${P}-row.is-ok .${P}-ico { color: ${STATUS_RING.running}; }
.${P}-row.is-err .${P}-ico { color: ${STATUS_RING.halted}; }
.${P}-row.is-run .${P}-ico { color: var(--vscode-foreground, #ccc); }
.${P}-name { flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.${P}-row.is-text .${P}-name { font-weight: 400; font-style: italic; color: var(--vscode-descriptionForeground, #9aa0a6); }
.${P}-sum { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground, #9aa0a6); }

.${P}-md { line-height: 1.5; overflow-wrap: anywhere; }
.${P}-md > :first-child { margin-top: 0; }
.${P}-md > :last-child { margin-bottom: 0; }
.${P}-md p { margin: 0.45em 0; }
.${P}-md ul, .${P}-md ol { margin: 0.4em 0; padding-left: 1.4em; }
.${P}-md h1, .${P}-md h2, .${P}-md h3, .${P}-md h4 { font-size: 1em; margin: 0.8em 0 0.3em; }
.${P}-md pre { background: rgba(128,128,128,0.14); padding: 6px 8px; border-radius: 4px; overflow-x: auto; }
.${P}-md code { font-family: var(--vscode-editor-font-family, Consolas, monospace); font-size: 0.92em; }
.${P}-md :not(pre) > code { background: rgba(128,128,128,0.16); padding: 1px 4px; border-radius: 3px; }
.${P}-md table { border-collapse: collapse; }
.${P}-md th, .${P}-md td { border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35)); padding: 2px 6px; }
.${P}-md a { color: var(--vscode-textLink-foreground, #4daafc); }

.${P}-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(60px, 1fr)); gap: 6px; margin-bottom: 12px; }
.${P}-stat { padding: 6px 8px; border-radius: 6px; background: rgba(128,128,128,0.1); }
.${P}-stat b { display: block; font-size: 1.25em; font-weight: 600; line-height: 1.2; font-variant-numeric: tabular-nums; }
.${P}-stat span { font-size: 0.82em; color: var(--vscode-descriptionForeground, #9aa0a6); }
.${P}-agent {
  display: flex; align-items: center; gap: 7px; width: 100%; min-width: 0; text-align: left;
  border: none; background: none; color: inherit; font: inherit; padding: 3px 4px; margin: 0 -4px; border-radius: 4px; cursor: pointer;
}
.${P}-agent:hover, .${P}-agent:focus-visible { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.14)); }
.${P}-agent .${P}-dot { margin-top: 0; width: 8px; height: 8px; }
.${P}-agent .${P}-dot.has-ring { box-shadow: 0 0 0 1.5px var(--vscode-editorWidget-background, #252526), 0 0 0 3px var(--${P}-ring); }
.${P}-agent-name { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${P}-agent-side { flex: none; font-size: 0.85em; color: var(--vscode-descriptionForeground, #9aa0a6); }

.${P}-actions {
  display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 12px 10px;
  border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.22));
}
.${P}-actions:empty { display: none; }
.${P}-btn {
  font: inherit; font-size: 0.92em; cursor: pointer; border-radius: 4px; padding: 4px 10px;
  border: 1px solid var(--vscode-button-border, transparent);
  color: var(--vscode-button-secondaryForeground, #ccc);
  background: var(--vscode-button-secondaryBackground, #3a3d41);
}
.${P}-btn:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
.${P}-btn.is-primary { color: var(--vscode-button-foreground, #fff); background: var(--vscode-button-background, #0e639c); }
.${P}-btn.is-primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground, #1177bb); }
.${P}-btn.is-danger { color: ${STATUS_RING.halted}; }
.${P}-btn:disabled { opacity: 0.55; cursor: default; }
.${P}-btn:focus-visible, .${P}-x:focus-visible, .${P}-agent:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: 1px; }
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

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) {
    el.className = cls;
  }
  for (const c of children) {
    if (c) {
      el.append(c);
    }
  }
  return el;
}

/** Escreve só quando muda: o tique e as atualizações ao vivo não mexem no DOM à toa. */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) {
    el.textContent = text;
  }
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

function fmtClock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
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

/** Uma linha de texto corrido, sem sinais de markdown, para caber numa linha da lista. */
function flat(text: string, max: number): string {
  const t = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/[`>*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function sameText(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

const STATUS_LABEL: Record<AgentInfo['status'], string> = {
  running: 'trabalhando',
  completed: 'concluído',
  failed: 'falhou',
  stopped: 'parado',
};

const KIND_LABEL: Record<AgentInfo['kind'], string> = {
  subagent: 'subagente',
  routed: 'agente',
  fork: 'continuação',
};

/** Destinos que o usuário não tem por que decifrar. Mesmas traduções do mapa. */
const WHO: Record<string, string> = {
  main: 'conversa principal',
  user: 'só você',
  bloqueado: 'entrega bloqueada',
  parent: 'quem criou',
};

function whoLabel(id: string): string {
  return WHO[id] ?? id;
}

function toolLabel(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]} · ${m[2]}` : name;
}

/** Resumo de reserva quando o main.ts não passa o dele. */
function fallbackDescribe(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const path = str(i.file_path) || str(i.notebook_path) || str(i.path);
  if (name === 'Bash' || name === 'PowerShell') {
    return str(i.description) || str(i.command);
  }
  if (path) {
    return path.replace(/\\/g, '/').split('/').slice(-3).join('/');
  }
  const first = str(i.description) || str(i.pattern) || str(i.query) || str(i.url) || Object.values(i).find((v) => typeof v === 'string');
  return typeof first === 'string' ? first : '';
}

function ringOf(a: AgentInfo): string {
  return a.status === 'running' ? STATUS_RING.running : a.status === 'failed' || a.status === 'stopped' ? STATUS_RING.halted : '';
}

function paintDot(dot: HTMLElement, a: AgentInfo): void {
  dot.style.setProperty('--agm-pop-color', agentColor(a.color, a.id));
  const ring = ringOf(a);
  dot.classList.toggle('has-ring', !!ring);
  if (ring) {
    dot.style.setProperty('--agm-pop-ring', ring);
  }
}

// ---------- ações recentes ----------

interface Action {
  key: string;
  kind: 'tool' | 'text' | 'user';
  state: 'run' | 'ok' | 'err' | 'none';
  name: string;
  sum: string;
}

/** Ferramenta aberta mais recente (sem resultado ainda), ou undefined se o agente não está numa. */
function currentTool(items: HistoryItem[]): Extract<HistoryItem, { kind: 'tool' }> | undefined {
  const done = new Set<string>();
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === 'toolResult') {
      done.add(it.id);
    } else if (it.kind === 'tool') {
      return done.has(it.id) ? undefined : it;
    }
  }
  return undefined;
}

function recentActions(items: HistoryItem[], describe: (n: string, i: unknown) => string, skip?: string, limit = RECENT): Action[] {
  const results = new Map<string, boolean>();
  for (const it of items) {
    if (it.kind === 'toolResult') {
      results.set(it.id, it.isError);
    }
  }
  const out: Action[] = [];
  for (let i = items.length - 1; i >= 0 && out.length < limit; i--) {
    const it = items[i];
    if (it.kind === 'tool') {
      if (it.id === skip) {
        continue;
      }
      const err = results.get(it.id);
      out.push({
        key: `t:${it.id}`,
        kind: 'tool',
        state: err === undefined ? 'run' : err ? 'err' : 'ok',
        name: toolLabel(it.name),
        sum: flat(describe(it.name, it.input), 160),
      });
    } else if (it.kind === 'text' && it.text.trim()) {
      out.push({ key: `x:${i}`, kind: 'text', state: 'none', name: 'escreveu', sum: flat(it.text, 200) });
    } else if (it.kind === 'user' && it.text.trim()) {
      out.push({ key: `u:${i}`, kind: 'user', state: 'none', name: 'recebeu', sum: flat(it.text, 200) });
    }
  }
  return out;
}

const ICON: Record<Action['state'], string> = { run: '▸', ok: '✓', err: '✕', none: '›' };

/** Vigia com a recorrência ligada (esperando a próxima verificação ou verificando agora). */
function isWatching(a: AgentInfo): boolean {
  return !!a.repeatEveryMinutes && (!!a.nextCheckAt || (a.status === 'running' && !a.restored));
}

// ---------- componente ----------

type Mode = 'root' | 'box' | 'running' | 'report' | 'none';
type Side = 'right' | 'left' | 'below' | 'above';

export function createNodePopup(deps: NodePopupDeps): NodePopup {
  ensureStyles();
  const rootLabel = deps.rootLabel ?? 'Conversa principal';
  const describe = deps.describeTool ?? fallbackDescribe;
  const duration = (a: AgentInfo): number => deps.liveDuration?.(a) ?? a.durationMs;

  const el = h('div', P);
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  el.tabIndex = -1;
  const caret = h('div', `${P}-caret`);
  const dot = h('span', `${P}-dot`);
  const title = h('div', `${P}-title`);
  const kind = h('div', `${P}-kind`);
  const closeBtn = h('button', `${P}-x`, '×');
  closeBtn.type = 'button';
  closeBtn.title = 'Fechar (Esc)';
  closeBtn.setAttribute('aria-label', 'Fechar');
  const route = h('div', `${P}-route`);
  const meta = h('div', `${P}-meta`);
  const body = h('div', `${P}-body`);
  const actions = h('div', `${P}-actions`);
  const wtRow = createWorktreeRow();
  const guardRow = createGuardRow();
  const attemptRow = createAttemptRow();
  el.append(caret, h('div', `${P}-head`, dot, h('div', `${P}-titles`, title, kind), closeBtn), route, meta, guardRow, attemptRow, wtRow, body, actions);
  document.body.append(el);

  let openId: string | undefined;
  let mode: Mode | undefined;
  let side: Side | undefined;
  let anchor: DOMRect | undefined;
  let returnFocus: HTMLElement | undefined;

  // Peças do corpo, recriadas só quando o modo muda. Entre uma notícia e outra, só o texto delas muda.
  let timeEl: HTMLElement | undefined;
  /** "a cada 5 min · próxima em 3m" de um vigia; como o tempo, quem reescreve é o tique. */
  let watchEl: HTMLElement | undefined;
  let reportEl: HTMLElement | undefined;
  let reportText = '';
  let reportLabel: HTMLElement | undefined;
  let nowBox: HTMLElement | undefined;
  let summaryEl: HTMLElement | undefined;
  let recentList: HTMLOListElement | undefined;
  let recentSection: HTMLElement | undefined;
  const rows = new Map<string, { li: HTMLLIElement; sig: string }>();
  let actionsSig = '';
  let stopping = false;
  /** Popup de caixa: "Parar os que estão rodando" já recebeu o primeiro clique e espera a confirmação. */
  let stopArmed = false;
  /** Tempo dos agentes rodando na lista da caixa; o tique reescreve só o texto. */
  let boxTimes: { el: HTMLElement; id: string }[] = [];

  closeBtn.addEventListener('click', () => close());

  // ---------- montagem ----------

  function modeOf(id: string, a: AgentInfo | undefined): Mode {
    if (id === 'main') {
      return 'root';
    }
    if (id.startsWith(BOX_PREFIX)) {
      return 'box';
    }
    if (!a) {
      return 'none';
    }
    // Torneio e varredura não têm "agora": o corpo é o ranking (ou os trials) ao vivo, e o relatório no fim.
    if (a.search) {
      return 'report';
    }
    if (a.status === 'running') {
      return 'running';
    }
    return reportOf(a) ? 'report' : 'none';
  }

  function reportOf(a: AgentInfo): string {
    if (a.search && (a.status === 'running' || !a.report)) {
      return a.search.markdown;
    }
    return sameText(a.report, a.description) ? '' : (a.report?.trim() ?? '');
  }

  function resetBody(): void {
    reportEl = undefined;
    reportText = '';
    reportLabel = undefined;
    nowBox = undefined;
    summaryEl = undefined;
    recentList = undefined;
    recentSection = undefined;
    rows.clear();
    body.replaceChildren();
    body.scrollTop = 0;
  }

  function buildBody(m: Mode, a: AgentInfo | undefined): void {
    resetBody();
    if (m === 'report' && a) {
      reportLabel = h('div', `${P}-label`);
      reportEl = h('div', `${P}-md md`);
      body.append(reportLabel, reportEl);
    } else if (m === 'running') {
      nowBox = h('div', `${P}-now`);
      summaryEl = h('div', `${P}-summary`);
      recentList = h('ol', `${P}-list`);
      recentSection = h('div', `${P}-section`, h('div', `${P}-label`, 'Últimas ações'), recentList);
      body.append(h('div', `${P}-section`, h('div', `${P}-label`, 'Agora'), nowBox, summaryEl), recentSection);
    } else if (m === 'none' && a) {
      summaryEl = h('div', `${P}-summary`);
      recentList = h('ol', `${P}-list`);
      recentSection = h('div', `${P}-section`, h('div', `${P}-label`, 'Últimas ações'), recentList);
      body.append(h('div', `${P}-section`, h('div', `${P}-note is-strong`, noReportText(a)), summaryEl), recentSection);
    }
  }

  function noReportText(a: AgentInfo): string {
    if (a.repeatEveryMinutes && a.status !== 'failed') {
      const last = lastCheckLabel(a);
      const head = isWatching(a) ? 'Vigiando. Nada entregue até agora.' : 'Vigia parado.';
      return last ? `${head} ${last[0].toUpperCase()}${last.slice(1)}.` : head;
    }
    if (a.status === 'failed') {
      return 'Este agente falhou antes de entregar um relatório.';
    }
    if (a.status === 'stopped') {
      return a.restored ? 'Este agente está parado (veio do disco) e não entregou relatório.' : 'Este agente foi parado antes de entregar um relatório.';
    }
    return 'Este agente terminou sem entregar relatório.';
  }

  // ---------- pintura ----------

  function paint(): void {
    const id = openId;
    if (!id) {
      return;
    }
    const boxId = id.startsWith(BOX_PREFIX) ? id.slice(BOX_PREFIX.length) : undefined;
    const box = boxId ? deps.getBox?.(boxId) : undefined;
    const a = id === 'main' || boxId ? undefined : deps.getAgent(id);
    if (id !== 'main' && !a && !box) {
      close();
      return;
    }
    const m = modeOf(id, a);
    // Guarda a rolagem do corpo: repintar no lugar não pode devolver o usuário ao topo.
    const keep = body.scrollTop;
    if (m !== mode) {
      mode = m;
      stopping = false;
      buildBody(m, a);
    }
    if (m === 'root') {
      paintRoot();
    } else if (box && boxId) {
      paintBox(boxId, box);
    } else if (a) {
      paintAgent(a, m);
    }
    if (body.scrollTop !== keep) {
      body.scrollTop = keep;
    }
  }

  function paintHeader(a: AgentInfo): void {
    el.style.setProperty('--agm-pop-color', agentColor(a.color, a.id));
    paintDot(dot, a);
    setText(title, a.description?.trim() || 'Agente');
    el.setAttribute('aria-label', `Agente ${a.description ?? a.id}`);
    const kindBits = [
      a.kind === 'routed' ? a.id : '',
      // Nós que não são agentes comuns dizem o que são; "agente" só para o resto.
      a.search
        ? a.search.kind === 'tournament' ? 'torneio' : 'varredura'
        : a.infra
          ? a.infra.kind === 'job' ? 'job de GPU' : 'vigia de treino'
          : a.verifier
            ? `verificador de ${a.verifier.hypothesisId}`
            : a.attempt
              ? `tentativa ${a.attempt.index} de ${a.attempt.of}`
              : a.repeatEveryMinutes
                ? `vigia ${repeatLabel(a.repeatEveryMinutes)}`
                : KIND_LABEL[a.kind],
      a.subagentType ?? '',
      a.restored ? 'salvo em disco' : '',
    ].filter(Boolean);
    setText(kind, kindBits.join(' · '));

    const from = a.creator ? whoLabel(a.creator) : '';
    const dest = a.reportedTo ?? a.reportTo;
    const to = dest ? whoLabel(dest) : '';
    const routeSig = `${from}|${to}`;
    if (route.dataset.sig !== routeSig) {
      route.dataset.sig = routeSig;
      const bits: Child[] = [];
      if (from) {
        bits.push('criado por ', h('b', '', from));
      }
      if (from && to) {
        bits.push(' → ');
      }
      if (dest === 'bloqueado') {
        bits.push(h('b', '', 'entrega bloqueada'));
      } else if (to) {
        bits.push(a.reportedTo ? 'entregou para ' : 'entrega para ', h('b', '', to));
      }
      route.replaceChildren(...(bits.filter(Boolean) as (Node | string)[]));
      route.hidden = !bits.length;
    }

    const hasTime = !!a.durationMs || a.status === 'running';
    const texts = [
      a.totalTokens ? `${fmtTokens(a.totalTokens)} tokens` : '',
      a.toolUses ? `${a.toolUses} ${a.toolUses === 1 ? 'ferramenta' : 'ferramentas'}` : '',
      a.model ? prettyModel(a.model) : '',
      a.effort ? `raciocínio ${a.effort}` : '',
      a.provider === 'codex' ? `Codex · ${a.profileName ?? '?'}` : a.profileName ? `conta ${a.profileName}` : '',
      a.brainNews ? `${a.brainNews.count} ${a.brainNews.count === 1 ? 'novidade' : 'novidades'} do cérebro recebida${a.brainNews.count === 1 ? '' : 's'} às ${fmtClock(a.brainNews.at)}` : '',
    ].filter(Boolean);
    // O tempo fica fora da assinatura: quem escreve nele é o tique, direto no nó de texto.
    const watching = isWatching(a);
    const sig = [a.status, hasTime, !!a.repeatEveryMinutes, watching, ...texts].join('|');
    if (meta.dataset.sig !== sig) {
      meta.dataset.sig = sig;
      timeEl = hasTime ? h('span', `${P}-time`) : undefined;
      watchEl = a.repeatEveryMinutes ? h('span', `${P}-watch`) : undefined;
      meta.replaceChildren(
        ...([h('span', `${P}-status is-${a.status}`, watching && a.status !== 'running' ? 'vigiando' : STATUS_LABEL[a.status]), watchEl, timeEl, ...texts.map((t) => h('span', '', t))].filter(Boolean) as HTMLElement[]),
      );
    }
    if (timeEl) {
      setText(timeEl, fmtDuration(duration(a)));
    }
    if (watchEl) {
      setText(watchEl, `↻ ${watchLabel(a, Date.now())}`);
    }
  }

  function paintAgent(a: AgentInfo, m: Mode): void {
    paintHeader(a);
    paintWorktreeRow(wtRow, a, deps.worktreeAction);
    paintGuardRow(guardRow, a);
    paintAttemptRow(attemptRow, a, deps.getAgents());
    if (m === 'report' && reportEl && reportLabel) {
      setText(
        reportLabel,
        a.search && (a.status === 'running' || !a.report)
          ? `${a.search.label}${a.status === 'running' ? ' · ao vivo' : ''}`
          : a.reportedAt
            ? `Relatório final · ${fmtClock(a.reportedAt)}`
            : 'Relatório final',
      );
      const text = reportOf(a);
      // Markdown só se refaz quando o texto muda: refazer à toa zeraria a rolagem do relatório.
      if (text !== reportText) {
        reportText = text;
        deps.renderMarkdown(reportEl, text);
      }
    }
    if (m === 'running' && nowBox) {
      paintNow(a);
    }
    if (summaryEl) {
      const summary = sameText(a.summary, a.description) ? '' : (a.summary?.trim() ?? '');
      setText(summaryEl, summary);
      summaryEl.hidden = !summary;
    }
    if (recentList && recentSection) {
      const items = deps.getItems(a.id);
      const skip = m === 'running' ? currentTool(items)?.id : undefined;
      const list = recentActions(items, describe, skip, m === 'running' ? RECENT : 3);
      paintRecent(list);
      recentSection.hidden = !list.length;
    }
    paintActions(a, m);
  }

  function paintNow(a: AgentInfo): void {
    if (!nowBox) {
      return;
    }
    const items = deps.getItems(a.id);
    const cur = currentTool(items);
    let tag: string;
    let name: string;
    let sum: string;
    let live = false;
    if (cur) {
      tag = 'usando';
      name = toolLabel(cur.name);
      sum = flat(describe(cur.name, cur.input), 200);
      live = true;
    } else if (items.length && items[items.length - 1].kind === 'text') {
      const last = items[items.length - 1] as { text: string };
      tag = 'escrevendo';
      name = '';
      sum = flat(last.text, 200);
      live = true;
    } else if (a.lastTool) {
      tag = 'pensando · última ferramenta';
      name = toolLabel(a.lastTool);
      sum = '';
      live = true;
    } else {
      tag = 'começando';
      name = '';
      sum = '';
      live = true;
    }
    const sig = `${tag}|${name}|${sum}|${live}`;
    if (nowBox.dataset.sig === sig) {
      return;
    }
    nowBox.dataset.sig = sig;
    nowBox.replaceChildren(
      ...([
        live ? h('span', `${P}-live`) : null,
        h('span', `${P}-now-tag`, tag),
        name ? h('span', `${P}-now-name`, name) : null,
        sum ? h('span', `${P}-now-sum`, sum) : null,
      ].filter(Boolean) as HTMLElement[]),
    );
    const nowSum = nowBox.querySelector(`.${P}-now-sum`) as HTMLElement | null;
    if (nowSum) {
      nowSum.title = sum;
    }
  }

  /** Lista chaveada: linha que já existe é reaproveitada e só troca o que mudou. Nada pisca. */
  function paintRecent(list: Action[]): void {
    if (!recentList) {
      return;
    }
    const next: HTMLLIElement[] = [];
    const live = new Set<string>();
    for (const act of list) {
      live.add(act.key);
      const sig = `${act.state}|${act.name}|${act.sum}`;
      let row = rows.get(act.key);
      if (!row) {
        row = { li: h('li', ''), sig: '' };
        rows.set(act.key, row);
      }
      if (row.sig !== sig) {
        row.sig = sig;
        row.li.className = `${P}-row is-${act.state} is-${act.kind}`;
        row.li.replaceChildren(h('span', `${P}-ico`, ICON[act.state]), h('span', `${P}-name`, act.name), h('span', `${P}-sum`, act.sum));
        row.li.title = act.sum ? `${act.name}: ${act.sum}` : act.name;
      }
      next.push(row.li);
    }
    for (const key of [...rows.keys()]) {
      if (!live.has(key)) {
        rows.delete(key);
      }
    }
    const current = [...recentList.children];
    if (current.length !== next.length || current.some((c, i) => c !== next[i])) {
      recentList.replaceChildren(...next);
    }
  }

  function button(label: string, cls: string, onClick: () => void, title?: string): HTMLButtonElement {
    const b = h('button', `${P}-btn${cls ? ` ${cls}` : ''}`, label);
    b.type = 'button';
    if (title) {
      b.title = title;
    }
    b.addEventListener('click', onClick);
    return b;
  }

  function paintActions(a: AgentInfo, m: Mode): void {
    const watching = isWatching(a);
    const canStop = (a.status === 'running' && (a.kind === 'routed' || (a.kind === 'subagent' && !!a.taskId))) || watching;
    // Vigia parado, restaurado ou não, religa pelo mesmo botão.
    const canResume = a.restored || (!!a.repeatEveryMinutes && !watching);
    const report = m === 'report' ? reportOf(a) : '';
    const leader = a.search?.kind === 'tournament' ? a.search.leader : undefined;
    const brainNote = !!deps.openBrainNote && !!deps.brainReady?.() && a.kind === 'routed' && !a.search && !a.infra && !a.repeatEveryMinutes;
    const sig = `${a.id}|${m}|${canStop}|${!!report}|${canResume ? (a.sessionId ? 'r' : 'x') : ''}|${stopping}|${!!a.repeatEveryMinutes}|${leader?.id ?? ''}|${brainNote}`;
    if (sig === actionsSig) {
      return;
    }
    actionsSig = sig;
    const list: HTMLButtonElement[] = [button('Abrir chat', 'is-primary', () => deps.openChat(a.id), 'Abre o painel do agente, com o log inteiro e a caixa de mensagem')];
    if (deps.askAbout && !a.search && !a.infra) {
      list.push(button('Perguntar sobre este agente', '', () => deps.askAbout?.(a.id), 'Abre a consulta lateral com uma pergunta sobre este agente na caixa, sem enviar. Não interfere nesta conversa.'));
    }
    if (brainNote) {
      list.push(button('Nota no cérebro', '', () => deps.openBrainNote?.(a.id), 'Abre a nota deste agente no cérebro compartilhado (.agm/brain/): tarefa, modelo, frente e o resumo do relatório'));
    }
    if (leader && deps.insertText) {
      // O torneio só prioriza: o clique prepara o pedido no composer, e o usuário completa métrica e braços antes de mandar.
      list.push(
        button('Promover líder', '', () => {
          deps.insertText?.(
            `Registre como hipótese do laboratório o candidato ${leader.id} ("${leader.title}") do torneio ${a.id}, com promote_to_hypothesis. Métrica: , direção: , braços: .`,
          );
        }, `Prepara no composer o pedido para ${leader.id} virar hipótese do laboratório`),
      );
    }
    if (report) {
      const copy = button('Copiar relatório', '', () => {
        const text = reportOf(deps.getAgent(a.id) ?? a);
        void copyText(text).then((ok) => {
          copy.textContent = ok ? 'Copiado' : 'Não deu para copiar';
          window.setTimeout(() => {
            copy.textContent = 'Copiar relatório';
          }, 1500);
        });
      });
      list.push(copy);
    }
    if (canResume) {
      const hint = a.repeatEveryMinutes
        ? `Liga de novo a verificação ${repeatLabel(a.repeatEveryMinutes)}.`
        : 'Sobe o processo deste agente de novo, com o histórico inteiro dele.';
      const resume = button(a.repeatEveryMinutes ? 'Retomar vigia' : 'Retomar', '', () => deps.resume(a.id), a.sessionId ? hint : 'A conversa deste agente não foi salva em disco, então não dá para retomá-lo.');
      resume.disabled = !a.sessionId;
      list.push(resume);
    }
    if (canStop) {
      const idle = a.repeatEveryMinutes ? 'Parar vigia' : 'Parar';
      const stop = button(stopping ? 'Parando…' : idle, 'is-danger', () => {
        stopping = true;
        deps.stop(a.id);
        paint();
        // Se o host não confirmar a parada, o botão volta a valer em vez de ficar em "Parando…" para sempre.
        const id = a.id;
        window.setTimeout(() => {
          if (stopping && openId === id) {
            stopping = false;
            paint();
          }
        }, 6000);
      });
      stop.disabled = stopping;
      list.push(stop);
    }
    actions.replaceChildren(...list);
  }

  function paintRoot(): void {
    const list = deps.getAgents();
    el.style.setProperty('--agm-pop-color', '#8b8f96');
    dot.style.setProperty('--agm-pop-color', '#8b8f96');
    dot.classList.remove('has-ring');
    setText(title, rootLabel);
    el.setAttribute('aria-label', rootLabel);
    setText(kind, 'raiz da árvore de agentes');
    route.hidden = true;
    route.dataset.sig = '';
    paintWorktreeRow(wtRow, undefined);
    paintGuardRow(guardRow, undefined);
    paintAttemptRow(attemptRow, undefined, []);
    const extra = deps.rootLines?.() ?? [];
    const metaSig = `root|${extra.join('|')}`;
    if (meta.dataset.sig !== metaSig) {
      meta.dataset.sig = metaSig;
      timeEl = undefined;
      watchEl = undefined;
      meta.replaceChildren(...extra.map((t) => h('span', '', t)));
    }
    meta.hidden = !extra.length;

    const running = list.filter((a) => a.status === 'running');
    const done = list.filter((a) => a.status === 'completed').length;
    const halted = list.filter((a) => a.status === 'failed' || a.status === 'stopped').length;
    const tokens = list.reduce((s, a) => s + a.totalTokens, 0);
    // A ordem da lista: quem roda primeiro, depois os mais recentes.
    const ordered = [...running, ...list.filter((a) => a.status !== 'running').reverse()];
    const sig = [list.length, running.length, done, halted, tokens, ...ordered.map((a) => `${a.id}:${a.status}:${a.color ?? ''}:${a.lastTool ?? ''}:${a.description}`)].join('|');
    if (body.dataset.sig === sig) {
      return;
    }
    body.dataset.sig = sig;
    const stat = (n: string, label: string): HTMLElement => h('div', `${P}-stat`, h('b', '', n), h('span', '', label));
    const stats = h(
      'div',
      `${P}-stats`,
      stat(String(list.length), list.length === 1 ? 'agente' : 'agentes'),
      stat(String(running.length), 'rodando'),
      stat(String(done), done === 1 ? 'concluído' : 'concluídos'),
      halted ? stat(String(halted), 'pararam') : null,
      stat(fmtTokens(tokens), 'tokens'),
    );
    const rowsEl = ordered.slice(0, 12).map((a) => {
      const d = h('span', `${P}-dot`);
      paintDot(d, a);
      const b = h(
        'button',
        `${P}-agent`,
        d,
        h('span', `${P}-agent-name`, a.description?.trim() || a.id),
        h('span', `${P}-agent-side`, a.status === 'running' ? (a.lastTool ? toolLabel(a.lastTool) : 'trabalhando') : STATUS_LABEL[a.status]),
      );
      b.type = 'button';
      b.addEventListener('click', () => {
        const r = deps.getAnchor?.(a.id);
        if (r) {
          open(a.id, r, { focus: true });
        } else {
          deps.openChat(a.id);
        }
      });
      return b;
    });
    body.replaceChildren(
      stats,
      list.length
        ? h('div', `${P}-section`, h('div', `${P}-label`, running.length ? 'Agentes (rodando primeiro)' : 'Agentes'), ...rowsEl, list.length > 12 ? h('div', `${P}-note`, `e mais ${list.length - 12}`) : null)
        : h('div', `${P}-note`, 'Nenhum agente nesta conversa ainda.'),
    );
    actionsSig = 'root';
    actions.replaceChildren();
  }

  function paintBox(boxId: string, b: BoxPopupInfo): void {
    el.style.setProperty('--agm-pop-color', b.color);
    dot.style.setProperty('--agm-pop-color', b.color);
    dot.classList.remove('has-ring');
    setText(title, b.name);
    el.setAttribute('aria-label', `Caixa ${b.name}`);
    setText(kind, ['caixa de agentes', b.parentName ? `dentro de ${b.parentName}` : '', b.collapsed ? 'recolhida no grafo' : 'aberta no grafo'].filter(Boolean).join(' · '));
    paintWorktreeRow(wtRow, undefined);
    paintGuardRow(guardRow, undefined);
    paintAttemptRow(attemptRow, undefined, []);
    const desc = [b.description?.trim() ?? '', b.childNames?.length ? `Etapas: ${b.childNames.join(', ')}.` : ''].filter(Boolean).join(' ');
    if (route.dataset.sig !== `box|${desc}`) {
      route.dataset.sig = `box|${desc}`;
      route.replaceChildren(desc);
    }
    route.hidden = !desc;
    meta.hidden = true;
    meta.dataset.sig = 'box';
    timeEl = undefined;
    watchEl = undefined;

    const list = b.agents;
    const running = list.filter((a) => a.status === 'running');
    const done = list.filter((a) => a.status === 'completed').length;
    const halted = list.filter((a) => a.status === 'failed' || a.status === 'stopped').length;
    const tokens = list.reduce((s, a) => s + a.totalTokens, 0);
    const time = list.reduce((s, a) => s + duration(a), 0);
    const sig = [boxId, list.length, running.length, done, halted, tokens, ...list.map((a) => `${a.id}:${a.status}:${a.color ?? ''}:${a.totalTokens}:${a.description}`)].join('|');
    if (body.dataset.sig !== sig) {
      body.dataset.sig = sig;
      const stat = (n: string, label: string): HTMLElement => h('div', `${P}-stat`, h('b', '', n), h('span', '', label));
      boxTimes = [];
      const rowsEl = list.map((a) => {
        const d = h('span', `${P}-dot`);
        paintDot(d, a);
        const t = h('span', `${P}-time`, fmtDuration(duration(a)));
        if (a.status === 'running') {
          boxTimes.push({ el: t, id: a.id });
        }
        const btn = h(
          'button',
          `${P}-agent`,
          d,
          h('span', `${P}-agent-name`, a.description?.trim() || a.id),
          h('span', `${P}-agent-side`, STATUS_LABEL[a.status], ' · ', t, a.totalTokens ? ` · ${fmtTokens(a.totalTokens)}` : ''),
        );
        btn.type = 'button';
        btn.title = `${a.id}: abrir o resumo deste agente`;
        btn.addEventListener('click', () => {
          const r = deps.getAnchor?.(a.id);
          if (r) {
            open(a.id, r, { focus: true });
          } else {
            deps.openChat(a.id);
          }
        });
        return btn;
      });
      body.replaceChildren(
        h(
          'div',
          `${P}-stats`,
          stat(String(list.length), list.length === 1 ? 'agente' : 'agentes'),
          stat(String(running.length), 'rodando'),
          stat(String(done), done === 1 ? 'concluído' : 'concluídos'),
          halted ? stat(String(halted), 'pararam') : null,
          stat(fmtTokens(tokens), 'tokens'),
          stat(fmtDuration(time), 'tempo somado'),
        ),
        h('div', `${P}-section`, h('div', `${P}-label`, 'Agentes da caixa'), ...rowsEl),
      );
    }
    const aSig = `box|${boxId}|${b.collapsed}|${running.length}|${stopArmed}|${stopping}`;
    if (actionsSig === aSig) {
      return;
    }
    actionsSig = aSig;
    const acts: HTMLButtonElement[] = [];
    if (deps.toggleBox) {
      acts.push(
        button(b.collapsed ? 'Expandir' : 'Recolher', 'is-primary', () => {
          deps.toggleBox?.(boxId);
          refresh(BOX_PREFIX + boxId);
        }, b.collapsed ? 'Mostra os agentes desta caixa no grafo' : 'Junta os agentes desta caixa num nó só'),
      );
    }
    if (running.length) {
      const label = stopArmed ? `Confirmar: parar ${running.length}` : `Parar ${running.length === 1 ? 'o que está rodando' : `os ${running.length} rodando`}`;
      const stop = button(label, 'is-danger', () => {
        if (!stopArmed) {
          stopArmed = true;
          paint();
          // O botão foi recriado: o foco volta para ele, para o Enter confirmar.
          actions.querySelector<HTMLButtonElement>(`.${P}-btn.is-danger`)?.focus({ preventScroll: true });
          return;
        }
        stopArmed = false;
        stopping = true;
        for (const a of running) {
          deps.stop(a.id);
        }
        paint();
      }, stopArmed ? 'Clique de novo para parar todos os agentes rodando desta caixa' : 'Para todos os agentes desta caixa que estão rodando (pede confirmação)');
      stop.disabled = stopping;
      acts.push(stop);
      if (stopArmed) {
        acts.push(
          button('Cancelar', '', () => {
            stopArmed = false;
            paint();
          }),
        );
      }
    } else {
      stopping = false;
    }
    actions.replaceChildren(...acts);
  }

  async function copyText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Webview sem permissão de clipboard: o velho textarea + execCommand ainda funciona.
      const ta = h('textarea', '');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  }

  // ---------- posição ----------

  function place(prefer?: Side): void {
    if (!anchor || el.hidden) {
      return;
    }
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const w = Math.min(MAX_W, vw - MARGIN * 2);
    el.style.width = `${w}px`;
    el.style.maxHeight = `${Math.min(MAX_H, vh - MARGIN * 2)}px`;
    const a = anchor;
    const fits: Record<Side, boolean> = {
      right: a.right + GAP + w <= vw - MARGIN,
      left: a.left - GAP - w >= MARGIN,
      below: false,
      above: false,
    };
    let s: Side | undefined = prefer && prefer !== 'below' && prefer !== 'above' && fits[prefer] ? prefer : fits.right ? 'right' : fits.left ? 'left' : undefined;
    let left: number;
    let top: number;
    if (s) {
      const hgt = el.offsetHeight;
      left = s === 'right' ? a.right + GAP : a.left - GAP - w;
      top = clampN(a.top + a.height / 2 - hgt / 2, MARGIN, vh - hgt - MARGIN);
    } else {
      // Painel estreito: nem à direita nem à esquerda cabe. Vai para baixo ou para cima do nó,
      // no lado com mais espaço, e a altura máxima encolhe até caber ali.
      const below = vh - a.bottom - GAP - MARGIN;
      const above = a.top - GAP - MARGIN;
      s = below >= above ? 'below' : 'above';
      const room = Math.max(160, s === 'below' ? below : above);
      el.style.maxHeight = `${Math.min(MAX_H, room, vh - MARGIN * 2)}px`;
      const hgt = el.offsetHeight;
      left = clampN(a.left + a.width / 2 - w / 2, MARGIN, vw - w - MARGIN);
      top = s === 'below' ? a.bottom + GAP : a.top - GAP - hgt;
      top = clampN(top, MARGIN, vh - hgt - MARGIN);
    }
    side = s;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    // Seta apontando para o centro do nó, presa dentro do popup.
    caret.className = `${P}-caret is-${s}`;
    const hgt = el.offsetHeight;
    if (s === 'right' || s === 'left') {
      caret.style.top = `${Math.round(clampN(a.top + a.height / 2 - top - 5, 10, hgt - 20))}px`;
      caret.style.left = '';
      caret.hidden = a.top + a.height / 2 < top + 6 || a.top + a.height / 2 > top + hgt - 6;
    } else {
      caret.style.left = `${Math.round(clampN(a.left + a.width / 2 - left - 5, 10, w - 20))}px`;
      caret.style.top = '';
      caret.hidden = false;
    }
  }

  function clampN(v: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(v, Math.max(lo, hi)));
  }

  // ---------- ciclo ----------

  function open(id: string, rect: DOMRect, opts?: { focus?: boolean }): void {
    // Trocar de nó não é fechar: onClose não roda, e quem abriu já ajustou o próprio estado.
    if (openId !== id) {
      mode = undefined;
      actionsSig = '';
      stopArmed = false;
      meta.dataset.sig = '';
      route.dataset.sig = '';
      body.dataset.sig = '';
      meta.hidden = false;
      route.hidden = false;
      side = undefined;
    }
    openId = id;
    anchor = rect;
    el.hidden = false;
    paint();
    place(side);
    if (opts?.focus) {
      const active = document.activeElement;
      returnFocus = active instanceof HTMLElement && !el.contains(active) ? active : returnFocus;
      // preventScroll: dar foco não pode rolar o mapa por baixo.
      (actions.querySelector('button') ?? closeBtn).focus({ preventScroll: true });
    }
  }

  function refresh(id?: string): void {
    if (!openId || (id !== undefined && openId !== 'main' && !openId.startsWith(BOX_PREFIX) && id !== openId)) {
      return;
    }
    const before = el.offsetHeight;
    paint();
    if (openId && el.offsetHeight !== before) {
      place(side);
    }
  }

  function reposition(): void {
    if (!openId) {
      return;
    }
    const r = deps.getAnchor?.(openId);
    if (!r) {
      return;
    }
    // O nó ou cartão saiu da janela (rolagem, arrasto): um popup solto, apontando para o nada, só confunde.
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) {
      close();
      return;
    }
    anchor = r;
    place(side);
  }

  function tick(): void {
    if (!openId) {
      return;
    }
    const a = deps.getAgent(openId);
    if (a && timeEl && a.status === 'running') {
      setText(timeEl, fmtDuration(duration(a)));
    }
    if (a && watchEl) {
      setText(watchEl, `↻ ${watchLabel(a, Date.now())}`);
    }
    for (const t of boxTimes) {
      const x = deps.getAgent(t.id);
      if (x?.status === 'running') {
        setText(t.el, fmtDuration(duration(x)));
      }
    }
  }

  function close(): void {
    if (!openId) {
      return;
    }
    const was = openId;
    openId = undefined;
    mode = undefined;
    stopArmed = false;
    boxTimes = [];
    anchor = undefined;
    el.hidden = true;
    resetBody();
    actions.replaceChildren();
    actionsSig = '';
    meta.dataset.sig = '';
    timeEl = undefined;
    watchEl = undefined;
    deps.onClose?.(was);
    if (returnFocus?.isConnected) {
      returnFocus.focus({ preventScroll: true });
    }
    returnFocus = undefined;
  }

  // Clique fora fecha. Captura: roda antes do handler do nó, que reabre na soltura se for outro nó.
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (openId && !el.contains(e.target as Node)) {
        close();
      }
    },
    true,
  );
  // Captura também: Esc fecha só o popup, e não chega no handler que fecharia o mapa inteiro.
  document.addEventListener(
    'keydown',
    (e) => {
      if (openId && e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    },
    true,
  );
  window.addEventListener('resize', () => reposition());

  return {
    open,
    refresh,
    reposition,
    tick,
    close,
    get openId() {
      return openId;
    },
    element: el,
  };
}
