import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { Profile } from '../profiles';
import type { AgentRecord, TurnEndInfo } from './session';
import { codexEnv } from '../codex';
import { resolveCodexExecutable } from '../codexPath';
import { CodexRpc, unsupported } from './codexRpc';
import {
  Attachment,
  HistoryItem,
  HostMessage,
  ModelOption,
  PermissionDecision,
  SessionOption,
  SlashCommandOption,
  UsageInfo,
  UsageWindow,
} from './protocol';

/**
 * Conversa com o Codex (agente da OpenAI) com a mesma cara da ChatSession: o painel e o hub chamam os mesmos
 * métodos e recebem as mesmas mensagens de protocolo. Por baixo roda um `codex app-server` por sessão, com
 * CODEX_HOME apontando para a pasta da conta.
 *
 * Tradução dos eventos do Codex para o nosso protocolo:
 * - mensagem do agente: `item/agentMessage/delta` vira `textDelta`, e o item completo vira `assistantText`;
 * - raciocínio: início e fim do item acendem e apagam o `thinking`;
 * - comando executado vira a ferramenta "Bash" (ou "PowerShell", quando o Codex embrulha em powershell -Command);
 * - mudança de arquivo vira "Edit" (com o diff separado em antes/depois), "Write" (arquivo novo) ou "Delete";
 * - plano do turno vira "TodoWrite"; ferramenta MCP vira `mcp__servidor__ferramenta`; busca vira "WebSearch";
 * - fim do turno vira `result`, com os tokens do turno (diferença do total da thread antes e depois).
 */

export interface CodexSessionOptions {
  model?: string;
  effort?: string;
  permissionMode?: PermissionMode;
  /** Vira `developerInstructions` da thread, calculado quando a thread nasce. */
  systemAppend?: () => string | undefined;
  /** Se bloquear Bash ou Write (vigias), a sessão roda em sandbox só leitura e sem pedir aprovação. */
  disallowedTools?: string[];
  /** Ignorado: os servidores MCP embutidos do SDK do Claude vivem no processo da extensão e o Codex não os alcança. */
  mcpServers?: unknown;
  /** Variáveis somadas ao ambiente do app-server, calculadas a cada início (limite de threads quando há agentes em paralelo). */
  env?: () => Record<string, string>;
}

type ApprovalPolicy = 'untrusted' | 'on-request' | 'never';
type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/**
 * Nosso seletor de modo -> política do Codex. O Codex separa "quando perguntar" (approvalPolicy) de "o que o
 * comando pode fazer sem perguntar" (sandbox):
 * - default: sandbox só leitura, pergunta quando precisar sair dele. Ler é livre; editar e rodar algo que grava pede
 *   aprovação, como no modo padrão do Claude;
 * - acceptEdits: pode gravar dentro do diretório de trabalho sem perguntar; rede e fora da pasta pedem aprovação.
 *   É o modo "Auto" do Codex;
 * - plan: igual ao default, e cada mensagem leva a instrução de só planejar;
 * - bypassPermissions: sem sandbox e sem perguntas ("Full access" do Codex).
 */
export function codexPolicy(mode: string, readOnlyAgent = false): { approvalPolicy: ApprovalPolicy; sandbox: SandboxMode } {
  if (readOnlyAgent) {
    return { approvalPolicy: 'never', sandbox: 'read-only' };
  }
  switch (mode) {
    case 'bypassPermissions':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
    case 'acceptEdits':
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
    default:
      return { approvalPolicy: 'on-request', sandbox: 'read-only' };
  }
}

function sandboxPolicy(sandbox: SandboxMode): Record<string, unknown> {
  if (sandbox === 'danger-full-access') {
    return { type: 'dangerFullAccess' };
  }
  if (sandbox === 'workspace-write') {
    return { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  }
  return { type: 'readOnly', networkAccess: false };
}

const PLAN_NOTE =
  'Modo de planejamento: não altere arquivos nem rode comandos que gravem algo. Investigue, depois apresente um plano numerado e espere a aprovação do usuário antes de executar.';

const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

/** Último `model/list` visto em qualquer sessão Codex. O prompt do orquestrador lista esses modelos. */
let catalog: CodexModel[] = [];

export function knownCodexModels(): CodexModel[] {
  return catalog;
}

/** Modelos do Codex no formato do seletor do webview, com os níveis de raciocínio de cada um. */
export function codexModelOptions(models: CodexModel[]): ModelOption[] {
  return models.map((m) => ({
    value: m.model,
    resolvedModel: m.model,
    displayName: m.displayName,
    description: [m.description, m.isDefault ? 'padrão da conta' : ''].filter(Boolean).join(' · '),
    efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort),
  }));
}

/**
 * Enche o catálogo sem abrir chat: sobe um app-server da conta, lê `model/list` e encerra. Não gasta token.
 * A extensão chama na ativação quando há conta Codex, para o orquestrador já saber os modelos.
 */
export async function prefetchCodexModels(profile: Profile, cwd: string): Promise<void> {
  if (catalog.length) {
    return;
  }
  const exe = await resolveCodexExecutable();
  if (!exe) {
    return;
  }
  const rpc = new CodexRpc(exe, codexEnv(profile), cwd, {
    notification: () => undefined,
    request: (method) => Promise.reject(unsupported(method)),
    exit: () => undefined,
  });
  try {
    await rpc.start();
    const res = await rpc.request<{ data: CodexModel[] }>('model/list', {}, 30000);
    if (!catalog.length) {
      catalog = res.data.filter((m) => !m.hidden);
    }
  } catch {
    // Sem catálogo o prompt só manda omitir model.
  } finally {
    rpc.dispose();
  }
}

/** Limites do plano de uma conta Codex sem chat aberto: sobe o app-server, lê e fecha. */
export async function probeCodexUsage(profile: Profile, cwd: string): Promise<UsageInfo> {
  const fetchedAt = new Date().toISOString();
  const exe = await resolveCodexExecutable();
  if (!exe) {
    return { available: false, windows: [], fetchedAt, error: 'não achei o executável do Codex' };
  }
  const rpc = new CodexRpc(exe, codexEnv(profile), cwd, {
    notification: () => undefined,
    request: (method) => Promise.reject(unsupported(method)),
    exit: () => undefined,
  });
  try {
    await rpc.start();
    const data = await rpc.request<{ rateLimits: RateSnapshot; rateLimitsByLimitId: Record<string, RateSnapshot> | null }>('account/rateLimits/read', undefined, 20000);
    const snapshots = data.rateLimitsByLimitId ? Object.values(data.rateLimitsByLimitId) : [data.rateLimits];
    const windows = snapshots.flatMap((s) => rateWindows(s, snapshots.length > 1));
    return {
      available: windows.length > 0,
      subscription: data.rateLimits.planType ?? undefined,
      windows,
      fetchedAt,
      error: windows.length ? undefined : 'o Codex não informou limites para esta conta',
    };
  } catch (err) {
    return { available: false, windows: [], fetchedAt, error: errorText(err) };
  } finally {
    rpc.dispose();
  }
}

/** Comandos de barra que a sessão resolve sozinha; o app-server do Codex não tem comandos de barra. */
const LOCAL_COMMANDS: SlashCommandOption[] = [
  { name: 'compact', description: 'Resume a conversa para liberar contexto' },
  { name: 'clear', description: 'Começa uma conversa nova (a atual fica no histórico)' },
];

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
}

interface RateWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

interface RateSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: RateWindow | null;
  secondary: RateWindow | null;
  planType: string | null;
}

type Item = { type: string; id: string; [key: string]: any };

interface PendingApproval {
  /** Id do pedido no JSON-RPC, para fechar o cartão quando o próprio Codex resolver o pedido. */
  rpcId: number | string;
  /** Resposta enviada ao Codex quando a sessão fecha ou o turno é interrompido. */
  cancel: () => void;
  resolve: (answer: PermissionDecision) => void;
}

export class CodexSession {
  readonly provider = 'codex' as const;
  sessionId?: string;
  permissionMode: PermissionMode = 'default';
  model: string;
  effort: string;
  /** A ferramenta Agent do Claude não existe no Codex; o mapa fica vazio, mas o painel e o hub o consultam. */
  readonly agents = new Map<string, AgentRecord>();
  lastTurnText = '';
  onTurnEnd?: (info: TurnEndInfo) => void;
  onBusyChange?: (busy: boolean) => void;
  /** Consumo para o orçamento: tokens novos desde o último evento de uso. O Codex não informa custo. */
  onUsage?: (u: { tokens?: number }) => void;
  /** Conta logada, lida no `account/read`. Serve ao cabeçalho do chat e para saber se há limite de plano. */
  account?: { type: string; email?: string; planType?: string };

  private rpc?: CodexRpc;
  private launching?: Promise<CodexRpc | undefined>;
  /** Sobe a cada stop(): respostas de um processo antigo não mexem no estado do novo. */
  private generation = 0;
  private threadId?: string;
  private threadReady?: Promise<string>;
  /** Thread a retomar quando o processo subir (start com id, ou processo que morreu no meio da conversa). */
  private resumeId?: string;
  private turnId?: string;
  private busy = false;
  private disposed = false;
  private queue: { text: string; attachments?: Attachment[] }[] = [];
  private turnTexts: string[] = [];
  private turnStartedAt = 0;
  private totals = { input: 0, output: 0 };
  private totalsAtTurnStart = { input: 0, output: 0 };
  private contextTokens = 0;
  private items = new Map<string, Item>();
  private openReasoning = new Set<string>();
  private pending = new Map<string, PendingApproval>();
  private models: CodexModel[] = [];
  /** Modelo que a thread está usando de fato (o `model` pode ficar vazio = padrão da conta). */
  private activeModel = '';
  private effortWarned = new Set<string>();

  constructor(
    readonly profile: Profile,
    readonly cwd: string,
    private readonly post: (msg: HostMessage) => void,
    private readonly options: CodexSessionOptions = {},
  ) {
    const config = vscode.workspace.getConfiguration('agentGraphMaster');
    const mode = options.permissionMode ?? config.get<string>('defaultPermissionMode', 'bypassPermissions').trim();
    this.permissionMode = (PERMISSION_MODES.includes(mode) ? mode : 'bypassPermissions') as PermissionMode;
    // Os padrões de modelo e raciocínio da extensão são nomes do Claude; no Codex vale o config.toml da conta.
    this.model = options.model ?? config.get<string>('codexDefaultModel', '').trim();
    this.effort = options.effort ?? config.get<string>('codexDefaultEffort', '').trim();
  }

  get isBusy(): boolean {
    return this.busy;
  }

  /** Sobe o app-server (sem gastar token). Com resumeId, reabre a thread salva. */
  start(resumeId?: string): void {
    this.stop();
    this.sessionId = resumeId;
    this.resumeId = resumeId;
    void this.ensureRpc().then((rpc) => {
      if (rpc && resumeId) {
        void this.ensureThread(rpc).catch(() => undefined);
      }
    });
  }

  send(text: string, attachments?: Attachment[]): void {
    if (this.disposed) {
      return;
    }
    const cmd = /^\/([\w:-]+)\s*$/.exec(text.trim())?.[1];
    if (cmd === 'compact') {
      void this.compact();
      return;
    }
    if (cmd === 'clear' || cmd === 'new') {
      this.post({ type: 'clear' });
      this.start();
      this.post({ type: 'notice', level: 'info', text: 'Conversa nova. A anterior continua no histórico do Codex.' });
      return;
    }
    if (this.busy) {
      // O Claude enfileira mensagens mandadas no meio do turno; aqui também, e elas saem uma por turno.
      this.queue.push({ text, attachments });
      return;
    }
    this.setBusy(true);
    void this.runTurn(text, attachments);
  }

  async interrupt(): Promise<void> {
    this.queue = [];
    this.cancelAllPending();
    const rpc = this.rpc;
    if (!rpc || !this.threadId || !this.turnId) {
      return;
    }
    try {
      await rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, 15000);
    } catch (err) {
      this.post({ type: 'notice', level: 'error', text: `Falha ao interromper: ${errorText(err)}` });
    }
  }

  /** O Codex aceita política nova a cada turno; a troca vale a partir da próxima mensagem. */
  async setMode(mode: PermissionMode): Promise<void> {
    this.permissionMode = mode;
    if (this.busy) {
      this.post({ type: 'notice', level: 'info', text: 'O novo modo vale a partir da próxima mensagem.' });
    }
    this.postSession();
  }

  async setModel(model: string): Promise<void> {
    this.model = model;
    if (model) {
      this.activeModel = model;
    }
    if (this.busy) {
      this.post({ type: 'notice', level: 'info', text: 'O novo modelo vale a partir da próxima mensagem.' });
    }
    this.postSession();
  }

  setEffort(effort: string): void {
    this.effort = effort;
    if (this.busy) {
      this.post({ type: 'notice', level: 'info', text: 'O novo nível de raciocínio vale a partir da próxima mensagem.' });
    }
  }

  /** Limites do plano do ChatGPT (janela de 5 horas, semana, mês, conforme o plano). */
  async readUsage(): Promise<UsageInfo> {
    const fetchedAt = new Date().toISOString();
    const rpc = this.rpc;
    if (!rpc?.alive) {
      return { available: false, windows: [], fetchedAt, error: 'sessão ainda não iniciada' };
    }
    if (this.account?.type === 'apiKey') {
      return { available: false, subscription: 'chave de API', windows: [], fetchedAt, error: 'esta conta usa chave de API, sem limites de plano' };
    }
    try {
      const data = await rpc.request<{ rateLimits: RateSnapshot; rateLimitsByLimitId: Record<string, RateSnapshot> | null }>(
        'account/rateLimits/read',
        undefined,
        20000,
      );
      const snapshots = data.rateLimitsByLimitId ? Object.values(data.rateLimitsByLimitId) : [data.rateLimits];
      const windows = snapshots.flatMap((s) => rateWindows(s, snapshots.length > 1));
      return {
        available: windows.length > 0,
        subscription: data.rateLimits.planType ?? this.account?.planType,
        windows,
        fetchedAt,
        error: windows.length ? undefined : 'o Codex não informou limites para esta conta',
      };
    } catch (err) {
      return { available: false, windows: [], fetchedAt, error: errorText(err) };
    }
  }

  /** Subagentes do Claude não existem aqui. */
  async stopAgent(_id: string): Promise<void> {}

  postCommands(): void {
    this.post({ type: 'commands', list: LOCAL_COMMANDS });
  }

  respondPermission(requestId: string, answer: PermissionDecision): void {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }
    this.pending.delete(requestId);
    this.post({ type: 'permissionClosed', requestId });
    pending.resolve(answer);
  }

  /** Conversas salvas desta conta no diretório de trabalho, para o dropdown de histórico. */
  async listSessions(limit = 40): Promise<SessionOption[]> {
    const rpc = await this.ensureRpc();
    if (!rpc) {
      throw new Error('o Codex não está rodando');
    }
    const res = await rpc.request<{ data: { id: string; name: string | null; preview: string; updatedAt: number }[] }>(
      'thread/list',
      { limit, cwd: this.cwd, sortKey: 'updated_at', archived: false },
      20000,
    );
    return res.data.map((t) => ({
      id: t.id,
      title: shorten(t.name || t.preview || t.id, 80),
      lastModified: t.updatedAt * 1000,
      current: t.id === this.sessionId,
    }));
  }

  /** Mensagens de uma thread salva, no formato do histórico do webview. */
  async loadHistory(threadId: string): Promise<HistoryItem[]> {
    const rpc = await this.ensureRpc();
    if (!rpc) {
      throw new Error('o Codex não está rodando');
    }
    const res = await rpc.request<{ thread: { turns: { items: Item[] }[] } }>('thread/read', { threadId, includeTurns: true }, 30000);
    const out: HistoryItem[] = [];
    for (const turn of res.thread.turns ?? []) {
      for (const item of turn.items ?? []) {
        out.push(...historyOf(item));
      }
    }
    return out;
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  // ---------- Processo e thread ----------

  private stop(): void {
    this.generation++;
    this.cancelAllPending();
    this.rpc?.dispose();
    this.rpc = undefined;
    this.launching = undefined;
    this.threadId = undefined;
    this.threadReady = undefined;
    this.turnId = undefined;
    this.queue = [];
    this.items.clear();
    this.openReasoning.clear();
    this.setBusy(false);
  }

  private ensureRpc(): Promise<CodexRpc | undefined> {
    if (this.rpc?.alive) {
      return Promise.resolve(this.rpc);
    }
    this.launching ??= this.launch();
    return this.launching;
  }

  private async launch(): Promise<CodexRpc | undefined> {
    const gen = this.generation;
    const exe = await resolveCodexExecutable();
    if (gen !== this.generation || this.disposed) {
      return undefined;
    }
    if (!exe) {
      this.launching = undefined;
      this.post({
        type: 'notice',
        level: 'error',
        text: 'Não achei o Codex CLI. Instale com `npm i -g @openai/codex` ou informe o caminho em agentGraphMaster.codexPath.',
      });
      return undefined;
    }
    const rpc: CodexRpc = new CodexRpc(exe, { ...codexEnv(this.profile), ...(this.options.env?.() ?? {}) }, this.cwd, {
      notification: (method, params) => {
        if (gen === this.generation) {
          this.onNotification(method, params);
        }
      },
      request: (method, params, id) => (gen === this.generation ? this.onServerRequest(method, params, id) : Promise.reject(unsupported(method))),
      exit: (info) => this.onExit(rpc, info),
    });
    try {
      await rpc.start();
    } catch (err) {
      rpc.dispose();
      if (gen === this.generation) {
        this.launching = undefined;
        this.post({ type: 'notice', level: 'error', text: `O Codex não subiu: ${errorText(err)}` });
      }
      return undefined;
    }
    if (gen !== this.generation || this.disposed) {
      rpc.dispose();
      return undefined;
    }
    this.rpc = rpc;
    this.launching = undefined;
    void this.loadAccount(rpc);
    void this.loadModels(rpc);
    this.postCommands();
    return rpc;
  }

  /** Cria a thread na primeira mensagem (ou retoma a salva). Não gasta token: só abre o arquivo da conversa. */
  private ensureThread(rpc: CodexRpc): Promise<string> {
    if (this.threadId) {
      return Promise.resolve(this.threadId);
    }
    if (!this.threadReady) {
      const gen = this.generation;
      const ready = this.openThread(rpc).then((id) => {
        if (gen === this.generation) {
          this.threadId = id;
        }
        return id;
      });
      ready.catch(() => {
        if (this.threadReady === ready) {
          this.threadReady = undefined;
        }
      });
      this.threadReady = ready;
    }
    return this.threadReady;
  }

  private async openThread(rpc: CodexRpc): Promise<string> {
    const policy = codexPolicy(this.permissionMode, this.readOnlyAgent());
    const params: Record<string, unknown> = {
      cwd: this.cwd,
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
    };
    if (this.model) {
      params.model = this.model;
    }
    const instructions = this.options.systemAppend?.();
    if (instructions) {
      params.developerInstructions = instructions;
    }
    type Opened = { thread: { id: string }; model: string; reasoningEffort: string | null };
    let res: Opened;
    const resumeId = this.resumeId;
    if (resumeId) {
      try {
        res = await rpc.request<Opened>('thread/resume', { threadId: resumeId, ...params }, 60000);
      } catch (err) {
        this.resumeId = undefined;
        this.post({ type: 'notice', level: 'error', text: `Não consegui retomar a conversa do Codex (${errorText(err)}). A próxima mensagem começa uma conversa nova.` });
        throw err;
      }
    } else {
      res = await rpc.request<Opened>('thread/start', params, 60000);
    }
    this.resumeId = undefined;
    this.sessionId = res.thread.id;
    this.activeModel = res.model;
    this.postSession();
    return res.thread.id;
  }

  private onExit(rpc: CodexRpc, info: { code: number | null; expected: boolean; stderr: string }): void {
    if (rpc !== this.rpc) {
      return;
    }
    this.rpc = undefined;
    // A thread continua salva em disco: a próxima mensagem sobe outro processo e retoma de onde parou.
    this.resumeId = this.threadId ?? this.resumeId;
    this.threadId = undefined;
    this.threadReady = undefined;
    this.turnId = undefined;
    this.cancelAllPending();
    if (!info.expected && !this.disposed) {
      const last = info.stderr.trim().split('\n').pop()?.trim();
      this.post({
        type: 'notice',
        level: 'error',
        text: `O processo do Codex parou${info.code !== null ? ` (código ${info.code})` : ''}${last ? `: ${stripAnsi(last)}` : ''}`,
      });
    }
    this.openReasoning.clear();
    this.post({ type: 'thinking', value: false });
    this.queue = [];
    this.setBusy(false);
  }

  private async loadAccount(rpc: CodexRpc): Promise<void> {
    try {
      const res = await rpc.request<{ account: { type: string; email?: string | null; planType?: string } | null; requiresOpenaiAuth: boolean }>(
        'account/read',
        { refreshToken: false },
        20000,
      );
      if (!res.account && res.requiresOpenaiAuth) {
        this.post({
          type: 'notice',
          level: 'error',
          text: `A conta "${this.profile.name}" não tem login no Codex. Use "Fazer login nesta conta" na lista de contas.`,
        });
        return;
      }
      if (res.account) {
        this.account = { type: res.account.type, email: res.account.email ?? undefined, planType: res.account.planType };
      }
    } catch {
      // Sem a conta o chat funciona; só o rodapé de limites fica sem plano.
    }
  }

  private async loadModels(rpc: CodexRpc): Promise<void> {
    try {
      const res = await rpc.request<{ data: CodexModel[] }>('model/list', {}, 30000);
      this.models = res.data;
      catalog = res.data.filter((m) => !m.hidden);
      if (!this.activeModel) {
        this.activeModel = this.model || res.data.find((m) => m.isDefault)?.model || '';
      }
      this.post({ type: 'models', list: codexModelOptions(res.data.filter((m) => !m.hidden || m.model === this.model)) });
    } catch {
      // Lista vazia: o seletor mostra só "Modelo padrão".
    }
  }

  // ---------- Turno ----------

  private async runTurn(text: string, attachments?: Attachment[]): Promise<void> {
    const gen = this.generation;
    this.turnTexts = [];
    this.items.clear();
    const rpc = await this.ensureRpc();
    if (!rpc || gen !== this.generation) {
      this.setBusy(false);
      return;
    }
    let threadId: string;
    try {
      threadId = await this.ensureThread(rpc);
    } catch (err) {
      if (gen === this.generation) {
        this.post({ type: 'notice', level: 'error', text: `O Codex não abriu a conversa: ${errorText(err)}` });
        this.setBusy(false);
      }
      return;
    }
    const policy = codexPolicy(this.permissionMode, this.readOnlyAgent());
    const params: Record<string, unknown> = {
      threadId,
      input: buildInput(text, attachments, this.permissionMode === 'plan'),
      approvalPolicy: policy.approvalPolicy,
      sandboxPolicy: sandboxPolicy(policy.sandbox),
    };
    if (this.model) {
      params.model = this.model;
    }
    const effort = this.effectiveEffort();
    if (effort) {
      params.effort = effort;
    }
    this.turnStartedAt = Date.now();
    this.totalsAtTurnStart = { ...this.totals };
    try {
      const res = await rpc.request<{ turn: { id: string } }>('turn/start', params, 60000);
      if (gen === this.generation) {
        this.turnId ??= res.turn.id;
      }
    } catch (err) {
      if (gen !== this.generation) {
        return;
      }
      this.post({ type: 'notice', level: 'error', text: `O Codex recusou a mensagem: ${errorText(err)}` });
      this.endTurn({ status: 'failed', error: { message: errorText(err) }, durationMs: Date.now() - this.turnStartedAt });
    }
  }

  /** Raciocínio pedido, ajustado ao que o modelo aceita (nem todo modelo tem "max"). */
  private effectiveEffort(): string | undefined {
    if (!this.effort) {
      return undefined;
    }
    const model = this.models.find((m) => m.model === (this.model || this.activeModel));
    const supported = model?.supportedReasoningEfforts.map((e) => e.reasoningEffort);
    if (!supported?.length || supported.includes(this.effort)) {
      return this.effort;
    }
    const order = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    const wanted = order.indexOf(this.effort);
    const below = supported.filter((e) => order.indexOf(e) <= wanted).sort((a, b) => order.indexOf(b) - order.indexOf(a))[0];
    const chosen = below ?? supported[0];
    const key = `${model?.model}:${this.effort}`;
    if (!this.effortWarned.has(key)) {
      this.effortWarned.add(key);
      this.post({ type: 'notice', level: 'info', text: `${model?.displayName ?? 'Este modelo'} não tem o raciocínio "${this.effort}"; usando "${chosen}".` });
    }
    return chosen;
  }

  private endTurn(turn: { status: string; error?: { message: string } | null; durationMs?: number | null }): void {
    this.turnId = undefined;
    if (this.openReasoning.size) {
      this.openReasoning.clear();
      this.post({ type: 'thinking', value: false });
    }
    const isError = turn.status === 'failed';
    const durationMs = turn.durationMs ?? Date.now() - this.turnStartedAt;
    this.post({
      type: 'result',
      isError,
      text: turn.status === 'completed' ? '' : turn.status === 'interrupted' ? 'interrompido' : (turn.error?.message ?? turn.status),
      durationMs,
      inputTokens: Math.max(0, this.totals.input - this.totalsAtTurnStart.input),
      outputTokens: Math.max(0, this.totals.output - this.totalsAtTurnStart.output),
    });
    this.lastTurnText = this.turnTexts.join('\n\n');
    this.onTurnEnd?.({ contextTokens: this.contextTokens, isError, queued: this.queue.length, durationMs });
    const next = this.queue.shift();
    if (next && !this.disposed) {
      void this.runTurn(next.text, next.attachments);
    } else {
      this.setBusy(false);
    }
  }

  private async compact(): Promise<void> {
    const rpc = await this.ensureRpc();
    if (!rpc || !this.threadId) {
      this.post({ type: 'notice', level: 'info', text: 'Nada para compactar ainda.' });
      return;
    }
    try {
      await rpc.request('thread/compact/start', { threadId: this.threadId }, 30000);
      this.post({ type: 'notice', level: 'info', text: 'Compactando a conversa...' });
    } catch (err) {
      this.post({ type: 'notice', level: 'error', text: `Não consegui compactar: ${errorText(err)}` });
    }
  }

  // ---------- Eventos do Codex ----------

  private onNotification(method: string, p: any): void {
    if (p && typeof p.threadId === 'string' && this.threadId && p.threadId !== this.threadId) {
      return;
    }
    switch (method) {
      case 'turn/started':
        this.turnId = p.turn.id;
        return;
      case 'turn/completed':
        if (this.busy) {
          this.endTurn(p.turn);
        }
        return;
      case 'item/started':
        this.onItemStarted(p.item);
        return;
      case 'item/completed':
        this.onItemCompleted(p.item);
        return;
      case 'item/agentMessage/delta':
        this.post({ type: 'textDelta', msgId: p.itemId, index: 0, text: p.delta });
        return;
      case 'turn/plan/updated':
        this.post({ type: 'toolUse', id: `plan-${p.turnId}`, name: 'TodoWrite', input: { todos: planTodos(p.plan) } });
        return;
      case 'thread/tokenUsage/updated': {
        const usage = p.tokenUsage;
        const before = this.totals.input + this.totals.output;
        this.totals = { input: usage.total.inputTokens, output: usage.total.outputTokens };
        const after = this.totals.input + this.totals.output;
        // Total menor que o anterior: thread nova ou processo novo; tudo o que veio é gasto novo.
        this.onUsage?.({ tokens: after >= before ? after - before : after });
        const context = usage.last.inputTokens + usage.last.outputTokens;
        if (context && context !== this.contextTokens) {
          this.contextTokens = context;
          this.post({ type: 'contextTokens', value: context });
        }
        return;
      }
      case 'error':
        this.post({
          type: 'notice',
          level: p.willRetry ? 'info' : 'error',
          text: p.willRetry ? `A API falhou, tentando de novo... (${p.error.message})` : `Erro do Codex: ${p.error.message}`,
        });
        return;
      case 'model/rerouted':
        this.activeModel = p.toModel;
        this.post({ type: 'notice', level: 'info', text: `O Codex trocou o modelo de ${p.fromModel} para ${p.toModel}.` });
        this.postSession();
        return;
      case 'thread/compacted':
        this.post({ type: 'notice', level: 'info', text: 'Conversa compactada para liberar contexto.' });
        return;
      case 'warning':
      case 'guardianWarning':
        this.post({ type: 'notice', level: 'info', text: String(p.message) });
        return;
      case 'configWarning':
      case 'deprecationNotice':
        this.post({ type: 'notice', level: 'info', text: [p.summary, p.details].filter(Boolean).join(': ') });
        return;
      case 'serverRequest/resolved':
        // O próprio Codex encerrou um pedido de aprovação (turno interrompido, por exemplo).
        for (const [id, pending] of this.pending) {
          if (pending.rpcId === p.requestId) {
            this.pending.delete(id);
            this.post({ type: 'permissionClosed', requestId: id });
            pending.cancel();
          }
        }
        return;
    }
  }

  private onItemStarted(item: Item): void {
    this.items.set(item.id, item);
    switch (item.type) {
      case 'reasoning':
        this.openReasoning.add(item.id);
        this.post({ type: 'thinking', value: true });
        return;
      case 'agentMessage':
      case 'userMessage':
      case 'hookPrompt':
      case 'plan':
        return;
      case 'contextCompaction':
        return;
    }
    for (const call of toolCalls(item)) {
      this.post({ type: 'toolUse', id: call.id, name: call.name, input: call.input });
    }
  }

  private onItemCompleted(item: Item): void {
    this.items.set(item.id, item);
    switch (item.type) {
      case 'agentMessage':
        if (item.text) {
          this.turnTexts.push(item.text);
        }
        this.post({ type: 'assistantText', msgId: item.id, text: item.text ?? '' });
        return;
      case 'reasoning':
        this.openReasoning.delete(item.id);
        if (!this.openReasoning.size) {
          this.post({ type: 'thinking', value: false });
        }
        return;
      case 'userMessage':
      case 'hookPrompt':
      case 'plan':
      case 'contextCompaction':
        return;
    }
    // A chamada pode ter começado e terminado sem item/started (ex.: busca rápida); o toolUse repetido só atualiza.
    for (const call of toolCalls(item)) {
      this.post({ type: 'toolUse', id: call.id, name: call.name, input: call.input });
    }
    for (const res of toolResults(item)) {
      this.post({ type: 'toolResult', id: res.id, text: res.text, isError: res.isError });
    }
  }

  // ---------- Pedidos do Codex (aprovações e perguntas) ----------

  private async onServerRequest(method: string, p: any, rpcId: number | string): Promise<unknown> {
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const item = this.items.get(p.itemId);
        const raw = p.command ?? item?.command ?? '';
        const { name, command } = unwrapCommand(raw);
        const answer = await this.ask(name, { command, description: p.reason ?? undefined }, true, p.reason ?? undefined, rpcId);
        return { decision: approvalDecision(answer) };
      }
      case 'item/fileChange/requestApproval': {
        const item = this.items.get(p.itemId);
        const calls = item ? toolCalls(item) : [];
        const { name, input } =
          calls.length === 1
            ? calls[0]
            : calls.length > 1
              ? { name: 'MultiEdit', input: { file_path: `${calls.length} arquivos`, edits: calls.map((c) => c.input) } }
              : { name: 'Edit', input: { file_path: p.grantRoot ?? 'arquivos' } };
        const reason = p.reason ?? (p.grantRoot ? `Pede permissão de escrita em ${p.grantRoot}` : undefined);
        const answer = await this.ask(name, input, true, reason, rpcId);
        return { decision: approvalDecision(answer) };
      }
      case 'item/permissions/requestApproval': {
        const answer = await this.ask('Permissões', { reason: p.reason, ...p.permissions }, true, p.reason ?? undefined, rpcId);
        if (answer.decision === 'deny') {
          return { permissions: {}, scope: 'turn' };
        }
        const granted = Object.fromEntries(Object.entries(p.permissions ?? {}).filter(([, v]) => v != null));
        return { permissions: granted, scope: answer.decision === 'always' ? 'session' : 'turn' };
      }
      case 'item/tool/requestUserInput': {
        const questions: any[] = p.questions ?? [];
        const answer = await this.ask(
          'AskUserQuestion',
          {
            questions: questions.map((q) => ({
              question: q.question,
              header: q.header,
              multiSelect: false,
              options: (q.options ?? []).map((o: any) => ({ label: o.label, description: o.description })),
            })),
          },
          false,
          undefined,
          rpcId,
        );
        if (answer.decision !== 'answer') {
          return { answers: {} };
        }
        const given = (answer.updatedInput.answers ?? {}) as Record<string, string>;
        return {
          answers: Object.fromEntries(questions.map((q) => [q.id, { answers: given[q.question] ? [given[q.question]] : [] }])),
        };
      }
      case 'execCommandApproval':
      case 'applyPatchApproval': {
        // API antiga (v1); não deveria chegar com thread/start, mas se chegar a resposta tem outro formato.
        const isExec = method === 'execCommandApproval';
        const command = Array.isArray(p.command) ? p.command.join(' ') : String(p.command ?? '');
        const answer = await this.ask(isExec ? 'Bash' : 'Edit', isExec ? { command } : { file_path: Object.keys(p.fileChanges ?? {}).join(', ') }, true, p.reason ?? undefined, rpcId);
        return { decision: reviewDecision(answer) };
      }
      case 'mcpServer/elicitation/request':
        return { action: 'decline', content: null, _meta: null };
      default:
        throw unsupported(method);
    }
  }

  /**
   * Mostra o cartão de permissão e espera a resposta do usuário. Recusa sem explicação encerra o turno, como no
   * Claude; recusa com explicação só recusa esta ação e manda a explicação para o Codex continuar.
   */
  private ask(
    toolName: string,
    input: Record<string, unknown>,
    canAlways: boolean,
    reason: string | undefined,
    rpcId: number | string,
  ): Promise<PermissionDecision> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      this.pending.set(requestId, {
        rpcId,
        resolve: (answer) => {
          resolve(answer);
          if (answer.decision === 'deny' && answer.feedback?.trim()) {
            void this.steer(`O usuário recusou a ação e explicou: ${answer.feedback.trim()}`);
          }
        },
        cancel: () => resolve({ decision: 'deny' }),
      });
      this.post({ type: 'permission', requestId, toolName, input, canAlways, reason });
    });
  }

  /** Acrescenta texto ao turno em andamento, sem esperar ele acabar. */
  private async steer(text: string): Promise<void> {
    if (!this.rpc || !this.threadId || !this.turnId) {
      return;
    }
    try {
      await this.rpc.request('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId, input: [textInput(text)] }, 15000);
    } catch {
      // Turno já acabou: a explicação vai como mensagem normal.
      this.send(text);
    }
  }

  private cancelAllPending(): void {
    for (const [id, pending] of this.pending) {
      this.post({ type: 'permissionClosed', requestId: id });
      pending.cancel();
    }
    this.pending.clear();
  }

  // ---------- Utilitários ----------

  private readOnlyAgent(): boolean {
    const blocked = this.options.disallowedTools ?? [];
    return blocked.includes('Bash') || blocked.includes('Write');
  }

  private postSession(): void {
    this.post({
      type: 'session',
      sessionId: this.sessionId ?? '',
      model: this.model || this.activeModel,
      permissionMode: this.permissionMode,
    });
  }

  private setBusy(value: boolean): void {
    if (this.busy !== value) {
      this.busy = value;
      this.post({ type: 'busy', value });
      this.onBusyChange?.(value);
    }
  }
}

// ---------- Tradução de itens ----------

function textInput(text: string): Record<string, unknown> {
  return { type: 'text', text, text_elements: [] };
}

/** Imagens vão como data URL; menções de arquivo e textos anexados vão no corpo, como no chat do Claude. */
function buildInput(text: string, attachments: Attachment[] | undefined, planMode: boolean): Record<string, unknown>[] {
  const input: Record<string, unknown>[] = [];
  if (planMode) {
    input.push(textInput(PLAN_NOTE));
  }
  const mentions: string[] = [];
  const extras: string[] = [];
  for (const att of attachments ?? []) {
    if (att.error) {
      extras.push(`[O anexo "${att.name}" não veio junto: ${att.error}]`);
    } else if (att.kind === 'image' && att.dataUrl) {
      input.push({ type: 'image', url: att.dataUrl });
    } else if (att.kind === 'path' && att.path) {
      mentions.push(att.path);
    } else if (att.text !== undefined) {
      extras.push(`<arquivo nome="${att.name}">\n${att.text}\n</arquivo>`);
    }
  }
  const mentionText = mentions.length ? `Arquivos mencionados (leia se precisar): ${mentions.join(', ')}` : '';
  const body = [text.trim(), mentionText, ...extras].filter(Boolean).join('\n\n');
  if (body || !input.length) {
    input.push(textInput(body || text));
  }
  return input;
}

interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Item do Codex -> chamadas de ferramenta no formato do Claude. Uma mudança de arquivo com N arquivos vira N chamadas. */
export function toolCalls(item: Item): ToolCall[] {
  switch (item.type) {
    case 'commandExecution': {
      const { name, command } = unwrapCommand(item.command ?? '');
      return [{ id: item.id, name, input: { command } }];
    }
    case 'fileChange': {
      const changes: { path: string; kind: { type: string; move_path?: string | null }; diff: string }[] = item.changes ?? [];
      return changes.map((c, i) => ({ id: changeId(item.id, i, changes.length), ...fileChangeTool(c) }));
    }
    case 'mcpToolCall':
      return [{ id: item.id, name: `mcp__${item.server}__${item.tool}`, input: asRecord(item.arguments) }];
    case 'dynamicToolCall':
      return [{ id: item.id, name: String(item.tool), input: asRecord(item.arguments) }];
    case 'webSearch':
      return [{ id: item.id, name: 'WebSearch', input: { query: item.query ?? '' } }];
    case 'imageView':
      return [{ id: item.id, name: 'Read', input: { file_path: item.path ?? '' } }];
    case 'collabAgentToolCall':
      return [{ id: item.id, name: 'Agent', input: { description: String(item.tool), prompt: item.prompt ?? '' } }];
    case 'imageGeneration':
    case 'sleep':
    case 'subAgentActivity':
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      return [{ id: item.id, name: item.type, input: {} }];
    default:
      return [];
  }
}

function toolResults(item: Item): { id: string; text: string; isError: boolean }[] {
  switch (item.type) {
    case 'commandExecution': {
      if (item.status === 'inProgress') {
        return [];
      }
      const declined = item.status === 'declined';
      const exit = typeof item.exitCode === 'number' ? item.exitCode : undefined;
      const output = String(item.aggregatedOutput ?? '').trimEnd();
      const text = declined ? 'Recusado.' : [output, exit !== undefined && exit !== 0 ? `(código de saída ${exit})` : ''].filter(Boolean).join('\n');
      return [{ id: item.id, text, isError: declined || item.status === 'failed' || (exit !== undefined && exit !== 0) }];
    }
    case 'fileChange': {
      if (item.status === 'inProgress') {
        return [];
      }
      const n = (item.changes ?? []).length;
      const ok = item.status === 'completed';
      const text = ok ? 'Aplicado.' : item.status === 'declined' ? 'Recusado.' : 'Falhou ao aplicar.';
      return Array.from({ length: n }, (_, i) => ({ id: changeId(item.id, i, n), text, isError: !ok }));
    }
    case 'mcpToolCall': {
      if (item.status === 'inProgress') {
        return [];
      }
      const text = item.error?.message ?? contentText(item.result?.content);
      return [{ id: item.id, text, isError: item.status === 'failed' || !!item.error }];
    }
    case 'dynamicToolCall': {
      if (item.status === 'inProgress') {
        return [];
      }
      const text = (item.contentItems ?? []).map((c: any) => (c.type === 'inputText' ? c.text : '[imagem]')).join('\n');
      return [{ id: item.id, text, isError: item.success === false }];
    }
    case 'webSearch':
      return [{ id: item.id, text: 'Busca feita.', isError: false }];
    default:
      return toolCalls(item).map((c) => ({ id: c.id, text: '', isError: false }));
  }
}

function historyOf(item: Item): HistoryItem[] {
  switch (item.type) {
    case 'userMessage': {
      const text = (item.content ?? [])
        .filter((c: any) => c.type === 'text' && c.text !== PLAN_NOTE)
        .map((c: any) => c.text)
        .join('\n');
      return text ? [{ kind: 'user', text }] : [];
    }
    case 'agentMessage':
      // O id do item é o mesmo do assistantText ao vivo: a thread da fala volta ao reabrir.
      return item.text ? [{ kind: 'text', text: item.text, id: item.id }] : [];
    case 'reasoning':
    case 'plan':
    case 'hookPrompt':
    case 'contextCompaction':
      return [];
  }
  const calls: HistoryItem[] = toolCalls(item).map((c) => ({ kind: 'tool', id: c.id, name: c.name, input: c.input }));
  const results: HistoryItem[] = toolResults(item).map((r) => ({ kind: 'toolResult', id: r.id, text: r.text, isError: r.isError }));
  return [...calls, ...results];
}

function changeId(itemId: string, index: number, total: number): string {
  return total === 1 ? itemId : `${itemId}#${index}`;
}

function fileChangeTool(change: { path: string; kind: { type: string; move_path?: string | null }; diff: string }): { name: string; input: Record<string, unknown> } {
  const diff = change.diff ?? '';
  if (change.kind.type === 'add') {
    return { name: 'Write', input: { file_path: change.path, content: looksLikeDiff(diff) ? splitDiff(diff).after : diff } };
  }
  if (change.kind.type === 'delete') {
    return { name: 'Delete', input: { file_path: change.path } };
  }
  const { before, after } = splitDiff(diff);
  const target = change.kind.move_path ? `${change.path} → ${change.kind.move_path}` : change.path;
  return { name: 'Edit', input: { file_path: target, old_string: before, new_string: after } };
}

function looksLikeDiff(text: string): boolean {
  return /^(@@|--- |\+\+\+ |diff )/m.test(text);
}

/** Diff unificado -> texto de antes e de depois (contexto nos dois), que é o que o cartão "Edit" desenha. */
export function splitDiff(diff: string): { before: string; after: string } {
  const before: string[] = [];
  const after: string[] = [];
  let hunks = 0;
  for (const line of diff.split('\n')) {
    if (/^(--- |\+\+\+ |diff |index )/.test(line)) {
      continue;
    }
    if (line.startsWith('@@')) {
      if (hunks++ > 0) {
        before.push('…');
        after.push('…');
      }
      continue;
    }
    if (line.startsWith('\\')) {
      continue;
    }
    const mark = line[0];
    const body = line.slice(1);
    if (mark === '-') {
      before.push(body);
    } else if (mark === '+') {
      after.push(body);
    } else {
      before.push(mark === ' ' ? body : line);
      after.push(mark === ' ' ? body : line);
    }
  }
  while (before.length && before[before.length - 1] === '' && after[after.length - 1] === '') {
    before.pop();
    after.pop();
  }
  return { before: before.join('\n'), after: after.join('\n') };
}

/**
 * No Windows o Codex embrulha cada comando em `powershell.exe -Command '...'`; em outros sistemas, em `bash -lc '...'`.
 * O cartão mostra o comando de dentro, com o nome do shell certo.
 */
export function unwrapCommand(raw: string): { name: string; command: string } {
  const ps = /^\s*"?[^"]*?(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-\w+\s+)*?-Command\s+([\s\S]+)$/i.exec(raw);
  if (ps) {
    return { name: 'PowerShell', command: unquote(ps[1]) };
  }
  const sh = /^\s*"?[^"\s]*?\b(?:bash|zsh|sh)"?\s+-l?c\s+([\s\S]+)$/.exec(raw);
  if (sh) {
    return { name: 'Bash', command: unquote(sh[1]) };
  }
  return { name: 'Bash', command: raw };
}

function unquote(text: string): string {
  const t = text.trim();
  if (t.length >= 2 && t[0] === "'" && t[t.length - 1] === "'") {
    return t.slice(1, -1).replace(/''/g, "'").replace(/'\\''/g, "'");
  }
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    return t.slice(1, -1);
  }
  return t;
}

function planTodos(plan: { step: string; status: string }[]): { content: string; status: string }[] {
  return (plan ?? []).map((s) => ({ content: s.step, status: s.status === 'inProgress' ? 'in_progress' : s.status }));
}

function approvalDecision(answer: PermissionDecision): string {
  if (answer.decision === 'always') {
    return 'acceptForSession';
  }
  if (answer.decision === 'allow' || answer.decision === 'answer') {
    return 'accept';
  }
  // Com explicação, só esta ação é recusada e o turno segue; sem, o turno acaba (como no Claude).
  return answer.decision === 'deny' && answer.feedback?.trim() ? 'decline' : 'cancel';
}

function reviewDecision(answer: PermissionDecision): unknown {
  if (answer.decision === 'always') {
    return 'approved_for_session';
  }
  if (answer.decision === 'allow' || answer.decision === 'answer') {
    return 'approved';
  }
  return answer.decision === 'deny' && answer.feedback?.trim() ? { denied: { rejection: answer.feedback.trim() } } : 'abort';
}

/** Janela de limite -> rótulo pelo tamanho (o Codex manda minutos, não nome). */
function rateWindows(snap: RateSnapshot, prefixName: boolean): UsageWindow[] {
  const out: UsageWindow[] = [];
  const prefix = prefixName && snap.limitName ? `${snap.limitName} · ` : '';
  for (const [slot, w] of [['primary', snap.primary], ['secondary', snap.secondary]] as const) {
    if (!w) {
      continue;
    }
    out.push({
      key: `${snap.limitId ?? 'codex'}:${slot}`,
      label: prefix + windowLabel(w.windowDurationMins),
      utilization: w.usedPercent,
      resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : undefined,
    });
  }
  return out;
}

function windowLabel(mins: number | null): string {
  if (!mins) {
    return 'Limite';
  }
  if (mins === 300) {
    return 'Sessão (5h)';
  }
  if (mins === 10080) {
    return 'Semana';
  }
  if (mins >= 43200 - 1440 && mins <= 44640) {
    return 'Mês';
  }
  if (mins % 1440 === 0) {
    return `${mins / 1440} dias`;
  }
  return mins % 60 === 0 ? `${mins / 60}h` : `${mins} min`;
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : (c as { type?: string })?.type === 'image' ? '[imagem]' : ''))
    .join('\n');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : { value };
}

function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
