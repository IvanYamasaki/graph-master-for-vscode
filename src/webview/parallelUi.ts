/**
 * Peças de interface do Best-of-N e do verificador: a marca das tentativas no grafo (grupo na linha de baixo,
 * vencedora com anel dourado, as outras esmaecidas depois que o grupo fecha), o ranking do grupo no popup do nó
 * e o selo da verificação independente no cartão de hipótese. Injeta o próprio <style> com prefixo `agm-par`.
 */
import type { AgentInfo, LabVerificationInfo } from '../chat/protocol';

const P = 'agm-par';
/** Anel da vencedora: dourado, distinto do verde de "rodando" e do âmbar de "preso". */
export const WINNER_RING = '#e8c547';

const SEAL_COLOR: Record<LabVerificationInfo['seal'], string> = {
  verificado: 'var(--vscode-testing-iconPassed, #73c991)',
  divergente: 'var(--vscode-testing-iconFailed, #f14c4c)',
  inconclusivo: 'var(--vscode-descriptionForeground, #9aa0a6)',
  verificando: 'var(--vscode-progressBar-background, #0e70c0)',
};

const CSS = `
.${P} { padding: 0 12px 8px; font-size: 0.9em; color: var(--vscode-descriptionForeground, #9aa0a6); }
.${P}[hidden] { display: none; }
.${P}-head { line-height: 1.5; margin-bottom: 2px; }
.${P}-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.${P}-table td { padding: 1px 6px 1px 0; white-space: nowrap; }
.${P}-table td.is-desc { white-space: normal; overflow-wrap: anywhere; }
.${P}-table tr.is-me td { color: var(--vscode-foreground, #ccc); font-weight: 600; }
.${P}-table tr.is-winner td:first-child { color: ${WINNER_RING}; }
.${P}-seal {
  flex: none; font-size: 0.74em; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
  padding: 1px 6px; border-radius: 4px; color: var(--${P}-seal);
  border: 1px dashed color-mix(in srgb, var(--${P}-seal) 70%, transparent);
}
.${P}-seal[hidden] { display: none; }
.${P}-check { font-size: 0.9em; line-height: 1.45; overflow-wrap: anywhere; }
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

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) {
    e.className = cls;
  }
  if (text !== undefined) {
    e.textContent = text;
  }
  return e;
}

/** Quatro algarismos significativos, como o fmtNum do host. */
function fmt(x: number | undefined): string {
  if (typeof x !== 'number' || !Number.isFinite(x)) {
    return '-';
  }
  if (x === 0) {
    return '0';
  }
  return Math.abs(x) < 1e-4 ? x.toExponential(2) : String(Number(x.toPrecision(4)));
}

// ---------- grafo ----------

/**
 * Tentativa de Best-of-N no grafo. Grupo aberto: "g1 · 2/3" na linha de baixo. Fechado: posição e valor; a
 * vencedora ganha anel dourado e fica acesa, as outras esmaecem (continuam no mapa, com relatório e worktree).
 */
export function markAttemptNode(node: { sub: string; detail: string; aria: string; ring?: { color: string; pulse: boolean }; quiet: boolean; faded?: boolean }, a: AgentInfo, maxSub: number): void {
  const at = a.attempt;
  if (!at) {
    return;
  }
  const glyph = a.worktree ? '⎇ ' : '';
  let sub: string;
  if (!at.closed) {
    sub = `${glyph}${at.group} · ${at.index}/${at.of}${a.status === 'running' ? ' · rodando' : ' · pronta'}`;
  } else if (at.winner) {
    sub = `★ ${at.group} · 1º · ${at.metric} ${fmt(at.value)}`;
    node.quiet = false;
    if (a.status !== 'running') {
      node.ring = { color: WINNER_RING, pulse: false };
    }
  } else {
    sub = `${glyph}${at.group} · ${at.rank ? `${at.rank}º · ${fmt(at.value)}` : 'sem métrica'}`;
    node.faded = a.status !== 'running';
  }
  node.sub = sub.length > maxSub ? `${sub.slice(0, maxSub - 1)}…` : sub;
  const where = `Best-of-N ${at.group}, tentativa ${at.index} de ${at.of}, por ${at.metric} (${at.direction === 'higher' ? 'maior' : 'menor'} é melhor)`;
  const result = at.closed ? (at.winner ? ', vencedora' : at.rank ? `, ${at.rank}º lugar` : ', sem métrica') : '';
  node.detail += `\n${where}${result}${at.value !== undefined ? `: ${fmt(at.value)}` : ''}`;
  node.aria += `. ${where}${result}`;
}

// ---------- popup do nó ----------

export function createAttemptRow(): HTMLElement {
  ensureStyles();
  const row = el('div', P);
  row.hidden = true;
  return row;
}

/** Ranking do grupo da tentativa aberta no popup. Refaz o DOM só quando algo visível muda. */
export function paintAttemptRow(row: HTMLElement, a: AgentInfo | undefined, all: AgentInfo[]): void {
  const at = a?.attempt;
  if (!a || !at) {
    row.hidden = true;
    row.dataset.sig = '';
    return;
  }
  const members = all.filter((x) => x.attempt?.group === at.group).sort((x, y) => (x.attempt!.rank ?? 99) - (y.attempt!.rank ?? 99) || x.attempt!.index - y.attempt!.index);
  const sig = [a.id, ...members.map((m) => `${m.id}:${m.status}:${m.attempt!.rank ?? ''}:${m.attempt!.value ?? ''}:${m.attempt!.closed ?? ''}`)].join('|');
  row.hidden = false;
  if (row.dataset.sig === sig) {
    return;
  }
  row.dataset.sig = sig;
  const head = el(
    'div',
    `${P}-head`,
    `Best-of-N ${at.group} · ${at.of} tentativas · ${at.metric}, ${at.direction === 'higher' ? 'maior' : 'menor'} é melhor${at.closed ? '' : ` · ${members.filter((m) => m.status !== 'running').length} de ${at.of} prontas`}`,
  );
  const table = el('table', `${P}-table`);
  for (const m of members) {
    const ma = m.attempt!;
    const tr = el('tr', `${m.id === a.id ? 'is-me' : ''}${ma.winner ? ' is-winner' : ''}`.trim());
    const pos = ma.closed ? (ma.winner ? '★ 1º' : ma.rank ? `${ma.rank}º` : '—') : `${ma.index}/${ma.of}`;
    const value = ma.value !== undefined ? fmt(ma.value) : ma.closed ? 'sem métrica' : m.status === 'running' ? 'rodando' : '…';
    const src = ma.source === 'result.json' ? 'result.json' : ma.source === 'log_run' ? 'log_run' : '';
    tr.append(el('td', '', pos), el('td', '', m.id), el('td', '', value), el('td', 'is-desc', src));
    tr.title = m.description;
    table.append(tr);
  }
  row.replaceChildren(head, table);
}

// ---------- selo da verificação ----------

const SEAL_LABEL: Record<LabVerificationInfo['seal'], string> = {
  verificado: 'verificado',
  divergente: 'divergente',
  inconclusivo: 'verificação inconclusiva',
  verificando: 'verificando…',
};

/** Selo ao lado do veredito no cartão da hipótese. Sem verificação, some. */
export function paintSeal(span: HTMLElement, v: LabVerificationInfo | undefined): void {
  ensureStyles();
  span.classList.add(`${P}-seal`);
  if (!v) {
    span.hidden = true;
    return;
  }
  span.hidden = false;
  span.style.setProperty(`--${P}-seal`, SEAL_COLOR[v.seal]);
  span.textContent = SEAL_LABEL[v.seal];
  span.title = v.seal === 'verificando' ? `O agente ${v.agent} está reexecutando os braços com seed nova.` : `Verificação independente pelo agente ${v.agent}${v.verdict ? `, parecer ${v.verdict}` : ''}${v.notes ? `: ${v.notes}` : ''}`;
}

/** Seção "Verificação independente" do popup da hipótese: parecer, notas, reexecuções e checagens do host. */
export function verificationSection(v: LabVerificationInfo | undefined, sectionCls: string, labelCls: string): HTMLElement | undefined {
  if (!v) {
    return undefined;
  }
  ensureStyles();
  const box = el('div', sectionCls);
  const seal = el('span', '');
  paintSeal(seal, v);
  const label = el('div', labelCls, 'Verificação independente ');
  label.append(seal);
  box.append(label);
  if (v.seal === 'verificando') {
    box.append(el('div', `${P}-check`, `Agente ${v.agent} reexecutando os braços com seed nova.`));
    return box;
  }
  box.append(el('div', `${P}-check`, `Parecer do agente ${v.agent}: ${v.verdict ?? '-'}${v.notes ? `. ${v.notes}` : ''}`));
  for (const r of v.reruns ?? []) {
    box.append(
      el(
        'div',
        `${P}-check`,
        `Reexecução ${r.arm} seed ${r.seed}: ${fmt(r.value)}${r.interval ? ` · intervalo [${fmt(r.interval[0])}, ${fmt(r.interval[1])}]` : ''}${r.inside === true ? ' · dentro' : r.inside === false ? ' · FORA' : ''}`,
      ),
    );
  }
  for (const c of v.checks ?? []) {
    box.append(el('div', `${P}-check`, `· ${c}`));
  }
  return box;
}
