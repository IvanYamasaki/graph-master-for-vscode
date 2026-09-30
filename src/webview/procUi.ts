/**
 * Linha "Processos" do popup de uma tarefa de shell: PID raiz, filhos (expansível), pasta, portas e "Encerrar".
 * A leitura é do host (1 a 2 s no Windows): pedida ao abrir o popup e no "Atualizar", nunca em laço.
 */
import type { AgentInfo, ProcView, TaskProcs } from '../chat/protocol';

export interface ProcRowDeps {
  getProcs(id: string): TaskProcs | undefined;
  requestProcs(id: string): void;
  killTree(id: string): void;
  openOrphans(): void;
}

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) {
    el.className = cls;
  }
  for (const c of children) {
    if (c) {
      el.append(c);
    }
  }
  return el;
}

function btn(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = h('button', 'proc-btn', label);
  b.type = 'button';
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

export function shortCmd(p: Pick<ProcView, 'commandLine' | 'name'>, max = 110): string {
  const one = (p.commandLine || p.name).replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** "há 3h 12m", a partir de um ISO. */
export function ageText(iso: string | undefined, now = Date.now()): string {
  if (!iso) {
    return '';
  }
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 60) {
    return `há ${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `há ${m}m`;
  }
  const hrs = Math.floor(m / 60);
  return hrs < 48 ? `há ${hrs}h ${m % 60}m` : `há ${Math.floor(hrs / 24)} dias`;
}

export function procLine(p: ProcView): HTMLElement {
  return h(
    'li',
    'proc-line',
    h('span', 'proc-pid', String(p.pid)),
    h('span', 'proc-name', p.name),
    p.ports.length ? h('span', 'proc-port', `:${p.ports.join(', :')}`) : null,
    h('span', 'proc-cmd', shortCmd(p)),
  );
}

export function createProcRow(): HTMLElement {
  const row = h('div', 'proc-row');
  row.hidden = true;
  return row;
}

/** Repinta a linha. Pede a leitura ao host na primeira pintura de cada agente aberto. */
export function paintProcRow(row: HTMLElement, a: AgentInfo, deps: ProcRowDeps): void {
  if (a.taskType !== 'local_bash') {
    row.hidden = true;
    row.dataset.sig = '';
    row.dataset.asked = '';
    return;
  }
  row.hidden = false;
  if (row.dataset.asked !== a.id) {
    row.dataset.asked = a.id;
    deps.requestProcs(a.id);
  }
  const procs = deps.getProcs(a.id);
  const sig = `${a.id}|${a.status}|${procs?.scannedAt ?? 'loading'}`;
  if (row.dataset.sig === sig) {
    return;
  }
  row.dataset.sig = sig;
  const head = h('div', 'proc-head', h('span', 'proc-label', 'Processos'));
  const refresh = btn('Atualizar', 'Lê de novo a árvore de processos desta tarefa', () => {
    refresh.disabled = true;
    deps.requestProcs(a.id);
  });
  head.append(refresh);
  if (!procs) {
    row.replaceChildren(head, h('div', 'proc-note', 'Lendo os processos…'));
    return;
  }
  if (procs.root) {
    head.append(btn('Encerrar', 'Encerra a árvore inteira desta tarefa (raiz e filhos). Pede confirmação.', () => deps.killTree(a.id)));
  }
  const parts: HTMLElement[] = [head];
  if (a.command) {
    parts.push(h('div', 'proc-cmdline', h('code', '', a.command.length > 200 ? `${a.command.slice(0, 199)}…` : a.command)));
  }
  for (const e of procs.expectedPorts) {
    parts.push(h('div', `proc-expected ${e.up ? 'is-up' : 'is-down'}`, `porta ${e.port} ${e.up ? 'no ar' : 'fora'}`));
  }
  if (procs.root) {
    const r = procs.root;
    const ports = [...new Set(procs.members.flatMap((m) => m.ports))];
    parts.push(h('div', 'proc-root', `PID ${r.pid} · ${r.name}${r.startedAt ? ` · ${ageText(r.startedAt)}` : ''}`));
    if (r.cwd) {
      parts.push(h('div', 'proc-note', `pasta: ${r.cwd}`));
    }
    parts.push(h('div', 'proc-note', ports.length ? `em escuta: ${ports.join(', ')}` : 'nenhuma porta em escuta'));
    const children = procs.members.slice(1);
    if (children.length) {
      const list = h('ul', 'proc-list', ...children.map(procLine));
      parts.push(h('details', 'proc-children', h('summary', '', `${children.length} ${children.length === 1 ? 'filho' : 'filhos'}`), list));
    }
  } else {
    parts.push(
      h(
        'div',
        'proc-note',
        !procs.identified
          ? a.status === 'running'
            ? 'Processo ainda não identificado (a busca olha só os filhos do Claude Code desta sessão, iniciados junto com a tarefa).'
            : 'Processo não identificado; veja Processos órfãos.'
          : 'Os processos desta tarefa já encerraram.',
      ),
    );
    if (a.status !== 'running') {
      parts.push(h('div', 'proc-head', btn('Processos órfãos', 'Lista processos do projeto que nenhuma tarefa rastreia mais', () => deps.openOrphans())));
    }
  }
  if (procs.error) {
    parts.push(h('div', 'proc-note is-error', procs.error));
  }
  row.replaceChildren(...parts);
}
