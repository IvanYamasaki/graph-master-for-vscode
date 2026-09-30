/**
 * Manutenção automática do cérebro, sem modelo: decide quando ele nasce numa conversa e traduz os eventos do hub
 * (agente criado, caixa criada, agente movido, relatório entregue, veredito do laboratório) em escritas no store.
 *
 * O cérebro nasce quando a conversa cria uma caixa ou quando dois ou mais agentes rodam em paralelo. Projeto que
 * já tem `.agm/brain/` continua sendo mantido em qualquer conversa. Vigias ficam de fora: leem conteúdo de terceiros
 * e não têm as ferramentas do cérebro.
 *
 * Toda escrita é assíncrona e passa pela fila do store; falha vai para o console e não atrapalha o hub.
 */
import * as path from 'node:path';
import type { AgentInfo, BoxInfo } from '../protocol';
import { BrainNews, type NewsHost } from './news';
import type { AgentCard, FrontCard } from './store';
import { Brain } from './tools';

export interface BrainKeeperHost {
  /** Raiz do projeto principal. */
  cwd: string;
  conversation(): string | undefined;
  agents(): AgentInfo[];
  boxes(): BoxInfo[];
  /** O cérebro acabou de nascer nesta conversa (o webview mostra o botão). */
  onActivate?(): void;
  /** Quem recebe, como empurrar sem turno e o registro das entregas dos avisos de novidade (news.ts). */
  news: NewsHost;
  /** Mapa estático do código (graphify) mais velho que isto ganha aviso no índice. */
  graphStaleDays?: () => number;
}

export class BrainKeeper {
  readonly brain: Brain;
  /** Avisos de novidade agrupados: cada escrita no cérebro entra aqui. */
  readonly news: BrainNews;
  private active: boolean;

  constructor(private readonly host: BrainKeeperHost) {
    this.brain = new Brain(host.cwd, () => host.conversation(), { graphStaleDays: host.graphStaleDays });
    this.news = new BrainNews(host.news);
    this.brain.store.onChange = (events) => this.news.add(events);
    this.active = this.brain.store.exists();
  }

  /**
   * Texto a mandar para `id`: o resumo de novidades guardado (se houver) vai na frente. Comando de barra fica
   * como está (o resumo espera a próxima mensagem).
   */
  withNews(id: string, text: string): string {
    if (text.trimStart().startsWith('/')) {
      return text;
    }
    const digest = this.news.take(id);
    return digest ? `${digest}\n\n---\n\n${text}` : text;
  }

  /**
   * Aviso para agente que já estava rodando quando o cérebro ligou (o prompt de sistema dele foi congelado sem o guia):
   * o guia do cérebro mais o resumo de entrada. O hub entrega em `onActivate` (uma vez por agente, sem abrir turno).
   */
  lateNotice(info: AgentInfo): string {
    return [
      'O cérebro compartilhado do projeto (.agm/brain/) foi ligado agora, depois que você começou. As ferramentas brain_read, brain_search, brain_fact, brain_write e brain_edit já estão disponíveis. Aviso do host, sem tarefa nova: siga no seu trabalho e use o cérebro como abaixo.',
      '',
      ...this.brain.guide(false, { boxId: info.box, task: info.prompt ?? info.description }),
    ].join('\n');
  }

  /** O cérebro existe (ou vai existir assim que a primeira escrita da fila terminar). */
  get isActive(): boolean {
    return this.active || this.brain.store.exists();
  }

  /** Agente criado, movido de caixa ou com estado novo. */
  agentChanged(info: AgentInfo): void {
    if (!counts(info)) {
      return;
    }
    if (this.activateIfNeeded()) {
      return;
    }
    if (this.active) {
      this.run(this.brain.store.upsertAgent(agentCard(info)));
    }
  }

  boxChanged(box: BoxInfo): void {
    if (this.activateIfNeeded()) {
      return;
    }
    if (this.active) {
      this.run(this.brain.store.upsertFront(frontCard(box)));
    }
  }

  /** Relatório final entregue: resumo na nota do agente. `files`: arquivos alterados no worktree, se houver. */
  report(info: AgentInfo, to: string, text: string, files?: string[]): void {
    if (!this.active || !counts(info)) {
      return;
    }
    this.run(
      this.brain.store
        .upsertAgent(agentCard(info))
        .then(() => this.brain.store.recordReport(info.id, { to, text, files, status: info.status })),
    );
  }

  verdict(v: { hypothesisId: string; title: string; verdict: string; by: string; detail?: string }): void {
    if (this.active) {
      this.run(this.brain.store.recordVerdict(v));
    }
  }

  /** Liga o cérebro (uma vez) quando a conversa pede. Devolve true se ligou agora: a ativação já grava tudo. */
  private activateIfNeeded(): boolean {
    if (this.active) {
      return false;
    }
    const agents = this.host.agents().filter(counts);
    const boxes = this.host.boxes();
    if (!boxes.length && agents.filter((a) => a.status === 'running').length < 2) {
      return false;
    }
    this.active = true;
    this.run(this.brain.store.activate(path.basename(this.host.cwd), boxes.map(frontCard), agents.map(agentCard)).then(() => this.host.onActivate?.()));
    return true;
  }

  private run(p: Promise<unknown>): void {
    p.catch((err) => console.error('[agm] cérebro:', err));
  }
}

/** Agente que ganha nota: roteado (inclui tentativas e verificadores), sem vigia, busca ou job. */
function counts(a: AgentInfo): boolean {
  return a.kind === 'routed' && !a.repeatEveryMinutes && !a.search && !a.infra;
}

function agentCard(a: AgentInfo): AgentCard {
  // Conta só quando não é a do chat: Codex sempre; Claude quando o agente tem accountId próprio.
  const account = a.provider === 'codex' || a.accountId ? (a.profileName ?? a.accountId) : undefined;
  return {
    id: a.id,
    description: a.description,
    task: a.prompt,
    creator: a.creator,
    reportTo: a.reportTo,
    provider: a.provider,
    account,
    model: a.model,
    effort: a.effort,
    boxId: a.box,
    status: a.status,
    worktreeBranch: a.worktree?.branch,
  };
}

function frontCard(b: BoxInfo): FrontCard {
  return { boxId: b.id, name: b.name, description: b.description, parentBoxId: b.parent };
}
