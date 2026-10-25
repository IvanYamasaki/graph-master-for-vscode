import * as vscode from 'vscode';
import { JEV_PROVIDER_LABEL, JevDecision, JevError, JevProvider, JevQuestions, jevDecide, jevListModels } from './jev';
import { JEV_AUTO_SETTING, JevAutoUse, withTimeout } from './jevAuto';
import type { JevAccountInfo } from './protocol';

/**
 * Contas do Jev (TypeSafe direto ou pelo AI Gateway da Vercel). A lista (nome, provedor, estado, gasto) fica no
 * globalState; a chave fica só no SecretStorage do VS Code, nunca em settings.json, no .agm, em log ou no webview.
 */

export interface JevAccount {
  id: string;
  name: string;
  provider: JevProvider;
  addedAt: string;
  /** invalid: a API recusou a chave (401/403) na última consulta. */
  status: 'ok' | 'invalid';
  error?: string;
  /** Gasto acumulado desde que a conta foi adicionada. */
  spent: { tokens: number; usd: number; calls: number };
}

const LIST_KEY = 'agentGraphMaster.jevAccounts';
const secretKey = (id: string) => `agentGraphMaster.jev.key.${id}`;

function enabledSetting(): boolean {
  return vscode.workspace.getConfiguration('agentGraphMaster').get<boolean>('jev.enabled', true);
}

export class JevAccounts {
  private static instance?: JevAccounts;

  static init(context: vscode.ExtensionContext): JevAccounts {
    JevAccounts.instance = new JevAccounts(context.secrets, context.globalState);
    return JevAccounts.instance;
  }

  /** Sem init (teste fora do VS Code): nenhuma conta, ferramenta fora. */
  static get(): JevAccounts | undefined {
    return JevAccounts.instance;
  }

  private readonly changed = new vscode.EventEmitter<void>();
  /** A lista mudou (conta nova, removida, estado ou gasto). */
  readonly onDidChange = this.changed.event;

  private constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly memento: vscode.Memento,
  ) {}

  all(): JevAccount[] {
    return this.memento.get<JevAccount[]>(LIST_KEY, []);
  }

  /** Conta que a jev_decide usa: a primeira com chave aceita, se agentGraphMaster.jev.enabled estiver ligado. */
  active(): JevAccount | undefined {
    return enabledSetting() ? this.all().find((a) => a.status === 'ok') : undefined;
  }

  /** Para o menu "Limites por conta". */
  infos(): JevAccountInfo[] {
    const on = enabledSetting();
    const active = this.active()?.id;
    return this.all().map((a) => ({
      id: a.id,
      name: a.name,
      provider: JEV_PROVIDER_LABEL[a.provider],
      status: a.status,
      error: a.error,
      addedAt: a.addedAt,
      spent: a.spent,
      inUse: a.id === active,
      disabled: !on,
    }));
  }

  private async save(list: JevAccount[]): Promise<void> {
    await this.memento.update(LIST_KEY, list);
    this.changed.fire();
  }

  private async patch(id: string, fn: (a: JevAccount) => JevAccount): Promise<void> {
    await this.save(this.all().map((a) => (a.id === id ? fn(a) : a)));
  }

  // ---------- Comandos ----------

  async add(): Promise<void> {
    const provider = await vscode.window.showQuickPick(
      [
        { label: 'TypeSafe', description: 'api.typesafe.ai', detail: 'Chave da TypeSafe AI (TYPESAFE_API_KEY). O cadastro direto está pausado desde 22/09/2026.', provider: 'typesafe' as const },
        { label: 'Vercel AI Gateway', description: 'ai-gateway.vercel.sh/typesafe', detail: 'Chave do AI Gateway (AI_GATEWAY_API_KEY), cobrada pela Vercel. Modelo typesafe-ai/jev.', provider: 'vercel' as const },
      ],
      { title: 'Nova conta Jev', placeHolder: 'Por onde o Jev vai ser chamado?', ignoreFocusOut: true },
    );
    if (!provider) {
      return;
    }
    const name = await vscode.window.showInputBox({
      title: 'Nova conta Jev',
      prompt: 'Nome da conta, para reconhecer no menu de contas',
      value: provider.label === 'TypeSafe' ? 'Jev' : 'Jev (Vercel)',
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Dê um nome à conta'),
    });
    if (!name?.trim()) {
      return;
    }
    const value = await vscode.window.showInputBox({
      title: `Chave ${provider.provider === 'typesafe' ? 'da TypeSafe' : 'do AI Gateway da Vercel'}`,
      prompt: 'A chave fica no cofre de segredos do VS Code e só sai daqui no cabeçalho das chamadas ao Jev.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim().length < 12 ? 'Chave curta demais' : undefined),
    });
    const key = value?.trim();
    if (!key) {
      return;
    }
    let models: string[];
    try {
      models = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Conferindo a chave em ${provider.label}…` }, () =>
        jevListModels({ provider: provider.provider, key }),
      );
    } catch (err) {
      vscode.window.showErrorMessage(`A chave não funcionou e não foi salva: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const id = `jev-${Date.now().toString(36)}`;
    await this.secrets.store(secretKey(id), key);
    await this.save([
      ...this.all(),
      { id, name: name.trim(), provider: provider.provider, addedAt: new Date().toISOString(), status: 'ok', spent: { tokens: 0, usd: 0, calls: 0 } },
    ]);
    const jev = models.filter((m) => /jev/i.test(m));
    vscode.window.showInformationMessage(
      `Conta Jev "${name.trim()}" salva${jev.length ? ` (modelos: ${jev.slice(0, 4).join(', ')})` : ''}. A ferramenta jev_decide entra nas conversas e agentes que começarem a partir de agora.`,
    );
  }

  async remove(): Promise<void> {
    const list = this.all();
    if (!list.length) {
      vscode.window.showInformationMessage('Nenhuma conta Jev cadastrada.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      list.map((a) => ({ label: a.name, description: JEV_PROVIDER_LABEL[a.provider], detail: a.status === 'ok' ? undefined : 'chave inválida', id: a.id })),
      { title: 'Remover conta Jev', placeHolder: 'Qual conta remover? A chave sai do cofre de segredos.' },
    );
    if (!picked) {
      return;
    }
    await this.secrets.delete(secretKey(picked.id));
    await this.save(this.all().filter((a) => a.id !== picked.id));
    vscode.window.showInformationMessage(`Conta Jev "${picked.label}" removida.`);
  }

  // ---------- Usos automáticos (jevAuto) ----------

  /** O uso automático está ligado (agentGraphMaster.jev.auto.*) e há conta Jev ativa. */
  autoEnabled(use: JevAutoUse): boolean {
    return !!this.active() && vscode.workspace.getConfiguration('agentGraphMaster').get<boolean>(JEV_AUTO_SETTING[use], false);
  }

  /**
   * Consulta automática do host: undefined se o uso estiver desligado, sem conta, com erro ou passado o tempo
   * (quem chama segue a regra antiga). O gasto entra na conta Jev como em decide.
   */
  async autoDecide(use: JevAutoUse, state: string, questions: JevQuestions, timeoutMs?: number): Promise<JevDecision | undefined> {
    if (!this.autoEnabled(use)) {
      return undefined;
    }
    return (await withTimeout(this.decide(state, questions), timeoutMs))?.decision;
  }

  // ---------- Consulta ----------

  /**
   * Uma consulta pela conta ativa. Soma o gasto na conta; 401/403 marca a chave como inválida (a ferramenta some das
   * sessões novas até o usuário cadastrar de novo).
   */
  async decide(state: string, questions: JevQuestions): Promise<{ account: JevAccount; decision: JevDecision }> {
    const account = this.active();
    if (!account) {
      throw new Error('Nenhuma conta Jev ativa. O usuário adiciona uma com o comando "Agent Graph Master: Adicionar conta Jev".');
    }
    const key = await this.secrets.get(secretKey(account.id));
    if (!key) {
      await this.patch(account.id, (a) => ({ ...a, status: 'invalid', error: 'a chave sumiu do cofre de segredos' }));
      throw new Error(`A chave da conta Jev "${account.name}" não está no cofre de segredos. Remova a conta e adicione de novo.`);
    }
    try {
      const decision = await jevDecide({ provider: account.provider, key, state, questions });
      await this.patch(account.id, (a) => ({
        ...a,
        status: 'ok',
        error: undefined,
        spent: { tokens: a.spent.tokens + decision.cost.tokens, usd: a.spent.usd + decision.cost.usd, calls: a.spent.calls + 1 },
      }));
      return { account, decision };
    } catch (err) {
      if (err instanceof JevError && err.invalidKey) {
        await this.patch(account.id, (a) => ({ ...a, status: 'invalid', error: err.message }));
      }
      throw err;
    }
  }
}
