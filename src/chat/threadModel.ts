/**
 * Posts e threads no chat principal, como no Slack: cada relatório que um agente entrega vira um post (avatar, nome,
 * hora e um resumo em primeira pessoa), e qualquer mensagem do chat (post, fala do Claude, mensagem do usuário) pode
 * ter thread. Quem responde na thread é o próprio orquestrador: a mensagem vai a ele embrulhada com o contexto
 * (<thread-msg>), e ele responde num bloco <thread id="..."> do texto dele. Só lógica pura, sem VS Code nem DOM: o
 * host guarda e o webview desenha com isto.
 */

/** Quem escreveu na thread: o usuário, o Claude da conversa principal ou o Claude na voz de um agente (`as`). */
export type ThreadAuthor = 'user' | 'claude' | 'agent';

export interface ThreadMessage {
  id: string;
  from: ThreadAuthor;
  /** Com `from: 'agent'`: em nome de qual agente. */
  agentId?: string;
  text: string;
  /** Hora em ms. 0 quando veio do transcrito, que não traz hora. */
  at: number;
  /** Resposta que terminou em erro. */
  error?: boolean;
}

/** Um relatório entregue por um agente, como post no chat. */
export interface AgentPost {
  /** "a3#2": agente e número do relatório dele. */
  id: string;
  agentId: string;
  /** 1 para o primeiro relatório do agente, 2 para o seguinte... */
  n: number;
  /** Hora da entrega em ms. */
  at: number;
  report: string;
  /** Texto do post escrito pelo orquestrador (bloco <post>). Sem ele, o post mostra a linha "Resumo:" do relatório. */
  summary?: string;
}

/** De que mensagem a thread pende: post de agente ("a3#2"), fala do Claude ("c:...") ou mensagem do usuário ("u:..."). */
export type ThreadParentKind = 'post' | 'claude' | 'user';

export interface ThreadParent {
  kind: ThreadParentKind;
  /** Agente do post. */
  agentId?: string;
  /** Trecho da mensagem-mãe: o painel da thread mostra e o embrulho leva ao orquestrador. Vazio nos posts (o post é a mãe). */
  text: string;
  /** Hora da mãe em ms, quando se sabe. */
  at?: number;
}

export interface ChatThread {
  /** Id da mensagem-mãe: "a3#2", "c:<id da mensagem da API>" ou "u:<uuid da mensagem do usuário>". */
  id: string;
  parent: ThreadParent;
  messages: ThreadMessage[];
  /** Mensagem mandada ao orquestrador, esperando a resposta (ou o fim do turno dele). */
  waiting?: boolean;
}

/** Passando disso, as mensagens mais antigas saem da thread. */
export const MAX_THREAD_MESSAGES = 200;
/** Texto guardado por mensagem; o resto fica no transcrito da conversa principal. */
export const MAX_MESSAGE_CHARS = 20_000;
/** Trecho da mensagem-mãe guardado na thread e levado no embrulho. */
export const PARENT_EXCERPT_CHARS = 600;
/** Relatório guardado por post. O inteiro continua no agente e em .agm/reports/. */
export const MAX_REPORT_CHARS = 60_000;
/** Posts guardados por conversa; os mais antigos saem primeiro. */
export const MAX_POSTS = 300;
/** Mesmo relatório gravado de novo nesse intervalo (entregue a dois destinos, por exemplo) não vira outro post. */
const SAME_REPORT_MS = 60_000;

export function postId(agentId: string, n: number): string {
  return `${agentId}#${n}`;
}

/** Thread vazia do post de um agente. */
export function emptyThread(post: Pick<AgentPost, 'id' | 'agentId'>): ChatThread {
  return { id: post.id, parent: { kind: 'post', agentId: post.agentId, text: '' }, messages: [] };
}

// ---------- Ids das mensagens-mãe ----------

/**
 * Id da thread de uma fala do Claude: o id da mensagem da API (o mesmo ao vivo, no `assistantText`, e no
 * transcrito) e, quando a mesma mensagem tem mais de um bloco de texto com algo escrito, a posição do bloco.
 */
export function claudeThreadId(msgId: string, ordinal = 0): string {
  return ordinal ? `c:${msgId}.${ordinal}` : `c:${msgId}`;
}

/** Id da thread de uma mensagem do usuário: o uuid que a mensagem recebeu ao sair (o transcrito guarda o mesmo). */
export function userThreadId(uuid: string): string {
  return `u:${uuid}`;
}

/** Que tipo de mensagem é a mãe, pelo id. Post é o "aN#k". */
export function threadKind(id: string): ThreadParentKind {
  return id.startsWith('c:') ? 'claude' : id.startsWith('u:') ? 'user' : 'post';
}

/** Agente do post pelo id ("a3#2" → "a3"). */
export function postAgent(id: string): string {
  const at = id.lastIndexOf('#');
  return at > 0 ? id.slice(0, at) : id;
}

/**
 * Thread de destino de um bloco <thread id="...">: uma que já existe, o post com esse id, ou, com só o id do agente
 * ("a3"), o post mais recente dele. Undefined quando não há onde pendurar.
 */
export function resolveThreadId(id: string, posts: readonly AgentPost[], has: (id: string) => boolean): string | undefined {
  const key = id.trim();
  if (!key) {
    return undefined;
  }
  if (has(key) || posts.some((p) => p.id === key)) {
    return key;
  }
  return /^[\w-]+$/.test(key) ? latestPost(posts, key)?.id : undefined;
}

/** Trecho de uma linha só, para o embrulho e o "Claude respondeu numa thread: ...". */
export function excerpt(text: string, max = PARENT_EXCERPT_CHARS): string {
  return clipText(text.replace(/\s+/g, ' ').trim(), max);
}

// ---------- Posts ----------

/** Posts de um agente, do primeiro ao último. */
export function postsOf(posts: readonly AgentPost[], agentId: string): AgentPost[] {
  return posts.filter((p) => p.agentId === agentId).sort((a, b) => a.n - b.n);
}

export function latestPost(posts: readonly AgentPost[], agentId: string): AgentPost | undefined {
  return postsOf(posts, agentId).at(-1);
}

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Relatório entregue: vira post novo, salvo quando é o mesmo de um post que já existe (mesma hora de entrega, ou o
 * mesmo texto gravado de novo logo em seguida). Devolve a lista nova e o post criado, se houve.
 */
export function addReport(posts: readonly AgentPost[], entry: { agentId: string; report: string; at: number }): { posts: AgentPost[]; added?: AgentPost } {
  const report = entry.report.trim();
  if (!report || !Number.isFinite(entry.at)) {
    return { posts: [...posts] };
  }
  const mine = postsOf(posts, entry.agentId);
  const clipped = clipText(report, MAX_REPORT_CHARS);
  const last = mine.at(-1);
  if (mine.some((p) => p.at === entry.at) || (last && last.report === clipped && Math.abs(entry.at - last.at) < SAME_REPORT_MS)) {
    return { posts: [...posts] };
  }
  const n = (last?.n ?? 0) + 1;
  const added: AgentPost = { id: postId(entry.agentId, n), agentId: entry.agentId, n, at: entry.at, report: clipped };
  return { posts: [...posts, added].sort((a, b) => a.at - b.at).slice(-MAX_POSTS), added };
}

/**
 * Texto do orquestrador para um agente: vai ao post mais recente dele que ainda não tem resumo, sem passar por cima
 * de um post que já tem (o bloco fala do relatório que acabou de chegar, não de um antigo).
 */
export function applyPostSummary(posts: readonly AgentPost[], agentId: string, summary: string): { posts: AgentPost[]; changed?: AgentPost } {
  const text = summary.trim();
  const target = [...postsOf(posts, agentId)].reverse().find((p, i, list) => !p.summary && list.slice(0, i).every((q) => !q.summary));
  if (!text || !target) {
    return { posts: [...posts] };
  }
  const changed = { ...target, summary: clipText(text, 2000) };
  return { posts: posts.map((p) => (p.id === target.id ? changed : p)), changed };
}

/**
 * Blocos <post> lidos de novo do transcrito (conversa reaberta): só valem para o agente cujos posts ainda não têm
 * resumo nenhum (o que foi gravado ao vivo vence), um bloco por post, na ordem.
 */
export function applyHistorySummaries(posts: readonly AgentPost[], blocks: readonly PostBlock[]): AgentPost[] {
  let out = [...posts];
  const byAgent = new Map<string, string[]>();
  for (const b of blocks) {
    byAgent.set(b.agentId, [...(byAgent.get(b.agentId) ?? []), b.text]);
  }
  for (const [agentId, texts] of byAgent) {
    const mine = postsOf(out, agentId);
    if (mine.some((p) => p.summary)) {
      continue;
    }
    mine.forEach((p, i) => {
      if (texts[i]?.trim()) {
        out = out.map((q) => (q.id === p.id ? { ...q, summary: clipText(texts[i].trim(), 2000) } : q));
      }
    });
  }
  return out;
}

// ---------- Blocos <post> e <thread> do orquestrador ----------

export interface PostBlock {
  agentId: string;
  text: string;
}

/** Resposta do orquestrador numa thread: `<thread id="a3#2" as="a3">...</thread>`. */
export interface ThreadBlock {
  /** Id da thread como ele escreveu (pode ser só o agente, "a3"): quem usa resolve com resolveThreadId. */
  id: string;
  /** Fala na voz deste agente; sem `as`, fala o Claude. */
  as?: string;
  text: string;
}

// "<thread-msg" (o embrulho) não é bloco: o nome da tag termina sem hífen nem letra.
const BLOCK = /<(post|thread)(?![\w-])([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
const BLOCK_OPEN = /<(?:post|thread)(?![\w-])/i;
const ATTR = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR)) {
    out[m[1].toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? '').trim();
  }
  return out;
}

/**
 * Tira do texto do orquestrador os blocos `<post agent="a3">...</post>` e `<thread id="..." as="a3">...</thread>`
 * e devolve o que sobra para mostrar, mais os blocos. Durante o streaming o bloco chega aos pedaços: um `<post` ou
 * `<thread` ainda sem fechamento, ou um começo de tag no fim ("<", "<th"), também some do texto até completar, para
 * não piscar na tela. Bloco sem o atributo que o identifica fica de fora sem virar nada.
 */
export function splitBlocks(text: string): { text: string; blocks: PostBlock[]; threads: ThreadBlock[] } {
  const blocks: PostBlock[] = [];
  const threads: ThreadBlock[] = [];
  let rest = text.replace(BLOCK, (_all, tag: string, rawAttrs: string, body: string) => {
    const a = attrs(rawAttrs);
    if (tag.toLowerCase() === 'post' && a.agent) {
      blocks.push({ agentId: a.agent, text: body.trim() });
    } else if (tag.toLowerCase() === 'thread' && a.id && body.trim()) {
      threads.push({ id: a.id, as: a.as || undefined, text: body.trim() });
    }
    return '';
  });
  const open = BLOCK_OPEN.exec(rest);
  if (open) {
    rest = rest.slice(0, open.index);
  }
  const tail = /<[a-z]{0,6}$/i.exec(rest);
  if (tail && ['<post', '<thread'].some((t) => t.startsWith(tail[0].toLowerCase()))) {
    rest = rest.slice(0, tail.index);
  }
  if (!blocks.length && !threads.length && rest === text) {
    return { text, blocks, threads };
  }
  return { text: rest.replace(/\n{3,}/g, '\n\n').trim(), blocks, threads };
}

// ---------- Mensagem escrita na thread, a caminho do orquestrador ----------

/** Quem é a mãe, como o embrulho conta ao orquestrador. */
function parentLabel(parent: ThreadParent): string {
  if (parent.kind === 'post') {
    return `post do agente ${parent.agentId ?? '?'}`;
  }
  return parent.kind === 'claude' ? 'fala sua (Claude) no chat' : 'mensagem do usuário no chat';
}

/**
 * O que vai de fato à conversa principal quando o usuário escreve numa thread: o id da thread, de quem é a mãe e um
 * trecho dela, e o texto. O lembrete do fim diz onde responder; o prompt de sistema explica o resto.
 *
 *   <thread-msg id="a3#2" mae="post do agente a3">
 *   <trecho>Li as 84 calls...</trecho>
 *   o que o usuário escreveu
 *   </thread-msg>
 *   (Mensagem escrita na thread id="a3#2". Por padrão responda nela, num bloco <thread id="a3#2">; fora do bloco, ...)
 */
export function wrapThreadMessage(threadId: string, parent: ThreadParent, text: string): string {
  const id = threadId.replace(/"/g, '');
  const head = excerpt(parent.text, 300).replace(/<\/?trecho>/gi, '');
  return [
    `<thread-msg id="${id}" mae="${parentLabel(parent)}">`,
    ...(head ? [`<trecho>${head}</trecho>`] : []),
    text.trim(),
    '</thread-msg>',
    // Sem fechar a tag: o lembrete não pode ser ele mesmo um bloco de resposta.
    `(Mensagem escrita na thread id="${id}". Por padrão responda nela, num bloco <thread id="${id}">; fora do bloco, se o assunto for da conversa toda.)`,
  ].join('\n');
}

const WRAP = /<thread-msg\s+id="([^"]+)"[^>]*>\n?(?:<trecho>[\s\S]*?<\/trecho>\n?)?([\s\S]*)<\/thread-msg>/;

/**
 * Reconhece o embrulho numa mensagem do usuário lida do transcrito (pode vir depois das novidades do cérebro): a
 * thread e o que o usuário escreveu. Undefined para mensagem comum.
 */
export function parseThreadMessage(text: string): { threadId: string; text: string } | undefined {
  const m = WRAP.exec(text);
  return m ? { threadId: m[1], text: m[2].trim() } : undefined;
}

// ---------- Rodapé e horas ----------

/** Respostas na thread: todas as mensagens, como o Slack conta (a mãe não entra). */
export function replyCount(thread: ChatThread | undefined): number {
  return thread?.messages.length ?? 0;
}

/** Hora da última mensagem; undefined quando ela veio do transcrito, sem hora. */
export function lastReplyAt(thread: ChatThread | undefined): number | undefined {
  return thread?.messages.at(-1)?.at || undefined;
}

/** "agora", "há 2 min", "há 3 h", "ontem", "há 4 dias" e, passando de uma semana, a data curta. */
export function relativeTime(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) {
    return 'agora';
  }
  const min = Math.max(1, Math.round(s / 60));
  if (min < 60) {
    return `há ${min} min`;
  }
  const hours = Math.floor(min / 60);
  if (hours < 24) {
    return `há ${hours} h`;
  }
  const days = Math.floor(hours / 24);
  if (days === 1) {
    return 'ontem';
  }
  if (days < 7) {
    return `há ${days} dias`;
  }
  const d = new Date(at);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Hora do post como no Slack em português: "10h57". */
export function clockLabel(at: number): string {
  const d = new Date(at);
  return `${d.getHours()}h${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Dias de calendário entre duas horas (no fuso local), não blocos de 24 h. */
function calendarDays(at: number, now: number): number {
  const a = new Date(at);
  const b = new Date(now);
  const da = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const db = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((db - da) / 86_400_000);
}

/** "Última resposta hoje às 14h24", "ontem às 9h05", "há 3 dias". */
export function lastReplyLabel(at: number, now: number): string {
  const days = Math.max(0, calendarDays(at, now));
  if (days === 0) {
    return `Última resposta hoje às ${clockLabel(at)}`;
  }
  if (days === 1) {
    return `Última resposta ontem às ${clockLabel(at)}`;
  }
  return `Última resposta há ${days} dias`;
}

/**
 * Rodapé da mensagem: "12 respostas" e "Última resposta hoje às 14h24" (vazio quando a última veio do transcrito,
 * sem hora). Thread vazia não tem rodapé.
 */
export function threadFooter(thread: ChatThread | undefined, now: number): { count: string; last: string } | undefined {
  const n = replyCount(thread);
  if (!n) {
    return undefined;
  }
  const last = lastReplyAt(thread);
  return { count: `${n} ${n === 1 ? 'resposta' : 'respostas'}`, last: last === undefined ? '' : lastReplyLabel(last, now) };
}

/** Quem fala numa thread: o usuário, o Claude ou o Claude na voz de um agente. */
export interface ThreadSpeaker {
  from: ThreadAuthor;
  agentId?: string;
}

function speakerKey(s: ThreadSpeaker): string {
  return s.from === 'agent' ? `agent:${s.agentId ?? ''}` : s.from;
}

/** Quem participou, do mais recente para o mais antigo, sem repetir. É a fila de avatares do rodapé. */
export function participants(thread: ChatThread | undefined, max = 3): ThreadSpeaker[] {
  const out: ThreadSpeaker[] = [];
  const seen = new Set<string>();
  for (const m of [...(thread?.messages ?? [])].reverse()) {
    const who: ThreadSpeaker = m.from === 'agent' ? { from: 'agent', agentId: m.agentId } : { from: m.from };
    if (!seen.has(speakerKey(who))) {
      seen.add(speakerKey(who));
      out.push(who);
    }
  }
  return out.slice(0, max);
}

/** Iniciais do avatar: "Eu", o id do agente ("a3"). O Claude não tem iniciais: o avatar dele é o ícone. */
export function authorInitials(who: ThreadSpeaker): string {
  return who.from === 'user' ? 'Eu' : who.from === 'agent' ? (who.agentId ?? '?').slice(0, 3) : '';
}

export function authorName(who: ThreadSpeaker, description?: string, brand = 'Claude'): string {
  if (who.from === 'user') {
    return 'Você';
  }
  return who.from === 'agent' ? description || `Agente ${who.agentId ?? ''}`.trim() : brand;
}

// ---------- Disco ----------

/** Thread do formato antigo, uma por agente: só serve para a migração. */
export interface LegacyThread {
  agentId: string;
  messages: ThreadMessage[];
}

export interface StoredThreads {
  posts: AgentPost[];
  threads: ChatThread[];
  /** Threads do formato antigo (chaveadas por agente), à espera dos posts para migrar. */
  legacy: LegacyThread[];
}

/**
 * Mensagens lidas do disco. `agentId` é o agente do post: nos formatos antigos quem respondia era uma persona dele
 * (a consulta só leitura, "consult", ou o próprio agente) e agora a mensagem aparece como dele.
 */
function readMessages(raw: unknown, agentId?: string): ThreadMessage[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ThreadMessage[] = [];
  for (const m of raw as Record<string, unknown>[]) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || typeof m.text !== 'string' || typeof m.at !== 'number') {
      continue;
    }
    const base = { id: m.id, text: m.text, at: m.at, error: m.error === true || undefined };
    if (m.from === 'user' || m.from === 'claude') {
      out.push({ ...base, from: m.from });
    } else if (m.from === 'agent' || m.from === 'consult') {
      const who = typeof m.agentId === 'string' && m.agentId ? m.agentId : agentId;
      out.push(who ? { ...base, from: 'agent', agentId: who } : { ...base, from: 'claude' });
    }
  }
  return out.slice(-MAX_THREAD_MESSAGES);
}

function readParent(id: string, raw: unknown): ThreadParent {
  const kind = threadKind(id);
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const text = typeof p.text === 'string' ? clipText(p.text, PARENT_EXCERPT_CHARS) : '';
  const at = typeof p.at === 'number' && Number.isFinite(p.at) ? p.at : undefined;
  return kind === 'post' ? { kind, agentId: postAgent(id), text: '' } : { kind, text, ...(at !== undefined ? { at } : {}) };
}

/**
 * Threads lidas do disco. O arquivo pode ser de um formato antigo (v1: lista de threads por agente; v2: threads só de
 * post, com `postId` e a sessão da consulta), estar velho ou editado à mão: o que não tem o formato fica de fora.
 */
export function threadsFromStore(raw: unknown): StoredThreads {
  const out: StoredThreads = { posts: [], threads: [], legacy: [] };
  if (Array.isArray(raw)) {
    for (const t of raw as Record<string, unknown>[]) {
      if (t && typeof t === 'object' && typeof t.agentId === 'string' && Array.isArray(t.messages)) {
        const messages = readMessages(t.messages, t.agentId);
        if (messages.length) {
          out.legacy.push({ agentId: t.agentId, messages });
        }
      }
    }
    return out;
  }
  if (!raw || typeof raw !== 'object') {
    return out;
  }
  const obj = raw as { posts?: unknown; threads?: unknown };
  for (const p of (Array.isArray(obj.posts) ? obj.posts : []) as Record<string, unknown>[]) {
    if (!p || typeof p !== 'object' || typeof p.agentId !== 'string' || typeof p.n !== 'number' || typeof p.at !== 'number' || typeof p.report !== 'string') {
      continue;
    }
    out.posts.push({ id: postId(p.agentId, p.n), agentId: p.agentId, n: p.n, at: p.at, report: p.report, summary: typeof p.summary === 'string' && p.summary ? p.summary : undefined });
  }
  const ids = new Set(out.posts.map((p) => p.id));
  const seen = new Set<string>();
  for (const t of (Array.isArray(obj.threads) ? obj.threads : []) as Record<string, unknown>[]) {
    // v3 traz `id` e `parent`; v2, só `postId` (thread de post).
    const id = t && typeof t === 'object' ? (typeof t.id === 'string' ? t.id : typeof t.postId === 'string' ? t.postId : undefined) : undefined;
    if (!id || seen.has(id) || !Array.isArray(t.messages)) {
      continue;
    }
    const parent = readParent(id, t.parent);
    if (parent.kind === 'post' && !ids.has(id)) {
      continue;
    }
    const messages = readMessages(t.messages, parent.agentId);
    if (parent.kind !== 'post' && !messages.length) {
      continue;
    }
    seen.add(id);
    out.threads.push({ id, parent, messages });
  }
  return out;
}

/**
 * Thread antiga (uma por agente) vai para a thread do post mais recente desse agente, antes das mensagens que ela
 * já tiver. Agente sem post perde a thread antiga: não há mensagem-mãe onde pendurá-la.
 */
export function migrateLegacy(legacy: readonly LegacyThread[], posts: readonly AgentPost[], threads: readonly ChatThread[]): ChatThread[] {
  const out = new Map(threads.map((t) => [t.id, t]));
  for (const old of legacy) {
    const post = latestPost(posts, old.agentId);
    if (!post) {
      continue;
    }
    const current = out.get(post.id) ?? emptyThread(post);
    const seen = new Set(current.messages.map((m) => m.id));
    const messages = [...old.messages.filter((m) => !seen.has(m.id)), ...current.messages].sort((a, b) => a.at - b.at).slice(-MAX_THREAD_MESSAGES);
    out.set(post.id, { ...current, messages });
  }
  return [...out.values()];
}

/** O que vai ao disco: os posts, mais recentes por último, e só as threads com conteúdo, sem o "esperando". */
export function threadsToStore(posts: readonly AgentPost[], threads: Iterable<ChatThread>): { version: 3; posts: AgentPost[]; threads: ChatThread[] } {
  const kept = [...posts].sort((a, b) => a.at - b.at).slice(-MAX_POSTS);
  const ids = new Set(kept.map((p) => p.id));
  return {
    version: 3,
    posts: kept,
    threads: [...threads].filter((t) => t.messages.length && (t.parent.kind !== 'post' || ids.has(t.id))).map(({ waiting: _waiting, ...t }) => t),
  };
}

// ---------- Mensagens ----------

/** Acrescenta uma mensagem (sem mudar a thread de entrada) e corta o excesso pelas mais antigas. */
export function appendMessage(thread: ChatThread, msg: Omit<ThreadMessage, 'id'> & { id?: string }): ChatThread {
  const text = clipText(msg.text, MAX_MESSAGE_CHARS);
  const id = msg.id ?? nextMessageId(thread, msg.at);
  const messages = [...thread.messages, { ...msg, id, text }].slice(-MAX_THREAD_MESSAGES);
  return { ...thread, messages };
}

/** Id curto e único dentro da thread: a hora em base 36 e um contador quando duas chegam no mesmo ms. */
function nextMessageId(thread: ChatThread, at: number): string {
  const base = at.toString(36);
  let id = base;
  for (let n = 1; thread.messages.some((m) => m.id === id); n++) {
    id = `${base}-${n}`;
  }
  return id;
}

/**
 * Mensagens das threads lidas de novo do transcrito (conversa reaberta), na ordem: o que o usuário escreveu (o
 * embrulho) e o que o orquestrador respondeu (blocos <thread>). Só servem para thread que o threads.json não tem,
 * e entram sem hora (o transcrito não traz).
 */
export function threadsFromHistory(
  items: readonly { kind: string; text?: string }[],
  posts: readonly AgentPost[],
  known: (id: string) => boolean,
): ChatThread[] {
  const out = new Map<string, ChatThread>();
  const add = (raw: string, msg: Omit<ThreadMessage, 'id' | 'at'>, parentText = '') => {
    const id = resolveThreadId(raw, posts, (x) => known(x) || out.has(x)) ?? (threadKind(raw) !== 'post' ? raw : undefined);
    if (!id || known(id)) {
      return;
    }
    const thread = out.get(id) ?? { id, parent: readParent(id, { text: parentText }), messages: [] };
    out.set(id, appendMessage(thread, { ...msg, at: 0, id: `h${thread.messages.length}` }));
  };
  for (const item of items) {
    if (item.kind === 'user' && item.text) {
      const wrapped = parseThreadMessage(item.text);
      if (wrapped?.text) {
        add(wrapped.threadId, { from: 'user', text: wrapped.text }, /<trecho>([\s\S]*?)<\/trecho>/.exec(item.text)?.[1] ?? '');
      }
    } else if (item.kind === 'text' && item.text) {
      for (const b of splitBlocks(item.text).threads) {
        add(b.id, b.as ? { from: 'agent', agentId: b.as, text: b.text } : { from: 'claude', text: b.text });
      }
    }
  }
  return [...out.values()];
}
