/**
 * Pacote de pesquisa: servidores MCP oficiais (e um da comunidade) gravados no `.mcp.json` do projeto, que o
 * Claude Code lê com settingSources 'project'. Servidor de `.mcp.json` só sobe aprovado (guard/mcpApproval.ts);
 * a confirmação deste comando, antes de gravar, conta como aprovação das entradas que ele acrescenta.
 *
 * Chave e token nunca vão para o arquivo: o `.mcp.json` referencia a variável (`${WANDB_API_KEY}`), e o valor
 * fica no SecretStorage do VS Code, injetado no ambiente das sessões de agente por `researchEnv()`.
 * Nenhum pacote Python é instalado: os servidores rodam com `uv run --with` / `uvx`, em ambiente temporário do uv.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ToolName, ToolProbe, probeAll, versionAtLeast } from './detect';
import { approveEntries } from '../guard/mcpApproval';

type McpEntry =
  | { type: 'stdio'; command: string; args: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> };

interface Secret {
  env: string;
  label: string;
  /** Sem o token o servidor ainda funciona (Hugging Face anônimo). */
  optional?: boolean;
  where: string;
}

interface PackServer {
  key: string;
  label: string;
  what: string;
  docs: string;
  official: boolean;
  needs: ToolName[];
  install: string;
  secret?: Secret;
  entry(opts: { trackingUri: string; hasSecret: boolean }): McpEntry;
}

/** Conferido na documentação de cada projeto em 2026-09. */
export const PACK: PackServer[] = [
  {
    key: 'mlflow',
    label: 'MLflow',
    what: 'consulta experimentos, runs, métricas e traces do servidor MLflow (oficial, experimental; MLflow ≥ 3.5.1)',
    docs: 'https://mlflow.org/docs/latest/genai/mcp/',
    official: true,
    needs: ['uv'],
    install: 'Instale o uv (winget install astral-sh.uv, ou pip install uv num venv do projeto). O servidor roda com "uv run --with mlflow[mcp]>=3.5.1", sem instalar o MLflow no seu Python.',
    entry: ({ trackingUri }) => ({
      type: 'stdio',
      command: 'uv',
      args: ['run', '--with', 'mlflow[mcp]>=3.5.1', 'mlflow', 'mcp', 'run'],
      env: { MLFLOW_TRACKING_URI: `\${MLFLOW_TRACKING_URI:-${trackingUri}}` },
    }),
  },
  {
    key: 'wandb',
    label: 'Weights & Biases',
    what: 'consulta runs, métricas, relatórios e traces Weave do W&B (oficial, hospedado em mcp.withwandb.com)',
    docs: 'https://docs.wandb.ai/platform/mcp-server',
    official: true,
    needs: [],
    install: '',
    secret: { env: 'WANDB_API_KEY', label: 'chave de API do W&B', where: 'https://wandb.ai/authorize' },
    entry: () => ({ type: 'http', url: 'https://mcp.withwandb.com/mcp', headers: { Authorization: 'Bearer ${WANDB_API_KEY}' } }),
  },
  {
    key: 'optuna',
    label: 'Optuna',
    what: 'cria e consulta estudos de otimização de hiperparâmetros (optuna-mcp, do projeto Optuna), gravados em optuna.db no projeto',
    docs: 'https://github.com/optuna/optuna-mcp',
    official: true,
    needs: ['uvx'],
    install: 'Instale o uv (winget install astral-sh.uv); o servidor roda com "uvx optuna-mcp".',
    entry: () => ({ type: 'stdio', command: 'uvx', args: ['optuna-mcp', '--storage', 'sqlite:///optuna.db'] }),
  },
  {
    key: 'huggingface',
    label: 'Hugging Face',
    what: 'busca modelos, datasets, Spaces e artigos no Hub (oficial, huggingface.co/mcp; com token, acessa também o que é seu)',
    docs: 'https://huggingface.co/docs/hub/agents-mcp',
    official: true,
    needs: [],
    install: '',
    secret: { env: 'HF_TOKEN', label: 'token do Hugging Face', optional: true, where: 'https://huggingface.co/settings/tokens' },
    entry: ({ hasSecret }) => (hasSecret ? { type: 'http', url: 'https://huggingface.co/mcp', headers: { Authorization: 'Bearer ${HF_TOKEN}' } } : { type: 'http', url: 'https://huggingface.co/mcp' }),
  },
  {
    key: 'jupyter',
    label: 'Jupyter (comunidade)',
    what: 'lê e executa células de um JupyterLab em andamento (datalayer/jupyter-mcp-server, não oficial do Jupyter)',
    docs: 'https://github.com/datalayer/jupyter-mcp-server',
    official: false,
    needs: ['uvx'],
    install: 'Instale o uv (winget install astral-sh.uv) e deixe um JupyterLab rodando; o servidor roda com "uvx jupyter-mcp-server@latest".',
    secret: { env: 'JUPYTER_TOKEN', label: 'token do JupyterLab', where: 'a saída do "jupyter lab" (parâmetro token=)' },
    entry: () => ({
      type: 'stdio',
      command: 'uvx',
      args: ['jupyter-mcp-server@latest'],
      env: { JUPYTER_URL: '${JUPYTER_URL:-http://localhost:8888}', JUPYTER_TOKEN: '${JUPYTER_TOKEN}', ALLOW_IMG_OUTPUT: 'true' },
    }),
  },
];

// ---------- Segredos injetados nas sessões ----------

const SECRET_PREFIX = 'agentGraphMaster.env.';
const SECRET_ENVS = [...new Set(PACK.flatMap((s) => (s.secret ? [s.secret.env] : [])))];
let secrets: vscode.SecretStorage | undefined;
const cached: Record<string, string> = {};

/** Carrega os tokens guardados. Chamado na ativação; sessões abertas depois já saem com eles no ambiente. */
export async function initResearchSecrets(storage: vscode.SecretStorage): Promise<void> {
  secrets = storage;
  for (const env of SECRET_ENVS) {
    const v = await storage.get(SECRET_PREFIX + env);
    if (v) {
      cached[env] = v;
    }
  }
}

/** Variáveis a acrescentar no ambiente de cada sessão. O que já existe no ambiente do VS Code tem prioridade. */
export function researchEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(cached)) {
    if (!process.env[k]) {
      out[k] = v;
    }
  }
  return out;
}

export function hasResearchSecret(env: string): boolean {
  return !!(process.env[env] || cached[env]);
}

async function storeSecret(env: string, value: string): Promise<void> {
  cached[env] = value;
  await secrets?.store(SECRET_PREFIX + env, value);
}

// ---------- .mcp.json ----------

export interface MergeResult {
  added: string[];
  kept: string[];
  json: Record<string, unknown>;
}

/** Junta as entradas novas às do arquivo, sem trocar nenhuma que já exista com o mesmo nome. */
export function mergeMcpJson(existing: Record<string, unknown> | undefined, entries: Record<string, McpEntry>): MergeResult {
  const json: Record<string, unknown> = { ...(existing ?? {}) };
  const servers = { ...((json.mcpServers && typeof json.mcpServers === 'object' ? json.mcpServers : {}) as Record<string, unknown>) };
  const added: string[] = [];
  const kept: string[] = [];
  for (const [name, entry] of Object.entries(entries)) {
    if (name in servers) {
      kept.push(name);
      continue;
    }
    servers[name] = entry;
    added.push(name);
  }
  json.mcpServers = servers;
  return { added, kept, json };
}

/** Lê o `.mcp.json`. Arquivo inválido vira erro: gravar por cima apagaria o que o usuário escreveu. */
export function readMcpJson(file: string): Record<string, unknown> | undefined | Error {
  if (!fs.existsSync(file)) {
    return undefined;
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : new Error(`${file} não contém um objeto JSON.`);
  } catch (err) {
    return new Error(`${file} não é JSON válido (${err instanceof Error ? err.message : String(err)}). Corrija o arquivo antes; nada foi gravado.`);
  }
}

function missingText(s: PackServer, probes: Record<ToolName, ToolProbe>): string | undefined {
  const missing = s.needs.filter((n) => !probes[n]?.ok);
  return missing.length ? missing.map((n) => probes[n]?.why ?? `${n} não encontrado`).join('; ') : undefined;
}

// ---------- Comando ----------

/** "Agent Graph Master: Configurar pacote de pesquisa". */
export async function configureResearchPack(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    void vscode.window.showErrorMessage('Abra a pasta do projeto antes: o pacote de pesquisa é gravado em .mcp.json na raiz do projeto.');
    return;
  }
  const file = path.join(root, '.mcp.json');
  const existing = readMcpJson(file);
  if (existing instanceof Error) {
    void vscode.window.showErrorMessage(existing.message);
    return;
  }
  const present = new Set(Object.keys(((existing?.mcpServers ?? {}) as Record<string, unknown>) ?? {}));
  const probes = await probeAll(['python', 'uv', 'uvx', 'mlflow']);
  const mlflowNote = probes.mlflow.ok
    ? versionAtLeast(probes.mlflow.version, '3.5.1')
      ? `MLflow ${probes.mlflow.version} no Python`
      : `MLflow ${probes.mlflow.version} no Python (o servidor usa ≥ 3.5.1 pelo uv)`
    : 'MLflow não instalado no Python (o servidor usa o do uv)';

  type Item = vscode.QuickPickItem & { server: PackServer; missing?: string };
  const items: Item[] = PACK.map((s) => {
    const missing = missingText(s, probes);
    const secretOk = !s.secret || hasResearchSecret(s.secret.env);
    const state = present.has(s.key)
      ? 'já está no .mcp.json'
      : missing
        ? `indisponível: ${missing}`
        : s.secret && !secretOk
          ? `pede ${s.secret.label}${s.secret.optional ? ' (opcional)' : ''}`
          : 'disponível';
    return {
      label: `${missing ? '$(circle-slash)' : present.has(s.key) ? '$(check)' : '$(plug)'} ${s.label}`,
      description: state,
      detail: `${s.what}. ${s.key === 'mlflow' ? `${mlflowNote}. ` : ''}Doc: ${s.docs}`,
      picked: false,
      server: s,
      missing,
    };
  });
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'Pacote de pesquisa: servidores MCP para o projeto',
    placeHolder: `Python: ${probes.python.ok ? probes.python.version : probes.python.why} · uv: ${probes.uv.ok ? probes.uv.version : 'não encontrado'}. Escolha o que gravar em .mcp.json`,
    ignoreFocusOut: true,
  });
  if (!picked?.length) {
    return;
  }
  const unavailable = picked.filter((i) => i.missing);
  const chosen = picked.filter((i) => !i.missing).map((i) => i.server);
  if (unavailable.length) {
    void vscode.window.showWarningMessage(`Ficam de fora por falta de dependência: ${unavailable.map((i) => `${i.server.label} (${i.missing}). ${i.server.install}`).join(' ')}`);
  }
  if (!chosen.length) {
    return;
  }

  let trackingUri = vscode.workspace.getConfiguration('agentGraphMaster').get<string>('mlflow.trackingUri', '') || 'http://127.0.0.1:5000';
  if (chosen.some((s) => s.key === 'mlflow') && !present.has('mlflow')) {
    const uri = await vscode.window.showInputBox({
      title: 'MLflow: tracking URI',
      prompt: 'Endereço do servidor MLflow. Fica como padrão no .mcp.json; a variável MLFLOW_TRACKING_URI, se existir, tem prioridade.',
      value: trackingUri,
      ignoreFocusOut: true,
    });
    if (uri === undefined) {
      return;
    }
    trackingUri = uri.trim() || trackingUri;
  }

  // Tokens: guardados no SecretStorage e injetados nas sessões, nunca escritos no arquivo.
  const hasSecret: Record<string, boolean> = {};
  for (const s of chosen) {
    if (!s.secret || present.has(s.key)) {
      continue;
    }
    if (hasResearchSecret(s.secret.env)) {
      hasSecret[s.key] = true;
      continue;
    }
    const value = await vscode.window.showInputBox({
      title: `${s.label}: ${s.secret.label}`,
      prompt: `Guardado no cofre de segredos do VS Code e passado às sessões como ${s.secret.env}; não vai para o .mcp.json. Onde obter: ${s.secret.where}. ${s.secret.optional ? 'Deixe vazio para usar sem token.' : 'Deixe vazio para definir a variável você mesmo depois.'}`,
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) {
      return;
    }
    if (value.trim()) {
      await storeSecret(s.secret.env, value.trim());
      hasSecret[s.key] = true;
    }
  }

  const entries = Object.fromEntries(chosen.map((s) => [s.key, s.entry({ trackingUri, hasSecret: !!hasSecret[s.key] })]));
  const merged = mergeMcpJson(existing, entries);
  if (!merged.added.length) {
    void vscode.window.showInformationMessage(`Nada a gravar: ${merged.kept.join(', ')} já estão em ${file} e foram mantidos como estão.`);
    return;
  }
  const noKey = chosen.filter((s) => s.secret && !s.secret.optional && !hasSecret[s.key] && merged.added.includes(s.key));
  const answer = await vscode.window.showWarningMessage(
    `Gravar em ${file}?`,
    {
      modal: true,
      detail: [
        `Acrescenta: ${merged.added.join(', ')}.`,
        merged.kept.length ? `Mantidos sem mudança: ${merged.kept.join(', ')}.` : '',
        existing ? `As outras ${Object.keys((existing.mcpServers ?? {}) as object).length} entrada(s) do arquivo continuam.` : 'O arquivo será criado.',
        'Nenhuma chave vai para o arquivo; só referências como ${WANDB_API_KEY}.',
        noKey.length ? `Sem ${noKey.map((s) => s.secret!.env).join(', ')} no ambiente, ${noKey.map((s) => s.label).join(', ')} não autentica.` : '',
        'Os chats e agentes abertos depois disso já carregam os servidores.',
      ]
        .filter(Boolean)
        .join('\n'),
    },
    'Gravar',
  );
  if (answer !== 'Gravar') {
    return;
  }
  fs.writeFileSync(file, `${JSON.stringify(merged.json, null, 2)}\n`, 'utf8');
  // A confirmação acima vale como aprovação destes servidores (guard/mcpApproval.ts); os que já estavam no arquivo seguem como estavam.
  await approveEntries(Object.fromEntries(merged.added.map((name) => [name, entries[name]])));
  void vscode.window.showInformationMessage(`Pacote de pesquisa gravado em ${file}: ${merged.added.join(', ')}. Abra um chat novo para usar.`);
}
