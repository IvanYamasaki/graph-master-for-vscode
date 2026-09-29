/**
 * Formato comum dos nós do grafo que não são agentes comuns: tentativa de Best-of-N, verificador, torneio,
 * varredura, job de GPU e vigia de treino. Todos têm o tamanho base dos agentes, um ícone de tipo discreto
 * (glifo da fonte codicon, que o painel já carrega) antes do título, e o progresso numa linha só: o texto de
 * baixo e, quando dá para medir, uma barra fina na base do nó.
 *
 * Roda depois dos marcadores específicos (infraUi, parallelUi): eles decidem o texto, este só dá o formato.
 */
import type { AgentInfo } from '../chat/protocol';

/** Pontos de código dos codicons usados como ícone de tipo. */
export const SYNTH_ICON = {
  tournament: '', // law
  sweep: '', // settings-gear
  job: '', // server-process
  trainingWatch: '', // pulse
  attempt: '', // layers
  verifier: '', // verified
  hypothesis: '', // beaker
} as const;

const KIND_NAME: Record<keyof typeof SYNTH_ICON, string> = {
  tournament: 'torneio',
  sweep: 'varredura',
  job: 'job',
  trainingWatch: 'vigia de treino',
  attempt: 'tentativa',
  verifier: 'verificador',
  hypothesis: 'hipótese',
};

export type SynthKind = keyof typeof SYNTH_ICON;

export function synthKind(a: AgentInfo): SynthKind | undefined {
  if (a.search) {
    return a.search.kind;
  }
  if (a.infra) {
    return a.infra.kind;
  }
  if (a.attempt) {
    return 'attempt';
  }
  if (a.verifier) {
    return 'verifier';
  }
  return undefined;
}

export function synthKindName(kind: SynthKind): string {
  return KIND_NAME[kind];
}

/** "3/4 partidas", "6/10 trials": a fração do começo do texto de progresso. */
function leadingFraction(text: string): number | undefined {
  const m = /^(\d+)\s*\/\s*(\d+)/.exec(text.trim());
  if (!m || !Number(m[2])) {
    return undefined;
  }
  return Math.min(1, Number(m[1]) / Number(m[2]));
}

/**
 * Ícone e barra de progresso do nó. `now` vem do tique do mapa (o job anda com o relógio).
 * Tentativa aberta: a barra é a fração do grupo que já terminou, contada por quem chama.
 */
export function markSynthNode(
  node: { icon?: string; progress?: number; sub: string; aria: string },
  a: AgentInfo,
  now: number,
  maxSub: number,
  groupDone?: number,
): void {
  const kind = synthKind(a);
  if (!kind) {
    return;
  }
  node.icon = SYNTH_ICON[kind];
  node.aria = `${KIND_NAME[kind][0].toUpperCase()}${KIND_NAME[kind].slice(1)}: ${node.aria}`;
  if (a.search) {
    node.progress = leadingFraction(a.search.progress);
  } else if (a.infra?.kind === 'job') {
    const x = a.infra;
    const budget = (x.hours ?? 0) * 3600e3;
    if (x.state === 'running' && budget && x.startedAt) {
      node.progress = Math.min(1, Math.max(0, (now - Date.parse(x.startedAt)) / budget));
    } else if (x.state === 'completed') {
      node.progress = 1;
    }
  } else if (a.attempt && !a.attempt.closed && groupDone !== undefined) {
    node.progress = groupDone / a.attempt.of;
  } else if (a.verifier) {
    // Só o estado do agente (sem tokens): a linha diz o que ele verifica e se ainda trabalha.
    const sub = `verifica ${a.verifier.hypothesisId} · ${node.sub.split(' · ')[0]}`;
    node.sub = sub.length > maxSub ? `${sub.slice(0, maxSub - 1)}…` : sub;
  }
}
