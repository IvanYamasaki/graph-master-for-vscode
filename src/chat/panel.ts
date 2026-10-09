import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { randomBytes, randomUUID } from 'crypto';
import type { PermissionMode, SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { getSessionInfo, getSessionMessages, listSessions } from '@anthropic-ai/claude-agent-sdk';
import { Profile, ProfileStore, configDirEnv, isCodex } from '../profiles';
import { AgentRecord, ChatSession, probeClaudeUsage, profileEnv, toolResultImages, toolResultText } from './session';
import { isClaudeUrl } from './remoteControl';
import { CodexSession, codexModelOptions, knownCodexModels, prefetchCodexModels, probeCodexUsage } from './codexSession';
import { copySession, findSession, targetTranscript } from './transfer';
import { AgentHub, AnySession, MAIN_ID, browserApproval } from './hub';
import type { LabReports } from './lab/reportHost';
import { AgentStore } from './agentStore';
import { SessionStore } from './sessionStore';
import { FileIndex, editorFiles } from './fileIndex';
import { AccountUsage, Attachment, AgentInfo, COMPANION_MARK, ConnectedBrowser, HistoryItem, HostMessage, ProfileOption, WebviewMessage } from './protocol';
import { ExternalProviders } from './external';
import { handleImageMessage } from './imageFiles';
import { probeBrowsers } from './browserProbe';
import { resolveClaudeExecutable } from '../claudePath';
import { CompanionLink, CompanionPanel } from './companion/panel';
import { ChatThreads } from './threadHost';
import { parseThreadMessage, splitBlocks } from './threadModel';
import { FolderThreadStore } from './threadStore';
import { RECONCILE_EVERY_MS } from './taskLiveness';
import { StampedKill, killSnapshot, killSummary, orphanDetail, scanOrphans, snapFromView } from './taskProcs';
import type { CompanionAgent, CompanionSource, MainMessage } from './companion/types';
import type { MapLayout, SessionOption, UsageInfo } from './protocol';

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
  permissionMode?: PermissionMode;
  /** Coluna onde a aba abre; sem isso abre ao lado. */
  viewColumn?: vscode.ViewColumn;
  /** Primeira mensagem enviada assim que o chat abre. `display` é o que aparece na tela, `prompt` é o que vai para o Claude. */
  seed?: { display: string; prompt: string };
}

interface PanelState {
  profileId: string;
  sessionId?: string;
}

/**
 * Confirmação modal do Remote Control com o modo bypass. `toggle`: o usuário ligou. `startup`: a configuração ligou.
 * `mode`: o modo virou bypass com a ponte ligada. `restart`: o processo novo ia religar a ponte em bypass.
 */
async function confirmRemoteBypass(why: 'toggle' | 'startup' | 'mode' | 'restart'): Promise<boolean> {
  const title = {
    toggle: 'Ligar o Remote Control com as permissões ignoradas (bypass)?',
    startup: 'Ligar o Remote Control neste chat (agentGraphMaster.remoteControlAtStartup)?',
    mode: 'O modo virou bypass com o Remote Control ligado. Manter o Remote Control?',
    restart: 'Religar o Remote Control com o modo bypass?',
  }[why];
  const button = why === 'toggle' || why === 'startup' ? 'Ligar mesmo assim' : 'Manter ligado';
  const ok = await vscode.window.showWarningMessage(
    title,
    {
      modal: true,
      detail:
        'Este chat roda em modo bypass: o Claude executa comandos e edita arquivos sem pedir aprovação.\n\n' +
        'Com o Remote Control ligado, quem tiver acesso à sua conta claude.ai (navegador ou app do celular) manda mensagens para esta sessão e, por ela, controla esta máquina sem nenhuma confirmação.\n\n' +
        (why === 'mode' || why === 'restart' ? 'Cancelar desliga o Remote Control.' : 'Se não quiser isso, cancele e troque o modo de permissão antes.'),
    },
    button,
  );
  return ok === button;
}

export class ChatPanel {
  private static readonly all = new Set<ChatPanel>();

  /** Claude ou Codex, conforme o fornecedor da conta. As duas têm a mesma superfície. */
  readonly session: AnySession;
  private readonly hub: AgentHub;
  /** Posts dos agentes (um por relatório entregue) e as threads de qualquer mensagem deste chat. */
  private readonly threads: ChatThreads;
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
  /** Reconciliação periódica das tarefas "trabalhando" com o que o CLI ainda conhece. */
  private reconcileTimer?: ReturnType<typeof setInterval>;

  static open(env: ChatEnv, profile: Profile, options: ChatOptions = {}): ChatPanel {
    const panel = vscode.window.createWebviewPanel(
      CHAT_VIEW_TYPE,
      '',
      { viewColumn: options.viewColumn ?? vscode.ViewColumn.Beside, preserveFocus: false },
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
    // Comando da paleta: abre a lista de órfãos no chat ativo; sem chat aberto, a lista vem num seletor do VS Code.
    vscode.commands.registerCommand('agentGraphMaster.orphanProcesses', async () => {
      const list = [...ChatPanel.all];
      const target = list.find((p) => p.panel.active) ?? list.at(-1);
      if (target) {
        target.panel.reveal();
        await target.postOrphans(true);
        return;
      }
      await pickOrphans(workspaceCwd());
    });
    // Comando da paleta: liga ou desliga o Remote Control do chat ativo (ou do último aberto).
    vscode.commands.registerCommand('agentGraphMaster.remoteControl', async () => {
      const list = [...ChatPanel.all];
      const target = list.find((p) => p.panel.active) ?? list.at(-1);
      if (!target) {
        void vscode.window.showInformationMessage('Abra um chat do Agent Graph Master para ligar o Remote Control.');
        return;
      }
      target.panel.reveal();
      const s = target.session;
      await target.setRemoteControl(!(s instanceof ChatSession && (s.remote.mayReceive || s.remote.state.status === 'connected')));
    });
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
      store: new AgentStore(env.context.workspaceState, SessionStore.for(cwd)),
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
          permissionMode: options.permissionMode,
          mcpServers: this.hub.mcpServersFor(MAIN_ID),
          systemAppend: () => this.hub.systemAppendFor(MAIN_ID),
          chrome: chromeAtStart,
          browserApproval,
          remoteControl: true,
        });
    if (this.session instanceof ChatSession) {
      this.session.onBrowserChange = () => this.postBrowser();
      this.session.onRemoteConfirm = (why) => this.askRemoteBypass(why);
      this.session.onOrphanHint = (text) => this.post({ type: 'notice', level: 'info', text, action: { kind: 'orphans', label: 'Processos órfãos' } });
      this.reconcileTimer = setInterval(() => {
        if (this.session instanceof ChatSession && this.session.hasRunningTasks) {
          this.session.reconcileTasks();
        }
      }, RECONCILE_EVERY_MS);
    }
    this.threads = new ChatThreads({
      persistence: new FolderThreadStore(cwd),
      mainSessionId: () => this.session.sessionId,
      agents: () => this.companionSource().agents().map((a) => a.info),
      post: (msg) => this.post(msg),
      // Mensagem de thread vai ao orquestrador como a do composer, com as novidades do cérebro na frente.
      toMain: (text) => void this.session.send(this.hub.brain.withNews(MAIN_ID, text)),
      startPaused: !!options.resumeId,
    });
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
      vscode.workspace.onDidChangeConfiguration?.((e) => {
        if (e.affectsConfiguration('agentGraphMaster.liveBubbles')) {
          this.post({ type: 'liveConfig', enabled: vscode.workspace.getConfiguration('agentGraphMaster').get<boolean>('liveBubbles', true) });
        }
        if (e.affectsConfiguration('agentGraphMaster.toolsExpanded')) {
          this.post({ type: 'toolsConfig', expanded: vscode.workspace.getConfiguration('agentGraphMaster').get<boolean>('toolsExpanded', false) });
        }
      }),
    ];
    panel.onDidDispose(() => {
      ChatPanel.all.delete(this);
      clearInterval(this.usageTimer);
      clearInterval(this.reconcileTimer);
      this.files.release();
      editorWatch.forEach((d) => d?.dispose());
      this.hub.dispose();
      this.threads.dispose();
      this.session.dispose();
      if (options.fork) {
        options.fork.parent.updateFork(options.fork.forkId, { status: 'stopped' });
      }
    });

    // Início e fim de turno da conversa principal: o hub decide se o texto é a resposta a quem perguntou ao main.
    this.session.onBusyChange = (busy) => {
      if (busy) {
        this.hub.noteMainTurnStart();
      }
    };
    // Sem os blocos <post> e <thread>: o que vai ao agente que perguntou é o texto do chat.
    this.session.onTurnEnd = (turn) => this.hub.onMainTurnEnd(splitBlocks(this.session.lastTurnText).text, turn.queued);
    if (options.fork) {
      const { parent, forkId } = options.fork;
      const ownBusy = this.session.onBusyChange;
      this.session.onBusyChange = (busy) => {
        ownBusy?.(busy);
        parent.updateFork(forkId, { status: busy ? 'running' : 'completed' });
      };
      const own = this.session.onTurnEnd;
      this.session.onTurnEnd = (turn) => {
        own?.(turn);
        parent.updateFork(forkId, { totalTokens: turn.contextTokens, status: turn.isError ? 'failed' : 'completed', model: this.session.model || undefined });
      };
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
    // Depois da mensagem do agente: relatório novo vira post. Texto completo do orquestrador: os blocos <post>
    // viram o texto do post do agente e os <thread>, respostas nas threads (o webview tira os blocos do que mostra).
    // Orquestrador parado: nenhuma thread espera mais resposta.
    if (msg.type === 'agent') {
      this.threads?.noteAgent(msg.agent);
    } else if (msg.type === 'assistantText') {
      this.threads?.takeText(msg.text);
    } else if (msg.type === 'busy' && !msg.value) {
      this.threads?.mainIdle();
    }
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.onReady();
        // Painel aberto (ou recarregado): o que diz "trabalhando" tem de estar vivo.
        if (this.session instanceof ChatSession) {
          this.session.reconcileTasks();
        }
        return;
      case 'taskProcs': {
        const read = this.session instanceof ChatSession ? await this.session.taskProcs(msg.id) : undefined;
        if (read) {
          this.post({ type: 'taskProcs', procs: read.procs });
        }
        return;
      }
      case 'killTaskTree':
        await this.killTaskTree(msg.id);
        return;
      case 'scanOrphans':
        await this.postOrphans(false);
        return;
      case 'killOrphans':
        await this.killOrphans(msg.roots);
        return;
      case 'send':
        // /remote-control (ou /rc) digitado no chat liga e desliga, como na extensão oficial; o CLI não o trata fora do terminal.
        if (/^\/(remote-control|rc)\s*$/i.test(msg.text.trim()) && this.session instanceof ChatSession && !msg.attachments?.length) {
          const s = this.session;
          if (msg.clientId) {
            this.post({ type: 'userId', clientId: msg.clientId });
          }
          await this.setRemoteControl(!(s.remote.mayReceive || s.remote.state.status === 'connected'));
          return;
        }
        {
          // Novidades do cérebro guardadas para o orquestrador vão na frente da mensagem (sem abrir turno à parte).
          const uuid = this.session.send(this.hub.brain.withNews(MAIN_ID, msg.text), msg.attachments);
          // O uuid é o id da mensagem no transcrito: a bolha dela ganha thread que sobrevive ao recarregar.
          if (msg.clientId) {
            this.post({ type: 'userId', clientId: msg.clientId, id: typeof uuid === 'string' ? uuid : undefined });
          }
        }
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
        // Conversa nova em aba nova no mesmo grupo de abas, com sessão, hub e agentes próprios. Esta aba fica como está.
        ChatPanel.open(this.env, this.profile, { viewColumn: this.panel.viewColumn });
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
      case 'mapLayout':
        if (this.session.sessionId) {
          SessionStore.for(this.session.cwd).write(this.session.sessionId, 'layout', msg.layout);
        }
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
      case 'threadSend':
        this.threads.send(msg.threadId, msg.text, msg.parent);
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
      case 'accountsUsage':
        await this.postAccountsUsage(!!msg.force);
        return;
      case 'transferSession':
        await this.transferSession(msg.profileId);
        return;
      case 'agentSwitchAccount':
        await this.hub.switchAccount(msg.id, msg.profileId);
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
      case 'resolveImages':
      case 'imageAction':
        await handleImageMessage(this.panel.webview, msg, this.session.cwd, [workspaceCwd()], (m) => this.post(m));
        return;
      case 'setChrome':
        this.setChrome(msg.value);
        return;
      case 'refreshBrowsers':
        await this.refreshBrowsers();
        return;
      case 'remoteControl':
        await this.remoteControlAction(msg.action);
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
      liveBubbles: vscode.workspace.getConfiguration('agentGraphMaster').get<boolean>('liveBubbles', true),
      toolsExpanded: vscode.workspace.getConfiguration('agentGraphMaster').get<boolean>('toolsExpanded', false),
    });
    this.post({ type: 'profiles', list: this.env.profileOptions() });
    if (knownCodexModels().length) {
      this.post({ type: 'codexModels', list: codexModelOptions(knownCodexModels()) });
    }
    this.postActiveFile();
    this.postBrowser();
    if (this.session instanceof ChatSession) {
      this.post({ type: 'remoteControl', state: this.session.remote.state });
    }
    this.post({ type: 'brain', exists: this.hub.brain.isActive });
    this.threads.postAll();
    for (const msg of this.outbox.splice(0)) {
      void this.panel.webview.postMessage(msg);
    }
    if (!firstLoad) {
      return;
    }
    const history = this.options.resumeId ? await this.loadHistory(this.options.resumeId) : [];
    this.session.start(this.options.resumeId);
    this.saveState();
    if (this.options.resumeId) {
      // Conversa retomada: os agentes roteados dela voltam da pasta da conversa, parados, esperando o usuário retomar.
      this.hub.restore(this.options.resumeId);
      this.threads.load(this.options.resumeId, history);
      this.postMapLayout(this.options.resumeId);
    }
    if (this.options.seed) {
      const uuid = this.session.send(this.options.seed.prompt);
      this.post({ type: 'userEcho', text: this.options.seed.display, msgId: typeof uuid === 'string' ? uuid : undefined });
    }
    this.startUsagePolling();
    // Remote Control ao abrir o chat só com a configuração ligada; em bypass passa pela mesma confirmação do interruptor.
    if (this.session instanceof ChatSession && vscode.workspace.getConfiguration('agentGraphMaster').get<boolean>('remoteControlAtStartup', false)) {
      await this.setRemoteControl(true, true);
    }
  }

  // ---------- Remote Control ----------

  /**
   * Liga ou desliga o Remote Control desta conversa. Em bypass, ligar pede confirmação modal: quem entrar na conta
   * claude.ai controla esta máquina pelo Claude sem aprovação nenhuma.
   */
  async setRemoteControl(on: boolean, atStartup = false): Promise<void> {
    if (!(this.session instanceof ChatSession)) {
      this.post({ type: 'notice', level: 'error', text: 'O Remote Control só funciona em conversas do Claude (não do Codex).' });
      return;
    }
    const session = this.session;
    if (!on) {
      await session.setRemoteControl(false);
      return;
    }
    if (!session.remote.available) {
      this.post({ type: 'notice', level: 'error', text: `Remote Control indisponível: ${session.remote.state.reason ?? 'o Claude Code não permite nesta conta ou organização'}.` });
      return;
    }
    if (session.permissionMode === 'bypassPermissions') {
      const ok = await confirmRemoteBypass(atStartup ? 'startup' : 'toggle');
      if (!ok) {
        if (atStartup) {
          this.post({ type: 'notice', level: 'info', text: 'Remote Control não ligado neste chat (confirmação recusada).' });
        }
        return;
      }
      session.remote.bypassConfirmed = true;
    }
    // O painel anuncia conectado, queda e motivo a cada mudança de estado (mensagem remoteControl).
    await session.setRemoteControl(true);
  }

  /**
   * O modo virou bypass com a ponte ligada, ou o processo novo ia religá-la em bypass: pergunta de novo. Recusar
   * desliga a ponte. Um modal por vez: pedidos que chegam com ele aberto esperam a mesma resposta.
   */
  private remoteConfirm?: Promise<void>;
  private askRemoteBypass(why: 'mode' | 'restart'): void {
    if (!(this.session instanceof ChatSession) || this.remoteConfirm) {
      return;
    }
    const session = this.session;
    this.remoteConfirm = (async () => {
      const ok = await confirmRemoteBypass(why);
      await session.confirmRemoteBypass(ok);
      if (!ok) {
        this.post({ type: 'notice', level: 'info', text: 'Remote Control desligado: o modo bypass não foi confirmado para uso remoto.' });
      }
    })().finally(() => (this.remoteConfirm = undefined));
  }

  private async remoteControlAction(action: 'on' | 'off' | 'open' | 'copy'): Promise<void> {
    if (action === 'on' || action === 'off') {
      await this.setRemoteControl(action === 'on');
      return;
    }
    const url = this.session instanceof ChatSession ? this.session.remote.state.sessionUrl : undefined;
    if (!url) {
      return;
    }
    if (action === 'open') {
      // Só abre https no claude.ai: o link vem do CLI, mas o navegador não abre nada que ele não devia mandar.
      if (!isClaudeUrl(url)) {
        this.post({ type: 'notice', level: 'error', text: `Link do Remote Control fora do claude.ai, não abri: ${url}` });
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(url));
    } else {
      await vscode.env.clipboard.writeText(url);
      this.post({ type: 'notice', level: 'info', text: 'Link da sessão copiado.' });
    }
  }

  // ---------- Processos das tarefas de shell ----------

  /**
   * Encerra a árvore de uma tarefa de shell, depois de confirmar num diálogo modal. Só o que a leitura mostrou ao usuário
   * pode morrer: a foto (PID, nome, início) é conferida de novo depois do modal, e o que não bater fica vivo.
   */
  private async killTaskTree(id: string): Promise<void> {
    if (!(this.session instanceof ChatSession)) {
      return;
    }
    const session = this.session;
    const record = session.agents.get(id);
    const read = await session.taskProcs(id);
    if (!record || !read) {
      return;
    }
    this.post({ type: 'taskProcs', procs: read.procs });
    if (!read.procs.root) {
      const why = read.procs.identified ? 'os processos dela já encerraram' : 'o processo dela não foi identificado enquanto ela rodava; veja Processos órfãos';
      this.post({ type: 'notice', level: 'info', text: `Nada a encerrar na tarefa "${record.info.description}": ${why}.`, action: read.procs.identified ? undefined : { kind: 'orphans', label: 'Processos órfãos' } });
      return;
    }
    const detail = read.procs.members.map((m) => `${m.pid} ${m.name}${m.ports.length ? ` (porta ${m.ports.join(', ')})` : ''}${m.startedAt ? ` · desde ${new Date(m.startedAt).toLocaleTimeString()}` : ''}`).join('\n');
    const ok = await vscode.window.showWarningMessage(
      `Encerrar ${read.procs.members.length} ${read.procs.members.length === 1 ? 'processo' : 'processos'} da tarefa "${record.info.description}"?`,
      { modal: true, detail },
      'Encerrar',
    );
    if (ok !== 'Encerrar') {
      return;
    }
    if (record.info.status === 'running') {
      // Parar pelo SDK também mata a árvore pela foto; o registro da tarefa sai direito.
      await session.stopAgent(id);
    }
    const r = await killSnapshot(read.snap);
    if (r.killed.length || r.failed.length || r.refused || r.skipped?.length) {
      this.post({ type: 'notice', level: r.failed.length || r.refused ? 'error' : 'info', text: `Tarefa "${record.info.description}": ${killSummary(r)}.` });
    }
    const after = await session.taskProcs(id);
    if (after) {
      this.post({ type: 'taskProcs', procs: after.procs });
    }
  }

  /** Lê os órfãos do projeto e manda ao webview; `open` abre a lista. */
  async postOrphans(open: boolean): Promise<void> {
    const found = await scanOrphans(this.session.cwd);
    this.post({ type: 'orphans', groups: found.groups, error: found.error, scannedAt: new Date().toISOString(), open });
  }

  /**
   * Encerra as árvores órfãs com estas raízes, depois de confirmar num diálogo modal. A lista é relida: raiz que não
   * bate mais (PID reaproveitado, processo já encerrado) não entra, e o que mudou na árvore depois da leitura fica vivo.
   */
  private async killOrphans(roots: { pid: number; name: string; startedAt?: string }[]): Promise<void> {
    const found = await scanOrphans(this.session.cwd);
    const wanted = roots.map(snapFromView);
    const groups = found.groups.filter((g) => wanted.some((w) => w.pid === g.root.pid && w.name.toLowerCase() === g.root.name.toLowerCase() && sameStart(w.startedAt, g.root.startedAt)));
    const missing = roots.filter((r) => !groups.some((g) => g.root.pid === r.pid));
    if (!groups.length) {
      this.post({ type: 'notice', level: 'info', text: 'As árvores escolhidas já não estão na lista de órfãos (encerraram ou o PID mudou de dono). Nada foi encerrado.' });
      this.post({ type: 'orphans', groups: found.groups, error: found.error, scannedAt: new Date().toISOString() });
      return;
    }
    const total = groups.reduce((n, g) => n + g.members.length, 0);
    const alive = groups.filter((g) => g.parentAlive).length;
    const ok = await vscode.window.showWarningMessage(
      `Encerrar ${groups.length === 1 ? 'a árvore órfã' : `${groups.length} árvores órfãs`} (${total} ${total === 1 ? 'processo' : 'processos'})?${alive ? ` ${alive === 1 ? 'Uma delas foi aberta' : `${alive} delas foram abertas`} por um processo que ainda está aberto (terminal externo, outro claude).` : ''}`,
      { modal: true, detail: orphanDetail(groups) + (missing.length ? `\n\nFora da lista agora (não serão tocados): ${missing.map((m) => m.pid).join(', ')}` : '') },
      'Encerrar',
    );
    if (ok !== 'Encerrar') {
      return;
    }
    const r = await killGroups(groups.map((g) => found.snaps.get(g.root.pid) ?? []));
    this.post({ type: 'notice', level: r.failed.length || r.refused ? 'error' : 'info', text: `Processos órfãos: ${killSummary(r)}${missing.length ? `; ${missing.length} já não estavam na lista` : ''}.` });
    await this.postOrphans(false);
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

  /**
   * Limites de todas as contas. A deste chat vem do processo dele; as outras, de um chat aberto com a mesma conta
   * ou de um processo curto que só pergunta o /usage. O menu recebe a lista de novo a cada conta lida.
   */
  private async postAccountsUsage(force: boolean): Promise<void> {
    const profiles = this.env.store.all();
    const options = new Map(this.env.profileOptions().map((o) => [o.id, o]));
    const result = new Map<string, UsageInfo | undefined>();
    const send = () =>
      this.post({
        type: 'accountsUsage',
        list: profiles.map(
          (p): AccountUsage => ({
            id: p.id,
            name: p.name,
            account: options.get(p.id)?.account ?? '',
            provider: isCodex(p) ? 'codex' : 'claude',
            current: p.id === this.profile.id,
            usage: result.get(p.id),
          }),
        ),
      });
    for (const p of profiles) {
      const cached = usageCache.get(p.id);
      result.set(p.id, !force && cached && Date.now() - cached.at < USAGE_CACHE_MS ? cached.usage : undefined);
    }
    send();
    await Promise.all(
      profiles
        .filter((p) => !result.get(p.id))
        .map(async (p) => {
          const usage = await this.readAccountUsage(p);
          usageCache.set(p.id, { usage, at: Date.now() });
          result.set(p.id, usage);
          send();
        }),
    );
  }

  private readAccountUsage(profile: Profile): Promise<UsageInfo> {
    const live = [this, ...ChatPanel.all].find((p) => p.profile.id === profile.id && ChatPanel.all.has(p));
    if (live) {
      return live.session.readUsage();
    }
    let running = usageProbes.get(profile.id);
    if (!running) {
      running = (isCodex(profile) ? probeCodexUsage(profile, this.session.cwd) : probeClaudeUsage(profile, this.session.cwd)).finally(() => usageProbes.delete(profile.id));
      usageProbes.set(profile.id, running);
    }
    return running;
  }

  // ---------- Troca de conta da conversa ----------

  /**
   * Continua esta conversa em outra conta Claude. O transcrito (com subagentes e checkpoints) é copiado para a pasta
   * da conta escolhida e o chat reabre ali, retomando a sessão. A cópia na conta de origem fica como estava.
   */
  private async transferSession(targetId: string): Promise<void> {
    const target = this.env.store.get(targetId);
    const session = this.session;
    const fail = (text: string) => this.post({ type: 'notice', level: 'error', text });
    if (!target || target.id === this.profile.id) {
      return;
    }
    if (!(session instanceof ChatSession) || isCodex(target)) {
      fail('Só dá para trocar a conta de conversas do Claude, e para outra conta do Claude: o Codex grava a conversa em outro formato.');
      return;
    }
    if (this.options.fork) {
      fail('Uma continuação de agente não troca de conta; continue o agente direto na outra conta pelo mapa.');
      return;
    }
    if (!session.sessionId) {
      fail('A conversa ainda não existe: mande a primeira mensagem antes de trocar de conta.');
      return;
    }
    if (session.isBusy) {
      fail('Espere o turno terminar (ou interrompa) antes de trocar de conta.');
      return;
    }
    if (path.resolve(target.configDir).toLowerCase() === path.resolve(this.profile.configDir).toLowerCase()) {
      fail(`A conta "${target.name}" usa a mesma pasta desta; não há o que transferir.`);
      return;
    }
    const sessionId = session.sessionId;
    const source = await findSession(this.profile, sessionId, session.cwd);
    if (!source) {
      fail(`Não achei o transcrito desta conversa na pasta da conta ${this.profile.name}.`);
      return;
    }
    const dest = targetTranscript(target, source);
    const email = this.env.profileOptions().find((p) => p.id === target.id)?.account;
    const warnings = [
      'A conversa é copiada para a outra conta e esta aba reabre nela, com o mesmo histórico. A cópia nesta conta fica como está.',
      session.hasRunningTasks ? 'Há tarefas em segundo plano rodando: elas param quando esta aba fechar.' : '',
      session.remote.state.status === 'connected' ? 'O Remote Control desta aba é desligado; ligue de novo na conta nova, se quiser.' : '',
      dest.exists ? `A conta ${target.name} já tem uma cópia desta conversa (de uma troca anterior). Ela será substituída por esta.` : '',
      email ? '' : `A conta ${target.name} não mostra login agora. Sem login, a conversa abre mas não responde até você entrar nela.`,
    ].filter(Boolean);
    const ok = await vscode.window.showWarningMessage(
      `Continuar esta conversa na conta ${target.name}${email ? ` (${email})` : ''}?`,
      { modal: true, detail: warnings.join('\n\n') },
      'Trocar de conta',
    );
    if (ok !== 'Trocar de conta' || !ChatPanel.all.has(this)) {
      return;
    }
    if (session.isBusy || session.sessionId !== sessionId) {
      fail('A conversa mudou enquanto a confirmação estava aberta; tente de novo.');
      return;
    }
    try {
      await copySession(source, this.profile, target);
    } catch (err) {
      fail(`Não consegui copiar a conversa para a conta ${target.name}: ${String(err)}`);
      return;
    }
    this.hub.pinOwnAccount();
    this.hub.flush();
    const env = this.env;
    const options: ChatOptions = { resumeId: sessionId, model: session.model, effort: session.effort, permissionMode: session.permissionMode, viewColumn: this.panel.viewColumn };
    // Fecha esta aba antes: o navegador e o Remote Control ficam livres para a aba nova.
    this.panel.dispose();
    const next = ChatPanel.open(env, target, options);
    next.post({ type: 'notice', level: 'info', text: `Conversa trazida da conta ${this.profile.name}. O histórico é o mesmo; daqui em diante ela gasta os limites de ${target.name}.` });
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
        this.post({ type: 'sessions', list: this.withAgentCounts(await this.session.listSessions()) });
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
        list: this.withAgentCounts(
          sessions.map((s) => ({
            id: s.sessionId,
            title: shorten(s.customTitle || s.summary || s.firstPrompt || s.sessionId, 80),
            lastModified: s.lastModified,
            current: s.sessionId === this.session.sessionId,
          })),
        ),
      });
    } catch (err) {
      this.post({ type: 'sessions', list: [], error: String(err) });
    }
  }

  /** Nós arrastados e caixas recolhidas da conversa reaberta, de `.agm/sessions/<id>/layout.json`. */
  private postMapLayout(sessionId: string): void {
    const raw = SessionStore.for(this.session.cwd).read<Partial<MapLayout>>(sessionId, 'layout');
    if (raw && typeof raw === 'object') {
      this.post({ type: 'mapLayout', layout: { pinned: isPlainObject(raw.pinned) ? raw.pinned : {}, folds: isPlainObject(raw.folds) ? raw.folds : {} } });
    }
  }

  /** Quantos agentes cada conversa tem no mapa, lido do meta.json da pasta dela (um arquivo pequeno por conversa). */
  private withAgentCounts(list: SessionOption[]): SessionOption[] {
    const sessions = SessionStore.for(this.session.cwd);
    return list.map((s) => {
      const agents = sessions.meta(s.id)?.agents;
      return agents ? { ...s, agents } : s;
    });
  }

  private async resume(sessionId: string): Promise<void> {
    if (sessionId === this.session.sessionId) {
      return;
    }
    // A mesma conversa em dois painéis teria dois hubs gravando a mesma pasta, cada um com a sua lista de agentes.
    const open = [...ChatPanel.all].find((p) => p !== this && p.session.sessionId === sessionId);
    if (open) {
      open.panel.reveal();
      return;
    }
    this.post({ type: 'clear' });
    this.session.agents.clear();
    // Trocar de conversa não apaga os agentes da anterior: eles continuam salvos e voltam se ela for reaberta.
    this.hub.detach();
    this.threads.detach();
    const history = await this.loadHistory(sessionId);
    this.session.start(sessionId);
    this.saveState();
    this.hub.restore(sessionId);
    this.threads.load(sessionId, history);
    this.postMapLayout(sessionId);
    this.sessionTitle = '';
    this.applyTitle();
    void this.refreshTitle(sessionId);
  }

  /** Manda o histórico ao webview e devolve os itens (os blocos <post> e <thread> deles completam posts e threads). */
  private async loadHistory(sessionId: string): Promise<HistoryItem[]> {
    let items: HistoryItem[];
    try {
      items =
        this.session instanceof CodexSession
          ? await this.session.loadHistory(sessionId)
          : toHistory(await withConfigDir(this.profile, () => getSessionMessages(sessionId, { dir: this.session.cwd })));
    } catch (err) {
      const what = this.session instanceof CodexSession ? 'a conversa do Codex' : 'a conversa';
      this.post({ type: 'notice', level: 'error', text: `Não consegui carregar ${what}: ${String(err)}` });
      return [];
    }
    this.post({ type: 'history', items, title: '' });
    return items;
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
    // Encadeia com o que o chat filho já ligou (o hub dele e o fork), em vez de substituir.
    const own = child.session.onTurnEnd;
    child.session.onTurnEnd = (turn) => {
      own?.(turn);
      this.updateFork(forkId, {
        totalTokens: turn.contextTokens,
        durationMs: Date.now() - started,
        status: turn.isError ? 'failed' : 'completed',
        model: child.session.model || undefined,
      });
    };
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
    const uuid = this.session.send(`${COMPANION_MARK}\n\n${text}`);
    this.post({ type: 'userEcho', text, origin: 'companion', msgId: typeof uuid === 'string' ? uuid : undefined });
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
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

/** Limites lidos de cada conta, para o menu de contas não subir um processo a cada clique. */
const USAGE_CACHE_MS = 60_000;
const usageCache = new Map<string, { usage: UsageInfo; at: number }>();
const usageProbes = new Map<string, Promise<UsageInfo>>();

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
      // Mensagem de thread: o que o usuário escreveu, sem o embrulho.
      const thread = report ? undefined : parseThreadMessage(item.text);
      out.push(report ? { from: 'report', label: `agente ${report[2] ?? report[3]}`, text: item.text } : { from: 'user', text: thread ? `(numa thread) ${thread.text}` : item.text });
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
    const message = m.message as { content?: string | RawBlock[]; id?: string } | undefined;
    const content = message?.content;
    // Id da thread de cada mensagem: o uuid na do usuário, o id da mensagem da API na do orquestrador.
    const id = m.type === 'assistant' ? (typeof message?.id === 'string' ? message.id : undefined) : m.uuid || undefined;
    if (typeof content === 'string') {
      if (m.type === 'user' && !isInternalPrompt(content)) {
        items.push({ kind: 'user', text: content, id });
      } else if (m.type === 'assistant') {
        items.push({ kind: 'text', text: content, id });
      }
      continue;
    }
    for (const block of content ?? []) {
      if (block.type === 'text' && block.text) {
        if (m.type === 'assistant') {
          items.push({ kind: 'text', text: block.text, id });
        } else if (!isInternalPrompt(block.text)) {
          items.push({ kind: 'user', text: block.text, id });
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

/** Mesma hora de início, com folga de 1 s; sem hora de um dos lados, não dá para desmentir. */
function sameStart(a: Date | undefined, b: string | undefined): boolean {
  return !a || !b || Math.abs(a.getTime() - Date.parse(b)) <= 1000;
}

/** Encerra cada árvore pela foto dela, somando os resultados. */
async function killGroups(snaps: import('./proc').ProcSnap[][]): Promise<StampedKill> {
  const total: StampedKill = { killed: [], failed: [] };
  const skipped: number[] = [];
  const refused: string[] = [];
  for (const snap of snaps) {
    const r = await killSnapshot(snap);
    total.killed.push(...r.killed);
    total.failed.push(...r.failed);
    skipped.push(...(r.skipped ?? []));
    if (r.refused) {
      refused.push(r.refused);
    }
  }
  if (skipped.length) {
    total.skipped = skipped;
  }
  if (refused.length) {
    total.refused = refused.join('; ');
  }
  return total;
}

function shortCommand(command: string): string {
  const one = command.replace(/\s+/g, ' ').trim();
  return one.length > 90 ? `${one.slice(0, 89)}…` : one;
}

/** Órfãos sem chat aberto: seletor múltiplo do VS Code e confirmação modal. Árvores de pai vivo vêm desmarcadas e sinalizadas. */
async function pickOrphans(cwd: string): Promise<void> {
  const found = await scanOrphans(cwd);
  if (!found.groups.length) {
    void vscode.window.showInformationMessage(found.error ? `Não consegui listar os processos: ${found.error}` : 'Nenhum processo órfão do projeto.');
    return;
  }
  const items = found.groups.map((g) => ({
    label: `${g.parentAlive ? '$(warning) ' : ''}${g.root.pid} ${g.root.name}`,
    description: [
      g.ports.length ? `porta ${g.ports.join(', ')}` : '',
      `${g.members.length} ${g.members.length === 1 ? 'processo' : 'processos'}`,
      g.root.startedAt ? `desde ${new Date(g.root.startedAt).toLocaleString()}` : '',
      g.parentAlive ? `pai ${g.parent?.name ?? '?'} ${g.parent?.pid ?? ''} ainda aberto` : 'pai encerrado',
    ]
      .filter(Boolean)
      .join(' · '),
    detail: shortCommand(g.root.commandLine),
    group: g,
  }));
  const picked = await vscode.window.showQuickPick(items, { canPickMany: true, title: 'Processos órfãos do projeto: marque as árvores para encerrar' });
  if (!picked?.length) {
    return;
  }
  const ok = await vscode.window.showWarningMessage(
    `Encerrar ${picked.length === 1 ? 'a árvore marcada' : `${picked.length} árvores marcadas`}?`,
    { modal: true, detail: orphanDetail(picked.map((p) => p.group)) },
    'Encerrar',
  );
  if (ok === 'Encerrar') {
    // killSnapshot relê a lista e só mata o que ainda bate com a foto tirada antes do seletor.
    const r = await killGroups(picked.map((p) => found.snaps.get(p.group.root.pid) ?? []));
    void vscode.window.showInformationMessage(`Processos órfãos: ${killSummary(r)}.`);
  }
}

/** Objeto simples vindo de JSON (layout.json pode ser de outra versão ou estar editado à mão). */
function isPlainObject<T>(value: unknown): value is Record<string, T> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
