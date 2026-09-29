import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import type {
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  HookCallbackMatcher,
  HookEvent,
  McpServerConfig,
  Query,
  SDKMessage,
  SDKUserMessage,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Profile, configDirEnv } from '../profiles';
import { resolveClaudeExecutable } from '../claudePath';
import { researchEnv } from './infra/researchPack';
import { projectMcpSettings } from './guard/mcpApproval';
import { BROWSER_SERVER, BROWSER_TOOL_PREFIX, BrowserStatus, browserActionWrites, browserUnreachable, describeBrowserAction, isBrowserTool } from './browser';
import { Attachment, AgentInfo, AgentStatus, HistoryItem, HostMessage, PermissionDecision, SlashCommandOption, UsageInfo, UsageWindow } from './protocol';

const AGENT_TOOLS = new Set(['Agent', 'Task']);
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Conteúdo de uma mensagem do usuário como o SDK aceita: texto solto ou lista de blocos (MessageParam). */
type UserContent = SDKUserMessage['message']['content'];
type UserContentBlock = Exclude<UserContent, string>[number];

const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

/**
 * Comandos presos ao terminal (o `init` traz em `terminal_slash_commands`). O init só chega com a primeira
 * mensagem, então a lista começa com o que o CLI 2.1.283 mandou e é trocada pela do processo assim que ele fala.
 */
let terminalCommands = new Set(['doctor', 'color', 'focus', 'reload-plugins']);

export interface AgentRecord {
  info: AgentInfo;
  items: HistoryItem[];
}

export interface SessionOptions {
  model?: string;
  effort?: string;
  permissionMode?: PermissionMode;
  /** Chamado a cada início de processo: servidores MCP embutidos precisam de instância nova por processo. */
  mcpServers?: () => Record<string, McpServerConfig>;
  /** Texto somado ao prompt de sistema padrão do Claude Code, calculado a cada início de processo. */
  systemAppend?: () => string | undefined;
  /** Ferramentas tiradas do modelo por completo (valem até em bypass, onde canUseTool nem é chamado). */
  disallowedTools?: string[];
  /** Sobe com o Claude in Chrome (`--chrome`). Sem isso a sessão vai com `--no-chrome`. */
  chrome?: boolean;
  /**
   * Ações do navegador que escrevem (clicar, digitar, navegar...) pedem aprovação mesmo em bypass?
   * Lido a cada chamada, para a configuração valer sem reiniciar. Padrão: sim.
   */
  browserApproval?: () => boolean;
  /** Hooks extras do SDK (caminhos protegidos dos agentes), somados ao do navegador a cada início de processo. */
  hooks?: () => Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined;
}

/** Ferramentas da própria extensão; não pedem permissão. */
const OWN_TOOL_PREFIX = 'mcp__agents__';

/** Fila que alimenta o modo de entrada contínua do SDK: cada push vira uma mensagem do usuário. */
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiting?: (r: IteratorResult<SDKUserMessage>) => void;
  private closed = false;

  /** priority "next": o CLI dobra a mensagem no turno em andamento, na próxima fronteira de ferramenta, sem interromper. */
  push(content: UserContent, priority?: SDKUserMessage['priority']): void {
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      ...(priority ? { priority } : {}),
    };
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: msg, done: false });
    } else {
      this.items.push(msg);
    }
  }

  close(): void {
    this.closed = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) {
          return Promise.resolve({ value: item, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => (this.waiting = resolve));
      },
    };
  }
}

interface PendingPermission {
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  resolve: (r: PermissionResult) => void;
}

/** Variáveis que o CLI usa para saber que está dentro de outra sessão; herdadas por engano, confundem o processo filho. */
const INHERITED_NOISE = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'];

export function profileEnv(profile: Profile): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of INHERITED_NOISE) {
    delete env[key];
  }
  const dir = configDirEnv(profile);
  if (dir) {
    env.CLAUDE_CONFIG_DIR = dir;
  } else {
    delete env.CLAUDE_CONFIG_DIR;
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'agent-graph-master/1.0.0';
  // Tokens do pacote de pesquisa (W&B, Hugging Face, Jupyter) guardados no SecretStorage: o .mcp.json só referencia a variável.
  Object.assign(env, researchEnv());
  return env;
}

export class ChatSession {
  sessionId?: string;
  permissionMode: PermissionMode = 'default';
  model: string;
  effort: string;
  readonly agents = new Map<string, AgentRecord>();
  /** Texto que o Claude escreveu no último turno terminado; é o que "Enviar ao chat principal" repassa. */
  lastTurnText = '';
  onTurnEnd?: (info: { contextTokens: number; isError: boolean; queued: number; durationMs: number }) => void;
  onBusyChange?: (busy: boolean) => void;
  /** Consumo para o orçamento: tokens de cada mensagem do modelo (repetida por bloco, daí o id) e custo acumulado no fim do turno. */
  onUsage?: (u: { messageId?: string; tokens?: number; costUsdTotal?: number }) => void;
  /** Navegador desta sessão; muda ao subir o processo e quando uma chamada mostra que o Chrome sumiu. */
  browser: BrowserStatus = { enabled: false, status: 'off', tools: [] };
  onBrowserChange?: (status: BrowserStatus) => void;
  chrome: boolean;

  private q?: Query;
  private prompts?: PromptQueue;
  private pending = new Map<string, PendingPermission>();
  private busy = false;
  private disposed = false;
  private turnTexts: string[] = [];
  private restartWhenIdle = false;
  private contextTokens = 0;
  private commands: SlashCommand[] = [];
  /** Depois de um /compact o CLI reenvia a saída de comandos locais já mostrados, com o mesmo uuid. */
  private shownLocalOutputs = new Set<string>();
  /** Chamadas de navegador em andamento, para reconhecer no resultado que o Chrome não respondeu. */
  private browserCalls = new Set<string>();

  constructor(
    readonly profile: Profile,
    readonly cwd: string,
    private readonly post: (msg: HostMessage) => void,
    private readonly options: SessionOptions = {},
  ) {
    const config = vscode.workspace.getConfiguration('agentGraphMaster');
    this.permissionMode = options.permissionMode ?? configuredPermissionMode(config);
    this.model = options.model ?? config.get<string>('defaultModel', '').trim();
    this.effort = options.effort ?? config.get<string>('defaultEffort', '').trim();
    this.chrome = !!options.chrome;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  /** Ferramentas do próprio chat pedidas e ainda sem resultado. */
  private toolsRunning = new Set<string>();
  /** Chamado quando o chat começa a rodar uma ferramenta: é a janela para um aviso entrar sem abrir turno. */
  onToolStart?: () => void;

  /**
   * Aviso informativo sem turno novo: só entra se o chat está no meio de uma ferramenta, e aí o CLI o dobra no
   * turno em andamento assim que ela termina. Devolve false quando não é o momento (quem chama guarda para depois).
   */
  notify(text: string): boolean {
    if (!this.prompts || !this.busy || !this.toolsRunning.size) {
      return false;
    }
    this.prompts.push(text, 'next');
    return true;
  }

  /** Sobe o processo do Claude (sem gastar token até a primeira mensagem). Com resumeId, continua uma conversa salva. */
  start(resumeId?: string): void {
    this.stop();
    this.restartWhenIdle = false;
    this.toolsRunning.clear();
    this.sessionId = resumeId;
    // A fila nasce já aqui: achar o executável virou assíncrono, e o que o usuário digitar nesse meio-tempo
    // fica guardado até o processo subir.
    const prompts = new PromptQueue();
    this.prompts = prompts;
    void resolveClaudeExecutable().then((executable) => {
      if (this.prompts !== prompts) {
        return; // Um stop() ou outro start() passou na frente enquanto procurávamos.
      }
      if (!executable) {
        this.post({
          type: 'notice',
          level: 'error',
          text: 'Não achei o executável do Claude Code. Instale o CLI ou informe o caminho em agentGraphMaster.claudePath.',
        });
        this.prompts = undefined;
        return;
      }
      this.launch(prompts, executable, resumeId);
    });
  }

  private launch(prompts: PromptQueue, executable: string, resumeId?: string): void {
    const q = query({
      prompt: prompts,
      options: {
        pathToClaudeCodeExecutable: executable,
        cwd: this.cwd,
        env: profileEnv(this.profile),
        resume: resumeId,
        model: this.model || undefined,
        effort: (this.effort || undefined) as Effort | undefined,
        permissionMode: this.permissionMode,
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        forwardSubagentText: true,
        agentProgressSummaries: true,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: this.options.systemAppend?.() },
        mcpServers: this.options.mcpServers?.(),
        tools: { type: 'preset', preset: 'claude_code' },
        disallowedTools: this.options.disallowedTools,
        settingSources: ['user', 'project', 'local'],
        // Servidor do .mcp.json sem aprovação do usuário para o conteúdo atual não sobe (guard/mcpApproval.ts).
        settings: projectMcpSettings(this.cwd),
        extraArgs: { [this.chrome ? 'chrome' : 'no-chrome']: null },
        hooks: this.sessionHooks(),
        canUseTool: (toolName, input, opts) =>
          toolName.startsWith(OWN_TOOL_PREFIX)
            ? Promise.resolve({ behavior: 'allow', updatedInput: input })
            : this.askPermission(toolName, input, opts.signal, opts.suggestions, opts.blockedPath),
        stderr: (data) => console.error(`[claude ${this.profile.name}] ${data}`),
      },
    });
    this.q = q;
    void this.consume(q);
    void this.readBrowserStatus(q);
    q.supportedModels()
      .then((list) =>
        this.post({
          type: 'models',
          list: list.map((m) => ({
            value: m.value,
            resolvedModel: m.resolvedModel,
            displayName: m.displayName,
            description: m.description,
          })),
        }),
      )
      .catch(() => undefined);
    q.supportedCommands()
      .then((list) => {
        this.commands = list;
        this.postCommands();
      })
      .catch(() => undefined);
  }

  /** Manda ao webview os comandos de barra, sem os que só fazem sentido no terminal. */
  postCommands(): void {
    const list: SlashCommandOption[] = this.commands
      .filter((c) => !terminalCommands.has(c.name) && !c.name.startsWith('__'))
      .map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint || undefined }));
    if (list.length) {
      this.post({ type: 'commands', list });
    }
  }

  send(text: string, attachments?: Attachment[]): void {
    const cmd = /^\/([\w:-]+)/.exec(text.trim())?.[1];
    if (cmd && terminalCommands.has(cmd)) {
      this.post({ type: 'notice', level: 'info', text: `/${cmd} é um comando do terminal do Claude Code; aqui ele pode não fazer nada ou se comportar diferente.` });
    }
    if (!this.prompts) {
      // O processo morreu (erro, rede, etc.). Sobe de novo continuando a mesma conversa.
      this.start(this.sessionId);
    }
    this.setBusy(true);
    this.turnTexts = [];
    this.prompts?.push(buildUserContent(text, attachments));
  }

  async interrupt(): Promise<void> {
    this.denyAllPending('Interrompido pelo usuário.');
    try {
      await this.q?.interrupt();
    } catch (err) {
      this.post({ type: 'notice', level: 'error', text: `Falha ao interromper: ${errorText(err)}` });
    }
  }

  async setMode(mode: PermissionMode): Promise<void> {
    this.permissionMode = mode;
    try {
      await this.q?.setPermissionMode(mode);
    } catch (err) {
      this.post({ type: 'notice', level: 'error', text: `Não consegui trocar o modo: ${errorText(err)}` });
    }
  }

  async setModel(model: string): Promise<void> {
    this.model = model;
    try {
      await this.q?.setModel(model || undefined);
    } catch (err) {
      this.post({ type: 'notice', level: 'error', text: `Não consegui trocar o modelo: ${errorText(err)}` });
    }
  }

  /** O SDK só aceita o raciocínio na hora de subir o processo; a troca reinicia e retoma a mesma conversa. */
  setEffort(effort: string): void {
    this.effort = effort;
    if (!this.q) {
      return;
    }
    if (this.busy) {
      this.restartWhenIdle = true;
      this.post({ type: 'notice', level: 'info', text: 'O novo nível de raciocínio vale a partir da próxima mensagem.' });
    } else {
      this.start(this.sessionId);
    }
  }

  /** Servidores MCP do projeto aprovados agora: só entram ao subir o processo, então reinicia e retoma. */
  reloadProjectMcp(): void {
    if (!this.q) {
      return;
    }
    if (this.busy) {
      this.restartWhenIdle = true;
    } else {
      this.start(this.sessionId);
    }
  }

  /**
   * Liga ou desliga o Claude in Chrome. Como o raciocínio, só vale ao subir o processo: reinicia e retoma.
   * `quiet` cala o aviso de "a partir da próxima mensagem" (o hub desliga o navegador no fim do turno de um agente).
   */
  setChrome(on: boolean, quiet = false): void {
    if (this.chrome === on) {
      return;
    }
    this.chrome = on;
    if (!this.q) {
      return;
    }
    if (this.busy) {
      this.restartWhenIdle = true;
      if (!quiet) {
        this.post({ type: 'notice', level: 'info', text: `O navegador ${on ? 'liga' : 'desliga'} a partir da próxima mensagem.` });
      }
    } else {
      this.start(this.sessionId);
    }
  }

  /**
   * Lê os limites do plano (janela de 5 horas e da semana) pelo mesmo caminho do comando /usage.
   * Precisa de um processo vivo; sem ele, devolve `available: false` em vez de estourar.
   */
  async readUsage(): Promise<UsageInfo> {
    const fetchedAt = new Date().toISOString();
    if (!this.q) {
      return { available: false, windows: [], fetchedAt, error: 'sessão ainda não iniciada' };
    }
    try {
      const data = await this.q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
      if (!data.rate_limits_available || !data.rate_limits) {
        return {
          available: false,
          subscription: data.subscription_type ?? undefined,
          windows: [],
          fetchedAt,
          error: 'esta conta não usa limites de plano (chave de API ou provedor externo)',
        };
      }
      return {
        available: true,
        subscription: data.subscription_type ?? undefined,
        windows: usageWindows(data.rate_limits),
        fetchedAt,
      };
    } catch (err) {
      return { available: false, windows: [], fetchedAt, error: errorText(err) };
    }
  }

  async stopAgent(id: string): Promise<void> {
    const record = this.agents.get(id);
    if (!record?.info.taskId || record.info.status !== 'running') {
      return;
    }
    try {
      await this.q?.stopTask(record.info.taskId);
    } catch (err) {
      this.post({ type: 'notice', level: 'error', text: `Não consegui parar o agente: ${errorText(err)}` });
    }
  }

  respondPermission(requestId: string, answer: PermissionDecision): void {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }
    this.pending.delete(requestId);
    this.post({ type: 'permissionClosed', requestId });

    if (answer.decision === 'deny') {
      const feedback = answer.feedback?.trim();
      pending.resolve({
        behavior: 'deny',
        message: feedback ? `O usuário recusou e explicou: ${feedback}` : 'O usuário recusou esta ação.',
        interrupt: !feedback,
      });
      return;
    }
    if (answer.decision === 'answer') {
      pending.resolve({ behavior: 'allow', updatedInput: answer.updatedInput });
      return;
    }

    if (pending.toolName === 'ExitPlanMode') {
      // Aprovar o plano sai do modo de planejamento, como na extensão oficial.
      const next: PermissionMode = answer.decision === 'always' ? 'acceptEdits' : 'default';
      this.permissionMode = next;
      this.post({ type: 'session', sessionId: this.sessionId ?? '', model: this.model, permissionMode: next });
      pending.resolve({
        behavior: 'allow',
        updatedInput: pending.input,
        updatedPermissions: [{ type: 'setMode', mode: next, destination: 'session' }],
      });
      return;
    }
    pending.resolve({
      behavior: 'allow',
      updatedInput: pending.input,
      updatedPermissions: answer.decision === 'always' ? pending.suggestions : undefined,
    });
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  private stop(): void {
    this.denyAllPending('Sessão encerrada.');
    this.prompts?.close();
    this.q?.close();
    this.q = undefined;
    this.prompts = undefined;
    this.setBusy(false);
  }

  private askPermission(
    toolName: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    suggestions?: PermissionUpdate[],
    blockedPath?: string,
    reason?: string,
  ): Promise<PermissionResult> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      this.pending.set(requestId, { toolName, input, suggestions, resolve });
      signal.addEventListener('abort', () => {
        if (this.pending.delete(requestId)) {
          this.post({ type: 'permissionClosed', requestId });
          resolve({ behavior: 'deny', message: 'Cancelado.' });
        }
      });
      this.post({
        type: 'permission',
        requestId,
        toolName,
        input,
        canAlways: !!suggestions?.length || toolName === 'ExitPlanMode',
        reason: reason ?? (blockedPath ? `Acesso fora das pastas liberadas: ${blockedPath}` : undefined),
      });
    });
  }

  /**
   * Em bypass o CLI nem consulta o canUseTool; o hook PreToolUse roda em todos os modos. Ações que escrevem
   * passam pelo mesmo pedido de aprovação do chat, e o "permitir" do hook dispensa o canUseTool, então não
   * há pedido em dobro. Leitura, e tudo quando a aprovação está desligada, seguem o fluxo normal do modo.
   */
  private browserGate(): HookCallbackMatcher {
    return {
      matcher: `^${BROWSER_TOOL_PREFIX}`,
      timeout: 24 * 60 * 60,
      hooks: [
        async (input, _toolUseId, { signal }) => {
          if (input.hook_event_name !== 'PreToolUse' || !isBrowserTool(input.tool_name)) {
            return {};
          }
          const needs = this.options.browserApproval?.() ?? true;
          if (!needs || !browserActionWrites(input.tool_name, input.tool_input)) {
            return {};
          }
          const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
          const answer = await this.askPermission(
            input.tool_name,
            toolInput,
            signal,
            undefined,
            undefined,
            `Ação no navegador: ${describeBrowserAction(input.tool_name, toolInput)}`,
          );
          return {
            hookSpecificOutput:
              answer.behavior === 'allow'
                ? { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: answer.updatedInput ?? toolInput }
                : { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: answer.message },
          };
        },
      ],
    };
  }

  /** Hook do navegador (com --chrome) mais os que o dono da sessão pedir; o PreToolUse de cada um roda em sequência. */
  private sessionHooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined {
    const extra = this.options.hooks?.() ?? {};
    const pre = [...(this.chrome ? [this.browserGate()] : []), ...(extra.PreToolUse ?? [])];
    const merged = { ...extra, ...(pre.length ? { PreToolUse: pre } : {}) };
    return Object.keys(merged).length ? merged : undefined;
  }

  /** A ponte do Chrome leva ~1 s para subir; espera sair de `pending` e publica o que veio. */
  private async readBrowserStatus(q: Query): Promise<void> {
    if (!this.chrome) {
      this.setBrowser({ enabled: false, status: 'off', tools: [] });
      return;
    }
    this.setBrowser({ enabled: true, status: 'pending', tools: [] });
    for (let i = 0; i < 30 && q === this.q; i++) {
      try {
        const server = (await q.mcpServerStatus()).find((s) => s.name === BROWSER_SERVER);
        if (!server) {
          this.setBrowser({ enabled: true, status: 'failed', tools: [], error: 'O CLI não subiu o Claude in Chrome.' });
          return;
        }
        if (server.status !== 'pending') {
          this.setBrowser({
            enabled: true,
            status: server.status,
            tools: (server.tools ?? []).map((t) => BROWSER_TOOL_PREFIX + t.name),
            error: server.error,
          });
          return;
        }
      } catch {
        // Processo subindo ou já encerrado; a condição do laço decide se tenta de novo.
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  private setBrowser(status: BrowserStatus): void {
    this.browser = status;
    this.onBrowserChange?.(status);
  }

  private noteBrowserResult(toolUseId: string, text: string, isError: boolean): void {
    if (!this.browserCalls.delete(toolUseId)) {
      return;
    }
    if (isError && browserUnreachable(text)) {
      this.setBrowser({ ...this.browser, status: 'disconnected', error: text.slice(0, 500) });
    } else if (!isError && this.browser.status === 'disconnected') {
      this.setBrowser({ ...this.browser, status: 'connected', error: undefined });
    }
  }

  private denyAllPending(message: string): void {
    for (const [id, pending] of this.pending) {
      this.post({ type: 'permissionClosed', requestId: id });
      pending.resolve({ behavior: 'deny', message, interrupt: true });
    }
    this.pending.clear();
  }

  private setBusy(value: boolean): void {
    if (this.busy !== value) {
      this.busy = value;
      this.post({ type: 'busy', value });
      this.onBusyChange?.(value);
    }
  }

  // ---------- Subagentes ----------

  private registerAgent(id: string, input: Record<string, unknown>): void {
    if (this.agents.has(id)) {
      return;
    }
    const info: AgentInfo = {
      id,
      kind: 'subagent',
      description: String(input.description ?? 'Subagente'),
      subagentType: input.subagent_type ? String(input.subagent_type) : undefined,
      prompt: input.prompt ? String(input.prompt) : undefined,
      // A ferramenta Agent embutida sempre devolve o resultado a quem a chamou, que aqui é esta conversa.
      creator: 'main',
      reportTo: 'main',
      status: 'running',
      totalTokens: 0,
      durationMs: 0,
      toolUses: 0,
    };
    this.agents.set(id, { info, items: [] });
    this.post({ type: 'agent', agent: info });
  }

  private updateAgent(id: string, patch: Partial<AgentInfo>): void {
    if (!this.agents.has(id)) {
      this.registerAgent(id, { description: patch.description });
    }
    const record = this.agents.get(id)!;
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<AgentInfo>;
    record.info = { ...record.info, ...clean };
    this.post({ type: 'agent', agent: record.info });
  }

  private addAgentItem(id: string, item: HistoryItem): void {
    if (!this.agents.has(id)) {
      this.registerAgent(id, {});
    }
    this.agents.get(id)!.items.push(item);
    this.post({ type: 'agentItem', id, item });
  }

  private agentIdByTask(taskId: string): string | undefined {
    for (const [id, record] of this.agents) {
      if (record.info.taskId === taskId) {
        return id;
      }
    }
    return undefined;
  }

  // ---------- Leitura das mensagens do SDK ----------

  private async consume(q: Query): Promise<void> {
    // Estado do streaming: id da mensagem atual e tipo de cada bloco, para saber quando o "pensando" termina.
    const stream = { msgId: '', blockTypes: new Map<number, string>() };
    try {
      for await (const m of q) {
        if (q !== this.q) {
          return;
        }
        this.handle(m, stream);
      }
    } catch (err) {
      if (q === this.q && !this.disposed) {
        this.post({ type: 'notice', level: 'error', text: `O processo do Claude parou: ${errorText(err)}` });
      }
    } finally {
      if (q === this.q) {
        this.q = undefined;
        this.prompts = undefined;
        this.setBusy(false);
        this.post({ type: 'thinking', value: false });
      }
    }
  }

  private handle(m: SDKMessage, stream: { msgId: string; blockTypes: Map<number, string> }): void {
    switch (m.type) {
      case 'system':
        this.handleSystem(m);
        return;

      case 'stream_event': {
        if (m.parent_tool_use_id) {
          return;
        }
        const ev = m.event;
        if (ev.type === 'message_start') {
          stream.msgId = ev.message.id;
          stream.blockTypes.clear();
        } else if (ev.type === 'content_block_start') {
          stream.blockTypes.set(ev.index, ev.content_block.type);
          if (ev.content_block.type === 'thinking' || ev.content_block.type === 'redacted_thinking') {
            this.post({ type: 'thinking', value: true });
          } else if (ev.content_block.type === 'tool_use') {
            this.post({ type: 'toolStart', id: ev.content_block.id, name: ev.content_block.name });
          }
        } else if (ev.type === 'content_block_delta') {
          if (ev.delta.type === 'text_delta') {
            this.post({ type: 'textDelta', msgId: stream.msgId, index: ev.index, text: ev.delta.text });
          }
        } else if (ev.type === 'content_block_stop') {
          const kind = stream.blockTypes.get(ev.index);
          if (kind === 'thinking' || kind === 'redacted_thinking') {
            this.post({ type: 'thinking', value: false });
          }
        }
        return;
      }

      case 'assistant': {
        const content = m.message.content;
        // Comando local (/rename, /usage, /context...): o CLI responde com uma mensagem sintética, sem modelo.
        if ('local_command_run' in m && !m.parent_tool_use_id) {
          if (!this.shownLocalOutputs.has(m.uuid)) {
            this.shownLocalOutputs.add(m.uuid);
            const text = content.map((b) => (b.type === 'text' ? b.text : '')).join('\n').trim();
            if (text) {
              this.post({ type: 'commandOutput', text });
            }
          }
          return;
        }
        const used = m.message.usage;
        if (used && this.onUsage) {
          // Subagentes (parent_tool_use_id) também gastam: entram na conta do dono da sessão.
          const tokens = (used.input_tokens ?? 0) + (used.output_tokens ?? 0) + (used.cache_read_input_tokens ?? 0) + (used.cache_creation_input_tokens ?? 0);
          this.onUsage({ messageId: m.message.id, tokens });
        }
        for (const block of content) {
          if (block.type === 'tool_use' && AGENT_TOOLS.has(block.name)) {
            this.registerAgent(block.id, block.input as Record<string, unknown>);
          }
          if (block.type === 'tool_use' && isBrowserTool(block.name)) {
            this.browserCalls.add(block.id);
          }
        }
        if (m.parent_tool_use_id) {
          for (const block of content) {
            if (block.type === 'text' && block.text.trim()) {
              this.addAgentItem(m.parent_tool_use_id, { kind: 'text', text: block.text });
            } else if (block.type === 'tool_use') {
              this.addAgentItem(m.parent_tool_use_id, { kind: 'tool', id: block.id, name: block.name, input: block.input });
            }
          }
          return;
        }
        for (const block of content) {
          if (block.type === 'text') {
            this.turnTexts.push(block.text);
            this.post({ type: 'assistantText', msgId: m.message.id, text: block.text });
          } else if (block.type === 'tool_use') {
            this.post({ type: 'toolUse', id: block.id, name: block.name, input: block.input });
            this.toolsRunning.add(block.id);
            this.onToolStart?.();
          }
        }
        const u = m.message.usage;
        const context = (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);
        if (context && context !== this.contextTokens) {
          this.contextTokens = context;
          this.post({ type: 'contextTokens', value: context });
        }
        if (m.error) {
          this.post({ type: 'notice', level: 'error', text: `Erro da API: ${m.error}` });
        }
        return;
      }

      case 'user': {
        if (typeof m.message.content === 'string') {
          return;
        }
        for (const block of m.message.content) {
          if (block.type !== 'tool_result') {
            continue;
          }
          const text = toolResultText(block.content);
          const isError = !!block.is_error;
          const images = toolResultImages(block.content);
          this.noteBrowserResult(block.tool_use_id, text, isError);
          if (m.parent_tool_use_id) {
            this.addAgentItem(m.parent_tool_use_id, { kind: 'toolResult', id: block.tool_use_id, text, isError, images });
            continue;
          }
          this.toolsRunning.delete(block.tool_use_id);
          const agent = this.agents.get(block.tool_use_id);
          if (agent && !agent.info.taskId && agent.info.status === 'running') {
            // CLI sem eventos de tarefa: o resultado da ferramenta marca o fim do subagente.
            this.updateAgent(block.tool_use_id, { status: isError ? 'failed' : 'completed' });
          }
          this.post({ type: 'toolResult', id: block.tool_use_id, text, isError, images });
        }
        return;
      }

      case 'conversation_reset':
        // /clear: o CLI abriu uma sessão nova; o init que vem em seguida traz o id dela.
        this.contextTokens = 0;
        this.agents.clear();
        this.post({ type: 'clear' });
        this.post({ type: 'notice', level: 'info', text: 'Conversa limpa. O Claude começou do zero; a anterior continua no histórico.' });
        return;

      case 'result': {
        this.toolsRunning.clear();
        const usage = m.usage;
        this.post({
          type: 'result',
          isError: m.is_error,
          text: m.subtype === 'success' ? '' : m.subtype,
          durationMs: m.duration_ms,
          inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
          outputTokens: usage.output_tokens ?? 0,
        });
        this.lastTurnText = this.turnTexts.join('\n\n');
        this.onUsage?.({ costUsdTotal: m.total_cost_usd });
        this.onTurnEnd?.({
          contextTokens: this.contextTokens,
          isError: m.is_error,
          queued: m.queued_turn_count ?? 0,
          durationMs: m.duration_ms,
        });
        if (!m.queued_turn_count) {
          this.setBusy(false);
          if (this.restartWhenIdle) {
            this.start(this.sessionId);
          }
        }
        return;
      }
    }
  }

  private handleSystem(m: Extract<SDKMessage, { type: 'system' }>): void {
    switch (m.subtype) {
      case 'init':
        this.sessionId = m.session_id;
        this.permissionMode = m.permissionMode;
        this.post({ type: 'session', sessionId: m.session_id, model: m.model, permissionMode: m.permissionMode, mcpServers: m.mcp_servers?.map((s) => ({ name: s.name, status: s.status })) });
        // O init vem a cada turno; só reenvia a lista quando o conjunto do terminal mudou.
        if (m.terminal_slash_commands && m.terminal_slash_commands.join() !== [...terminalCommands].join()) {
          terminalCommands = new Set(m.terminal_slash_commands);
          this.postCommands();
        }
        return;
      case 'commands_changed':
        this.commands = m.commands;
        this.postCommands();
        return;
      case 'local_command_output':
        if (m.content.trim()) {
          this.post({ type: 'commandOutput', text: m.content.trim() });
        }
        return;
      case 'compact_boundary':
        this.post({ type: 'notice', level: 'info', text: 'Conversa compactada para liberar contexto.' });
        return;
      case 'api_retry':
        this.post({ type: 'notice', level: 'info', text: 'A API falhou, tentando de novo...' });
        return;
      case 'task_started':
        if (m.tool_use_id) {
          this.updateAgent(m.tool_use_id, {
            taskId: m.task_id,
            description: m.description,
            subagentType: m.subagent_type,
            prompt: m.prompt,
            status: 'running',
          });
        }
        return;
      case 'task_progress':
        if (m.tool_use_id) {
          this.updateAgent(m.tool_use_id, {
            taskId: m.task_id,
            totalTokens: m.usage.total_tokens,
            durationMs: m.usage.duration_ms,
            toolUses: m.usage.tool_uses,
            lastTool: m.last_tool_name,
            summary: m.summary,
          });
        }
        return;
      case 'task_updated': {
        const id = this.agentIdByTask(m.task_id);
        if (id && m.patch.status) {
          this.updateAgent(id, { status: mapTaskStatus(m.patch.status), summary: m.patch.error });
        }
        return;
      }
      case 'task_notification': {
        const id = m.tool_use_id ?? this.agentIdByTask(m.task_id);
        if (id) {
          this.updateAgent(id, {
            status: mapTaskStatus(m.status),
            summary: m.summary,
            ...(m.usage ? { totalTokens: m.usage.total_tokens, durationMs: m.usage.duration_ms, toolUses: m.usage.tool_uses } : {}),
          });
        }
        return;
      }
    }
  }
}

/** Lê o modo de permissão inicial da configuração; valor estranho cai no padrão da extensão. */
function configuredPermissionMode(config: vscode.WorkspaceConfiguration): PermissionMode {
  const value = config.get<string>('defaultPermissionMode', 'bypassPermissions').trim();
  return PERMISSION_MODES.includes(value as PermissionMode) ? (value as PermissionMode) : 'bypassPermissions';
}

function isImageMediaType(value: string): value is ImageMediaType {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(value);
}

/** Separa um data URL (`data:image/png;base64,AAA...`) no tipo e nos bytes em base64. */
function parseDataUrl(dataUrl: string): { mediaType: string; data: string } | undefined {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(dataUrl.trim());
  return match ? { mediaType: match[1].toLowerCase(), data: match[2] } : undefined;
}

/**
 * Monta o conteúdo da mensagem do usuário. Sem anexo, continua sendo texto puro.
 * Com anexo: as imagens vão como blocos próprios, na frente, e o resto (mensagem, menções `@caminho`
 * e conteúdo de arquivo) vai junto em um único bloco de texto.
 */
function buildUserContent(text: string, attachments?: Attachment[]): UserContent {
  if (!attachments?.length) {
    return text;
  }
  const images: UserContentBlock[] = [];
  const mentions: string[] = [];
  const extras: string[] = [];

  for (const att of attachments) {
    if (att.error) {
      extras.push(`[O anexo "${att.name}" não veio junto: ${att.error}]`);
      continue;
    }
    if (att.kind === 'image') {
      const parsed = att.dataUrl ? parseDataUrl(att.dataUrl) : undefined;
      if (parsed && isImageMediaType(parsed.mediaType)) {
        images.push({ type: 'image', source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data } });
      } else {
        const kind = parsed?.mediaType ?? 'desconhecido';
        extras.push(`[A imagem "${att.name}" não pôde ser enviada: o formato ${kind} não é suportado. Use png, jpeg, gif ou webp.]`);
      }
    } else if (att.kind === 'path') {
      if (att.path) {
        // Caminho com espaço precisa de aspas, senão a menção termina no primeiro espaço.
        mentions.push(/\s/.test(att.path) ? `@"${att.path}"` : `@${att.path}`);
      }
    } else if (att.text !== undefined) {
      extras.push(`<arquivo nome="${att.name}">\n${att.text}\n</arquivo>`);
    }
  }

  const body = [[text.trim(), mentions.join(' ')].filter(Boolean).join('\n\n'), ...extras].filter(Boolean).join('\n\n');
  const blocks = body ? [...images, { type: 'text' as const, text: body }] : images;
  return blocks.length ? blocks : text;
}

type RateWindow = { utilization: number | null; resets_at: string | null } | null | undefined;

/**
 * Achata a resposta de /usage nas janelas que o rodapé mostra. O servidor manda dezenas de chaves
 * com nomes internos; só interessam a janela de 5 horas, a da semana e as por modelo.
 */
function usageWindows(limits: Record<string, unknown>): UsageWindow[] {
  const named: [string, string][] = [
    ['five_hour', 'Sessão (5h)'],
    ['seven_day', 'Semana'],
    ['seven_day_opus', 'Semana · Opus'],
    ['seven_day_sonnet', 'Semana · Sonnet'],
  ];
  const windows: UsageWindow[] = [];
  for (const [key, label] of named) {
    const w = limits[key] as RateWindow;
    if (w && typeof w.utilization === 'number') {
      windows.push({ key, label, utilization: w.utilization, resetsAt: w.resets_at ?? undefined });
    }
  }
  const scoped = limits.model_scoped;
  if (Array.isArray(scoped)) {
    for (const entry of scoped as { display_name?: string; utilization?: number | null; resets_at?: string | null }[]) {
      if (typeof entry.utilization === 'number') {
        windows.push({
          key: `model:${entry.display_name ?? ''}`,
          label: `Semana · ${entry.display_name ?? 'modelo'}`,
          utilization: entry.utilization,
          resetsAt: entry.resets_at ?? undefined,
        });
      }
    }
  }
  return windows;
}

/** Mapeia os status de tarefa do CLI para os quatro estados que o mapa mostra. */
function mapTaskStatus(status: string): AgentStatus {
  if (status === 'completed' || status === 'failed') {
    return status;
  }
  if (status === 'killed' || status === 'stopped') {
    return 'stopped';
  }
  return 'running';
}

export function toolResultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : c?.type === 'image' ? '[imagem]' : ''))
      .join('\n');
  }
  return '';
}

/** Teto por imagem (em caracteres da data URL). Capturas do Chrome ficam bem abaixo; acima disso só entra o aviso. */
const MAX_RESULT_IMAGE_CHARS = 2 * 1024 * 1024;
const MAX_RESULT_IMAGES = 4;

/**
 * Imagens de um resultado de ferramenta (capturas de tela do navegador) como data URLs, para a miniatura no log.
 * A CSP do webview já aceita `data:`; imagem grande demais fica de fora e o texto continua dizendo "[imagem]".
 */
export function toolResultImages(content: unknown): string[] | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const out: string[] = [];
  for (const c of content) {
    const source = c?.type === 'image' ? (c as { source?: { type?: string; media_type?: string; data?: string } }).source : undefined;
    if (source?.type !== 'base64' || !source.data || !source.media_type?.startsWith('image/')) {
      continue;
    }
    const url = `data:${source.media_type};base64,${source.data}`;
    if (url.length <= MAX_RESULT_IMAGE_CHARS && out.length < MAX_RESULT_IMAGES) {
      out.push(url);
    }
  }
  return out.length ? out : undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
