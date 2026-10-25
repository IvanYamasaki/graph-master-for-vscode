import * as vscode from 'vscode';
import { ChatEnv, ChatPanel } from './chat/panel';
import { readHistory } from './chat/historySource';
import { RecentRow, recentRows } from './chat/sidebarModel';

/**
 * Seção "Chat" da barra lateral: o item "Novo chat", as abas de chat abertas e as conversas recentes do projeto
 * em todas as contas Claude. Recentes lê o disco (~1,7 s em projeto grande), então só recarrega ao atualizar, ao
 * expandir pela primeira vez e quando uma aba abre ou fecha.
 */

type Node =
  | { kind: 'new' }
  | { kind: 'group'; id: 'open' | 'recent' }
  | { kind: 'open'; index: number }
  | { kind: 'recent'; row: RecentRow }
  | { kind: 'loading' }
  | { kind: 'empty'; text: string };

const SHORTCUT = 'Ctrl+Shift+Alt+K';

class ChatSidebar implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private rows: RecentRow[] | undefined;
  private error = '';
  private loading = false;
  private seq = 0;
  private readonly cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  constructor(private readonly env: ChatEnv) {}

  refresh(): void {
    this.rows = undefined;
    void this.load();
  }

  /** Aba abriu, fechou ou mudou de título. As recentes só recarregam se já foram lidas. */
  tabsChanged(): void {
    if (this.rows) {
      void this.load();
    } else {
      this.changed.fire(undefined);
    }
  }

  private async load(): Promise<void> {
    if (!this.cwd) {
      return;
    }
    const mine = ++this.seq;
    this.loading = true;
    this.changed.fire(undefined);
    try {
      const entries = await readHistory(this.env.store.all(), this.cwd);
      if (mine !== this.seq) {
        return;
      }
      this.rows = recentRows(entries);
      this.error = '';
    } catch (err) {
      if (mine !== this.seq) {
        return;
      }
      this.rows = [];
      this.error = String(err);
    }
    this.loading = false;
    this.changed.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'new': {
        const item = new vscode.TreeItem('Novo chat');
        item.iconPath = new vscode.ThemeIcon('add');
        item.tooltip = `Abre um chat com a conta ativa (${SHORTCUT})`;
        item.command = { command: 'agentGraphMaster.openChat', title: 'Novo chat' };
        return item;
      }
      case 'group': {
        const open = node.id === 'open';
        const item = new vscode.TreeItem(open ? 'Abertos' : 'Recentes', open ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `group-${node.id}`;
        return item;
      }
      case 'open': {
        const tab = ChatPanel.openTabs()[node.index];
        const item = new vscode.TreeItem(tab?.title || 'Nova conversa');
        item.description = tab?.profileName;
        item.iconPath = new vscode.ThemeIcon('comment-discussion');
        item.tooltip = 'Mostrar esta aba';
        item.command = { command: 'agentGraphMaster.chatReveal', title: 'Mostrar a aba', arguments: [node.index] };
        return item;
      }
      case 'recent': {
        const item = new vscode.TreeItem(node.row.label);
        item.description = node.row.description;
        item.iconPath = new vscode.ThemeIcon('history');
        item.tooltip = `${node.row.label}\n${node.row.description}\nClique para abrir (ou mostrar, se já estiver aberta).`;
        item.command = { command: 'agentGraphMaster.chatResume', title: 'Abrir a conversa', arguments: [node.row.id, node.row.profileId] };
        return item;
      }
      case 'loading': {
        const item = new vscode.TreeItem('Carregando…');
        item.iconPath = new vscode.ThemeIcon('loading~spin');
        return item;
      }
      case 'empty': {
        const item = new vscode.TreeItem(node.text);
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
      }
    }
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return [{ kind: 'new' }, { kind: 'group', id: 'open' }, { kind: 'group', id: 'recent' }];
    }
    if (node.kind !== 'group') {
      return [];
    }
    if (node.id === 'open') {
      const tabs = ChatPanel.openTabs();
      return tabs.length ? tabs.map((_, index) => ({ kind: 'open' as const, index })) : [{ kind: 'empty', text: 'Nenhum chat aberto' }];
    }
    if (!this.cwd) {
      return [{ kind: 'empty', text: 'Abra uma pasta para ver as conversas' }];
    }
    if (!this.rows) {
      if (!this.loading) {
        void this.load();
      }
      return [{ kind: 'loading' }];
    }
    if (this.error) {
      return [{ kind: 'empty', text: `Não deu para ler: ${this.error}` }];
    }
    if (!this.rows.length) {
      return [{ kind: 'empty', text: 'Nenhuma conversa neste projeto' }];
    }
    return this.rows.map((row) => ({ kind: 'recent' as const, row }));
  }
}

export function registerChatSidebar(env: ChatEnv): vscode.Disposable[] {
  const provider = new ChatSidebar(env);
  return [
    vscode.window.createTreeView('agentGraphMaster.chatLauncher', { treeDataProvider: provider }),
    ChatPanel.onDidChangeTabs(() => provider.tabsChanged()),
    // Atalhos dos botões do título (ícone próprio); o item "Novo chat" roda openChat direto.
    vscode.commands.registerCommand('agentGraphMaster.chatNew', () => vscode.commands.executeCommand('agentGraphMaster.openChat')),
    vscode.commands.registerCommand('agentGraphMaster.chatNewWith', () => vscode.commands.executeCommand('agentGraphMaster.openChatWith')),
    vscode.commands.registerCommand('agentGraphMaster.chatRefresh', () => provider.refresh()),
    vscode.commands.registerCommand('agentGraphMaster.chatReveal', (index: number) => ChatPanel.openTabs()[index]?.reveal()),
    vscode.commands.registerCommand('agentGraphMaster.chatResume', (sessionId: string, profileId: string) => {
      const open = ChatPanel.openTabs().find((t) => t.sessionId === sessionId);
      if (open) {
        open.reveal();
        return;
      }
      const profile = env.store.get(profileId);
      if (!profile) {
        void vscode.window.showWarningMessage('A conta desta conversa não existe mais.');
        return;
      }
      ChatPanel.open(env, profile, { resumeId: sessionId, viewColumn: ChatPanel.preferredColumn() });
    }),
  ];
}
