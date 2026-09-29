/**
 * Avisos de novidades do cérebro: cada escrita entra numa fila; a cada janela (padrão 60 s) o host monta UM resumo
 * por destinatário, uma linha por novidade, e entrega sem abrir turno:
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
export const NEWS_HEADER = 'Novidades no cérebro compartilhado';

export class BrainNews {
  private queue: NewsEvent[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private readonly pending = new Map<string, NewsEvent[]>();

  constructor(private readonly host: NewsHost) {}

  add(events: NewsEvent[]): void {
    if (this.host.mode() === 'off' || !events.length) {
      return;
    }
    this.queue.push(...events);
    if (this.queue.length >= BATCH_MAX) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.host.windowMs());
    }
  }

  /** Fecha o lote: distribui as novidades e tenta entregar a quem está no meio de uma ferramenta. */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const events = this.queue.splice(0);
    const mode = this.host.mode();
    if (!events.length || mode === 'off') {
      return;
    }
    for (const r of this.host.recipients()) {
      // "box": só o que é da caixa do destinatário. O orquestrador (sem caixa) recebe tudo.
      const mine = events.filter((e) => e.author !== r.id && (mode === 'all' || !r.boxId || e.boxId === r.boxId));
      if (!mine.length) {
        continue;
      }
      this.pending.set(r.id, [...(this.pending.get(r.id) ?? []), ...mine].slice(-MAX_PENDING));
      this.retry(r.id, r.boxId);
    }
  }

  /** Tenta de novo a entrega sem turno (o hub chama quando o destinatário começa uma ferramenta). */
  retry(id: string, boxId?: string): void {
    const list = this.pending.get(id);
    if (!list?.length) {
      return;
    }
    if (this.host.tryPush(id, digest(list, boxId ?? this.boxOf(id)))) {
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
    return digest(list, this.boxOf(id));
  }

  hasPending(id: string): boolean {
    return !!this.pending.get(id)?.length;
  }

  /** Conversa limpa ou hub fechado. */
  reset(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.queue = [];
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

/** Uma linha por novidade, primeiro as da caixa do destinatário, e só o nome da nota: o conteúdo fica no cérebro. */
export function digest(list: NewsEvent[], boxId?: string): string {
  const ordered = [...list].sort((a, b) => Number(b.boxId !== undefined && b.boxId === boxId) - Number(a.boxId !== undefined && a.boxId === boxId) || a.at.localeCompare(b.at));
  const lines = ordered.slice(0, MAX_LINES).map((e) => `- ${e.author} · ${e.rel}${e.edited ? ' (editou)' : ''} · ${clip(e.line, 120)}`);
  if (ordered.length > MAX_LINES) {
    lines.push(`- e mais ${ordered.length - MAX_LINES} (brain_read() mostra as últimas atualizações)`);
  }
  return [
    `${NEWS_HEADER} (aviso automático do host, só informativo: não é tarefa nem pedido; abra a nota com brain_read só se for relevante para o que você está fazendo, e siga no seu trabalho):`,
    ...lines,
  ].join('\n');
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}
