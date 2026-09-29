import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  AuthStatus,
  DEFAULT_ID,
  Profile,
  ProfileStore,
  Provider,
  claudeCommand,
  configDirEnv,
  isCodex,
  isSharedFolder,
  readAuthStatus,
} from './profiles';
import { codexCommandLine, codexProfilesRoot, defaultCodexHome, isSharedCodexHome, loginWithApiKey } from './codex';
import { resolveCodexExecutable } from './codexPath';
import { CHAT_VIEW_TYPE, ChatEnv, ChatPanel } from './chat/panel';
import { COMPANION_VIEW_TYPE, CompanionPanel } from './chat/companion/panel';
import { ExternalProviders } from './chat/external';
import { configureResearchPack, initResearchSecrets } from './chat/infra/researchPack';
import { initMcpApprovals } from './chat/guard/mcpApproval';
import { Lab } from './chat/lab/tools';
import { LabReports } from './chat/lab/reportHost';
import { prefetchCodexModels } from './chat/codexSession';

const ENV_NAME = 'CLAUDE_CONFIG_DIR';

let store: ProfileStore;
let envCollection: vscode.EnvironmentVariableCollection;
const statuses = new Map<string, AuthStatus | 'loading'>();
const statusChanged = new vscode.EventEmitter<void>();
/** Terminais de login abertos pela extensão, para atualizar o status quando fecharem. */
const loginTerminals = new Map<vscode.Terminal, string>();
let lastEditor: vscode.TextEditor | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  store = new ProfileStore(context.globalState);
  const external = ExternalProviders.init(context);
  // Tokens do pacote de pesquisa: carregados antes do primeiro chat para as sessões já saírem com eles no ambiente.
  await initResearchSecrets(context.secrets).catch(() => undefined);
  // Aprovações dos servidores do .mcp.json, por conteúdo de entrada: lidas antes de qualquer sessão subir.
  initMcpApprovals(context.workspaceState);
  envCollection = context.environmentVariableCollection;
  envCollection.description = 'Conta do Claude Code escolhida no Claude Profiles';

  lastEditor = vscode.window.activeTextEditor;
  const chatEnv: ChatEnv = {
    context,
    store,
    lastEditor: () => lastEditor,
    profileOptions: () =>
      store.all().map((p) => {
        const status = statuses.get(p.id);
        return {
          id: p.id,
          name: p.name,
          account: status && status !== 'loading' && status.loggedIn ? status.email ?? '' : '',
          provider: isCodex(p) ? ('codex' as const) : ('claude' as const),
        };
      }),
  };
  const openChat = (profile: Profile) => ChatPanel.open(chatEnv, profile);

  const tree = new ProfileTree();
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = 'agentGraphMaster.switch';
  statusBar.show();
  const chatButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  chatButton.text = '$(comment-discussion) Chat';
  chatButton.tooltip = 'Abrir chat do Claude com a conta ativa';
  chatButton.command = 'agentGraphMaster.openChat';
  chatButton.show();

  const updateStatusBar = () => {
    const active = store.active();
    const status = statuses.get(active.id);
    statusBar.text = `$(account) Claude: ${active.name}`;
    const lines = [`**Conta ativa:** ${active.name}`];
    if (status === 'loading' || status === undefined) {
      lines.push('Verificando login...');
    } else if (status.loggedIn) {
      lines.push(`${status.email ?? 'e-mail desconhecido'}${status.subscriptionType ? ` · plano ${status.subscriptionType}` : ''}`);
    } else {
      lines.push('$(warning) Sem login. Clique para trocar ou fazer login.');
    }
    lines.push('', `Pasta: \`${active.configDir}\``, '', 'Clique para trocar de conta.');
    statusBar.tooltip = new vscode.MarkdownString(lines.join('\n\n'), true);
  };

  context.subscriptions.push(
    statusBar,
    chatButton,
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && editor.document.uri.scheme === 'file') {
        lastEditor = editor;
      }
    }),
    vscode.window.registerWebviewPanelSerializer(CHAT_VIEW_TYPE, {
      deserializeWebviewPanel: async (panel, state) => ChatPanel.revive(chatEnv, panel, state as { profileId: string; sessionId?: string }),
    }),
    vscode.window.registerWebviewPanelSerializer(COMPANION_VIEW_TYPE, {
      deserializeWebviewPanel: async (panel, state) => CompanionPanel.revive(chatEnv, panel, state as { profileId: string; sessionId?: string }),
    }),
    vscode.commands.registerCommand('agentGraphMaster.openChat', (item?: ProfileItem) => openChat(item?.profile ?? store.active())),
    vscode.commands.registerCommand('agentGraphMaster.openChatWith', async () => {
      const profile = await pickProfile('Abrir chat com qual conta?');
      if (profile) {
        openChat(profile);
      }
    }),
    vscode.window.registerTreeDataProvider('agentGraphMaster.view', tree),
    // View vazia de propósito: o VS Code mostra no lugar os botões de viewsWelcome (Abrir chat).
    vscode.window.registerTreeDataProvider('agentGraphMaster.chatLauncher', { getTreeItem: (i: vscode.TreeItem) => i, getChildren: () => [] }),
    store.onDidChange(() => {
      tree.refresh();
      updateStatusBar();
    }),
    statusChanged.event(() => {
      tree.refresh();
      updateStatusBar();
    }),
    vscode.window.onDidCloseTerminal((terminal) => {
      const id = loginTerminals.get(terminal);
      if (id) {
        loginTerminals.delete(terminal);
        void refreshStatus(id);
      }
    }),
    vscode.commands.registerCommand('agentGraphMaster.switch', switchProfile),
    vscode.commands.registerCommand('agentGraphMaster.add', addProfile),
    vscode.commands.registerCommand('agentGraphMaster.login', async (item?: ProfileItem) => {
      const profile = item?.profile ?? (await pickProfile('Fazer login em qual conta?'));
      if (profile) {
        await login(profile);
      }
    }),
    vscode.commands.registerCommand('agentGraphMaster.rename', renameProfile),
    vscode.commands.registerCommand('agentGraphMaster.remove', removeProfile),
    vscode.commands.registerCommand('agentGraphMaster.openTerminal', async (item?: ProfileItem) => {
      const profile = item?.profile ?? (await pickProfile('Abrir no terminal com qual conta?'));
      if (profile) {
        if (isCodex(profile)) {
          openProfileTerminal(profile, await codexCommandLine());
        } else {
          openClaudeTerminal(profile, []);
        }
      }
    }),
    vscode.commands.registerCommand('agentGraphMaster.activate', async (item?: ProfileItem) => {
      if (item) {
        await activateProfile(item.profile);
      }
    }),
    // Chaves de API da pesquisa e da geração de imagem: ficam no SecretStorage, nunca no settings.json.
    vscode.commands.registerCommand('agentGraphMaster.setGeminiKey', () => external.promptKey('gemini')),
    vscode.commands.registerCommand('agentGraphMaster.setOpenAIKey', () => external.promptKey('openai')),
    vscode.commands.registerCommand('agentGraphMaster.clearGeminiKey', () => external.clearKey('gemini')),
    vscode.commands.registerCommand('agentGraphMaster.clearOpenAIKey', () => external.clearKey('openai')),
    vscode.commands.registerCommand('agentGraphMaster.configureResearchPack', () => configureResearchPack()),
    vscode.commands.registerCommand('agentGraphMaster.experimentReport', async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        void vscode.window.showErrorMessage('Abra a pasta do projeto antes: o relatório lê o quadro em .agm/lab/.');
        return;
      }
      // Sem chat aberto ainda dá para relatar um ramo ou uma hipótese; o escopo "esta conversa" precisa do chat.
      const reports =
        ChatPanel.labReports() ??
        new LabReports(new Lab(root, () => undefined), { cwd: root, profile: () => store.active(), conversation: () => '', notice: (text) => void vscode.window.showInformationMessage(text) });
      await reports.runCommand();
    }),
    vscode.commands.registerCommand('agentGraphMaster.refresh', async () => {
      await store.importOrphanFolders();
      await refreshAll();
    }),
  );

  await store.importOrphanFolders();
  // Garante que terminais e a extensão oficial estejam alinhados com a conta ativa, mesmo que alguém tenha mexido no settings.json.
  await applyEnvironment(store.active(), true);
  updateStatusBar();
  void refreshAll();
  // O orquestrador lista os modelos do Codex no prompt; lê a lista uma vez, sem gastar token.
  const codexAccount = store.all().find(isCodex);
  if (codexAccount) {
    void prefetchCodexModels(codexAccount, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? codexAccount.configDir);
  }
}

export function deactivate(): void {
  // Grava na hora os agentes que ainda esperavam o salvamento com atraso; nunca pode travar o fechamento.
  try {
    ChatPanel.flushAll();
  } catch (err) {
    console.error('[agent-graph-master] falha ao gravar agentes no deactivate', err);
  }
}

// ---------- Aplicar conta ----------

async function activateProfile(profile: Profile): Promise<void> {
  if (isCodex(profile)) {
    vscode.window.showInformationMessage(
      `"${profile.name}" é uma conta do Codex. A conta ativa só vale para o Claude Code: ela muda o CLAUDE_CONFIG_DIR da extensão oficial e dos terminais. Contas do Codex são usadas direto no chat ou no terminal, cada uma com a própria pasta (CODEX_HOME).`,
    );
    return;
  }
  if (profile.id === store.active().id) {
    vscode.window.showInformationMessage(`A conta "${profile.name}" já está ativa.`);
    return;
  }
  const status = statuses.get(profile.id);
  if (status && status !== 'loading' && !status.loggedIn) {
    const choice = await vscode.window.showWarningMessage(
      `A conta "${profile.name}" ainda não tem login. Ativar mesmo assim?`,
      'Fazer login antes',
      'Ativar assim mesmo',
    );
    if (choice === 'Fazer login antes') {
      openLoginTerminal(profile);
      return;
    }
    if (choice !== 'Ativar assim mesmo') {
      return;
    }
  }

  await store.setActive(profile.id);
  const ok = await applyEnvironment(profile, false);
  if (!ok) {
    return;
  }

  const after = vscode.workspace.getConfiguration('agentGraphMaster').get<string>('afterSwitch', 'ask');
  if (after === 'reload') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
    return;
  }
  if (after === 'ask') {
    const choice = await vscode.window.showInformationMessage(
      `Conta "${profile.name}" ativa. Sessões e terminais novos já usam essa conta. As sessões abertas continuam na conta anterior até você recarregar a janela.`,
      'Recarregar janela',
    );
    if (choice === 'Recarregar janela') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  }
}

/**
 * Escreve CLAUDE_CONFIG_DIR em dois lugares:
 * 1. claudeCode.environmentVariables (settings do usuário), lido pela extensão oficial ao iniciar o processo do Claude;
 * 2. a coleção de variáveis dos terminais do VS Code, para quem roda `claude` direto no terminal.
 */
async function applyEnvironment(profile: Profile, silent: boolean): Promise<boolean> {
  const dir = configDirEnv(profile);
  if (dir) {
    envCollection.replace(ENV_NAME, dir);
  } else {
    envCollection.delete(ENV_NAME);
  }

  const config = vscode.workspace.getConfiguration('claudeCode');
  const inspected = config.inspect<{ name: string; value: string }[]>('environmentVariables');
  if (!inspected) {
    if (!silent) {
      vscode.window.showWarningMessage(
        'A extensão oficial do Claude Code não foi encontrada. A troca vale só para terminais (comando `claude`).',
      );
    }
    return true;
  }
  const current = inspected.globalValue ?? [];
  const existing = current.find((v) => v.name === ENV_NAME)?.value;
  if (existing === dir) {
    return true;
  }
  const next = current.filter((v) => v.name !== ENV_NAME);
  if (dir) {
    next.push({ name: ENV_NAME, value: dir });
  }
  try {
    await config.update('environmentVariables', next, vscode.ConfigurationTarget.Global);
    return true;
  } catch (err) {
    vscode.window.showErrorMessage(`Não consegui gravar claudeCode.environmentVariables: ${String(err)}`);
    return false;
  }
}

// ---------- Comandos ----------

async function switchProfile(): Promise<void> {
  type Item = vscode.QuickPickItem & { profile?: Profile; action?: 'add' };
  const activeId = store.active().id;
  const items: Item[] = store.all().filter((p) => !isCodex(p)).map((profile) => ({
    label: `${profile.id === activeId ? '$(check)' : '$(account)'} ${profile.name}`,
    description: describeStatus(profile.id),
    detail: profile.configDir,
    profile,
  }));
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: '$(add) Adicionar conta', action: 'add' });

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Claude Profiles',
    placeHolder: 'Escolha a conta que o Claude Code vai usar (contas do Codex não entram aqui)',
    matchOnDescription: true,
  });
  if (!picked) {
    return;
  }
  if (picked.action === 'add') {
    await addProfile();
  } else if (picked.profile) {
    await activateProfile(picked.profile);
  }
}

async function addProfile(): Promise<void> {
  type Item = vscode.QuickPickItem & { provider: Provider };
  const picked = await vscode.window.showQuickPick<Item>(
    [
      { label: '$(account) Claude', description: 'Anthropic · Claude Code', detail: 'Login pela conta Claude (Pro/Max) ou pelo console da Anthropic', provider: 'claude' },
      { label: '$(robot) Codex', description: 'OpenAI · Codex CLI', detail: 'Login pela conta do ChatGPT ou com chave de API da OpenAI', provider: 'codex' },
    ],
    { title: 'Adicionar conta', placeHolder: 'De qual fornecedor é a conta?' },
  );
  if (!picked) {
    return;
  }
  if (picked.provider === 'codex') {
    await addCodexProfile();
    return;
  }
  const name = await vscode.window.showInputBox({
    title: 'Nova conta do Claude',
    prompt: 'Nome para identificar a conta (ex.: Pessoal, Trabalho)',
    validateInput: (value) => (value.trim() ? undefined : 'Digite um nome'),
  });
  if (!name) {
    return;
  }
  const profile = await store.add(name.trim());
  statuses.set(profile.id, { loggedIn: false });
  statusChanged.fire();

  const choice = await vscode.window.showInformationMessage(
    `Conta "${profile.name}" criada. O login é feito uma única vez pelo navegador, depois a troca é direta.`,
    'Fazer login agora',
  );
  if (choice === 'Fazer login agora') {
    openLoginTerminal(profile);
  }
}

async function renameProfile(item?: ProfileItem): Promise<void> {
  const profile = item?.profile ?? (await pickProfile('Renomear qual conta?', true));
  if (!profile) {
    return;
  }
  const name = await vscode.window.showInputBox({
    title: 'Renomear conta',
    value: profile.name,
    validateInput: (value) => (value.trim() ? undefined : 'Digite um nome'),
  });
  if (name) {
    await store.rename(profile.id, name.trim());
  }
}

async function removeProfile(item?: ProfileItem): Promise<void> {
  const profile = item?.profile ?? (await pickProfile('Remover qual conta?', true));
  if (!profile) {
    return;
  }
  const shared = isSharedFolder(profile);
  const choice = await vscode.window.showWarningMessage(
    `Remover a conta "${profile.name}"?`,
    {
      modal: true,
      detail: shared
        ? `A pasta ${profile.configDir} é o login padrão do ${isCodex(profile) ? 'Codex' : 'Claude'} nesta máquina e continua onde está.`
        : `Apagar a pasta também remove o login salvo e o histórico dessa conta:\n${profile.configDir}`,
    },
    ...(shared ? ['Remover da lista'] : ['Remover da lista', 'Remover e apagar pasta']),
  );
  if (!choice) {
    return;
  }
  const wasActive = store.active().id === profile.id;
  await store.remove(profile.id, choice === 'Remover e apagar pasta');
  statuses.delete(profile.id);
  if (wasActive) {
    await applyEnvironment(store.active(), false);
    vscode.window.showInformationMessage('A conta removida era a ativa. Voltei para a conta Padrão.');
  }
}

async function pickProfile(placeHolder: string, customOnly = false): Promise<Profile | undefined> {
  const profiles = store.all().filter((p) => !customOnly || p.id !== DEFAULT_ID);
  if (!profiles.length) {
    vscode.window.showInformationMessage('Nenhuma conta extra cadastrada ainda.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    profiles.map((profile) => ({ label: profile.name, description: describeStatus(profile.id), profile })),
    { placeHolder },
  );
  return picked?.profile;
}

// ---------- Contas do Codex ----------

async function addCodexProfile(): Promise<void> {
  if (!(await resolveCodexExecutable())) {
    const choice = await vscode.window.showWarningMessage(
      'Não achei o Codex CLI nesta máquina. Instale com `npm i -g @openai/codex` (ou informe o caminho em agentGraphMaster.codexPath) antes de fazer login.',
      'Criar a conta mesmo assim',
    );
    if (!choice) {
      return;
    }
  }
  const name = await vscode.window.showInputBox({
    title: 'Nova conta do Codex',
    prompt: 'Nome para identificar a conta (ex.: ChatGPT pessoal, Trabalho)',
    validateInput: (value) => (value.trim() ? undefined : 'Digite um nome'),
  });
  if (!name) {
    return;
  }

  // O login feito fora da extensão (codex no terminal, extensão da OpenAI) fica em ~/.codex. Dá para reaproveitar.
  const home = defaultCodexHome();
  let existingDir: string | undefined;
  const homeTaken = store.all().some((p) => isCodex(p) && isSharedCodexHome(p.configDir));
  if (!homeTaken && fs.existsSync(path.join(home, 'auth.json'))) {
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(check) Usar o login que já existe', detail: `${home}, o mesmo do codex no terminal e da extensão da OpenAI`, reuse: true },
        { label: '$(add) Login separado', detail: `Pasta nova em ${codexProfilesRoot()}, com login próprio`, reuse: false },
      ],
      { title: `Esta máquina já tem um login do Codex em ${home}`, placeHolder: 'Qual login a conta vai usar?' },
    );
    if (!pick) {
      return;
    }
    existingDir = pick.reuse ? home : undefined;
  }

  const profile = await store.add(name.trim(), 'codex', existingDir);
  if (existingDir) {
    await refreshStatus(profile.id);
    vscode.window.showInformationMessage(`Conta do Codex "${profile.name}" criada com o login de ${existingDir}.`);
    return;
  }
  statuses.set(profile.id, { loggedIn: false });
  statusChanged.fire();
  const choice = await vscode.window.showInformationMessage(
    `Conta do Codex "${profile.name}" criada em ${profile.configDir}. O login é feito uma vez, pela conta do ChatGPT ou com chave de API.`,
    'Fazer login agora',
  );
  if (choice === 'Fazer login agora') {
    await login(profile);
  }
}

async function login(profile: Profile): Promise<void> {
  if (!isCodex(profile)) {
    openLoginTerminal(profile);
    return;
  }
  type Item = vscode.QuickPickItem & { how: 'browser' | 'device' | 'apiKey' };
  const how = await vscode.window.showQuickPick<Item>(
    [
      { label: '$(globe) Conta do ChatGPT', detail: 'Abre o navegador para entrar (Plus, Pro, Business...)', how: 'browser' },
      { label: '$(device-mobile) Conta do ChatGPT por código', detail: 'Mostra um código para digitar em outro aparelho; serve quando não há navegador aqui', how: 'device' },
      { label: '$(key) Chave de API da OpenAI', detail: 'Uso cobrado por token na conta da API', how: 'apiKey' },
    ],
    { title: `Login do Codex · ${profile.name}`, placeHolder: 'Como entrar?' },
  );
  if (!how) {
    return;
  }
  if (how.how === 'apiKey') {
    const key = await vscode.window.showInputBox({
      title: `Chave de API · ${profile.name}`,
      prompt: 'Cole a chave (sk-...). Ela vai direto para o Codex, que grava no auth.json da conta.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim().length > 20 ? undefined : 'Chave curta demais'),
    });
    if (!key) {
      return;
    }
    try {
      await loginWithApiKey(profile, key);
      vscode.window.showInformationMessage(`Chave de API gravada na conta "${profile.name}".`);
    } catch (err) {
      vscode.window.showErrorMessage(`O Codex não aceitou a chave: ${err instanceof Error ? err.message : String(err)}`);
    }
    await refreshStatus(profile.id);
    return;
  }
  const command = `${await codexCommandLine()} login${how.how === 'device' ? ' --device-auth' : ''}`;
  const terminal = openProfileTerminal(profile, command, true);
  loginTerminals.set(terminal, profile.id);
  vscode.window.showInformationMessage(
    `Login do Codex na conta "${profile.name}": conclua ${how.how === 'device' ? 'digitando o código mostrado no terminal' : 'no navegador que vai abrir'}. Depois feche o terminal (ou aperte uma tecla nele) para atualizar o status.`,
  );
}

// ---------- Terminais ----------

function openLoginTerminal(profile: Profile): void {
  const terminal = openClaudeTerminal(profile, ['auth', 'login'], true);
  loginTerminals.set(terminal, profile.id);
  vscode.window.showInformationMessage(
    `Login da conta "${profile.name}": conclua no navegador que vai abrir. Depois feche o terminal (ou aperte uma tecla nele) para atualizar o status.`,
  );
}

function openClaudeTerminal(profile: Profile, args: string[], closeWhenDone = false): vscode.Terminal {
  return openProfileTerminal(profile, [claudeCommand(), ...args].join(' '), closeWhenDone);
}

/**
 * Abre um terminal que roda o comando com a pasta da conta: CLAUDE_CONFIG_DIR no Claude, CODEX_HOME no Codex.
 * A variável é definida dentro do próprio comando para não depender da coleção global de variáveis, que aponta
 * para a conta ativa.
 */
function openProfileTerminal(profile: Profile, command: string, closeWhenDone = false): vscode.Terminal {
  const codex = isCodex(profile);
  const envName = codex ? 'CODEX_HOME' : ENV_NAME;
  const dir = codex ? profile.configDir : configDirEnv(profile);
  let shellPath: string;
  let shellArgs: string[] | string;
  if (process.platform === 'win32') {
    // String crua: com array, o VS Code escaparia as aspas no formato do C runtime, que o cmd não entende.
    const setEnv = dir ? `set "${envName}=${dir}"` : `set "${envName}="`;
    shellPath = process.env.ComSpec || 'cmd.exe';
    shellArgs = closeWhenDone ? `/d /c ${setEnv} && ${command} & pause` : `/d /k ${setEnv} && ${command}`;
  } else {
    const setEnv = dir ? `export ${envName}=${shellQuote(dir)}` : `unset ${envName}`;
    shellPath = '/bin/sh';
    shellArgs = closeWhenDone
      ? ['-c', `${setEnv}; ${command}; printf '\\nPressione Enter para fechar'; read _`]
      : ['-c', `${setEnv}; ${command}; exec "\${SHELL:-/bin/sh}"`];
  }
  const terminal = vscode.window.createTerminal({
    name: `${codex ? 'Codex' : 'Claude'} · ${profile.name}`,
    shellPath,
    shellArgs,
    iconPath: new vscode.ThemeIcon(codex ? 'robot' : 'account'),
  });
  terminal.show();
  return terminal;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ---------- Status de login ----------

async function refreshStatus(id: string): Promise<void> {
  const profile = store.get(id);
  if (!profile) {
    return;
  }
  statuses.set(id, 'loading');
  statusChanged.fire();
  statuses.set(id, await readAuthStatus(profile));
  statusChanged.fire();
}

async function refreshAll(): Promise<void> {
  await Promise.all(store.all().map((p) => refreshStatus(p.id)));
}

function describeStatus(id: string): string {
  const status = statuses.get(id);
  if (status === undefined || status === 'loading') {
    return 'verificando...';
  }
  if (!status.loggedIn) {
    return status.error ? `erro: ${status.error}` : 'sem login';
  }
  return [status.email, status.subscriptionType].filter(Boolean).join(' · ') || 'logado';
}

// ---------- Painel lateral ----------

class ProfileItem extends vscode.TreeItem {
  constructor(readonly profile: Profile, isActive: boolean) {
    super(profile.name, vscode.TreeItemCollapsibleState.None);
    const status = statuses.get(profile.id);
    const loggedOut = status !== undefined && status !== 'loading' && !status.loggedIn;
    if (isCodex(profile)) {
      // Sem "active"/"inactive" no contextValue: o botão "Usar esta conta" (menu por viewItem) não aparece.
      this.description = `Codex · ${describeStatus(profile.id)}`;
      this.tooltip = `${profile.name} (Codex)\n${describeStatus(profile.id)}\nCODEX_HOME: ${profile.configDir}\n\nNão entra na troca de conta ativa, que só vale para o Claude Code.`;
      this.iconPath = new vscode.ThemeIcon(loggedOut ? 'warning' : 'robot');
      this.contextValue = 'profile codex custom';
      return;
    }
    this.description = `${isActive ? 'ativa · ' : ''}${describeStatus(profile.id)}`;
    this.tooltip = `${profile.name}\n${describeStatus(profile.id)}\n${profile.configDir}`;
    this.iconPath = new vscode.ThemeIcon(
      isActive ? 'pass-filled' : loggedOut ? 'warning' : 'account',
      isActive ? new vscode.ThemeColor('charts.green') : undefined,
    );
    this.contextValue = ['profile', isActive ? 'active' : 'inactive', profile.id === DEFAULT_ID ? 'builtin' : 'custom'].join(' ');
  }
}

class ProfileTree implements vscode.TreeDataProvider<ProfileItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(item: ProfileItem): vscode.TreeItem {
    return item;
  }

  getChildren(): ProfileItem[] {
    const activeId = store.active().id;
    // Claude primeiro, Codex depois; dentro de cada grupo, a ordem de criação.
    const ordered = [...store.all().filter((p) => !isCodex(p)), ...store.all().filter(isCodex)];
    return ordered.map((profile) => new ProfileItem(profile, profile.id === activeId));
  }
}
