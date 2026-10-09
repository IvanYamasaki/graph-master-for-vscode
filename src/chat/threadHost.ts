import type { AgentInfo, HistoryItem, HostMessage } from './protocol';
import { reportHeadline } from './headline';
import {
  addReport,
  appendMessage,
  applyHistorySummaries,
  applyPostSummary,
  emptyThread,
  excerpt,
  migrateLegacy,
  resolveThreadId,
  splitBlocks,
  threadKind,
  threadsFromHistory,
  wrapThreadMessage,
  type AgentPost,
  type ChatThread,
  type PostBlock,
  type ThreadParent,
} from './threadModel';
import type { ThreadPersistence } from './threadStore';

export interface ThreadHostDeps {
  persistence: ThreadPersistence;
  mainSessionId: () => string | undefined;
  /** Agentes da conversa: relatório entregue que ainda não tem post vira post. */
  agents: () => AgentInfo[];
  post: (msg: HostMessage) => void;
  /**
   * Manda o texto à conversa principal pelo mesmo caminho do composer: com o orquestrador ocupado, vira turno
   * enfileirado no CLI.
   */
  toMain: (text: string) => void;
  /** Conversa retomada na abertura do painel: os agentes restaurados chegam antes do load e não podem gravar por cima. */
  startPaused?: boolean;
}

/** Mãe que o webview manda junto com a primeira mensagem de uma thread nova (fala do Claude ou do usuário). */
export interface ThreadParentHint {
  text: string;
  at?: number;
}

/**
 * Posts e threads estilo Slack dentro do chat principal: cada relatório entregue por um agente vira um post, e
 * qualquer mensagem do chat pode ter thread. Quem responde na thread é o orquestrador (a sessão principal): a
 * mensagem do usuário vai a ele embrulhada com o id da thread e um trecho da mãe, e ele responde num bloco
 * <thread id="..."> (ou no chat, fora do bloco). Os blocos saem do texto mostrado no webview e entram aqui.
 */
export class ChatThreads {
  private posts: AgentPost[] = [];
  /** Threads pelo id da mensagem-mãe ("a3#2", "c:...", "u:..."). */
  private threads = new Map<string, ChatThread>();
  /** Conversa principal cujas threads estão carregadas. */
  private loadedFor?: string;
  /** Entre a troca de conversa e o load: relatório de agente restaurado não vira post aqui (o load refaz a conta). */
  private paused: boolean;

  constructor(private readonly deps: ThreadHostDeps) {
    this.paused = !!deps.startPaused;
  }

  /**
   * Conversa aberta ou retomada: troca para os posts e threads dela. `history` é o transcrito: os blocos <post> do
   * orquestrador completam o resumo de post que não chegou a ser gravado, e as mensagens de thread (embrulho e
   * blocos <thread>) refazem a thread que o threads.json não tem.
   */
  load(mainSessionId: string, history: readonly HistoryItem[] = []): void {
    this.detach();
    this.loadedFor = mainSessionId;
    this.paused = false;
    const stored = this.deps.persistence.load(mainSessionId);
    this.posts = stored.posts;
    for (const t of stored.threads) {
      this.threads.set(t.id, { ...t, waiting: undefined });
    }
    // Relatórios que o arquivo ainda não tem (conversa de antes dos posts, ou gravação perdida) viram post agora.
    for (const info of this.deps.agents()) {
      this.posts = this.withReport(info) ?? this.posts;
    }
    const texts = history.flatMap((i) => (i.kind === 'text' ? [i.text] : []));
    const blocks: PostBlock[] = texts.flatMap((text) => splitBlocks(text).blocks);
    if (blocks.length) {
      this.posts = applyHistorySummaries(this.posts, blocks);
    }
    if (stored.legacy.length) {
      for (const t of migrateLegacy(stored.legacy, this.posts, [...this.threads.values()])) {
        this.threads.set(t.id, t);
      }
    }
    for (const t of threadsFromHistory(history, this.posts, (id) => !!this.threads.get(id)?.messages.length)) {
      this.threads.set(t.id, t);
    }
    this.save();
    this.postAll();
  }

  /** Troca de conversa: grava o que havia e esvazia, sem apagar nada do disco. */
  detach(): void {
    this.save();
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

  /**
   * Texto completo de um bloco do orquestrador: os blocos <post> viram o texto do post de cada agente, e os blocos
   * <thread> viram mensagens na thread certa (do Claude, ou do agente com `as`).
   */
  takeText(text: string): void {
    if (this.paused) {
      return;
    }
    const { blocks, threads } = splitBlocks(text);
    let changed = false;
    for (const b of blocks) {
      const r = applyPostSummary(this.posts, b.agentId, b.text);
      if (r.changed) {
        this.posts = r.posts;
        this.deps.post({ type: 'post', post: r.changed });
        changed = true;
      }
    }
    for (const b of threads) {
      const id = resolveThreadId(b.id, this.posts, (x) => this.threads.has(x));
      const post = id ? this.posts.find((p) => p.id === id) : undefined;
      const thread = id ? (this.threads.get(id) ?? (post ? emptyThread(post) : undefined)) : undefined;
      if (!thread) {
        // Thread que não existe (id inventado, mensagem de outra conversa): o texto não some, vai como aviso.
        this.deps.post({ type: 'notice', level: 'info', text: `O Claude respondeu numa thread que não existe aqui (${b.id}): ${b.text}` });
        continue;
      }
      const from = b.as ? ({ from: 'agent', agentId: b.as } as const) : ({ from: 'claude' } as const);
      this.update(appendMessage({ ...thread, waiting: undefined }, { ...from, text: b.text, at: Date.now() }), false);
      changed = true;
    }
    if (changed) {
      this.save();
    }
  }

  /**
   * Mensagem escrita numa thread: aparece na thread e vai ao orquestrador embrulhada com o contexto. A thread de
   * uma fala ou mensagem do usuário nasce aqui, com o trecho da mãe que o webview mandou.
   */
  send(threadId: string, raw: string, hint?: ThreadParentHint): void {
    const text = raw.trim();
    const thread = this.threads.get(threadId) ?? this.newThread(threadId, hint);
    if (!text || !thread) {
      return;
    }
    const next = appendMessage({ ...thread, waiting: true }, { from: 'user', text, at: Date.now() });
    this.update(next);
    this.deps.toMain(wrapThreadMessage(threadId, this.parentForPrompt(next), text));
  }

  /** O orquestrador parou (fim do turno sem outro na fila, ou o processo caiu): nenhuma thread espera mais. */
  mainIdle(): void {
    for (const t of this.threads.values()) {
      if (t.waiting) {
        this.update({ ...t, waiting: undefined }, false);
      }
    }
  }

  // ---------- Internos ----------

  private newThread(id: string, hint?: ThreadParentHint): ChatThread | undefined {
    const kind = threadKind(id);
    if (kind === 'post') {
      const post = this.posts.find((p) => p.id === id);
      return post ? emptyThread(post) : undefined;
    }
    if (!hint) {
      return undefined;
    }
    const parent: ThreadParent = { kind, text: excerpt(hint.text), ...(hint.at ? { at: hint.at } : {}) };
    return { id, parent, messages: [] };
  }

  /** Mãe como o embrulho conta: no post, o texto dele (o do orquestrador ou a linha "Resumo:"). */
  private parentForPrompt(thread: ChatThread): ThreadParent {
    if (thread.parent.kind !== 'post') {
      return thread.parent;
    }
    const post = this.posts.find((p) => p.id === thread.id);
    return { ...thread.parent, text: post ? post.summary || reportHeadline(post.report) || '' : '' };
  }

  private update(thread: ChatThread, save = true): void {
    this.threads.set(thread.id, thread);
    this.deps.post({ type: 'thread', thread });
    if (save) {
      this.save();
    }
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
}
