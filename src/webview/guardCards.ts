// Cartões do guarda no chat: orçamento esgotado e agente possivelmente preso. Usam o mesmo cartão de decisão
// da permissão e da tarefa proposta (.decision) e mudam no lugar quando o status volta do host. Resolvido, o
// cartão encolhe para uma linha.

import type { GuardAlert, WebviewMessage } from '../chat/protocol';

export interface GuardCardDeps {
  send: (msg: WebviewMessage) => void;
  /** Põe o cartão no fim do log do chat. */
  append: (el: HTMLElement) => void;
  /** Cor do agente (hex), a mesma do nó dele no grafo. */
  colorOf: (agentId: string) => string;
  /** Título do agente, para o cabeçalho não depender só do id. */
  agentName: (agentId: string) => string | undefined;
  /** Cartão pendente (el) ou resolvido (null), para a lista de decisões do composer. */
  onPending: (id: string, el: HTMLElement | null, label: string, detail: string, agentId: string) => void;
}

const DONE_LABEL: Record<GuardAlert['status'], string> = {
  pending: '',
  extended: 'orçamento ampliado',
  stopped: 'parado',
  ignored: 'ignorado',
  messaged: 'mensagem enviada',
  resolved: 'resolvido',
};

const TITLE: Record<GuardAlert['kind'], string> = {
  budget: 'Orçamento esgotado',
  stuck: 'Agente possivelmente preso',
  training: 'Alerta do treino',
};

const ICON: Record<GuardAlert['kind'], string> = {
  budget: 'dashboard',
  stuck: 'warning',
  training: 'pulse',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) {
    node.className = cls;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function button(label: string, cls: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  if (title) {
    b.title = title;
  }
  b.addEventListener('click', onClick);
  return b;
}

export function createGuardCards(deps: GuardCardDeps): { onAlert: (a: GuardAlert) => void } {
  const cards = new Map<string, HTMLElement>();

  function actionsFor(a: GuardAlert, card: HTMLElement): HTMLElement {
    const row = el('div', 'task-actions');
    const resolve = (action: 'extend' | 'stop' | 'ignore' | 'message', text?: string) => {
      // Trava os botões até o host devolver o status: dois cliques não viram duas ações.
      for (const b of card.querySelectorAll('button')) {
        b.disabled = true;
      }
      deps.send({ type: 'resolveGuard', id: a.id, action, text });
    };
    if (a.kind === 'budget') {
      row.append(
        button(`Dar mais ${a.extendPercent ?? 50}%`, 'primary', () => resolve('extend'), 'Aumenta cada limite e deixa o agente continuar de onde parou'),
        button('Parar de vez', 'task-ignore', () => resolve('stop'), 'Encerra o agente; quem receberia o relatório fica sabendo'),
      );
      return row;
    }
    if (a.kind === 'training') {
      // Vigia de treino: o job só é cancelado por este clique; o hub nunca para sozinho.
      row.append(button('Mandar ao agente responsável', 'primary', () => resolve('message'), 'Encaminha o alerta e as últimas linhas do log a quem pediu o job ou o vigia'));
      if (a.jobId) {
        row.append(button('Parar o job', '', () => resolve('stop'), `Cancela o job ${a.jobId}; o trabalho em andamento se perde`));
      }
      row.append(button('Ignorar', 'task-ignore', () => resolve('ignore'), 'Este tipo de alerta não volta neste vigia'));
      return row;
    }
    const box = el('div', 'guard-msg');
    box.hidden = true;
    const text = el('textarea', 'guard-msg-input');
    text.rows = 2;
    text.placeholder = 'Mensagem para o agente (ex.: pare de repetir e resuma o que já tem)';
    const go = button('Enviar', 'primary', () => text.value.trim() && resolve('message', text.value));
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        go.click();
      }
    });
    box.append(text, go);
    row.append(
      button('Mandar mensagem', 'primary', () => {
        box.hidden = false;
        text.focus();
      }),
      button('Parar', '', () => resolve('stop')),
      button('Ignorar', 'task-ignore', () => resolve('ignore'), 'Esconde o aviso até o agente voltar a progredir'),
    );
    const wrap = el('div', 'guard-actions');
    wrap.append(row, box);
    return wrap;
  }

  function onAlert(a: GuardAlert): void {
    let card = cards.get(a.id);
    const fresh = !card;
    if (!card) {
      card = el('div', 'msg task-card guard-card decision has-agent');
      card.setAttribute('role', 'group');
      cards.set(a.id, card);
    }
    const pending = a.status === 'pending';
    card.classList.toggle('done', !pending);
    card.style.setProperty('--agent', deps.colorOf(a.agentId));
    const name = deps.agentName(a.agentId) ?? a.agentId;
    card.setAttribute('aria-label', `${TITLE[a.kind]}: ${name}`);

    const head = el('div', 'dec-head');
    const ico = el('span', `codicon codicon-${ICON[a.kind]}`);
    ico.setAttribute('aria-hidden', 'true');
    const who = el('span', 'dec-who');
    const dot = el('span', 'agent-dot');
    dot.setAttribute('aria-hidden', 'true');
    who.append(dot, el('span', 'dec-who-name', name));
    who.title = `${name} (${a.agentId})`;
    const at = new Date(a.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    head.append(ico, el('span', 'dec-title', TITLE[a.kind]), who, el('div', 'spacer'), el('span', 'dec-meta', at));

    if (!pending) {
      // Resolvido: uma linha, com o texto do alerta no title para quem quiser relembrar.
      head.append(el('span', `task-status ${a.status === 'extended' || a.status === 'resolved' ? 'approved' : ''}`, a.note ?? DONE_LABEL[a.status]));
      card.title = a.summary ? `${a.text}\n\n${a.summary}` : a.text;
      card.replaceChildren(head);
    } else {
      card.removeAttribute('title');
      const body = el('div', 'guard-text', a.text);
      if (a.summary) {
        body.append(el('div', 'guard-summary', a.summary));
      }
      card.replaceChildren(head, body, actionsFor(a, card));
    }
    deps.onPending(a.id, pending ? card : null, `${TITLE[a.kind]}: ${name}`, a.text, a.agentId);
    if (fresh) {
      deps.append(card);
    }
  }

  return { onAlert };
}
