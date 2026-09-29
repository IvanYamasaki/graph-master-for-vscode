/**
 * Elo e pareamento suíço do torneio de hipóteses. Sem VS Code e sem modelo: roda no teste com node puro.
 *
 * Como no AI co-scientist (arXiv 2502.18864), cada candidato entra com 1200 e ganha ou perde pontos a cada
 * comparação em pares. O pareamento junta candidatos de Elo parecido que ainda não se enfrentaram: é onde uma
 * partida a mais informa mais sobre a ordem.
 */

export const ELO_START = 1200;

/** Chance de A vencer B pelo Elo atual. */
export function expected(ra: number, rb: number): number {
  return 1 / (1 + 10 ** ((rb - ra) / 400));
}

/** Elo novo de A e B depois de uma partida. `scoreA`: 1 vitória de A, 0 derrota, 0.5 empate. */
export function eloUpdate(ra: number, rb: number, scoreA: number, k: number): [number, number] {
  const ea = expected(ra, rb);
  return [ra + k * (scoreA - ea), rb + k * (1 - scoreA - (1 - ea))];
}

/** Gerador pseudoaleatório com semente (mulberry32): o sorteio de A/B e dos pares fica reproduzível. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Pares de uma rodada: ordena por Elo (empates em ordem sorteada) e junta cada um com o vizinho mais próximo
 * que ainda não enfrentou; se já enfrentou todos, com o vizinho mais próximo. Número ímpar: o último fica de fora.
 */
export function swissPairs(players: { id: string; elo: number }[], played: Set<string>, random: () => number): [string, string][] {
  const order = players
    .map((p) => ({ ...p, tie: random() }))
    .sort((a, b) => b.elo - a.elo || a.tie - b.tie)
    .map((p) => p.id);
  const free = new Set(order);
  const pairs: [string, string][] = [];
  for (const a of order) {
    if (!free.has(a)) {
      continue;
    }
    free.delete(a);
    const rest = order.filter((x) => free.has(x));
    if (!rest.length) {
      break;
    }
    const b = rest.find((x) => !played.has(pairKey(a, x))) ?? rest[0];
    free.delete(b);
    pairs.push([a, b]);
  }
  return pairs;
}
