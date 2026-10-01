/**
 * Lista "Processos órfãos": árvores de processos do projeto que nenhum painel rastreia (servidores de dev que
 * sobraram de uma sessão anterior). Encerrar por árvore ou todas; quem confirma é o host, num diálogo modal.
 */
import type { OrphanView, WebviewMessage } from '../chat/protocol';
import { ageText, procLine, shortCmd } from './procUi';

export interface OrphansView {
  open(): void;
  update(msg: { groups: OrphanView[]; error?: string; scannedAt: string; open?: boolean }): void;
  close(): void;
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

function btn(label: string, cls: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = h('button', cls, label);
  b.type = 'button';
  b.title = title;
  // Dentro de um <summary> o clique também abriria e fecharia o grupo.
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return b;
}

/** Identidade da raiz que vai ao host: ele confere PID, nome e início antes de matar. */
function rootOf(g: OrphanView): { pid: number; name: string; startedAt?: string } {
  return { pid: g.root.pid, name: g.root.name, startedAt: g.root.startedAt };
}

export function createOrphansView(send: (msg: WebviewMessage) => void): OrphansView {
  const el = h('div', 'orphans');
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Processos órfãos');
  el.tabIndex = -1;
  const body = h('div', 'orphans-body');
  const status = h('div', 'orphans-status');
  const killAll = btn('Encerrar todos', 'orphans-btn is-danger', 'Encerra as árvores de pai encerrado (sobras de sessão). As de pai ainda aberto ficam de fora. Pede confirmação.', () => {
    const dead = groups.filter((g) => !g.parentAlive);
    if (dead.length) {
      send({ type: 'killOrphans', roots: dead.map((g) => rootOf(g)) });
    }
  });
  const rescan = btn('Atualizar', 'orphans-btn', 'Lê a tabela de processos de novo', () => scan());
  const closeBtn = btn('×', 'orphans-x', 'Fechar (Esc)', () => close());
  el.append(h('div', 'orphans-head', h('div', 'orphans-title', 'Processos órfãos do projeto'), rescan, killAll, closeBtn), status, body);
  document.body.append(el);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      close();
    }
  });

  let groups: OrphanView[] = [];

  function scan(): void {
    status.textContent = 'Lendo os processos…';
    rescan.disabled = true;
    send({ type: 'scanOrphans' });
  }

  function open(): void {
    el.hidden = false;
    el.focus();
    scan();
  }

  function close(): void {
    el.hidden = true;
  }

  function update(msg: { groups: OrphanView[]; error?: string; scannedAt: string; open?: boolean }): void {
    if (msg.open) {
      el.hidden = false;
    }
    groups = msg.groups;
    rescan.disabled = false;
    killAll.disabled = !groups.some((g) => !g.parentAlive);
    const n = groups.reduce((sum, g) => sum + g.members.length, 0);
    status.textContent = msg.error
      ? `Não consegui ler tudo: ${msg.error}`
      : groups.length
        ? `${groups.length} ${groups.length === 1 ? 'árvore' : 'árvores'}, ${n} ${n === 1 ? 'processo' : 'processos'}. Lido às ${new Date(msg.scannedAt).toLocaleTimeString()}.`
        : 'Nenhum processo órfão do projeto.';
    const dead = groups.filter((g) => !g.parentAlive);
    const live = groups.filter((g) => g.parentAlive);
    const children: HTMLElement[] = dead.map(groupEl);
    if (live.length) {
      children.push(
        h(
          'div',
          'orphans-section',
          h('div', 'orphans-section-title', `Lançados por um processo ainda aberto (${live.length})`),
          h('div', 'orphans-section-note', 'Terminal externo, outro claude ou outra IDE: podem ter sido abertos de propósito. Ficam fora do "Encerrar todos".'),
        ),
        ...live.map(groupEl),
      );
    }
    body.replaceChildren(...children);
  }

  function groupEl(g: OrphanView): HTMLElement {
    const parent = g.parentAlive ? `pai ${g.parent?.name ?? '?'} ${g.parent?.pid ?? g.root.ppid} aberto` : '';
    return h(
      'details',
      `orphan${g.parentAlive ? ' is-parent-alive' : ''}`,
      h(
        'summary',
        'orphan-sum',
        h('span', 'proc-pid', String(g.root.pid)),
        h('span', 'proc-name', g.root.name),
        g.ports.length ? h('span', 'proc-port', `porta ${g.ports.join(', ')}`) : null,
        h('span', 'orphan-meta', [`${g.members.length} ${g.members.length === 1 ? 'processo' : 'processos'}`, ageText(g.root.startedAt), parent].filter(Boolean).join(' · ')),
        btn('Encerrar', 'orphans-btn', 'Encerra esta árvore (raiz e filhos). Pede confirmação.', () => send({ type: 'killOrphans', roots: [rootOf(g)] })),
      ),
      h('div', 'orphan-cmd', shortCmd(g.root, 300)),
      h('ul', 'proc-list', ...g.members.map(procLine)),
    );
  }

  return { open, update, close };
}
