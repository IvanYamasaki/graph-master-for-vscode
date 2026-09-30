/**
 * Peças de interface do guarda fora do chat: a marca no nó do grafo (anel âmbar de agente possivelmente preso,
 * barra fina de consumo do orçamento) e a seção de consumo no popup do nó. Injeta o próprio <style> com prefixo `agm-gd`.
 */
import type { AgentInfo } from '../chat/protocol';
import { BUDGET_WARN, budgetFraction, budgetLines, hasBudget } from '../chat/guard/format';

const P = 'agm-gd';

/** Âmbar do "possivelmente preso": o mesmo tom do aviso do VS Code, forte o bastante sobre as cores dos agentes. */
export const STUCK_RING = '#e3a008';
const METER_OK = '#3fb950';
const METER_WARN = '#e3a008';
const METER_FULL = '#f85149';

export interface GraphMeter {
  frac: number;
  color: string;
}

function meterColor(frac: number): string {
  return frac >= 1 ? METER_FULL : frac >= BUDGET_WARN ? METER_WARN : METER_OK;
}

/** Barra de orçamento de um nó (agente ou caixa recolhida), na cor da faixa em que está. */
export function budgetMeter(frac: number): GraphMeter {
  return { frac: Math.min(1, frac), color: meterColor(frac) };
}

/** Ajusta o modelo do nó: anel âmbar quando preso, barra de orçamento, e o consumo no texto de dica. */
export function markGuardNode(node: { ring?: { color: string; pulse: boolean }; detail: string; aria: string; meter?: GraphMeter }, a: AgentInfo): void {
  if (a.stuck && a.status === 'running') {
    node.ring = { color: STUCK_RING, pulse: false };
    node.detail += `\npossivelmente preso: ${a.stuck.reason}`;
    node.aria += `. Possivelmente preso: ${a.stuck.reason}`;
  }
  const frac = budgetFraction(a.budget, a.spent);
  if (frac !== undefined) {
    node.meter = budgetMeter(frac);
    node.detail += `\norçamento: ${Math.round(frac * 100)}% · ${budgetLines(a).join(' · ')}`;
    if (frac >= BUDGET_WARN) {
      node.aria += `. Orçamento em ${Math.round(frac * 100)}%`;
    }
  }
}

const CSS = `
.${P} { padding: 0 12px 8px; font-size: 0.9em; color: var(--vscode-descriptionForeground, #9aa0a6); }
.${P}[hidden] { display: none; }
.${P}-bar { height: 3px; border-radius: 2px; background: rgba(128,128,128,0.25); overflow: hidden; margin: 2px 0 5px; }
.${P}-fill { height: 100%; border-radius: 2px; }
.${P}-line { line-height: 1.5; }
.${P}-stuck { color: ${STUCK_RING}; font-weight: 600; line-height: 1.5; }
.${P}-paths { line-height: 1.5; overflow-wrap: anywhere; }
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

function div(cls: string, text?: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = cls;
  if (text !== undefined) {
    el.textContent = text;
  }
  return el;
}

/** Contêiner da seção de consumo no popup. Vazio e escondido até `paintGuardRow`. */
export function createGuardRow(): HTMLElement {
  ensureStyles();
  const row = div(P);
  row.hidden = true;
  return row;
}

/** Tokens, minutos, custo estimado, a barra quando há limite, o aviso de preso e os caminhos protegidos. */
export function paintGuardRow(row: HTMLElement, a: AgentInfo | undefined): void {
  if (!a || a.kind !== 'routed' || !a.spent) {
    row.hidden = true;
    row.dataset.sig = '';
    return;
  }
  const frac = budgetFraction(a.budget, a.spent);
  const lines = budgetLines(a);
  const sig = [frac?.toFixed(3) ?? '', ...lines, a.stuck?.reason ?? '', ...(a.protectedPaths ?? [])].join('|');
  if (row.dataset.sig === sig) {
    return;
  }
  row.dataset.sig = sig;
  const parts: HTMLElement[] = [];
  if (a.stuck) {
    parts.push(div(`${P}-stuck`, `Possivelmente preso: ${a.stuck.reason}`));
  }
  if (frac !== undefined && hasBudget(a.budget)) {
    const bar = div(`${P}-bar`);
    const fill = div(`${P}-fill`);
    fill.style.width = `${Math.min(100, Math.round(frac * 100))}%`;
    fill.style.background = meterColor(frac);
    bar.title = `${Math.round(frac * 100)}% do orçamento`;
    bar.append(fill);
    parts.push(bar);
  }
  parts.push(div(`${P}-line`, `${frac !== undefined ? `Orçamento ${Math.round(frac * 100)}% · ` : 'Consumo · '}${lines.join(' · ')}`));
  if (a.protectedPaths?.length) {
    parts.push(div(`${P}-paths`, `Caminhos protegidos: ${a.protectedPaths.join(', ')}`));
  }
  row.replaceChildren(...parts);
  row.hidden = false;
}
