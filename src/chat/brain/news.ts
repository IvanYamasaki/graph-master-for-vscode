/**
 * Avisos de novidades do cérebro: cada escrita entra numa fila; a cada janela (padrão 60 s) o host monta UM resumo
 * por destinatário, uma linha por nota (a mesma nota escrita várias vezes na janela vira uma linha), e entrega sem
 * abrir turno.
 * - O orquestrador ("main", recebe tudo de todas as frentes) tem janela própria e maior, e recebe um resumo por
 *   frente em vez de uma linha por nota.
 * - Decisão e armadilha nova não esperam a janela: saem na hora para todos, inclusive o orquestrador.
 * - Mudança do ESTADO.md de uma frente não gera aviso sozinha: só fecha o lote do orquestrador antes da janela se
 *   o lote já tem um evento de conteúdo (fato, nota, relatório). Lote só com ESTADO.md é descartado.
 * Entrega:
 * - agente no meio de uma ferramenta recebe no turno em andamento (mensagem com prioridade "next", que o CLI dobra
 *   na próxima fronteira de ferramenta, sem interromper);
 * - quem está parado, concluído, restaurado ou entre ferramentas fica com o resumo guardado, entregue na próxima
 *   ferramenta que ele rodar ou na frente da próxima mensagem que receber. Ninguém é acordado por causa do aviso.
 * O autor de uma novidade não a recebe.
 *
 * Sem VS Code: o hub passa quem recebe, como empurrar e o que fazer com cada entrega.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type NewsMode = 'all' | 'box' | 'off';

export interface NewsEvent {
  /** Nota, relativa a .agm/brain/. */
  rel: string;
  /** Quem escreveu (id de agente, "main", "user" ou "host"). */
  author: string;
  entryId?: string;
  /** Primeira linha útil da entrada. */
  line: string;
  /** Caixa da nota (frente ou agente) ou, sem ela, a do autor. */
  boxId?: string;
  edited?: boolean;
  at: string;
  /** Tipo do fato (decisao, armadilha, achado...), quando a novidade é um fato novo. */
  kind?: string;
  /** Nome da frente da caixa, para o resumo do orquestrador. */
  boxName?: string;
  /** O ESTADO.md da frente mudou (só o orquestrador vê). */
  state?: boolean;
  /** Decisão ou armadilha nova: sai na hora. Preenchido por BrainNews.add. */
  urgent?: boolean;
  /** Quantas escritas na mesma nota esta linha junta, e quem escreveu. Preenchido pela deduplicação. */
  n?: number;
  authors?: string[];
}

export interface NewsRecipient {
  id: string;
  boxId?: string;
}

export interface NewsDelivery {
  to: string;
  count: number;
  at: string;
  /** turno: dobrado no turno em andamento; mensagem: na frente da próxima mensagem. */
  how: 'turno' | 'mensagem';
  events: { rel: string; author: string; entryId?: string }[];
}

export interface NewsHost {
  recipients(): NewsRecipient[];
  mode(): NewsMode;
  windowMs(): number;
  /** Janela do orquestrador ("main"). Omitida: a mesma dos agentes. */
  mainWindowMs?(): number;
  /** Entrega agora, sem abrir turno. false: o destinatário não está no meio de uma ferramenta; o resumo fica guardado. */
  tryPush(id: string, text: string): boolean;
  delivered(d: NewsDelivery): void;
}

/** Linhas por resumo; o resto vira "e mais N". */
const MAX_LINES = 12;
/** Novidades guardadas por destinatário parado. */
const MAX_PENDING = 40;
/** Fila grande fecha o lote antes da janela. */
const BATCH_MAX = 20;
const MAIN_BATCH_MAX = 40;
/** Limites do resumo do orquestrador. */
const MAIN_MAX_FRONTS = 8;
const MAIN_MAX_TITLES = 4;
const MAIN_MAX_URGENT = 8;
export const NEWS_HEADER = 'Novidades no cérebro compartilhado';
export const MAIN_RECIPIENT = 'main';
/** Tipos de fato que não esperam a janela. */
const URGENT_KINDS = new Set(['decisao', 'armadilha']);

export class BrainNews {
  private queue: NewsEvent[] = [];
  private mainQueue: NewsEvent[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private mainTimer?: ReturnType<typeof setTimeout>;
  private readonly pending = new Map<string, NewsEvent[]>();

  constructor(private readonly host: NewsHost) {}

  add(events: NewsEvent[]): void {
    if (this.host.mode() === 'off' || !events.length) {
      return;
    }
    const tagged = events.map((e) => (isUrgent(e) ? { ...e, urgent: true } : e));
    const urgent = tagged.filter((e) => e.urgent);
    const rest = tagged.filter((e) => !e.urgent);
    if (urgent.length) {
      this.dispatch(urgent);
    }
    if (!rest.length) {
      return;
    }
    const forAgents = rest.filter((e) => !e.state);
    if (forAgents.length) {
      this.queue.push(...forAgents);
      if (this.queue.length >= BATCH_MAX) {
        this.flushAgents();
      } else if (!this.timer) {
        this.timer = setTimeout(() => this.flushAgents(), this.host.windowMs());
      }
    }
    this.mainQueue.push(...rest);
    // ESTADO.md sozinho não diz nada: só fecha o lote cedo se ele já tem um evento de conteúdo.
    if (this.mainQueue.length >= MAIN_BATCH_MAX || (rest.some((e) => e.state) && this.mainQueue.some((e) => !e.state))) {
      this.flushMain();
    } else if (!this.mainTimer) {
      this.mainTimer = setTimeout(() => this.flushMain(), this.host.mainWindowMs?.() ?? this.host.windowMs());
    }
  }

  /** Fecha os dois lotes (agentes e orquestrador). */
  flush(): void {
    this.flushAgents();
    this.flushMain();
  }

  /** Fecha o lote dos agentes: distribui as novidades e tenta entregar a quem está no meio de uma ferramenta. */
  private flushAgents(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.dispatch(this.queue.splice(0), (r) => r.id !== MAIN_RECIPIENT);
  }

  private flushMain(): void {
    clearTimeout(this.mainTimer);
    this.mainTimer = undefined;
    const batch = this.mainQueue.splice(0);
    // Lote só com ESTADO.md não tem nada a dizer.
    if (batch.some((e) => !e.state)) {
      this.dispatch(batch, (r) => r.id === MAIN_RECIPIENT);
    }
  }

  private dispatch(events: NewsEvent[], only?: (r: NewsRecipient) => boolean): void {
    const mode = this.host.mode();
    if (!events.length || mode === 'off') {
      return;
    }
    for (const r of this.host.recipients()) {
      if (only && !only(r)) {
        continue;
      }
      // "box": só o que é da caixa do destinatário. O orquestrador (sem caixa) recebe tudo.
      // Mudança de ESTADO.md só interessa ao orquestrador.
      const mine = events.filter((e) => e.author !== r.id && (r.id === MAIN_RECIPIENT || !e.state) && (mode === 'all' || !r.boxId || e.boxId === r.boxId));
      if (!mine.length) {
        continue;
      }
      this.pending.set(r.id, mergeEvents([...(this.pending.get(r.id) ?? []), ...mine]).slice(-MAX_PENDING));
      this.retry(r.id, r.boxId);
    }
  }

  /** Tenta de novo a entrega sem turno (o hub chama quando o destinatário começa uma ferramenta). */
  retry(id: string, boxId?: string): void {
    const list = this.pending.get(id);
    if (!list?.length) {
      return;
    }
    if (this.host.tryPush(id, digestFor(id, list, boxId ?? this.boxOf(id)))) {
      this.pending.delete(id);
      this.report(id, list, 'turno');
    }
  }

  /** Resumo guardado para ir na frente da próxima mensagem do destinatário (e esvazia a pendência). */
  take(id: string): string | undefined {
    const list = this.pending.get(id);
    if (!list?.length) {
      return undefined;
    }
    this.pending.delete(id);
    this.report(id, list, 'mensagem');
    return digestFor(id, list, this.boxOf(id));
  }

  hasPending(id: string): boolean {
    return !!this.pending.get(id)?.length;
  }

  /** Conversa limpa ou hub fechado. */
  reset(): void {
    clearTimeout(this.timer);
    clearTimeout(this.mainTimer);
    this.timer = undefined;
    this.mainTimer = undefined;
    this.queue = [];
    this.mainQueue = [];
    this.pending.clear();
  }

  private boxOf(id: string): string | undefined {
    return this.host.recipients().find((r) => r.id === id)?.boxId;
  }

  private report(id: string, list: NewsEvent[], how: NewsDelivery['how']): void {
    this.host.delivered({
      to: id,
      count: list.length,
      at: new Date().toISOString(),
      how,
      events: list.map((e) => ({ rel: e.rel, author: e.author, entryId: e.entryId })),
    });
  }
}

/**
 * Registro das entregas para depuração, em `.agm/cache/brain-news.jsonl` (fora do git: `cache/` está no
 * `.agm/.gitignore`). Falha de disco não atrapalha a entrega.
 */
export function logBrainNews(root: string, rec: NewsDelivery & { conversation?: string }): void {
  try {
    const dir = path.join(root, '.agm', 'cache');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'brain-news.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
  } catch {
    // só depuração
  }
}

const PREAMBLE = `${NEWS_HEADER} (aviso automático do host, só informativo: não é tarefa nem pedido; abra a nota com brain_read só se for relevante para o que você está fazendo, e siga no seu trabalho)`;

/** Fato novo de tipo decisao ou armadilha. Edição não conta: o fato já saiu quando nasceu. */
export function isUrgent(e: NewsEvent): boolean {
  return !!e.urgent || (!e.edited && !e.state && !!e.kind && URGENT_KINDS.has(e.kind));
}

/** A mesma nota várias vezes no lote vira uma novidade só: a última linha, quantas escritas e quem escreveu. */
export function mergeEvents(list: NewsEvent[]): NewsEvent[] {
  const byRel = new Map<string, NewsEvent>();
  for (const e of list) {
    const prev = byRel.get(e.rel);
    if (!prev) {
      byRel.set(e.rel, { ...e, n: e.n ?? 1, authors: [...(e.authors ?? [e.author])] });
      continue;
    }
    byRel.set(e.rel, {
      ...e,
      edited: !!prev.edited && !!e.edited,
      urgent: prev.urgent || e.urgent,
      state: prev.state && e.state,
      kind: e.kind ?? prev.kind,
      boxId: e.boxId ?? prev.boxId,
      boxName: e.boxName ?? prev.boxName,
      n: (prev.n ?? 1) + (e.n ?? 1),
      authors: [...new Set([...(prev.authors ?? [prev.author]), ...(e.authors ?? [e.author])])],
    });
  }
  return [...byRel.values()];
}

export function digestFor(id: string, list: NewsEvent[], boxId?: string): string {
  return id === MAIN_RECIPIENT ? digestMain(list) : digest(list, boxId);
}

/** Uma linha por nota, primeiro as da caixa do destinatário, e só o nome da nota: o conteúdo fica no cérebro. */
export function digest(list: NewsEvent[], boxId?: string): string {
  const ordered = mergeEvents(list.filter((e) => !e.state)).sort(
    (a, b) => Number(b.boxId !== undefined && b.boxId === boxId) - Number(a.boxId !== undefined && a.boxId === boxId) || a.at.localeCompare(b.at),
  );
  const lines = ordered.slice(0, MAX_LINES).map((e) => `- ${eventLine(e)}`);
  if (ordered.length > MAX_LINES) {
    lines.push(`- e mais ${ordered.length - MAX_LINES} (brain_read() mostra as últimas atualizações)`);
  }
  return [`${PREAMBLE}:`, ...lines].join('\n');
}

function eventLine(e: NewsEvent): string {
  const who = (e.authors ?? [e.author]).join(', ');
  const tag = e.urgent && e.kind ? ` [${e.kind}]` : '';
  return `${who} · ${e.rel}${tag}${e.edited ? ' (editou)' : ''}${(e.n ?? 1) > 1 ? ` (${e.n} escritas)` : ''} · ${clip(e.line, 120)}`;
}

/**
 * Resumo do orquestrador: decisões e armadilhas uma a uma (são poucas e mudam o rumo), o resto como uma linha por
 * frente ("frente X: N fatos novos (títulos curtos)"), limitada. O detalhe fica no cérebro.
 */
export function digestMain(list: NewsEvent[]): string {
  const merged = mergeEvents(list);
  const urgent = merged.filter((e) => e.urgent).sort((a, b) => a.at.localeCompare(b.at));
  const fronts = new Map<string, { name: string; facts: NewsEvent[]; notes: number; state: boolean; first: string }>();
  for (const e of merged) {
    if (e.urgent) {
      continue;
    }
    const key = e.boxId ?? '';
    const f = fronts.get(key) ?? fronts.set(key, { name: e.boxName ?? (e.boxId ? `caixa ${e.boxId}` : 'sem frente'), facts: [], notes: 0, state: false, first: e.at }).get(key)!;
    if (e.state) {
      f.state = true;
    } else if (e.rel.startsWith('fatos/') && !e.edited) {
      f.facts.push(e);
    } else {
      f.notes++;
    }
    if (e.at < f.first) {
      f.first = e.at;
    }
  }
  const lines = urgent.slice(0, MAIN_MAX_URGENT).map((e) => `- ${eventLine(e)}`);
  if (urgent.length > MAIN_MAX_URGENT) {
    lines.push(`- e mais ${urgent.length - MAIN_MAX_URGENT} decisões ou armadilhas (brain_read() mostra as últimas atualizações)`);
  }
  const groups = [...fronts.values()].sort((a, b) => b.facts.length + b.notes - (a.facts.length + a.notes) || a.first.localeCompare(b.first));
  for (const f of groups.slice(0, MAIN_MAX_FRONTS)) {
    const parts: string[] = [];
    if (f.facts.length) {
      const titles = f.facts.slice(0, MAIN_MAX_TITLES).map((e) => clip(e.line, 70));
      const rest = f.facts.length - titles.length;
      parts.push(`${f.facts.length} ${f.facts.length === 1 ? 'fato novo' : 'fatos novos'} (${titles.join('; ')}${rest > 0 ? `; e mais ${rest}` : ''})`);
    }
    if (f.notes) {
      parts.push(`${f.notes} ${f.notes === 1 ? 'nota atualizada' : 'notas atualizadas'}`);
    }
    if (f.state) {
      parts.push('ESTADO.md mudou');
    }
    lines.push(`- frente ${f.name}: ${parts.join(', ')}`);
  }
  if (groups.length > MAIN_MAX_FRONTS) {
    const rest = groups.slice(MAIN_MAX_FRONTS);
    lines.push(`- e mais ${rest.length} frentes com ${rest.reduce((n, f) => n + f.facts.length + f.notes, 0)} novidades (brain_read() mostra as últimas atualizações)`);
  }
  return [`${PREAMBLE}. Resumo por frente:`, ...lines].join('\n');
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}
