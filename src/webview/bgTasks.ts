/**
 * Lista das tarefas em segundo plano que seguram o relatório de um agente ("aguardando 2 processos em segundo plano"):
 * uma linha por tarefa com nome, tempo correndo, estado e uma barra fina de progresso; o comando completo no hover e
 * no clique. Usada no chat do agente e no popup do nó. Tempo e barra andam sozinhos por um intervalo único da página.
 */
import { STATUS_LABEL, type BackgroundTaskInfo } from '../chat/protocol';
import { type BgEstimate, etaSource, etaView, fmtLeft } from '../chat/bgEta';

/** Acima disto a lista fica recolhida, com as primeiras linhas à vista. */
const FOLD_AFTER = 4;

export interface BgListOptions {
  /** Para a tarefa. Ausente: sem botão Parar. */
  onStop?(taskId: string): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) {
    e.textContent = text;
  }
  return e;
}

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function stateLabel(t: BackgroundTaskInfo): string {
  return t.status && t.status !== 'running' ? STATUS_LABEL[t.status] : 'rodando';
}

/** Tarefas confirmadas para parar: o primeiro clique arma, o segundo para. Vale entre repinturas. */
const armed = new Set<string>();

function row(t: BackgroundTaskInfo, opts: BgListOptions): HTMLElement {
  const li = el('li', 'bg-task');
  const line = el('div', 'bg-task-line');
  const name = el('span', 'bg-task-name', t.description);
  const full = t.command ?? t.description;
  name.setAttribute('title', full);
  const meta = el('span', 'bg-task-meta');
  const since = t.startedAt ? Date.parse(t.startedAt) : NaN;
  if (!Number.isNaN(since)) {
    const clock = el('span', 'bg-task-clock', fmtElapsed(Date.now() - since));
    clock.dataset.bgSince = String(since);
    clock.setAttribute('title', `começou às ${new Date(since).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);
    meta.append(clock, ' · ');
  }
  meta.append(stateLabel(t));
  if (t.ports?.length) {
    meta.append(` · porta ${t.ports.join(', ')}`);
  }
  line.append(name, meta);
  // Clique no nome abre o comando completo embaixo, para ler e copiar.
  const cmd = el('code', 'bg-task-cmd', full);
  cmd.hidden = true;
  name.setAttribute('role', 'button');
  name.tabIndex = 0;
  const toggle = () => {
    cmd.hidden = !cmd.hidden;
  };
  name.addEventListener('click', toggle);
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });
  if (opts.onStop) {
    const stop = el('button', 'bg-task-stop');
    const paintStop = () => {
      const on = armed.has(t.id);
      stop.textContent = on ? 'Confirmar' : 'Parar';
      stop.classList.toggle('is-armed', on);
      stop.setAttribute('title', on ? 'Clique de novo para parar este processo' : 'Para este processo (pede confirmação)');
    };
    paintStop();
    stop.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!armed.has(t.id)) {
        armed.add(t.id);
        paintStop();
        // Sem o segundo clique em alguns segundos, desarma.
        window.setTimeout(() => {
          armed.delete(t.id);
          if (stop.isConnected) {
            paintStop();
          }
        }, 4000);
        return;
      }
      armed.delete(t.id);
      stop.disabled = true;
      stop.textContent = 'Parando…';
      opts.onStop?.(t.id);
    });
    line.append(stop);
  }
  li.dataset.bgTask = t.id;
  li.append(line, etaBar(t), cmd);
  return li;
}

// ---------- Barra de progresso ----------

/** Estimativa de cada barra na página; o relógio repinta a partir dela. */
const etas = new WeakMap<HTMLElement, BgEstimate | undefined>();

/**
 * Barra fina com "45% · falta ~4 min". Sem estimativa fica indeterminada (animação discreta) e sem texto: o tempo
 * decorrido já está na linha. Nunca mostra porcentagem que não veio da saída.
 */
function etaBar(t: BackgroundTaskInfo, cls = 'bg-eta'): HTMLElement {
  const box = el('div', cls);
  box.dataset.bgTask = t.id;
  const since = t.startedAt ? Date.parse(t.startedAt) : NaN;
  if (!Number.isNaN(since)) {
    box.dataset.bgEtaSince = String(since);
  }
  const bar = el('div', 'bg-bar');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', `Progresso de ${t.description}`);
  bar.append(el('div', 'bg-bar-fill'));
  box.append(bar, el('span', 'bg-eta-text'));
  etas.set(box, t.eta);
  paintEta(box);
  return box;
}

function paintEta(box: HTMLElement, now = Date.now()): void {
  const est = etas.get(box);
  const since = Number(box.dataset.bgEtaSince);
  const v = etaView(est, Number.isNaN(since) ? 0 : now - since);
  const bar = box.querySelector<HTMLElement>('.bg-bar');
  const fill = box.querySelector<HTMLElement>('.bg-bar-fill');
  const text = box.querySelector<HTMLElement>('.bg-eta-text');
  if (!bar || !fill || !text) {
    return;
  }
  const known = v.fraction !== undefined;
  box.classList.toggle('is-indet', !known);
  box.classList.toggle('is-over', v.over);
  if (known) {
    const pct = Math.min(100, Math.max(0, v.fraction! * 100));
    fill.style.width = `${pct.toFixed(1)}%`;
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(Math.round(pct)));
  } else {
    fill.style.removeProperty('width');
    bar.removeAttribute('aria-valuenow');
  }
  const parts: string[] = [];
  if (est?.source === 'output' && known) {
    parts.push(`${Math.round(v.fraction! * 100)}%`);
  }
  if (v.over) {
    parts.push('passou da média');
  } else if (v.leftMs !== undefined) {
    parts.push(fmtLeft(v.leftMs));
  }
  const label = parts.join(' · ');
  if (text.textContent !== label) {
    text.textContent = label;
  }
  const tip = etaSource(est) + (v.over && est?.expectedMs ? ` A média é ${fmtElapsed(est.expectedMs)}.` : '');
  if (box.getAttribute('title') !== tip) {
    box.setAttribute('title', tip);
  }
}

/**
 * Estimativas novas (o host releu a saída) entram nas barras que já estão na página, sem repintar a lista: o comando
 * aberto e o Parar armado ficam como estão.
 */
export function bgRefresh(root: ParentNode, tasks: BackgroundTaskInfo[] | undefined): void {
  const byId = new Map((tasks ?? []).map((t) => [t.id, t]));
  for (const box of root.querySelectorAll<HTMLElement>('.bg-eta')) {
    const t = box.dataset.bgTask ? byId.get(box.dataset.bgTask) : undefined;
    if (t) {
      etas.set(box, t.eta);
      paintEta(box);
    }
  }
}

/** Quanto ainda falta, para escolher o processo mais demorado; sem estimativa conta o que começou antes. */
function weight(t: BackgroundTaskInfo, now: number): number {
  const since = t.startedAt ? Date.parse(t.startedAt) : NaN;
  const elapsed = Number.isNaN(since) ? 0 : now - since;
  const v = etaView(t.eta, elapsed);
  return v.leftMs ?? (v.over ? 1e12 : 1e13 + elapsed);
}

/**
 * Barra resumida para a nota "aguardando N processos" do log: uma por processo quando são até 3, senão só a do mais
 * demorado, com quantos outros há.
 */
export function bgSummary(tasks: BackgroundTaskInfo[]): HTMLElement | null {
  if (!tasks.length) {
    return null;
  }
  const now = Date.now();
  const shown = tasks.length <= 3 ? tasks : [[...tasks].sort((a, b) => weight(b, now) - weight(a, now))[0]];
  const box = el('div', 'bg-sum');
  for (const t of shown) {
    const line = el('div', 'bg-sum-line');
    const name = el('span', 'bg-sum-name', t.description);
    name.setAttribute('title', t.command ?? t.description);
    line.append(name, etaBar(t, 'bg-eta bg-eta-sum'));
    box.append(line);
  }
  if (shown.length < tasks.length) {
    box.append(el('div', 'bg-sum-more', `o mais demorado de ${tasks.length} processos`));
  }
  startTicker();
  return box;
}

/** Assinatura da lista: repintar só quando muda, para não fechar o comando aberto nem desarmar o Parar. A estimativa fica fora: entra por bgRefresh. */
export function bgSig(tasks: BackgroundTaskInfo[] | undefined): string {
  return (tasks ?? []).map((t) => [t.id, t.description, t.status ?? '', t.startedAt ?? '', t.command ?? ''].join('\u0001')).join('\u0002');
}

/** A lista inteira; com mais de FOLD_AFTER tarefas, o resto fica num "mais N" recolhível. */
export function bgTaskList(tasks: BackgroundTaskInfo[], opts: BgListOptions = {}): HTMLElement {
  const box = el('div', 'bg-tasks');
  const head = el('ul', 'bg-task-list');
  head.append(...tasks.slice(0, FOLD_AFTER).map((t) => row(t, opts)));
  box.append(head);
  if (tasks.length > FOLD_AFTER) {
    const more = el('details', 'bg-task-more');
    more.append(el('summary', '', `mais ${tasks.length - FOLD_AFTER}`));
    const rest = el('ul', 'bg-task-list');
    rest.append(...tasks.slice(FOLD_AFTER).map((t) => row(t, opts)));
    more.append(rest);
    box.append(more);
  }
  startTicker();
  return box;
}

let ticker: number | undefined;

/** Um intervalo só, que para sozinho quando não há mais relógio nem barra de tarefa na página. */
function startTicker(): void {
  if (ticker !== undefined) {
    return;
  }
  ticker = window.setInterval(() => {
    const clocks = document.querySelectorAll<HTMLElement>('[data-bg-since]');
    const bars = document.querySelectorAll<HTMLElement>('.bg-eta');
    if (!clocks.length && !bars.length) {
      window.clearInterval(ticker);
      ticker = undefined;
      return;
    }
    const now = Date.now();
    for (const c of clocks) {
      c.textContent = fmtElapsed(now - Number(c.dataset.bgSince));
    }
    for (const b of bars) {
      paintEta(b, now);
    }
  }, 1000);
}
