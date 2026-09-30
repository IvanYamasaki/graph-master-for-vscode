import { Marked } from 'marked';
import { createAgentGraph } from './graph';
import { boxSpend, boxStats, boxCountText, groupAgents, LOOSE_BOX, type Grouping } from './boxModel';
import { createNodePopup } from './nodePopup';
import { createLabCards } from './labCards';
import { createLabView } from './labTree';
import { createGuardCards } from './guardCards';
import { STUCK_RING } from './guardUi';
import { COMPANION_MARK, STATUS_LABEL, STATUS_RING, agentColor, lastCheckLabel, onOtherAccount, pendingText, repeatLabel, shortAccountName, watchLabel } from '../chat/protocol';
import { COMPANION_ICON, COMPANION_OPEN_TITLE, createCompanionUi } from './companionUi';
import type { CompanionInit } from '../chat/companion/types';
import { describeBrowserAction, isBrowserTool } from '../chat/browser';
import type { BrowserStatus } from '../chat/browser';
import type { ConnectedBrowser } from '../chat/protocol';
import type { BoxInfo } from '../chat/protocol';
import type { AgentInfo, Attachment, ExternalProviderName, HistoryItem, HostMessage, ModelOption, NoticeAction, ProfileOption, FileResult, SessionOption, SlashCommandOption, TaskProposal, UsageInfo, WebviewMessage } from '../chat/protocol';

declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewMessage): void;
  setState(state: unknown): void;
  getState(): unknown;
};

const vscode = acquireVsCodeApi();
const send = (msg: WebviewMessage) => vscode.postMessage(msg);

/** O que esta aba guardou antes de recarregar. É lido no início para um reload cedo não perder a conversa. */
interface SavedState {
  profileId?: string;
  sessionId?: string;
  /** Linhas do grafo que o usuário escondeu pela legenda. */
  edges?: { creation: boolean; delivery: boolean };
  /** Caixas que o usuário recolheu (true) ou expandiu (false), por "<sessão>|<caixa>". */
  boxFold?: Record<string, boolean>;
}
const saved = (vscode.getState() ?? {}) as SavedState;

// ---------- Markdown ----------

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const marked = new Marked({ gfm: true, breaks: false });
// HTML cru vindo do modelo vira texto: nada de tags injetadas na página.
marked.use({ renderer: { html: ({ text }) => escapeHtml(text) } });

function md(el: HTMLElement, text: string): void {
  el.innerHTML = marked.parse(text, { async: false }) as string;
}

// ---------- DOM ----------

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | ((e: Event) => void)> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') {
      el.addEventListener(k.replace(/^on/, ''), v as EventListener);
    } else if (v === true) {
      el.setAttribute(k, '');
    } else if (v !== false) {
      el.setAttribute(k, v);
    }
  }
  for (const c of children) {
    if (c) {
      el.append(c);
    }
  }
  return el;
}

/** replaceChildren que ignora null/false (o DOM escreveria "null" na tela). */
function fill(el: HTMLElement, ...children: Child[]): void {
  el.replaceChildren(...(children.filter(Boolean) as (Node | string)[]));
}

/**
 * Glifo da fonte codicon. O host serve media/codicons/codicon.css junto com o do chat;
 * aria-hidden porque quem lê a tela deve ouvir o aria-label do botão, não o nome do ícone.
 */
function icon(name: string): HTMLSpanElement {
  return h('span', { class: `codicon codicon-${name}`, 'aria-hidden': 'true' });
}

function option(value: string, label: string, selected: boolean): HTMLOptionElement {
  const o = h('option', { value }, label);
  o.selected = selected;
  return o;
}

// ---------- Estado ----------

const state = {
  profileId: saved.profileId ?? '',
  profileName: '',
  account: '',
  cwd: '',
  mode: 'default',
  model: '',
  resolvedModel: '',
  effort: '',
  forkOf: undefined as string | undefined,
  /** Nome da sessão (gerado pelo Claude Code ou /rename). Vazio: "Nova conversa". */
  sessionTitle: '',
  /** Preenchido no chat lateral de consulta: esconde a orquestração e mostra a faixa de só leitura. */
  companion: undefined as CompanionInit | undefined,
  busy: false,
  thinking: false,
  contextTokens: 0,
  sessionId: saved.sessionId ?? '',
  models: [] as ModelOption[],
  profiles: [] as ProfileOption[],
  /** Quem roda este chat. Codex muda nomes, níveis de raciocínio, rodapé de limites e comandos de barra. */
  provider: 'claude' as 'claude' | 'codex',
  /** Modelos das contas Codex, para continuar um agente numa conta Codex. Vazio até o host mandar. */
  codexModels: [] as ModelOption[],
  /** Diretório de trabalho como URI do webview: base das miniaturas das imagens geradas. */
  cwdUri: '',
  /** Provedores padrão de pesquisa e imagem, para os prompts do menu "+". */
  external: { research: 'openai', image: 'openai', imageFolder: 'assets/generated' } as { research: ExternalProviderName; image: ExternalProviderName; imageFolder: string },
  /** Claude in Chrome: interruptor deste chat, estado da sessão, dono do navegador e navegadores conectados. */
  browser: { on: false, status: { enabled: false, status: 'off', tools: [] } } as {
    on: boolean;
    status: BrowserStatus;
    owner?: { id: string; label: string };
    browsers?: ConnectedBrowser[];
    browsersError?: string;
  },
};

/** "Claude" ou "Codex": entra no cabeçalho, no placeholder e nos títulos dos botões. */
const brand = () => (state.provider === 'codex' ? 'Codex' : 'Claude');
/** Quem espera a lista de modelos do Codex chegar (o seletor de conta do cartão do agente). */
const codexModelWaiters: (() => void)[] = [];

const agents = new Map<string, AgentInfo>();
const agentItems = new Map<string, HistoryItem[]>();
/** Cartão ao vivo de cada agente no log principal, guardado para atualizar no lugar. */
const agentCards = new Map<string, HTMLElement>();
/** Cartão de aprovação de cada tarefa proposta por um vigia. */
const taskCards = new Map<string, HTMLElement>();
/** Linhas do grafo visíveis. Começa como estava salvo. */
let edgeVisibility = { creation: saved.edges?.creation ?? true, delivery: saved.edges?.delivery ?? true };
/** Ferramentas de orquestração que o log principal engole: o cartão do agente já conta a história. */
const hiddenTools = new Set<string>();
const ORCHESTRATION_TOOL = /^mcp__agents__/;
/** Pesquisa e imagem externas também vêm do servidor "agents", mas o resultado interessa ao usuário: aparecem no log. */
const RESEARCH_TOOL = 'mcp__agents__web_research';
const IMAGE_TOOL = 'mcp__agents__generate_image';
const isOrchestration = (name: string) => ORCHESTRATION_TOOL.test(name) && name !== RESEARCH_TOOL && name !== IMAGE_TOOL;
const providerName = (p: unknown) => (p === 'gemini' ? 'Gemini' : p === 'openai' ? 'GPT' : '');
/** Anexos escolhidos mas ainda não enviados. Esvazia no submit. */
const pending: Attachment[] = [];

const MODES: [string, string][] = [
  ['default', 'Perguntar antes'],
  ['acceptEdits', 'Aceitar edições'],
  ['plan', 'Planejar'],
  ['bypassPermissions', 'Sem perguntas (bypass)'],
];
const EFFORTS: [string, string][] = [
  ['', 'Raciocínio padrão'],
  ['low', 'Raciocínio baixo'],
  ['medium', 'Raciocínio médio'],
  ['high', 'Raciocínio alto'],
  ['xhigh', 'Raciocínio muito alto'],
  ['max', 'Raciocínio máximo'],
];

// ---------- Estrutura da página ----------

const acct = h('div', { class: 'acct' });
const histBtn = h(
  'button',
  { class: 'icon-btn square', title: 'Conversas anteriores desta conta', 'aria-label': 'Histórico de conversas', onclick: () => openHistoryMenu() },
  icon('history'),
);
const companionBtn = h(
  'button',
  { class: 'icon-btn square', title: COMPANION_OPEN_TITLE, 'aria-label': 'Abrir a consulta lateral', onclick: () => send({ type: 'openCompanion' }) },
  icon(COMPANION_ICON),
);
const newChatBtn = h('button', { class: 'icon-btn square', title: 'Nova conversa (abre em outra aba)', 'aria-label': 'Nova conversa em outra aba', onclick: () => send({ type: 'newChat' }) }, icon('add'));
const top = h('header', { class: 'top' }, acct, h('div', { class: 'spacer' }), companionBtn, histBtn, newChatBtn);
const forkBanner = h('div', { class: 'fork-banner hidden' });
const log = h('main', { class: 'log' });
/** Pedidos de exemplo do chat novo: o clique só preenche a caixa, para o usuário ajustar antes de enviar. */
const EXAMPLES: [string, string][] = [
  ['beaker', 'Registre a hipótese: warmup de 5 épocas melhora val_acc no CIFAR-100. Rode 5 seeds por braço e declare o veredito.'],
  ['type-hierarchy-sub', 'Abra três agentes em paralelo para comparar AdamW, Lion e SGD neste repositório e me traga uma tabela.'],
  ['settings', 'Faça uma varredura de lr e weight decay com 10 trials e me mostre os melhores.'],
  ['search', 'Pesquise na web os trabalhos recentes sobre label smoothing e resuma o que muda para o meu modelo.'],
];
const empty = h(
  'div',
  { class: 'empty' },
  h('div', { class: 'logo' }, '✳'),
  h('p', { class: 'empty-title' }, 'O que vamos investigar?'),
  h('p', {}, 'Peça uma mudança no código, um experimento ou uma pesquisa. Os agentes que o Claude abrir aparecem aqui e no mapa.'),
  h(
    'div',
    { class: 'empty-examples' },
    ...EXAMPLES.map(([ico, text]) =>
      h(
        'button',
        {
          class: 'empty-ex',
          type: 'button',
          title: 'Coloca este pedido na caixa de mensagem',
          onclick: () => {
            input.value = text;
            autosize(input);
            renderSend();
            input.focus();
          },
        },
        icon(ico),
        h('span', {}, text),
      ),
    ),
  ),
  h('p', { class: 'empty-hint' }, h('kbd', {}, '/'), ' comandos · ', h('kbd', {}, '@'), ' arquivos · ', h('kbd', {}, '+'), ' anexos e pesquisa'),
);
log.append(empty);
const activity = h('div', { class: 'activity hidden' });
const runBar = h('div', {
  class: 'runbar hidden',
  role: 'button',
  tabindex: '0',
  'aria-label': 'Agentes em execução, abre o mapa de agentes',
  onclick: (e: Event) => {
    const line = (e.target as Element).closest('.run-line') as HTMLElement | null;
    if (line?.dataset.agent) {
      openAgent(line.dataset.agent);
    } else {
      openMap();
    }
  },
  onkeydown: (e: Event) => {
    if ((e as KeyboardEvent).key === 'Enter' || (e as KeyboardEvent).key === ' ') {
      e.preventDefault();
      openMap();
    }
  },
});

const input = h('textarea', { class: 'input', rows: '1', placeholder: 'Escreva para o Claude. Enter envia, Shift+Enter quebra linha' });
const attRow = h('div', { class: 'atts hidden' });
const filePicker = h('input', {
  type: 'file',
  multiple: true,
  accept: 'image/*,text/*,.md,.txt,.json,.csv,.log,.ts,.tsx,.js,.jsx,.py,.rs,.go,.java,.c,.h,.cpp,.cs,.rb,.php,.sh,.ps1,.css,.html,.xml,.yml,.yaml,.toml,.ini,.sql',
  class: 'hidden',
});
filePicker.addEventListener('change', () => {
  const chosen = Array.from(filePicker.files ?? []);
  filePicker.value = '';
  void addFiles(chosen);
});

/** Pílula da barra do composer: rótulo curto que abre um menu ou dispara uma ação. */
function pill(cls: string, title: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
  return h('button', { class: `pill ${cls}`, title, onclick: (e) => onClick(e as MouseEvent) });
}

const addBtn = h(
  'button',
  { class: 'ghost', title: 'Anexar arquivo ou mencionar o arquivo aberto', 'aria-label': 'Anexar', onclick: () => openAddMenu() },
  icon('add'),
);
// Quadradinho com "/" igual ao do Claude Code oficial: abre a lista de comandos de barra.
const mentionBtn = h(
  'button',
  { class: 'slash', title: 'Comandos de barra (/rename, /goal...)', 'aria-label': 'Comandos de barra', onclick: () => startSlash() },
  '/',
);
const workingDot = h('span', { class: 'working hidden', title: 'O Claude está trabalhando' });
const clockPill = pill('quiet', 'Limites do plano', (e) => openUsageMenu(e.currentTarget as HTMLElement));
const agentsPill = pill('agents hidden', 'Agentes desta conversa', () => openMap());
/** Decisões esperando o usuário (permissões, tarefas externas, alertas do guarda). Abre a lista; cada item leva ao cartão. */
const pendingPill = pill('pending-pill hidden', 'Decisões esperando você', (e) => openPendingMenu(e.currentTarget as HTMLElement));
const browserPill = pill('quiet browser hidden', 'Claude in Chrome', (e) => openBrowserMenu(e.currentTarget as HTMLElement));
const modelPill = pill('cap', 'Modelo e nível de raciocínio', (e) => openModelMenu(e.currentTarget as HTMLElement));
const modePill = pill('quiet mode', 'Modo de permissão', (e) => openModeMenu(e.currentTarget as HTMLElement));
agentsPill.setAttribute('aria-label', 'Mapa de agentes');
const sendBtn = h('button', { class: 'go', title: 'Enviar', 'aria-label': 'Enviar', onclick: () => (state.busy ? send({ type: 'interrupt' }) : submit()) });
/** Lista de sugestões acima do composer: comandos de barra ("/") e arquivos ("@"). */
const scPop = h('div', { class: 'sc-pop hidden', role: 'listbox', onmousedown: (e: Event) => e.preventDefault() });
/** Rodapé fino: contexto à esquerda, barrinhas de 5h e semana à direita. Clique relê os limites. */
const usageBar = h('div', { class: 'usage-bar', role: 'button', tabindex: '0', onclick: () => send({ type: 'refreshUsage' }) });

const composer = h(
  'footer',
  { class: 'composer sc-anchor' },
  scPop,
  attRow,
  h(
    'div',
    { class: 'box' },
    input,
    h('div', { class: 'row' }, addBtn, mentionBtn, workingDot, pendingPill, clockPill, agentsPill, browserPill, modelPill, h('div', { class: 'spacer' }), modePill, sendBtn),
  ),
  usageBar,
);
const dropZone = h('div', { class: 'dropzone hidden' }, h('div', { class: 'drop-card' }, icon('cloud-upload'), h('span', {}, 'Solte aqui')));
const menuLayer = h('div', { class: 'menu-layer hidden' });
const overlay = h('div', { class: 'overlay hidden' });
/** Captura de tela ampliada: clique ou Esc fecha. */
const shotView = h('div', { class: 'shot-view hidden', role: 'dialog', 'aria-label': 'Captura de tela ampliada', onclick: () => closeShot() });
document.getElementById('app')!.append(top, forkBanner, log, activity, runBar, composer, dropZone, menuLayer, overlay, shotView);



input.addEventListener('keydown', (e) => {
  if (suggestKey(e)) {
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
});
input.addEventListener('input', () => {
  autosize(input);
  renderSend();
  suggestCursor = 0;
  renderSuggest();
});
input.addEventListener('blur', () => closeSuggest());
// O "@" vale em qualquer ponto do texto: mover o cursor para dentro ou para fora de uma menção abre ou fecha a lista.
input.addEventListener('click', () => renderSuggest());
input.addEventListener('keyup', (e) => {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
    renderSuggest();
  }
});

// ---------- Sugestões acima do composer: comandos de barra e arquivos com "@" ----------

/** Qual lista ocupa o popup. Só uma por vez: "/" no começo do campo, "@" em qualquer ponto. */
let suggestKind: 'slash' | 'file' | null = null;
let suggestCursor = 0;
/** Esc fecha a lista até o texto mudar de novo. */
let suggestDismissed: string | null = null;

function renderSuggest(): void {
  if (input.value === suggestDismissed) {
    closeSuggest();
    return;
  }
  suggestDismissed = null;
  const slash = slashQuery();
  if (slash !== null) {
    renderSlash(slash);
    return;
  }
  const mention = mentionAtCursor();
  if (mention) {
    renderFiles(mention);
    return;
  }
  closeSuggest();
}

function closeSuggest(): void {
  suggestKind = null;
  scPop.classList.add('hidden');
  scPop.replaceChildren();
  clearTimeout(fileTimer);
  fileWanted = null;
  fileShown = null;
  fileMatches = [];
}

/** Mostra as linhas prontas, ou só uma linha cinza quando `rows` é texto. `footer` é um aviso abaixo da lista. */
function showSuggest(kind: 'slash' | 'file', rows: HTMLElement[] | string, footer?: string): void {
  suggestKind = kind;
  if (typeof rows === 'string') {
    fill(scPop, h('div', { class: 'sc-empty' }, rows));
  } else {
    fill(scPop, ...rows, footer ? h('div', { class: 'sc-empty' }, footer) : null);
  }
  scPop.classList.remove('hidden');
  scPop.children[suggestCursor]?.scrollIntoView({ block: 'nearest' });
}

function suggestRow(i: number, onPick: () => void, title: string | undefined, ...children: Child[]): HTMLElement {
  return h(
    'div',
    {
      class: `sc-item${i === suggestCursor ? ' cur' : ''}`,
      role: 'option',
      title: title ?? false,
      // mousedown: o clique não pode tirar o foco do campo antes de completar.
      onmousedown: (e: Event) => {
        e.preventDefault();
        onPick();
      },
    },
    ...children,
  );
}

/** Teclas com a lista aberta. Devolve true quando a tecla era dela. */
function suggestKey(e: KeyboardEvent): boolean {
  if (!suggestKind || e.isComposing) {
    return false;
  }
  if (e.key === 'Escape') {
    // Só fecha a lista: não interrompe o Claude nem fecha o mapa.
    e.preventDefault();
    e.stopPropagation();
    suggestDismissed = input.value;
    closeSuggest();
    return true;
  }
  const n = suggestKind === 'slash' ? (slashCommands ? slashMatches.length : 0) : fileMatches.length;
  if (!n) {
    return false;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    suggestCursor = (suggestCursor + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    Array.from(scPop.children).forEach((row, i) => row.classList.toggle('cur', i === suggestCursor));
    scPop.children[suggestCursor]?.scrollIntoView({ block: 'nearest' });
    return true;
  }
  if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
    if (suggestKind === 'file') {
      e.preventDefault();
      completeFile(fileMatches[suggestCursor]);
      return true;
    }
    const c = slashMatches[suggestCursor];
    // Nome já completo e Enter: manda o comando como está, em vez de completar de novo.
    if (e.key === 'Enter' && input.value.slice(1).toLowerCase() === c.name.toLowerCase()) {
      closeSuggest();
      return false;
    }
    e.preventDefault();
    completeSlash(c);
    return true;
  }
  return false;
}

// ---------- Comandos de barra ----------

/** null enquanto o host não mandou a lista (o processo ainda está subindo). */
let slashCommands: SlashCommandOption[] | null = null;
let slashMatches: SlashCommandOption[] = [];

/** Nome digitado depois da barra, ou null quando o campo não é um comando sendo escrito. */
function slashQuery(): string | null {
  const m = /^\/(\S*)$/.exec(input.value);
  return m ? m[1].toLowerCase() : null;
}

/** Prefixo primeiro, depois quem tem o trecho em outro lugar do nome. */
function matchSlash(q: string): SlashCommandOption[] {
  const list = slashCommands ?? [];
  const starts = list.filter((c) => c.name.toLowerCase().startsWith(q));
  const inside = list.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
  return [...starts, ...inside];
}

function renderSlash(q: string): void {
  if (!slashCommands) {
    showSuggest('slash', 'Carregando comandos...');
    return;
  }
  slashMatches = matchSlash(q);
  suggestCursor = Math.min(suggestCursor, Math.max(0, slashMatches.length - 1));
  const codexNote = state.provider === 'codex' ? 'Os outros comandos do Claude Code não existem no Codex.' : undefined;
  if (!slashMatches.length) {
    showSuggest('slash', `Nenhum comando começa com /${q}${codexNote ? `. ${codexNote}` : ''}`);
    return;
  }
  showSuggest(
    'slash',
    slashMatches.map((c, i) =>
      suggestRow(
        i,
        () => completeSlash(c),
        undefined,
        h('span', { class: 'sc-name' }, `/${c.name}`),
        c.argumentHint ? h('span', { class: 'sc-arg' }, c.argumentHint) : null,
        h('span', { class: 'sc-desc' }, c.description),
      ),
    ),
    codexNote,
  );
}

function completeSlash(c: SlashCommandOption): void {
  input.value = `/${c.name} `;
  input.setSelectionRange(input.value.length, input.value.length);
  closeSuggest();
  autosize(input);
  renderSend();
  input.focus();
}

/** Botão "/": começa um comando no campo e abre a lista. */
function startSlash(): void {
  if (!input.value.startsWith('/')) {
    input.value = `/${input.value.trimStart()}`;
  }
  suggestDismissed = null;
  suggestCursor = 0;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  autosize(input);
  renderSend();
  if (!slashCommands) {
    send({ type: 'listCommands' });
  }
  renderSuggest();
}

// ---------- Menção de arquivo com "@" ----------

interface Mention {
  /** Trecho do campo que a escolha substitui, do "@" ao fim do caminho já digitado. */
  start: number;
  end: number;
  query: string;
}

let fileMatches: FileResult[] = [];
let fileNotice: string | undefined;
/** Busca que o campo pede agora e busca da lista na tela (null enquanto não chegou nenhuma). */
let fileWanted: string | null = null;
let fileShown: string | null = null;
let fileSent = '';
let fileReq = 0;
let fileTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * "@" logo antes do cursor, no começo do texto ou depois de espaço ou quebra de linha, seguido de caracteres
 * de caminho. Com aspas (`@"pasta com espaço/`) o caminho pode ter espaço.
 */
function mentionAtCursor(): Mention | null {
  const pos = input.selectionStart;
  if (pos !== input.selectionEnd) {
    return null;
  }
  const m = /(?:^|\s)@(?:"([^"\n]*)|([^\s"]*))$/.exec(input.value.slice(0, pos));
  if (!m) {
    return null;
  }
  const quoted = m[1] !== undefined;
  const query = quoted ? m[1] : m[2];
  const after = input.value.slice(pos);
  // O resto do caminho à direita do cursor também sai: escolher no meio de "@sess|ion.ts" troca a palavra toda.
  const tail = (quoted ? /^[^"\n]*"/.exec(after) : null)?.[0] ?? /^[^\s"]*/.exec(after)![0];
  return { start: pos - query.length - (quoted ? 2 : 1), end: pos + tail.length, query };
}

function renderFiles(m: Mention): void {
  if (m.query !== fileWanted) {
    fileWanted = m.query;
    clearTimeout(fileTimer);
    fileTimer = setTimeout(() => {
      fileSent = m.query;
      send({ type: 'searchFiles', query: m.query, requestId: ++fileReq });
    }, 80);
  }
  paintFiles();
}

function paintFiles(): void {
  if (fileShown === null) {
    showSuggest('file', 'Buscando arquivos...');
    return;
  }
  if (!fileMatches.length) {
    showSuggest('file', fileNotice ?? 'Nenhum arquivo encontrado');
    return;
  }
  const q = fileShown;
  showSuggest(
    'file',
    fileMatches.map((f, i) => {
      const cut = Math.max(f.path.lastIndexOf('/'), f.path.lastIndexOf('\\'));
      return suggestRow(
        i,
        () => completeFile(f),
        f.path,
        icon(f.kind === 'folder' ? 'folder' : 'file'),
        h('span', { class: 'sc-name sc-file' }, ...highlight(f.name, q)),
        cut > 0 ? h('span', { class: 'sc-desc' }, f.path.slice(0, cut)) : null,
      );
    }),
    fileNotice,
  );
}

/** Realça no nome as letras que casaram com a busca: o trecho inteiro quando aparece junto, senão letra a letra. */
function highlight(name: string, query: string): (Node | string)[] {
  const q = query.slice(query.lastIndexOf('/') + 1).toLowerCase();
  const lower = name.toLowerCase();
  if (!q) {
    return [name];
  }
  const hits = new Set<number>();
  const at = lower.indexOf(q);
  if (at >= 0) {
    for (let i = 0; i < q.length; i++) {
      hits.add(at + i);
    }
  } else {
    let from = 0;
    for (const ch of q) {
      const i = lower.indexOf(ch, from);
      if (i < 0) {
        // Casou pelo caminho, não pelo nome: nada a realçar.
        return [name];
      }
      hits.add(i);
      from = i + 1;
    }
  }
  const out: (Node | string)[] = [];
  let run = '';
  let runHit = false;
  for (let i = 0; i <= name.length; i++) {
    const hit = hits.has(i);
    if (i === name.length || (run && hit !== runHit)) {
      out.push(runHit ? h('span', { class: 'sc-hit' }, run) : run);
      run = '';
    }
    run += name[i] ?? '';
    runHit = hit;
  }
  return out;
}

/**
 * Troca o "@digitado" pela menção completa, com aspas quando o caminho tem espaço (a mesma regra do host
 * para anexos). Pasta deixa a lista aberta, com o cursor antes da aspa final, para seguir navegando nela.
 */
function completeFile(f: FileResult): void {
  const m = mentionAtCursor();
  if (!m) {
    return;
  }
  const folder = f.kind === 'folder';
  const target = folder ? `${f.path}/` : f.path;
  const quote = /\s/.test(target);
  const mention = quote ? `@"${target}"` : `@${target}`;
  const rest = input.value.slice(m.end);
  let text = mention;
  let caret = m.start + mention.length;
  if (folder) {
    caret -= quote ? 1 : 0;
  } else if (rest.startsWith(' ')) {
    caret += 1;
  } else {
    text += ' ';
    caret += 1;
  }
  input.value = input.value.slice(0, m.start) + text + rest;
  input.setSelectionRange(caret, caret);
  autosize(input);
  renderSend();
  input.focus();
  suggestCursor = 0;
  if (folder) {
    renderSuggest();
  } else {
    closeSuggest();
  }
}

/** "Adicionar contexto" do "+": põe um "@" onde está o cursor e abre a lista de arquivos. */
function startMention(): void {
  input.focus();
  const pos = input.selectionStart;
  const lead = pos > 0 && !/\s/.test(input.value[pos - 1]) ? ' ' : '';
  input.setRangeText(`${lead}@`, pos, input.selectionEnd, 'end');
  suggestDismissed = null;
  suggestCursor = 0;
  autosize(input);
  renderSend();
  renderSuggest();
}

const WEB_PREFIX = 'Pesquise na web: ';
/** Começos de mensagem que os itens do "+" inserem; trocar de item troca o começo em vez de empilhar. */
const PROMPT_PREFIX = /^(Pesquise na web: |Use o (Gemini|GPT) para pesquisar na web: |Gere uma imagem com o (Gemini|GPT) e salve em [^:\n]*: )/;

/**
 * Itens do "+" que começam a mensagem com um pedido editável. "Pesquise na web" usa o WebSearch do Claude;
 * os pedidos com Gemini ou GPT fazem o Claude chamar web_research ou generate_image.
 */
function startPrefixed(prefix: string): void {
  if (!input.value.startsWith(prefix)) {
    input.value = prefix + input.value.replace(PROMPT_PREFIX, '').trimStart();
  }
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  autosize(input);
  renderSend();
}

/** Nome do arquivo aberto no editor, que o host manda; sem ele o item "Mencionar arquivo aberto" some. */
let activeFileName: string | undefined;

function openAddMenu(): void {
  const items: MenuItem[] = [
    { icon: 'cloud-upload', label: 'Enviar do computador', title: 'Anexa imagens e arquivos de texto do computador', onPick: () => filePicker.click() },
    { icon: 'file-add', label: 'Adicionar contexto', title: 'Menciona um arquivo ou pasta do projeto com @', onPick: () => startMention() },
  ];
  const research = providerName(state.external.research);
  const image = providerName(state.external.image);
  const webItems: MenuItem[] = [
    {
      icon: 'globe',
      label: 'Pesquisar com o Claude',
      title: 'Começa a mensagem com "Pesquise na web:". O Claude usa as ferramentas de busca dele (WebSearch e WebFetch).',
      onPick: () => startPrefixed(WEB_PREFIX),
    },
    {
      icon: 'search',
      label: 'Pesquisar com Gemini/GPT',
      hint: research,
      title: `Pede ao ${research} uma pesquisa na web (ferramenta web_research). Troque o nome no texto para usar o outro provedor. Gasta a cota do CLI (Codex ou Antigravity) ou crédito de API.`,
      onPick: () => startPrefixed(`Use o ${research} para pesquisar na web: `),
    },
    {
      icon: 'file-media',
      label: 'Gerar imagem',
      hint: image,
      title: `Pede ao ${image} uma imagem, salva em ${state.external.imageFolder}/ e mostrada aqui (ferramenta generate_image). Troque o nome ou a pasta no texto se quiser.`,
      onPick: () => startPrefixed(`Gere uma imagem com o ${image} e salve em ${state.external.imageFolder}/: `),
    },
  ];
  if (activeFileName) {
    items.push({
      icon: 'mention',
      label: 'Mencionar arquivo aberto',
      title: `Insere @${activeFileName} (com as linhas selecionadas, se houver)`,
      onPick: () => send({ type: 'mentionFile' }),
    });
  }
  const sections: MenuSection[] = [{ items }, { title: 'Web e imagens', items: webItems }];
  if (state.provider === 'claude' && !state.forkOf) {
    const b = state.browser;
    const heldElsewhere = !!b.owner && b.owner.id !== 'main';
    sections.push({
      title: 'Navegador',
      items: [
        {
          icon: 'browser',
          label: 'Usar o navegador (Claude in Chrome)',
          selected: b.on,
          detail: heldElsewhere && !b.on ? `em uso por ${b.owner!.label}` : b.on ? browserStateText() : undefined,
          disabled: heldElsewhere && !b.on,
          title: b.on
            ? 'Desliga o Claude in Chrome nesta conversa (reinicia a sessão e continua a mesma conversa).'
            : 'Liga o Claude in Chrome nesta conversa: o Claude controla o Chrome em que a extensão está conectada. Cliques e digitação pedem aprovação.',
          onPick: () => send({ type: 'setChrome', value: !b.on }),
        },
      ],
    });
  }
  openMenu(addBtn, sections);
  const panel = openAt?.anchor === addBtn ? menuLayer.querySelector<HTMLElement>('.menu') : null;
  if (panel) {
    panel.classList.add('addm');
    placeMenu(panel, addBtn, false);
  }
}
input.addEventListener('paste', (e) => {
  const imgs = Array.from(e.clipboardData?.items ?? []).filter((it) => it.kind === 'file' && it.type.startsWith('image/'));
  if (!imgs.length) {
    return;
  }
  // Só engole o paste quando havia imagem; texto junto com a imagem continua caindo no textarea.
  e.preventDefault();
  const files = imgs.map((it) => it.getAsFile()).filter((f): f is File => !!f);
  void addFiles(files);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // O menu já se fechou no handler de captura; este Esc não pode virar interrupt.
    if (openAt || closeShot()) {
      return;
    }
    if (!overlay.classList.contains('hidden')) {
      closeMap();
    } else if (state.busy) {
      send({ type: 'interrupt' });
    }
  }
});

function autosize(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
}

function submit(): void {
  const text = input.value.trim();
  if (!text && !pending.length) {
    return;
  }
  // Anexo com erro já avisou no preview e não tem conteúdo para mandar.
  const atts = pending.filter((a) => !a.error);
  pending.length = 0;
  renderPending();
  input.value = '';
  autosize(input);
  closeSuggest();
  addUser(text, undefined, log, atts);
  send({ type: 'send', text, attachments: atts.length ? atts : undefined });
}

// ---------- Anexos ----------

const TEXT_LIMIT = 256 * 1024;
/** Windows não dá MIME para .ts/.md e afins; tipo vazio entra como texto e o tamanho decide. */
const TEXTISH = /^(text\/|application\/(json|xml|javascript|typescript|x-sh|x-yaml|sql))/;

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) {
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }
  return n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('leitura falhou'));
    reader.readAsDataURL(file);
  });
}

async function addFiles(files: readonly File[]): Promise<void> {
  for (const file of files) {
    const base = { id: crypto.randomUUID(), name: file.name || 'anexo', size: file.size };
    try {
      if (file.type.startsWith('image/')) {
        pending.push({ ...base, kind: 'image', dataUrl: await readDataUrl(file) });
      } else if (!(file.type === '' || TEXTISH.test(file.type))) {
        pending.push({ ...base, kind: 'text', error: 'Tipo de arquivo não suportado. Arraste do explorer do VS Code para mandar o caminho.' });
      } else if (file.size > TEXT_LIMIT) {
        pending.push({ ...base, kind: 'text', error: `Arquivo grande demais (${fmtBytes(file.size)}). O limite é 256 KB.` });
      } else {
        pending.push({ ...base, kind: 'text', text: await file.text() });
      }
    } catch {
      pending.push({ ...base, kind: 'text', error: 'Não foi possível ler este arquivo.' });
    }
    renderPending();
  }
}

function attChip(a: Attachment, onRemove?: () => void): HTMLElement {
  const face =
    a.kind === 'image' && a.dataUrl
      ? h('img', { class: 'att-thumb', src: a.dataUrl, alt: a.name })
      : icon(a.error ? 'file-binary' : a.kind === 'path' ? 'file-symlink-file' : 'file-code');
  return h(
    'div',
    { class: `att${a.error ? ' bad' : ''}`, title: a.error ?? a.path ?? a.name },
    face,
    h('span', { class: 'att-name' }, a.name),
    a.error ? h('span', { class: 'att-err' }, a.error) : a.size ? h('span', { class: 'att-size' }, fmtBytes(a.size)) : null,
    onRemove ? h('button', { class: 'att-x', title: 'Remover', 'aria-label': `Remover ${a.name}`, onclick: onRemove }, icon('close')) : null,
  );
}

function renderPending(): void {
  attRow.classList.toggle('hidden', !pending.length);
  fill(
    attRow,
    ...pending.map((a) =>
      attChip(a, () => {
        const at = pending.findIndex((p) => p.id === a.id);
        if (at >= 0) {
          pending.splice(at, 1);
        }
        renderPending();
      }),
    ),
  );
  renderSend();
}

// Com o mapa de agentes aberto o composer está coberto; anexar ali só sumiria com o arquivo.
const dragPayload = (dt: DataTransfer | null) =>
  !!dt && overlay.classList.contains('hidden') && (dt.types.includes('Files') || dt.types.includes('text/uri-list'));

// dragenter/dragleave disparam de novo a cada filho sob o cursor; o contador evita a camada piscando.
let dragDepth = 0;
function endDrag(): void {
  dragDepth = 0;
  dropZone.classList.add('hidden');
}

window.addEventListener('dragenter', (e) => {
  if (!dragPayload(e.dataTransfer)) {
    return;
  }
  dragDepth++;
  dropZone.classList.remove('hidden');
});
window.addEventListener('dragover', (e) => {
  if (!dragPayload(e.dataTransfer)) {
    return;
  }
  e.preventDefault();
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'copy';
  }
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) {
    dropZone.classList.add('hidden');
  }
});
window.addEventListener('dragend', endDrag);
window.addEventListener('drop', (e) => {
  const dt = e.dataTransfer;
  endDrag();
  if (!dragPayload(dt)) {
    return;
  }
  e.preventDefault();
  // Arquivo do explorer do VS Code chega como URI sem conteúdo; só o host sabe virar caminho.
  const uris = (dt?.getData('text/uri-list') ?? '').split(/\r?\n/).filter((u) => u && !u.startsWith('#'));
  if (uris.length) {
    send({ type: 'resolveUris', uris });
    return;
  }
  void addFiles(Array.from(dt?.files ?? []));
});

// ---------- Controles ----------

/**
 * Nome bonito a partir do id: tira `claude-`, capitaliza a família, junta os números de
 * versão com ponto e transforma o sufixo de contexto longo em " (1M)".
 * `claude-opus-5-5` → "Opus 5.5"; `claude-opus-5[1m]` → "Opus 5 (1M)".
 */
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
  // Números de 4+ dígitos são a data da build (claude-haiku-4-5-20251001), não versão.
  const version = rest.filter((p) => /^\d{1,3}$/.test(p)).join('.');
  return `${family.charAt(0).toUpperCase()}${family.slice(1)}${version ? ` ${version}` : ''}${long ? ` (${long[1]}M)` : ''}`;
}

/** A lista de modelos é a fonte boa do nome; o id só vira nome derivado quando não bate com nada. */
/**
 * Nome do modelo que está rodando de fato. O id derivado ("Opus 5.5") vem antes do displayName da lista,
 * porque a entrada escolhida costuma ser "Default (recommended)", que esconde qual modelo é.
 */
function modelLabel(id: string): string {
  if (state.provider === 'codex') {
    const listed = state.models.find((m) => m.resolvedModel === id || m.value === id);
    if (listed) {
      return listed.displayName;
    }
  }
  const pretty = prettyModel(id);
  if (pretty !== id) {
    return pretty;
  }
  const named = state.models.find((m) => m.resolvedModel === id && m.value !== 'default');
  return named?.displayName ?? state.models.find((m) => m.resolvedModel === id)?.displayName ?? id;
}

/** Família e número de versão do `resolvedModel`, na mesma lógica de {@link prettyModel}, para comparar versões. */
function modelVersionKey(id: string): { family: string; parts: number[] } {
  const long = /\[(\d+)m\]$/i.exec(id);
  const [family, ...rest] = (long ? id.slice(0, long.index) : id).replace(/^claude-/, '').split('-');
  return { family: (family ?? '').toLowerCase(), parts: rest.filter((p) => /^\d{1,3}$/.test(p)).map(Number) };
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) {
      return d;
    }
  }
  return 0;
}

/** Só o mais novo de cada família, mais o item `default` e o modelo selecionado agora, mesmo que antigo. */
function newestModels(models: ModelOption[]): Set<ModelOption> {
  const byFamily = new Map<string, ModelOption[]>();
  for (const m of models) {
    const { family } = modelVersionKey(m.resolvedModel ?? m.value);
    if (!family) {
      continue;
    }
    (byFamily.get(family) ?? byFamily.set(family, []).get(family)!).push(m);
  }
  const result = new Set<ModelOption>();
  for (const list of byFamily.values()) {
    const best = list.reduce<number[]>((acc, m) => {
      const { parts } = modelVersionKey(m.resolvedModel ?? m.value);
      return compareVersions(parts, acc) > 0 ? parts : acc;
    }, []);
    for (const m of list) {
      if (compareVersions(modelVersionKey(m.resolvedModel ?? m.value).parts, best) === 0) {
        result.add(m);
      }
    }
  }
  const def = models.find((m) => m.value === 'default');
  if (def) {
    result.add(def);
  }
  const cur = models.find((m) => m.value === state.model);
  if (cur) {
    result.add(cur);
  }
  return result;
}

// ---------- Menus ancorados ----------

interface MenuItem {
  label: string;
  /** Segunda linha, em cinza. */
  detail?: string;
  /** Texto cinza encostado à direita. */
  hint?: string;
  selected?: boolean;
  disabled?: boolean;
  onPick?: () => void;
  /** Não fecha o menu ao clicar; usado para alternar entre visões dentro do mesmo painel. */
  keepOpen?: boolean;
  /** Codicon à esquerda, no lugar do check. */
  icon?: string;
  title?: string;
}

interface MenuSection {
  title?: string;
  items: MenuItem[];
  /** Rodapé cinza da seção. */
  note?: string;
}

/** Só um menu por vez. Guarda em quem ele está ancorado para poder redesenhar sem reabrir. */
let openAt: { anchor: HTMLElement; below: boolean } | null = null;
let menuButtons: HTMLButtonElement[] = [];
let menuCursor = -1;

function closeMenu(): void {
  if (!openAt) {
    return;
  }
  openAt.anchor.classList.remove('menu-on');
  openAt = null;
  menuButtons = [];
  menuCursor = -1;
  menuLayer.classList.add('hidden');
  menuLayer.replaceChildren();
}

/**
 * Painel flutuante preso ao elemento clicado. `below` pede o lado de baixo (botões do topo);
 * o padrão é para cima, porque quem abre menu aqui é o composer, que fica no rodapé.
 */
function openMenu(anchor: HTMLElement, sections: MenuSection[], below = false): void {
  const again = openAt?.anchor === anchor;
  closeMenu();
  if (again) {
    return;
  }
  openAt = { anchor, below };
  anchor.classList.add('menu-on');
  menuLayer.classList.remove('hidden');
  paintMenu(sections);
}

/** Redesenha o menu que já está aberto neste anchor: a lista de conversas chega depois do clique. */
function refillMenu(anchor: HTMLElement, sections: MenuSection[]): void {
  if (openAt?.anchor === anchor) {
    paintMenu(sections);
  }
}

function paintMenu(sections: MenuSection[]): void {
  const { anchor, below } = openAt!;
  menuButtons = [];
  menuCursor = -1;
  const panel = h('div', { class: 'menu', tabindex: '-1', role: 'menu' });
  for (const section of sections) {
    if (panel.childElementCount) {
      panel.append(h('div', { class: 'menu-sep' }));
    }
    if (section.title) {
      panel.append(h('div', { class: 'menu-title' }, section.title));
    }
    for (const item of section.items) {
      const btn = h(
        'button',
        { class: `menu-item${item.selected ? ' sel' : ''}`, type: 'button', role: 'menuitem', title: item.title ?? false },
        h('span', { class: 'menu-mark' }, item.selected ? icon('check') : item.icon ? icon(item.icon) : null),
        h('span', { class: 'menu-text' }, h('span', { class: 'menu-label' }, item.label), item.detail ? h('span', { class: 'menu-detail' }, item.detail) : null),
        item.hint ? h('span', { class: 'menu-hint' }, item.hint) : null,
      );
      if (item.disabled || !item.onPick) {
        btn.disabled = true;
      } else {
        const pick = item.onPick;
        btn.addEventListener('click', () => {
          if (!item.keepOpen) {
            closeMenu();
          }
          pick();
        });
        menuButtons.push(btn);
      }
      panel.append(btn);
    }
    if (section.note) {
      panel.append(h('div', { class: 'menu-note' }, section.note));
    }
  }
  menuLayer.replaceChildren(panel);
  placeMenu(panel, anchor, below);
  panel.focus();
}

/** Encaixa o painel perto do anchor sem deixar nada para fora da janela. */
function placeMenu(panel: HTMLElement, anchor: HTMLElement, below: boolean): void {
  const r = anchor.getBoundingClientRect();
  const gap = 6;
  const edge = 8;
  const roomAbove = r.top - gap - edge;
  const roomBelow = window.innerHeight - r.bottom - gap - edge;
  // Fica do lado pedido; só vira para o outro quando ali não cabe e o oposto é maior.
  const goUp = below ? roomBelow < 140 && roomAbove > roomBelow : !(roomAbove < 140 && roomBelow > roomAbove);
  panel.style.maxHeight = `${Math.max(140, goUp ? roomAbove : roomBelow)}px`;
  const w = panel.offsetWidth;
  const hh = panel.offsetHeight;
  const left = Math.min(Math.max(edge, r.left), Math.max(edge, window.innerWidth - edge - w));
  const top = goUp ? Math.max(edge, r.top - gap - hh) : Math.min(r.bottom + gap, Math.max(edge, window.innerHeight - edge - hh));
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
}

// Clique fora fecha. A camada cobre a página inteira, então isso pega qualquer ponto fora do painel.
menuLayer.addEventListener('mousedown', (e) => {
  if (!(e.target as Element).closest('.menu')) {
    closeMenu();
  }
});

// Captura: com menu aberto, Esc fecha o menu em vez de interromper o Claude, e as setas navegam.
document.addEventListener(
  'keydown',
  (e) => {
    if (!openAt) {
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      return;
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && menuButtons.length) {
      e.preventDefault();
      e.stopPropagation();
      const down = e.key === 'ArrowDown';
      menuCursor = menuCursor < 0 ? (down ? 0 : menuButtons.length - 1) : (menuCursor + (down ? 1 : menuButtons.length - 1)) % menuButtons.length;
      menuButtons.forEach((b, i) => b.classList.toggle('cur', i === menuCursor));
      menuButtons[menuCursor].scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'Enter' && menuCursor >= 0) {
      e.preventDefault();
      e.stopPropagation();
      menuButtons[menuCursor].click();
    }
  },
  true,
);

// ---------- Conteúdo dos menus ----------

const MODE_SHORT: Record<string, string> = {
  default: 'Perguntar antes',
  acceptEdits: 'Aceitar edições',
  plan: 'Planejar',
  bypassPermissions: 'Bypass permissions',
};
const MODE_ICON: Record<string, string> = {
  default: 'shield',
  acceptEdits: 'edit',
  plan: 'checklist',
  bypassPermissions: 'organization',
};
const MODE_HELP: Record<string, string> = {
  default: 'Pergunta antes de cada ferramenta que muda alguma coisa.',
  acceptEdits: 'Edita arquivos sem perguntar; o resto continua passando por você.',
  plan: 'Só lê e propõe um plano; nada muda até você aprovar.',
  bypassPermissions: 'Não pergunta nada: qualquer edição ou comando roda direto. Use só quando confiar na tarefa inteira.',
};
const EFFORT_SHORT: Record<string, string> = {
  none: 'Nenhum',
  minimal: 'Mínimo',
  low: 'Baixo',
  medium: 'Médio',
  high: 'Alto',
  xhigh: 'Muito alto',
  max: 'Máximo',
  ultra: 'Ultra',
};

/** Enquanto o menu de modelo estiver aberto: lembra se o usuário pediu a lista completa. */
let modelMenuShowAll = false;

function modelMenuSections(anchor: HTMLElement): MenuSection[] {
  const all = state.models.length ? state.models : [{ value: '', displayName: 'Modelo padrão', description: '' }];
  // O Codex lista poucos modelos e sem família-versão para comparar: mostra todos.
  const newest = state.provider === 'codex' ? new Set(all) : newestModels(all);
  const reduced = all.filter((m) => newest.has(m));
  const list = modelMenuShowAll ? all : reduced;
  const modelItems: MenuItem[] = list.map((m) => ({
    label: m.displayName,
    detail: m.description || undefined,
    selected: m.value === state.model || (state.provider === 'codex' && !state.model && m.resolvedModel === state.resolvedModel),
    onPick: () => {
      state.model = m.value;
      if (m.resolvedModel) {
        state.resolvedModel = m.resolvedModel;
      }
      renderControls();
      send({ type: 'setModel', value: m.value });
    },
  }));
  if (reduced.length < all.length) {
    modelItems.push({
      label: modelMenuShowAll ? 'Mostrar só os mais novos' : `Mostrar todos os modelos (${all.length})`,
      keepOpen: true,
      onPick: () => {
        modelMenuShowAll = !modelMenuShowAll;
        paintModelMenu(anchor, false);
      },
    });
  }
  return [{ title: 'Escolha um modelo', items: modelItems }];
}

/** Níveis do slider de raciocínio, da esquerda para a direita. O padrão (`''`) fica fora dele. */
const EFFORT_STEPS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Ordem de todos os níveis conhecidos, para arrumar os que o Codex informa por modelo. */
const EFFORT_ORDER = ['none', 'minimal', ...EFFORT_STEPS, 'ultra'];

/** Níveis que `model` aceita, em ordem. Sem informação (Claude), os cinco de sempre. */
function effortsFor(model: ModelOption | undefined): string[] {
  const list = model?.efforts;
  if (!list?.length) {
    return EFFORT_STEPS;
  }
  const rank = (e: string) => (EFFORT_ORDER.includes(e) ? EFFORT_ORDER.indexOf(e) : EFFORT_ORDER.length);
  return [...list].sort((a, b) => rank(a) - rank(b));
}

/** Modelo escolhido neste chat, ou o que está rodando quando a escolha é o padrão. */
function currentModel(): ModelOption | undefined {
  return (
    state.models.find((m) => m.value && m.value === state.model) ??
    state.models.find((m) => !!state.resolvedModel && m.resolvedModel === state.resolvedModel) ??
    state.models.find((m) => /padrão da conta/.test(m.description))
  );
}

/**
 * Rodapé do menu de modelo: "Raciocínio (Médio)" e uma trilha com um ponto por nível.
 * Clique num ponto ou setas com a trilha em foco trocam o nível; nada é enviado enquanto o usuário não escolhe.
 */
function effortSlider(): HTMLElement {
  const steps = effortsFor(currentModel());
  // Posição mostrada quando não há escolha: "medium" se o modelo tiver, senão o meio da trilha.
  const unsetAt = steps.includes('medium') ? steps.indexOf('medium') : Math.floor((steps.length - 1) / 2);
  const level = h('span', { class: 'mm-effort-level' });
  const knob = h('span', { class: 'mm-knob' });
  const track = h('div', {
    class: 'mm-slider',
    role: 'slider',
    tabindex: '0',
    'aria-label': 'Nível de raciocínio',
    'aria-valuemin': '0',
    'aria-valuemax': String(steps.length - 1),
  });
  track.style.setProperty('--steps', String(Math.max(1, steps.length - 1)));
  const paint = (): void => {
    const idx = steps.indexOf(state.effort);
    const shown = idx < 0 ? unsetAt : idx;
    track.style.setProperty('--i', String(shown));
    track.classList.toggle('mm-unset', idx < 0);
    track.setAttribute('aria-valuenow', String(shown));
    track.setAttribute('aria-valuetext', idx < 0 ? 'padrão' : (EFFORT_SHORT[state.effort] ?? state.effort));
    level.textContent = `(${idx < 0 ? 'padrão' : (EFFORT_SHORT[state.effort] ?? state.effort)})`;
  };
  const pick = (v: string): void => {
    if (v === state.effort) {
      return;
    }
    state.effort = v;
    renderControls();
    send({ type: 'setEffort', value: v });
    paint();
  };
  steps.forEach((v, i) => {
    const dot = h('span', { class: `mm-dot${v === 'max' || v === 'ultra' ? ' mm-max' : ''}`, title: EFFORT_SHORT[v] ?? v });
    dot.style.setProperty('--i', String(i));
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      pick(v);
    });
    track.append(dot);
  });
  track.append(knob);
  // Clique fora dos pontos vai para o nível mais perto; os pontos são pequenos demais para exigir mira.
  track.addEventListener('click', (e) => {
    const r = track.getBoundingClientRect();
    const t = (e.clientX - r.left - 9) / Math.max(1, r.width - 18);
    pick(steps[Math.min(steps.length - 1, Math.max(0, Math.round(t * (steps.length - 1))))]);
  });
  track.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const idx = steps.indexOf(state.effort);
    const from = idx < 0 ? unsetAt : idx;
    const to = Math.min(steps.length - 1, Math.max(0, from + (e.key === 'ArrowRight' ? 1 : -1)));
    pick(steps[to]);
  });
  paint();
  return h('div', { class: 'mm-effort' }, h('span', { class: 'mm-effort-label' }, 'Raciocínio ', level), track);
}

/** Desenha o menu genérico e o veste de menu de modelo: classe `mm`, item "Mostrar todos" discreto e o slider no rodapé. */
function paintModelMenu(anchor: HTMLElement, fresh: boolean): void {
  const sections = modelMenuSections(anchor);
  if (fresh) {
    openMenu(anchor, sections);
  } else {
    refillMenu(anchor, sections);
  }
  const panel = openAt?.anchor === anchor ? menuLayer.querySelector<HTMLElement>('.menu') : null;
  if (!panel) {
    return;
  }
  panel.classList.add('mm');
  const items = sections[0].items;
  if (items[items.length - 1]?.keepOpen) {
    const buttons = panel.querySelectorAll('.menu-item');
    buttons[buttons.length - 1]?.classList.add('mm-more');
  }
  panel.append(effortSlider());
  placeMenu(panel, anchor, false);
}

function openModelMenu(anchor: HTMLElement): void {
  modelMenuShowAll = false;
  paintModelMenu(anchor, true);
}

function openModeMenu(anchor: HTMLElement): void {
  openMenu(anchor, [
    {
      title: 'Modo de permissão',
      items: MODES.map(([v, l]) => ({
        label: l,
        detail: MODE_HELP[v],
        selected: v === state.mode,
        onPick: () => {
          state.mode = v;
          renderControls();
          send({ type: 'setMode', value: v });
        },
      })),
    },
  ]);
}

function openUsageMenu(anchor: HTMLElement): void {
  const ctx: MenuItem[] = state.contextTokens
    ? [{ label: 'Contexto desta conversa', detail: `${state.contextTokens.toLocaleString('pt-BR')} tokens em contexto`, hint: shortTokens(state.contextTokens) }]
    : [];
  const refresh: MenuItem = { label: 'Atualizar agora', onPick: () => send({ type: 'refreshUsage' }) };
  const u = lastUsage;
  if (!u?.available) {
    openMenu(anchor, [
      {
        title: 'Limites do plano',
        items: [...ctx, { label: 'Limites indisponíveis', detail: u?.error ?? 'Os limites chegam com a primeira resposta desta conta.' }],
      },
      { items: [refresh] },
    ]);
    return;
  }
  openMenu(anchor, [
    {
      title: u.subscription ? `Limites do plano ${u.subscription}` : 'Limites do plano',
      items: [
        ...ctx,
        ...u.windows.map((w) => ({
          label: w.label,
          detail: `${Math.round(w.utilization)}% usado · ${Math.round(100 - w.utilization)}% livre${w.resetsAt ? ` · zera ${fmtReset(w.resetsAt)}` : ''}`,
          hint: w.resetsAt ? fmtLeft(w.resetsAt) : undefined,
        })),
      ],
      note: `Lido às ${fmtClock(u.fetchedAt)}.`,
    },
    { items: [refresh] },
  ]);
}

function openHistoryMenu(): void {
  const wasOpen = openAt?.anchor === histBtn;
  openMenu(histBtn, [{ title: 'Conversas anteriores', items: [{ label: 'Carregando…' }] }], true);
  if (!wasOpen) {
    send({ type: 'listSessions' });
  }
}

function showSessions(list: SessionOption[], error?: string): void {
  const items: MenuItem[] = error
    ? [{ label: 'Não foi possível ler as conversas', detail: error }]
    : !list.length
      ? [{ label: 'Nenhuma conversa salva nesta conta ainda' }]
      : list.map((sn) => ({
          label: sn.title || 'Sem título',
          hint: fmtWhen(sn.lastModified),
          selected: sn.current,
          disabled: sn.current,
          onPick: () => send({ type: 'resumeSession', id: sn.id }),
        }));
  refillMenu(histBtn, [{ title: 'Conversas anteriores', items }]);
}

function renderControls(): void {
  const title = state.companion ? `Consulta · ${state.companion.mainTitle}` : state.sessionTitle || (state.forkOf ? `Continuação · ${state.forkOf}` : 'Nova conversa');
  fill(
    acct,
    h('span', { class: 'acct-title', title }, title),
    h('span', { class: 'acct-name' }, state.provider === 'codex' ? `Codex · ${state.profileName}` : state.profileName),
    state.account ? h('span', { class: 'acct-mail' }, state.account) : null,
    state.resolvedModel ? h('span', { class: 'acct-model', title: state.resolvedModel }, modelLabel(state.resolvedModel)) : null,
  );
  renderUsageBar();
  renderClock();
  renderModelPill();
  renderModePill();
  renderAgentsPill();
  renderBrowserPill();
  renderSend();
  workingDot.classList.toggle('hidden', !state.busy);
  renderActivity();
}

function renderModelPill(): void {
  const named = state.resolvedModel ? modelLabel(state.resolvedModel) : (state.models.find((m) => m.value === state.model)?.displayName ?? 'Modelo padrão');
  const eff = EFFORT_SHORT[state.effort] ?? state.effort;
  fill(modelPill, h('span', {}, named), eff ? h('span', { class: 'dim' }, eff) : null);
  modelPill.title = `Modelo: ${named}\nRaciocínio: ${eff || 'padrão'}\nClique para trocar.`;
}

function renderModePill(): void {
  const mode = state.mode || 'default';
  fill(modePill, icon(MODE_ICON[mode] ?? 'shield'), h('span', {}, MODE_SHORT[mode] ?? mode));
  // A barra fica toda no mesmo cinza, como no Claude Code oficial. O risco do bypass é dito por
  // escrito no title e na descrição do menu; colorir a pílula de âmbar só tirava o sossego da barra.
  modePill.title = `${MODE_SHORT[mode] ?? mode}: ${MODE_HELP[mode] ?? ''}`;
}

/** "conectando…", "conectado", "desconectado": estado da ponte e da última chamada ao navegador. */
function browserStateText(): string {
  const st = state.browser.status.status;
  return st === 'pending' ? 'conectando…' : st === 'connected' ? 'conectado' : st === 'disconnected' ? 'desconectado' : st === 'off' ? 'desligado' : 'falhou';
}

/** Uma linha por navegador conectado: "Browser 1 · Linux · outra máquina". */
function browserLines(): string[] {
  const b = state.browser;
  if (b.browsersError) {
    return [`Não consegui listar os navegadores: ${b.browsersError}`];
  }
  if (!b.browsers) {
    return ['Lendo os navegadores conectados…'];
  }
  if (!b.browsers.length) {
    return ['Nenhum navegador conectado. Abra o Chrome com a extensão Claude in Chrome (claude.ai/chrome).'];
  }
  return b.browsers.map((x) => [x.name, x.osPlatform, x.isLocal === undefined ? '' : x.isLocal ? 'nesta máquina' : 'outra máquina'].filter(Boolean).join(' · '));
}

/**
 * Indicador do navegador no composer: aparece com o interruptor ligado ou com um agente desta conversa usando o
 * navegador. Tooltip com o estado e os navegadores conectados; o clique abre o menu com eles e o botão de desligar.
 */
function renderBrowserPill(): void {
  const b = state.browser;
  const agentOwner = b.owner && b.owner.id !== 'main' && b.owner.id !== 'other' ? b.owner : undefined;
  const show = state.provider === 'claude' && (b.on || !!agentOwner);
  browserPill.classList.toggle('hidden', !show);
  if (!show) {
    return;
  }
  const st = b.on ? b.status.status : 'connected';
  const label = b.on ? browserStateText() : `${agentOwner!.id} no navegador`;
  fill(browserPill, icon('browser'), h('span', { class: `bstate ${st}` }), h('span', {}, label));
  browserPill.classList.toggle('warn', b.on && (st === 'disconnected' || st === 'failed'));
  browserPill.title = [
    b.on ? `Claude in Chrome ligado nesta conversa: ${browserStateText()}.` : `O navegador está com o ${agentOwner!.label}.`,
    b.status.error ? b.status.error.slice(0, 200) : '',
    '',
    'Navegadores conectados:',
    ...browserLines().map((l) => `• ${l}`),
    '',
    'Clique para ver os detalhes ou desligar.',
  ]
    .filter((l, i, arr) => l || arr[i - 1])
    .join('\n');
}

function openBrowserMenu(anchor: HTMLElement): void {
  const b = state.browser;
  const items: MenuItem[] = browserLines().map((l) => ({ icon: 'browser', label: l }));
  items.push({ icon: 'refresh', label: 'Ler de novo', keepOpen: false, onPick: () => send({ type: 'refreshBrowsers' }) });
  const control: MenuItem[] = b.on
    ? [{ icon: 'debug-disconnect', label: 'Desligar o navegador nesta conversa', onPick: () => send({ type: 'setChrome', value: false }) }]
    : [];
  openMenu(anchor, [
    {
      title: b.on ? `Claude in Chrome · ${browserStateText()}` : `Navegador com o ${b.owner?.label ?? '?'}`,
      items,
      note: 'O Claude trabalha num grupo de abas próprio e não vê as abas que você já tem abertas. Cliques, digitação e endereços novos pedem sua aprovação.',
    },
    ...(control.length ? [{ items: control }] : []),
  ]);
}

/**
 * Rodapé abaixo do composer: "372k em contexto" à esquerda e as barrinhas de 5h e semana à direita,
 * com a mesma leitura (lastUsage) que alimenta a pílula do relógio.
 */
function renderUsageBar(): void {
  const n = state.contextTokens;
  const u = lastUsage;
  const ctx = n ? h('span', { class: 'usage-ctx' }, `${shortTokens(n)} em contexto`) : null;
  const lines = n ? [`${n.toLocaleString('pt-BR')} tokens em contexto nesta conversa`, ''] : [];
  if (!u?.available) {
    fill(usageBar, ctx, h('span', { class: 'usage-spacer' }), h('span', { class: 'usage-off' }, 'limites indisponíveis'));
    lines.push(u?.error ?? 'Os limites chegam com a primeira resposta desta conta.', '', 'Clique para tentar de novo.');
    usageBar.title = lines.join('\n');
    return;
  }
  const claudeWins = [
    { key: 'five_hour', short: '5h' },
    { key: 'seven_day', short: 'semana' },
  ].flatMap(({ key, short }) => {
    const w = u.windows.find((x) => x.key === key);
    return w ? [{ w, short }] : [];
  });
  // O Codex não usa as chaves do Claude: mostra as janelas que ele informou ("Mês", "Semana"...), no máximo duas.
  const shown = claudeWins.length
    ? claudeWins
    : u.windows.slice(0, 2).map((w) => ({ w, short: w.label === 'Sessão (5h)' ? '5h' : w.label.toLowerCase() }));
  fill(
    usageBar,
    ctx,
    h('span', { class: 'usage-spacer' }),
    ...shown.map(({ w, short }) => {
      const pct = Math.max(0, Math.min(100, w.utilization));
      const fillEl = h('span', { class: `usage-fill ${level(pct)}` });
      fillEl.style.width = `${pct}%`;
      return h('span', { class: 'usage-win' }, h('span', {}, short), h('span', { class: 'usage-track' }, fillEl), h('span', {}, `${Math.round(pct)}%`));
    }),
  );
  if (u.subscription) {
    lines.push(`Plano ${u.subscription}`);
  }
  for (const w of u.windows) {
    lines.push(`${w.label}: ${Math.round(w.utilization)}% usado, ${Math.round(100 - w.utilization)}% livre${w.resetsAt ? ` · zera ${fmtReset(w.resetsAt)}` : ''}`);
  }
  lines.push('', `Lido às ${fmtClock(u.fetchedAt)}. Clique para atualizar.`);
  usageBar.title = lines.join('\n');
}

function renderSend(): void {
  fill(sendBtn, icon(state.busy ? 'stop-circle' : 'arrow-up'));
  sendBtn.classList.toggle('stopping', state.busy);
  sendBtn.disabled = !state.busy && !input.value.trim() && !pending.length;
  sendBtn.title = state.busy ? `Parar o ${brand()}` : 'Enviar';
  sendBtn.setAttribute('aria-label', sendBtn.title);
}

function renderActivity(): void {
  const show = state.busy || state.thinking;
  activity.classList.toggle('hidden', !show);
  activity.replaceChildren(h('span', { class: 'spinner' }), state.thinking ? 'Pensando…' : 'Trabalhando…');
}

function renderForkBanner(): void {
  if (!state.forkOf) {
    forkBanner.classList.add('hidden');
    return;
  }
  forkBanner.classList.remove('hidden');
  forkBanner.replaceChildren(
    h('span', {}, `Continuação do agente "${state.forkOf}"`),
    h('div', { class: 'spacer' }),
    h('button', { class: 'icon-btn', onclick: () => send({ type: 'sendToParent' }) }, 'Enviar última resposta ao chat principal'),
  );
}

/** Tudo que depende da lista de agentes: a pílula do composer, a faixa de execução e o tique. */
function renderAgents(): void {
  renderAgentsPill();
  renderRunBar();
  syncTicker();
}

function renderAgentsPill(): void {
  const list = [...agents.values()];
  const running = list.filter((a) => a.status === 'running').length;
  const waiting = list.filter((a) => a.status === 'waiting').length;
  agentsPill.classList.toggle('hidden', !list.length);
  if (!list.length) {
    return;
  }
  const tone = running ? 'running' : waiting ? 'waiting' : list.some((a) => a.status === 'failed') ? 'failed' : 'completed';
  const waitText = waiting ? ` · ${waiting} aguardando` : '';
  fill(
    agentsPill,
    h('span', { class: `dot ${tone}` }),
    h('span', {}, running ? `${running} de ${list.length} trabalhando${waitText}` : waiting ? `${waiting} de ${list.length} aguardando` : `${list.length} ${list.length === 1 ? 'agente' : 'agentes'}`),
  );
  agentsPill.title = running || waiting
    ? `${running} de ${list.length} ainda trabalhando${waiting ? `, ${waiting} aguardando processo, subagentes ou resposta` : ''}. Clique para abrir o mapa de agentes.`
    : `${list.length} ${list.length === 1 ? 'agente' : 'agentes'} nesta conversa. Clique para abrir o mapa.`;
}

/** No máximo três linhas na faixa; o resto vira uma contagem. */
const RUN_LIMIT = 3;

function renderRunBar(): void {
  const running = [...agents.values()].filter((a) => a.status === 'running');
  // A faixa aparece e some entre o log e o composer: quem estava no fim da conversa continua no fim.
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 160;
  runBar.classList.toggle('hidden', !running.length);
  fill(
    runBar,
    ...running.slice(0, RUN_LIMIT).map((a) =>
      h(
        'div',
        { class: 'run-line', 'data-agent': a.id, title: `Abrir o painel de ${a.description || a.id}` },
        agentDot(a),
        h('span', { class: 'run-title' }, a.description || a.id),
        clockCell(a, 'run-time'),
        a.lastTool ? h('span', { class: 'run-tool' }, a.lastTool) : null,
      ),
    ),
    running.length > RUN_LIMIT ? h('div', { class: 'run-more' }, `+${running.length - RUN_LIMIT} outros`) : null,
  );
  if (stick) {
    log.scrollTop = log.scrollHeight;
  }
}

// ---------- Relógio dos agentes ----------

/**
 * O host manda `durationMs` a cada poucos segundos; entre uma mensagem e outra o número ficaria parado.
 * Guardamos a última verdade e o instante em que ela chegou, e mostramos base + tempo decorrido.
 */
const liveClock = new Map<string, { base: number; at: number }>();
/** Nós de texto do tempo que o tique reescreve. Só o texto muda: nada de remontar cartão ou mexer no scroll. */
const clockCells = new Set<HTMLElement>();
/** "a cada 5 min · próxima em 3m" de cada vigia, reescrito pelo mesmo tique. */
const watchCells = new Set<HTMLElement>();
/** Última contagem regressiva desenhada no grafo; muda no máximo uma vez por segundo. */
let graphWatchSig = '';
let ticker: number | undefined;

/**
 * Ponto de estado de um agente, em duas camadas: o miolo é a cor da frente de trabalho
 * (escolhida pelo orquestrador) e o anel em volta é o estado. Verde pulsando enquanto roda,
 * vermelho contínuo quando parou ou falhou, sem anel quando terminou bem.
 */
function agentDot(a: AgentInfo): HTMLSpanElement {
  // Âmbar forte quando o guarda acha que o agente está preso; âmbar claro quando ele aguarda: os mesmos anéis do nó no grafo.
  const ring = a.status === 'running' ? (a.stuck ? STUCK_RING : STATUS_RING.running) : a.status === 'waiting' ? STATUS_RING.waiting : a.status === 'failed' || a.status === 'stopped' ? STATUS_RING.halted : '';
  const el = h('span', { class: `agdot${ring ? ' ring' : ''}${a.status === 'running' ? ' live' : ''}`, 'aria-hidden': 'true' });
  el.style.setProperty('--agm-color', agentColor(a.color, a.id));
  if (ring) {
    el.style.setProperty('--agm-ring', ring);
  }
  return el;
}

/** Borda esquerda do cartão (e filete do painel) na cor da frente de trabalho. */
function paintAgent(el: HTMLElement, a: AgentInfo): void {
  el.style.setProperty('--agm-color', agentColor(a.color, a.id));
}

function liveDuration(a: AgentInfo): number {
  const live = a.status === 'running' ? liveClock.get(a.id) : undefined;
  return live ? live.base + (performance.now() - live.at) : a.durationMs;
}

/** Notícia nova do host: rebase nos dois valores. O `max` impede o número de andar para trás. */
function rebaseClock(a: AgentInfo): void {
  if (a.status !== 'running') {
    liveClock.delete(a.id);
    return;
  }
  const prev = liveClock.get(a.id);
  const shown = prev ? prev.base + (performance.now() - prev.at) : 0;
  liveClock.set(a.id, { base: Math.max(a.durationMs, shown), at: performance.now() });
}

/** Célula de tempo registrada no tique. Agente parado mostra o tempo final e não entra no conjunto. */
function clockCell(a: AgentInfo, cls: string): HTMLElement {
  const el = h('span', { class: cls }, fmtDuration(liveDuration(a)));
  if (a.status === 'running') {
    el.dataset.agent = a.id;
    clockCells.add(el);
  }
  return el;
}

function tick(): void {
  for (const el of clockCells) {
    // Cartão remontado ou log limpo: o nó velho sai do conjunto em vez de acumular.
    if (!el.isConnected) {
      clockCells.delete(el);
      continue;
    }
    const a = agents.get(el.dataset.agent ?? '');
    if (!a || a.status !== 'running') {
      continue;
    }
    const text = fmtDuration(liveDuration(a));
    if (el.textContent !== text) {
      el.textContent = text;
    }
  }
  const now = Date.now();
  for (const el of watchCells) {
    if (!el.isConnected) {
      watchCells.delete(el);
      continue;
    }
    const a = agents.get(el.dataset.agent ?? '');
    const text = a ? watchLabel(a, now) : '';
    if (el.textContent !== text) {
      el.textContent = text;
    }
  }
  // O grafo escreve a contagem no próprio nó; só redesenha quando algum rótulo mudou.
  const sig = [...agents.values()].map((a) => watchLabel(a, now)).join('|');
  if (sig !== graphWatchSig) {
    graphWatchSig = sig;
    if (!overlay.classList.contains('hidden') && !detailId) {
      updateGraph();
    }
  }
  // O popup do nó tem o seu próprio nó de tempo; o mesmo tique escreve nele.
  popup.tick();
}

/** Célula da contagem de um vigia, registrada no tique. */
function watchCell(a: AgentInfo, cls: string): HTMLElement {
  const el = h('span', { class: cls }, watchLabel(a, Date.now()));
  el.dataset.agent = a.id;
  watchCells.add(el);
  return el;
}

/** Vigia com a recorrência ligada: pode parar mesmo entre verificações, quando não está rodando. */
function watching(a: AgentInfo): boolean {
  return !!a.repeatEveryMinutes && (!!a.nextCheckAt || (a.status === 'running' && !a.restored));
}

/** Um intervalo só na página, e só enquanto existe agente rodando ou vigia esperando a próxima verificação. */
function syncTicker(): void {
  const running = [...agents.values()].some((a) => a.status === 'running' || !!a.nextCheckAt);
  if (running && ticker === undefined) {
    ticker = window.setInterval(tick, 1000);
  } else if (!running && ticker !== undefined) {
    window.clearInterval(ticker);
    ticker = undefined;
  }
}

// ---------- Mensagens da conversa ----------

function scrollDown(force = false): void {
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 160;
  if (force || nearBottom) {
    log.scrollTop = log.scrollHeight;
  }
}

function append(el: HTMLElement, container: HTMLElement = log): void {
  empty.remove();
  container.append(el);
  if (container === log) {
    scrollDown();
  }
}

// ---------- Decisões pendentes ----------

/**
 * Tudo o que espera um clique do usuário, venha de onde vier: permissão, tarefa externa, alerta do guarda.
 * O cartão continua no log; a pílula do composer conta e lista, para nada se perder no meio da rolagem.
 */
interface PendingDecision {
  el: HTMLElement;
  label: string;
  detail: string;
  icon: string;
  agentId?: string;
}
const pendingDecisions = new Map<string, PendingDecision>();

function setPending(key: string, info: PendingDecision | null): void {
  const agentId = info?.agentId ?? pendingDecisions.get(key)?.agentId;
  if (info) {
    pendingDecisions.set(key, info);
  } else {
    pendingDecisions.delete(key);
  }
  renderPendingPill();
  // Decisão de um agente numa caixa recolhida: a caixa abre (ou volta a fechar quando a decisão sai).
  if (agentId && boxes.length && !overlay.classList.contains('hidden') && !detailId) {
    updateGraph();
  }
}

function renderPendingPill(): void {
  const n = pendingDecisions.size;
  pendingPill.classList.toggle('hidden', !n);
  fill(pendingPill, icon('bell-dot'), h('span', {}, n === 1 ? '1 decisão' : `${n} decisões`));
  pendingPill.title = n === 1 ? 'Uma decisão espera você. Clique para ver.' : `${n} decisões esperam você. Clique para ver.`;
  pendingPill.setAttribute('aria-label', pendingPill.title);
  if (openAt?.anchor === pendingPill) {
    if (n) {
      refillMenu(pendingPill, pendingSections());
    } else {
      closeMenu();
    }
  }
}

/** Leva ao cartão no log e põe o foco no primeiro botão dele. */
function jumpToCard(el: HTMLElement): void {
  if (!el.isConnected) {
    return;
  }
  if (!overlay.classList.contains('hidden')) {
    closeMap();
  }
  el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  el.querySelector<HTMLElement>('button:not(:disabled), input, textarea')?.focus({ preventScroll: true });
}

function pendingSections(): MenuSection[] {
  return [
    {
      title: 'Esperando você',
      items: [...pendingDecisions.values()].map((d) => ({
        label: d.label,
        detail: d.detail,
        icon: d.icon,
        hint: d.agentId,
        onPick: () => jumpToCard(d.el),
      })),
      note: 'Clique para ir ao cartão.',
    },
  ];
}

function openPendingMenu(anchor: HTMLElement): void {
  openMenu(anchor, pendingSections());
}

/** Cartões do guarda: orçamento esgotado e agente possivelmente preso. */
const guardCards = createGuardCards({
  send,
  append: (el) => append(el),
  colorOf: (id) => agentColor(agents.get(id)?.color, id),
  agentName: (id) => agents.get(id)?.description,
  onPending: (id, el, label, detail, agentId) => setPending(`guard:${id}`, el ? { el, label, detail, icon: 'warning', agentId } : null),
});

function addUser(text: string, from?: string, container: HTMLElement = log, atts: Attachment[] = [], fromId?: string, origin?: 'companion'): void {
  // No histórico, a mensagem do "Enviar ao principal" chega com a marca na primeira linha.
  if (!from && text.startsWith(COMPANION_MARK)) {
    text = text.slice(COMPANION_MARK.length).trim();
    origin = 'companion';
  }
  // Relatório entregue por um agente: uma linha só, que abre quando o usuário quer ler.
  if (from) {
    const body = h('div', { class: 'md' });
    md(body, text);
    const card = h('details', { class: 'msg report' });
    // Com o id do agente, a linha usa a cor dele (a mesma do cartão e do nó) e o nome abre o popup do nó.
    const info = fromId ? agents.get(fromId) : undefined;
    let who: Node | string = `Relatório de ${whoLabel(from)}`;
    if (fromId) {
      card.classList.add('has-agent');
      card.dataset.agent = fromId;
      card.style.setProperty('--agent', agentColor(info?.color, fromId));
      const name = h(
        'button',
        {
          class: 'report-agent',
          type: 'button',
          title: `Abre o resumo de ${fromId}`,
          onclick: (e: Event) => {
            // Dentro do <summary>: sem isso o clique também abriria e fecharia o relatório.
            e.preventDefault();
            e.stopPropagation();
            openCardPopup(card, fromId, false);
          },
        },
        info?.description || fromId,
      );
      who = h('span', {}, 'Relatório: ', name);
    }
    card.append(
      h(
        'summary',
        {},
        fromId ? h('span', { class: 'agent-dot', 'aria-hidden': 'true' }) : icon('inbox'),
        h('span', { class: 'from' }, who),
        h('span', { class: 'fold-more' }, 'ver'),
        h('span', { class: 'fold-less' }, 'recolher'),
      ),
      body,
    );
    append(card, container);
    if (container === log) {
      scrollDown(true);
    }
    return;
  }
  const bubble = h('div', { class: 'msg user' });
  if (origin === 'companion') {
    bubble.classList.add('from-companion');
    bubble.append(h('div', { class: 'msg-origin', title: 'Você enviou esta resposta do chat lateral de consulta' }, icon(COMPANION_ICON), 'da consulta lateral'));
  }
  {
    if (atts.length) {
      bubble.append(h('div', { class: 'atts sent' }, ...atts.map((a) => attChip(a))));
    }
    if (text) {
      bubble.append(h('div', { class: 'plain' }, text));
    }
  }
  append(bubble, container);
  if (container === log) {
    scrollDown(true);
  }
}

// Blocos de texto em streaming: chave msgId:index. O texto final (assistantText) substitui o parcial.
const liveBlocks = new Map<string, { el: HTMLElement; text: string; msgId: string; final: boolean }>();
let renderQueued = new Set<string>();

function onTextDelta(msgId: string, index: number, text: string): void {
  const key = `${msgId}:${index}`;
  let block = liveBlocks.get(key);
  if (!block) {
    block = { el: h('div', { class: 'msg assistant md' }), text: '', msgId, final: false };
    liveBlocks.set(key, block);
    append(block.el);
  }
  block.text += text;
  renderQueued.add(key);
  if (renderQueued.size === 1) {
    requestAnimationFrame(() => {
      for (const k of renderQueued) {
        const b = liveBlocks.get(k);
        if (b && !b.final) {
          md(b.el, b.text);
        }
      }
      renderQueued = new Set();
      scrollDown();
    });
  }
}

function onAssistantText(msgId: string, text: string): void {
  for (const block of liveBlocks.values()) {
    if (block.msgId === msgId && !block.final) {
      block.final = true;
      md(block.el, text);
      companionUi?.markRaw(block.el, text);
      scrollDown();
      return;
    }
  }
  if (!text.trim()) {
    return;
  }
  const el = h('div', { class: 'msg assistant md' });
  md(el, text);
  companionUi?.markRaw(el, text);
  append(el);
}

// ---------- Ferramentas ----------

interface ToolView {
  el: HTMLDetailsElement;
  head: HTMLElement;
  body: HTMLElement;
}
// Um mapa por container: a conversa principal e cada painel de agente renderizam as próprias linhas de ferramenta.
const toolMaps = new WeakMap<HTMLElement, Map<string, ToolView>>();
function toolsIn(container: HTMLElement): Map<string, ToolView> {
  let map = toolMaps.get(container);
  if (!map) {
    map = new Map();
    toolMaps.set(container, map);
  }
  return map;
}

/** Ferramentas de leitura do chat lateral, com nome de gente no log. */
const COMPANION_TOOL_LABEL: Record<string, string> = {
  list_agents: 'Lista os agentes',
  agent_activity: 'Atividade do agente',
  agent_report: 'Relatório do agente',
  main_recent: 'Conversa principal',
  lab_board: 'Quadro do laboratório',
  worktree_status: 'Worktree do agente',
  searches: 'Buscas',
  jobs: 'Jobs',
};

function toolLabel(name: string): string {
  if (name === RESEARCH_TOOL) {
    return 'Pesquisa na web';
  }
  if (name === IMAGE_TOOL) {
    return 'Gerar imagem';
  }
  if (isBrowserTool(name)) {
    return 'Navegador';
  }
  const own = /^mcp__companion__(.+)$/.exec(name);
  if (own) {
    return COMPANION_TOOL_LABEL[own[1]] ?? `Consulta · ${own[1]}`;
  }
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]} · ${m[2]}` : name;
}

function shortPath(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const cwd = state.cwd.replace(/\\/g, '/');
  return cwd && norm.toLowerCase().startsWith(cwd.toLowerCase()) ? norm.slice(cwd.length).replace(/^\//, '') : norm;
}

function summarize(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return str(i.description) || str(i.command);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return shortPath(str(i.file_path) || str(i.notebook_path));
    case 'Grep':
      return `${str(i.pattern)}${i.path ? ` em ${shortPath(str(i.path))}` : ''}`;
    case 'Glob':
      return str(i.pattern);
    case 'WebFetch':
      return str(i.url);
    case 'WebSearch':
      return str(i.query);
    case 'Agent':
    case 'Task':
      return str(i.description);
    case 'TodoWrite':
      return `${Array.isArray(i.todos) ? i.todos.length : 0} tarefas`;
    case 'mcp__agents__spawn_agent':
      return `${str(i.description)}${i.report_to ? ` → relatório para ${str(i.report_to)}` : ''}`;
    case 'mcp__agents__send_to_agent':
    case 'mcp__agents__stop_agent':
      return str(i.agent_id);
    case RESEARCH_TOOL:
      return `${providerName(i.provider ?? state.external.research)} · ${str(i.prompt)}`;
    case IMAGE_TOOL:
      return `${providerName(i.provider ?? state.external.image)} · ${str(i.prompt)}${i.save_to ? ` → ${str(i.save_to)}` : ''}`;
  }
  if (isBrowserTool(name)) {
    return describeBrowserAction(name, input);
  }
  const first = Object.values(i).find((v) => typeof v === 'string');
  return typeof first === 'string' ? first.slice(0, 120) : '';
}

function toolDetail(name: string, input: unknown): HTMLElement {
  const i = (input ?? {}) as Record<string, unknown>;
  if ((name === 'Bash' || name === 'PowerShell') && typeof i.command === 'string') {
    return h('pre', { class: 'code' }, i.command);
  }
  if (name === 'Edit' && typeof i.old_string === 'string') {
    return diff(String(i.old_string), String(i.new_string ?? ''));
  }
  if (name === 'MultiEdit' && Array.isArray(i.edits)) {
    return h('div', {}, ...i.edits.map((e: { old_string?: string; new_string?: string }) => diff(e.old_string ?? '', e.new_string ?? '')));
  }
  if (name === 'Write' && typeof i.content === 'string') {
    const lines = i.content.split('\n');
    return h('pre', { class: 'code add' }, lines.slice(0, 80).join('\n') + (lines.length > 80 ? `\n… (+${lines.length - 80} linhas)` : ''));
  }
  if (name === 'TodoWrite' && Array.isArray(i.todos)) {
    return h(
      'ul',
      { class: 'todos' },
      ...i.todos.map((t: { content?: string; status?: string }) =>
        h('li', { class: `todo ${t.status ?? ''}` }, t.status === 'completed' ? '☑ ' : t.status === 'in_progress' ? '◐ ' : '☐ ', t.content ?? ''),
      ),
    );
  }
  if ((name === 'Agent' || name === 'Task' || name === 'mcp__agents__spawn_agent') && typeof i.prompt === 'string') {
    const el = h('div', { class: 'md prompt' });
    md(el, i.prompt);
    return el;
  }
  return h('pre', { class: 'code' }, JSON.stringify(input, null, 2));
}

function diff(oldText: string, newText: string): HTMLElement {
  const pre = h('pre', { class: 'code diff' });
  for (const line of oldText.split('\n')) {
    pre.append(h('div', { class: 'del' }, `- ${line}`));
  }
  for (const line of newText.split('\n')) {
    pre.append(h('div', { class: 'add' }, `+ ${line}`));
  }
  return pre;
}

function createTool(id: string, name: string, container: HTMLElement = log): ToolView {
  const browser = isBrowserTool(name);
  const head = h(
    'summary',
    {},
    h('span', { class: 'dot running' }),
    browser ? h('span', { class: 'tico', 'aria-hidden': 'true' }, icon('browser')) : null,
    h('span', { class: 'tname' }, toolLabel(name)),
    h('span', { class: 'tsum' }),
  );
  const body = h('div', { class: 'tbody' });
  // No log principal a linha de ferramenta é discreta: o detalhe continua a um clique.
  const el = h('details', { class: `${container === log ? 'tool slim' : 'tool'}${browser ? ' browser' : ''}` }, head, body);
  el.dataset.tool = name;
  const view = { el, head, body };
  toolsIn(container).set(id, view);
  append(el, container);
  return view;
}

function onToolUse(id: string, name: string, input: unknown, container: HTMLElement = log): void {
  const view = toolsIn(container).get(id) ?? createTool(id, name, container);
  (view.head.querySelector('.tsum') as HTMLElement).textContent = summarize(name, input);
  view.body.replaceChildren(toolDetail(name, input));
}

function onToolResult(id: string, text: string, isError: boolean, container: HTMLElement = log, images?: string[]): void {
  const view = toolsIn(container).get(id);
  if (!view) {
    return;
  }
  if (images?.length && !view.el.nextElementSibling?.classList.contains('shots')) {
    view.el.after(shotRow(images));
    if (container === log) {
      scrollDown();
    }
  }
  const dot = view.head.querySelector('.dot') as HTMLElement;
  dot.className = `dot ${isError ? 'failed' : 'completed'}`;
  const clipped = text.length > 6000 ? `${text.slice(0, 6000)}\n… (${text.length - 6000} caracteres omitidos)` : text;
  if (clipped.trim()) {
    view.body.append(h('div', { class: 'tlabel' }, isError ? 'Erro' : 'Resultado'), h('pre', { class: `code out ${isError ? 'err' : ''}` }, clipped));
  }
  const tool = view.el.dataset.tool;
  if (isError || (tool !== RESEARCH_TOOL && tool !== IMAGE_TOOL) || view.el.nextElementSibling?.classList.contains('ext-block')) {
    return;
  }
  const block = tool === RESEARCH_TOOL ? researchBlock(text) : imageBlock(text);
  if (block) {
    view.el.after(block);
    if (container === log) {
      scrollDown();
    }
  }
}

/** Miniaturas das imagens de um resultado (capturas do navegador). O clique amplia na própria página. */
function shotRow(images: string[]): HTMLElement {
  return h(
    'div',
    { class: 'shots' },
    ...images.map((src, i) =>
      h(
        'button',
        { class: 'shot', type: 'button', title: 'Ampliar a captura', 'aria-label': `Ampliar a captura ${i + 1}`, onclick: () => openShot(src) },
        h('img', { src, alt: `Captura ${i + 1}`, loading: 'lazy' }),
      ),
    ),
  );
}

function openShot(src: string): void {
  shotView.replaceChildren(h('img', { src, alt: 'Captura de tela' }), h('div', { class: 'shot-hint' }, 'Clique ou Esc para fechar'));
  shotView.classList.remove('hidden');
}

function closeShot(): boolean {
  if (shotView.classList.contains('hidden')) {
    return false;
  }
  shotView.classList.add('hidden');
  shotView.replaceChildren();
  return true;
}

/**
 * Resultado do web_research como bloco recolhível: texto em markdown e fontes como links. O formato vem de
 * formatResearch (src/chat/external/index.ts): cabeçalho, texto entre <conteudo_externo>, depois "Fontes:".
 */
function researchBlock(text: string): HTMLElement | null {
  const open = text.indexOf('<conteudo_externo');
  const close = text.indexOf('</conteudo_externo>');
  if (open < 0 || close < open) {
    return null;
  }
  const header = text.slice(0, open).trim();
  const inner = text.slice(text.indexOf('>', open) + 1, close).trim();
  // A primeira linha de dentro é o aviso para o modelo; o usuário não precisa dela.
  const bodyText = inner.replace(/^Conteúdo trazido da web[^\n]*\n?/, '').trim();
  const sources = [...text.slice(close).matchAll(/^- \[([^\]]*)\]\((https?:\/\/[^)\s]+)\)$/gm)].map((m) => ({ title: m[1], url: m[2] }));
  const who = /pelo (\w+) \(([^)]*)\)/.exec(header);
  const body = h('div', { class: 'md' });
  md(body, bodyText);
  const list = sources.length
    ? h(
        'ol',
        { class: 'ext-sources' },
        ...sources.map((s) => h('li', {}, h('a', { href: s.url, title: s.url }, s.title || s.url), h('span', { class: 'ext-host' }, hostName(s.url)))),
      )
    : null;
  return h(
    'details',
    { class: 'msg ext-block ext-research' },
    h(
      'summary',
      {},
      icon('globe'),
      h('span', { class: 'ext-title' }, `Pesquisa do ${who?.[1] ?? 'provedor externo'}`),
      h('span', { class: 'ext-meta' }, [sources.length ? `${sources.length} ${sources.length === 1 ? 'fonte' : 'fontes'}` : 'sem fontes', who?.[2]].filter(Boolean).join(' · ')),
      h('span', { class: 'fold-more' }, 'ver'),
      h('span', { class: 'fold-less' }, 'recolher'),
    ),
    body,
    list ? h('div', { class: 'tlabel' }, 'Fontes') : null,
    list,
  );
}

function hostName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Resultado do generate_image: miniatura de cada arquivo salvo; o clique abre o arquivo no editor. */
function imageBlock(text: string): HTMLElement | null {
  const files = [...text.matchAll(/^- (.+?\.(?:png|jpe?g|webp))(?: \((\d+x\d+)\))?$/gim)].map((m) => ({ rel: m[1], size: m[2] }));
  if (!files.length) {
    return null;
  }
  const who = /pelo (\w+) \(/.exec(text);
  return h(
    'div',
    { class: 'msg ext-block ext-images' },
    h('div', { class: 'ext-images-head' }, icon('file-media'), h('span', { class: 'ext-title' }, `${files.length > 1 ? 'Imagens' : 'Imagem'} do ${who?.[1] ?? 'provedor externo'}`)),
    h(
      'div',
      { class: 'ext-thumbs' },
      ...files.map((f) =>
        h(
          'button',
          { class: 'ext-thumb', type: 'button', title: `Abrir ${f.rel} no editor`, onclick: () => send({ type: 'openFile', path: f.rel }) },
          state.cwdUri ? h('img', { src: `${state.cwdUri.replace(/\/$/, '')}/${f.rel.split('/').map(encodeURIComponent).join('/')}`, alt: f.rel, loading: 'lazy' }) : null,
          h('span', { class: 'ext-path' }, f.rel, f.size ? h('span', { class: 'ext-dim' }, ` · ${f.size}`) : null),
        ),
      ),
    ),
  );
}

/**
 * Avisos informativos em sequência (instalando, instalado, job submetido...) viram uma linha só: o mais recente
 * à vista e um contador; o clique abre a lista inteira. Erro e aviso com botão ficam sempre sozinhos.
 */
function addNotice(text: string, level: 'info' | 'error', action?: NoticeAction): void {
  const last = log.lastElementChild as HTMLElement | null;
  if (level === 'info' && !action && last) {
    if (last.classList.contains('sys-group')) {
      pushSysLine(last as HTMLDetailsElement, text);
      scrollDown();
      return;
    }
    if (last.matches('.notice.info:not(.sys-group)') && !last.querySelector('button')) {
      const group = h('details', { class: 'notice info sys-group' }, h('summary', {}, icon('info'), h('span', { class: 'sys-last' }), h('span', { class: 'sys-count' })), h('div', { class: 'sys-list' }));
      last.replaceWith(group);
      pushSysLine(group, last.textContent ?? '');
      pushSysLine(group, text);
      scrollDown();
      return;
    }
  }
  const el = h('div', { class: `notice ${level}` }, text);
  if (action?.kind === 'configureKey') {
    el.append(h('button', { class: 'notice-action', type: 'button', onclick: () => send({ type: 'configureKey', provider: action.provider }) }, icon('key'), action.label));
  }
  append(el);
}

function pushSysLine(group: HTMLDetailsElement, text: string): void {
  const list = group.querySelector('.sys-list')!;
  list.append(h('div', { class: 'sys-line' }, text));
  group.querySelector('.sys-last')!.textContent = text;
  const n = list.childElementCount;
  group.querySelector('.sys-count')!.textContent = `${n} avisos`;
  group.querySelector('summary')!.title = `${n} avisos do sistema. Clique para ver todos.`;
}

function addResult(msg: Extract<HostMessage, { type: 'result' }>): void {
  const parts = [fmtDuration(msg.durationMs), `${fmtTokens(msg.inputTokens)} entrada`, `${fmtTokens(msg.outputTokens)} saída`];
  if (msg.isError) {
    parts.unshift(`erro${msg.text ? `: ${msg.text}` : ''}`);
  }
  append(h('div', { class: `result ${msg.isError ? 'error' : ''}` }, parts.join(' · ')));
}

function renderHistory(items: HistoryItem[], container: HTMLElement = log): void {
  for (const item of items) {
    renderItem(item, container);
  }
  if (container === log) {
    scrollDown(true);
  }
}

function renderItem(item: HistoryItem, container: HTMLElement): void {
  if (item.kind === 'user') {
    addUser(item.text, undefined, container);
  } else if (item.kind === 'text') {
    const el = h('div', { class: 'msg assistant md' });
    md(el, item.text);
    if (container === log) {
      companionUi?.markRaw(el, item.text);
    }
    append(el, container);
  } else if (item.kind === 'tool') {
    if (container === log && isOrchestration(item.name)) {
      hiddenTools.add(item.id);
      return;
    }
    onToolUse(item.id, item.name, item.input, container);
  } else {
    if (container === log && hiddenTools.has(item.id)) {
      return;
    }
    onToolResult(item.id, item.text, item.isError, container, item.images);
  }
}

function clearLog(): void {
  popup.close();
  log.replaceChildren(empty);
  liveBlocks.clear();
  toolsIn(log).clear();
  permissions.clear();
  agents.clear();
  boxes = [];
  agentItems.clear();
  agentCards.clear();
  taskCards.clear();
  pendingDecisions.clear();
  renderPendingPill();
  mapCards.clear();
  hiddenTools.clear();
  mapShape = '';
  pending.length = 0;
  renderPending();
  state.contextTokens = 0;
  liveClock.clear();
  clockCells.clear();
  renderAgents();
  renderControls();
}

// ---------- Permissões ----------

const permissions = new Map<string, HTMLElement>();

function onPermission(msg: Extract<HostMessage, { type: 'permission' }>): void {
  const { requestId, toolName, input } = msg;
  const answer = (decision: WebviewMessage) => send(decision);
  const card = h('div', { class: `perm decision${isBrowserTool(toolName) ? ' browser' : ''}`, role: 'group' });
  const kind = toolName === 'AskUserQuestion' ? 'Pergunta' : toolName === 'ExitPlanMode' ? 'Plano pronto' : isBrowserTool(toolName) ? 'Ação no navegador' : 'Permissão';
  const kindIcon = toolName === 'AskUserQuestion' ? 'question' : toolName === 'ExitPlanMode' ? 'checklist' : isBrowserTool(toolName) ? 'browser' : 'shield';
  // Pedido de um agente: o ponto na cor dele (a mesma do cartão e do nó) diz de quem é.
  const who = msg.agentId ? agents.get(msg.agentId) : undefined;
  if (msg.agentId) {
    card.classList.add('has-agent');
    card.style.setProperty('--agent', agentColor(who?.color, msg.agentId));
  }
  const whoText = msg.agentId ? (who?.description ?? msg.agentLabel ?? msg.agentId) : '';
  card.setAttribute('aria-label', `${kind}${whoText ? ` de ${whoText}` : ''}`);
  card.append(
    decisionHead(
      kindIcon,
      kind,
      msg.agentId ? h('span', { class: 'dec-who', title: `${whoText} (${msg.agentId})` }, h('span', { class: 'agent-dot', 'aria-hidden': 'true' }), h('span', { class: 'dec-who-name' }, whoText)) : null,
      new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
    ),
  );

  if (toolName === 'AskUserQuestion') {
    card.append(questionForm(requestId, input));
  } else if (toolName === 'ExitPlanMode') {
    card.append(h('div', { class: 'perm-title' }, 'O Claude terminou o plano'));
    const plan = h('div', { class: 'md plan' });
    md(plan, String(input.plan ?? ''));
    const feedback = h('textarea', { class: 'feedback', rows: '2', placeholder: 'O que mudar no plano?' });
    card.append(
      plan,
      h(
        'div',
        { class: 'perm-actions' },
        h('button', { class: 'primary', onclick: () => answer({ type: 'permission', requestId, decision: 'always' }) }, 'Aprovar e aceitar edições'),
        h('button', { onclick: () => answer({ type: 'permission', requestId, decision: 'allow' }) }, 'Aprovar e perguntar antes de editar'),
      ),
      feedback,
      h(
        'div',
        { class: 'perm-actions' },
        h('button', { onclick: () => answer({ type: 'permission', requestId, decision: 'deny', feedback: feedback.value || 'Continue planejando.' }) }, 'Continuar planejando'),
      ),
    );
  } else {
    card.append(
      ...([
        h('div', { class: 'perm-title' }, `${toolLabel(toolName)}`, h('span', { class: 'tsum' }, summarize(toolName, input))),
        msg.reason ? h('div', { class: 'perm-reason' }, msg.reason) : null,
        h('div', { class: 'perm-detail' }, toolDetail(toolName, input)),
      ].filter(Boolean) as HTMLElement[]),
    );
    const feedback = h('input', { class: 'feedback', placeholder: 'Ou diga ao Claude o que fazer diferente (Enter)' });
    feedback.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && feedback.value.trim()) {
        answer({ type: 'permission', requestId, decision: 'deny', feedback: feedback.value });
      }
    });
    card.append(
      h(
        'div',
        { class: 'perm-actions' },
        h('button', { class: 'primary', onclick: () => answer({ type: 'permission', requestId, decision: 'allow' }) }, 'Sim'),
        msg.canAlways
          ? h('button', { title: 'Permite e não pergunta de novo por esta ferramenta até o fim da sessão', onclick: () => answer({ type: 'permission', requestId, decision: 'always' }) }, 'Sempre nesta sessão')
          : null,
        h('button', { onclick: () => answer({ type: 'permission', requestId, decision: 'deny' }) }, 'Não'),
      ),
      feedback,
    );
  }
  permissions.set(requestId, card);
  setPending(`perm:${requestId}`, {
    el: card,
    label: toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode' ? kind : `${kind}: ${toolLabel(toolName)} ${summarize(toolName, input)}`.trim(),
    detail: whoText || 'conversa principal',
    icon: kindIcon,
    agentId: msg.agentId,
  });
  append(card);
  scrollDown(true);
}

/** Cabeçalho comum dos cartões que pedem decisão: ícone, o que é, de quem, e um detalhe cinza à direita. */
function decisionHead(iconName: string, title: string, who: Node | null, meta: string): HTMLElement {
  return h('div', { class: 'dec-head' }, icon(iconName), h('span', { class: 'dec-title' }, title), who, h('div', { class: 'spacer' }), meta ? h('span', { class: 'dec-meta' }, meta) : null);
}

interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: { label: string; description?: string }[];
}

function questionForm(requestId: string, input: Record<string, unknown>): HTMLElement {
  const questions = (Array.isArray(input.questions) ? input.questions : []) as Question[];
  const chosen = new Map<string, Set<string>>();
  const others = new Map<string, HTMLInputElement>();
  const form = h('div', { class: 'questions' });
  for (const q of questions) {
    chosen.set(q.question, new Set());
    const opts = h('div', { class: 'q-options' });
    for (const o of q.options ?? []) {
      const btn = h('button', { class: 'q-opt', title: o.description ?? '' }, h('b', {}, o.label), o.description ? h('span', {}, o.description) : null);
      btn.addEventListener('click', () => {
        const set = chosen.get(q.question)!;
        if (!q.multiSelect) {
          set.clear();
          opts.querySelectorAll('.q-opt').forEach((b) => b.classList.remove('on'));
        }
        if (set.has(o.label)) {
          set.delete(o.label);
          btn.classList.remove('on');
        } else {
          set.add(o.label);
          btn.classList.add('on');
        }
      });
      opts.append(btn);
    }
    const other = h('input', { class: 'feedback', placeholder: 'Outra resposta' });
    others.set(q.question, other);
    form.append(h('div', { class: 'q' }, q.header ? h('div', { class: 'q-head' }, q.header) : null, h('div', { class: 'q-text' }, q.question), opts, other));
  }
  form.append(
    h(
      'div',
      { class: 'perm-actions' },
      h(
        'button',
        {
          class: 'primary',
          onclick: () => {
            const answers: Record<string, string> = {};
            for (const q of questions) {
              const typed = others.get(q.question)?.value.trim();
              answers[q.question] = typed || [...chosen.get(q.question)!].join(', ');
            }
            send({ type: 'permission', requestId, decision: 'answer', updatedInput: { ...input, answers } });
          },
        },
        'Responder',
      ),
      h('button', { onclick: () => send({ type: 'permission', requestId, decision: 'deny' }) }, 'Pular'),
    ),
  );
  return form;
}

function closePermission(requestId: string): void {
  const card = permissions.get(requestId);
  setPending(`perm:${requestId}`, null);
  if (card) {
    card.classList.add('done');
    card.querySelectorAll('button, input, textarea').forEach((el) => ((el as HTMLButtonElement).disabled = true));
    permissions.delete(requestId);
    setTimeout(() => card.remove(), 300);
  }
}

// ---------- Mapa de agentes ----------

let detailId: string | undefined;
let detailLog: HTMLElement | undefined;

/*
 * O mapa tem duas vistas que se alternam no cabeçalho. O grafo é a principal e ocupa toda a altura;
 * a lista de cartões é a secundária. Alternar em vez de empilhar (grafo em cima, lista embaixo num
 * container só) evita o conflito da roda do mouse: sobre o grafo ela dá zoom, sobre a lista ela rola,
 * e empilhados o usuário ficaria preso no zoom tentando rolar até a lista.
 */
type MapMode = 'graph' | 'list' | 'lab';
let mapMode: MapMode = 'graph';

/** Caixas da conversa (create_box, spawn_agent com box, assign_box), como o host mandou por último. */
let boxes: BoxInfo[] = [];
/** O projeto tem cérebro compartilhado (.agm/brain/): o mapa mostra o botão "Cérebro". */
let brainReady = false;
/** Recolher/expandir escolhido pelo usuário. Vale para o grafo e para a lista, e sobrevive ao reload da aba. */
const boxFold: Record<string, boolean> = { ...(saved.boxFold ?? {}) };
/** Teto de escolhas guardadas: as mais antigas saem. */
const MAX_FOLDS = 300;

function foldKey(boxId: string): string {
  return `${state.sessionId || '-'}|${boxId}`;
}

function setFold(boxId: string, collapsed: boolean): void {
  const key = foldKey(boxId);
  delete boxFold[key];
  boxFold[key] = collapsed;
  const keys = Object.keys(boxFold);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_FOLDS))) {
    delete boxFold[k];
  }
  saveState();
}

/** Agente com decisão esperando o usuário: a caixa dele abre sozinha. */
function hasPendingDecision(agentId: string): boolean {
  for (const d of pendingDecisions.values()) {
    if (d.agentId === agentId) {
      return true;
    }
  }
  return false;
}

/** Container que rola a lista. Criado uma vez: trocá-lo a cada atualização jogaria o scroll para o topo. */
const mapScroll = h('div', { class: 'map' });
const mapHead = h('div', { class: 'map-head' });
/** Lugar do botão "Organizar em caixas", ao lado das vistas. */
const mapOrganize = h('div', { class: 'map-organize-slot' });
/** Lugar do botão "Cérebro", que só aparece depois que o cérebro existe. */
const mapBrain = h('div', { class: 'map-organize-slot' });
const mapBody = h('div', { class: 'map-body' });
mapScroll.append(mapBody);

function modeButton(mode: MapMode, iconName: string, label: string): HTMLButtonElement {
  // O rótulo some no painel estreito (chat.css); o title e o aria-label mantêm o nome.
  return h('button', { class: 'map-mode', type: 'button', 'data-mode': mode, title: label, 'aria-label': label, onclick: () => setMapMode(mode) }, icon(iconName), h('span', { class: 'map-mode-label' }, label));
}
const mapToggle = h('div', { class: 'map-toggle', role: 'group', 'aria-label': 'Vista do mapa' }, modeButton('graph', 'type-hierarchy-sub', 'Grafo'), modeButton('list', 'list-flat', 'Lista'), modeButton('lab', 'beaker', 'Hipóteses'));
/** Grafo da árvore de agentes. Criado uma vez, igual ao mapScroll. */
const graph = createAgentGraph({
  rootLabel: 'Conversa principal',
  fill: true,
  onSelect: (id, rect, byKey) => {
    popAnchor = undefined;
    popup.open(id, rect, { focus: byKey });
  },
  onViewChange: () => popup.reposition(),
  onEdgeVisibilityChange: (v) => {
    edgeVisibility = v;
    saveState();
  },
  getFold: (id) => boxFold[foldKey(id)],
  onFoldChange: (id, collapsed) => {
    setFold(id, collapsed);
    // A lista usa a mesma escolha: aberta agora, remonta com a caixa no estado novo.
    if (mapMode === 'list' && !overlay.classList.contains('hidden') && !detailId) {
      renderMap();
    }
  },
  needsAttention: hasPendingDecision,
  // Com o mapa na tela, caixa que termina não recolhe sozinha (a lista e o grafo pulariam); recolhe na próxima abertura.
  holdAutoFold: () => !overlay.classList.contains('hidden') && !detailId,
});
graph.setEdgeVisibility(edgeVisibility);
const mapGraph = h('div', { class: 'map-graph' }, graph.element);
const mapView = h('div', { class: 'map-view' }, mapGraph, mapScroll);

function paintMapMode(): void {
  mapView.classList.toggle('is-graph', mapMode === 'graph');
  mapView.classList.toggle('is-list', mapMode === 'list');
  mapView.classList.toggle('is-lab', mapMode === 'lab');
  for (const b of mapToggle.querySelectorAll<HTMLButtonElement>('.map-mode')) {
    b.setAttribute('aria-pressed', String(b.dataset.mode === mapMode));
  }
}
paintMapMode();

function setMapMode(mode: MapMode): void {
  // O popup está ancorado num nó ou cartão da vista que vai sumir.
  popup.close();
  labView.closePopup();
  mapMode = mode;
  paintMapMode();
}

/** Cartão (da lista ou do log) em que o popup foi aberto. Sem ele, o popup se ancora no nó do grafo. */
let popAnchor: HTMLElement | undefined;

/** Onde o popup de `id` se ancora agora: o cartão clicado, o nó do grafo visível, ou o cartão de algum lugar. */
function anchorFor(id: string): DOMRect | undefined {
  const visible = (el: HTMLElement | undefined): el is HTMLElement => !!el?.isConnected && el.offsetParent !== null;
  if (visible(popAnchor) && popAnchor.dataset.agent === id) {
    return popAnchor.getBoundingClientRect();
  }
  const mapOpen = !overlay.classList.contains('hidden') && !detailId;
  if (mapOpen && mapMode === 'graph') {
    return graph.nodeRect(id);
  }
  const card = mapOpen ? mapCards.get(id) : agentCards.get(id);
  return visible(card) ? card.getBoundingClientRect() : undefined;
}

/**
 * Popup de um nó ou cartão: relatório de quem concluiu, "o que está fazendo agora" de quem roda.
 * Fica fixo no <body>, fora dos containers que rolam, então nunca mexe no scroll do mapa nem do log.
 */
/** Cartões de veredito do laboratório no log; o popup deles usa as classes do popup de nó. */
const labCards = createLabCards({ append: (el) => append(el) });
const popup = createNodePopup({
  rootLabel: 'Conversa principal',
  getAgent: (id) => agents.get(id),
  getAgents: () => [...agents.values()],
  getItems: (id) => agentItems.get(id) ?? [],
  renderMarkdown: md,
  openChat: (id) => {
    popup.close();
    openAgent(id);
  },
  stop: (id) => send({ type: 'stopAgent', id }),
  resume: (id) => send({ type: 'resumeAgent', id }),
  worktreeAction: (id, action) => send({ type: 'worktreeAction', id, action }),
  brainReady: () => brainReady,
  openBrainNote: (id) => send({ type: 'openBrain', agentId: id }),
  insertText: (text) => {
    popup.close();
    input.value = text;
    autosize(input);
    input.focus();
  },
  getAnchor: anchorFor,
  liveDuration,
  describeTool: summarize,
  rootLines: () => [state.profileName, state.contextTokens ? `${fmtTokens(state.contextTokens)} em contexto` : ''].filter(Boolean),
  getBox: (boxId) => {
    const grouping = groupAgents([...agents.values()], boxes);
    const g = grouping.groups.get(boxId);
    if (!g) {
      return undefined;
    }
    return {
      name: g.name,
      color: g.color,
      description: g.description,
      agents: g.all,
      collapsed: graph.isBoxCollapsed(boxId),
      parentName: g.parent ? grouping.groups.get(g.parent)?.name : undefined,
      childNames: g.children.map((c) => grouping.groups.get(c)?.name ?? c),
      spend: boxSpend(g),
    };
  },
  toggleBox: (boxId) => graph.toggleBox(boxId),
  askAbout: (id) => {
    popup.close();
    send({ type: 'openCompanion', prefill: askAboutText(id) });
  },
  onClose: () => {
    popAnchor = undefined;
    if (!detailId) {
      graph.select(undefined);
    }
  },
});

/**
 * Vista "Hipóteses" do mapa: árvore de hipóteses do laboratório e o painel com status, buscas e jobs.
 * Busca e job abrem o mesmo popup de nó do grafo, ancorado na linha (ou no nó do torneio) clicada.
 */
const labView = createLabView({
  send,
  insertText: (text) => {
    labView.closePopup();
    closeMap();
    input.value = text;
    autosize(input);
    input.focus();
  },
  openAgentPopup: (id, anchor) => {
    popAnchor = anchor as HTMLElement;
    popup.open(id, anchor.getBoundingClientRect(), { focus: false });
  },
  openAgent: (id) => openAgent(id),
});
mapView.append(labView.element);

/** Abre o popup de um agente ancorado no cartão clicado (lista do mapa ou log principal). */
function openCardPopup(card: HTMLElement, id: string, byKey: boolean): void {
  popAnchor = card;
  popup.open(id, card.getBoundingClientRect(), { focus: byKey });
}

// O log e a lista rolam por baixo do popup aberto num cartão: ele acompanha o cartão.
document.addEventListener(
  'scroll',
  () => {
    if (popup.openId) {
      popup.reposition();
    }
  },
  { capture: true, passive: true },
);

/**
 * O grafo muda de altura quando entra ou sai um agente, e isso encurtaria o conteúdo debaixo do
 * scroll do usuário. Guardar e devolver o scrollTop em volta do update mantém a lista onde estava.
 */
function updateGraph(): void {
  const keep = mapScroll.scrollTop;
  graph.setBoxes(boxes);
  graph.update([...agents.values()]);
  labView.setAgents([...agents.values()]);
  if (mapScroll.scrollTop !== keep) {
    mapScroll.scrollTop = keep;
  }
}
/** Cartão de cada agente no mapa. Reaproveitado entre remontagens para não perder o nó (nem o scroll). */
const mapCards = new Map<string, HTMLElement>();
/** Lista de id:status da última montagem. Enquanto ela não muda, atualizar um agente mexe só no cartão dele. */
let mapShape = '';

function mapSignature(): string {
  // Caixa entra na assinatura: mover um agente de caixa remonta a lista.
  return `${boxes.map((b) => `${b.id}>${b.parent ?? ''}`).join(',')}#${[...agents.values()].map((a) => `${a.id}:${a.status}:${a.box ?? ''}`).join('|')}`;
}

function openMap(): void {
  // Voltando do painel de um agente ("← Mapa"), o nó dele continua destacado no grafo.
  const back = detailId;
  detailId = undefined;
  detailLog = undefined;
  overlay.classList.remove('hidden');
  popup.close();
  // Abrindo o mapa (ou voltando do painel de um agente), as caixas concluídas recolhem pela regra automática.
  graph.releaseAutoFolds();
  // Cabeçalho único: título, contagem, as três vistas e fechar. O espaço vertical é do grafo.
  overlay.replaceChildren(
    h(
      'div',
      { class: 'ov-head map-top' },
      h('b', {}, 'Agentes'),
      mapHead,
      h('div', { class: 'spacer' }),
      mapOrganize,
      mapBrain,
      mapToggle,
      h('button', { class: 'icon-btn square', title: 'Fechar o mapa (Esc)', 'aria-label': 'Fechar o mapa', onclick: closeMap }, icon('close')),
    ),
    mapView,
  );
  mapShape = '';
  graph.select(back);
  renderMap();
}

function closeMap(): void {
  popup.close();
  labView.closePopup();
  overlay.classList.add('hidden');
  detailId = undefined;
  detailLog = undefined;
}

/** Abre o painel de um agente a partir de qualquer lugar, inclusive de um cartão no chat principal. */
function openAgent(id: string): void {
  if (agents.has(id)) {
    overlay.classList.remove('hidden');
    openDetail(id);
  }
}

const KIND_LABEL: Record<AgentInfo['kind'], string> = {
  subagent: 'subagente',
  routed: 'agente',
  fork: 'continuação',
};

/** Destinos que o usuário não tem por que decifrar. */
const WHO: Record<string, string> = {
  main: 'conversa principal',
  user: 'só você',
  bloqueado: 'entrega bloqueada',
  parent: 'quem criou',
};

function whoLabel(id: string | undefined): string {
  return id ? (WHO[id] ?? id) : 'ninguém';
}

/** Texto igual ao título não acrescenta nada: o cartão prefere ficar curto. */
function sameText(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Metades da rota que existem de verdade. Sem origem e sem destino, não há linha de rota. */
function routeParts(a: AgentInfo): { from: string; to: string } {
  const to = a.reportedTo ?? a.reportTo;
  return { from: a.creator ? whoLabel(a.creator) : '', to: to ? whoLabel(to) : '' };
}


/** Agente que voltou do disco: o processo dele não está de pé até alguém retomar. */
const RESUME_HINT = 'Sobe o processo deste agente de novo, com o histórico inteiro dele.';
const NO_SESSION_HINT = 'A conversa deste agente não foi salva em disco, então não dá para retomá-lo.';

function resumeButton(a: AgentInfo, cls: string): HTMLElement | null {
  // Vigia parado (pelo usuário ou porque a janela fechou) volta a verificar pelo mesmo botão.
  const watcherOff = !!a.repeatEveryMinutes && !watching(a);
  // Parado por limite de uso do fornecedor: o botão pede para continuar de onde parou.
  if (a.limit && !a.restored && a.status === 'failed') {
    return h('button', { class: cls, title: 'Pede ao agente para continuar de onde parou. Faça isso depois que o limite de uso liberar.', onclick: () => send({ type: 'resumeAgent', id: a.id }) }, 'Tentar de novo');
  }
  if (!a.restored && !watcherOff) {
    return null;
  }
  if (a.restored && !a.sessionId) {
    const dead = h('button', { class: cls, title: NO_SESSION_HINT }, 'Não dá para retomar');
    dead.disabled = true;
    return dead;
  }
  const label = a.repeatEveryMinutes ? 'Retomar vigia' : 'Retomar';
  const title = a.repeatEveryMinutes ? `Liga de novo a verificação ${repeatLabel(a.repeatEveryMinutes)}.` : RESUME_HINT;
  return h('button', { class: cls, title, onclick: () => send({ type: 'resumeAgent', id: a.id }) }, label);
}

function statusLabel(s: AgentInfo['status']): string {
  return STATUS_LABEL[s];
}

function agentMeta(a: AgentInfo): string {
  const parts = [];
  if (a.durationMs || a.status === 'running') {
    parts.push(fmtDuration(liveDuration(a)));
  }
  if (a.totalTokens) {
    parts.push(`${fmtTokens(a.totalTokens)} tokens`);
  }
  if (a.lastTool && a.status === 'running') {
    parts.push(a.lastTool);
  }
  return parts.join(' · ');
}

function agentTags(a: AgentInfo): HTMLElement {
  return h(
    'div',
    { class: 'tags' },
    h('span', { class: 'tag' }, KIND_LABEL[a.kind]),
    a.repeatEveryMinutes ? h('span', { class: 'tag watch' }, icon('sync'), ` vigia ${repeatLabel(a.repeatEveryMinutes)}`) : null,
    a.browserActive ? h('span', { class: 'tag browser', title: 'Este agente está com o navegador agora' }, icon('browser'), ' navegador') : null,
    a.worktree ? h('span', { class: 'tag branch', title: `Worktree isolado: ${a.worktree.path}` }, icon('git-branch'), ` ${a.worktree.branch}`) : null,
    a.subagentType ? h('span', { class: 'tag' }, a.subagentType) : null,
    a.provider === 'codex' ? h('span', { class: 'tag prov', title: 'Roda no Codex (OpenAI)' }, 'Codex') : null,
    a.profileName && a.kind !== 'subagent' ? h('span', { class: 'tag acc' }, a.profileName) : null,
    a.model ? h('span', { class: 'tag' }, prettyModel(a.model)) : null,
    a.effort ? h('span', { class: 'tag' }, `raciocínio ${a.effort}`) : null,
    a.creator && a.creator !== 'main' ? h('span', { class: 'tag' }, `criado por ${a.creator}`) : null,
    a.reportTo ? h('span', { class: 'tag route' }, `relatório → ${whoLabel(a.reportTo)}`) : null,
  );
}

/** Primeiras linhas do relatório, sem os sinais de markdown, para caber na prévia recolhida. */
function peekText(text: string, lines = 3): string {
  return text
    .split('\n')
    .map((l) =>
      l
        .trim()
        .replace(/^#{1,6}\s+/, '')
        .replace(/^>\s*/, '')
        .replace(/^[-*+]\s+/, '• ')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/`/g, ''),
    )
    .filter(Boolean)
    .slice(0, lines)
    .join('\n');
}

/** Relatório recolhido nas primeiras linhas; aberto, vira markdown de verdade ali mesmo. */
function reportFold(text: string): HTMLDetailsElement {
  const full = h('div', { class: 'md ag-full' });
  md(full, text);
  return h(
    'details',
    { class: 'fold' },
    h('summary', {}, h('div', { class: 'fold-peek' }, peekText(text)), h('span', { class: 'fold-more' }, 'ver tudo'), h('span', { class: 'fold-less' }, 'recolher')),
    full,
  );
}

/**
 * Destino do relatório só quando foge do padrão (entregar para quem criou). "→ a1", "→ só você".
 * O padrão é o caso de quase todo agente e repeti-lo em cada cartão só ocuparia espaço.
 */
function cardDest(a: AgentInfo): string {
  const dest = a.reportedTo ?? a.reportTo;
  if (!dest || dest === 'parent' || dest === (a.creator ?? 'main')) {
    return '';
  }
  return `→ ${whoLabel(dest)}`;
}

/**
 * Segunda linha do cartão, só quando acrescenta algo: o que o agente faz agora (última ferramenta
 * do log, com o resumo dela) enquanto roda, ou a primeira linha do relatório quando terminou.
 */
function cardLine(a: AgentInfo): string {
  // Vigia entre verificações: a hora da última verificação diz mais que o último relatório.
  if (a.repeatEveryMinutes && a.status !== 'running') {
    return lastCheckLabel(a) || (sameText(a.summary, a.description) ? '' : (a.summary?.trim() ?? ''));
  }
  if (a.status === 'running') {
    const items = agentItems.get(a.id) ?? [];
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === 'tool') {
        return `${toolLabel(it.name)} ${summarize(it.name, it.input)}`.trim();
      }
    }
    const summary = sameText(a.summary, a.description) ? '' : a.summary?.trim();
    return summary || a.lastTool || '';
  }
  const report = sameText(a.report, a.description) ? '' : a.report?.trim();
  if (report) {
    return peekText(report, 1);
  }
  return sameText(a.summary, a.description) ? '' : (a.summary?.trim() ?? '');
}

/**
 * Cartão de um agente, numa linha (mais uma opcional): ponto de estado, título, destino fora do
 * padrão, tempo e tokens. Rota completa, métricas, relatório e botões ficam no popup, que o clique
 * abre ancorado no cartão. `into` reaproveita o nó que já está na tela: atualizar no lugar mantém o
 * scroll do container e a posição cronológica no log. `compact` é a versão do chat principal.
 */
function agentCard(a: AgentInfo, compact: boolean, into?: HTMLElement): HTMLElement {
  const card = into ?? h('div', { class: 'ag-card', role: 'button', tabindex: '0' });
  if (!into) {
    card.dataset.agent = a.id;
    card.addEventListener('click', (e) => {
      if (!(e.target as Element).closest('button, a')) {
        openCardPopup(card, a.id, false);
      }
    });
    card.addEventListener('keydown', (e) => {
      const key = (e as KeyboardEvent).key;
      if ((key === 'Enter' || key === ' ') && e.target === card) {
        e.preventDefault();
        openCardPopup(card, a.id, true);
      }
    });
  }
  card.className = `ag-card slim ${a.status}${compact ? ' compact' : ''}${a.restored ? ' restored' : ''}`;
  card.title = `${a.description || 'Agente'}: clique para ver ${a.status === 'running' ? 'o que está fazendo' : 'o relatório'}`;
  paintAgent(card, a);

  const canStop = (a.status === 'running' && (a.kind === 'routed' || (a.kind === 'subagent' && !!a.taskId))) || watching(a);
  const dest = cardDest(a);
  const line = cardLine(a);
  const stop = canStop
    ? h(
        'button',
        {
          class: 'ag-stop icon-btn',
          title: a.repeatEveryMinutes ? 'Parar vigia' : 'Parar agente',
          'aria-label': `Parar ${a.description || a.id}`,
          onclick: (e: Event) => {
            e.stopPropagation();
            send({ type: 'stopAgent', id: a.id });
          },
        },
        icon('debug-stop'),
      )
    : null;

  fill(
    card,
    h(
      'div',
      { class: 'ag-top' },
      agentDot(a),
      a.repeatEveryMinutes ? h('span', { class: 'ag-watch-ico', title: `Vigia ${repeatLabel(a.repeatEveryMinutes)}` }, icon('sync')) : null,
      a.browserActive ? h('span', { class: 'ag-browser', title: 'Está com o navegador (Claude in Chrome)' }, icon('browser')) : null,
      a.worktree ? h('span', { class: 'ag-branch', title: `Isolado na branch ${a.worktree.branch}` }, icon('git-branch')) : null,
      h('span', { class: 'ag-title' }, a.description || 'Agente'),
      a.provider === 'codex' ? h('span', { class: 'ag-prov', title: `Roda no Codex, conta ${a.profileName ?? '?'}` }, 'Codex') : null,
      onOtherAccount(a) ? h('span', { class: 'ag-prov', title: `Roda na conta Claude ${a.profileName ?? a.accountId}, não na deste chat` }, shortAccountName(a.profileName ?? a.accountId ?? '')) : null,
      dest ? h('span', { class: 'ag-dest' }, dest) : null,
      h('div', { class: 'spacer' }),
      a.repeatEveryMinutes ? watchCell(a, 'ag-watch') : null,
      h(
        'span',
        { class: 'ag-nums' },
        a.durationMs || a.status === 'running' ? clockCell(a, 'ag-time') : null,
        a.totalTokens ? h('span', { class: 'ag-tok' }, shortTokens(a.totalTokens)) : null,
      ),
      stop,
    ),
    // No log principal o cartão fica numa linha: a atividade já está na faixa de cima do composer e o
    // relatório chega como linha própria. O popup do clique tem o resto.
    line && !compact ? h('div', { class: 'ag-line2' }, line) : null,
  );
  return card;
}

/** Log novo de um agente rodando: só a segunda linha dos cartões dele muda, no texto. */
function paintCardActivity(id: string): void {
  const a = agents.get(id);
  if (!a || a.status !== 'running') {
    return;
  }
  const text = cardLine(a);
  for (const [card, compact] of [[mapCards.get(id), false]] as const) {
    if (!card) {
      continue;
    }
    const el = card.querySelector<HTMLElement>('.ag-line2');
    if (el && text) {
      if (el.textContent !== text) {
        el.textContent = text;
      }
    } else if (!!el !== !!text) {
      agentCard(a, compact, card);
    }
  }
}

const GROUPS: { title: string; match: AgentInfo['status'][] }[] = [
  { title: 'Trabalhando', match: ['running'] },
  { title: 'Aguardando', match: ['waiting'] },
  { title: 'Concluídos', match: ['completed'] },
  { title: 'Falhou ou parado', match: ['failed', 'stopped'] },
];

/** Mesma regra dos cartões: métrica zerada não aparece, e linha que ficou vazia some inteira. */
function subLine(...parts: (string | false | undefined)[]): HTMLElement | null {
  const kept = parts.filter(Boolean) as string[];
  return kept.length ? h('div', { class: 'map-sub' }, kept.join(' · ')) : null;
}

function renderMapHead(): void {
  const list = [...agents.values()];
  const running = list.filter((a) => a.status === 'running').length;
  const tokens = list.reduce((sum, a) => sum + a.totalTokens, 0);
  // Uma linha curta: quantos e quantos trabalham. Tokens, conta e contexto ficam no title e no popup da raiz.
  mapHead.title = [`${fmtTokens(tokens)} tokens somados`, state.forkOf ? `Continuação de ${state.forkOf}` : '', state.profileName, state.contextTokens ? `${fmtTokens(state.contextTokens)} em contexto` : '']
    .filter(Boolean)
    .join(' · ');
  const grouping = groupAgents(list, boxes);
  const shownBoxes = [...grouping.groups.keys()].filter((k) => k !== LOOSE_BOX).length;
  // Agentes roteados soltos (os únicos que assign_box move): a partir de 4, vale oferecer a arrumação.
  const looseRouted = list.filter((a) => a.kind === 'routed' && !a.search && !a.infra && (!grouping.boxOf.has(a.id) || grouping.boxOf.get(a.id) === LOOSE_BOX)).length;
  fill(
    mapHead,
    subLine(running ? `${running} de ${list.length} trabalhando` : `${list.length} ${list.length === 1 ? 'agente' : 'agentes'}`),
    shownBoxes ? h('div', { class: 'map-sub map-sub-boxes' }, `${shownBoxes} ${shownBoxes === 1 ? 'caixa' : 'caixas'}`) : null,
  );
  fill(
    mapBrain,
    brainReady
      ? h(
          'button',
          {
            class: 'map-organize map-brain',
            type: 'button',
            title: 'Abre o índice do cérebro compartilhado (.agm/brain/index.md): decisões, achados e uma nota por frente e por agente',
            onclick: () => send({ type: 'openBrain' }),
          },
          icon('book'),
          h('span', { class: 'map-brain-label' }, 'Cérebro'),
        )
      : null,
  );
  // Fora do mapHead: ele divide a largura com o espaçador e quebraria a linha.
  fill(
    mapOrganize,
    // Só quando a bagunça existe: a caixa "Avulsos" apareceu, ou já há caixas e sobraram vários soltos.
    grouping.groups.has(LOOSE_BOX) || (grouping.hasBoxes && looseRouted >= 4)
      ? h(
          'button',
          {
            class: 'map-organize',
            type: 'button',
            title: `Prepara na caixa de mensagem um pedido para o orquestrador agrupar os ${looseRouted} agentes soltos em caixas (você revisa e envia)`,
            onclick: () => organizeInBoxes(),
          },
          icon('group-by-ref-type'),
          h('span', { class: 'map-organize-label' }, 'Organizar em caixas'),
        )
      : null,
  );
}

/** Texto que "Organizar em caixas" põe no composer. O modelo decide os grupos pelo título e pela descrição. */
const ORGANIZE_TEXT = [
  'Organize os agentes desta conversa em caixas no mapa de agentes.',
  'Use list_agents para ver quem existe. Agrupe por projeto ou etapa, pelo título e pelo que cada um fez: crie as caixas com create_box (nomes curtos, como "Onda 1 · fundação") e mova os agentes com assign_box, inclusive os concluídos.',
  'Deixe sem caixa só o que foi tarefa avulsa. Não crie, não pare e não retome agentes; é só arrumação. No fim, diga numa linha quais caixas ficaram.',
].join('\n');

function organizeInBoxes(): void {
  closeMap();
  input.value = ORGANIZE_TEXT;
  autosize(input);
  input.focus();
}

/** Remonta a lista. Move os cartões que já existem em vez de recriá-los e devolve o scroll onde estava. */
function renderMap(): void {
  if (detailId) {
    return;
  }
  const keep = mapScroll.scrollTop;
  const list = [...agents.values()];
  graph.setBoxes(boxes);
  graph.update(list);
  labView.setAgents(list);
  mapShape = mapSignature();
  for (const id of [...mapCards.keys()]) {
    if (!agents.has(id)) {
      mapCards.delete(id);
    }
  }
  const grouping = groupAgents(list, boxes);
  const byBox = grouping.hasBoxes ? boxSections(grouping) : undefined;
  const sections = byBox ?? GROUPS.flatMap((g) => {
    const inGroup = list.filter((a) => g.match.includes(a.status));
    if (!inGroup.length) {
      return [];
    }
    return [
      h(
        'section',
        { class: 'map-group' },
        h('div', { class: 'group-head' }, h('span', { class: `dot ${g.match[0]}` }), g.title, h('span', { class: 'group-count' }, String(inGroup.length))),
        ...inGroup.map((a) => {
          const card = agentCard(a, false, mapCards.get(a.id));
          mapCards.set(a.id, card);
          return card;
        }),
      ),
    ];
  });
  renderMapHead();
  mapBody.replaceChildren(...(sections.length ? sections : [h('div', { class: 'none' }, 'Nenhum agente nesta conversa ainda.')]));
  mapScroll.scrollTop = keep;
}

/**
 * Lista agrupada por caixa: um cabeçalho recolhível por caixa (o mesmo recolher do grafo), as caixas filhas
 * dentro da mãe e os avulsos no fim.
 */
function boxSections(grouping: Grouping): HTMLElement[] {
  const cardOf = (a: AgentInfo): HTMLElement => {
    const card = agentCard(a, false, mapCards.get(a.id));
    mapCards.set(a.id, card);
    return card;
  };
  const section = (gid: string, child: boolean): HTMLElement | null => {
    const g = grouping.groups.get(gid);
    if (!g) {
      return null;
    }
    const st = boxStats(g.all);
    const collapsed = graph.isBoxCollapsed(gid);
    const swatch = h('span', { class: 'box-swatch', 'aria-hidden': 'true' });
    swatch.style.setProperty('--agm-color', g.color);
    const head = h(
      'button',
      {
        class: 'box-head',
        type: 'button',
        'aria-expanded': String(!collapsed),
        title: `${g.description ? `${g.description}\n` : ''}${collapsed ? 'Expandir' : 'Recolher'} a caixa`,
        onclick: () => graph.toggleBox(gid),
      },
      icon(collapsed ? 'chevron-right' : 'chevron-down'),
      swatch,
      h('span', { class: 'box-name' }, g.name),
      h('span', { class: 'box-count' }, boxCountText(st)),
      h('div', { class: 'spacer' }),
      st.tokens ? h('span', { class: 'box-tok' }, shortTokens(st.tokens)) : null,
    );
    const el = h('section', { class: `map-group map-box${child ? ' is-child' : ''}${collapsed ? ' is-collapsed' : ''}` }, head);
    el.style.setProperty('--agm-color', g.color);
    if (!collapsed) {
      el.append(...g.agents.map(cardOf), ...(g.children.map((c) => section(c, true)).filter(Boolean) as HTMLElement[]));
    }
    return el;
  };
  const out = grouping.top.map((gid) => section(gid, false)).filter(Boolean) as HTMLElement[];
  if (grouping.loose.length) {
    out.push(
      h(
        'section',
        { class: 'map-group map-loose' },
        h('div', { class: 'group-head' }, h('span', { class: 'dot completed' }), 'Avulsos', h('span', { class: 'group-count' }, String(grouping.loose.length))),
        ...grouping.loose.map(cardOf),
      ),
    );
  }
  return out;
}

/** Atualização de um agente: mexe só no cartão dele, a não ser que a lista em si tenha mudado. */
function refreshMap(id?: string): void {
  if (overlay.classList.contains('hidden') || detailId) {
    return;
  }
  if (mapSignature() !== mapShape) {
    renderMap();
    return;
  }
  const a = id ? agents.get(id) : undefined;
  const card = id ? mapCards.get(id) : undefined;
  if (a && card) {
    agentCard(a, false, card);
  }
  renderMapHead();
  updateGraph();
}

function openDetail(id: string): void {
  const a = agents.get(id);
  if (!a) {
    return;
  }
  popup.close();
  detailId = id;
  graph.select(id);
  const header = h('div', { class: 'detail-head' });
  const body = h('div', { class: 'detail-log' });
  detailLog = body;

  overlay.replaceChildren(
    h(
      'div',
      { class: 'ov-head' },
      h('button', { class: 'icon-btn', onclick: () => openMap() }, '← Mapa'),
      h('div', { class: 'spacer' }),
      h('button', { class: 'icon-btn', onclick: closeMap }, 'Fechar'),
    ),
    header,
    body,
    agentComposer(a),
  );
  renderDetailHeader();
  for (const item of agentItems.get(id) ?? []) {
    renderItem(item, body);
  }
  body.scrollTop = body.scrollHeight;
}

/** Só o cabeçalho muda; o log do agente fica intocado, com o scroll onde o usuário deixou. */
function renderDetailHeader(): void {
  const a = detailId ? agents.get(detailId) : undefined;
  const header = overlay.querySelector('.detail-head') as HTMLElement | null;
  if (!a || !header) {
    return;
  }
  paintAgent(header, a);
  header.classList.add('tinted');
  header.classList.toggle('restored', !!a.restored);
  const canStop = (a.status === 'running' && (a.kind === 'routed' || (a.kind === 'subagent' && !!a.taskId))) || watching(a);
  const report = sameText(a.report, a.description) ? '' : a.report?.trim();
  const { from, to } = routeParts(a);
  const route = [from ? `criado por ${from}` : '', to ? `entrega para ${to}` : ''].filter(Boolean).join(' → ');
  const wasOpen = !!header.querySelector('details.fold[open]');
  const fold = report ? reportFold(report) : null;
  if (fold && wasOpen) {
    fold.open = true;
  }
  fill(
    header,
    h(
      'div',
      { class: 'node-title big' },
      agentDot(a),
      a.kind === 'routed' ? `${a.id} · ${a.description}` : a.description,
      a.restored ? h('span', { class: 'ag-saved', title: a.sessionId ? RESUME_HINT : NO_SESSION_HINT }, 'salvo') : null,
    ),
    h('div', { class: 'node-meta' }, [statusLabel(a.status), agentMeta(a)].filter(Boolean).join(' · ')),
    route ? h('div', { class: 'node-meta' }, route) : null,
    a.repeatEveryMinutes ? h('div', { class: 'node-meta' }, watchCell(a, ''), lastCheckLabel(a) ? ` · ${lastCheckLabel(a)}` : '') : null,
    agentTags(a),
    a.prompt
      ? h(
          'details',
          { class: 'task' },
          h('summary', {}, 'Tarefa'),
          (() => {
            const el = h('div', { class: 'md prompt' });
            md(el, a.prompt!);
            return el;
          })(),
        )
      : null,
    fold ? h('div', { class: 'ag-label' }, 'Relatório final') : null,
    fold,
    h(
      'div',
      { class: 'perm-actions' },
      canStop ? h('button', { onclick: () => send({ type: 'stopAgent', id: a.id }) }, a.repeatEveryMinutes ? 'Parar vigia' : 'Parar agente') : null,
      resumeButton(a, ''),
      a.kind === 'fork' ? h('button', { onclick: () => send({ type: 'revealAgent', id: a.id }) }, 'Abrir chat') : null,
    ),
  );
}

/**
 * Caixa de mensagem do agente. Roteado na mesma conta: fala direto com ele e troca modelo/raciocínio na hora.
 * Outra conta, ou subagente embutido: abre uma continuação num chat próprio com a conta, o modelo e o raciocínio escolhidos.
 */
function agentComposer(a: AgentInfo): HTMLElement {
  const text = h('textarea', { class: 'input', rows: '2', placeholder: a.kind === 'routed' ? `Mensagem para ${a.id}` : 'Mensagem para continuar este agente' });
  // Agente roteado numa conta Codex mora nessa conta: é ela que vem marcada e que conta como "mesma conta".
  const home = a.kind === 'routed' && a.accountId ? a.accountId : state.profileId;
  const profileSel = h(
    'select',
    { title: 'Conta' },
    ...state.profiles.map((p) =>
      option(p.id, `${p.name}${p.provider === 'codex' ? ' · Codex' : ''}${p.account ? ` · ${p.account}` : ''}`, p.id === home),
    ),
  );
  const modelSel2 = h('select', { title: 'Modelo' });
  const effortSel2 = h('select', { title: 'Raciocínio' });
  const targetIsCodex = () => state.profiles.find((p) => p.id === profileSel.value)?.provider === 'codex';
  /** Chat Codex tem os modelos do Codex em state.models; chat Claude só os conhece pela lista que o host manda à parte. */
  const modelsFor = (codex: boolean) => (codex === (state.provider === 'codex') ? state.models : codex ? state.codexModels : []);
  /** Refaz modelo e raciocínio conforme o fornecedor da conta escolhida: nomes do Claude não valem no Codex e vice-versa. */
  const fillModels = () => {
    const codex = targetIsCodex();
    const list = modelsFor(codex).filter((m) => m.value);
    const keep = codex === (a.provider === 'codex') ? a.model : undefined;
    modelSel2.replaceChildren(
      option('', codex ? 'Modelo padrão da conta' : 'Modelo padrão', !keep),
      ...list.map((m) => option(m.value, m.displayName, m.value === keep)),
    );
    if (keep && !list.some((m) => m.value === keep)) {
      modelSel2.append(option(keep, prettyModel(keep), true));
    }
    fillEfforts();
  };
  const fillEfforts = () => {
    const codex = targetIsCodex();
    const chosen = modelsFor(codex).find((m) => m.value === modelSel2.value);
    const levels = codex ? effortsFor(chosen ?? modelsFor(codex).find((m) => /padrão da conta/.test(m.description))) : EFFORT_STEPS;
    const was = effortSel2.value || (codex === (a.provider === 'codex') ? (a.effort ?? '') : '');
    effortSel2.replaceChildren(
      option('', 'Raciocínio padrão', !levels.includes(was)),
      ...levels.map((v) => option(v, EFFORTS.find(([k]) => k === v)?.[1] ?? `Raciocínio ${(EFFORT_SHORT[v] ?? v).toLowerCase()}`, v === was)),
    );
  };
  fillModels();
  const stopOriginal = h('input', { type: 'checkbox' });
  const hint = h('div', { class: 'hint' });

  const current = () => agents.get(a.id) ?? a;
  const sameAccount = () => profileSel.value === home;
  const restored = () => !!current().restored && !!current().sessionId && sameAccount();
  const direct = () => current().kind === 'routed' && sameAccount() && !restored();
  const refreshHint = () => {
    hint.textContent = restored()
      ? 'Este agente está parado; enviar vai retomá-lo e entregar a mensagem na sequência.'
      : direct()
        ? 'Vai direto para o agente. Modelo e raciocínio mudam na hora.'
        : 'Abre um chat próprio com a conta, o modelo e o raciocínio escolhidos, já com a tarefa e o que o agente fez até agora.';
    stopLabel.classList.toggle('hidden', direct() || restored() || current().status !== 'running');
    go.textContent = restored() ? 'Retomar e enviar' : direct() ? 'Enviar' : 'Continuar em chat próprio';
    hint.classList.toggle('warn-hint', restored());
  };
  modelSel2.addEventListener('change', () => {
    fillEfforts();
    if (direct()) {
      send({ type: 'agentSetModel', id: a.id, value: modelSel2.value });
    }
  });
  effortSel2.addEventListener('change', () => {
    if (direct()) {
      send({ type: 'agentSetEffort', id: a.id, value: effortSel2.value });
    }
  });
  profileSel.addEventListener('change', () => {
    if (targetIsCodex() && state.provider !== 'codex' && !state.codexModels.length) {
      codexModelWaiters.push(fillModels);
      send({ type: 'listCodexModels' });
    }
    fillModels();
    refreshHint();
  });

  const go = h('button', {
    class: 'send',
    onclick: () => {
      const value = text.value.trim();
      if (!value) {
        return;
      }
      if (restored()) {
        send({ type: 'resumeAgent', id: a.id, text: value });
      } else if (direct()) {
        send({ type: 'agentSend', id: a.id, text: value });
      } else {
        send({
          type: 'forkAgent',
          id: a.id,
          profileId: profileSel.value,
          model: modelSel2.value,
          effort: effortSel2.value,
          text: value,
          stopOriginal: stopOriginal.checked,
        });
      }
      text.value = '';
    },
  });
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      go.click();
    }
  });
  const stopLabel = h('label', { class: 'check' }, stopOriginal, ' parar o original');
  const box = h('div', { class: 'composer agent' }, text, h('div', { class: 'row' }, profileSel, modelSel2, effortSel2, stopLabel, h('div', { class: 'spacer' }), go), hint);
  refreshHint();
  return box;
}

function onAgent(agent: AgentInfo): void {
  const isNew = !agents.has(agent.id);
  agents.set(agent.id, agent);
  rebaseClock(agent);
  if (!agentItems.has(agent.id)) {
    agentItems.set(agent.id, []);
  }
  // Continuação vive só no mapa: no log principal ela seria o eco de algo que o usuário acabou de pedir.
  if (agent.kind !== 'fork') {
    const card = agentCards.get(agent.id);
    if (card) {
      agentCard(agent, true, card);
    } else {
      const made = agentCard(agent, true);
      agentCards.set(agent.id, made);
      append(made);
    }
  }
  renderAgents();
  if (detailId === agent.id) {
    renderDetailHeader();
  } else {
    refreshMap(isNew ? undefined : agent.id);
  }
  // Popup aberto nesse agente (ou na raiz, que resume todos) repinta no lugar.
  popup.refresh(agent.id);
}

function onAgentItem(id: string, item: HistoryItem): void {
  if (!agentItems.has(id)) {
    agentItems.set(id, []);
  }
  agentItems.get(id)!.push(item);
  if (detailId === id && detailLog) {
    const stick = detailLog.scrollHeight - detailLog.scrollTop - detailLog.clientHeight < 120;
    renderItem(item, detailLog);
    if (stick) {
      detailLog.scrollTop = detailLog.scrollHeight;
    }
  }
  paintCardActivity(id);
  if (popup.openId === id) {
    popup.refresh(id);
  }
}

// ---------- Formatação ----------

// ---------- Limites do plano ----------

/** Última leitura dos limites. Alimenta a pílula do relógio e o menu que ela abre. */
let lastUsage: UsageInfo | undefined;

function renderUsage(usage: UsageInfo): void {
  lastUsage = usage;
  renderClock();
  renderUsageBar();
}

/** Pílula do relógio: quanto falta para a janela de 5 horas zerar. Sem dado, fica só o ícone apagado. */
function renderClock(): void {
  const u = lastUsage;
  const five = u?.available ? (u.windows.find((w) => w.key === 'five_hour') ?? u.windows[0]) : undefined;
  const tone = five ? level(five.utilization) : '';
  clockPill.classList.toggle('off', !five);
  clockPill.classList.toggle('warn', tone === 'warn');
  clockPill.classList.toggle('crit', tone === 'crit');
  fill(clockPill, icon('clockface'), five?.resetsAt ? h('span', {}, fmtLeft(five.resetsAt)) : null);
  const lines = (u?.windows ?? []).map(
    (w) => `${w.label}: ${w.utilization.toFixed(0)}% usado, ${(100 - w.utilization).toFixed(0)}% livre${w.resetsAt ? ` · zera ${fmtReset(w.resetsAt)}` : ''}`,
  );
  if (!five) {
    lines.push(u?.error ?? 'Limites ainda indisponíveis.');
  }
  if (u?.subscription) {
    lines.unshift(`Plano ${u.subscription}`);
  }
  lines.push('', 'Clique para ver o detalhe e atualizar.');
  clockPill.title = lines.join('\n');
}

function level(pct: number): string {
  return pct >= 90 ? 'crit' : pct >= 75 ? 'warn' : '';
}

/** "em 2h 10min" ou a data, quando falta mais de um dia. */
function fmtReset(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) {
    return iso;
  }
  if (ms <= 0) {
    return 'agora';
  }
  const min = Math.round(ms / 60000);
  if (min < 60) {
    return `em ${min}min`;
  }
  const hours = Math.floor(min / 60);
  if (hours < 24) {
    return `em ${hours}h ${min % 60}min`;
  }
  return `em ${Math.floor(hours / 24)}d ${hours % 24}h (${new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })})`;
}

/** Quanto falta, curto: "58m", "2h 10m", "3d 4h". */
function fmtLeft(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) {
    return '';
  }
  if (ms <= 0) {
    return 'agora';
  }
  const min = Math.round(ms / 60000);
  if (min < 60) {
    return `${min}m`;
  }
  const hrs = Math.floor(min / 60);
  return hrs < 24 ? `${hrs}h ${min % 60}m` : `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

/** Quando foi, para a lista de conversas: "há 5 min", "ontem 14:30", "12/03 09:12". */
function fmtWhen(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  const min = Math.round((Date.now() - d.getTime()) / 60000);
  if (min < 1) {
    return 'agora';
  }
  if (min < 60) {
    return `há ${min} min`;
  }
  const clock = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return `hoje ${clock}`;
  }
  if (d.toDateString() === new Date(now.getTime() - 86400000).toDateString()) {
    return `ontem ${clock}`;
  }
  const date = d.toLocaleDateString('pt-BR', d.getFullYear() === now.getFullYear() ? { day: '2-digit', month: '2-digit' } : { day: '2-digit', month: '2-digit', year: '2-digit' });
  return `${date} ${clock}`;
}

/** Igual a fmtTokens, sem a casa decimal nos milhares: a pílula de contexto é estreita. */
function shortTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  return String(n);
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ---------- Mensagens do host ----------

/** Acrescenta ao que já está salvo. Um sessionId vazio (o init chega antes do session) nunca apaga o que havia. */
function saveState(): void {
  const prev = (vscode.getState() ?? {}) as SavedState;
  vscode.setState({
    ...prev,
    profileId: state.profileId || prev.profileId,
    sessionId: state.sessionId || prev.sessionId || undefined,
    edges: edgeVisibility,
    boxFold,
  });
}

// ---------- Tarefas propostas por vigias ----------

const TASK_STATUS: Record<TaskProposal['status'], string> = {
  pending: '',
  approved: 'executada',
  edited: 'foi para a caixa de mensagem',
  ignored: 'ignorada',
};

/** Texto que "Editar e executar" põe no composer, já com a origem, para o master saber de onde veio. */
function taskDraft(p: TaskProposal): string {
  return [`Tarefa aprovada vinda do ${p.source} de ${p.from}:`, '', p.instructions, ...(p.link ? ['', `Link: ${p.link}`] : [])].join('\n');
}

/**
 * Cartão de aprovação. O texto veio de outra pessoa, então vai como texto puro (nada de markdown, que
 * carregaria imagem de fora) e só chega ao agente principal pelo clique em Executar.
 */
function onTaskProposal(p: TaskProposal): void {
  const known = taskCards.get(p.id);
  const card = known ?? h('div', { class: 'msg task-card decision has-agent', role: 'group', 'aria-label': `Tarefa proposta: ${p.summary}` });
  const pendingNow = p.status === 'pending';
  card.classList.toggle('done', !pendingNow);
  // Ponto na cor do vigia que propôs, a mesma do nó dele no grafo.
  card.style.setProperty('--agent', agentColor(agents.get(p.agentId)?.color, p.agentId));
  const at = new Date(p.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const link = /^https?:\/\//i.test(p.link ?? '') ? h('a', { class: 'task-link', href: p.link!, title: p.link! }, 'mensagem original') : null;
  const head = decisionHead('inbox', `Tarefa do ${p.source}`, h('span', { class: 'dec-who', title: `${p.from}, proposta pelo vigia ${p.agentId}` }, h('span', { class: 'agent-dot', 'aria-hidden': 'true' }), h('span', { class: 'dec-who-name' }, p.from)), at);
  if (!pendingNow) {
    // Resolvida: uma linha só. O texto completo continua no title.
    head.append(h('span', { class: `task-status ${p.status}` }, TASK_STATUS[p.status]));
    card.title = `${p.summary}\n\n${p.instructions}`;
    fill(card, head);
  } else {
    fill(
      card,
      head,
      h('div', { class: 'task-summary' }, p.summary),
      h('div', { class: 'task-body' }, p.instructions),
      h(
        'div',
        { class: 'task-actions' },
        h('button', { class: 'primary', title: 'Manda a tarefa ao agente principal, que executa', onclick: () => send({ type: 'resolveTask', id: p.id, action: 'approve' }) }, 'Executar'),
        h(
          'button',
          {
            title: 'Põe a tarefa na caixa de mensagem para você ajustar e enviar',
            onclick: () => {
              const draft = taskDraft(p);
              input.value = input.value.trim() ? `${input.value.trimEnd()}\n\n${draft}` : draft;
              autosize(input);
              input.focus();
              send({ type: 'resolveTask', id: p.id, action: 'edit' });
            },
          },
          'Editar antes',
        ),
        h('button', { class: 'task-ignore', onclick: () => send({ type: 'resolveTask', id: p.id, action: 'ignore' }) }, 'Ignorar'),
        h('div', { class: 'spacer' }),
        link,
      ),
      h('div', { class: 'task-warn' }, 'Escrito por outra pessoa. Se aprovar, o Claude executa sem pedir permissão.'),
    );
  }
  setPending(`task:${p.id}`, pendingNow ? { el: card, label: p.summary, detail: `Tarefa do ${p.source}, de ${p.from}`, icon: 'inbox', agentId: p.agentId } : null);
  if (!known) {
    taskCards.set(p.id, card);
    append(card);
    scrollDown(true);
  }
}

// ---------- Chat lateral de consulta ----------

/** Pergunta que o "Perguntar sobre este agente" do popup põe na caixa do chat lateral (sem enviar). */
function askAboutText(id: string): string {
  const a = agents.get(id);
  const who = a ? `o agente ${id} ("${a.description}")` : `o agente ${id}`;
  if (a?.status === 'failed') {
    return `Por que ${who} falhou?`;
  }
  if (a?.status === 'running') {
    return `O que ${who} está fazendo agora?`;
  }
  return `O que ${who} fez? Resuma o relatório dele.`;
}

/** Só existe no chat lateral. No principal fica indefinido e as chamadas `companionUi?.` não fazem nada. */
let companionUi: ReturnType<typeof createCompanionUi> | undefined;

/**
 * O mesmo bundle serve ao chat lateral: sem orquestração (agentes, decisões, navegador, modo de permissão,
 * histórico, anexos e pesquisa), com a faixa de só leitura no topo e perguntas de exemplo próprias.
 */
function enterCompanionMode(init: CompanionInit): void {
  if (!companionUi) {
    companionUi = createCompanionUi({
      send,
      setInput: (text) => {
        input.value = text;
        autosize(input);
        renderSend();
        input.focus();
      },
    });
    document.body.classList.add('companion');
    top.after(companionUi.banner);
    for (const el of [companionBtn, histBtn, newChatBtn, addBtn, agentsPill, pendingPill, browserPill, clockPill, modePill, usageBar, runBar]) {
      el.classList.add('companion-hidden');
    }
    empty.replaceChildren(...Array.from(companionUi.empty.childNodes));
    empty.classList.add('companion-empty');
  }
  companionUi.setExamples(init.examples);
}

/** Textos fixos da página que citam quem responde. */
function applyBrand(): void {
  input.placeholder = state.companion
    ? 'Pergunte sobre o projeto ou sobre os agentes. Enter envia, Shift+Enter quebra linha'
    : `Escreva para o ${brand()}. Enter envia, Shift+Enter quebra linha`;
  workingDot.title = `O ${brand()} está trabalhando`;
}

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      Object.assign(state, {
        profileId: msg.profileId,
        profileName: msg.profileName,
        account: msg.account,
        cwd: msg.cwd,
        mode: msg.permissionMode,
        model: msg.model,
        effort: msg.effort,
        forkOf: msg.forkOf,
        provider: msg.provider === 'codex' ? 'codex' : 'claude',
        cwdUri: msg.cwdUri ?? '',
        external: msg.external ?? state.external,
        sessionTitle: msg.sessionTitle || state.sessionTitle,
        companion: msg.companion,
      });
      if (msg.companion) {
        enterCompanionMode(msg.companion);
      }
      applyBrand();
      renderControls();
      renderForkBanner();
      saveState();
      break;
    case 'profiles':
      state.profiles = msg.list;
      break;
    case 'models':
      state.models = msg.list;
      renderControls();
      break;
    case 'codexModels':
      state.codexModels = msg.list;
      codexModelWaiters.splice(0).forEach((fn) => fn());
      break;
    case 'session':
      state.sessionId = msg.sessionId || state.sessionId;
      state.mode = msg.permissionMode;
      if (msg.model) {
        state.resolvedModel = msg.model;
      }
      renderControls();
      saveState();
      break;
    case 'busy':
      state.busy = msg.value;
      if (!msg.value) {
        state.thinking = false;
      }
      renderControls();
      refreshMap();
      break;
    case 'thinking':
      state.thinking = msg.value;
      renderActivity();
      break;
    case 'contextTokens':
      state.contextTokens = msg.value;
      renderControls();
      refreshMap();
      break;
    case 'textDelta':
      onTextDelta(msg.msgId, msg.index, msg.text);
      break;
    case 'assistantText':
      onAssistantText(msg.msgId, msg.text);
      break;
    // spawn_agent, send_to_agent e companhia não viram linha: quem conta essa história é o cartão do agente.
    case 'toolStart':
      if (isOrchestration(msg.name)) {
        hiddenTools.add(msg.id);
      } else if (!toolsIn(log).has(msg.id)) {
        createTool(msg.id, msg.name);
      }
      break;
    case 'toolUse':
      if (isOrchestration(msg.name)) {
        hiddenTools.add(msg.id);
      } else {
        onToolUse(msg.id, msg.name, msg.input);
      }
      break;
    case 'toolResult':
      if (!hiddenTools.has(msg.id)) {
        onToolResult(msg.id, msg.text, msg.isError, log, msg.images);
      }
      break;
    case 'permission':
      onPermission(msg);
      break;
    case 'permissionClosed':
      closePermission(msg.requestId);
      break;
    case 'result':
      addResult(msg);
      companionUi?.decorate(log);
      break;
    case 'sessionTitle':
      state.sessionTitle = msg.title;
      renderControls();
      break;
    case 'companionPrefill':
      input.value = msg.text;
      autosize(input);
      renderSend();
      input.focus();
      break;
    case 'companionExamples':
      companionUi?.setExamples(msg.examples);
      break;
    case 'notice':
      addNotice(msg.text, msg.level, msg.action);
      break;
    case 'history':
      renderHistory(msg.items);
      companionUi?.decorate(log);
      break;
    case 'clear':
      clearLog();
      break;
    case 'userEcho':
      addUser(msg.text, msg.from, log, [], msg.fromId, msg.origin);
      break;
    case 'insertText':
      input.value += (input.value && !input.value.endsWith(' ') ? ' ' : '') + msg.text;
      autosize(input);
      input.focus();
      break;
    case 'agent':
      onAgent(msg.agent);
      break;
    case 'boxes':
      boxes = msg.list;
      refreshMap();
      popup.refresh();
      break;
    case 'agentItem':
      onAgentItem(msg.id, msg.item);
      break;
    case 'attachments':
      pending.push(...msg.list);
      renderPending();
      input.focus();
      break;
    case 'usage':
      renderUsage(msg.usage);
      break;
    case 'sessions':
      showSessions(msg.list, msg.error);
      break;
    case 'commands':
      slashCommands = msg.list;
      if (suggestKind === 'slash') {
        renderSuggest();
      }
      break;
    case 'fileResults':
      // Resposta de uma busca que o usuário já passou: ignora.
      if (msg.requestId === fileReq && suggestKind === 'file') {
        fileMatches = msg.list;
        fileNotice = msg.notice;
        fileShown = fileSent;
        suggestCursor = 0;
        paintFiles();
      }
      break;
    case 'activeFile':
      activeFileName = msg.name;
      break;
    case 'taskProposal':
      onTaskProposal(msg.proposal);
      break;
    case 'guardAlert':
      guardCards.onAlert(msg.alert);
      break;
    case 'lab':
      labCards.update(msg.state, msg.initial);
      labView.update(msg.state);
      break;
    case 'brain':
      brainReady = msg.exists;
      renderMapHead();
      break;
    case 'browserStatus':
      state.browser = { on: msg.on, status: msg.browser, owner: msg.owner, browsers: msg.browsers, browsersError: msg.browsersError };
      renderBrowserPill();
      // Menu do "+" aberto: o item do navegador acompanha o estado novo.
      if (openAt?.anchor === addBtn) {
        closeMenu();
        openAddMenu();
      }
      break;
    case 'commandOutput': {
      // Resposta do próprio CLI, não do modelo: vai com cara de aviso do sistema.
      const el = h('div', { class: 'sc-output md' });
      md(el, msg.text);
      append(el);
      break;
    }
  }
});

renderControls();
input.focus();
send({ type: 'ready' });
