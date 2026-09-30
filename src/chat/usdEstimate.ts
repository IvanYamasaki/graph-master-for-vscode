/**
 * Custo em US$ estimado mensagem a mensagem. O SDK só informa o custo real (total_cost_usd) no fim do turno: sem a
 * estimativa, um turno longo interrompido não deixa custo nenhum e o teto max_usd só é conferido quando o turno acaba.
 * No fim do turno a estimativa dele é trocada pelo valor real. Sem VS Code.
 */
import { MODEL_PRICES, modelTier } from './costs';

/** Uso de uma mensagem do modelo, como vem em message.usage. */
export interface MessageUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** Leitura de cache sai a 10% do preço de entrada; escrita de cache, a 125%. */
export const CACHE_READ_FACTOR = 0.1;
export const CACHE_WRITE_FACTOR = 1.25;

/** US$ estimados de uma mensagem. Modelo fora da tabela: undefined (melhor não estimar que estimar errado). */
export function estimateUsd(usage: MessageUsage | undefined, model: string | undefined): number | undefined {
  const tier = modelTier(model);
  if (!usage || !tier) {
    return undefined;
  }
  const { inUsd, outUsd } = MODEL_PRICES[tier];
  const input = usage.input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  return (input * inUsd + read * inUsd * CACHE_READ_FACTOR + write * inUsd * CACHE_WRITE_FACTOR + output * outUsd) / 1e6;
}

/** Conta de US$ de um agente entre relatos de uso. */
export interface UsdTrack {
  /** Último total acumulado do SDK. Sobrevive a reinícios do processo: o resume continua do total salvo. */
  lastCostTotal: number;
  /** Estimativa somada no turno em andamento; sai quando o valor real chega. */
  turnEstimate: number;
  /** Estimativa já contada por id de mensagem: o SDK repete a mesma mensagem, com o mesmo uso, a cada bloco. */
  seen: Map<string, number>;
}

export function newUsdTrack(savedUsd: number | undefined): UsdTrack {
  return { lastCostTotal: savedUsd ?? 0, turnEstimate: 0, seen: new Map() };
}

/**
 * Aplica um relato ao gasto `usd` e devolve o valor novo, ou undefined se nada mudou.
 * - `usdEstimate` (por mensagem): soma a diferença para o que já foi contado dessa mensagem.
 * - `costUsdTotal` (fim do turno): troca a estimativa do turno pelo delta real do total acumulado.
 */
export function applyUsd(
  t: UsdTrack,
  usd: number | undefined,
  u: { messageId?: string; usdEstimate?: number; costUsdTotal?: number; processStart?: boolean },
): number | undefined {
  // Processo novo: a estimativa do turno que morreu sem result vira gasto definitivo, porque o result dele nunca
  // vem. Sem isso o próximo result descontava essa estimativa e o custo do turno morto sumia.
  if (u.processStart) {
    t.turnEstimate = 0;
    t.seen.clear();
    return undefined;
  }
  let next = usd;
  let changed = false;
  if (u.usdEstimate !== undefined && u.usdEstimate > 0) {
    const before = u.messageId ? (t.seen.get(u.messageId) ?? 0) : 0;
    const delta = u.usdEstimate - before;
    if (delta > 0) {
      if (u.messageId) {
        t.seen.set(u.messageId, u.usdEstimate);
      }
      t.turnEstimate += delta;
      next = (next ?? 0) + delta;
      changed = true;
    }
  }
  if (u.costUsdTotal !== undefined && u.costUsdTotal >= 0) {
    // Total menor que o último: o processo recomeçou sem trazer o total salvo; o valor novo é todo gasto novo.
    const real = u.costUsdTotal >= t.lastCostTotal ? u.costUsdTotal - t.lastCostTotal : u.costUsdTotal;
    t.lastCostTotal = u.costUsdTotal;
    const replaced = Math.max(0, (next ?? 0) - t.turnEstimate + real);
    if (replaced !== next || next === undefined) {
      next = replaced;
      changed = true;
    }
    t.turnEstimate = 0;
    t.seen.clear();
  }
  return changed ? next : undefined;
}
