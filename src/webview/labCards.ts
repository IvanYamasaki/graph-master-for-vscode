/**
 * Cartões do laboratório no log principal. Cada veredito novo de declare_result vira um cartão compacto:
 * título, veredito com cor (verde suportada, cinza inconclusiva, vermelho refutada) e a diferença com o IC.
 * O clique abre um popup com braços, seeds, média ± desvio, IC, p ajustado e os runs com comando e commit.
 *
 * O popup usa as classes `agm-pop` do nodePopup.ts (mesma aparência) sem mexer nele: o nodePopup injeta o CSS
 * dessas classes ao ser criado pelo main.ts. Aqui só entra o CSS próprio do cartão, com prefixo `agm-lab`.
 *
 * O primeiro estado (`initial`) só marca o que já existia: abrir o chat não despeja vereditos antigos no log.
 * Texto vindo do modelo (títulos, comandos) entra por textContent.
 */
import type { LabHypothesisInfo, LabState, LabVerdictInfo, LabVerdictKind } from '../chat/protocol';
import { paintSeal, verificationSection } from './parallelUi';

const L = 'agm-lab';
const P = 'agm-pop';
const MARGIN = 8;
const GAP = 8;
const MAX_W = 460;
const MAX_H = 560;

const COLOR: Record<LabVerdictKind, string> = {
  suportada: 'var(--vscode-testing-iconPassed, #73c991)',
  inconclusiva: 'var(--vscode-descriptionForeground, #9aa0a6)',
  refutada: 'var(--vscode-testing-iconFailed, #f14c4c)',
};

const CSS = `
.${L}-card {
  display: flex; flex-direction: column; gap: 2px; cursor: pointer;
  padding: 7px 11px; border-radius: 8px;
  border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
  border-left: 3px solid var(--${L}-color);
  background: color-mix(in srgb, var(--${L}-color) 7%, transparent);
}
.${L}-card:hover { background: color-mix(in srgb, var(--${L}-color) 13%, transparent); }
.${L}-card:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: 1px; }
.${L}-head { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.${L}-badge {
  flex: none; font-size: 0.78em; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
  padding: 1px 6px; border-radius: 4px; color: var(--${L}-color);
  border: 1px solid color-mix(in srgb, var(--${L}-color) 55%, transparent);
}
.${L}-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.${L}-id { flex: none; color: var(--vscode-descriptionForeground, #9aa0a6); font-size: 0.88em; }
.${L}-line { font-size: 0.9em; color: var(--vscode-descriptionForeground, #9aa0a6); font-variant-numeric: tabular-nums; }
.${L}-line b { color: var(--vscode-foreground, #ccc); font-weight: 600; }
.${L}-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; font-size: 0.92em; }
.${L}-table th { text-align: left; font-weight: 400; color: var(--vscode-descriptionForeground, #9aa0a6); padding: 2px 6px 2px 0; }
.${L}-table td { padding: 2px 6px 2px 0; }
.${L}-kv { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; font-size: 0.92em; font-variant-numeric: tabular-nums; }
.${L}-kv span:nth-child(odd) { color: var(--vscode-descriptionForeground, #9aa0a6); }
.${L}-reasons { margin: 0; padding-left: 1.2em; font-size: 0.9em; line-height: 1.45; }
.${L}-warn { color: var(--vscode-editorWarning-foreground, #cca700); font-size: 0.9em; line-height: 1.45; margin-top: 6px; }
.${L}-run { font-size: 0.88em; line-height: 1.45; padding: 2px 0; border-bottom: 1px solid rgba(128,128,128,0.12); overflow-wrap: anywhere; }
.${L}-run code { font-family: var(--vscode-editor-font-family, Consolas, monospace); font-size: 0.95em; }
.${L}-muted { color: var(--vscode-descriptionForeground, #9aa0a6); }
`;

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

/** Quatro algarismos significativos; NaN (null no JSON) vira "-". Igual ao fmtNum do host. */
function fmt(x: number | null | undefined): string {
  if (typeof x !== 'number' || Number.isNaN(x)) {
    return '-';
  }
  if (!Number.isFinite(x)) {
    return x > 0 ? '∞' : '-∞';
  }
  if (x === 0) {
    return '0';
  }
  return Math.abs(x) < 1e-4 ? x.toExponential(2) : String(Number(x.toPrecision(4)));
}

const signed = (x: number | null | undefined) => (typeof x === 'number' && x > 0 ? `+${fmt(x)}` : fmt(x));

export interface LabCards {
  update(state: LabState, initial?: boolean): void;
  close(): void;
}

export function createLabCards(deps: { append(el: HTMLElement): void }): LabCards {
  if (!document.getElementById(`${L}-style`)) {
    const style = document.createElement('style');
    style.id = `${L}-style`;
    style.textContent = CSS;
    document.head.append(style);
  }
  let state: LabState = { hypotheses: [], runs: 0, findings: 0 };
  /** Vereditos que já têm cartão (ou que já existiam ao abrir): id da hipótese + tentativa. */
  const shown = new Set<string>();
  const loadedAt = Date.now() - 2000;

  const pop = h('div', P);
  pop.hidden = true;
  pop.setAttribute('role', 'dialog');
  pop.tabIndex = -1;
  document.body.append(pop);
  let anchorEl: HTMLElement | undefined;

  const sig = (hyp: LabHypothesisInfo, v: LabVerdictInfo) => `${hyp.id}#${v.attempt}#${v.at}`;

  function update(next: LabState, initial?: boolean): void {
    state = next;
    for (const hyp of next.hypotheses) {
      const v = hyp.verdict;
      if (!v || shown.has(sig(hyp, v))) {
        continue;
      }
      shown.add(sig(hyp, v));
      // Veredito anterior à página (webview recarregado sem o estado inicial) não vira cartão de novo.
      if (!initial && Date.parse(v.at) >= loadedAt) {
        deps.append(card(hyp, v));
      }
    }
    // Selo da verificação independente: só no cartão do veredito que foi verificado (o último da hipótese).
    for (const hyp of next.hypotheses) {
      for (const card of document.querySelectorAll<HTMLElement>(`.${L}-card[data-hyp="${hyp.id}"]`)) {
        const seal = card.querySelector<HTMLElement>(`.${L}-seal`);
        const at = (JSON.parse(card.dataset.verdict ?? 'null') as LabVerdictInfo | null)?.at;
        if (seal) {
          paintSeal(seal, at && at === hyp.verdict?.at ? hyp.verification : undefined);
        }
      }
    }
    // Popup aberto: runs novos aparecem nele.
    if (!pop.hidden && anchorEl?.dataset.hyp) {
      const hyp = state.hypotheses.find((x) => x.id === anchorEl!.dataset.hyp);
      if (hyp) {
        fillPopup(hyp, JSON.parse(anchorEl.dataset.verdict ?? 'null') ?? hyp.verdict);
        place();
      }
    }
  }

  function card(hyp: LabHypothesisInfo, v: LabVerdictInfo): HTMLElement {
    const el = h('div', `msg ${L}-card`);
    el.style.setProperty(`--${L}-color`, COLOR[v.verdict]);
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', `Hipótese ${hyp.id}, ${v.verdict}. Abrir detalhes`);
    el.dataset.hyp = hyp.id;
    el.dataset.verdict = JSON.stringify(v);
    const [b, va] = v.arms;
    const line = h('div', `${L}-line`);
    if (Number.isFinite(v.diff)) {
      line.append(
        `Δ ${hyp.metric} `,
        h('b', undefined, signed(v.diff)),
        ` IC95% [${fmt(v.ci[0])}, ${fmt(v.ci[1])}] · p aj. ${fmt(v.pAdjusted)} · seeds ${b.n}+${va.n}`,
      );
    } else {
      line.append(`Sem dados para comparar · seeds ${b.n}+${va.n} de ${hyp.minSeeds} por braço`);
    }
    if (v.verdict === 'inconclusiva' && typeof v.seedsMissing === 'number' && v.seedsMissing > 0) {
      line.append(` · faltam ~${v.seedsMissing} seeds por braço`);
    }
    const seal = h('span', `${L}-seal`);
    paintSeal(seal, v.at === hyp.verdict?.at ? hyp.verification : undefined);
    el.append(h('div', `${L}-head`, h('span', `${L}-badge`, v.verdict), seal, h('span', `${L}-title`, hyp.title), h('span', `${L}-id`, hyp.id)), line);
    const open = () => openPopup(el, hyp.id, v);
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
    return el;
  }

  function openPopup(el: HTMLElement, id: string, v: LabVerdictInfo): void {
    const hyp = state.hypotheses.find((x) => x.id === id);
    if (!hyp) {
      return;
    }
    if (!pop.hidden && anchorEl === el) {
      close();
      return;
    }
    anchorEl = el;
    fillPopup(hyp, v);
    pop.hidden = false;
    place();
    pop.focus({ preventScroll: true });
  }

  function fillPopup(hyp: LabHypothesisInfo, v: LabVerdictInfo): void {
    pop.style.setProperty(`--${P}-color`, COLOR[v.verdict]);
    const x = h('button', `${P}-x`, '×');
    x.type = 'button';
    x.title = 'Fechar (Esc)';
    x.setAttribute('aria-label', 'Fechar');
    x.addEventListener('click', () => close());
    const dot = h('span', `${P}-dot`);
    const head = h(
      'div',
      `${P}-head`,
      dot,
      h('div', `${P}-titles`, h('div', `${P}-title`, hyp.title), h('div', `${P}-kind`, `Hipótese ${hyp.id} · ${v.verdict} · tentativa ${v.attempt} · ${new Date(v.at).toLocaleString('pt-BR')}`)),
      x,
    );
    const crit = `${hyp.minImprovement}${hyp.improvementKind === 'relative' ? ' (relativa)' : ''}`;
    const meta = h(
      'div',
      `${P}-meta`,
      h('span', undefined, `${hyp.metric}, ${hyp.direction === 'higher' ? 'maior' : 'menor'} é melhor`),
      h('span', undefined, `melhora mínima ${crit}`),
      h('span', undefined, `família ${v.family}`),
      h('span', undefined, `por ${v.by}`),
    );

    const armsTable = h('table', `${L}-table`);
    armsTable.append(h('tr', undefined, h('th', undefined, 'Braço'), h('th', undefined, 'Seeds'), h('th', undefined, 'Média ± desvio')));
    for (const a of v.arms) {
      armsTable.append(h('tr', undefined, h('td', undefined, a.arm), h('td', undefined, String(a.n)), h('td', undefined, `${fmt(a.mean)} ± ${fmt(a.sd)}`)));
    }

    const kv = h('div', `${L}-kv`);
    const pair = (k: string, val: string) => kv.append(h('span', undefined, k), h('span', undefined, val));
    pair('Diferença', `${signed(v.diff)}${typeof v.relDiff === 'number' ? ` (${signed(v.relDiff * 100)}%)` : ''}`);
    pair('IC 95%', `[${fmt(v.ci[0])}, ${fmt(v.ci[1])}] · ${v.mode === 'paired-samples' ? 'bootstrap pareado por amostra' : 'bootstrap por seed'}`);
    pair(v.mode === 'seeds' ? 'd de Cohen' : 'd_z', fmt(v.effect));
    pair('p', fmt(v.p));
    pair('p ajustado (BH)', `${fmt(v.pAdjusted)} · ${v.familySize} hipótese(s) na família`);
    pair('Alpha', String(hyp.alpha));
    if (v.verdict === 'inconclusiva' && typeof v.seedsMissing === 'number') {
      pair('Seeds que faltam', `~${v.seedsMissing} por braço (poder 80%)`);
    }

    const reasons = h('ul', `${L}-reasons`);
    for (const r of v.reasons) {
      reasons.append(h('li', undefined, r));
    }
    const warnings = v.warnings.map((w) => h('div', `${L}-warn`, `Atenção: ${w}`));

    const runs = h('div');
    const list = hyp.runs.filter((r) => hyp.arms.includes(r.arm));
    if (!list.length) {
      runs.append(h('div', `${L}-muted`, 'Nenhum run registrado.'));
    }
    for (const r of list) {
      const cmd = r.command ? h('code', undefined, r.command) : h('span', `${L}-muted`, 'sem comando');
      runs.append(
        h(
          'div',
          `${L}-run`,
          `${r.id} · ${r.arm} · seed ${r.seed} · ${hyp.metric} ${fmt(r.value)} · `,
          cmd,
          h(
            'span',
            `${L}-muted`,
            ` · ${r.commit ? `commit ${r.commit.slice(0, 10)}${r.dirty ? ' (sujo)' : ''}` : 'sem commit'} · ${r.source === 'arquivo' ? `lido de ${r.artifact ?? 'arquivo'}` : 'valor declarado'} · ${r.agent}`,
          ),
        ),
      );
    }

    const body = h(
      'div',
      `${P}-body`,
      h('div', `${P}-section`, h('div', `${P}-label`, 'Enunciado'), h('div', `${P}-note is-strong`, hyp.statement)),
      h('div', `${P}-section`, h('div', `${P}-label`, 'Braços'), armsTable),
      h('div', `${P}-section`, h('div', `${P}-label`, 'Estatística'), kv, ...warnings),
      h('div', `${P}-section`, h('div', `${P}-label`, 'Por que este veredito'), reasons),
      v.at === hyp.verdict?.at && verificationSection(hyp.verification, `${P}-section`, `${P}-label`),
      h('div', `${P}-section`, h('div', `${P}-label`, `Runs (${list.length})`), runs),
    );
    pop.replaceChildren(head, meta, body);
  }

  /** Abaixo do cartão se couber, senão acima; o log é largo demais para os lados. */
  function place(): void {
    if (!anchorEl || pop.hidden) {
      return;
    }
    if (!anchorEl.isConnected) {
      close();
      return;
    }
    const a = anchorEl.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const w = Math.min(MAX_W, vw - MARGIN * 2);
    const below = vh - a.bottom - GAP - MARGIN;
    const above = a.top - GAP - MARGIN;
    const down = below >= above;
    pop.style.width = `${w}px`;
    pop.style.maxHeight = `${Math.min(MAX_H, Math.max(180, down ? below : above))}px`;
    const hgt = pop.offsetHeight;
    const left = Math.min(Math.max(MARGIN, a.left), vw - w - MARGIN);
    const top = down ? a.bottom + GAP : a.top - GAP - hgt;
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(Math.min(Math.max(MARGIN, top), vh - hgt - MARGIN))}px`;
  }

  function close(): void {
    if (pop.hidden) {
      return;
    }
    pop.hidden = true;
    const back = anchorEl;
    anchorEl = undefined;
    back?.focus({ preventScroll: true });
  }

  document.addEventListener('mousedown', (e) => {
    if (!pop.hidden && !pop.contains(e.target as Node) && !anchorEl?.contains(e.target as Node)) {
      close();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.hidden) {
      close();
    }
  });
  window.addEventListener('resize', () => place());
  // O log rola por baixo do popup: ele acompanha o cartão.
  document.addEventListener('scroll', () => place(), true);

  return { update, close };
}
