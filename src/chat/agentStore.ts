import type { Memento } from 'vscode';
import { AgentInfo, AgentStatus } from './protocol';
import type { WorktreeInfo } from './protocol';
import type { AgentBudget, AgentSpent } from './protocol';
import type { AttemptInfo, BoxInfo } from './protocol';
import type { SessionStore } from './sessionStore';

/** Chave antiga no workspaceState, com todas as conversas juntas. Só é lida para migrar para a pasta de cada conversa. */
const LEGACY_KEY = 'agentGraphMaster.routedAgents';
/** Chave dentro da pasta da conversa: `.agm/sessions/<id>/agents.json`. */
const SESSION_KEY = 'agents';

/** Relatório longo é o que mais pesa; acima disso o resto fica na sessão do próprio agente. */
const MAX_REPORT_CHARS = 60_000;
/** Junta as gravações de uma rajada de updates numa só. */
const SAVE_DELAY_MS = 1000;

const STATUSES: readonly AgentStatus[] = ['running', 'waiting', 'completed', 'failed', 'stopped'];

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
  /** Arquivos reivindicados (owns) e se o agente sobe com os MCP do usuário; ao retomar, valem de novo. */
  owns?: string[];
  userMcp?: boolean;
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

type StoredMap = Record<string, StoredConversation>;

/**
 * Guarda os agentes roteados e as caixas de cada conversa principal em `.agm/sessions/<id>/agents.json`
 * (via SessionStore). Quem tem o histórico de verdade é o próprio Claude Code, pelo sessionId de cada agente.
 *
 * Antes tudo ficava numa chave só do workspaceState, com teto de 40 agentes por conversa: passando disso,
 * `slice(-40)` jogava fora os primeiros, que sumiam do mapa na reabertura. Agora não há teto, e cada gravação
 * junta o que já está no disco (agente nunca sai do hub, então quem falta na lista de quem grava é de outro
 * painel ou de uma gravação anterior, não um agente apagado).
 */
export class AgentStore {
  private timer?: ReturnType<typeof setTimeout>;
  /** Uma entrada por conversa: trocar de chave no meio do debounce não perde a gravação da anterior. */
  private readonly pending = new Map<string, { agents: StoredAgent[]; boxes: BoxInfo[] }>();
  /** Última chave gravada desde o último flush; muda sem flush quando a conversa viva ganha id novo (fork, /clear). */
  private lastKey?: string;

  constructor(
    memento: Memento,
    private readonly sessions: SessionStore,
  ) {
    migrateLegacy(memento, sessions);
  }

  load(key: string): StoredAgent[] {
    return this.read(key).agents;
  }

  loadBoxes(key: string): BoxInfo[] {
    return this.read(key).boxes ?? [];
  }

  /** Agenda a gravação. Chamadas seguidas na mesma conversa viram uma só. */
  save(key: string, agents: AgentInfo[], boxes: BoxInfo[] = []): void {
    if (!key) {
      return;
    }
    if (this.lastKey && this.lastKey !== key) {
      // A mesma conversa, viva, ganhou id novo: o resto da pasta (threads, imagens) vai junto para o id novo.
      this.writeAll();
      try {
        this.sessions.fork(this.lastKey, key);
      } catch (err) {
        console.error('[agentGraphMaster] falha ao copiar a pasta da conversa:', err);
      }
    }
    this.lastKey = key;
    this.pending.set(key, { agents: agents.map(toStored), boxes: boxes.map((b) => ({ ...b })) });
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.writeAll();
    }, SAVE_DELAY_MS);
  }

  /** Grava agora o que estava agendado. Usado ao fechar o painel ou trocar de conversa. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.writeAll();
    // Depois de um flush o hub troca de conversa de propósito: a próxima chave não é fork desta.
    this.lastKey = undefined;
  }

  /** Esquece os agentes de uma conversa. A pasta fica com o resto (threads, imagens). */
  forget(key: string): void {
    this.pending.delete(key);
    this.sessions.remove(key, SESSION_KEY);
  }

  private read(key: string): { agents: StoredAgent[]; boxes?: BoxInfo[] } {
    if (!key) {
      return { agents: [] };
    }
    return toConversation(this.sessions.read(key, SESSION_KEY)) ?? { agents: [] };
  }

  private writeAll(): void {
    const entries = [...this.pending];
    this.pending.clear();
    for (const [key, entry] of entries) {
      // Erro dentro do timer não tem quem o pegue: sem este try, uma falha ao gravar derruba o processo.
      try {
        this.write(key, entry.agents, entry.boxes);
      } catch (err) {
        console.error('[agentGraphMaster] falha ao salvar os agentes:', err);
      }
    }
  }

  private write(key: string, agents: StoredAgent[], boxes: BoxInfo[]): void {
    const disk = this.read(key);
    const merged = mergeById(disk.agents, agents);
    const mergedBoxes = mergeById(disk.boxes ?? [], boxes);
    if (!merged.length && !mergedBoxes.length) {
      return;
    }
    this.sessions.write(key, SESSION_KEY, { savedAt: Date.now(), agents: merged, ...(mergedBoxes.length ? { boxes: mergedBoxes } : {}) });
    this.sessions.updateMeta(key, { agents: merged.length });
  }
}

/**
 * Junta o disco com a lista de quem grava: a versão de quem grava vale para os ids que ele tem; os que só o disco tem
 * ficam (outro painel na mesma conversa, ou gravação de antes de um restore incompleto). Mantém a ordem de criação.
 */
export function mergeById<T extends { id: string }>(disk: readonly T[], next: readonly T[]): T[] {
  const byId = new Map(next.map((item) => [item.id, item]));
  const out = disk.map((item) => byId.get(item.id) ?? item);
  const seen = new Set(disk.map((item) => item.id));
  for (const item of next) {
    if (!seen.has(item.id)) {
      out.push(item);
    }
  }
  return out;
}

/**
 * Leva as conversas da chave antiga do workspaceState para a pasta de cada uma e apaga a chave. Conversa que já tem
 * `agents.json` junta as duas listas. Se alguma gravação falhar, a chave antiga fica para a próxima tentativa.
 */
export function migrateLegacy(memento: Memento, sessions: SessionStore): void {
  if (memento.get<unknown>(LEGACY_KEY) === undefined) {
    return;
  }
  let failed = false;
  for (const [key, conv] of Object.entries(readMap(memento))) {
    try {
      const disk = toConversation(sessions.read(key, SESSION_KEY));
      const agents = mergeById(disk?.agents ?? [], conv.agents);
      const boxes = mergeById(disk?.boxes ?? [], conv.boxes ?? []);
      sessions.write(key, SESSION_KEY, { savedAt: conv.savedAt, agents, ...(boxes.length ? { boxes } : {}) });
      sessions.updateMeta(key, { agents: agents.length });
    } catch (err) {
      failed = true;
      console.error(`[agentGraphMaster] falha ao migrar os agentes da conversa ${key}:`, err);
    }
  }
  if (!failed) {
    void memento.update(LEGACY_KEY, undefined);
  }
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
  if (info.owns?.length) {
    stored.owns = [...info.owns];
  }
  if (info.userMcp) {
    stored.userMcp = true;
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

// ---------- Leitura defensiva: o que está no disco ou no state pode ser de uma versão antiga da extensão ----------

function readMap(memento: Memento): StoredMap {
  const raw = memento.get<unknown>(LEGACY_KEY);
  const map: StoredMap = {};
  if (!isRecord(raw)) {
    return map;
  }
  for (const [key, value] of Object.entries(raw)) {
    const conv = toConversation(value);
    if (conv && (conv.agents.length || conv.boxes?.length)) {
      map[key] = conv;
    }
  }
  return map;
}

/** Uma conversa gravada (`agents.json` ou entrada da chave antiga), com cada agente e caixa validados. */
function toConversation(value: unknown): StoredConversation | undefined {
  if (!isRecord(value) || !Array.isArray(value.agents)) {
    return undefined;
  }
  const agents = value.agents.map(toAgent).filter((a): a is StoredAgent => a !== undefined);
  const boxes = Array.isArray(value.boxes) ? value.boxes.map(toBox).filter((b): b is BoxInfo => b !== undefined) : [];
  return { savedAt: num(value.savedAt) ?? 0, agents, ...(boxes.length ? { boxes } : {}) };
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
    owns: Array.isArray(raw.owns) ? raw.owns.filter((p): p is string => typeof p === 'string' && !!p) : undefined,
    userMcp: raw.userMcp === true ? true : undefined,
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
  return { id, name, description: str(raw.description), color: str(raw.color), parent: str(raw.parent), budget: toBudget(raw.budget), createdBy: str(raw.createdBy), closed: raw.closed === true ? true : undefined, createdAt: str(raw.createdAt) ?? new Date(0).toISOString() };
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
