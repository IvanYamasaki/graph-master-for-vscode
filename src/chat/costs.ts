/**
 * Custo por modelo e textos de gasto, sem VS Code: o hub usa no spawn_agent e no list_agents, e os testes rodam com node.
 *
 * Preço por milhão de tokens (entrada / saída) da API da Anthropic, tabela de 2026-09-25. Os agentes rodam pela
 * assinatura ou pela API, e o SDK calcula o custo estimado com esta mesma tabela; aqui ela só serve para comparar
 * modelos. Atualize quando o preço mudar.
 */
import { budgetLines, fmtUsd } from './guard/format';
import type { AgentBudget, AgentInfo, AgentSpent } from './protocol';

export type ModelTier = 'haiku' | 'sonnet' | 'opus' | 'fable';

export const MODEL_PRICES: Record<ModelTier, { name: string; inUsd: number; outUsd: number }> = {
  haiku: { name: 'Haiku 4.5', inUsd: 1, outUsd: 5 },
  sonnet: { name: 'Sonnet 5.5', inUsd: 2, outUsd: 10 },
  opus: { name: 'Opus 5.5', inUsd: 4, outUsd: 20 },
  fable: { name: 'Fable 5.1', inUsd: 10, outUsd: 50 },
};

/** Família do modelo pelo alias ou pelo id ("sonnet", "claude-opus-5-5"). Mythos custa o mesmo que Fable. Desconhecido: undefined. */
export function modelTier(model: string | undefined): ModelTier | undefined {
  const m = (model ?? '').toLowerCase();
  if (m.includes('haiku')) {
    return 'haiku';
  }
  if (m.includes('sonnet')) {
    return 'sonnet';
  }
  if (m.includes('opus')) {
    return 'opus';
  }
  return m.includes('fable') || m.includes('mythos') ? 'fable' : undefined;
}

/** Quantas vezes o preço do sonnet (o modelo de código rotineiro). */
export function relativeToSonnet(tier: ModelTier): number {
  return MODEL_PRICES[tier].inUsd / MODEL_PRICES.sonnet.inUsd;
}

function times(x: number): string {
  return `${String(Math.round(x * 10) / 10).replace('.', ',')}x`;
}

/**
 * "modelo opus (Opus 5.5, US$ 4/20 por milhão de tokens, 2x o sonnet), raciocínio high". Modelo fora da tabela
 * aparece sem preço.
 */
export function modelCostLine(model: string | undefined, effort: string | undefined, inherited = false): string {
  const tier = modelTier(model);
  const name = `${model || 'padrão'}${inherited ? ' (herdado)' : ''}`;
  const price = tier
    ? ` (${MODEL_PRICES[tier].name}, US$ ${MODEL_PRICES[tier].inUsd}/${MODEL_PRICES[tier].outUsd} por milhão de tokens de entrada/saída${tier === 'sonnet' ? '' : `, ${times(relativeToSonnet(tier))} o sonnet`})`
    : '';
  return `modelo ${name}${price}, raciocínio ${effort || 'padrão'}`;
}

const HEAVY_EFFORTS = new Set(['high', 'xhigh', 'max']);

/** Opus ou Fable com raciocínio high ou acima. Raciocínio omitido conta como pesado: o chat costuma rodar em high. */
export function isHeavySpawn(model: string | undefined, effort: string | undefined): boolean {
  const tier = modelTier(model);
  return (tier === 'opus' || tier === 'fable') && (!effort || HEAVY_EFFORTS.has(effort));
}

/** A partir de quantos filhos pesados seguidos o spawn_agent sugere modelo menor. */
export const HEAVY_STREAK = 3;

/** Filhos pesados seguidos no fim da lista (do mais antigo ao mais novo). */
export function heavyStreak(history: boolean[]): number {
  let n = 0;
  for (let i = history.length - 1; i >= 0 && history[i]; i--) {
    n++;
  }
  return n;
}

/** Linha de sugestão quando o criador acabou de pôr o N-ésimo filho seguido em opus/fable com raciocínio alto. */
export function heavyNudge(streak: number): string {
  if (streak < HEAVY_STREAK) {
    return '';
  }
  return ` Este é o ${streak}º subagente seguido em opus/fable com raciocínio alto. Medição, bancada, integração, testes e robustez costumam caber em sonnet (medium), a metade do preço do opus; leitura e levantamento, em haiku (low). Guarde opus para projeto de solução, depuração difícil e revisão crítica.`;
}

/**
 * Linhas de gasto contra o orçamento. Com teto em US$, o custo aparece mesmo antes do primeiro valor do SDK
 * ("US$ 0,00 de US$ 35,00"), para o teto não sumir do resumo.
 */
export function spendLines(budget: AgentBudget | undefined, spent: AgentSpent | undefined, provider?: AgentInfo['provider']): string[] {
  const s: AgentSpent = { ...(spent ?? { tokens: 0, minutes: 0 }) };
  if (s.usd === undefined && budget?.maxUsd && provider !== 'codex') {
    s.usd = 0;
  }
  return budgetLines({ budget, spent: s, provider });
}

/** Soma de gastos. Custo só entra se alguém informou (agente Codex não informa). */
export function sumSpent(list: (AgentSpent | undefined)[]): AgentSpent {
  const total: AgentSpent = { tokens: 0, minutes: 0 };
  for (const s of list) {
    total.tokens += s?.tokens ?? 0;
    total.minutes += s?.minutes ?? 0;
    if (s?.usd !== undefined) {
      total.usd = (total.usd ?? 0) + s.usd;
    }
  }
  total.minutes = Math.round(total.minutes * 100) / 100;
  return total;
}

/** "US$ 1,23" do agente, ou vazio quando o custo não existe (Codex, ou nenhum turno terminou ainda). */
export function usdLabel(spent: AgentSpent | undefined): string {
  return spent?.usd !== undefined ? `${fmtUsd(spent.usd)} estimados` : '';
}

const STALE_VERB: Partial<Record<AgentInfo['status'], string>> = { completed: 'concluir', failed: 'falhar', stopped: 'parar' };

/** Status em que a nota de progresso deixa de valer: o agente não está mais trabalhando. */
export function isSettledStatus(status: AgentInfo['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped';
}

/** Nota de progresso depois da mudança de status: ao sair de rodando/aguardando, a nota vira antiga. */
export function settleProgress(progress: AgentInfo['progress'], status: AgentInfo['status']): AgentInfo['progress'] {
  return progress && !progress.stale && isSettledStatus(status) ? { ...progress, stale: true } : progress;
}

/** "progresso: X" ou, com a nota antiga, "último progresso, antes de concluir: X". */
export function progressLabel(info: Pick<AgentInfo, 'progress' | 'status'>): string {
  const p = info.progress;
  if (!p) {
    return '';
  }
  if (!p.stale) {
    return `progresso: ${p.text}`;
  }
  const verb = STALE_VERB[info.status];
  return verb ? `último progresso, antes de ${verb}: ${p.text}` : `progresso anterior: ${p.text}`;
}

/**
 * " (sem Codex)" para o US$ de um grupo que mistura agentes Codex e Claude: o Codex não informa custo, então a soma
 * só cobre os Claude. Grupo só de Codex já diz "o Codex não informa" na própria linha; sem custo, nada a ressalvar.
 */
export function codexNote(providers: (AgentInfo['provider'] | undefined)[], hasUsd: boolean): string {
  const codex = providers.filter((p) => p === 'codex').length;
  return hasUsd && codex > 0 && codex < providers.length ? ' (sem Codex)' : '';
}
