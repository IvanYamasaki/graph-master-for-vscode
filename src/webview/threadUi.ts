/**
 * Posts dos agentes no chat principal e a thread de cada um, como no Slack. Cada relatório entregue é um post
 * (avatar, nome, hora, o texto que o orquestrador escreveu em primeira pessoa e o relatório recolhido), com
 * "Responder em thread" no hover e o rodapé "12 respostas · Última resposta hoje às 14h24". A thread abre num
 * painel à direita; quem responde é uma leitura só leitura do agente, falando como ele. O host guarda posts e
 * threads; aqui só se desenha. Onde cada post fica no log é com o main.ts.
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
  threadFooter,
  type AgentPost,
  type PostThread,
  type ThreadMessage,
} from '../chat/threadModel';

export interface ThreadUiDeps {
  send: (msg: WebviewMessage) => void;
  agent: (id: string) => AgentInfo | undefined;
  paintAgent: (el: HTMLElement, a: AgentInfo) => void;
  /** Cor do agente mesmo quando ele já saiu da lista (conversa trocada, agente apagado). */
  colorOf: (agentId: string) => string;
  md: (el: HTMLElement, text: string) => void;
  statusLabel: (a: AgentInfo) => string;
  /** Pergunta sugerida na caixa quando a thread abre vazia (não é enviada). */
  suggest: (post: AgentPost) => string;
  /** Clique numa imagem de uma resposta: abre no visualizador ampliável. */
  openImage?: (src: string, caption: string) => void;
  /** Clique no avatar ou no nome: o popup do agente, ancorado no post. */
  openAgent: (anchor: HTMLElement, agentId: string) => void;
  /** Um post mudou (novo, texto do orquestrador, rodapé da thread): o main.ts põe no lugar ou repinta. */
  onPost: (post: AgentPost) => void;
  /** Lista inteira trocou (conversa aberta ou trocada). */
  onPosts: (posts: AgentPost[]) => void;
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

/** Hora relativa que o tique de 30 s mantém em dia. */
function timeEl(at: number, cls: string): HTMLElement {
  return el('span', { class: `${cls} thread-rel`.trim(), title: fullTime(at), 'data-at': String(at) }, relativeTime(at, Date.now()));
}

/** "Última resposta hoje às 14h24": o tique também a mantém (vira "ontem às" na virada do dia). */
function lastEl(at: number): HTMLElement {
  return el('span', { class: 'thread-last thread-lastrel', title: fullTime(at), 'data-at': String(at) }, lastReplyLabel(at, Date.now()));
}

export function createThreadUi(deps: ThreadUiDeps) {
  let posts: AgentPost[] = [];
  const threads = new Map<string, PostThread>();
  const status = new Map<string, string>();
  let openId: string | undefined;

  const head = el('div', { class: 'thread-head' });
  const parent = el('div', { class: 'thread-parent' });
  const replies = el('div', { class: 'thread-replies', role: 'log', 'aria-live': 'polite' });
  const live = el('div', { class: 'thread-live hidden' });
  const scroller = el('div', { class: 'thread-scroll' }, parent, replies, live);

  const input = el('textarea', { class: 'input', rows: '2', 'aria-label': 'Mensagem da thread' });
  const sendBtn = el('button', { class: 'send', type: 'button', title: 'Pergunta ao agente. Responde uma leitura só leitura dele, em primeira pessoa; nada chega ao agente nem à conversa principal.' }, 'Enviar');
  const stopBtn = el('button', { class: 'icon-btn hidden', type: 'button', title: 'Parar a resposta' }, codicon('debug-stop'));
  const hint = el('div', { class: 'hint' }, 'Só leitura: o agente responde pelo que fez, sem interferir na conversa principal.');
  const composer = el('div', { class: 'composer thread-composer' }, input, el('div', { class: 'row' }, hint, el('div', { class: 'spacer' }), stopBtn, sendBtn));

  const drawer = el('aside', { class: 'thread-drawer hidden', role: 'complementary', 'aria-label': 'Thread do post' }, head, scroller, composer);

  const postById = (id: string) => posts.find((p) => p.id === id);
  const nameOf = (agentId: string) => deps.agent(agentId)?.description || `Agente ${agentId}`;

  const submit = () => {
    const text = input.value.trim();
    if (!openId || !text) {
      return;
    }
    deps.send({ type: 'threadSend', postId: openId, text });
    input.value = '';
    autosize();
  };
  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  };
  sendBtn.addEventListener('click', submit);
  stopBtn.addEventListener('click', () => openId && deps.send({ type: 'threadInterrupt', postId: openId }));
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

  /** Avatar quadrado como no Slack: o do agente na cor dele, com o id; o do usuário, "Eu". */
  function avatar(from: ThreadMessage['from'], agentId: string, cls = ''): HTMLElement {
    const av = el('span', { class: `thread-av ${from} ${cls}`.trim(), 'aria-hidden': 'true' }, authorInitials(from, agentId));
    if (from === 'agent') {
      av.style.setProperty('--agm-color', deps.colorOf(agentId));
    }
    return av;
  }

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
    const av = avatar('agent', p.agentId, 'post-av');
    av.setAttribute('role', 'button');
    av.setAttribute('tabindex', '-1');
    av.title = `Abre o resumo de ${p.agentId}`;
    av.addEventListener('click', (e) => {
      e.stopPropagation();
      deps.openAgent(card, p.agentId);
    });
    const text = el('div', { class: 'md post-text' });
    deps.md(text, postText(p));
    const reply = el('button', { class: 'thread-reply icon-btn', type: 'button', title: 'Abre a thread deste post ao lado do chat. O agente responde em primeira pessoa, só lendo o que fez.' }, codicon('comment'), el('span', {}, 'Responder em thread'));
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
      el('div', { class: 'post-main' }, postHead(p, () => card), text, reportFold(p, 'Relatório completo'), footer(p)),
      el('div', { class: 'post-actions sl-actions' }, copy, reply),
    );
    return card;
  }

  /** Rodapé Slack: avatares de quem falou, "12 respostas" em azul e a hora da última. */
  function footer(p: AgentPost): HTMLElement | null {
    const t = threads.get(p.id);
    const summary = threadFooter(t, Date.now());
    if (!summary || !t) {
      return null;
    }
    const b = el(
      'button',
      { class: 'thread-link', type: 'button', title: 'Abrir a thread' },
      el('span', { class: 'thread-avs' }, ...participants(t).map((who) => avatar(who, p.agentId))),
      el('span', { class: 'thread-count' }, summary.count),
      lastEl(t.messages.at(-1)!.at),
      t.waiting ? codicon('loading', true) : null,
    );
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      open(p.id);
    });
    return el('div', { class: 'thread-foot' }, b);
  }

  function renderHead(p: AgentPost): void {
    const a = deps.agent(p.agentId);
    const narrow = window.innerWidth < NARROW_PX;
    const back = el('button', { class: 'icon-btn thread-back', type: 'button', title: 'Voltar ao chat' }, codicon('arrow-left'), el('span', {}, 'Voltar'));
    back.addEventListener('click', close);
    const closeBtn = el('button', { class: 'icon-btn square', type: 'button', title: 'Fechar a thread', 'aria-label': 'Fechar a thread' }, codicon('close'));
    closeBtn.addEventListener('click', close);
    const many = postsOf(posts, p.agentId).length > 1;
    const parts: (Node | null)[] = [
      narrow ? back : null,
      el(
        'div',
        { class: 'thread-title' },
        el('div', { class: 'thread-name' }, el('span', {}, 'Thread'), el('span', { class: 'thread-who' }, nameOf(p.agentId))),
        el('div', { class: 'thread-sub' }, [many ? `relatório ${p.n} de ${p.agentId}` : p.agentId, a ? deps.statusLabel(a) : ''].filter(Boolean).join(' · ')),
      ),
      closeBtn,
    ];
    head.replaceChildren(...(parts.filter(Boolean) as Node[]));
    drawer.style.setProperty('--agm-color', deps.colorOf(p.agentId));
  }

  /** Mensagem-mãe: o post, com o relatório recolhido. */
  function renderParent(p: AgentPost): void {
    const text = el('div', { class: 'md post-text' });
    deps.md(text, postText(p));
    parent.replaceChildren(
      avatar('agent', p.agentId, 'post-av'),
      el('div', { class: 'post-main' }, postHead(p, () => parent), text, reportFold(p, 'Relatório completo')),
    );
  }

  function messageEl(m: ThreadMessage, p: AgentPost): HTMLElement {
    const body = el('div', { class: 'md thread-body' });
    deps.md(body, m.text);
    body.querySelectorAll('img').forEach((img) => {
      img.classList.add('thread-img');
      img.addEventListener('click', () => deps.openImage?.(img.src, img.alt));
    });
    return el(
      'div',
      { class: `thread-msg ${m.from}${m.error ? ' error' : ''}` },
      avatar(m.from, p.agentId),
      el(
        'div',
        { class: 'thread-msg-main' },
        el('div', { class: 'thread-msg-head' }, el('span', { class: 'thread-author' }, authorName(m.from, p.agentId, deps.agent(p.agentId)?.description)), timeEl(m.at, 'thread-time')),
        body,
      ),
    );
  }

  function renderReplies(): void {
    const p = openId ? postById(openId) : undefined;
    if (!p) {
      return;
    }
    const t = threads.get(p.id);
    const stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    const n = t?.messages.length ?? 0;
    replies.replaceChildren(
      el('div', { class: 'thread-divider' }, el('span', {}, n ? `${n} ${n === 1 ? 'resposta' : 'respostas'}` : 'Nenhuma resposta ainda')),
      ...(t?.messages ?? []).map((m) => messageEl(m, p)),
    );
    renderLive();
    if (stick) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }

  /** Linha de "digitando": os pontinhos na cor do agente e o que ele está relendo. */
  function renderLive(): void {
    const p = openId ? postById(openId) : undefined;
    if (!p) {
      return;
    }
    const waiting = !!threads.get(p.id)?.waiting;
    stopBtn.classList.toggle('hidden', !waiting);
    if (!waiting) {
      live.classList.add('hidden');
      return;
    }
    const dots = typingDots();
    dots.style.setProperty('--lb-color', 'var(--agm-color)');
    live.replaceChildren(dots, el('span', {}, `${nameOf(p.agentId)} ${status.get(p.id) ?? 'digitando'}…`));
    live.classList.remove('hidden');
  }

  function open(id: string): void {
    const p = postById(id);
    if (!p) {
      return;
    }
    const changed = openId !== id;
    openId = id;
    renderHead(p);
    renderParent(p);
    input.placeholder = `Responda a ${nameOf(p.agentId)}. Enter envia, Shift+Enter quebra linha`;
    renderReplies();
    drawer.classList.remove('hidden');
    document.body.classList.add('thread-open');
    if (changed) {
      input.value = threads.get(id)?.messages.length ? '' : deps.suggest(p);
      autosize();
      scroller.scrollTop = 0;
    }
    input.focus();
  }

  /** Thread do post mais recente do agente. Falso se ele ainda não entregou relatório. */
  function openLatest(agentId: string): boolean {
    const p = postsOf(posts, agentId).at(-1);
    if (p) {
      open(p.id);
    }
    return !!p;
  }

  function close(): void {
    openId = undefined;
    drawer.classList.add('hidden');
    document.body.classList.remove('thread-open');
  }

  /** Lista inteira (conversa aberta, retomada ou trocada). */
  function setAll(list: AgentPost[], threadList: PostThread[]): void {
    posts = [...list].sort((a, b) => a.at - b.at);
    threads.clear();
    status.clear();
    for (const t of threadList) {
      threads.set(t.postId, t);
    }
    deps.onPosts(posts);
    if (openId && !postById(openId)) {
      close();
    } else if (openId) {
      open(openId);
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
      renderHead(p);
      renderParent(p);
    }
  }

  function upsertThread(t: PostThread): void {
    threads.set(t.postId, t);
    if (!t.waiting) {
      status.delete(t.postId);
    }
    const p = postById(t.postId);
    if (p) {
      deps.onPost(p);
    }
    if (openId === t.postId) {
      renderReplies();
    }
  }

  function setStatus(postId: string, text?: string): void {
    if (text) {
      status.set(postId, text);
    } else {
      status.delete(postId);
    }
    if (openId === postId) {
      renderLive();
    }
  }

  /** O agente mudou (nome, estado): o cabeçalho da thread aberta acompanha. */
  function refreshAgent(agentId: string): void {
    const p = openId ? postById(openId) : undefined;
    if (p?.agentId === agentId) {
      renderHead(p);
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
    const p = openId ? postById(openId) : undefined;
    if (narrow !== wasNarrow && p) {
      renderHead(p);
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
    renderPost,
    setAll,
    upsertPost,
    upsertThread,
    setStatus,
    refreshAgent,
  };
}

export type ThreadUi = ReturnType<typeof createThreadUi>;
