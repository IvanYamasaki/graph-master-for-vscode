/**
 * Regras puras do fim de turno de um agente roteado, separadas do hub para dar para testar sem VS Code:
 * o que ainda está pendente antes do relatório final, a janela de entregas automáticas (trava de laço),
 * o reconhecimento de erro de limite de uso e o corte de relatório longo.
 */
import type { PendingInfo, PendingReason } from './protocol';

export interface PendingInput {
  /** Tarefas em segundo plano abertas na sessão. */
  background: { id: string; description: string }[];
  /** Filhos vivos que ainda vão reportar a este agente. */
  children: string[];
  /** A quem este agente perguntou (send_to_agent com resposta esperada) e ainda não ouviu de volta. */
  asked: string[];
}

/** Quantos caracteres do texto do turno segurado ficam no nó como nota de progresso. */
const NOTE_CHARS = 600;

/** Monta o `pending` do agente, ou nada quando não falta nada. `since` é mantido de uma pendência anterior. */
export function pendingInfo(input: PendingInput, opts: { since?: string; note?: string; now?: Date } = {}): PendingInfo | undefined {
  const reasons: PendingReason[] = [];
  if (input.background.length) {
    reasons.push('background');
  }
  if (input.children.length) {
    reasons.push('children');
  }
  if (input.asked.length) {
    reasons.push('question');
  }
  if (!reasons.length) {
    return undefined;
  }
  const note = opts.note?.trim();
  return {
    reasons,
    background: input.background.length ? input.background.map((t) => ({ id: t.id, description: t.description })) : undefined,
    children: input.children.length ? [...input.children] : undefined,
    asked: input.asked.length ? [...input.asked] : undefined,
    since: opts.since ?? (opts.now ?? new Date()).toISOString(),
    note: note ? (note.length > NOTE_CHARS ? `${note.slice(0, NOTE_CHARS)}…` : note) : undefined,
  };
}

/** "processo em segundo plano (1)", "2 subagentes (a3, a4)", "resposta de main", ligados por vírgula. */
export function pendingLabel(p: PendingInfo | undefined): string {
  if (!p) {
    return '';
  }
  const parts: string[] = [];
  const bg = p.background?.length ?? 0;
  if (bg) {
    parts.push(bg === 1 ? 'processo em segundo plano' : `${bg} processos em segundo plano`);
  }
  const kids = p.children ?? [];
  if (kids.length) {
    parts.push(`${kids.length} ${kids.length === 1 ? 'subagente' : 'subagentes'} (${kids.join(', ')})`);
  }
  const asked = p.asked ?? [];
  if (asked.length) {
    parts.push(`resposta de ${asked.join(', ')}`);
  }
  return `aguardando ${parts.join(', ')}`;
}

/** Janela em que as entregas automáticas contam para a trava de laço. */
export const DELIVERY_WINDOW_MS = 10 * 60_000;

/**
 * Trava de laço entre agentes: conta só as entregas automáticas dentro da janela. Devolve a lista já podada e
 * se a próxima entrega ainda cabe. Antes o contador nunca zerava: depois de `limit` trocas o agente perdia até o relatório final.
 */
export function deliveryWindow(times: number[], now: number, limit: number, windowMs = DELIVERY_WINDOW_MS): { kept: number[]; allowed: boolean } {
  const kept = times.filter((t) => now - t < windowMs);
  return { kept, allowed: kept.length < limit };
}

/**
 * Prefixos e trechos que o CLI usa quando o limite de uso foi de fato atingido (USAGE_LIMIT_ERROR_PREFIXES do SDK,
 * mais o 429 da API). Texto de erro que casa com isto vira "limite de uso", não "falhou".
 */
const LIMIT_RE = /you've (hit|reached) your|you're out of (usage|extra usage)|out of usage credits|usage limit|rate[ _]limit|limit reached|too many requests|\b429\b/i;

/** Reconhece um erro de limite de uso no texto e tenta ler a hora de reset ("resets 3pm", "resets at 14:30"). */
export function limitFromText(text: string, now = new Date()): { until?: string; text: string } | undefined {
  if (!text || !LIMIT_RE.test(text)) {
    return undefined;
  }
  const short = text.replace(/\s+/g, ' ').trim().slice(0, 300);
  const m = /reset(?:s|ting)?(?: at| in| on)?\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?)/i.exec(short);
  return { text: short, until: m ? untilIso(m[1], now) : undefined };
}

/** "3pm" ou "14:30" de hoje (ou de amanhã, se já passou) em ISO. Sem hora reconhecível, nada. */
export function untilIso(raw: string, now = new Date()): string | undefined {
  const m = /^([0-9]{1,2})(?::([0-9]{2}))?\s*(am|pm)?/i.exec(raw.trim());
  if (!m) {
    return undefined;
  }
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  const ampm = m[3]?.toLowerCase();
  if (ampm === 'pm' && hour < 12) {
    hour += 12;
  } else if (ampm === 'am' && hour === 12) {
    hour = 0;
  }
  if (hour > 23 || minute > 59) {
    return undefined;
  }
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  if (at.getTime() < now.getTime()) {
    at.setDate(at.getDate() + 1);
  }
  return at.toISOString();
}

/** "limite de uso até 15:00" ou só "limite de uso". */
export function limitSummary(limit: { until?: string }): string {
  if (!limit.until) {
    return 'limite de uso';
  }
  const at = new Date(limit.until);
  return `limite de uso até ${at.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
}

/** Relatório acima disto vai inteiro para um arquivo; quem recebe ganha o começo mais o caminho. */
export const REPORT_INLINE_CHARS = 6000;
const REPORT_HEAD_CHARS = 2500;

/**
 * Corta um relatório longo para a entrega: o começo (até um parágrafo inteiro) mais o aviso com o caminho do arquivo.
 * `path` é onde o hub gravou o texto completo. Abaixo do teto, devolve o texto como veio.
 */
export function clipReport(text: string, path: string | undefined, max = REPORT_INLINE_CHARS): string {
  if (text.length <= max || !path) {
    return text;
  }
  let cut = text.lastIndexOf('\n\n', REPORT_HEAD_CHARS);
  if (cut < REPORT_HEAD_CHARS / 2) {
    cut = REPORT_HEAD_CHARS;
  }
  return `${text.slice(0, cut).trimEnd()}\n\n[Relatório cortado: ${text.length} caracteres no total. O texto completo está em ${path}; leia o arquivo se precisar do resto.]`;
}

/**
 * Junta o relatório segurado (escrito quando ainda havia pendência) com o texto do turno em que nada mais faltava.
 * Turno final que reescreveu o relatório inteiro (tamanho parecido ou maior) vale sozinho; turno curto ("recebi o
 * relatório de a4, tudo certo") vira atualização anexada ao segurado; turno sem texto entrega o segurado.
 */
export function mergeHeldReport(held: string | undefined, latest: string): string {
  const h = held?.trim() ?? '';
  const l = latest.trim();
  if (!h) {
    return l;
  }
  if (!l) {
    return h;
  }
  if (l.length >= h.length * 0.8) {
    return l;
  }
  return `${h}

---

Atualização depois de a pendência acabar:
${l}`;
}

/**
 * Quantas causas o fim de um turno consome. Cada mensagem enfileirada no CLI deixou uma causa por atender; um turno
 * que o CLI abriu sozinho (aviso de tarefa) não tem causa própria, então não pode roubar a de uma mensagem na fila.
 */
export function consumedCauses(total: number, queued: number, auto: boolean): number {
  const owed = Math.max(0, total - queued);
  return auto ? owed : Math.max(1, owed);
}

/**
 * A quem o texto de um turno do main responde. Só o turno que começou depois de a pergunta chegar (a pergunta abriu
 * ou entrou nesse turno) e só quando não há mais mensagens na fila do CLI: um turno sobre outro assunto, aberto
 * antes da pergunta, não pode virar "Resposta da conversa principal".
 */
export function mainAnswerTargets(askers: { id: string; askedAt: number }[], turnStartedAt: number, queued: number): string[] {
  if (queued > 0) {
    return [];
  }
  return askers.filter((a) => a.askedAt <= turnStartedAt).map((a) => a.id);
}

/**
 * Relatório segurado depois de mais um turno com pendência: junta com o texto novo (o original nunca some) e não
 * muda num turno que só respondeu a uma pergunta recebida enquanto aguardava.
 */
export function nextHeldReport(held: string | undefined, rawText: string, replyTurn: boolean): string | undefined {
  if (replyTurn || !rawText.trim()) {
    return held;
  }
  return mergeHeldReport(held, rawText);
}

/**
 * Caminhos protegidos de um agente novo: os de quem o criou (que já trazem os do avô) somados aos do spawn_agent.
 * O filho não tira proteção herdada; repetidos e vazios saem. Nenhum: undefined.
 */
export function inheritProtected(fromCreator: string[] | undefined, own: string[] | undefined): string[] | undefined {
  const all = [...new Set([...(fromCreator ?? []), ...(own ?? [])].map((p) => p.trim()).filter(Boolean))];
  return all.length ? all : undefined;
}

/**
 * Relatório que o Parar ainda deve entregar. Segurado só pelo lembrete do laboratório, o relatório já estava pronto
 * e sairia sem ele, então parar não pode apagá-lo. Segurado por pendência real (filhos, processo, resposta), o
 * Parar descarta como antes. Vazio: nada a entregar.
 */
export function reportOnStop(held: string | undefined, byReminder: boolean): string | undefined {
  const text = held?.trim();
  return byReminder && text ? text : undefined;
}
