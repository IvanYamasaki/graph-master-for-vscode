import * as vscode from 'vscode';
import { JEV_PROVIDER_LABEL, fmtJevUsd } from './chat/jev';
import { JevAccounts } from './chat/jevAccounts';
import { JEV_AUTO_SETTING, JevAutoUse } from './chat/jevAuto';

/**
 * Seção "Jev" da barra lateral: a conta em uso, a ferramenta jev_decide e os quatro usos automáticos como caixas de
 * marcar (gravam em agentGraphMaster.jev.* nas configurações do usuário) e o teste de latência.
 */

const TOGGLES: { setting: string; label: string; tooltip: string }[] = [
  { setting: 'jev.enabled', label: 'Ferramenta jev_decide', tooltip: 'O Claude e os agentes podem consultar o Jev quando acharem que vale.' },
  ...(
    [
      ['spawnRouting', 'Escolher modelo dos agentes', 'Quando o spawn_agent não diz modelo ou effort, o Jev escolhe (só com confiança ≥ 0,7).'],
      ['stuckCheck', 'Conferir agente preso', 'Antes do cartão de agente preso, o Jev diz se as chamadas recentes ainda avançam.'],
      ['reportCheck', 'Conferir relatório final', 'Relatório que claramente não responde à tarefa volta ao agente uma vez.'],
      ['proposalFilter', 'Filtrar propostas de vigias', 'Segura proposta repetida ou que claramente não é tarefa sua (fica uma linha no log).'],
    ] as [JevAutoUse, string, string][]
  ).map(([use, label, tooltip]) => ({ setting: JEV_AUTO_SETTING[use], label, tooltip: `${tooltip} O texto vai para a TypeSafe ou a Vercel; sem resposta em 4 s, segue a regra antiga.` })),
];

const config = () => vscode.workspace.getConfiguration('agentGraphMaster');

class JevItem extends vscode.TreeItem {
  constructor(
    label: string,
    readonly setting?: string,
  ) {
    super(label);
  }
}

export class JevView implements vscode.TreeDataProvider<JevItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly jev: JevAccounts) {}

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(item: JevItem): vscode.TreeItem {
    return item;
  }

  getChildren(): JevItem[] {
    const account = this.jev.active();
    const any = this.jev.all();
    if (!any.length) {
      const add = new JevItem('Adicionar conta Jev');
      add.iconPath = new vscode.ThemeIcon('add');
      add.command = { command: 'agentGraphMaster.addJevAccount', title: 'Adicionar conta Jev' };
      return [add];
    }
    const shown = account ?? any[0];
    const head = new JevItem(shown.name);
    head.description = `${JEV_PROVIDER_LABEL[shown.provider]} · ${shown.spent.calls} consultas · ${fmtJevUsd(shown.spent.usd)}`;
    head.iconPath = new vscode.ThemeIcon(shown.status === 'ok' ? 'pass-filled' : 'error');
    head.tooltip = shown.status === 'ok' ? 'Conta Jev em uso' : `Chave recusada: ${shown.error ?? ''}`;
    const toggles = TOGGLES.map((t) => {
      const item = new JevItem(t.label, t.setting);
      const on = config().get<boolean>(t.setting, t.setting === 'jev.enabled');
      item.checkboxState = on ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
      item.tooltip = t.tooltip;
      return item;
    });
    const test = new JevItem('Testar latência');
    test.iconPath = new vscode.ThemeIcon('pulse');
    test.command = { command: 'agentGraphMaster.testJev', title: 'Testar o Jev (latência)' };
    return [head, ...toggles, test];
  }

  /** Caixa marcada ou desmarcada: grava nas configurações do usuário. */
  async onCheck(e: vscode.TreeCheckboxChangeEvent<JevItem>): Promise<void> {
    for (const [item, state] of e.items) {
      if (item.setting) {
        await config().update(item.setting, state === vscode.TreeItemCheckboxState.Checked, vscode.ConfigurationTarget.Global);
      }
    }
  }
}

export function registerJevView(jev: JevAccounts): vscode.Disposable[] {
  const provider = new JevView(jev);
  const view = vscode.window.createTreeView('agentGraphMaster.jev', { treeDataProvider: provider, manageCheckboxStateManually: true });
  return [
    view,
    view.onDidChangeCheckboxState((e) => provider.onCheck(e)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('agentGraphMaster.jev')) {
        provider.refresh();
      }
    }),
    jev.onDidChange(() => provider.refresh()),
  ];
}
