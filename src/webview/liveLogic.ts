/**
 * Lógica pura dos sinais de vida do chat (balão "digitando", balão de pensamento, faixa de agentes ativos).
 * Sem DOM e sem relógio próprio: o tempo entra como argumento, para dar para testar sem VS Code.
 */

/** Limite padrão do texto do balão de pensamento. */
export const BUBBLE_MAX_CHARS = 120;
/** Tempo mínimo entre duas trocas do texto do balão, para dar tempo de ler. */
export const BUBBLE_MIN_MS = 1500;

/** Junta espaços e quebras de linha e corta em `max` caracteres, no fim de uma palavra quando dá. */
export function clip(text: string, max = BUBBLE_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) {
    return flat;
  }
  const cut = flat.slice(0, Math.max(1, max - 1));
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:]+$/, '')}…`;
}

/** O fim de um texto que ainda está sendo escrito (thinking em streaming): o que o modelo pensa agora, não o começo. */
export function tail(text: string, max = BUBBLE_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) {
    return flat;
  }
  const cut = flat.slice(flat.length - (max - 1));
  const space = cut.indexOf(' ');
  return `…${space >= 0 && space < max * 0.3 ? cut.slice(space + 1) : cut}`;
}

function base(path: unknown): string {
  const s = typeof path === 'string' ? path.replace(/[\\/]+$/, '') : '';
  return s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Comando de shell em uma frase: testes, build, git... ou o próprio comando, curto. */
function describeCommand(command: string, description: string): string {
  if (description) {
    return description.charAt(0).toLowerCase() + description.slice(1);
  }
  const c = command.trim();
  if (/\b(test|jest|vitest|pytest|mocha|\.test\.)/i.test(c)) {
    return 'rodando os testes';
  }
  if (/\b(build|compile|tsc|esbuild|webpack|vite build|cargo build|make)\b/i.test(c)) {
    return 'compilando o projeto';
  }
  if (/\b(npm|pnpm|yarn)\s+(i|install|ci|add)\b|\bpip3?\s+install\b/i.test(c)) {
    return 'instalando dependências';
  }
  if (/^git\s+(status|diff|log|show)\b/.test(c)) {
    return `olhando o git (${c.split(/\s+/)[1]})`;
  }
  if (/^git\s+/.test(c)) {
    return `rodando git ${c.split(/\s+/)[1] ?? ''}`.trim();
  }
  if (/\b(lint|eslint|prettier)\b/i.test(c)) {
    return 'conferindo o estilo do código';
  }
  return `rodando ${clip(c.split('\n')[0], 60)}`;
}

/** Nome da ferramenta e entrada em uma frase humana ("lendo hub.ts", "procurando 'lightbox'"). */
export function describeTool(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const bare = name.startsWith('mcp__') ? name.split('__').slice(2).join('__') : name;
  switch (name) {
    case 'Read':
      return `lendo ${base(i.file_path ?? i.path) || 'um arquivo'}`;
    case 'Edit':
    case 'MultiEdit':
      return `editando ${base(i.file_path ?? i.path) || 'um arquivo'}`;
    case 'Write':
      return `escrevendo ${base(i.file_path ?? i.path) || 'um arquivo'}`;
    case 'NotebookEdit':
      return `editando ${base(i.notebook_path) || 'um notebook'}`;
    case 'Bash':
    case 'BashOutput':
      return describeCommand(str(i.command), str(i.description));
    case 'KillShell':
    case 'TaskStop':
      return 'encerrando um processo';
    case 'Grep':
      return str(i.pattern) ? `procurando '${clip(str(i.pattern), 40)}'` : 'procurando no código';
    case 'Glob':
      return str(i.pattern) ? `listando arquivos ${clip(str(i.pattern), 40)}` : 'listando arquivos';
    case 'WebSearch':
      return str(i.query) ? `pesquisando na web: ${clip(str(i.query), 60)}` : 'pesquisando na web';
    case 'WebFetch': {
      const url = str(i.url);
      const host = /^https?:\/\/([^/]+)/.exec(url)?.[1];
      return host ? `abrindo ${host}` : 'abrindo uma página';
    }
    case 'Task':
    case 'Agent':
      return str(i.description) ? `delegando: ${clip(str(i.description), 60)}` : 'delegando a um subagente';
    case 'TodoWrite':
      return 'atualizando a lista de tarefas';
    case 'AskUserQuestion':
      return 'esperando a sua resposta';
    case 'ExitPlanMode':
      return 'apresentando o plano';
    case 'ToolSearch':
      return 'procurando uma ferramenta';
  }
  if (name.startsWith('mcp__')) {
    switch (bare) {
      case 'report_progress':
        return str(i.text) ? clip(str(i.text)) : 'atualizando o progresso';
      case 'spawn_agent':
      case 'spawn_attempts':
        return str(i.description) ? `criando agente: ${clip(str(i.description), 60)}` : 'criando um agente';
      case 'send_to_agent':
        return `mandando mensagem a ${str(i.agent_id) || 'um agente'}`;
      case 'list_agents':
        return 'olhando os agentes';
      case 'brain_read':
      case 'brain_search':
        return 'consultando o cérebro';
      case 'brain_fact':
      case 'brain_write':
      case 'brain_edit':
        return 'anotando no cérebro';
      case 'web_research':
        return 'pesquisando na web';
      case 'generate_image':
        return 'gerando uma imagem';
    }
    if (/browser|chrome|computer|navigate|screenshot|tabs_/i.test(name)) {
      return 'usando o navegador';
    }
    return `usando ${bare.replace(/_/g, ' ')}`;
  }
  return `usando ${name}`;
}

/** Segundos de um turno como "7s", "1m 05s" ou "1h 02m". */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  }
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/**
 * Segura as trocas de texto: a primeira aparece na hora, as seguintes esperam `minMs` desde a última troca. Só o
 * texto mais novo sobrevive à espera, então rajadas não enfileiram nada.
 */
export class TextPacer {
  private shown = '';
  private shownAt = -Infinity;
  private pending: string | undefined;

  constructor(private readonly minMs = BUBBLE_MIN_MS) {}

  get text(): string {
    return this.shown;
  }

  /** Oferece um texto novo. Devolve true se o texto visível mudou agora. */
  push(text: string, now: number): boolean {
    if (!text || text === this.shown) {
      this.pending = undefined;
      return false;
    }
    if (!this.shown || now - this.shownAt >= this.minMs) {
      this.shown = text;
      this.shownAt = now;
      this.pending = undefined;
      return true;
    }
    this.pending = text;
    return false;
  }

  /** Aplica o texto que esperava, se o prazo já passou. Devolve true se o texto visível mudou. */
  poll(now: number): boolean {
    if (this.pending !== undefined && now - this.shownAt >= this.minMs) {
      this.shown = this.pending;
      this.shownAt = now;
      this.pending = undefined;
      return true;
    }
    return false;
  }

  /** Ms até o texto pendente poder aparecer; undefined sem nada esperando. */
  wait(now: number): number | undefined {
    return this.pending === undefined ? undefined : Math.max(0, this.shownAt + this.minMs - now);
  }

  clear(): void {
    this.shown = '';
    this.shownAt = -Infinity;
    this.pending = undefined;
  }
}

/** O que o balão de um ator mostra agora. */
export type BubbleKind = 'typing' | 'thought' | 'none';

export interface ActorView {
  id: string;
  kind: BubbleKind;
  /** Texto do balão de pensamento (kind "thought"); a frase da ferramenta ou o trecho de thinking. */
  text: string;
  /** Ms desde o início do turno. */
  elapsedMs: number;
}

interface Actor {
  id: string;
  since: number;
  typing: boolean;
  thought: TextPacer;
}

/**
 * Quem está trabalhando agora e o que cada um mostra. Um ator existe só entre `start` e `stop` (turno do chat
 * principal, agente com status "rodando"). Eventos de quem não está ativo são ignorados: nada de balão sem trabalho.
 */
export class LiveModel {
  private readonly actors = new Map<string, Actor>();

  constructor(
    private readonly minMs = BUBBLE_MIN_MS,
    private readonly maxChars = BUBBLE_MAX_CHARS,
  ) {}

  start(id: string, now: number): boolean {
    if (this.actors.has(id)) {
      return false;
    }
    this.actors.set(id, { id, since: now, typing: false, thought: new TextPacer(this.minMs) });
    return true;
  }

  stop(id: string): boolean {
    return this.actors.delete(id);
  }

  has(id: string): boolean {
    return this.actors.has(id);
  }

  get active(): boolean {
    return this.actors.size > 0;
  }

  /** O modelo começou a escrever texto: o balão vira "digitando" até a mensagem chegar. Devolve true se mudou. */
  typing(id: string): boolean {
    const a = this.actors.get(id);
    if (!a || a.typing) {
      return false;
    }
    a.typing = true;
    return true;
  }

  /** A mensagem de texto chegou: o balão "digitando" some. */
  message(id: string): boolean {
    const a = this.actors.get(id);
    if (!a || !a.typing) {
      return false;
    }
    a.typing = false;
    return true;
  }

  /** Trecho do que o modelo pensa. Sem texto (thinking oculto), vale a frase "pensando…". */
  thinking(id: string, text: string | undefined, now: number): boolean {
    return this.think(id, text ? tail(text, this.maxChars) : 'pensando…', now);
  }

  /** Ferramenta em uso, em linguagem humana. */
  tool(id: string, name: string, input: unknown, now: number): boolean {
    return this.think(id, clip(describeTool(name, input), this.maxChars), now);
  }

  private think(id: string, text: string, now: number): boolean {
    const a = this.actors.get(id);
    if (!a) {
      return false;
    }
    const wasTyping = a.typing;
    a.typing = false;
    return a.thought.push(text, now) || wasTyping;
  }

  /** Aplica as trocas que esperavam o prazo. Devolve true se algum balão mudou. */
  poll(now: number): boolean {
    let changed = false;
    for (const a of this.actors.values()) {
      changed = a.thought.poll(now) || changed;
    }
    return changed;
  }

  /** Ms até a próxima troca pendente; undefined se nenhuma. */
  nextWake(now: number): number | undefined {
    let wake: number | undefined;
    for (const a of this.actors.values()) {
      const w = a.thought.wait(now);
      if (w !== undefined && (wake === undefined || w < wake)) {
        wake = w;
      }
    }
    return wake;
  }

  view(id: string, now: number): ActorView | undefined {
    const a = this.actors.get(id);
    if (!a) {
      return undefined;
    }
    const kind: BubbleKind = a.typing ? 'typing' : a.thought.text ? 'thought' : 'none';
    return { id, kind, text: kind === 'thought' ? a.thought.text : '', elapsedMs: now - a.since };
  }

  ids(): string[] {
    return [...this.actors.keys()];
  }
}

// ---------- "Agora" de um agente ----------

/** Só o que a linha "Agora" lê de um item do log do agente (o HistoryItem do protocolo cabe aqui). */
export type NowItem = { kind: 'tool'; id: string; name: string; input: unknown } | { kind: 'toolResult'; id: string } | { kind: 'text'; text: string } | { kind: string };

/** "mcp__agents__brain_read" vira "agents · brain_read"; ferramenta embutida fica como está. */
export function mcpToolLabel(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]} · ${m[2]}` : name;
}

/** Uma linha de texto corrido, sem sinais de markdown, para caber numa linha da lista. */
export function flatLine(text: string, max: number): string {
  const t = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/[`>*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Ferramenta aberta mais recente (sem resultado ainda), ou undefined se o agente não está numa. */
export function openTool(items: readonly NowItem[]): { kind: 'tool'; id: string; name: string; input: unknown } | undefined {
  const done = new Set<string>();
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i] as { kind: string; id?: string; name?: string; input?: unknown };
    if (it.kind === 'toolResult') {
      done.add(it.id ?? '');
    } else if (it.kind === 'tool') {
      return done.has(it.id ?? '') ? undefined : { kind: 'tool', id: it.id ?? '', name: it.name ?? '', input: it.input };
    }
  }
  return undefined;
}

export interface NowLine {
  /** "usando", "escrevendo", "pensando · última ferramenta" ou "começando". */
  tag: string;
  name: string;
  sum: string;
}

/**
 * O que um agente rodando faz agora, pelo log dele: a ferramenta aberta (com o resumo da entrada), o texto que está
 * escrevendo, a última ferramenta enquanto pensa, ou "começando". É a linha "Agora" do popup e do chat.
 */
export function agentNow(items: readonly NowItem[], lastTool: string | undefined, describe: (name: string, input: unknown) => string, max = 200): NowLine {
  const cur = openTool(items);
  if (cur) {
    return { tag: 'usando', name: mcpToolLabel(cur.name), sum: flatLine(describe(cur.name, cur.input), max) };
  }
  const last = items.at(-1);
  if (last?.kind === 'text') {
    return { tag: 'escrevendo', name: '', sum: flatLine((last as { text: string }).text, max) };
  }
  if (lastTool) {
    return { tag: 'pensando · última ferramenta', name: mcpToolLabel(lastTool), sum: '' };
  }
  return { tag: 'começando', name: '', sum: '' };
}

/**
 * Quem aparece na faixa de baixo e quem no próprio lugar do chat. Agente com lugar visível no log (o post que roda)
 * mostra o balão lá; a faixa fica com o chat principal e com quem não tem lugar no log. Faixa vazia some.
 */
export function splitTray(ids: readonly string[], inChat: (id: string) => boolean): { tray: string[]; chat: string[] } {
  const tray: string[] = [];
  const chat: string[] = [];
  for (const id of ids) {
    (inChat(id) ? chat : tray).push(id);
  }
  return { tray, chat };
}
