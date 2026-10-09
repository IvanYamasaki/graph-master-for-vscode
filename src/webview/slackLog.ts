/**
 * Log principal como um canal do Slack: toda mensagem à esquerda, com avatar, nome em negrito e hora; mensagens
 * seguidas do mesmo autor em até 5 min se juntam sob o mesmo cabeçalho (a hora aparece no hover, na margem). As
 * ferramentas do orquestrador ficam presas à fala dele. Os elementos do log continuam os mesmos do main.ts: aqui só
 * se põe o cabeçalho antes do primeiro de cada sequência e se marca o resto como continuação.
 */

import type { AgentInfo } from '../chat/protocol';
import { clockLabel } from '../chat/threadModel';

/** Quem fala: o usuário, o orquestrador, um agente (post e lugar ao vivo têm cabeçalho próprio) ou nota do sistema. */
export type Author = 'user' | 'claude' | 'agent' | 'meta';

/** Mensagens do mesmo autor com menos que isso entre elas ficam sob o mesmo cabeçalho. */
export const GROUP_MS = 5 * 60_000;

export interface RunMark {
  author: Author;
  /** Hora em ms; ausente no histórico (o transcrito não traz hora). */
  at?: number;
}

/** A mensagem nova continua a sequência anterior (sem repetir avatar e nome)? */
export function continuesRun(prev: RunMark | undefined, next: RunMark): boolean {
  if (!prev || prev.author !== next.author || next.author === 'agent' || next.author === 'meta') {
    return false;
  }
  // Histórico sem hora junta pelo autor; a primeira mensagem ao vivo depois dele ganha cabeçalho com hora.
  if (prev.at === undefined || next.at === undefined) {
    return prev.at === undefined && next.at === undefined;
  }
  return next.at - prev.at < GROUP_MS;
}

/** Quem é o autor de um elemento do log, pelas classes dele. */
export function authorOf(cls: { contains(c: string): boolean }): Author {
  if (cls.contains('post') || cls.contains('chat-slot') || cls.contains('report')) {
    return 'agent';
  }
  if (cls.contains('msg') && cls.contains('user')) {
    return 'user';
  }
  if (cls.contains('assistant') || cls.contains('tool-group') || cls.contains('tool') || cls.contains('img-bubble') || cls.contains('ext-block')) {
    return 'claude';
  }
  return 'meta';
}

/**
 * O agente ganha lugar no log principal (digitando, depois o post)? Só os do spawn_agent. Tarefa do SDK (Bash em
 * segundo plano, subagente nativo), continuação, job e busca ficam no mapa e no popup: no chat eram um cartão com as
 * iniciais do id da chamada ("too", de toolu_...).
 */
export function showsInChat(a: Pick<AgentInfo, 'kind' | 'taskType' | 'infra' | 'search'>): boolean {
  return a.kind === 'routed' && !a.taskType && !a.infra && !a.search;
}

function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** "Hoje", "Ontem" ou "quarta-feira, 7 de outubro". */
export function dayLabel(at: number, now: number): string {
  const day = new Date(at);
  const today = new Date(now);
  const diff = Math.round((Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - Date.UTC(day.getFullYear(), day.getMonth(), day.getDate())) / 86_400_000);
  if (diff === 0) {
    return 'Hoje';
  }
  if (diff === 1) {
    return 'Ontem';
  }
  return day.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', ...(day.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}

export interface SlackLogDeps {
  log: HTMLElement;
  /** "Claude" ou "Codex". */
  brand: () => string;
  /** Texto cru de uma mensagem, para o "Copiar". */
  rawText: (el: HTMLElement) => string;
  /** "Responder em thread" na mensagem: só aparece na que tem id de thread (`data-thread`). */
  onReply: (el: HTMLElement) => void;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = cls;
  if (text !== undefined) {
    el.textContent = text;
  }
  return el;
}

function codicon(name: string): HTMLElement {
  const el = node('span', `codicon codicon-${name}`);
  el.setAttribute('aria-hidden', 'true');
  return el;
}

export function createSlackLog(deps: SlackLogDeps) {
  const { log } = deps;
  let enabled = false;
  let replaying = false;
  let run: (RunMark & { head?: HTMLElement }) | undefined;
  let lastDay: string | undefined;
  /** Cabeçalho de cada primeira mensagem de sequência. */
  const heads = new WeakMap<HTMLElement, HTMLElement>();

  function header(author: 'user' | 'claude', at: number | undefined): HTMLElement {
    const head = node('div', `sl-head ${author}`);
    const av = node('span', `sl-av ${author}`);
    av.setAttribute('aria-hidden', 'true');
    if (author === 'user') {
      av.textContent = 'Eu';
    } else {
      av.append(codicon('sparkle'));
    }
    head.append(av, node('span', 'sl-name', author === 'user' ? 'Você' : deps.brand()));
    if (author === 'claude') {
      head.append(node('span', 'sl-badge', 'APP'));
    }
    if (at !== undefined) {
      const time = node('span', 'sl-time', clockLabel(at));
      time.title = new Date(at).toLocaleString('pt-BR');
      head.append(time);
    }
    return head;
  }

  function dayDivider(at: number): HTMLElement {
    const el = node('div', 'sl-day');
    el.setAttribute('role', 'separator');
    el.dataset.at = String(at);
    el.append(node('span', '', dayLabel(at, Date.now())));
    return el;
  }

  /** Elemento recém-posto no log: ganha cabeçalho, ou vira continuação da sequência anterior. */
  function stamp(el: HTMLElement): void {
    if (!enabled || el.parentElement !== log || el.classList.contains('empty')) {
      return;
    }
    const author = authorOf(el.classList);
    const at = replaying ? undefined : Date.now();
    if (author === 'meta') {
      // Nota do sistema (permissão, aviso, estatística do turno) fica entre as falas sem quebrar a sequência.
      el.classList.add('sl-meta');
      return;
    }
    if (author === 'agent') {
      run = { author, at };
      return;
    }
    el.classList.add('sl-body');
    const mark: RunMark = { author, at };
    if (continuesRun(run, mark) && run) {
      el.classList.add('sl-cont');
      if (at !== undefined) {
        el.dataset.slTime = clockLabel(at);
      }
      // O cabeçalho da sequência estava preso a uma fala que sumiu (só tinha o bloco <post>): passa para esta.
      if (run.head?.hidden) {
        el.before(run.head);
        run.head.hidden = false;
        heads.set(el, run.head);
      }
      run = { ...run, at: at ?? run.at };
      return;
    }
    if (at !== undefined && dayKey(at) !== lastDay) {
      lastDay = dayKey(at);
      el.before(dayDivider(at));
    }
    const head = header(author, at);
    el.before(head);
    heads.set(el, head);
    head.hidden = el.classList.contains('hidden');
    run = { author, at, head };
  }

  /** A fala mudou de visível para escondida (ou o contrário): o cabeçalho dela acompanha. */
  function refresh(el: HTMLElement): void {
    const head = heads.get(el);
    if (head && head.nextElementSibling === el) {
      head.hidden = el.classList.contains('hidden');
    }
  }

  function reset(): void {
    run = undefined;
    lastDay = undefined;
  }

  // Barra de ações no hover, no canto superior direito da mensagem, como no Slack. Um nó só, que muda de mensagem.
  const copyBtn = node('button', 'icon-btn sl-act');
  copyBtn.type = 'button';
  copyBtn.title = 'Copiar o texto';
  copyBtn.setAttribute('aria-label', 'Copiar o texto');
  copyBtn.append(codicon('copy'));
  const replyBtn = node('button', 'icon-btn sl-act');
  replyBtn.type = 'button';
  replyBtn.title = 'Responder em thread';
  replyBtn.setAttribute('aria-label', 'Responder em thread');
  replyBtn.append(codicon('comment-discussion'));
  replyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (barFor?.dataset.thread) {
      deps.onReply(barFor);
    }
  });
  const bar = node('div', 'sl-actions');
  bar.append(copyBtn, replyBtn);
  let barFor: HTMLElement | undefined;
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!barFor) {
      return;
    }
    const text = deps.rawText(barFor);
    void navigator.clipboard?.writeText(text).then(
      () => {
        copyBtn.replaceChildren(codicon('check'));
        window.setTimeout(() => copyBtn.replaceChildren(codicon('copy')), 1500);
      },
      () => undefined,
    );
  });
  log.addEventListener('mouseover', (e) => {
    if (!enabled) {
      return;
    }
    const msg = (e.target as Element).closest<HTMLElement>('.msg.user, .msg.assistant');
    if (msg && msg.parentElement === log && bar.parentElement !== msg) {
      barFor = msg;
      replyBtn.hidden = !msg.dataset.thread;
      msg.append(bar);
    }
  });

  // "Hoje" vira "Ontem" na virada do dia.
  window.setInterval(() => {
    const now = Date.now();
    log.querySelectorAll<HTMLElement>(':scope > .sl-day').forEach((d) => {
      const span = d.firstElementChild as HTMLElement | null;
      const text = dayLabel(Number(d.dataset.at), now);
      if (span && span.textContent !== text) {
        span.textContent = text;
      }
    });
  }, 60_000);

  return {
    stamp,
    refresh,
    reset,
    /** Cabeçalho avulso, igual ao das sequências, para quem monta um lugar fora do stamp (a fala do Claude que vai nascer). */
    header,
    /** Cabeçalho à vista logo antes desta fala, se ela abre a sequência. */
    headOf(el: HTMLElement): HTMLElement | undefined {
      const head = heads.get(el);
      return head && !head.hidden && head.nextElementSibling === el ? head : undefined;
    },
    setEnabled(on: boolean) {
      enabled = on;
      log.classList.toggle('slack', on);
    },
    setReplaying(on: boolean) {
      replaying = on;
    },
  };
}
