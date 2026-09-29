import type { AgentInfo, BoxInfo, HistoryItem } from '../protocol';

/** Item do log de um agente com a hora em que chegou (ms). Itens de antes de a janela abrir vêm sem hora. */
export interface TimedItem {
  item: HistoryItem;
  at?: number;
}

/** Um agente visto de fora: o que o mapa mostra mais o log dele. Só leitura. */
export interface CompanionAgent {
  info: AgentInfo;
  /** O processo do agente está no meio de um turno agora. */
  busy: boolean;
  /** Início do turno em andamento (ms), quando busy. */
  turnStartedAt?: number;
  items: TimedItem[];
}

/** Mensagem da conversa principal, sem ferramentas. `from` diz quem escreveu. */
export interface MainMessage {
  from: 'user' | 'assistant' | 'report';
  text: string;
  /** Rótulo de quem entregou, em relatórios de agentes ("agente a3"). */
  label?: string;
}

/** Ferramentas só de leitura que já existem no servidor "agents" e o chat lateral reaproveita. */
export type ReadOnlyTool = 'read_board' | 'worktree_status' | 'search_status' | 'list_jobs' | 'brain_read' | 'brain_search';

/**
 * O que o chat lateral enxerga do chat principal. Tudo aqui só lê: nenhum método muda agente, conversa ou arquivo.
 * O painel principal monta isto a partir do hub e da sessão dele.
 */
export interface CompanionSource {
  /** Nome da conversa principal, para o título da aba e o prompt. */
  title(): string;
  /** Modelo e raciocínio do chat principal (o que os agentes herdam). */
  mainModel(): { model: string; effort: string };
  /** O chat principal está no meio de um turno. */
  mainBusy(): boolean;
  /** Agentes roteados, subagentes da ferramenta Agent, continuações, jobs e buscas desta conversa. */
  agents(): CompanionAgent[];
  boxes(): BoxInfo[];
  /** Últimas mensagens da conversa principal, da mais antiga para a mais nova. */
  mainRecent(last: number): Promise<MainMessage[]>;
  /** Chama uma ferramenta de leitura do servidor "agents" com estes argumentos e devolve o texto dela. */
  readTool(name: ReadOnlyTool, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }>;
}

/** Dados do chat lateral no `init` do webview. */
export interface CompanionInit {
  /** Nome da conversa principal. */
  mainTitle: string;
  /** Perguntas de exemplo do estado vazio (já com os ids dos agentes). */
  examples: string[];
}
