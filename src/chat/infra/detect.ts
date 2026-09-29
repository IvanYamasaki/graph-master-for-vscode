/**
 * Detecção dos executáveis que as integrações usam: Python e uv (servidores MCP de pesquisa), mlflow,
 * e os CLIs de GPU remota (sbatch, modal, runpodctl). Nada é instalado aqui; só se procura e se lê a versão.
 *
 * Sem VS Code: roda no teste com node puro.
 */
import { execFile } from 'node:child_process';

export type ToolName = 'python' | 'uv' | 'uvx' | 'mlflow' | 'sbatch' | 'squeue' | 'modal' | 'runpodctl' | 'jupyter';

export interface ToolProbe {
  ok: boolean;
  /** Primeira linha da versão, quando o comando responde. */
  version?: string;
  /** Por que não está disponível, em uma frase para o usuário. */
  why?: string;
}

/** Comando e argumento que imprimem a versão. O mlflow é lido pelo Python: o executável nem sempre está no PATH. */
const PROBES: Record<ToolName, { cmd: string; args: string[] }> = {
  python: { cmd: process.platform === 'win32' ? 'python' : 'python3', args: ['--version'] },
  uv: { cmd: 'uv', args: ['--version'] },
  uvx: { cmd: 'uvx', args: ['--version'] },
  mlflow: { cmd: process.platform === 'win32' ? 'python' : 'python3', args: ['-c', 'import mlflow; print(mlflow.__version__)'] },
  sbatch: { cmd: 'sbatch', args: ['--version'] },
  squeue: { cmd: 'squeue', args: ['--version'] },
  modal: { cmd: 'modal', args: ['--version'] },
  runpodctl: { cmd: 'runpodctl', args: ['version'] },
  jupyter: { cmd: 'jupyter', args: ['--version'] },
};

const cache = new Map<ToolName, { at: number; probe: Promise<ToolProbe> }>();
const TTL_MS = 60_000;

/** Roda um comando curto e devolve a saída. Nunca lança: erro vira `{ code: -1 }`. */
export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 15_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: opts.env ?? process.env },
      (err, stdout, stderr) => {
        // Saída diferente de zero traz o código numérico; comando inexistente traz 'ENOENT'.
        const raw = (err as { code?: unknown } | null)?.code;
        const code = !err ? 0 : typeof raw === 'number' ? raw : -1;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err && code === -1 ? err.message : '') });
      },
    );
  });
}

export function probe(name: ToolName): Promise<ToolProbe> {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return hit.probe;
  }
  const p = (async (): Promise<ToolProbe> => {
    const { cmd, args } = PROBES[name];
    const r = await run(cmd, args, { timeoutMs: 20_000 });
    const out = `${r.stdout}\n${r.stderr}`.trim();
    if (r.code !== 0) {
      if (name === 'mlflow') {
        return { ok: false, why: /No module named/i.test(out) ? 'o pacote mlflow não está instalado neste Python' : 'Python não encontrado' };
      }
      return { ok: false, why: `${cmd} não está no PATH` };
    }
    // O python.exe da Microsoft Store sem Python instalado só abre a loja: responde sem versão.
    const version = out.split(/\r?\n/).find((l) => /\d+\.\d+/.test(l))?.trim();
    if ((name === 'python' || name === 'mlflow') && !version) {
      return { ok: false, why: 'Python não encontrado (só o atalho da Microsoft Store)' };
    }
    return { ok: true, version };
  })();
  cache.set(name, { at: Date.now(), probe: p });
  return p;
}

export async function probeAll(names: ToolName[]): Promise<Record<ToolName, ToolProbe>> {
  const entries = await Promise.all(names.map(async (n) => [n, await probe(n)] as const));
  return Object.fromEntries(entries) as Record<ToolName, ToolProbe>;
}

/** Compara versões "3.5.1" >= "3.5.1". Partes não numéricas contam como zero. */
export function versionAtLeast(version: string | undefined, min: string): boolean {
  if (!version) {
    return false;
  }
  const a = (version.match(/\d+(\.\d+)*/)?.[0] ?? '0').split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) {
      return x > y;
    }
  }
  return true;
}
