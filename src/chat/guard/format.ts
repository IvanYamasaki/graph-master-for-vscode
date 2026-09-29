// Contas e textos do orçamento. Sem dependência de Node nem do VS Code: o webview importa daqui também.

import type { AgentBudget, AgentInfo, AgentSpent } from '../protocol';

/** A partir daqui o mapa pinta a barra de âmbar. */
export const BUDGET_WARN = 0.8;

/** Fração do orçamento já gasta, pela medida mais apertada. Sem limite nenhum, undefined. */
export function budgetFraction(budget: AgentBudget | undefined, spent: AgentSpent | undefined): number | undefined {
  if (!budget) {
    return undefined;
  }
  const s = spent ?? { tokens: 0, minutes: 0 };
  const parts = [
    budget.maxTokens ? s.tokens / budget.maxTokens : undefined,
    budget.maxMinutes ? s.minutes / budget.maxMinutes : undefined,
    budget.maxUsd && s.usd !== undefined ? s.usd / budget.maxUsd : undefined,
  ].filter((v): v is number => v !== undefined && Number.isFinite(v));
  return parts.length ? Math.max(...parts) : undefined;
}

export function hasBudget(b: AgentBudget | undefined): boolean {
  return !!(b && (b.maxTokens || b.maxMinutes || b.maxUsd));
}

export function fmtTokensShort(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  }
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));
}

export function fmtUsd(v: number): string {
  return v < 0.01 ? '<US$ 0,01' : `US$ ${v.toFixed(2).replace('.', ',')}`;
}

export function fmtMinutes(m: number): string {
  if (m < 1) {
    return `${Math.round(m * 60)}s`;
  }
  return m < 60 ? `${m.toFixed(m < 10 ? 1 : 0).replace('.', ',')} min` : `${Math.floor(m / 60)}h ${Math.round(m % 60)}min`;
}

/** "120k de 200k tokens · 3,2 de 10 min · US$ 0,40 de US$ 1,00". Medida sem limite aparece só com o gasto. */
export function budgetLines(a: Pick<AgentInfo, 'budget' | 'spent' | 'provider'>): string[] {
  const s = a.spent ?? { tokens: 0, minutes: 0 };
  const b = a.budget ?? {};
  const lines = [
    `${fmtTokensShort(s.tokens)}${b.maxTokens ? ` de ${fmtTokensShort(b.maxTokens)}` : ''} tokens processados`,
    `${fmtMinutes(s.minutes)}${b.maxMinutes ? ` de ${fmtMinutes(b.maxMinutes)}` : ''} de trabalho`,
  ];
  if (s.usd !== undefined) {
    lines.push(`${fmtUsd(s.usd)}${b.maxUsd ? ` de ${fmtUsd(b.maxUsd)}` : ''} estimados`);
  } else if (a.provider === 'codex') {
    lines.push(b.maxUsd ? 'custo: o Codex não informa, max_usd não vale aqui' : 'custo: o Codex não informa');
  }
  return lines;
}
