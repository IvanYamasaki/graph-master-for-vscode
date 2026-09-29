/**
 * O que o módulo de paralelismo (Best-of-N, K seeds e verificador) precisa do hub. Mantém a regra aqui e o
 * ciclo de vida dos agentes lá, como o GuardHost do guarda.
 */
import type { AgentInfo, HostMessage, WorktreeInfo } from '../protocol';
import type { Lab } from '../lab/tools';

/** Orçamento no formato do spawn_agent (snake_case); o hub converte com AgentGuard.budgetFrom. */
export interface RawBudget {
  max_tokens?: number;
  max_minutes?: number;
  max_usd?: number;
}

export interface SpawnRequest {
  /** Id reservado com reserveId (obrigatório com worktree: a pasta e a branch levam o nome do agente). */
  id?: string;
  creator: string;
  description: string;
  prompt: string;
  reportTo: string;
  model?: string;
  effort?: string;
  color?: string;
  worktree?: WorktreeInfo;
  budget?: RawBudget;
  protectedPaths?: string[];
  /** Conta Claude do agente, quando não é a do chat (id do perfil, já resolvido por resolveAccount). */
  accountId?: string;
  /** Campos a mais no AgentInfo (attempt, verifier). */
  extra: Pick<AgentInfo, 'attempt' | 'verifier' | 'box'>;
}

export interface ParallelHost {
  /** Diretório do projeto (o do chat principal). */
  cwd: string;
  lab: Lab;
  info(id: string): AgentInfo | undefined;
  agents(): AgentInfo[];
  update(id: string, patch: Partial<AgentInfo>): void;
  post(msg: HostMessage): void;
  isBusy(id: string): boolean;
  /** Vagas antes do limite agentGraphMaster.maxRoutedAgents de agentes rodando. */
  freeSlots(): number;
  resolveTarget(raw: string | undefined, callerId: string): string | Error;
  /** Caixa do mapa: id ou nome (nome novo cria); omitido, a caixa de quem chama. */
  resolveBox(raw: string | undefined, callerId: string): string | undefined | Error;
  reserveId(): string;
  /** Conta Claude pedida (nome, id ou e-mail) → id do perfil; undefined = a conta do chat. Erro lista as contas logadas. */
  resolveAccount(raw: string | undefined): Promise<string | undefined | Error>;
  /** Cria o agente e devolve o id. */
  spawn(req: SpawnRequest): string;
  /** Entrega um relatório a "main" ou a um agente e marca a entrega em `from`. Destino "user": só grava. */
  deliverReport(target: string, text: string, from: string): void;
}
