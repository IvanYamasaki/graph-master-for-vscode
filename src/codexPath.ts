import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const EXE = process.platform === 'win32' ? 'codex.exe' : 'codex';
const VERSION_TIMEOUT_MS = 5000;
const EXTENSION_PREFIX = 'openai.chatgpt-';

/** Pasta do binário nativo dentro do pacote npm `@openai/codex-<plataforma>`. */
const NPM_TRIPLE: Record<string, string> = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
};

export interface CodexCandidate {
  path: string;
  version?: string;
  /** Versão com sufixo (0.155.0-alpha.16): só ganha se não houver estável. */
  prerelease: boolean;
}

let cache: Promise<string | undefined> | undefined;

/**
 * Acha o binário nativo do Codex. Preferimos o executável de verdade ao atalho `codex` do npm: no Windows o atalho
 * é um .cmd que passa por cmd.exe e node, e matar o cmd deixaria o app-server órfão.
 *
 * Entre as instalações encontradas ganha a versão estável mais nova. A extensão oficial da OpenAI traz um binário
 * próprio, muitas vezes alpha; ele só é usado quando não há outro.
 */
export function resolveCodexExecutable(): Promise<string | undefined> {
  const configured = vscode.workspace.getConfiguration('agentGraphMaster').get<string>('codexPath', '').trim();
  if (configured) {
    return Promise.resolve(fs.existsSync(configured) ? configured : undefined);
  }
  cache ??= pick().catch(() => undefined);
  return cache;
}

export async function listCodexCandidates(): Promise<CodexCandidate[]> {
  const found = collectCandidates();
  const versions = await Promise.all(found.map(readVersion));
  return found.map((p, i) => ({ path: p, version: versions[i], prerelease: /-/.test(versions[i] ?? '') }));
}

async function pick(): Promise<string | undefined> {
  const list = (await listCodexCandidates()).filter((c) => c.version);
  if (!list.length) {
    return collectCandidates()[0];
  }
  const best = list.reduce((a, b) => {
    if (a.prerelease !== b.prerelease) {
      return a.prerelease ? b : a;
    }
    return compareVersions(b.version!, a.version!) > 0 ? b : a;
  });
  console.log(`[agent-graph-master] Codex: ${best.path} (versão ${best.version})`);
  return best.path;
}

/** Ordem de preferência em empate: PATH, npm global, winget, extensão oficial. */
function collectCandidates(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string) => {
    const norm = path.normalize(p).toLowerCase();
    if (!seen.has(norm) && isFile(p)) {
      seen.add(norm);
      out.push(p);
    }
  };
  const triple = NPM_TRIPLE[`${process.platform}-${process.arch}`];
  const npmVendor = (prefixDir: string) =>
    triple &&
    [
      path.join(prefixDir, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', `codex-${process.platform}-${process.arch}`, 'vendor', triple, 'bin', EXE),
      path.join(prefixDir, 'node_modules', '@openai', `codex-${process.platform}-${process.arch}`, 'vendor', triple, 'bin', EXE),
    ].forEach(add);

  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    add(path.join(dir, EXE));
    npmVendor(dir);
    // Linux/macOS: o npm põe o atalho em <prefix>/bin e o pacote em <prefix>/lib/node_modules.
    npmVendor(path.join(dir, '..', 'lib'));
  }
  if (process.env.APPDATA) {
    npmVendor(path.join(process.env.APPDATA, 'npm'));
  }
  if (process.env.LOCALAPPDATA) {
    add(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', EXE));
  }
  add(path.join(os.homedir(), '.local', 'bin', EXE));

  const platformDir = process.platform === 'win32' ? `windows-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}` : undefined;
  for (const root of extensionRoots()) {
    for (const dir of listDirs(root).filter((d) => d.startsWith(EXTENSION_PREFIX))) {
      if (platformDir) {
        add(path.join(root, dir, 'bin', platformDir, EXE));
      }
      for (const sub of listDirs(path.join(root, dir, 'bin'))) {
        add(path.join(root, dir, 'bin', sub, EXE));
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

/** `codex-cli 0.147.0` -> `0.147.0`; `codex-cli 0.155.0-alpha.16.3` -> `0.155.0-alpha.16.3`. */
function readVersion(exe: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(exe, ['--version'], { timeout: VERSION_TIMEOUT_MS, windowsHide: true }, (_err, stdout) => {
      const m = /(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(stdout ?? '');
      resolve(m ? m[1] : undefined);
    });
  });
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff < 0 ? -1 : 1;
    }
  }
  return 0;
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
