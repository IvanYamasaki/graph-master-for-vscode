// Sinais de vida do chat: balão "digitando", balão de pensamento e a faixa dos agentes que estão trabalhando.
// Tudo nasce de eventos reais (turno do chat principal, status "rodando" de um agente, deltas de texto, thinking e
// chamadas de ferramenta). Sem trabalho em andamento não há balão, timer nem animação. A faixa fica fora do log:
// só mexe na rolagem de quem já estava colado no fim.

import { LiveModel, fmtElapsed, type ActorView, type BubbleKind } from './liveLogic';

export interface LiveBubblesDeps {
  /** O log do chat: a faixa só o reajusta (colado no fim) quando muda de altura. */
  log: HTMLElement;
  /** Cor (hex) do ator; "main" usa a cor de destaque. */
  colorOf: (id: string) => string;
  /** Nome que aparece no balão. */
  labelOf: (id: string) => string;
  /** Clique numa linha de agente (abrir o cartão dele). */
  onOpen?: (id: string, anchor: HTMLElement) => void;
}

/** Linhas visíveis ao mesmo tempo; o resto vira "+N". */
const MAX_ROWS = 4;
const MAIN_ID = 'main';

interface Row {
  el: HTMLElement;
  name: HTMLElement;
  slot: HTMLElement;
  time: HTMLElement;
  kind: BubbleKind | '';
  text: string;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = cls;
  if (text !== undefined) {
    el.textContent = text;
  }
  return el;
}

/** Os três pontinhos. Com movimento reduzido o CSS troca a animação por reticências estáticas. */
export function typingDots(): HTMLElement {
  const el = node('span', 'lb-bubble lb-typing');
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', 'digitando');
  for (let i = 0; i < 3; i++) {
    el.append(node('i', 'lb-dot'));
  }
  return el;
}

function bubbleFor(kind: BubbleKind, text: string): HTMLElement | undefined {
  if (kind === 'typing') {
    return typingDots();
  }
  if (kind === 'thought') {
    const el = node('span', 'lb-bubble lb-thought');
    el.append(node('span', 'lb-thought-text', text));
    return el;
  }
  return undefined;
}

export function createLiveBubbles(deps: LiveBubblesDeps) {
  const model = new LiveModel();
  const tray = node('div', 'live-tray hidden');
  tray.setAttribute('aria-live', 'off');
  const rows = new Map<string, Row>();
  const more = node('div', 'lb-more hidden');
  tray.append(more);
  let enabled = true;
  let wake: number | undefined;
  let tick: number | undefined;

  const motionOk = () => !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  function applyEnabled(): void {
    const anim = enabled && motionOk();
    if (anim && !document.body.classList.contains('live-anim')) {
      // Ligar a classe reinicia a animação de entrada em tudo que ela casa: o que já está no log (histórico
      // repintado com a animação pausada, ou o log de antes de religar) fica marcado e não pisca.
      for (const el of document.querySelectorAll('.log > *')) {
        el.classList.add('lb-settled');
      }
    }
    document.body.classList.toggle('live-on', enabled);
    document.body.classList.toggle('live-anim', anim);
  }

  /** Muda o conteúdo da faixa sem empurrar a rolagem de quem lia o fim do log. */
  function relayout(fn: () => void): void {
    const log = deps.log;
    const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 160;
    fn();
    if (stick) {
      log.scrollTop = log.scrollHeight;
    }
  }

  function makeRow(id: string): Row {
    const el = node('div', `lb-row${id === MAIN_ID ? ' main' : ''}`);
    el.style.setProperty('--lb-color', deps.colorOf(id));
    const avatar = node('span', 'lb-avatar');
    const name = node('span', 'lb-name', deps.labelOf(id));
    const slot = node('span', 'lb-slot');
    const time = node('span', 'lb-time');
    el.append(avatar, name, slot, time);
    if (id !== MAIN_ID && deps.onOpen) {
      el.classList.add('clickable');
      el.addEventListener('click', () => deps.onOpen?.(id, el));
    }
    return { el, name, slot, time, kind: '', text: '' };
  }

  function paintRow(row: Row, v: ActorView): void {
    row.time.textContent = fmtElapsed(v.elapsedMs);
    if (row.kind === v.kind && row.text === v.text) {
      return;
    }
    row.kind = v.kind;
    row.text = v.text;
    const bubble = bubbleFor(v.kind, v.text);
    row.slot.replaceChildren(...(bubble ? [bubble] : [node('span', 'lb-idle', 'trabalhando')]));
  }

  /** Reconstrói as linhas que mudaram. Chamado só quando um evento muda o conjunto ou o texto de alguém. */
  function render(): void {
    const now = Date.now();
    relayout(() => {
      const ids = model.ids();
      const shown = ids.slice(0, MAX_ROWS);
      for (const [id, row] of rows) {
        if (!shown.includes(id)) {
          row.el.remove();
          rows.delete(id);
        }
      }
      for (const id of shown) {
        let row = rows.get(id);
        if (!row) {
          row = makeRow(id);
          rows.set(id, row);
          tray.insertBefore(row.el, more);
        }
        row.name.textContent = deps.labelOf(id);
        const v = model.view(id, now);
        if (v) {
          paintRow(row, v);
        }
      }
      const extra = ids.length - shown.length;
      more.classList.toggle('hidden', extra <= 0);
      more.textContent = extra > 0 ? `+${extra} trabalhando` : '';
      tray.classList.toggle('hidden', !enabled || !ids.length);
    });
    schedule();
  }

  /** Um timer de 1 s para os contadores e um para a próxima troca de texto; ambos só existem com gente trabalhando. */
  function schedule(): void {
    if (!enabled || !model.active) {
      window.clearInterval(tick);
      window.clearTimeout(wake);
      tick = wake = undefined;
      return;
    }
    if (tick === undefined) {
      tick = window.setInterval(() => {
        if (document.hidden) {
          return;
        }
        const now = Date.now();
        for (const [id, row] of rows) {
          const v = model.view(id, now);
          if (v) {
            row.time.textContent = fmtElapsed(v.elapsedMs);
          }
        }
      }, 1000);
    }
    window.clearTimeout(wake);
    wake = undefined;
    const wait = model.nextWake(Date.now());
    if (wait !== undefined) {
      wake = window.setTimeout(() => {
        wake = undefined;
        if (model.poll(Date.now())) {
          render();
        } else {
          schedule();
        }
      }, wait + 20);
    }
  }

  /** Aplica um evento ao modelo e só repinta se algo visível mudou. */
  function apply(changed: boolean): void {
    if (changed && enabled) {
      render();
    }
  }

  return {
    el: tray,

    get enabled(): boolean {
      return enabled;
    },

    setEnabled(on: boolean): void {
      enabled = on;
      applyEnabled();
      if (!on) {
        tray.classList.add('hidden');
      }
      render();
    },

    /** Começa ou termina o turno de um ator (o chat principal em `busy`, um agente em "rodando"). */
    setWorking(id: string, working: boolean): void {
      apply(working ? model.start(id, Date.now()) : model.stop(id));
    },

    /** Chegou um delta de texto: balão "digitando". */
    typing(id: string): void {
      apply(model.typing(id));
    },

    /** A mensagem de texto chegou inteira: o "digitando" some. */
    message(id: string): void {
      apply(model.message(id));
    },

    thinking(id: string, text?: string): void {
      apply(model.thinking(id, text, Date.now()));
    },

    tool(id: string, name: string, input: unknown): void {
      apply(model.tool(id, name, input, Date.now()));
    },

    isTyping(id: string): boolean {
      return model.view(id, Date.now())?.kind === 'typing';
    },

    /** Chat trocado ou limpo: ninguém está trabalhando. */
    reset(): void {
      for (const id of model.ids()) {
        model.stop(id);
      }
      render();
    },

    /** Reabrir uma conversa renderiza o histórico de uma vez: sem a animação de entrada em cada mensagem. */
    pauseEntrance(): void {
      document.body.classList.remove('live-anim');
      requestAnimationFrame(() => requestAnimationFrame(applyEnabled));
    },
  };
}

export type LiveBubbles = ReturnType<typeof createLiveBubbles>;
