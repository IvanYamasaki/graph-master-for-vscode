import * as vscode from 'vscode';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Antigravity CLI (`agy`), o sucessor do Gemini CLI para contas pessoais do Google. O instalador oficial põe o
 * executável em %LOCALAPPDATA%\agy\bin no Windows; nos outros sistemas ele fica no PATH.
 */

const EXE = process.platform === 'win32' ? 'agy.exe' : 'agy';
const LOGIN_TTL_MS = 60_000;

/** Caminho configurado em agentGraphMaster.external.agyPath, instalação padrão ou PATH. */
export function resolveAgyExecutable(): string | undefined {
  const configured = vscode.workspace.getConfiguration('agentGraphMaster').get<string>('external.agyPath', '').trim();
  if (configured) {
    return isFile(configured) ? configured : undefined;
  }
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'agy', 'bin', EXE),
    ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, EXE)),
    path.join(os.homedir(), '.local', 'bin', EXE),
  ].filter((p): p is string => !!p);
  return candidates.find(isFile);
}

let loginCache: { at: number; value: boolean } | undefined;

/**
 * Login sem gastar cota: o agy guarda a conta Google no cofre do sistema. No Windows é a credencial
 * "gemini:antigravity" do Gerenciador de Credenciais, que o `cmdkey /list` mostra sem expor o segredo.
 * Nos outros sistemas não há consulta barata equivalente: vale a pasta de dados que o agy cria no primeiro uso.
 */
export function agyLoggedIn(): boolean {
  if (loginCache && Date.now() - loginCache.at < LOGIN_TTL_MS) {
    return loginCache.value;
  }
  let value: boolean;
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('cmdkey', ['/list:gemini:antigravity'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      // O cabeçalho repete o nome pedido; a segunda ocorrência é a credencial encontrada.
      value = out.split('gemini:antigravity').length > 2;
    } catch {
      value = false;
    }
  } else {
    value = fs.existsSync(path.join(os.homedir(), '.gemini', 'antigravity-cli'));
  }
  loginCache = { at: Date.now(), value };
  return value;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
