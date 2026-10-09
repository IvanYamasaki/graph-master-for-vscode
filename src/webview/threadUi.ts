/**
 * Posts dos agentes no chat principal e as threads, como no Slack. Cada relatório entregue é um post (avatar, nome,
 * hora, o texto que o orquestrador escreveu em primeira pessoa e o relatório recolhido), e qualquer mensagem do chat
 * (post, fala do Claude, mensagem do usuário) pode ter thread: "Responder em thread" no hover e o rodapé
 * "12 respostas · Última resposta hoje às 14h24". A thread abre num painel à direita; o que se escreve nela vai ao
 * Claude da conversa principal, que responde na thread (ou no chat). O host guarda posts e threads; aqui só se
 * desenha. Onde cada post fica no log, e o rodapé das outras mensagens, é com o main.ts.
 */

import type { AgentInfo, WebviewMessage } from '../chat/protocol';
import { reportHeadline } from '../chat/headline';
import { typingDots } from './liveBubbles';
import {
  authorInitials,
  authorName,
  clockLabel,
  lastReplyLabel,
  participants,
  postsOf,
  relativeTime,
  resolveThreadId,
  threadFooter,
  threadKind,
  type AgentPost,
  type ChatThread,
  type ThreadMessage,
  type ThreadSpeaker,
} from '../chat/threadModel';

/** Mãe de uma thread que pende de uma fala ou de uma mensagem do usuário: o trecho e a hora, quando se sabe. */
export interface ParentHint {
  text: string;
  at?: number;
}

export interface ThreadUiDeps {
  send: (msg: WebviewMessage) => void;
  agent: (id: string) => AgentInfo | undefined;
  /** Cor do agente mesmo quando ele já saiu da lista (conversa trocada, agente apagado). */
  colorOf: (agentId: string) => string;
  md: (el: HTMLElement, text: string) => void;
  statusLabel: (a: AgentInfo) => string;
  /** "Claude" ou "Codex". */
  brand: () => string;
  /** Pergunta sugerida na caixa quando a thread de um post abre vazia (não é enviada). */
  suggest: (post: AgentPost) => string;
  /** Clique numa imagem de uma resposta: abre no visualizador ampliável. */
  openImage?: (src: string, caption: string) => void;
  /** Clique no avatar ou no nome: o popup do agente, ancorado no post. */
  openAgent: (anchor: HTMLElement, agentId: string) => void;
  /** Mensagem do log (fala ou mensagem do usuário) a que uma thread nova vai pender. */
  parentOf: (id: string) => ParentHint | undefined;
  /** Um post mudou (novo, texto do orquestrador, rodapé da thread): o main.ts põe no lugar ou repinta. */
  onPost: (post: AgentPost) => void;
  /** Lista inteira trocou (conversa aberta ou trocada). */
  onPosts: (posts: AgentPost[]) => void;
  /** A thread de uma fala ou mensagem do usuário mudou (ou todas, sem id): o main.ts repinta o rodapé no log. */
  onThread: (id?: string) => void;
}

/** Abaixo desta largura a thread ocupa a tela inteira, com botão de voltar. */
const NARROW_PX = 760;
const TICK_MS = 30_000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, v);
  }
  node.append(...(children.filter(Boolean) as (Node | string)[]));
  return node;
}

function codicon(name: string, spin = false): HTMLSpanElement {
  return el('span', { class: `codicon codicon-${name}${spin ? ' codicon-modifier-spin' : ''}`, 'aria-hidden': 'true' });
}

function fullTime(at: number): string {
  return new Date(at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Hora relativa que o tique de 30 s mantém em dia. Sem hora (veio do transcrito), nada. */
function timeEl(at: number, cls: string): HTMLElement | null {
  return at ? el('span', { class: `${cls} thread-rel`.trim(), title: fullTime(at), 'data-at': String(at) }, relativeTime(at, Date.now())) : null;
}

/** "Última resposta hoje às 14h24": o tique também a mantém (vira "ontem às" na virada do dia). */
function lastEl(at: number | undefined): HTMLElement | null {
  return at ? el('span', { class: 'thread-last thread-lastrel', title: fullTime(at), 'data-at': String(at) }, lastReplyLabel(at, Date.now())) : null;
}

export function createThreadUi(deps: ThreadUiDeps) {
  let posts: AgentPost[] = [];
  const threads = new Map<string, ChatThread>();
  let openId: string | undefined;
  /** Mãe da thread aberta que ainda não existe no host (fala ou mensagem do usuário sem resposta nenhuma). */
  let openHint: ParentHint | undefined;

  const head = el('div', { class: 'thread-head' });
  const parent = el('div', { class: 'thread-parent' });
  const replies = el('div', { class: 'thread-replies', role: 'log', 'aria-live': 'polite' });
  const live = el('div', { class: 'thread-live hidden' });
  const scroller = el('div', { class: 'thread-scroll' }, parent, replies, live);

  const input = el('textarea', { class: 'input', rows: '2', 'aria-label': 'Mensagem da thread' });
  const sendBtn = el('button', { class: 'send', type: 'button', title: 'Manda ao Claude da conversa principal, com o contexto desta thread. A resposta vem aqui ou no chat.' }, 'Enviar');
  const hint = el('div', { class: 'hint' }, 'Vai ao Claude da conversa principal. Ele responde aqui ou no chat, se o assunto for da conversa toda.');
  const composer = el('div', { class: 'composer thread-composer' }, input, el('div', { class: 'row' }, hint, el('div', { class: 'spacer' }), sendBtn));

  const drawer = el('aside', { class: 'thread-drawer hidden', role: 'complementary', 'aria-label': 'Thread' }, head, scroller, composer);

  const postById = (id: string) => posts.find((p) => p.id === id);
  const nameOf = (agentId: string) => deps.agent(agentId)?.description || `Agente ${agentId}`;
  const isPost = (id: string) => threadKind(id) === 'post';

  const submit = () => {
    const text = input.value.trim();
    if (!openId || !text) {
      return;
    }
    // Thread que ainda não existe leva a mãe: o host guarda o trecho e o põe no embrulho.
    const known = threads.has(openId) || isPost(openId);
    deps.send({ type: 'threadSend', threadId: openId, text, parent: known ? undefined : openHint });
    input.value = '';
    autosize();
  };
  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  };
  sendBtn.addEventListener('click', submit);
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  drawer.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });

  /** Avatar quadrado como no Slack: o do agente na cor dele, com o id; o do usuário, "Eu"; o do Claude, o ícone. */
  function avatar(who: ThreadSpeaker, cls = ''): HTMLElement {
    const av = el('span', { class: `thread-av ${who.from} ${cls}`.trim(), 'aria-hidden': 'true' });
    if (who.from === 'claude') {
      av.append(codicon('sparkle'));
    } else {
      av.textContent = authorInitials(who);
    }
    if (who.from === 'agent' && who.agentId) {
      av.style.setProperty('--agm-color', deps.colorOf(who.agentId));
    }
    return av;
  }

  const speakerName = (who: ThreadSpeaker) => authorName(who, who.agentId ? deps.agent(who.agentId)?.description : undefined, deps.brand());

  /** Texto do post: o do orquestrador, senão a linha "Resumo:" do relatório. */
  function postText(p: AgentPost): string {
    return p.summary || reportHeadline(p.report) || 'Entreguei o relatório.';
  }

  /** Relatório recolhido; o Markdown só é montado quando abre (relatório grande não pesa no log). */
  function reportFold(p: AgentPost, label: string, open = false): HTMLDetailsElement {
    const body = el('div', { class: 'md post-report-body' });
    const fold = el('details', { class: 'post-report' }, el('summary', {}, codicon('chevron-right'), el('span', {}, label)), body);
    const fill = () => {
      if (!body.childElementCount && !body.textContent) {
        deps.md(body, p.report);
      }
    };
    fold.addEventListener('toggle', () => fold.open && fill());
    if (open) {
      fold.open = true;
      fill();
    }
    return fold;
  }

  function postHead(p: AgentPost, anchor: () => HTMLElement): HTMLElement {
    const name = el('button', { class: 'post-name', type: 'button', title: `Abre o resumo de ${p.agentId}` }, nameOf(p.agentId));
    name.addEventListener('click', (e) => {
      e.stopPropagation();
      deps.openAgent(anchor(), p.agentId);
    });
    const many = postsOf(posts, p.agentId).length > 1;
    return el(
      'div',
      { class: 'post-head' },
      name,
      el('span', { class: 'post-id' }, many ? `${p.agentId} · relatório ${p.n}` : p.agentId),
      el('span', { class: 'post-time', title: fullTime(p.at) }, clockLabel(p.at)),
    );
  }

  /**
   * Post de um relatório no chat. `into` reaproveita o nó que já está na tela (a posição no log fica). O rodapé da
   * thread aparece quando há conversa; sem conversa, "Responder em thread" só no hover.
   */
  function renderPost(p: AgentPost, into?: HTMLElement): HTMLElement {
    const card = into ?? el('div', { class: 'post', role: 'article' });
    card.className = 'post';
    card.dataset.post = p.id;
    card.dataset.agent = p.agentId;
    card.setAttribute('aria-label', `${nameOf(p.agentId)}, ${clockLabel(p.at)}`);
    card.style.setProperty('--agm-color', deps.colorOf(p.agentId));
    const av = avatar({ from: 'agent', agentId: p.agentId }, 'post-av');
    av.setAttribute('role', 'button');
    av.setAttribute('tabindex', '-1');
    av.title = `Abre o resumo de ${p.agentId}`;
    av.addEventListener('click', (e) => {
      e.stopPropagation();
      deps.openAgent(card, p.agentId);
    });
    const text = el('div', { class: 'md post-text' });
    deps.md(text, postText(p));
    const reply = el('button', { class: 'thread-reply icon-btn', type: 'button', title: 'Abre a thread deste post ao lado do chat. O Claude responde nela, como ele mesmo ou na voz do agente.' }, codicon('comment'), el('span', {}, 'Responder em thread'));
    reply.addEventListener('click', (e) => {
      e.stopPropagation();
      open(p.id);
    });
    const copy = el('button', { class: 'icon-btn sl-act', type: 'button', title: 'Copiar o texto do post', 'aria-label': 'Copiar o texto do post' }, codicon('copy'));
    copy.addEventListener('click', (e) => {
      e.stopPropagation();
      void navigator.clipboard?.writeText(postText(p)).then(
        () => {
          copy.replaceChildren(codicon('check'));
          window.setTimeout(() => copy.replaceChildren(codicon('copy')), 1500);
        },
        () => undefined,
      );
    });
    card.replaceChildren(
      av,
      el('div', { class: 'post-main' }, postHead(p, () => card), text, reportFold(p, 'Relatório completo'), footerFor(p.id)),
      el('div', { class: 'post-actions sl-actions' }, copy, reply),
    );
    return card;
  }

  /** Rodapé Slack de qualquer mensagem com thread: avatares de quem falou, "12 respostas" em azul e a hora da última. */
  function footerFor(id: string): HTMLElement | null {
    const t = threads.get(id);
    const summary = threadFooter(t, Date.now());
    if (!summary || !t) {
      return null;
    }
    const b = el(
      'button',
      { class: 'thread-link', type: 'button', title: 'Abrir a thread' },
      el('span', { class: 'thread-avs' }, ...participants(t).map((who) => avatar(who))),
      el('span', { class: 'thread-count' }, summary.count),
      lastEl(t.messages.at(-1)?.at),
      t.waiting ? codicon('loading', true) : null,
    );
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      open(id);
    });
    return el('div', { class: 'thread-foot' }, b);
  }

  /** Mãe da thread aberta: o post, ou o trecho guardado da fala ou da mensagem do usuário. */
  function parentHint(id: string): ParentHint | undefined {
    const t = threads.get(id);
    if (t && t.parent.text) {
      return { text: t.parent.text, at: t.parent.at };
    }
    return deps.parentOf(id) ?? (t ? { text: '', at: t.parent.at } : undefined);
  }

  function renderHead(id: string): void {
    const p = postById(id);
    const a = p ? deps.agent(p.agentId) : undefined;
    const narrow = window.innerWidth < NARROW_PX;
    const back = el('button', { class: 'icon-btn thread-back', type: 'button', title: 'Voltar ao chat' }, codicon('arrow-left'), el('span', {}, 'Voltar'));
    back.addEventListener('click', close);
    const closeBtn = el('button', { class: 'icon-btn square', type: 'button', title: 'Fechar a thread', 'aria-label': 'Fechar a thread' }, codicon('close'));
    closeBtn.addEventListener('click', close);
    let who: string;
    let sub: string;
    if (p) {
      who = nameOf(p.agentId);
      sub = [postsOf(posts, p.agentId).length > 1 ? `relatório ${p.n} de ${p.agentId}` : p.agentId, a ? deps.statusLabel(a) : ''].filter(Boolean).join(' · ');
    } else {
      who = threadKind(id) === 'user' ? 'sua mensagem' : `fala do ${deps.brand()}`;
      sub = 'conversa principal';
    }
    const parts: (Node | null)[] = [
      narrow ? back : null,
      el('div', { class: 'thread-title' }, el('div', { class: 'thread-name' }, el('span', {}, 'Thread'), el('span', { class: 'thread-who' }, who)), el('div', { class: 'thread-sub' }, sub)),
      closeBtn,
    ];
    head.replaceChildren(...(parts.filter(Boolean) as Node[]));
    if (p) {
      drawer.style.setProperty('--agm-color', deps.colorOf(p.agentId));
    } else {
      drawer.style.removeProperty('--agm-color');
    }
  }

  /** Mensagem-mãe no topo da thread: o post com o relatório recolhido, ou a fala ou mensagem do usuário. */
  function renderParent(id: string): void {
    const p = postById(id);
    const text = el('div', { class: 'md post-text' });
    if (p) {
      deps.md(text, postText(p));
      parent.replaceChildren(avatar({ from: 'agent', agentId: p.agentId }, 'post-av'), el('div', { class: 'post-main' }, postHead(p, () => parent), text, reportFold(p, 'Relatório completo')));
      return;
    }
    const hintNow = parentHint(id) ?? openHint;
    const who: ThreadSpeaker = { from: threadKind(id) === 'user' ? 'user' : 'claude' };
    deps.md(text, hintNow?.text || '(mensagem do chat)');
    const at = hintNow?.at;
    parent.replaceChildren(
      avatar(who, 'post-av'),
      el(
        'div',
        { class: 'post-main' },
        el('div', { class: 'post-head' }, el('span', { class: 'post-name static' }, speakerName(who)), at ? el('span', { class: 'post-time', title: fullTime(at) }, clockLabel(at)) : null),
        text,
      ),
    );
  }

  function messageEl(m: ThreadMessage): HTMLElement {
    const body = el('div', { class: 'md thread-body' });
    deps.md(body, m.text);
    body.querySelectorAll('img').forEach((img) => {
      img.classList.add('thread-img');
      img.addEventListener('click', () => deps.openImage?.(img.src, img.alt));
    });
    const who: ThreadSpeaker = m.from === 'agent' ? { from: 'agent', agentId: m.agentId } : { from: m.from };
    return el(
      'div',
      { class: `thread-msg ${m.from}${m.error ? ' error' : ''}` },
      avatar(who),
      el('div', { class: 'thread-msg-main' }, el('div', { class: 'thread-msg-head' }, el('span', { class: 'thread-author' }, speakerName(who)), timeEl(m.at, 'thread-time')), body),
    );
  }

  function renderReplies(): void {
    if (!openId) {
      return;
    }
    const t = threads.get(openId);
    const stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    const n = t?.messages.length ?? 0;
    replies.replaceChildren(
      el('div', { class: 'thread-divider' }, el('span', {}, n ? `${n} ${n === 1 ? 'resposta' : 'respostas'}` : 'Nenhuma resposta ainda')),
      ...(t?.messages ?? []).map(messageEl),
    );
    renderLive();
    if (stick) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }

  /** Linha de "digitando" enquanto o orquestrador não respondeu (ele pode estar terminando outro turno antes). */
  function renderLive(): void {
    const waiting = !!(openId && threads.get(openId)?.waiting);
    if (!waiting) {
      live.classList.add('hidden');
      return;
    }
    const dots = typingDots();
    dots.style.setProperty('--lb-color', 'var(--agm-color, var(--accent))');
    live.replaceChildren(dots, el('span', {}, `${deps.brand()} vai responder aqui ou no chat…`));
    live.classList.remove('hidden');
  }

  /** Abre a thread de uma mensagem. Falso quando não há mãe conhecida (post que sumiu, mensagem fora do log). */
  function open(id: string): boolean {
    const known = !!postById(id) || threads.has(id);
    const hintNow = known ? undefined : deps.parentOf(id);
    if (!known && !hintNow) {
      return false;
    }
    const changed = openId !== id;
    openId = id;
    openHint = hintNow ?? (changed ? undefined : openHint);
    renderHead(id);
    renderParent(id);
    const p = postById(id);
    input.placeholder = p ? `Responda na thread de ${nameOf(p.agentId)}. Enter envia, Shift+Enter quebra linha` : 'Responda na thread. Enter envia, Shift+Enter quebra linha';
    renderReplies();
    drawer.classList.remove('hidden');
    document.body.classList.add('thread-open');
    if (changed) {
      input.value = p && !threads.get(id)?.messages.length ? deps.suggest(p) : '';
      autosize();
      scroller.scrollTop = 0;
    }
    input.focus();
    return true;
  }

  /** Thread do post mais recente do agente. Falso se ele ainda não entregou relatório. */
  function openLatest(agentId: string): boolean {
    const p = postsOf(posts, agentId).at(-1);
    return p ? open(p.id) : false;
  }

  function close(): void {
    openId = undefined;
    openHint = undefined;
    drawer.classList.add('hidden');
    document.body.classList.remove('thread-open');
  }

  /** Lista inteira (conversa aberta, retomada ou trocada). */
  function setAll(list: AgentPost[], threadList: ChatThread[]): void {
    posts = [...list].sort((a, b) => a.at - b.at);
    threads.clear();
    for (const t of threadList) {
      threads.set(t.id, t);
    }
    deps.onPosts(posts);
    deps.onThread();
    if (openId && !open(openId)) {
      close();
    }
  }

  function upsertPost(p: AgentPost): void {
    posts = [...posts.filter((q) => q.id !== p.id), p].sort((a, b) => a.at - b.at);
    deps.onPost(p);
    // Segundo relatório do mesmo agente: os posts anteriores passam a dizer "relatório 1".
    for (const q of postsOf(posts, p.agentId)) {
      if (q.id !== p.id && p.n === 2 && q.n === 1) {
        deps.onPost(q);
      }
    }
    if (openId === p.id) {
      renderHead(p.id);
      renderParent(p.id);
    }
  }

  function upsertThread(t: ChatThread): void {
    threads.set(t.id, t);
    const p = postById(t.id);
    if (p) {
      deps.onPost(p);
    } else {
      deps.onThread(t.id);
    }
    if (openId === t.id) {
      renderReplies();
    }
  }

  /** O agente mudou (nome, estado): o cabeçalho da thread aberta acompanha. */
  function refreshAgent(agentId: string): void {
    const p = openId ? postById(openId) : undefined;
    if (p?.agentId === agentId) {
      renderHead(p.id);
    }
  }

  // Horas relativas na tela andam sozinhas; largura que cruza o limite troca o botão de voltar.
  window.setInterval(() => {
    const now = Date.now();
    document.querySelectorAll<HTMLElement>('.thread-rel').forEach((node) => {
      const text = relativeTime(Number(node.dataset.at), now);
      if (node.textContent !== text) {
        node.textContent = text;
      }
    });
    document.querySelectorAll<HTMLElement>('.thread-lastrel').forEach((node) => {
      const text = lastReplyLabel(Number(node.dataset.at), now);
      if (node.textContent !== text) {
        node.textContent = text;
      }
    });
  }, TICK_MS);
  let wasNarrow = window.innerWidth < NARROW_PX;
  window.addEventListener('resize', () => {
    const narrow = window.innerWidth < NARROW_PX;
    if (narrow !== wasNarrow && openId) {
      renderHead(openId);
    }
    wasNarrow = narrow;
  });

  return {
    drawer,
    open,
    openLatest,
    close,
    get openId() {
      return openId;
    },
    hasPosts: (agentId: string) => posts.some((p) => p.agentId === agentId),
    postsOf: (agentId: string) => postsOf(posts, agentId),
    /** Thread de destino de um bloco <thread id="..."> do orquestrador (o id dele pode ser só o agente). */
    resolve: (id: string) => resolveThreadId(id, posts, (x) => threads.has(x)),
    renderPost,
    footerFor,
    setAll,
    upsertPost,
    upsertThread,
    refreshAgent,
  };
}

export type ThreadUi = ReturnType<typeof createThreadUi>;
