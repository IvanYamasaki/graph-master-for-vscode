/**
 * Leitura do sistema: lista de processos e portas em escuta. Uma chamada de PowerShell no Windows, ps e lsof/ss no resto.
 * Nada aqui lança: o erro volta junto de um valor vazio.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { parseLsof, parseNetstat, parsePortsJson, parsePs, parseSs, parseWin32Json } from './parse';
import type { ProcInfo, Scan } from './types';

const IS_WIN = process.platform === 'win32';
const PS_TIMEOUT_MS = 20_000;
const POSIX_TIMEOUT_MS = 8_000;

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/** Roda um executável sem janela e com prazo. Nunca lança: comando inexistente ou prazo estourado viram code -1 e stderr. */
export function run(cmd: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<Ran> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: env ?? process.env, encoding: 'utf8' }, (err, stdout, stderr) => {
        const raw = (err as { code?: unknown } | null)?.code;
        const code = !err ? 0 : typeof raw === 'number' ? raw : -1;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err && code === -1 ? err.message : '') });
      });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: e instanceof Error ? e.message : String(e) });
    }
  });
}

/** PowerShell por -EncodedCommand (UTF-16LE em base64): sem problema de aspas e de página de código na linha de comando. */
function powershell(script: string, timeoutMs: number): Promise<Ran> {
  const full = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${script}`;
  const encoded = Buffer.from(full, 'utf16le').toString('base64');
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], timeoutMs);
}

const WIN_PROCS =
  "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine," +
  "@{n='Started';e={if($_.CreationDate){[int64]([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}else{$null}}} | ConvertTo-Json -Compress";

const WIN_PORTS = 'Get-NetTCPConnection -State Listen | Select-Object LocalPort,OwningProcess | ConvertTo-Json -Compress';

/** Lê os processos. Windows: Get-CimInstance. Linux/macOS: ps, mais o cwd por /proc no Linux. */
export async function scanProcesses(): Promise<Scan<ProcInfo[]>> {
  const t0 = Date.now();
  const done = (value: ProcInfo[], error?: string): Scan<ProcInfo[]> => ({ value, error, ms: Date.now() - t0 });
  try {
    if (IS_WIN) {
      const r = await powershell(WIN_PROCS, PS_TIMEOUT_MS);
      const procs = parseWin32Json(r.stdout);
      return procs.length ? done(procs) : done([], `PowerShell não listou processos (código ${r.code}): ${r.stderr.trim().slice(0, 300) || 'saída vazia'}`);
    }
    const r = await run('ps', ['-eo', 'pid=,ppid=,lstart=,comm=,args='], POSIX_TIMEOUT_MS, { ...process.env, LC_ALL: 'C' });
    const procs = parsePs(r.stdout);
    if (!procs.length) {
      return done([], `ps não listou processos (código ${r.code}): ${r.stderr.trim().slice(0, 300) || 'saída vazia'}`);
    }
    if (process.platform === 'linux') {
      await Promise.all(
        procs.map(async (p) => {
          try {
            p.cwd = await fs.promises.readlink(`/proc/${p.pid}/cwd`);
          } catch {
            // Processo de outro usuário ou já encerrado.
          }
        }),
      );
    }
    return done(procs);
  } catch (e) {
    return done([], e instanceof Error ? e.message : String(e));
  }
}

export async function listProcesses(): Promise<ProcInfo[]> {
  return (await scanProcesses()).value;
}

/** Portas TCP em escuta por PID. Windows: netstat -ano, com Get-NetTCPConnection de reserva. POSIX: lsof, com ss de reserva. */
export async function scanPorts(): Promise<Scan<Map<number, number[]>>> {
  const t0 = Date.now();
  const done = (value: Map<number, number[]>, error?: string): Scan<Map<number, number[]>> => ({ value, error, ms: Date.now() - t0 });
  try {
    const errors: string[] = [];
    if (IS_WIN) {
      // netstat -ano leva ~0,1 s e Get-NetTCPConnection ~3 s (carga do módulo de rede); os dois dão PID e porta. O mais rápido vai primeiro.
      const n = await run('netstat.exe', ['-ano'], 15_000);
      const viaNetstat = parseNetstat(n.stdout);
      if (viaNetstat.size || n.code === 0) {
        return done(viaNetstat);
      }
      errors.push(`netstat: ${n.stderr.trim().slice(0, 200) || `código ${n.code}`}`);
      const r = await powershell(WIN_PORTS, PS_TIMEOUT_MS);
      const map = parsePortsJson(r.stdout);
      // Saída vazia com código 0 é legítima (nenhuma porta).
      return map.size || r.code === 0 ? done(map) : done(new Map(), [...errors, `Get-NetTCPConnection: ${r.stderr.trim().slice(0, 200) || `código ${r.code}`}`].join('; '));
    }
    const l = await run('lsof', ['-iTCP', '-sTCP:LISTEN', '-nP'], POSIX_TIMEOUT_MS);
    const viaLsof = parsePortsFromLsof(l);
    if (viaLsof) {
      return done(viaLsof);
    }
    errors.push(`lsof: ${l.stderr.trim().slice(0, 200) || `código ${l.code}`}`);
    const s = await run('ss', ['-ltnp'], POSIX_TIMEOUT_MS);
    if (s.code === 0) {
      return done(parseSs(s.stdout));
    }
    return done(new Map(), [...errors, `ss: ${s.stderr.trim().slice(0, 200) || `código ${s.code}`}`].join('; '));
  } catch (e) {
    return done(new Map(), e instanceof Error ? e.message : String(e));
  }
}

/** lsof sai com 1 quando nada escuta; só a falta do executor (-1) ou erro de uso com stderr conta como falha. */
function parsePortsFromLsof(r: Ran): Map<number, number[]> | undefined {
  if (r.code === 0 || (r.code === 1 && !r.stderr.trim())) {
    return parseLsof(r.stdout);
  }
  return undefined;
}

export async function listeningPorts(): Promise<Map<number, number[]>> {
  return (await scanPorts()).value;
}
