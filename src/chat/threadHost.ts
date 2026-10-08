import * as vscode from 'vscode';
import type { Profile } from '../profiles';
import { ChatSession } from './session';
import type { AgentInfo, HostMessage, PermissionDecision } from './protocol';
import { COMPANION_SERVER, createCompanionServer } from './companion/tools';
import { COMPANION_BLOCKED_TOOLS, companionHooks, companionSystemAppend } from './companion/policy';
import type { CompanionSource } from './companion/types';
import {
  addReport,
  appendMessage,
  applyHistorySummaries,
  applyPostSummary,
  consultPrompt,
  consultToolLabel,
  emptyThread,
  migrateLegacy,
  postsOf,
  splitPostBlocks,
  type AgentPost,
  type PostBlock,
  type PostThread,
} from './threadModel';
import type { ThreadPersistence } from './threadStore';

/** Sessões de consulta vivas ao mesmo tempo; a mais antiga parada fecha quando outra thread precisa subir. */
const MAX_LIVE_SESSIONS = 2;
/** Espera depois do fim do processo antes de dar a resposta como perdida (o fim do turno chega antes, quando chega). */
const LOST_TURN_MS = 800;

export interface ThreadHostDeps {
  /** Conta Claude que responde nas threads (numa conversa Codex, a primeira conta Claude). */
  profile: () => Profile;
  cwd: string;
  persistence: ThreadPersistence;
  mainSessionId: () => string | undefined;
  /** Mesma leitura só leitura do chat lateral. */
  source: () => CompanionSource;
  post: (msg: HostMessage) => void;
  /** Conversa retomada na abertura do painel: os agentes restaurados chegam antes do load e não podem gravar por cima. */
  startPaused?: boolean;
}

/**
 * Posts e threads estilo Slack dentro do chat principal: cada relatório entregue por um agente vira um post, e cada
 * post tem uma thread. Quem responde na thread é uma sessão só leitura (as ferramentas do chat lateral, o mesmo hook)
 * falando em primeira pessoa como o agente; nada dela entra na conversa principal nem chega ao agente de verdade.
 */
export class AgentThreads {
  private posts: AgentPost[] = [];
  /** Thread de cada post, pelo id do post ("a3#2"). */
  private threads = new Map<string, PostThread>();
  private readonly sessions = new Map<string, ChatSession>();
  /** Pedido de permissão de uma sessão de thread → post da thread. */
  private readonly permissions = new Map<string, string>();
  /** Perguntas que esperam vaga: com as sessões vivas todas ocupadas, a próxima thread espera em vez de subir mais uma. */
  private queue: { postId: string; prompt: string }[] = [];
  /** Conversa principal cujas threads estão carregadas. */
  private loadedFor?: string;
  /** Entre a troca de conversa e o load: relatório de agente restaurado não vira post aqui (o load refaz a conta). */
  private paused: boolean;

  constructor(private readonly deps: ThreadHostDeps) {
    this.paused = !!deps.startPaused;
  }

  /**
   * Conversa aberta ou retomada: troca para os posts e threads dela. `history` são os textos do orquestrador lidos do
   * transcrito; os blocos <post> deles completam o resumo de post que não chegou a ser gravado.
   */
  load(mainSessionId: string, history: readonly string[] = []): void {
    this.detach();
    this.loadedFor = mainSessionId;
    this.paused = false;
    const stored = this.deps.persistence.load(mainSessionId);
    this.posts = stored.posts;
    for (const t of stored.threads) {
      this.threads.set(t.postId, { ...t, waiting: undefined });
    }
    // Relatórios que o arquivo ainda não tem (conversa de antes dos posts, ou gravação perdida) viram post agora.
    for (const { info } of this.deps.source().agents()) {
      this.posts = this.withReport(info) ?? this.posts;
    }
    const blocks: PostBlock[] = history.flatMap((text) => splitPostBlocks(text).blocks);
    if (blocks.length) {
      this.posts = applyHistorySummaries(this.posts, blocks);
    }
    if (stored.legacy.length) {
      for (const t of migrateLegacy(stored.legacy, this.posts, [...this.threads.values()])) {
        this.threads.set(t.postId, t);
      }
    }
    this.save();
    this.postAll();
  }

  /** Troca de conversa: grava o que havia e esvazia, sem apagar nada do disco. */
  detach(): void {
    this.save();
    this.closeSessions();
    this.posts = [];
    this.threads = new Map();
    this.loadedFor = undefined;
    this.paused = true;
    this.deps.post({ type: 'threads', posts: [], list: [] });
  }

  postAll(): void {
    this.deps.post({ type: 'threads', posts: this.posts, list: [...this.threads.values()] });
  }

  dispose(): void {
    this.save();
    this.closeSessions();
  }

  /** Agente mudou: relatório entregue que ainda não tem post vira post novo. */
  noteAgent(info: AgentInfo): void {
    if (this.paused) {
      return;
    }
    const next = this.withReport(info);
    if (!next) {
      return;
    }
    const added = next.find((p) => !this.posts.includes(p));
    this.posts = next;
    if (added) {
      this.deps.post({ type: 'post', post: added });
    }
    this.save();
  }

  /** Posts com o relatório do agente, ou undefined quando não há relatório novo. */
  private withReport(info: AgentInfo): AgentPost[] | undefined {
    if (info.kind === 'fork' || info.search || info.infra || !info.report?.trim() || !info.reportedAt) {
      return undefined;
    }
    const { posts, added } = addReport(this.posts, { agentId: info.id, report: info.report, at: Date.parse(info.reportedAt) });
    return added ? posts : undefined;
  }

  /** Texto completo do orquestrador: os blocos <post> viram o texto do post de cada agente. */
  takeSummaries(text: string): void {
    if (this.paused) {
      return;
    }
    const { blocks } = splitPostBlocks(text);
    let changed = false;
    for (const b of blocks) {
      const r = applyPostSummary(this.posts, b.agentId, b.text);
      if (r.changed) {
        this.posts = r.posts;
        this.deps.post({ type: 'post', post: r.changed });
        changed = true;
      }
    }
    if (changed) {
      this.save();
    }
  }

  /** Troca de conta: as sessões das threads são da conta antiga e não retomam na nova. A próxima pergunta abre outra. */
  resetSessions(): void {
    this.closeSessions();
    for (const [id, t] of this.threads) {
      if (t.consultSessionId || t.waiting) {
        this.threads.set(id, { ...t, consultSessionId: undefined, waiting: undefined });
      }
    }
    this.save();
    this.postAll();
  }

  /** Pergunta escrita na thread de um post: vai à sessão que fala pelo agente. */
  send(postId: string, raw: string): void {
    const text = raw.trim();
    const post = this.posts.find((p) => p.id === postId);
    if (!text || !post) {
      return;
    }
    const thread = this.thread(post);
    if (thread.waiting) {
      this.deps.post({ type: 'notice', level: 'info', text: `O agente ${post.agentId} ainda está respondendo nesta thread.` });
      return;
    }
    const first = !thread.messages.some((m) => m.from === 'agent');
    const info = this.agentInfo(post.agentId);
    this.update(appendMessage({ ...thread, waiting: true }, { from: 'user', text, at: Date.now() }));
    const prompt = consultPrompt(post, info?.description ?? '', text, first, postsOf(this.posts, post.agentId).length);
    if (!this.hasRoom(postId)) {
      this.queue.push({ postId, prompt });
      this.status(postId, 'na fila: outras threads estão respondendo');
      return;
    }
    this.status(postId, 'pensando');
    this.session(post).send(prompt);
  }

  /** Há vaga para esta thread: ela já tem sessão, sobra lugar ou alguma sessão viva está parada. */
  private hasRoom(postId: string): boolean {
    return this.sessions.has(postId) || this.sessions.size < MAX_LIVE_SESSIONS || [...this.sessions.values()].some((s) => !s.isBusy);
  }

  /** Uma sessão ficou livre: a primeira pergunta da fila que cabe agora sai. */
  private drainQueue(): void {
    const i = this.queue.findIndex((q) => this.hasRoom(q.postId));
    if (i < 0) {
      return;
    }
    const [next] = this.queue.splice(i, 1);
    const post = this.posts.find((p) => p.id === next.postId);
    if (!post || !this.threads.get(next.postId)?.waiting) {
      this.drainQueue();
      return;
    }
    this.status(next.postId, 'pensando');
    this.session(post).send(next.prompt);
  }

  /** Botão de parar da thread: interrompe a resposta em andamento. */
  async interrupt(postId: string): Promise<void> {
    if (this.queue.some((q) => q.postId === postId)) {
      // Ainda na fila: só sai dela, sem resposta.
      this.queue = this.queue.filter((q) => q.postId !== postId);
      this.status(postId, undefined);
      const thread = this.threads.get(postId);
      if (thread) {
        this.update({ ...thread, waiting: undefined });
      }
      return;
    }
    await this.sessions.get(postId)?.interrupt();
  }

  ownsPermission(requestId: string): boolean {
    return this.permissions.has(requestId);
  }

  respondPermission(requestId: string, answer: PermissionDecision): void {
    const id = this.permissions.get(requestId);
    this.permissions.delete(requestId);
    if (id) {
      this.sessions.get(id)?.respondPermission(requestId, answer);
    }
  }

  // ---------- Internos ----------

  private thread(post: AgentPost): PostThread {
    return this.threads.get(post.id) ?? emptyThread(post);
  }

  private update(thread: PostThread): void {
    this.threads.set(thread.postId, thread);
    this.deps.post({ type: 'thread', thread });
    this.save();
  }

  private status(postId: string, text?: string): void {
    this.deps.post({ type: 'threadStatus', postId, text });
  }

  private save(): void {
    if (this.paused && !this.loadedFor) {
      return;
    }
    // O id vivo vence: fork e /clear trocam o id da conversa sem passar por detach/load, e a pasta copiada é a nova.
    // Na troca de conversa o detach grava antes do session.start, então o id vivo ainda é o da que sai.
    const id = this.deps.mainSessionId() ?? this.loadedFor;
    if (id && (this.threads.size || this.posts.length)) {
      this.loadedFor = id;
      this.deps.persistence.save(id, this.posts, [...this.threads.values()]);
    }
  }

  private agentInfo(id: string): AgentInfo | undefined {
    return this.deps.source().agents().find((a) => a.info.id === id)?.info;
  }

  /** Sessão que responde pela thread, criada na primeira pergunta e retomada da conversa salva. */
  private session(post: AgentPost): ChatSession {
    const key = post.id;
    const existing = this.sessions.get(key);
    if (existing) {
      // Reinsere: a ordem do Map é a de uso, e a primeira parada é a que fecha quando faltar vaga.
      this.sessions.delete(key);
      this.sessions.set(key, existing);
      return existing;
    }
    if (this.sessions.size >= MAX_LIVE_SESSIONS) {
      const idle = [...this.sessions.entries()].find(([, s]) => !s.isBusy);
      if (idle) {
        idle[1].dispose();
        this.sessions.delete(idle[0]);
      }
    }
    const config = vscode.workspace.getConfiguration('agentGraphMaster');
    // Sessão descartada (troca de conversa, conta trocada, vaga para outra thread) não mexe em mais nada: outra
    // conversa pode ter uma thread com o mesmo id.
    const alive = () => this.sessions.get(key) === session;
    const session: ChatSession = new ChatSession(this.deps.profile(), this.deps.cwd, (msg) => alive() && this.onConsultMessage(key, msg), {
      model: config.get<string>('companion.model', 'sonnet').trim() || 'sonnet',
      effort: config.get<string>('companion.effort', 'medium').trim(),
      permissionMode: 'default',
      mcpServers: () => ({ [COMPANION_SERVER]: createCompanionServer(() => this.deps.source()) }),
      systemAppend: () => threadSystemAppend(this.deps.source().title(), post.agentId, this.agentInfo(post.agentId)),
      // Na thread nem comandos com aprovação: o cartão cairia no meio da conversa principal.
      disallowedTools: [...COMPANION_BLOCKED_TOOLS, 'Bash', 'PowerShell', 'KillShell'],
      hooks: companionHooks,
      strictMcp: true,
    });
    session.onTurnEnd = (turn) => {
      if (!alive()) {
        return;
      }
      this.status(key, undefined);
      const thread = this.threads.get(key);
      if (!thread?.waiting) {
        return;
      }
      const text = session.lastTurnText.trim() || (turn.isError ? 'A resposta falhou sem texto.' : 'Terminei sem escrever resposta.');
      this.update(appendMessage({ ...thread, waiting: undefined }, { from: 'agent', text, at: Date.now(), error: turn.isError || undefined }));
    };
    session.onBusyChange = (busy) => {
      if (busy || !alive()) {
        return;
      }
      queueMicrotask(() => this.drainQueue());
      // Processo que morre sem fechar o turno não deixa a thread esperando para sempre.
      setTimeout(() => {
        const thread = this.threads.get(key);
        if (alive() && thread?.waiting && !session.isBusy) {
          this.status(key, undefined);
          this.update(appendMessage({ ...thread, waiting: undefined }, { from: 'agent', text: 'A sessão desta thread parou sem responder.', at: Date.now(), error: true }));
        }
      }, LOST_TURN_MS);
    };
    this.sessions.set(key, session);
    session.start(this.thread(post).consultSessionId);
    return session;
  }

  /** O que a sessão da thread conta: só o que a thread usa passa adiante. */
  private onConsultMessage(postId: string, msg: HostMessage): void {
    const agentId = this.threads.get(postId)?.agentId ?? postId.slice(0, postId.lastIndexOf('#'));
    switch (msg.type) {
      case 'session': {
        const thread = this.threads.get(postId);
        if (msg.sessionId && thread && thread.consultSessionId !== msg.sessionId) {
          this.threads.set(postId, { ...thread, consultSessionId: msg.sessionId });
          this.save();
        }
        return;
      }
      case 'toolUse':
      case 'toolStart':
        this.status(postId, consultToolLabel(msg.name));
        return;
      case 'permission':
        this.permissions.set(msg.requestId, postId);
        this.deps.post({ ...msg, agentLabel: `thread do ${agentId}`, agentId });
        return;
      case 'permissionClosed':
        this.permissions.delete(msg.requestId);
        this.deps.post(msg);
        return;
      case 'notice':
        if (msg.level === 'error') {
          this.deps.post({ ...msg, text: `Thread do ${agentId}: ${msg.text}` });
        }
        return;
    }
  }

  private closeSessions(): void {
    // Limpa o mapa antes do dispose: o "alive" de cada sessão já dá falso para o que ela ainda mandar.
    const list = [...this.sessions.values()];
    this.sessions.clear();
    for (const s of list) {
      s.dispose();
    }
    this.permissions.clear();
    this.queue = [];
  }
}

/** Prompt de sistema da thread: as ferramentas do chat lateral, mas falando como o agente, sobre o post. */
function threadSystemAppend(mainTitle: string, agentId: string, info: AgentInfo | undefined): string {
  const who = info?.description ? `${agentId} ("${info.description}")` : agentId;
  return [
    companionSystemAppend(mainTitle),
    '',
    `Nesta sessão o papel muda: você responde numa thread do Slack, dentro do chat principal, pendurada num post do agente ${who}. Fale em primeira pessoa, como se fosse esse agente contando o que fez, o que achou e por quê ("eu li", "eu mudei", "não verifiquei").`,
    'Você é uma leitura só leitura do trabalho dele, não o agente de verdade: responda pelo relatório do post, pelo log (agent_activity) e pelos arquivos. O que não estiver lá, diga que não sabe ou que não conferiu, sem inventar.',
    'Nesta thread não há "Enviar ao principal", você não roda comandos (Bash e PowerShell estão fora) e nada do que escreve chega ao agente nem ao orquestrador. Pedido de ação (refazer, continuar, mudar código): diga que o usuário pode pedir no chat principal.',
    'Responda curto, como numa thread: poucas frases e, se precisar, uma lista pequena.',
  ].join('\n');
}
