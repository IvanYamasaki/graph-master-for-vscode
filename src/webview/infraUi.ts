/**
 * Marca no grafo dos nós que não são agentes: job de GPU (estado, tempo, custo acumulado) e vigia de treino
 * (última leitura da métrica). Os dois chegam como AgentInfo com `infra`, mandados pelo hub.
 */
import type { AgentInfo, InfraNodeInfo } from '../chat/protocol';

const JOB_STATE: Record<NonNullable<InfraNodeInfo['state']>, string> = {
  pending: 'na fila',
  running: 'rodando',
  completed: 'terminou',
  failed: 'falhou',
  cancelled: 'cancelado',
  lost: 'perdido',
};

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

function fmtUsd(x: number | undefined): string {
  return x === undefined ? 'custo ?' : `US$ ${x < 10 ? x.toFixed(2) : x.toFixed(0)}`;
}

function fmtValue(v: number): string {
  if (!Number.isFinite(v)) {
    return String(v);
  }
  return Math.abs(v) >= 1000 || (v !== 0 && Math.abs(v) < 1e-3) ? v.toExponential(2) : String(Math.round(v * 10000) / 10000);
}

function cut(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Troca a linha de baixo e o texto de dica do nó quando ele é um job ou um vigia de treino. */
export function markInfraNode(node: { sub: string; detail: string; aria: string }, a: AgentInfo, maxSub: number): void {
  const x = a.infra;
  if (!x) {
    return;
  }
  if (x.kind === 'job') {
    const state = x.state ? JOB_STATE[x.state] : '';
    const gpu = `${x.gpus ?? 0}× ${x.gpuType ?? 'GPU'}`;
    // O backend fica no detalhe: a linha de baixo é o progresso (estado, tempo, custo), como nos outros nós sintéticos.
    node.sub = cut(`${state} · ${fmtElapsed(a.durationMs)} · ${fmtUsd(x.costUsd)}`, maxSub);
    node.detail = [
      a.description,
      `id: ${a.id}${x.externalId ? ` (${x.backend} ${x.externalId})` : ''}`,
      `estado: ${state}${a.summary && a.summary !== state ? ` · ${a.summary}` : ''}`,
      `recursos: ${gpu}, até ${x.hours ?? '?'} h`,
      `tempo: ${fmtElapsed(a.durationMs)}`,
      `custo acumulado: ${fmtUsd(x.costUsd)}`,
      `script: ${a.prompt ?? '—'}`,
      `pedido por: ${a.creator ?? 'main'}`,
    ].join('\n');
    node.aria = `Job ${x.backend} ${a.description}, ${state}, ${fmtElapsed(a.durationMs)}, ${fmtUsd(x.costUsd)}`;
    return;
  }
  const last = x.last ? `${x.metric} ${fmtValue(x.last.value)} @${x.last.step}` : 'sem leitura';
  // O tipo vai no ícone do nó (synthUi) e o "rodando" no anel: a linha de baixo é só a leitura.
  node.sub = cut(`${last}${x.alerts ? ` · ⚠ ${x.alerts}` : ''}`, maxSub);
  node.detail = [
    a.description,
    `id: ${a.id}${x.jobId ? ` · job ${x.jobId}` : ''}`,
    `fonte: ${x.source ?? '—'}`,
    `última leitura: ${x.last ? `${fmtValue(x.last.value)} no passo ${x.last.step}, às ${new Date(x.last.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : '—'}`,
    `alertas: ${x.alerts ?? 0}`,
    ...(a.summary ? [`estado: ${a.summary}`] : []),
  ].join('\n');
  node.aria = `Vigia de treino de ${x.metric}, ${last}, ${x.alerts ?? 0} alertas`;
}
