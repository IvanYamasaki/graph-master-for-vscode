import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import type { AuthStatus, Profile } from './profiles';
import { resolveCodexExecutable } from './codexPath';

/**
 * Contas do Codex. Cada conta é uma pasta usada como CODEX_HOME: o Codex guarda nela o login (auth.json),
 * a configuração (config.toml) e o histórico (sessions/). Duas pastas = duas contas que não se enxergam.
 */

/** Pasta que o Codex usa quando CODEX_HOME não está definido. É onde fica o login feito fora da extensão. */
export function defaultCodexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
}

/**
 * Raiz das contas Codex criadas pela extensão. Fica separada de ~/.claude-profiles para a importação de pastas
 * órfãs saber o fornecedor só pela raiz, sem adivinhar pelo conteúdo.
 */
export function codexProfilesRoot(): string {
  const configured = vscode.workspace.getConfiguration('agentGraphMaster').get<string>('codexProfilesRoot', '').trim();
  if (!configured) {
    return path.join(os.homedir(), '.codex-profiles');
  }
  return configured.startsWith('~') ? path.join(os.homedir(), configured.slice(1)) : configured;
}

/** Pastas que não são da extensão e nunca devem ser apagadas junto com a conta. */
export function isSharedCodexHome(dir: string): boolean {
  return path.resolve(dir).toLowerCase() === path.resolve(defaultCodexHome()).toLowerCase();
}

/** Ambiente do processo do Codex para esta conta. */
export function codexEnv(profile: Profile): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.CODEX_HOME = profile.configDir;
  return env;
}

/** Comando para rodar o Codex no terminal: o binário encontrado, ou `codex` do PATH como último recurso. */
export async function codexCommandLine(): Promise<string> {
  const exe = await resolveCodexExecutable();
  if (!exe) {
    return 'codex';
  }
  return /\s/.test(exe) ? `"${exe}"` : exe;
}

interface AuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: { id_token?: string } | null;
}

/**
 * Descobre quem está logado na conta sem mostrar nem copiar token. Com login pelo ChatGPT, o e-mail e o plano
 * saem do id_token (a parte pública do JWT, só as claims). Com chave de API, só dá para dizer que há chave.
 * Se não houver auth.json (login guardado no cofre do sistema, por exemplo), pergunta ao próprio CLI.
 */
export async function readCodexAuthStatus(profile: Profile): Promise<AuthStatus> {
  let raw: string | undefined;
  try {
    raw = await fs.promises.readFile(path.join(profile.configDir, 'auth.json'), 'utf8');
  } catch {
    return loginStatusFromCli(profile);
  }
  let auth: AuthFile;
  try {
    auth = JSON.parse(raw) as AuthFile;
  } catch {
    return { loggedIn: false, error: 'auth.json ilegível' };
  }
  if (auth.OPENAI_API_KEY) {
    return { loggedIn: true, authMethod: 'apiKey', subscriptionType: 'chave de API' };
  }
  const claims = jwtClaims(auth.tokens?.id_token);
  if (!claims) {
    return auth.tokens ? { loggedIn: true, authMethod: auth.auth_mode ?? 'chatgpt' } : { loggedIn: false };
  }
  const openai = (claims['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;
  const plan = typeof openai.chatgpt_plan_type === 'string' ? openai.chatgpt_plan_type : undefined;
  return {
    loggedIn: true,
    email: typeof claims.email === 'string' ? claims.email : undefined,
    subscriptionType: plan ? `ChatGPT ${planLabel(plan)}` : 'ChatGPT',
    authMethod: 'chatgpt',
  };
}

function jwtClaims(token: string | undefined): Record<string, unknown> | undefined {
  const payload = token?.split('.')[1];
  if (!payload) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function planLabel(plan: string): string {
  return plan === 'prolite' ? 'Pro Lite' : plan.charAt(0).toUpperCase() + plan.slice(1);
}

/** `codex login status` sai com 0 quando há login. Só olhamos o código e a primeira linha. */
async function loginStatusFromCli(profile: Profile): Promise<AuthStatus> {
  const exe = await resolveCodexExecutable();
  if (!exe) {
    return { loggedIn: false, error: 'Codex CLI não encontrado (npm i -g @openai/codex)' };
  }
  return new Promise((resolve) => {
    execFile(exe, ['login', 'status'], { env: codexEnv(profile), timeout: 20000, windowsHide: true }, (err, stdout, stderr) => {
      // O CLI escreve o status no stderr, junto com avisos; a linha que interessa é a última.
      const lines = `${stdout ?? ''}\n${stderr ?? ''}`.split('\n').map((l) => l.trim()).filter(Boolean);
      const line = lines.find((l) => /logged in/i.test(l)) ?? lines[lines.length - 1] ?? '';
      if (err) {
        resolve({ loggedIn: false, error: /not logged in/i.test(line) ? undefined : line || err.message.split('\n')[0] });
      } else {
        resolve({ loggedIn: true, authMethod: /api key/i.test(line) ? 'apiKey' : 'chatgpt', subscriptionType: /api key/i.test(line) ? 'chave de API' : 'ChatGPT' });
      }
    });
  });
}

/** Grava uma chave de API como login da conta, pelo próprio CLI (a chave vai pelo stdin, não pela linha de comando). */
export async function loginWithApiKey(profile: Profile, apiKey: string): Promise<void> {
  const exe = await resolveCodexExecutable();
  if (!exe) {
    throw new Error('Codex CLI não encontrado. Instale com: npm i -g @openai/codex');
  }
  await fs.promises.mkdir(profile.configDir, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(exe, ['login', '--with-api-key'], { env: codexEnv(profile), windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim().split('\n').pop() || `saiu com código ${code}`))));
    child.stdin.end(`${apiKey.trim()}\n`);
  });
}
