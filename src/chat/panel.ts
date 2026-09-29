import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { randomBytes, randomUUID } from 'crypto';
import type { PermissionMode, SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { getSessionInfo, getSessionMessages, listSessions } from '@anthropic-ai/claude-agent-sdk';
import { Profile, ProfileStore, configDirEnv, isCodex } from '../profiles';
import { AgentRecord, ChatSession, profileEnv, toolResultImages, toolResultText } from './session';
import { CodexSession, codexModelOptions, knownCodexModels, prefetchCodexModels } from './codexSession';
import { AgentHub, AnySession, MAIN_ID, browserApproval } from './hub';
import type { LabReports } from './lab/reportHost';
import { AgentStore } from './agentStore';
import { FileIndex, editorFiles } from './fileIndex';
import { Attachment, AgentInfo, COMPANION_MARK, ConnectedBrowser, HistoryItem, HostMessage, ProfileOption, WebviewMessage } from './protocol';
import { ExternalProviders } from './external';
import { probeBrowsers } from './browserProbe';
import { resolveClaudeExecutable } from '../claudePath';
import { CompanionLink, CompanionPanel } from './companion/panel';
import type { CompanionAgent, CompanionSource, MainMessage } from './companion/types';

export const CHAT_VIEW_TYPE = 'agentGraphMaster.chat';

/** Extensões que viram bloco de imagem; o resto vai como menção de caminho. */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Acima disso a imagem não vai: o base64 estoura o limite de uma mensagem. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface ChatEnv {
  context: vscode.ExtensionContext;
  store: ProfileStore;
  /** Contas cadastradas com o e-mail logado, para os seletores de conta. */
  profileOptions: () => ProfileOption[];
  /** Último editor de texto focado; o webview tira o foco do editor, então guardamos por fora. */
  lastEditor: () => vscode.TextEditor | undefined;
}

interface ForkLink {
  parent: ChatPanel;
  forkId: string;
  description: string;
}

export interface ChatOptions {
  resumeId?: string;
  model?: string;
  effort?: string;
  fork?: ForkLink;
  /** Primeira mensagem enviada assim que o chat abre. `display` é o que aparece na tela, `prompt` é o que vai para o Claude. */
  seed?: { display: string; prompt: string };
}

interface PanelState {
  profileId: string;
  sessionId?: string;
}

export class ChatPanel {
  private static readonly all = new Set<ChatPanel>();

  /** Claude ou Codex, conforme o fornecedor da conta. As duas têm a mesma superfície. */
  readonly session: AnySession;
  private readonly hub: AgentHub;
  private ready = false;
  private usageTimer?: ReturnType<typeof setInterval>;
  private usageInFlight = false;
  private outbox: HostMessage[] = [];
  private readonly forks = new Map<string, AgentInfo>();
  /** Nome da sessão: o /rename ou o título que o Claude Code gera. Vazio até existir. */
  private sessionTitle = '';
  /** Leituras de título em voo; só a última vale. */
  private titleSeq = 0;
  private companionLink?: CompanionLink;
  private readonly files: FileIndex;
  /** Navegadores conectados à conta, lidos da ponte do Claude in Chrome. Relidos ao ligar e no clique do indicador. */
  private browsers?: { list?: ConnectedBrowser[]; error?: string; at: number };
  private probing = false;

  static open(env: ChatEnv, profile: Profile, options: ChatOptions = {}): ChatPanel {
    const panel = vscode.window.createWebviewPanel(
      CHAT_VIEW_TYPE,
      '',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      ChatPanel.webviewOptions(env.context),
    );
    return new ChatPanel(env, panel, profile, options);
  }

  /** Recria a aba depois de recarregar a janela, retomando a conversa salva. */
  static revive(env: ChatEnv, panel: vscode.WebviewPanel, state: PanelState | undefined): void {
    const profile = (state && env.store.get(state.profileId)) ?? env.store.active();
    panel.webview.options = ChatPanel.webviewOptions(env.context);
    new ChatPanel(env, panel, profile, { resumeId: state?.sessionId });
  }

  /** Grava já os agentes que o debounce ainda segura, em todos os painéis. O deactivate chama antes do reload. */
  static flushAll(): void {
    for (const panel of ChatPanel.all) {
      panel.hub.flush();
    }
  }

  static {
    CompanionPanel.setup({
      findLink: (mainSessionId) => [...ChatPanel.all].find((p) => p.session.sessionId === mainSessionId)?.link(),
      loadHistory: async (profile, cwd, sessionId) => toHistory(await withConfigDir(profile, () => getSessionMessages(sessionId, { dir: cwd }))),
    });
  }

  static disposeAll(): void {
    for (const panel of ChatPanel.all) {
      panel.panel.dispose();
    }
  }

  /** Relatório de experimento do chat ativo (ou do último aberto), com a conversa dele como escopo possível. */
  static labReports(): LabReports | undefined {
    const list = [...ChatPanel.all];
    return (list.find((p) => p.panel.active) ?? list.at(-1))?.hub.labReports;
  }

  private static webviewOptions(context: vscode.ExtensionContext): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return {
      enableScripts: true,
      retainContextWhenHidden: true,
      // O diretório de trabalho entra para as miniaturas das imagens geradas (generate_image salva dentro dele).
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out'), vscode.Uri.joinPath(context.extensionUri, 'media'), vscode.Uri.file(workspaceCwd())],
    };
  }

  private constructor(
    private readonly env: ChatEnv,
    private readonly panel: vscode.WebviewPanel,
    readonly profile: Profile,
    private readonly options: ChatOptions,
  ) {
    ChatPanel.all.add(this);
    const cwd = workspaceCwd();
    this.hub = new AgentHub({
      profile,
      cwd,
      main: () => this.session,
      profiles: () => env.store.all(),
      post: (msg) => this.post(msg),
      permissionMode: () => this.session.permissionMode,
      store: new AgentStore(env.context.workspaceState),
      browserChanged: () => this.postBrowser(),
    });
    // O interruptor começa como a configuração manda, se o navegador estiver livre (outra aba pode estar com ele).
    const chromeAtStart =
      !isCodex(profile) && !options.fork && vscode.workspace.getConfiguration('agentGraphMaster').get<boolean>('claudeInChrome', false) && this.hub.claimBrowser(MAIN_ID) === true;
    // Chat com conta Codex não recebe as ferramentas de agentes: elas são um servidor MCP dentro do processo da
    // extensão, que só o SDK do Claude alcança. Quem orquestra é sempre um chat Claude.
    this.session = isCodex(profile)
      ? new CodexSession(profile, cwd, (msg) => this.post(msg), { model: options.model, effort: options.effort })
      : new ChatSession(profile, cwd, (msg) => this.post(msg), {
          model: options.model,
          effort: options.effort,
          mcpServers: this.hub.mcpServersFor(MAIN_ID),
          systemAppend: () => this.hub.systemAppendFor(MAIN_ID),
          chrome: chromeAtStart,
          browserApproval,
        });
    if (this.session instanceof ChatSession) {
      this.session.onBrowserChange = () => this.postBrowser();
    }
    this.files = FileIndex.acquire(cwd);
    // Aba restaurada já volta com o título que tinha; o nome da sessão chega logo depois pela leitura abaixo.
    if (!(options.resumeId && panel.title)) {
      this.applyTitle();
    }
    if (options.resumeId) {
      void this.refreshTitle(options.resumeId);
    }
    panel.iconPath = vscode.Uri.joinPath(env.context.extensionUri, 'media', 'icon.svg');
    panel.webview.html = this.html();

    panel.webview.onDidReceiveMessage((msg: WebviewMessage) => void this.onMessage(msg));
    // O menu do "+" só mostra "Mencionar arquivo aberto" quando há um arquivo aberto de fato.
    const editorWatch = [
      vscode.window.onDidChangeActiveTextEditor(() => this.postActiveFile()),
      vscode.workspace.onDidCloseTextDocument?.(() => this.postActiveFile()),
    ];
    panel.onDidDispose(() => {
      ChatPanel.all.delete(this);
      clearInterval(this.usageTimer);
      this.files.release();
      editorWatch.forEach((d) => d?.dispose());
      this.hub.dispose();
      this.session.dispose();
      if (options.fork) {
        options.fork.parent.updateFork(options.fork.forkId, { status: 'stopped' });
      }
    });

    if (options.fork) {
      const { parent, forkId } = options.fork;
      this.session.onBusyChange = (busy) => parent.updateFork(forkId, { status: busy ? 'running' : 'completed' });
      this.session.onTurnEnd = ({ contextTokens, isError }) =>
        parent.updateFork(forkId, { totalTokens: contextTokens, status: isError ? 'failed' : 'completed', model: this.session.model || undefined });
    }
  }

  // ---------- Comunicação com o webview ----------

  private post(msg: HostMessage): void {
    // /rename pelo chat: a aba acompanha o nome novo da conversa.
    const renamed = msg.type === 'commandOutput' && !this.options.fork ? /^Session renamed to: (.+)$/.exec(msg.text) : null;
    if (renamed) {
      this.setSessionTitle(renamed[1]);
    } else if (msg.type === 'result') {
      // Fim de turno: o Claude Code pode ter gerado (ou trocado) o nome da sessão. Uma leitura por turno.
      // Sem nome ainda, tenta de novo daqui a pouco: o título gerado pode ser gravado logo depois do turno.
      void this.refreshTitle().then(() => {
        if (!this.sessionTitle) {
          setTimeout(() => void this.refreshTitle(), 4000);
        }
      });
    }
    if (this.ready) {
      void this.panel.webview.postMessage(msg);
    } else {
      this.outbox.push(msg);
    }
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.onReady();
        return;
      case 'send':
        // Novidades do cérebro guardadas para o orquestrador vão na frente da mensagem (sem abrir turno à parte).
        this.session.send(this.hub.brain.withNews(MAIN_ID, msg.text), msg.attachments);
        return;
      case 'resolveUris':
        await this.resolveUris(msg.uris);
        return;
      case 'interrupt':
        await this.session.interrupt();
        return;
      case 'permission': {
        const { requestId, type: _type, ...answer } = msg;
        if (this.hub.ownsPermission(requestId)) {
          this.hub.respondPermission(requestId, answer);
        } else {
          this.session.respondPermission(requestId, answer);
        }
        return;
      }
      case 'setModel':
        await this.session.setModel(msg.value);
        return;
      case 'setMode':
        await this.session.setMode(msg.value as PermissionMode);
        return;
      case 'setEffort':
        this.session.setEffort(msg.value);
        return;
      case 'newChat':
        // Conversa nova em aba nova, com sessão, hub e agentes próprios. Esta aba fica como está.
        ChatPanel.open(this.env, this.profile);
        return;
      case 'resolveTask':
        this.hub.resolveTask(msg.id, msg.action);
        return;
      case 'resolveGuard':
        await this.hub.resolveGuard(msg.id, msg.action, msg.text);
        return;
      case 'listSessions':
        await this.sendSessionList();
        return;
      case 'resumeSession':
        await this.resume(msg.id);
        return;
      case 'mentionFile':
        this.mentionFile();
        return;
      case 'listCommands':
        this.session.postCommands();
        return;
      case 'listCodexModels': {
        // O catálogo enche na ativação; se ainda estiver vazio, lê agora pela primeira conta Codex (sem gastar token).
        const account = this.env.store.all().find(isCodex);
        if (account && !knownCodexModels().length) {
          await prefetchCodexModels(account, this.session.cwd);
        }
        this.post({ type: 'codexModels', list: codexModelOptions(knownCodexModels()) });
        return;
      }
      case 'searchFiles': {
        const found = await this.files.search(msg.query, editorFiles(this.env.lastEditor()));
        this.post({ type: 'fileResults', requestId: msg.requestId, ...found });
        return;
      }
      case 'stopAgent':
        if (this.hub.has(msg.id)) {
          await this.hub.stop(msg.id);
        } else {
          await this.session.stopAgent(msg.id);
        }
        return;
      case 'agentSend':
        this.hub.sendFromUser(msg.id, msg.text);
        return;
      case 'agentSetModel':
        await this.hub.setModel(msg.id, msg.value);
        return;
      case 'agentSetEffort':
        this.hub.setEffort(msg.id, msg.value);
        return;
      case 'resumeAgent':
        this.hub.resumeAgent(msg.id, msg.text);
        return;
      case 'revealAgent':
        [...ChatPanel.all].find((p) => p.options.fork?.forkId === msg.id)?.panel.reveal();
        return;
      case 'refreshUsage':
        await this.refreshUsage();
        return;
      case 'forkAgent':
        await this.forkAgent(msg);
        return;
      case 'sendToParent':
        this.sendToParent();
        return;
      case 'configureKey':
        await vscode.commands.executeCommand(msg.provider === 'gemini' ? 'agentGraphMaster.setGeminiKey' : 'agentGraphMaster.setOpenAIKey');
        return;
      case 'openFile':
        await this.openProjectFile(msg.path);
        return;
      case 'setChrome':
        this.setChrome(msg.value);
        return;
      case 'refreshBrowsers':
        await this.refreshBrowsers();
        return;
      case 'worktreeAction':
        await this.hub.worktreeAction(msg.id, msg.action);
        return;
      case 'openCompanion':
        this.openCompanion(msg.prefill);
        return;
      case 'labAction':
        this.hub.lab.setPruned(msg.hypothesis_id, msg.kind === 'prune');
        return;
      case 'openBrain':
        await this.openBrain(msg.agentId);
        return;
    }
  }

  /** Abre o index.md do cérebro, ou a nota de um agente, no preview de Markdown (links relativos clicáveis). */
  private async openBrain(agentId?: string): Promise<void> {
    const note = this.hub.brainNote(agentId);
    if (note instanceof Error) {
      this.post({ type: 'notice', level: 'info', text: note.message });
      return;
    }
    await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(note));
  }

  private async onReady(): Promise<void> {
    const firstLoad = !this.ready;
    this.ready = true;
    this.post({
      type: 'init',
      profileId: this.profile.id,
      profileName: this.profile.name,
      account: this.accountLabel(),
      cwd: this.session.cwd,
      permissionMode: this.session.permissionMode,
      model: this.session.model,
      effort: this.session.effort,
      forkOf: this.options.fork?.description,
      sessionTitle: this.sessionTitle,
      provider: isCodex(this.profile) ? 'codex' : 'claude',
      cwdUri: String(this.panel.webview.asWebviewUri(vscode.Uri.file(this.session.cwd))),
      external: {
        research: ExternalProviders.get().defaultProvider('research'),
        image: ExternalProviders.get().defaultProvider('image'),
        imageFolder: ExternalProviders.get().imageFolder(),
      },
    });
    this.post({ type: 'profiles', list: this.env.profileOptions() });
    if (knownCodexModels().length) {
      this.post({ type: 'codexModels', list: codexModelOptions(knownCodexModels()) });
    }
    this.postActiveFile();
    this.postBrowser();
    this.post({ type: 'brain', exists: this.hub.brain.isActive });
    for (const msg of this.outbox.splice(0)) {
      void this.panel.webview.postMessage(msg);
    }
    if (!firstLoad) {
      return;
    }
    if (this.options.resumeId) {
      await this.loadHistory(this.options.resumeId);
    }
    this.session.start(this.options.resumeId);
    this.saveState();
    if (this.options.resumeId) {
      // Conversa retomada: os agentes roteados dela voltam do workspaceState, parados, esperando o usuário retomar.
      this.hub.restore(this.options.resumeId);
    }
    if (this.options.seed) {
      this.post({ type: 'userEcho', text: this.options.seed.display });
      this.session.send(this.options.seed.prompt);
    }
    this.startUsagePolling();
  }

  // ---------- Navegador (Claude in Chrome) ----------

  /** Interruptor do chat principal. Liga só com o navegador livre; reinicia a sessão retomando a conversa. */
  private setChrome(on: boolean): void {
    if (!(this.session instanceof ChatSession)) {
      this.post({ type: 'notice', level: 'error', text: 'O Claude in Chrome só funciona em conversas do Claude.' });
      this.postBrowser();
      return;
    }
    if (on) {
      const claimed = this.hub.claimBrowser(MAIN_ID);
      if (claimed !== true) {
        this.post({ type: 'notice', level: 'error', text: claimed });
        this.postBrowser();
        return;
      }
      this.session.setChrome(true);
      void this.refreshBrowsers();
    } else {
      this.session.setChrome(false);
      this.hub.releaseBrowser(MAIN_ID);
    }
    this.postBrowser();
  }

  private postBrowser(): void {
    if (!(this.session instanceof ChatSession)) {
      return;
    }
    const owner = this.hub.browserOwner();
    // Um agente pegou o navegador e ainda não sabemos quais estão conectados: lê agora, para o tooltip.
    if (owner && owner.id !== 'other' && !this.browsers && !this.probing) {
      void this.refreshBrowsers();
    }
    this.post({
      type: 'browserStatus',
      on: this.session.chrome,
      browser: this.session.browser,
      owner,
      browsers: this.browsers?.list,
      browsersError: this.browsers?.error,
    });
  }

  /** Lê os navegadores conectados direto da ponte do CLI (sem modelo, sem token). */
  private async refreshBrowsers(): Promise<void> {
    if (this.probing || !(this.session instanceof ChatSession)) {
      return;
    }
    this.probing = true;
    try {
      const executable = await resolveClaudeExecutable();
      if (!executable) {
        throw new Error('executável do Claude Code não encontrado');
      }
      this.browsers = { list: await probeBrowsers(executable, profileEnv(this.profile)), at: Date.now() };
    } catch (err) {
      this.browsers = { error: err instanceof Error ? err.message : String(err), at: Date.now() };
    } finally {
      this.probing = false;
    }
    this.postBrowser();
  }

  // ---------- Limites do plano ----------

  private startUsagePolling(): void {
    clearInterval(this.usageTimer);
    const minutes = vscode.workspace.getConfiguration('agentGraphMaster').get<number>('usageRefreshMinutes', 1);
    if (minutes <= 0) {
      return;
    }
    // A primeira leitura espera o processo subir; sem ele a API de uso não responde.
    setTimeout(() => void this.refreshUsage(), 3000);
    this.usageTimer = setInterval(() => void this.refreshUsage(), minutes * 60_000);
  }

  private async refreshUsage(): Promise<void> {
    if (this.usageInFlight) {
      return;
    }
    this.usageInFlight = true;
    try {
      this.post({ type: 'usage', usage: await this.session.readUsage() });
    } finally {
      this.usageInFlight = false;
    }
  }

  private saveState(): void {
    // O webview guarda o estado que o serializer usa ao recarregar a janela.
    this.post({ type: 'session', sessionId: this.session.sessionId ?? '', model: this.session.model, permissionMode: this.session.permissionMode });
  }

  private accountLabel(): string {
    return this.env.profileOptions().find((p) => p.id === this.profile.id)?.account ?? '';
  }

  // ---------- Histórico ----------

  /** Alimenta o dropdown de histórico do webview; a escolha volta em `resumeSession`. */
  private async sendSessionList(): Promise<void> {
    if (this.session instanceof CodexSession) {
      try {
        this.post({ type: 'sessions', list: await this.session.listSessions() });
      } catch (err) {
        this.post({ type: 'sessions', list: [], error: String(err) });
      }
      return;
    }
    try {
      const sessions = await withConfigDir(this.profile, () =>
        listSessions({ dir: this.session.cwd, limit: 40, includeProgrammatic: false }),
      );
      this.post({
        type: 'sessions',
        list: sessions.map((s) => ({
          id: s.sessionId,
          title: shorten(s.customTitle || s.summary || s.firstPrompt || s.sessionId, 80),
          lastModified: s.lastModified,
          current: s.sessionId === this.session.sessionId,
        })),
      });
    } catch (err) {
      this.post({ type: 'sessions', list: [], error: String(err) });
    }
  }

  private async resume(sessionId: string): Promise<void> {
    if (sessionId === this.session.sessionId) {
      return;
    }
    this.post({ type: 'clear' });
    this.session.agents.clear();
    // Trocar de conversa não apaga os agentes da anterior: eles continuam salvos e voltam se ela for reaberta.
    this.hub.detach();
    await this.loadHistory(sessionId);
    this.session.start(sessionId);
    this.saveState();
    this.hub.restore(sessionId);
    this.sessionTitle = '';
    this.applyTitle();
    void this.refreshTitle(sessionId);
  }

  private async loadHistory(sessionId: string): Promise<void> {
    if (this.session instanceof CodexSession) {
      try {
        this.post({ type: 'history', items: await this.session.loadHistory(sessionId), title: '' });
      } catch (err) {
        this.post({ type: 'notice', level: 'error', text: `Não consegui carregar a conversa do Codex: ${String(err)}` });
      }
      return;
    }
    try {
      const messages = await withConfigDir(this.profile, () => getSessionMessages(sessionId, { dir: this.session.cwd }));
      this.post({ type: 'history', items: toHistory(messages), title: '' });
    } catch (err) {
      this.post({ type: 'notice', level: 'error', text: `Não consegui carregar a conversa: ${String(err)}` });
    }
  }

  // ---------- Subagentes ----------

  private async forkAgent(msg: Extract<WebviewMessage, { type: 'forkAgent' }>): Promise<void> {
    const record = this.session.agents.get(msg.id) ?? this.hub.record(msg.id) ?? this.forkRecord(msg.id);
    const target = this.env.store.get(msg.profileId);
    if (!record || !target) {
      return;
    }
    if (msg.stopOriginal) {
      await (this.hub.has(msg.id) ? this.hub.stop(msg.id) : this.session.stopAgent(msg.id));
    }
    const forkId = `fork-${randomUUID()}`;
    const toCodex = isCodex(target);
    // O seletor do diálogo pode trazer um nome do Claude; na conta Codex só vale modelo que o Codex listou.
    const model = toCodex && msg.model && !knownCodexModels().some((m) => m.model === msg.model) ? '' : msg.model;
    const info: AgentInfo = {
      id: forkId,
      kind: 'fork',
      description: `${record.info.description} (continuação)`,
      prompt: record.info.prompt,
      subagentType: record.info.subagentType,
      status: 'running',
      totalTokens: 0,
      durationMs: 0,
      toolUses: 0,
      profileName: target.name,
      model: model || undefined,
      provider: toCodex ? 'codex' : undefined,
      accountId: target.id,
    };
    this.forks.set(forkId, info);
    this.post({ type: 'agent', agent: info });
    const started = Date.now();
    const child = ChatPanel.open(this.env, target, {
      model,
      effort: msg.effort,
      fork: { parent: this, forkId, description: record.info.description },
      seed: { display: msg.text, prompt: buildSeed(record, msg.text) },
    });
    child.session.onTurnEnd = ({ contextTokens, isError }) =>
      this.updateFork(forkId, {
        totalTokens: contextTokens,
        durationMs: Date.now() - started,
        status: isError ? 'failed' : 'completed',
        model: child.session.model || undefined,
      });
  }

  /** Continuar uma continuação: o registro vem do chat filho. */
  private forkRecord(forkId: string): AgentRecord | undefined {
    const info = this.forks.get(forkId);
    if (!info) {
      return undefined;
    }
    const child = [...ChatPanel.all].find((p) => p.options.fork?.forkId === forkId);
    const items: HistoryItem[] = child?.session.lastTurnText ? [{ kind: 'text', text: child.session.lastTurnText }] : [];
    return { info, items };
  }

  updateFork(forkId: string, patch: Partial<AgentInfo>): void {
    const info = this.forks.get(forkId);
    if (!info) {
      return;
    }
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<AgentInfo>;
    const next = { ...info, ...clean };
    this.forks.set(forkId, next);
    this.post({ type: 'agent', agent: next });
  }

  // ---------- Nome da sessão ----------

  private applyTitle(): void {
    const fallback = this.options.fork ? `Continuação · ${this.options.fork.description}` : 'Nova conversa';
    this.panel.title = shorten(this.sessionTitle || fallback, 40);
  }

  private setSessionTitle(raw: string): void {
    const title = raw.replace(/\s+/g, ' ').trim();
    if (!title || title === this.sessionTitle) {
      return;
    }
    this.sessionTitle = title;
    this.applyTitle();
    this.post({ type: 'sessionTitle', title });
    CompanionPanel.retitleAll();
  }

  /** Lê o nome da sessão salvo pelo CLI (customTitle do /rename, senão o título gerado ou o primeiro pedido). */
  private async refreshTitle(id = this.session.sessionId): Promise<void> {
    if (!id) {
      return;
    }
    const seq = ++this.titleSeq;
    let title = '';
    try {
      if (this.session instanceof CodexSession) {
        title = (await this.session.listSessions(40)).find((s) => s.id === id)?.title ?? '';
      } else {
        const info = await withConfigDir(this.profile, () => getSessionInfo(id, { dir: this.session.cwd }));
        title = info?.customTitle || info?.summary || '';
      }
    } catch {
      return;
    }
    if (seq === this.titleSeq && (!this.session.sessionId || this.session.sessionId === id)) {
      this.setSessionTitle(title);
    }
  }

  // ---------- Chat lateral de consulta ----------

  private openCompanion(prefill?: string): void {
    CompanionPanel.show(this.env, this.link(), prefill?.trim() || undefined);
  }

  /** O que o chat lateral enxerga desta conversa. Tudo só lê, menos o sendToMain, que só o clique do usuário dispara. */
  private link(): CompanionLink {
    this.companionLink ??= {
      // O lateral é sempre Claude: numa conversa Codex ele usa a primeira conta Claude cadastrada.
      profile: isCodex(this.profile) ? (this.env.store.all().find((p) => !isCodex(p)) ?? this.env.store.active()) : this.profile,
      mainSessionId: () => this.session.sessionId,
      alive: () => ChatPanel.all.has(this),
      source: () => this.companionSource(),
      sendToMain: (text) => this.receiveFromCompanion(text),
      revealMain: () => this.panel.reveal(),
    };
    return this.companionLink;
  }

  private companionSource(): CompanionSource {
    const builtIn = (info: AgentInfo, items: HistoryItem[]): CompanionAgent => ({ info, busy: info.status === 'running', items: items.map((item) => ({ item })) });
    return {
      title: () => this.sessionTitle || 'Nova conversa',
      mainModel: () => ({ model: this.session.model, effort: this.session.effort }),
      mainBusy: () => this.session.isBusy,
      agents: () => [
        ...this.hub.companionAgents(),
        ...[...this.session.agents.values()].map((r) => builtIn(r.info, r.items)),
        ...[...this.forks.keys()].map((id) => this.forkRecord(id)).filter((r): r is AgentRecord => !!r).map((r) => builtIn(r.info, r.items)),
      ],
      boxes: () => this.hub.boxList(),
      mainRecent: (last) => this.mainRecent(last),
      readTool: (name, args) => this.hub.readTool(name, args),
    };
  }

  /** Últimas mensagens da conversa principal, lidas do transcrito salvo (o CLI grava cada mensagem ao terminar). */
  private async mainRecent(last: number): Promise<MainMessage[]> {
    const id = this.session.sessionId;
    if (!id) {
      return [];
    }
    const items =
      this.session instanceof CodexSession
        ? await this.session.loadHistory(id)
        : toHistory(await withConfigDir(this.profile, () => getSessionMessages(id, { dir: this.session.cwd })));
    return toMainMessages(items).slice(-last);
  }

  /** "Enviar ao principal" do chat lateral: entra como mensagem do usuário, marcada como vinda da consulta. */
  private receiveFromCompanion(text: string): void {
    this.post({ type: 'userEcho', text, origin: 'companion' });
    this.session.send(`${COMPANION_MARK}\n\n${text}`);
  }

  private sendToParent(): void {
    const fork = this.options.fork;
    if (!fork || !ChatPanel.all.has(fork.parent)) {
      vscode.window.showWarningMessage('O chat principal desta continuação já foi fechado.');
      return;
    }
    const text = this.session.lastTurnText.trim();
    if (!text) {
      vscode.window.showInformationMessage('Ainda não há resposta para enviar.');
      return;
    }
    const message = `Resultado do agente "${fork.description}" (continuado na conta ${this.profile.name}):\n\n${text}`;
    fork.parent.post({ type: 'userEcho', text: message });
    fork.parent.session.send(message);
    fork.parent.panel.reveal();
  }

  /** Abre no editor um arquivo do projeto (miniatura de imagem gerada). Caminho fora do cwd é ignorado. */
  private async openProjectFile(rel: string): Promise<void> {
    const root = path.resolve(this.session.cwd);
    const abs = path.resolve(root, rel);
    const inside = path.relative(root, abs);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
      return;
    }
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(abs), { preview: true, viewColumn: vscode.ViewColumn.One });
  }

  private postActiveFile(): void {
    const doc = this.env.lastEditor()?.document;
    this.post({ type: 'activeFile', name: doc && !doc.isClosed ? path.basename(doc.uri.fsPath) : undefined });
  }

  private mentionFile(): void {
    const editor = this.env.lastEditor();
    if (!editor) {
      vscode.window.showInformationMessage('Abra um arquivo no editor para mencioná-lo.');
      return;
    }
    const rel = path.relative(this.session.cwd, editor.document.uri.fsPath).replace(/\\/g, '/');
    const sel = editor.selection;
    const range = sel.isEmpty ? '' : `#L${sel.start.line + 1}-${sel.end.line + 1}`;
    this.post({ type: 'insertText', text: `@${rel.startsWith('..') ? editor.document.uri.fsPath : rel}${range} ` });
  }

  // ---------- Anexos ----------

  /** Resolve as URIs que o webview recebeu de um arrastar-e-soltar e devolve os anexos prontos. */
  private async resolveUris(uris: string[]): Promise<void> {
    const list: Attachment[] = [];
    for (const raw of uris) {
      list.push(await this.resolveUri(raw));
    }
    this.post({ type: 'attachments', list });
  }

  private async resolveUri(raw: string): Promise<Attachment> {
    const id = randomUUID();
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(raw, true);
    } catch {
      return { id, kind: 'path', name: raw, error: 'Não entendi este endereço de arquivo.' };
    }
    if (uri.scheme !== 'file') {
      const name = path.posix.basename(uri.path) || raw;
      return { id, kind: 'path', name, error: `Só dá para anexar arquivo salvo em disco; este veio de "${uri.scheme}:".` };
    }

    const fsPath = uri.fsPath;
    const name = path.basename(fsPath);
    let size: number | undefined;
    try {
      size = (await vscode.workspace.fs.stat(uri)).size;
    } catch {
      // Segue sem o tamanho; a leitura abaixo dá o erro de verdade se o arquivo não existir.
    }

    const mime = IMAGE_MIME[path.extname(fsPath).toLowerCase()];
    if (!mime) {
      return { id, kind: 'path', name, size, path: relativeToCwd(this.session.cwd, fsPath) };
    }
    if (size !== undefined && size > MAX_IMAGE_BYTES) {
      return { id, kind: 'image', name, size, error: tooBig(size) };
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        return { id, kind: 'image', name, size: bytes.byteLength, error: tooBig(bytes.byteLength) };
      }
      return {
        id,
        kind: 'image',
        name,
        size: size ?? bytes.byteLength,
        dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`,
      };
    } catch (err) {
      return { id, kind: 'image', name, size, error: `Não consegui ler a imagem: ${String(err)}` };
    }
  }

  // ---------- HTML ----------

  private html(): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.env.context.extensionUri, 'out', 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.env.context.extensionUri, 'media', 'chat.css'));
    const codicons = webview.asWebviewUri(vscode.Uri.joinPath(this.env.context.extensionUri, 'media', 'codicons', 'codicon.css'));
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: https:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${codicons}">
<link rel="stylesheet" href="${style}">
<title>Agent Graph Master</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

// ---------- Utilitários ----------

function workspaceCwd(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
}

/** Caminho relativo ao cwd quando o arquivo está dentro dele; fora, o absoluto mesmo. */
function relativeToCwd(cwd: string, fsPath: string): string {
  const rel = path.relative(cwd, fsPath).replace(/\\/g, '/');
  if (!rel || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) {
    return fsPath;
  }
  return rel;
}

function tooBig(size: number): string {
  return `A imagem tem ${(size / 1024 / 1024).toFixed(1)} MB e o limite para anexar é 5 MB.`;
}

function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

let configDirLock: Promise<unknown> = Promise.resolve();

/**
 * listSessions e getSessionMessages leem CLAUDE_CONFIG_DIR de process.env na hora da chamada. Trocamos a variável
 * só durante a chamada, uma de cada vez, para ler o histórico da conta certa.
 */
function withConfigDir<T>(profile: Profile, fn: () => Promise<T>): Promise<T> {
  const run = async () => {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    const dir = configDirEnv(profile);
    if (dir) {
      process.env.CLAUDE_CONFIG_DIR = dir;
    } else {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
    try {
      return await fn();
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previous;
      }
    }
  };
  const result = configDirLock.then(run, run);
  configDirLock = result.catch(() => undefined);
  return result;
}

interface RawBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/** Relatório de agente entregue à conversa principal: vira "report" no main_recent do chat lateral. */
const REPORT_HEAD = /^(Relatório final|Resposta) do agente (a\d+)|^Novidade do vigia (a\d+)/;

/** Conversa principal sem as ferramentas: textos seguidos do assistente viram uma mensagem só. */
function toMainMessages(items: HistoryItem[]): MainMessage[] {
  const out: MainMessage[] = [];
  for (const item of items) {
    if (item.kind === 'user') {
      const report = REPORT_HEAD.exec(item.text);
      out.push(report ? { from: 'report', label: `agente ${report[2] ?? report[3]}`, text: item.text } : { from: 'user', text: item.text });
    } else if (item.kind === 'text' && item.text.trim()) {
      const prev = out.at(-1);
      if (prev?.from === 'assistant') {
        prev.text += `\n\n${item.text}`;
      } else {
        out.push({ from: 'assistant', text: item.text });
      }
    }
  }
  return out;
}

function toHistory(messages: SessionMessage[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  for (const m of messages) {
    if (m.parent_tool_use_id || m.type === 'system') {
      continue;
    }
    const content = (m.message as { content?: string | RawBlock[] } | undefined)?.content;
    if (typeof content === 'string') {
      if (m.type === 'user' && !isInternalPrompt(content)) {
        items.push({ kind: 'user', text: content });
      } else if (m.type === 'assistant') {
        items.push({ kind: 'text', text: content });
      }
      continue;
    }
    for (const block of content ?? []) {
      if (block.type === 'text' && block.text) {
        if (m.type === 'assistant') {
          items.push({ kind: 'text', text: block.text });
        } else if (!isInternalPrompt(block.text)) {
          items.push({ kind: 'user', text: block.text });
        }
      } else if (block.type === 'tool_use') {
        items.push({ kind: 'tool', id: block.id ?? '', name: block.name ?? '', input: block.input });
      } else if (block.type === 'tool_result') {
        items.push({
          kind: 'toolResult',
          id: block.tool_use_id ?? '',
          text: toolResultText(block.content),
          isError: !!block.is_error,
          images: toolResultImages(block.content),
        });
      }
    }
  }
  return items;
}

/** Mensagens que o próprio Claude Code injeta (lembretes, saída de comandos) e que a interface oficial também esconde. */
function isInternalPrompt(text: string): boolean {
  return /^\s*<(system-reminder|command-name|command-message|local-command-stdout|local-command-caveat)/.test(text);
}

const SEED_LIMIT = 40000;

/** Monta a primeira mensagem da continuação: tarefa original, o que o subagente já fez e a mensagem do usuário. */
function buildSeed(record: AgentRecord, userText: string): string {
  const { info, items } = record;
  const lines: string[] = [];
  for (const item of items) {
    if (item.kind === 'text') {
      lines.push(`[agente escreveu]\n${item.text}`);
    } else if (item.kind === 'tool') {
      lines.push(`[agente chamou ${item.name}] ${JSON.stringify(item.input).slice(0, 800)}`);
    } else if (item.kind === 'toolResult') {
      lines.push(`[resultado${item.isError ? ' com erro' : ''}] ${item.text.slice(0, 1500)}`);
    }
  }
  let transcript = lines.join('\n\n');
  if (transcript.length > SEED_LIMIT) {
    transcript = `(início omitido)\n${transcript.slice(-SEED_LIMIT)}`;
  }
  return [
    'Você está assumindo o trabalho de um subagente que foi criado em outra conversa do Claude Code. Continue o trabalho dele a partir daqui, no mesmo diretório.',
    '',
    `Descrição: ${info.description}`,
    info.subagentType ? `Tipo de agente: ${info.subagentType}` : '',
    '',
    '<tarefa_original>',
    info.prompt ?? '(não disponível)',
    '</tarefa_original>',
    '',
    '<o_que_o_agente_ja_fez>',
    transcript || '(nada registrado ainda)',
    '</o_que_o_agente_ja_fez>',
    '',
    'Mensagem do usuário para você:',
    userText,
  ]
    .filter((l, i, arr) => !(l === '' && arr[i - 1] === ''))
    .join('\n');
}
