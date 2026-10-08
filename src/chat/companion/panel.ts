import * as vscode from 'vscode';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { ChatEnv } from '../panel';
import type { Profile } from '../../profiles';
import { ChatSession } from '../session';
import { FileIndex, editorFiles } from '../fileIndex';
import { handleImageMessage } from '../imageFiles';
import type { HistoryItem, HostMessage, WebviewMessage } from '../protocol';
import { COMPANION_SERVER, createCompanionServer } from './tools';
import { COMPANION_BLOCKED_TOOLS, companionHooks, companionSystemAppend } from './policy';
import { CompanionStore } from './store';
import type { CompanionAgent, CompanionSource } from './types';

export const COMPANION_VIEW_TYPE = 'agentGraphMaster.companion';

/** O chat principal visto pelo lateral. O painel principal entrega isto; nada aqui escreve sem clique do usuário. */
export interface CompanionLink {
  profile: Profile;
  /** Conversa principal atual (vazia até o primeiro init do CLI). */
  mainSessionId(): string | undefined;
  /** O painel principal continua aberto. */
  alive(): boolean;
  source(): CompanionSource;
  /** "Enviar ao principal": entra na conversa principal como mensagem do usuário, marcada como vinda da consulta. */
  sendToMain(text: string): void;
  /** Revela a aba principal (depois de enviar, se o usuário quiser ver). */
  revealMain(): void;
}

/** O que o painel principal fornece uma vez, na ativação: achar a conversa principal e ler histórico salvo. */
export interface CompanionSetup {
  findLink(mainSessionId: string): CompanionLink | undefined;
  loadHistory(profile: Profile, cwd: string, sessionId: string): Promise<HistoryItem[]>;
}

interface CompanionState {
  profileId: string;
  sessionId?: string;
}

/**
 * Chat lateral de consulta: aba ao lado do chat principal, com sessão própria do Claude, só leitura.
 * Um por conversa principal. Nada do que se diz aqui entra no contexto do orquestrador.
 */
export class CompanionPanel {
  private static readonly all = new Set<CompanionPanel>();
  private static setupDeps?: CompanionSetup;

  readonly session: ChatSession;
  private ready = false;
  private outbox: HostMessage[] = [];
  private readonly files: FileIndex;
  private readonly store: CompanionStore;
  /** Conversa principal a que este lateral pertence; conhecida desde o início, ou assim que o principal tiver id. */
  private mainId?: string;
  private prefill?: string;

  /** O painel principal chama uma vez, na ativação. */
  static setup(deps: CompanionSetup): void {
    CompanionPanel.setupDeps = deps;
  }

  /** Abre (ou revela) o lateral da conversa principal. `prefill` vai para a caixa de texto, sem enviar. */
  static show(env: ChatEnv, link: CompanionLink, prefill?: string): CompanionPanel {
    const existing = CompanionPanel.forLink(link);
    if (existing) {
      existing.reveal(prefill);
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(COMPANION_VIEW_TYPE, '', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, CompanionPanel.webviewOptions(env.context));
    const mainId = link.mainSessionId();
    const resumeId = mainId ? new CompanionStore(env.context.workspaceState).sessionFor(mainId) : undefined;
    return new CompanionPanel(env, panel, link.profile, link, mainId, resumeId, prefill);
  }

  /** Recria a aba depois de recarregar a janela. O principal pode ainda não ter voltado: o link é procurado a cada uso. */
  static revive(env: ChatEnv, panel: vscode.WebviewPanel, state: CompanionState | undefined): void {
    const profile = (state && env.store.get(state.profileId)) ?? env.store.active();
    panel.webview.options = CompanionPanel.webviewOptions(env.context);
    const mainId = state?.sessionId ? new CompanionStore(env.context.workspaceState).mainFor(state.sessionId) : undefined;
    new CompanionPanel(env, panel, profile, undefined, mainId, state?.sessionId);
  }

  /** O lateral já aberto desta conversa principal, se houver. */
  static forLink(link: CompanionLink): CompanionPanel | undefined {
    const id = link.mainSessionId();
    return [...CompanionPanel.all].find((p) => p.link === link || (!!id && p.mainId === id));
  }

  /** O principal mudou de nome: as abas laterais dele acompanham. */
  static retitleAll(): void {
    for (const p of CompanionPanel.all) {
      p.retitle();
    }
  }

  static disposeAll(): void {
    for (const p of CompanionPanel.all) {
      p.panel.dispose();
    }
  }

  private static webviewOptions(context: vscode.ExtensionContext): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out'), vscode.Uri.joinPath(context.extensionUri, 'media')],
    };
  }

  private constructor(
    private readonly env: ChatEnv,
    private readonly panel: vscode.WebviewPanel,
    readonly profile: Profile,
    private link: CompanionLink | undefined,
    mainId: string | undefined,
    private readonly resumeId: string | undefined,
    prefill?: string,
  ) {
    CompanionPanel.all.add(this);
    this.mainId = mainId;
    this.prefill = prefill;
    this.store = new CompanionStore(env.context.workspaceState);
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const config = vscode.workspace.getConfiguration('agentGraphMaster');
    this.session = new ChatSession(profile, cwd, (msg) => this.post(msg), {
      model: config.get<string>('companion.model', 'sonnet').trim() || 'sonnet',
      effort: config.get<string>('companion.effort', 'medium').trim(),
      // Sempre "perguntar antes": o hook libera a leitura e força o pedido nos comandos.
      permissionMode: 'default',
      mcpServers: () => ({ [COMPANION_SERVER]: createCompanionServer(() => this.source()) }),
      systemAppend: () => companionSystemAppend(this.mainTitle()),
      disallowedTools: COMPANION_BLOCKED_TOOLS,
      hooks: companionHooks,
    });
    this.files = FileIndex.acquire(cwd);
    panel.iconPath = vscode.Uri.joinPath(env.context.extensionUri, 'media', 'icon.svg');
    this.retitle();
    panel.webview.html = this.html();
    panel.webview.onDidReceiveMessage((msg: WebviewMessage) => void this.onMessage(msg));
    panel.onDidDispose(() => {
      CompanionPanel.all.delete(this);
      this.files.release();
      this.session.dispose();
    });
  }

  reveal(prefill?: string): void {
    this.panel.reveal(vscode.ViewColumn.Beside);
    this.post({ type: 'companionExamples', examples: this.examples() });
    if (prefill) {
      this.post({ type: 'companionPrefill', text: prefill });
    }
  }

  retitle(): void {
    this.panel.title = `Consulta · ${shorten(this.mainTitle(), 40)}`;
  }

  // ---------- Ligação com o chat principal ----------

  /** O principal aberto agora: o link direto, ou o que a conversa guardada aponta (depois de recarregar a janela). */
  private currentLink(): CompanionLink | undefined {
    if (this.link?.alive()) {
      return this.link;
    }
    const id = this.mainId ?? this.link?.mainSessionId();
    const found = id ? CompanionPanel.setupDeps?.findLink(id) : undefined;
    if (found) {
      this.link = found;
    }
    return found;
  }

  private source(): CompanionSource | undefined {
    return this.currentLink()?.source();
  }

  private mainTitle(): string {
    return this.source()?.title() ?? 'conversa principal';
  }

  /** Grava o par principal → lateral assim que os dois ids existem. */
  private remember(): void {
    this.mainId ??= this.link?.mainSessionId();
    if (this.mainId && this.session.sessionId) {
      this.store.save(this.mainId, this.session.sessionId);
    }
  }

  // ---------- Webview ----------

  private post(msg: HostMessage): void {
    if (msg.type === 'session') {
      this.remember();
    }
    if (msg.type === 'result') {
      // O principal pode ter ganhado nome novo enquanto conversávamos.
      this.retitle();
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
        this.session.send(msg.text, msg.attachments);
        return;
      case 'interrupt':
        await this.session.interrupt();
        return;
      case 'permission': {
        const { requestId, type: _type, ...answer } = msg;
        this.session.respondPermission(requestId, answer);
        return;
      }
      case 'setModel':
        await this.session.setModel(msg.value);
        return;
      case 'setEffort':
        this.session.setEffort(msg.value);
        return;
      case 'listCommands':
        this.session.postCommands();
        return;
      case 'searchFiles': {
        const found = await this.files.search(msg.query, editorFiles(this.env.lastEditor()));
        this.post({ type: 'fileResults', requestId: msg.requestId, ...found });
        return;
      }
      case 'openFile':
        await this.openProjectFile(msg.path);
        return;
      case 'resolveImages':
      case 'imageAction':
        // Sem o projeto no localResourceRoots: as imagens chegam como data URL.
        await handleImageMessage(this.panel.webview, msg, this.session.cwd, [], (m) => this.post(m));
        return;
      case 'companionToMain':
        this.sendToMain(msg.text);
        return;
      // O resto (modo de permissão, agentes, navegador, histórico...) não existe no chat lateral.
    }
  }

  private async onReady(): Promise<void> {
    const firstLoad = !this.ready;
    this.ready = true;
    this.post({
      type: 'init',
      profileId: this.profile.id,
      profileName: this.profile.name,
      account: this.env.profileOptions().find((p) => p.id === this.profile.id)?.account ?? '',
      cwd: this.session.cwd,
      permissionMode: 'default',
      model: this.session.model,
      effort: this.session.effort,
      provider: 'claude',
      sessionTitle: this.mainTitle(),
      companion: { mainTitle: this.mainTitle(), examples: this.examples() },
    });
    for (const msg of this.outbox.splice(0)) {
      void this.panel.webview.postMessage(msg);
    }
    if (!firstLoad) {
      return;
    }
    const resumeId = this.resumeId;
    if (resumeId && CompanionPanel.setupDeps) {
      try {
        this.post({ type: 'history', items: await CompanionPanel.setupDeps.loadHistory(this.profile, this.session.cwd, resumeId), title: '' });
      } catch (err) {
        this.post({ type: 'notice', level: 'error', text: `Não consegui carregar a consulta anterior: ${String(err)}` });
      }
    }
    this.session.start(resumeId);
    this.post({ type: 'session', sessionId: this.session.sessionId ?? '', model: this.session.model, permissionMode: 'default' });
    if (this.prefill) {
      this.post({ type: 'companionPrefill', text: this.prefill });
      this.prefill = undefined;
    }
  }

  /** Só o clique em "Enviar ao principal" chega aqui. */
  private sendToMain(raw: string): void {
    const text = raw.trim();
    if (!text) {
      return;
    }
    const link = this.currentLink();
    if (!link) {
      this.post({ type: 'notice', level: 'error', text: 'O chat principal desta consulta está fechado; nada foi enviado.' });
      return;
    }
    link.sendToMain(text);
    this.post({ type: 'notice', level: 'info', text: 'Enviado ao chat principal como mensagem sua, marcada como vinda da consulta lateral.' });
  }

  /** As três perguntas do estado vazio, com os ids dos agentes desta conversa. */
  private examples(): string[] {
    const agents = this.source()?.agents() ?? [];
    const lastActive = pickLast(agents, (a) => a.info.status === 'running' && !a.info.restored) ?? pickLast(agents, () => true);
    const lastFailed = pickLast(agents, (a) => a.info.status === 'failed');
    return [
      lastActive ? `O que o agente ${lastActive.info.id} ("${shorten(lastActive.info.description, 40)}") está fazendo agora?` : 'O que o chat principal está fazendo agora?',
      lastFailed ? `Por que o ${lastFailed.info.id} ("${shorten(lastFailed.info.description, 40)}") falhou?` : 'Algum agente falhou ou está travado?',
      'Resuma o estado do laboratório',
    ];
  }

  private async openProjectFile(rel: string): Promise<void> {
    const root = path.resolve(this.session.cwd);
    const abs = path.resolve(root, rel);
    const inside = path.relative(root, abs);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
      return;
    }
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(abs), { preview: true, viewColumn: vscode.ViewColumn.One });
  }

  private html(): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.env.context.extensionUri, ...p));
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('media', 'codicons', 'codicon.css')}">
<link rel="stylesheet" href="${uri('media', 'chat.css')}">
<title>Consulta lateral</title>
</head>
<body class="companion">
<div id="app"></div>
<script nonce="${nonce}" src="${uri('out', 'webview.js')}"></script>
</body>
</html>`;
  }
}

/** O mais recente que passa no filtro (a lista vem na ordem de criação). */
function pickLast(list: CompanionAgent[], ok: (a: CompanionAgent) => boolean): CompanionAgent | undefined {
  return list.filter(ok).at(-1);
}

function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
