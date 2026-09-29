import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const EXE = process.platform === 'win32' ? 'claude.exe' : 'claude';
const VERSION_TIMEOUT_MS = 5000;
const EXTENSION_PREFIX = 'anthropic.claude-code-';

/** Um executável encontrado no disco, com a versão que ele reporta em `--version` (ausente se não respondeu). */
export interface ClaudeCandidate {
  path: string;
  /** Veio do PATH (ou de um node_modules dentro do PATH). Serve de desempate entre versões iguais. */
  fromPath: boolean;
  version?: string;
}

/** Cache por sessão do VS Code: sondar `--version` de meia dúzia de binários custa caro para fazer a cada chat. */
let cache: { key: string; result: Promise<string | undefined> } | undefined;

/**
 * Acha o executável nativo do Claude Code. O SDK precisa do caminho absoluto do binário, não do atalho `claude`
 * do npm (no Windows é um .cmd que o SDK não consegue executar direto).
 *
 * A versão importa: a lista de modelos do chat vem do CLI, então um binário velho esconde os modelos novos.
 * Por padrão escolhemos o mais novo entre todas as instalações; `claudePathStrategy: "path"` volta ao antigo
 * comportamento de pegar o primeiro do PATH.
 */
export async function resolveClaudeExecutable(): Promise<string | undefined> {
  const config = vscode.workspace.getConfiguration('agentGraphMaster');
  const configured = config.get<string>('claudePath', '').trim();
  if (configured) {
    return fs.existsSync(configured) ? configured : undefined;
  }

  const strategy = config.get<string>('claudePathStrategy', 'newest').trim() || 'newest';
  const key = strategy;
  if (!cache || cache.key !== key) {
    cache = { key, result: pick(strategy).catch(() => undefined) };
  }
  return cache.result;
}

/** Lista os candidatos existentes no disco com a versão de cada um. Usada no diagnóstico. */
export async function listClaudeCandidates(): Promise<ClaudeCandidate[]> {
  const found = collectCandidates();
  const versions = await Promise.all(found.map((c) => readVersion(c.path)));
  return found.map((c, i) => ({ ...c, version: versions[i] }));
}

async function pick(strategy: string): Promise<string | undefined> {
  const found = collectCandidates();
  if (found.length === 0) {
    return undefined;
  }
  if (strategy === 'path') {
    log(found[0].path, undefined);
    return found[0].path;
  }

  const versions = await Promise.all(found.map((c) => readVersion(c.path)));
  let best = -1;
  for (let i = 0; i < found.length; i++) {
    if (!versions[i]) {
      continue;
    }
    if (best < 0) {
      best = i;
      continue;
    }
    const diff = compareVersions(versions[i] as string, versions[best] as string);
    // Empate fica com o do PATH; fora isso, ganha a versão maior. Índice menor só desempata o resto.
    if (diff > 0 || (diff === 0 && found[i].fromPath && !found[best].fromPath)) {
      best = i;
    }
  }
  if (best < 0) {
    // Nenhum respondeu `--version`: comportamento antigo, o primeiro que existe.
    log(found[0].path, undefined);
    return found[0].path;
  }
  log(found[best].path, versions[best]);
  return found[best].path;
}

/** Monta a lista de lugares onde o binário costuma estar, na ordem de preferência antiga (PATH primeiro). */
function collectCandidates(): ClaudeCandidate[] {
  const out: ClaudeCandidate[] = [];
  const seen = new Set<string>();
  const add = (p: string, fromPath: boolean) => {
    const norm = path.normalize(p).toLowerCase();
    if (seen.has(norm) || !isFile(p)) {
      return;
    }
    seen.add(norm);
    out.push({ path: p, fromPath });
  };

  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    add(path.join(dir, EXE), true);
    // Instalação via npm: o atalho fica em <prefix>/claude e o binário em node_modules.
    add(path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', EXE), true);
  }
  add(path.join(os.homedir(), '.local', 'bin', EXE), false);
  if (process.env.APPDATA) {
    add(path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', EXE), false);
  }

  // O binário que vem dentro da extensão oficial, na versão ativa.
  const official = vscode.extensions.getExtension('anthropic.claude-code');
  if (official) {
    add(path.join(official.extensionPath, 'resources', 'native-binary', EXE), false);
  }
  // E em todas as versões instaladas lado a lado, que o VS Code não expõe pela API.
  for (const root of extensionRoots()) {
    for (const dir of listDirs(root)) {
      if (dir.startsWith(EXTENSION_PREFIX)) {
        add(path.join(root, dir, 'resources', 'native-binary', EXE), false);
      }
    }
  }
  return out;
}

function extensionRoots(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.vscode', 'extensions'),
    path.join(home, '.vscode-insiders', 'extensions'),
    path.join(home, '.cursor', 'extensions'),
  ].filter(isDir);
}

/** `2.1.274 (Claude Code)` -> `2.1.274`. undefined se o binário não respondeu no prazo. */
function readVersion(exe: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(exe, ['--version'], { timeout: VERSION_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (err && !stdout) {
        resolve(undefined);
        return;
      }
      const m = /(\d+(?:\.\d+)+)/.exec(stdout);
      resolve(m ? m[1] : undefined);
    });
  });
}

/** Compara como número, não como texto: 2.1.9 < 2.1.10. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff < 0 ? -1 : 1;
    }
  }
  return 0;
}

function log(exe: string, version: string | undefined): void {
  console.log(`[agent-graph-master] Claude Code: ${exe}${version ? ` (versão ${version})` : ' (versão desconhecida)'}`);
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listDirs(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
