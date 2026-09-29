import type { Memento } from 'vscode';
import { AgentInfo, AgentStatus } from './protocol';
import type { WorktreeInfo } from './protocol';
import type { AgentBudget, AgentSpent } from './protocol';
import type { AttemptInfo, BoxInfo } from './protocol';

/** Chave única no workspaceState; dentro dela cada conversa principal tem a sua lista de agentes. */
const KEY = 'agentGraphMaster.routedAgents';

/** Teto por conversa: o mapa de agentes não precisa de mais que isso, e o state é compartilhado com o resto da extensão. */
const MAX_AGENTS = 40;
/** Quantas conversas ficam guardadas; passando disso, a mais antiga sai. */
const MAX_CONVERSATIONS = 20;
/** Relatório longo é o que mais pesa; o resto do texto fica na sessão do próprio agente. */
const MAX_REPORT_CHARS = 8000;
/** Junta as gravações de uma rajada de updates numa só. */
const SAVE_DELAY_MS = 1000;

const STATUSES: readonly AgentStatus[] = ['running', 'completed', 'failed', 'stopped'];

/** O que de um agente roteado sobrevive ao fechamento da janela. */
export interface StoredAgent {
  id: string;
  description: string;
  status: AgentStatus;
  totalTokens: number;
  durationMs: number;
  toolUses: number;
  prompt?: string;
  creator?: string;
  reportTo?: string;
  exchanges?: number;
  model?: string;
  effort?: string;
  report?: string;
  reportedTo?: string;
  reportedAt?: string;
  summary?: string;
  lastTool?: string;
  profileName?: string;
  /** Nome da cor do agente: volta igual depois de reabrir a conversa. */
  color?: string;
  /** Sessão do Claude Code do agente: sem ela não há como retomar o trabalho dele. */
  sessionId?: string;
  /** Vigia: intervalo, fim da última verificação e contagem. Volta parado; o Retomar reativa. */
  repeatEveryMinutes?: number;
  lastCheckAt?: string;
  checks?: number;
  /** Agente do Codex: fornecedor e conta em que ele roda. O sessionId dele é o id da thread do Codex. */
  provider?: 'claude' | 'codex';
  accountId?: string;
  /** Agente de navegador. Volta sem o navegador ligado; o Retomar pede de novo. */
  browser?: boolean;
  /** Agente isolado: caminho, branch e ponto de partida do worktree. Ao restaurar, o hub confere se a pasta ainda existe. */
  worktree?: WorktreeInfo;
  /** Orçamento e consumo: ao retomar, o gasto continua de onde parou. */
  budget?: AgentBudget;
  spent?: AgentSpent;
  /** Caminhos protegidos pedidos no spawn_agent (os do projeto vêm de .agm/protected.json). */
  protectedPaths?: string[];
  /** Tentativa de Best-of-N: grupo, posição e, com o grupo fechado, valor, ranking e vencedora. */
  attempt?: AttemptInfo;
  /** Verificador independente: hipótese e veredito que ele verifica. */
  verifier?: { hypothesisId: string; verdictId: string };
  /** Caixa do mapa em que o agente está. */
  box?: string;
}

interface StoredConversation {
  savedAt: number;
  agents: StoredAgent[];
  /** Caixas do mapa desta conversa. Ausente em conversas salvas antes das caixas. */
  boxes?: BoxInfo[];
}

/** Mais caixas que isso numa conversa não cabe no mapa de qualquer jeito. */
const MAX_BOXES = 40;

type StoredMap = Record<string, StoredConversation>;

/**
 * Guarda os agentes roteados por conversa principal no workspaceState. Nada vai para arquivo do projeto:
 * é estado da interface, e quem tem o histórico de verdade é o próprio Claude Code, pelo sessionId de cada agente.
 */
export class AgentStore {
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: { key: string; agents: StoredAgent[]; boxes: BoxInfo[] };

  constructor(private readonly memento: Memento) {}

  load(key: string): StoredAgent[] {
    return readMap(this.memento)[key]?.agents ?? [];
  }

  loadBoxes(key: string): BoxInfo[] {
    return readMap(this.memento)[key]?.boxes ?? [];
  }

  /** Agenda a gravação. Chamadas seguidas na mesma conversa viram uma só. */
  save(key: string, agents: AgentInfo[], boxes: BoxInfo[] = []): void {
    if (!key) {
      return;
    }
    // Só os mais recentes entram, e o relatório vai cortado.
    this.pending = { key, agents: agents.slice(-MAX_AGENTS).map(toStored), boxes: boxes.slice(-MAX_BOXES).map((b) => ({ ...b })) };
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // Erro dentro de um timer não tem quem o pegue: sem este try, uma falha ao gravar derruba o processo.
      try {
        void this.write();
      } catch (err) {
        console.error('[agentGraphMaster] falha ao salvar os agentes:', err);
      }
    }, SAVE_DELAY_MS);
  }

  /** Grava agora o que estava agendado. Usado ao fechar o painel ou trocar de conversa. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    void this.write();
  }

  /** Esquece uma conversa (nova conversa no mesmo painel). */
  forget(key: string): void {
    if (this.pending?.key === key) {
      this.pending = undefined;
    }
    const map = readMap(this.memento);
    if (map[key]) {
      delete map[key];
      void this.memento.update(KEY, map);
    }
  }

  private async write(): Promise<void> {
    const entry = this.pending;
    this.pending = undefined;
    if (!entry) {
      return;
    }
    const map = readMap(this.memento);
    if (!entry.agents.length && !entry.boxes.length) {
      delete map[entry.key];
    } else {
      map[entry.key] = { savedAt: Date.now(), agents: entry.agents, ...(entry.boxes.length ? { boxes: entry.boxes } : {}) };
    }
    await this.memento.update(KEY, prune(map));
  }
}

/** Deixa só as conversas mais recentes pela data da última gravação. */
function prune(map: StoredMap): StoredMap {
  const keys = Object.keys(map);
  if (keys.length <= MAX_CONVERSATIONS) {
    return map;
  }
  const keep = keys.sort((a, b) => map[b].savedAt - map[a].savedAt).slice(0, MAX_CONVERSATIONS);
  const next: StoredMap = {};
  for (const key of keep) {
    next[key] = map[key];
  }
  return next;
}

function toStored(info: AgentInfo): StoredAgent {
  const stored: StoredAgent = {
    id: info.id,
    description: info.description,
    status: info.status,
    totalTokens: info.totalTokens,
    durationMs: info.durationMs,
    toolUses: info.toolUses,
  };
  const copy = <K extends keyof StoredAgent & keyof AgentInfo>(field: K): void => {
    const value = info[field];
    if (value !== undefined) {
      stored[field] = value as StoredAgent[K];
    }
  };
  for (const field of ['prompt', 'creator', 'reportTo', 'exchanges', 'model', 'effort', 'reportedTo', 'reportedAt', 'summary', 'lastTool', 'profileName', 'color', 'sessionId', 'repeatEveryMinutes', 'lastCheckAt', 'checks', 'provider', 'accountId', 'browser', 'worktree', 'box'] as const) {
    copy(field);
  }
  if (info.budget) {
    stored.budget = { ...info.budget };
  }
  if (info.spent) {
    stored.spent = { ...info.spent };
  }
  if (info.protectedPaths?.length) {
    stored.protectedPaths = [...info.protectedPaths];
  }
  if (info.attempt) {
    stored.attempt = { ...info.attempt };
  }
  if (info.verifier) {
    stored.verifier = { ...info.verifier };
  }
  if (info.report) {
    stored.report = info.report.length > MAX_REPORT_CHARS ? `${info.report.slice(0, MAX_REPORT_CHARS)}\n\n(relatório cortado ao salvar)` : info.report;
  }
  return stored;
}

// ---------- Leitura defensiva: o que está no state pode ser de uma versão antiga da extensão ----------

function readMap(memento: Memento): StoredMap {
  const raw = memento.get<unknown>(KEY);
  const map: StoredMap = {};
  if (!isRecord(raw)) {
    return map;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value) || !Array.isArray(value.agents)) {
      continue;
    }
    const agents = value.agents.map(toAgent).filter((a): a is StoredAgent => a !== undefined);
    const boxes = Array.isArray(value.boxes) ? value.boxes.map(toBox).filter((b): b is BoxInfo => b !== undefined) : [];
    if (agents.length || boxes.length) {
      map[key] = { savedAt: num(value.savedAt) ?? 0, agents, ...(boxes.length ? { boxes } : {}) };
    }
  }
  return map;
}

function toAgent(raw: unknown): StoredAgent | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const id = str(raw.id);
  if (!id) {
    return undefined;
  }
  const status = str(raw.status);
  const agent: StoredAgent = {
    id,
    description: str(raw.description) ?? id,
    status: STATUSES.includes(status as AgentStatus) ? (status as AgentStatus) : 'stopped',
    totalTokens: num(raw.totalTokens) ?? 0,
    durationMs: num(raw.durationMs) ?? 0,
    toolUses: num(raw.toolUses) ?? 0,
    prompt: str(raw.prompt),
    creator: str(raw.creator),
    reportTo: str(raw.reportTo),
    exchanges: num(raw.exchanges),
    model: str(raw.model),
    effort: str(raw.effort),
    report: str(raw.report),
    reportedTo: str(raw.reportedTo),
    reportedAt: str(raw.reportedAt),
    summary: str(raw.summary),
    lastTool: str(raw.lastTool),
    profileName: str(raw.profileName),
    color: str(raw.color),
    sessionId: str(raw.sessionId),
    repeatEveryMinutes: num(raw.repeatEveryMinutes),
    lastCheckAt: str(raw.lastCheckAt),
    checks: num(raw.checks),
    provider: raw.provider === 'codex' ? 'codex' : undefined,
    accountId: str(raw.accountId),
    browser: raw.browser === true ? true : undefined,
    worktree: toWorktree(raw.worktree),
    budget: toBudget(raw.budget),
    spent: toSpent(raw.spent),
    protectedPaths: Array.isArray(raw.protectedPaths) ? raw.protectedPaths.filter((p): p is string => typeof p === 'string' && !!p) : undefined,
    attempt: toAttempt(raw.attempt),
    verifier: isRecord(raw.verifier) && str(raw.verifier.hypothesisId) && str(raw.verifier.verdictId) ? { hypothesisId: str(raw.verifier.hypothesisId)!, verdictId: str(raw.verifier.verdictId)! } : undefined,
    box: str(raw.box),
  };
  return agent;
}

function toBox(raw: unknown): BoxInfo | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const id = str(raw.id);
  const name = str(raw.name);
  if (!id || !name) {
    return undefined;
  }
  return { id, name, description: str(raw.description), color: str(raw.color), parent: str(raw.parent), createdAt: str(raw.createdAt) ?? new Date(0).toISOString() };
}

function toBudget(raw: unknown): AgentBudget | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const budget: AgentBudget = { maxTokens: num(raw.maxTokens), maxMinutes: num(raw.maxMinutes), maxUsd: num(raw.maxUsd) };
  return budget.maxTokens || budget.maxMinutes || budget.maxUsd ? budget : undefined;
}

function toSpent(raw: unknown): AgentSpent | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  return { tokens: num(raw.tokens) ?? 0, minutes: num(raw.minutes) ?? 0, usd: num(raw.usd) };
}

const WORKTREE_STATUSES: readonly WorktreeInfo['status'][] = ['active', 'merged', 'discarded', 'missing'];

function toWorktree(raw: unknown): WorktreeInfo | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const [wtPath, branch, base, baseCommit, repo] = [str(raw.path), str(raw.branch), str(raw.base), str(raw.baseCommit), str(raw.repo)];
  if (!wtPath || !branch || !base || !baseCommit || !repo) {
    return undefined;
  }
  const status = WORKTREE_STATUSES.find((s) => s === raw.status) ?? 'active';
  return { path: wtPath, branch, base, baseCommit, repo, cwd: str(raw.cwd) ?? wtPath, status, changed: num(raw.changed), ahead: num(raw.ahead) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toAttempt(raw: unknown): AttemptInfo | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const group = str(raw.group);
  const index = num(raw.index);
  const of = num(raw.of);
  const metric = str(raw.metric);
  if (!group || !index || !of || !metric) {
    return undefined;
  }
  return {
    group,
    index,
    of,
    metric,
    direction: raw.direction === 'lower' ? 'lower' : 'higher',
    closed: raw.closed === true ? true : undefined,
    value: num(raw.value),
    source: raw.source === 'result.json' || raw.source === 'log_run' ? raw.source : undefined,
    hash: str(raw.hash),
    rank: num(raw.rank),
    winner: raw.winner === true ? true : undefined,
  };
}
