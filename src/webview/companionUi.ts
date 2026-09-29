/**
 * Peças do chat lateral de consulta no webview. O main.ts usa o mesmo bundle para os dois chats; no lateral
 * (init com `companion`) ele esconde a orquestração e chama estas funções.
 */

import type { WebviewMessage } from '../chat/protocol';

export interface CompanionUiDeps {
  send: (msg: WebviewMessage) => void;
  /** Põe o texto na caixa de mensagem (sem enviar), ajusta a altura e dá foco. */
  setInput: (text: string) => void;
}

/** Ícone do botão do cabeçalho do chat principal que abre o lateral. */
export const COMPANION_ICON = 'comment-discussion';
export const COMPANION_OPEN_TITLE = 'Consulta lateral: tirar dúvidas, depurar e perguntar o que um agente está fazendo, sem interferir nesta conversa';

const SEND_CLASS = 'companion-send';
/** Onde o texto cru (markdown) de uma resposta fica guardado no elemento renderizado. */
const RAW_KEY = 'raw';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function codicon(name: string): HTMLSpanElement {
  return el('span', { class: `codicon codicon-${name}`, 'aria-hidden': 'true' });
}

export function createCompanionUi(deps: CompanionUiDeps) {
  const examplesBox = el('div', { class: 'empty-examples' });

  const banner = el(
    'div',
    { class: 'companion-banner', role: 'note' },
    codicon('lock'),
    el('span', {}, 'Consulta lateral · só leitura · não interfere no chat principal'),
  );

  const empty = el(
    'div',
    { class: 'empty companion-empty' },
    el('div', { class: 'logo' }, codicon(COMPANION_ICON)),
    el('p', { class: 'empty-title' }, 'O que você quer saber?'),
    el('p', {}, 'Pergunte sobre o projeto, peça ajuda para depurar ou pergunte o que um agente está fazendo. Esta conversa tem contexto próprio: nada daqui chega ao orquestrador, a não ser que você clique em "Enviar ao principal".'),
    examplesBox,
  );

  function setExamples(list: string[]): void {
    examplesBox.replaceChildren(
      ...list.map((text, i) => {
        const b = el('button', { class: 'empty-ex', type: 'button', title: 'Coloca esta pergunta na caixa de mensagem' }, codicon(['pulse', 'error', 'beaker'][i] ?? 'question'), el('span', {}, text));
        b.addEventListener('click', () => deps.setInput(text));
        return b;
      }),
    );
  }

  /** Guarda o markdown de uma resposta no elemento, para o botão enviar o texto original e não o renderizado. */
  function markRaw(node: HTMLElement, text: string): void {
    node.dataset[RAW_KEY] = text;
  }

  function sendButton(text: string): HTMLElement {
    const b = el('button', { class: SEND_CLASS, type: 'button', title: 'Manda esta resposta ao chat principal como mensagem sua. Só acontece com este clique.' }, codicon('send'), el('span', {}, 'Enviar ao principal'));
    b.addEventListener('click', () => {
      deps.send({ type: 'companionToMain', text });
      b.classList.add('sent');
      b.disabled = true;
      b.replaceChildren(codicon('check'), el('span', {}, 'Enviado ao principal'));
    });
    return el('div', { class: 'companion-send-row' }, b);
  }

  /**
   * Um botão por resposta: cada trecho entre duas mensagens do usuário é uma resposta, e o botão vai depois
   * do último texto dela, levando todos os textos do trecho. Trecho que já tem botão fica como está.
   * Chamar no fim de cada turno (`result`) e depois de carregar o histórico.
   */
  function decorate(log: HTMLElement): void {
    let group: HTMLElement[] = [];
    let done = false;
    const flush = () => {
      if (group.length && !done) {
        const last = group[group.length - 1];
        const text = group.map((n) => n.dataset[RAW_KEY] ?? '').filter((t) => t.trim()).join('\n\n');
        if (text.trim()) {
          last.after(sendButton(text));
        }
      }
      group = [];
      done = false;
    };
    for (const child of Array.from(log.children) as HTMLElement[]) {
      if (child.classList.contains('user')) {
        flush();
      } else if (child.classList.contains('companion-send-row')) {
        done = true;
      } else if (child.classList.contains('assistant') && child.dataset[RAW_KEY] !== undefined) {
        group.push(child);
      }
    }
    flush();
  }

  return { banner, empty, setExamples, markRaw, decorate };
}

export type CompanionUi = ReturnType<typeof createCompanionUi>;
