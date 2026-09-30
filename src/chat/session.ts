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
import { decisionFor, projectMcpSettings, readProjectMcp } from './guard/mcpApproval';
import { limitFromText } from './turnRules';
import { LEVEL_GRACE_MS, TaskLife, isOrphanNotice, orphanNoticeIds, reconcileTasks } from './taskLiveness';
import { TaskProcsRead, killSnapshot, killSummary, readTaskProcs } from './taskProcs';
import type { ProcSnap } from './proc';
import { spawn } from 'child_process';
import { estimateUsd } from './usdEstimate';
import { BROWSER_SERVER, BROWSER_TOOL_PREFIX, BrowserStatus, browserActionWrites, browserUnreachable, describeBrowserAction, isBrowserTool } from './browser';
import { Attachment, AgentInfo, AgentStatus, HistoryItem, HostMessage, ModelOption, PermissionDecision, SlashCommandOption, UsageInfo, UsageWindow } from './protocol';

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
  /** Variáveis somadas ao ambiente do processo, calculadas a cada início (limite de threads quando há agentes em paralelo). */
  env?: () => Record<string, string>;
  /**
   * Só os servidores MCP passados aqui e os do `.mcp.json` do projeto já aprovados; nada dos servidores de
   * usuário nem dos conectores do claude.ai. Um agente roteado com tudo carregado gasta milhares de tokens em
   * schema e sobe dezenas de processos.
   */
  strictMcp?: boolean;
}

/** Tarefa em segundo plano da sessão começou ou terminou; `open` é quantas continuam abertas. */
export interface BackgroundTaskEvent {
  kind: 'started' | 'ended';
  taskId: string;
  description: string;
  /** Só no fim: como terminou e onde está a saída. */
  status?: 'completed' | 'failed' | 'stopped';
  summary?: string;
  outputFile?: string;
  open: number;
}

/** O que o fim do turno conta ao dono da sessão. */
export interface TurnEndInfo {
  contextTokens: number;
  isError: boolean;
  queued: number;
  durationMs: number;
  /** O turno morreu por limite de uso do fornecedor (429 ou janela da assinatura). `until` em ISO quando o CLI informou. */
  limit?: { until?: string; text: string };
  /** O CLI abriu este turno sozinho (aviso de tarefa em segundo plano que terminou), sem mensagem nossa. */
  auto?: boolean;
}

/** Última lista de modelos que um processo do Claude Code informou (supportedModels). Vale para qualquer sessão da janela. */
let lastKnownModels: ModelOption[] = [];

export function knownClaudeModels(): ModelOption[] {
  return lastKnownModels;
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
  onTurnEnd?: (info: TurnEndInfo) => void;
  onBusyChange?: (busy: boolean) => void;
  /**
   * Tarefas em segundo plano abertas neste processo (Bash run_in_background, subagente em background), por task_id.
   * Zera a cada processo novo: o CLI não reenvia o conjunto ao subir.
   */
  readonly backgroundTasks = new Map<string, { description: string; type?: string }>();
  onBackgroundTask?: (ev: BackgroundTaskEvent) => void;
  /** Modelos que este processo aceita (supportedModels), para o seletor e para o list_models dos agentes. */
  models: ModelOption[] = [];
  /** Consumo para o orçamento: tokens de cada mensagem do modelo (repetida por bloco, daí o id) e custo acumulado no fim do turno. */
  onUsage?: (u: { messageId?: string; tokens?: number; costUsdTotal?: number; usdEstimate?: number; processStart?: boolean }) => void;
  /** Navegador desta sessão; muda ao subir o processo e quando uma chamada mostra que o Chrome sumiu. */
  browser: BrowserStatus = { enabled: false, status: 'off', tools: [] };
  onBrowserChange?: (status: BrowserStatus) => void;
  chrome: boolean;
  /**
   * Tarefas de shell podem ter deixado processos vivos: sessão retomada com tarefas marcadas como paradas pelo CLI,
   * processo do CLI trocado com shell rodando, ou shell encerrada por tempo limite. O painel oferece a lista de órfãos.
   */
  onOrphanHint?: (text: string) => void;

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
  /** Limite de uso visto neste turno (rate_limit_event rejeitado ou erro da API); vai no fim do turno. */
  private limitHit?: { until?: string; text: string };
  /** O turno em andamento foi aberto pelo CLI sozinho (aviso de tarefa em segundo plano), não por send(). */
  private autoTurn = false;
  /** Já veio um init neste processo. O primeiro acompanha a primeira mensagem; os seguintes abrem turno. */
  private initSeen = false;
  /** Último bloco de texto não vazio do turno, mesmo antes de uma ferramenta: vale quando o relatório foi seguido de brain_fact ou report_progress. */
  private turnLastText = '';
  /** Processo do CLI: sobe a cada start(). Item cujo último sinal de vida é de um processo anterior morreu com ele. */
  private epoch = 0;
  /** Sinais de vida de cada item de tarefa, pelo id do item (tool_use_id). */
  private readonly taskLife = new Map<string, TaskLife>();
  /** Último background_tasks_changed deste processo. */
  private level?: { ids: Set<string>; at: number };
  private levelTimer?: ReturnType<typeof setTimeout>;
  /** Comando de cada chamada de Bash, pelo tool_use_id: vira o `command` da tarefa de shell e acha o PID dela. */
  private readonly bashCommands = new Map<string, string>();
  /** Tarefas que o usuário mandou parar: o fim delas não sugere órfãos. */
  private readonly stoppingByUser = new Set<string>();
  /** PID do processo do CLI desta sessão (capturado no spawn): a raiz de uma tarefa de shell só é procurada abaixo dele. */
  private cliPid?: number;
  /** Fim do stderr do CLI, para explicar uma queda (o spawn próprio não entrega ao SDK o texto que ele juntaria). */
  private stderrTail = '';
  /** Foto da raiz de cada tarefa de shell (PID, nome, início), tirada na primeira leitura com a tarefa rodando. */
  private readonly taskRoots = new Map<string, ProcSnap>();
  /** Leitura de processos em andamento por tarefa: um segundo pedido reaproveita a mesma. */
  private readonly procReads = new Map<string, Promise<TaskProcsRead | undefined>>();
  /** Itens dados por concluídos pela regra do nível, sem aviso do CLI: um sinal de vida os traz de volta. */
  private readonly inferredDone = new Set<string>();
  private hintLines: string[] = [];
  private hintTimer?: ReturnType<typeof setTimeout>;

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
    this.onUsage?.({ processStart: true });
    this.restartWhenIdle = false;
    this.toolsRunning.clear();
    // Processo novo: o CLI não reenvia o conjunto de tarefas em segundo plano, e as antigas morreram com ele.
    this.backgroundTasks.clear();
    // Os itens de tarefa do processo anterior deixam de contar como trabalhando; o CLI novo os reconfirma se estiverem vivos.
    this.epoch++;
    this.level = undefined;
    this.reconcileTasks();
    this.initSeen = false;
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
        env: { ...profileEnv(this.profile), ...(this.options.env?.() ?? {}) },
        resume: resumeId,
        model: this.model || undefined,
        effort: (this.effort || undefined) as Effort | undefined,
        permissionMode: this.permissionMode,
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        forwardSubagentText: true,
        agentProgressSummaries: true,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: this.options.systemAppend?.() },
        mcpServers: this.options.strictMcp ? { ...approvedProjectMcp(this.cwd), ...this.options.mcpServers?.() } : this.options.mcpServers?.(),
        strictMcpConfig: this.options.strictMcp || undefined,
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
        // Mesmo spawn do SDK (pipes, windowsHide, signal), só para saber o PID do CLI: a raiz das tarefas de shell é
        // procurada entre os descendentes dele, nunca entre os de outros chats e agentes da janela.
        spawnClaudeCodeProcess: (o) => {
          const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, signal: o.signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
          if (this.prompts === prompts) {
            this.cliPid = child.pid;
            this.stderrTail = '';
          }
          child.stderr.setEncoding('utf8');
          child.stderr.on('data', (data: string) => {
            if (this.prompts === prompts) {
              this.stderrTail = (this.stderrTail + data).slice(-2000);
            }
            console.error(`[claude ${this.profile.name}] ${data}`);
          });
          child.stderr.on('error', () => undefined);
          return child;
        },
      },
    });
    this.q = q;
    void this.consume(q);
    void this.readBrowserStatus(q);
    q.supportedModels()
      .then((list) => {
        this.models = list.map((m) => ({
          value: m.value,
          resolvedModel: m.resolvedModel,
          displayName: m.displayName,
          description: m.description,
        }));
        if (this.models.length) {
          lastKnownModels = this.models;
        }
        this.post({ type: 'models', list: this.models });
      })
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
    // Mensagem que chega com o turno em andamento vira turno enfileirado no CLI: o estado do atual fica como está.
    if (!this.busy) {
      this.turnTexts = [];
      this.turnLastText = '';
      this.autoTurn = false;
      this.limitHit = undefined;
    }
    this.setBusy(true);
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
    if (this.deferRestart()) {
      this.post({ type: 'notice', level: 'info', text: this.busy ? 'O novo nível de raciocínio vale a partir da próxima mensagem.' : 'O novo nível de raciocínio vale quando as tarefas em segundo plano acabarem (reiniciar agora as encerraria).' });
    }
  }

  /**
   * Reinício pedido (raciocínio, navegador, MCP). Com turno em andamento ou tarefa em segundo plano aberta, fica para
   * depois: trocar o processo agora encerraria as tarefas, e os processos delas ficariam soltos. Devolve true se adiou.
   */
  private deferRestart(): boolean {
    if (this.busy || this.backgroundTasks.size) {
      this.restartWhenIdle = true;
      return true;
    }
    this.start(this.sessionId);
    return false;
  }

  /** Reinício adiado: sai quando não há turno nem tarefa em segundo plano. */
  private restartIfIdle(): void {
    if (this.restartWhenIdle && !this.busy && !this.backgroundTasks.size && !this.disposed && this.q) {
      this.start(this.sessionId);
    }
  }

  /** Servidores MCP do projeto aprovados agora: só entram ao subir o processo, então reinicia e retoma. */
  reloadProjectMcp(): void {
    if (!this.q) {
      return;
    }
    this.deferRestart();
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
    if (this.deferRestart() && !quiet) {
      this.post({ type: 'notice', level: 'info', text: this.busy ? `O navegador ${on ? 'liga' : 'desliga'} a partir da próxima mensagem.` : `O navegador ${on ? 'liga' : 'desliga'} quando as tarefas em segundo plano acabarem.` });
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
    const taskId = record.info.taskId;
    // O SDK mata só a raiz da tarefa de shell; os filhos (npm → cmd → node --watch) ficariam soltos. A foto vem antes do
    // stopTask porque depois dele os filhos perdem o pai e não dá mais para achá-los pela árvore.
    const shell = record.info.taskType === 'local_bash';
    const stamps = shell ? ((await this.taskProcs(id).catch(() => undefined))?.snap ?? []) : [];
    this.stoppingByUser.add(taskId);
    try {
      if (!this.q) {
        throw new Error('No task found: o processo do Claude Code não está de pé');
      }
      await this.q.stopTask(taskId);
    } catch (err) {
      const text = errorText(err);
      if (/no task found/i.test(text)) {
        // O CLI já não conhece a tarefa (processo trocado, sessão retomada): o item sai de "trabalhando".
        this.markTask(id, 'lost', 'o Claude Code não conhece mais esta tarefa');
      } else {
        this.post({ type: 'notice', level: 'error', text: `Não consegui parar o agente: ${text}` });
      }
    }
    if (stamps.length) {
      const r = await killSnapshot(stamps);
      if (r.killed.length || r.failed.length || r.refused || r.skipped?.length) {
        this.post({ type: 'notice', level: r.failed.length || r.refused ? 'error' : 'info', text: `Árvore da tarefa "${record.info.description}": ${killSummary(r)}.` });
      }
    }
  }

  /**
   * Árvore de processos de uma tarefa de shell. Com foto da raiz, só ela vale; sem foto, busca apenas com a tarefa
   * rodando e o CLI desta sessão de pé, e grava a foto do que achar. Pedido repetido reaproveita a leitura em andamento.
   */
  taskProcs(id: string): Promise<TaskProcsRead | undefined> {
    const running = this.procReads.get(id);
    if (running) {
      return running;
    }
    const record = this.agents.get(id);
    if (record?.info.taskType !== 'local_bash') {
      return Promise.resolve(undefined);
    }
    const search = record.info.status === 'running' && !!this.q && this.cliPid !== undefined;
    const read = readTaskProcs(record.info, { root: this.taskRoots.get(id), cliPid: this.cliPid, search })
      .then((r) => {
        if (r.root && !this.taskRoots.has(id)) {
          this.taskRoots.set(id, r.root);
        }
        return r;
      })
      .finally(() => this.procReads.delete(id));
    this.procReads.set(id, read);
    return read;
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
    clearTimeout(this.levelTimer);
    clearTimeout(this.hintTimer);
    this.stop();
  }

  private stop(): void {
    this.denyAllPending('Sessão encerrada.');
    this.prompts?.close();
    this.q?.close();
    this.q = undefined;
    this.prompts = undefined;
    // Reinício com turno aberto (raro) ou com tarefas no fundo: nada fica pendurado esperando um result que não vem.
    this.dropBackgroundTasks('stopped');
    this.endDeadTurn();
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
    this.taskLife.set(id, { epoch: this.epoch, lastLifeAt: Date.now(), backgrounded: false });
    this.post({ type: 'agent', agent: info });
  }

  /** O CLI falou da tarefa: ela está viva neste processo. Item que tinha sido dado por perdido volta a trabalhar. */
  private touchTask(id: string, backgrounded?: boolean): void {
    const life = this.taskLife.get(id);
    if (life) {
      life.epoch = this.epoch;
      life.lastLifeAt = Date.now();
      life.backgrounded ||= !!backgrounded;
    }
    const record = this.agents.get(id);
    if (record?.info.status === 'lost' || (record?.info.status === 'completed' && this.inferredDone.has(id))) {
      this.inferredDone.delete(id);
      this.updateAgent(id, { status: 'running' });
    }
  }

  /** Tira o item de "trabalhando" sem o aviso de fim do CLI, e a tarefa do conjunto das abertas. */
  private markTask(id: string, status: 'lost' | 'completed', reason: string): void {
    const record = this.agents.get(id);
    if (!record || record.info.status !== 'running') {
      return;
    }
    this.updateAgent(id, { status, summary: record.info.summary || reason });
    if (status === 'completed') {
      this.inferredDone.add(id);
    }
    if (record.info.taskId) {
      this.untrackBackground(record.info.taskId, { status: status === 'lost' ? 'stopped' : 'completed', summary: reason });
    }
    if (status === 'lost' && record.info.taskType === 'local_bash') {
      this.queueOrphanHint(`A tarefa de shell "${record.info.description}" encerrou com a sessão anterior do Claude Code; os processos dela podem continuar vivos.`);
    }
  }

  /** O processo do CLI morreu ou foi trocado: tudo que rodava nele encerrou junto. */
  private loseRunningTasks(reason: string): void {
    for (const [id, record] of this.agents) {
      if (record.info.status === 'running') {
        this.markTask(id, 'lost', reason);
      }
    }
  }

  /**
   * Confere os itens "trabalhando" contra o que se sabe do CLI (processo em que falaram por último e o último nível de
   * tarefas em segundo plano). Chamada ao trocar de processo, ao abrir o painel e de tempos em tempos. Devolve quantos mudaram.
   */
  reconcileTasks(): number {
    const items = [...this.agents.values()].map((r) => ({ id: r.info.id, taskId: r.info.taskId, status: r.info.status, life: this.taskLife.get(r.info.id) }));
    const verdicts = reconcileTasks(items, { epoch: this.epoch, now: Date.now(), level: this.level });
    for (const v of verdicts) {
      this.markTask(v.id, v.status, v.reason);
    }
    return verdicts.length;
  }

  /** Há item de tarefa contando como trabalhando (o painel só agenda a reconciliação periódica nesse caso). */
  get hasRunningTasks(): boolean {
    return [...this.agents.values()].some((r) => r.info.status === 'running');
  }

  /** Junta os motivos de uma rajada (três tarefas perdidas de uma vez) num aviso só. */
  private queueOrphanHint(line: string): void {
    if (!this.hintLines.includes(line)) {
      this.hintLines.push(line);
    }
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => {
      const lines = this.hintLines.splice(0);
      if (lines.length && !this.disposed) {
        this.onOrphanHint?.(lines.length === 1 ? lines[0] : `${lines[0]} (e mais ${lines.length - 1} ${lines.length === 2 ? 'aviso' : 'avisos'})`);
      }
    }, 1500);
  }

  /** Aviso do CLI ao retomar: "N background ... tasks didn't finish before the previous session ended ... marked stopped". */
  private noteOrphanNotice(text: string): void {
    const ids = new Set(orphanNoticeIds(text));
    let shells = 0;
    for (const [id, record] of this.agents) {
      if (record.info.taskId && ids.has(record.info.taskId)) {
        if (record.info.taskType === 'local_bash') {
          shells++;
        }
        this.markTask(id, 'lost', 'encerrada com a sessão anterior do Claude Code');
      }
    }
    // Ids que este painel nem chegou a ver (sessão aberta do disco): os processos deles podem estar vivos do mesmo jeito.
    if (/shell/i.test(text) || shells) {
      this.queueOrphanHint(`O Claude Code marcou como paradas ${ids.size || 'algumas'} tarefas de shell da sessão anterior; os processos delas podem continuar vivos.`);
    }
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
        const tail = this.stderrTail.trim().split('\n').slice(-3).join(' ').slice(-400);
        this.post({ type: 'notice', level: 'error', text: `O processo do Claude parou: ${errorText(err)}${tail && !errorText(err).includes(tail) ? ` (${tail})` : ''}` });
      }
    } finally {
      if (q === this.q) {
        this.q = undefined;
        this.prompts = undefined;
        // O processo morreu: as tarefas em segundo plano morreram com ele, e o turno em andamento acabou em erro.
        // Sem isto o agente ficava "rodando" e quem esperava por ele, aguardando para sempre.
        this.dropBackgroundTasks('failed');
        this.loseRunningTasks('o processo do Claude Code parou');
        this.endDeadTurn();
        this.setBusy(false);
        this.post({ type: 'thinking', value: false });
      }
    }
  }

  /** Turno que estava em andamento quando o processo caiu ou foi trocado: conta como terminado em erro. */
  private endDeadTurn(): void {
    if (!this.busy || this.disposed) {
      return;
    }
    this.lastTurnText = this.turnTexts.join('\n\n') || this.turnLastText;
    this.turnTexts = [];
    this.turnLastText = '';
    this.autoTurn = false;
    this.limitHit = undefined;
    this.onTurnEnd?.({ contextTokens: this.contextTokens, isError: true, queued: 0, durationMs: 0 });
  }

  /** Encerra o registro de todas as tarefas em segundo plano (processo morto ou trocado), avisando o dono da sessão. */
  private dropBackgroundTasks(status: 'failed' | 'stopped'): void {
    for (const id of [...this.backgroundTasks.keys()]) {
      this.untrackBackground(id, { status, summary: status === 'failed' ? 'o processo do Claude caiu' : 'sessão reiniciada' });
    }
  }

  /** Pede ao CLI para matar as tarefas em segundo plano desta sessão (Parar num agente que aguarda processo). */
  async stopBackgroundTasks(): Promise<void> {
    for (const id of [...this.backgroundTasks.keys()]) {
      try {
        await this.q?.stopTask(id);
      } catch {
        // Tarefa já encerrada ou CLI antigo: o registro sai do mesmo jeito.
      }
      this.untrackBackground(id, { status: 'stopped', summary: 'parada pelo usuário' });
    }
  }

  /**
   * O CLI abre um turno sozinho quando uma tarefa em segundo plano termina (o modelo recebe o aviso e responde).
   * Sem send() ninguém marcou a sessão como ocupada: marca aqui, senão o fim desse turno passa despercebido.
   */
  private noteAutoTurn(): void {
    if (this.busy || !this.q) {
      return;
    }
    this.autoTurn = true;
    this.limitHit = undefined;
    this.turnTexts = [];
    this.turnLastText = '';
    this.setBusy(true);
  }

  private handle(m: SDKMessage, stream: { msgId: string; blockTypes: Map<number, string> }): void {
    switch (m.type) {
      case 'system':
        this.handleSystem(m);
        return;

      case 'rate_limit_event':
        // Limite da assinatura: o CLI avisa antes de o turno morrer. Guardado para o fim do turno explicar a falha.
        if (m.rate_limit_info?.status === 'rejected') {
          const at = m.rate_limit_info.resetsAt;
          const until = typeof at === 'number' ? new Date(at < 1e12 ? at * 1000 : at).toISOString() : undefined;
          this.limitHit = { until, text: `limite de uso da assinatura${m.rate_limit_info.rateLimitType ? ` (${m.rate_limit_info.rateLimitType})` : ''}` };
        }
        return;

      case 'stream_event': {
        if (m.parent_tool_use_id) {
          return;
        }
        const ev = m.event;
        if (ev.type === 'message_start') {
          this.noteAutoTurn();
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
          this.onUsage({ messageId: m.message.id, tokens, usdEstimate: estimateUsd(used, m.message.model || this.model) });
        }
        for (const block of content) {
          if (block.type === 'tool_use' && AGENT_TOOLS.has(block.name)) {
            this.registerAgent(block.id, block.input as Record<string, unknown>);
          }
          if (block.type === 'tool_use' && isBrowserTool(block.name)) {
            this.browserCalls.add(block.id);
          }
          if (block.type === 'tool_use' && block.name === 'Bash') {
            const command = (block.input as { command?: unknown }).command;
            if (typeof command === 'string') {
              this.bashCommands.set(block.id, command);
            }
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
        this.noteAutoTurn();
        for (const block of content) {
          if (block.type === 'text') {
            this.turnTexts.push(block.text);
            if (block.text.trim()) {
              this.turnLastText = block.text;
            }
            this.post({ type: 'assistantText', msgId: m.message.id, text: block.text });
          } else if (block.type === 'tool_use') {
            // Texto antes de uma ferramenta é narração ("Vou ler o arquivo"): o relatório é só o que vem depois da última.
            this.turnTexts = [];
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
          if (m.error === 'rate_limit') {
            this.limitHit ??= { text: 'a API respondeu 429 (limite de requisições ou de uso)' };
          }
          this.post({ type: 'notice', level: 'error', text: `Erro da API: ${m.error}` });
        }
        return;
      }

      case 'user': {
        const plain = typeof m.message.content === 'string' ? m.message.content : m.message.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        if (!m.parent_tool_use_id && isOrphanNotice(plain)) {
          this.noteOrphanNotice(plain);
        }
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
        this.taskLife.clear();
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
        // Relatório seguido de uma ferramenta (brain_fact, report_progress) não pode virar texto vazio: vale o último bloco.
        this.lastTurnText = this.turnTexts.join('\n\n') || this.turnLastText;
        // Zera aqui também: mensagem que chegou no meio do turno abre o próximo sem passar pelo send().
        this.turnTexts = [];
        this.turnLastText = '';
        // Limite só por sinal da API (rate_limit_event, erro rate_limit) ou pelo texto de erro do próprio result;
        // nunca pelo que o modelo escreveu, senão quem depura um 429 vira "limite de uso".
        const errorText = m.subtype === 'success' ? '' : (m.errors ?? []).join(' ');
        const limit = m.is_error ? (this.limitHit ?? limitFromText(errorText)) : undefined;
        const auto = this.autoTurn;
        this.autoTurn = false;
        this.limitHit = undefined;
        this.onUsage?.({ costUsdTotal: m.total_cost_usd });
        this.onTurnEnd?.({
          contextTokens: this.contextTokens,
          isError: m.is_error,
          queued: m.queued_turn_count ?? 0,
          durationMs: m.duration_ms,
          limit,
          auto,
        });
        if (!m.queued_turn_count) {
          this.setBusy(false);
          this.restartIfIdle();
        }
        return;
      }
    }
  }

  private handleSystem(m: Extract<SDKMessage, { type: 'system' }>): void {
    switch (m.subtype) {
      case 'init':
        // O init vem no começo de cada turno, inclusive nos que o CLI abre sozinho. O primeiro do processo não conta:
        // um CLI que o emita ao subir deixaria a sessão "ocupada" sem turno nenhum.
        if (this.initSeen) {
          this.noteAutoTurn();
        }
        this.initSeen = true;
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
        this.reconcileTasks();
        return;
      case 'api_retry':
        this.post({ type: 'notice', level: 'info', text: 'A API falhou, tentando de novo...' });
        return;
      case 'task_started':
        if (m.is_backgrounded && !m.ambient && !m.skip_transcript) {
          this.trackBackground(m.task_id, m.description, m.task_type);
        }
        if (m.tool_use_id) {
          const shell = m.task_type === 'local_bash';
          this.updateAgent(m.tool_use_id, {
            taskId: m.task_id,
            description: m.description,
            subagentType: m.subagent_type,
            prompt: m.prompt,
            status: 'running',
            taskType: m.task_type,
            command: shell ? this.bashCommands.get(m.tool_use_id) : undefined,
            startedAt: new Date().toISOString(),
          });
          this.touchTask(m.tool_use_id, m.is_backgrounded);
          if (shell && m.is_backgrounded) {
            // Foto da raiz enquanto a tarefa roda e o CLI desta sessão está de pé: é o que permite encerrar os processos
            // dela depois que ela se perder (sessão retomada), sem confundir com outra tarefa de mesmo comando.
            const toolUseId = m.tool_use_id;
            setTimeout(() => void this.taskProcs(toolUseId).catch(() => undefined), 2500);
          }
        }
        return;
      case 'background_tasks_changed': {
        // Sinal de nível: substitui o conjunto. Cobre bookend perdido (task_started sem task_notification).
        const live = new Set(m.tasks.filter((t) => !t.ambient).map((t) => t.task_id));
        this.level = { ids: new Set(m.tasks.map((t) => t.task_id)), at: Date.now() };
        for (const id of this.level.ids) {
          const agentId = this.agentIdByTask(id);
          if (agentId) {
            this.touchTask(agentId, true);
          }
        }
        // O fim costuma vir logo atrás, no task_notification, com o status certo; a reconciliação espera a carência.
        clearTimeout(this.levelTimer);
        this.levelTimer = setTimeout(() => this.reconcileTasks(), LEVEL_GRACE_MS + 200);
        for (const id of [...this.backgroundTasks.keys()]) {
          if (!live.has(id)) {
            this.untrackBackground(id, { status: 'completed' });
          }
        }
        for (const t of m.tasks) {
          if (!t.ambient) {
            this.trackBackground(t.task_id, t.description, t.task_type);
          }
        }
        return;
      }
      case 'task_progress':
        if (m.tool_use_id) {
          this.touchTask(m.tool_use_id);
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
        // Tarefa que estava em primeiro plano e foi para o fundo (Ctrl+B do CLI) passa a contar.
        if (m.patch.is_backgrounded) {
          this.trackBackground(m.task_id, m.patch.description ?? this.backgroundTasks.get(m.task_id)?.description ?? 'tarefa em segundo plano');
        }
        if (m.patch.status === 'completed' || m.patch.status === 'failed' || m.patch.status === 'killed') {
          this.untrackBackground(m.task_id, { status: m.patch.status === 'killed' ? 'stopped' : m.patch.status, summary: m.patch.error });
        }
        const id = this.agentIdByTask(m.task_id);
        if (id) {
          this.touchTask(id, m.patch.is_backgrounded);
        }
        if (id && m.patch.status) {
          this.updateAgent(id, { status: mapTaskStatus(m.patch.status), summary: m.patch.error });
        }
        return;
      }
      case 'task_notification': {
        this.untrackBackground(m.task_id, { status: m.status, summary: m.summary, outputFile: m.output_file });
        const id = m.tool_use_id ?? this.agentIdByTask(m.task_id);
        const byUser = this.stoppingByUser.delete(m.task_id);
        if (id) {
          // Fim dito pelo CLI: vale mais que o concluído inferido pelo nível.
          this.inferredDone.delete(id);
        }
        if (m.reason === 'worker_restart' || isOrphanNotice(m.summary)) {
          // Tarefa que o processo anterior do CLI deixou sem fim. Item que este painel não conhece não vira nó novo.
          const known = id && this.agents.has(id) ? id : undefined;
          if (known) {
            this.updateAgent(known, { status: 'lost', summary: 'encerrada com a sessão anterior do Claude Code' });
          }
          if (!known || this.agents.get(known)?.info.taskType === 'local_bash') {
            this.queueOrphanHint('O Claude Code marcou como paradas tarefas da sessão anterior; se eram servidores ou watchers, os processos deles podem continuar vivos.');
          }
          return;
        }
        if (id && m.status === 'stopped' && !byUser && this.agents.get(id)?.info.taskType === 'local_bash') {
          // Encerrada pelo CLI (tempo limite, falta de memória): ele mata só a raiz.
          this.queueOrphanHint(`A tarefa de shell "${this.agents.get(id)!.info.description}" foi encerrada pelo Claude Code; filhos dela podem ter sobrevivido.`);
        }
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

  private trackBackground(taskId: string, description: string, type?: string): void {
    if (this.backgroundTasks.has(taskId)) {
      return;
    }
    this.backgroundTasks.set(taskId, { description, type });
    this.onBackgroundTask?.({ kind: 'started', taskId, description, open: this.backgroundTasks.size });
  }

  private untrackBackground(taskId: string, end: { status: 'completed' | 'failed' | 'stopped'; summary?: string; outputFile?: string }): void {
    const task = this.backgroundTasks.get(taskId);
    if (!task) {
      return;
    }
    this.backgroundTasks.delete(taskId);
    this.onBackgroundTask?.({ kind: 'ended', taskId, description: task.description, ...end, open: this.backgroundTasks.size });
    if (!this.backgroundTasks.size && this.restartWhenIdle) {
      // O CLI costuma abrir um turno sozinho para contar o fim da tarefa: espera um pouco antes de trocar o processo.
      setTimeout(() => this.restartIfIdle(), 3000);
    }
  }
}

/** Servidores do `.mcp.json` do projeto que o usuário aprovou, no formato do SDK, para uma sessão com strictMcp. */
function approvedProjectMcp(cwd: string): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const s of readProjectMcp(cwd).servers) {
    if (decisionFor(s) === 'allow' && s.entry && typeof s.entry === 'object') {
      out[s.name] = s.entry as McpServerConfig;
    }
  }
  return out;
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
