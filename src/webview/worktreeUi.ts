/**
 * Peças de interface dos agentes isolados (spawn_agent com isolation "worktree"): a linha da branch com os botões
 * Ver diff, Mesclar e Descartar no popup do nó, e a marca de ramificação no grafo. Mesclar e Descartar só pedem ao
 * host; quem confirma é o modal do VS Code. Autossuficiente: injeta o próprio <style> com prefixo `agm-wt`.
 */
import type { AgentInfo, WorktreeAction } from '../chat/protocol';

const P = 'agm-wt';
/** Símbolo de ramificação, para lugares sem codicon (o SVG do grafo). */
/** Glifo git-branch da fonte codicon: o mesmo ícone de ramificação do cartão, do popup e do nó do grafo. */
export const BRANCH_GLYPH = '';

const CSS = `
.${P} { padding: 0 12px 8px; font-size: 0.9em; color: var(--vscode-descriptionForeground, #9aa0a6); }
.${P}[hidden] { display: none; }
.${P}-line { display: flex; align-items: center; gap: 6px; min-width: 0; line-height: 1.5; }
.${P}-line .codicon { flex: none; font-size: 13px; }
.${P}-branch { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--vscode-editor-font-family, Consolas, monospace); color: var(--vscode-foreground, #ccc); }
.${P}-count { flex: none; }
.${P}-state { flex: none; font-weight: 600; }
.${P}-state.is-missing, .${P}-state.is-discarded { color: var(--vscode-errorForeground, #f85149); }
.${P}-btns { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 5px; }
.${P}-btn {
  font: inherit; cursor: pointer; border-radius: 4px; padding: 2px 9px;
  border: 1px solid var(--vscode-button-border, transparent);
  color: var(--vscode-button-secondaryForeground, #ccc);
  background: var(--vscode-button-secondaryBackground, #3a3d41);
}
.${P}-btn:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
.${P}-btn.is-danger { color: var(--vscode-errorForeground, #f85149); }
.${P}-btn:disabled { opacity: 0.55; cursor: default; }
.${P}-btn:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: 1px; }
`;

function ensureStyles(): void {
  if (document.getElementById(`${P}-style`)) {
    return;
  }
  const style = document.createElement('style');
  style.id = `${P}-style`;
  style.textContent = CSS;
  document.head.append(style);
}

function span(cls: string, text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  return el;
}

const STATE_LABEL: Record<string, string> = { merged: 'mesclado', discarded: 'descartado', missing: 'sumiu do disco' };

/** "+3 arquivos · 2 commits". */
export function worktreeCount(a: AgentInfo): string {
  const wt = a.worktree;
  if (!wt || wt.status === 'discarded' || wt.status === 'missing') {
    return '';
  }
  const files = wt.changed ?? 0;
  const commits = wt.ahead ?? 0;
  return [`+${files} ${files === 1 ? 'arquivo' : 'arquivos'}`, commits ? `${commits} ${commits === 1 ? 'commit' : 'commits'}` : ''].filter(Boolean).join(' · ');
}

/** Cria o contêiner da linha do worktree no popup. Vazio e escondido até `paintWorktreeRow`. */
export function createWorktreeRow(): HTMLElement {
  ensureStyles();
  const row = document.createElement('div');
  row.className = P;
  row.hidden = true;
  return row;
}

/**
 * Pinta a linha "(ramificação) agm/a3-... · +N arquivos" e os botões. Só refaz o DOM quando algo visível muda,
 * para o foco de teclado não pular a cada notícia do host.
 */
export function paintWorktreeRow(row: HTMLElement, a: AgentInfo | undefined, act?: (id: string, action: WorktreeAction) => void): void {
  const wt = a?.worktree;
  if (!a || !wt) {
    row.hidden = true;
    row.dataset.sig = '';
    return;
  }
  const running = a.status === 'running';
  const count = worktreeCount(a);
  const sig = [a.id, wt.branch, wt.status, count, running, !!act].join('|');
  row.hidden = false;
  if (row.dataset.sig === sig) {
    return;
  }
  row.dataset.sig = sig;
  const line = document.createElement('div');
  line.className = `${P}-line`;
  line.title = `Worktree: ${wt.path}\nSaiu de ${wt.base} @ ${wt.baseCommit.slice(0, 7)}`;
  const ico = span('codicon codicon-git-branch', '');
  ico.setAttribute('aria-hidden', 'true');
  line.append(ico, span(`${P}-branch`, `branch ${wt.branch}`));
  if (count) {
    line.append(span(`${P}-count`, `· ${count}`));
  }
  if (STATE_LABEL[wt.status]) {
    line.append(span(`${P}-state is-${wt.status}`, `· ${STATE_LABEL[wt.status]}`));
  }
  const parts: HTMLElement[] = [line];
  const alive = wt.status !== 'discarded' && wt.status !== 'missing';
  if (act && alive) {
    const btns = document.createElement('div');
    btns.className = `${P}-btns`;
    const button = (label: string, action: WorktreeAction, title: string, cls = ''): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `${P}-btn${cls ? ` ${cls}` : ''}`;
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', () => act(a.id, action));
      return b;
    };
    const merge = button('Mesclar', 'merge', running ? 'Espere o agente terminar para mesclar.' : `Mescla ${wt.branch} em ${wt.base} com commit de merge. Pede confirmação; conflito aborta.`);
    merge.disabled = running;
    btns.append(
      button('Ver diff', 'diff', 'Abre no editor as mudanças do agente contra o ponto de partida.'),
      merge,
      button('Descartar', 'discard', 'Apaga o worktree e a branch do agente. Pede confirmação.', 'is-danger'),
    );
    parts.push(btns);
  }
  row.replaceChildren(...parts);
}

/** Marca de ramificação num nó do grafo: ícone antes do título (como os nós sintéticos) e a branch no detalhe (tooltip). */
export function markGraphNode(node: { sub: string; detail: string; icon?: string }, a: AgentInfo, _maxSub: number): void {
  const wt = a.worktree;
  if (!wt) {
    return;
  }
  node.icon = BRANCH_GLYPH;
  const count = worktreeCount(a);
  node.detail += `\nworktree: ${wt.branch}${count ? ` (${count})` : ''}${STATE_LABEL[wt.status] ? `, ${STATE_LABEL[wt.status]}` : ''}`;
}
