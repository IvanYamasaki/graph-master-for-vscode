/**
 * Árvore de processos de uma sessão: lê todos os processos do sistema numa chamada só (PowerShell no Windows, ps no resto),
 * filtra os descendentes do CLI e mede o extension host. Parsers puros, separados da execução, para teste sem VS Code.
 * Nada aqui lança: falha de leitura volta como lista vazia mais `error`.
 */
import { execFile } from 'node:child_process';

export interface RawProc {
  pid: number;
  ppid: number;
  name: string;
  /** Linha de comando completa (pode vir vazia: o Windows esconde a de processos protegidos). */
  cmd: string;
  /** Working set no Windows, RSS no resto. */
  rssBytes: number;
  /** CPU acumulada (usuário + sistema), em ms. Serve para medir a diferença entre duas amostras. */
  cpuMs?: number;
  /** Início do processo, em ms desde a época. Junto com o PID identifica o processo (o Windows reaproveita PIDs). */
  startedMs?: number;
}

export interface TreeNode extends RawProc {
  /** 1 = filho direto do CLI. */
  depth: number;
  /** Comando curto e legível: "graphify.serve", "ffmpeg -i in.mp4", "bash -c npm run build". */
  short: string;
}

export interface HostMemory {
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
}

export interface Snapshot {
  procs: RawProc[];
  at: number;
  error?: string;
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** Saída de `Get-CimInstance Win32_Process | Select ... | ConvertTo-Json`: um objeto se só há um processo, senão uma lista. */
export function parseWin32Json(text: string): RawProc[] {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, '').trim());
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : [];
  const out: RawProc[] = [];
  for (const item of list as Record<string, unknown>[]) {
    const pid = num(item.ProcessId);
    if (pid === undefined || pid <= 0) {
      continue;
    }
    // Kernel e usuário vêm em unidades de 100 ns.
    const k = num(item.KernelModeTime);
    const u = num(item.UserModeTime);
    out.push({
      pid,
      ppid: num(item.ParentProcessId) ?? 0,
      name: String(item.Name ?? ''),
      cmd: typeof item.CommandLine === 'string' ? item.CommandLine : '',
      rssBytes: num(item.WorkingSetSize) ?? 0,
      cpuMs: k !== undefined || u !== undefined ? ((k ?? 0) + (u ?? 0)) / 10_000 : undefined,
      startedMs: num(item.Started)
    });
  }
  return out;
}

/** "1-02:03:04", "02:03:04", "03:04" ou "03:04.56", em segundos. */
export function parsePsClock(s: string): number | undefined {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(s.trim());
  if (!m) {
    return undefined;
  }
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

const baseName = (p: string): string => p.replace(/^["']|["']$/g, '').split(/[\\/]/).pop() ?? p;

/** Saída de `ps -A -o pid=,ppid=,rss=,time=,etime=,args=` (Linux e macOS). RSS em KB. */
export function parsePs(text: string, now = Date.now()): RawProc[] {
  const out: RawProc[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) {
      continue;
    }
    const cpu = parsePsClock(m[4]);
    const up = parsePsClock(m[5]);
    const cmd = m[6].trim();
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      name: baseName(cmd.split(/\s+/)[0] ?? ''),
      cmd,
      rssBytes: Number(m[3]) * 1024,
      cpuMs: cpu !== undefined ? cpu * 1000 : undefined,
      startedMs: up !== undefined ? now - up * 1000 : undefined
    });
  }
  return out;
}

/** Separa a linha de comando respeitando aspas simples e duplas. */
export function splitArgs(cmd: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const SHELLS = /^(bash|sh|zsh|fish|dash|cmd|powershell|pwsh)(\.exe)?$/i;

/** Nome mais o que identifica o processo: o módulo do `python -m x`, o script do `node x.js`, o argumento do shell. */
export function shortCommand(p: Pick<RawProc, 'name' | 'cmd'>): string {
  const name = p.name.replace(/\.exe$/i, '');
  const rest = splitArgs(p.cmd).slice(1);
  const dash = rest.indexOf('-m');
  if (/^python/i.test(name) && dash >= 0 && rest[dash + 1]) {
    return rest[dash + 1];
  }
  if (/^(python|node|deno|bun|tsx)/i.test(name)) {
    const script = rest.find((a) => !a.startsWith('-'));
    if (script) {
      return clip(baseName(script), 60);
    }
  }
  if (SHELLS.test(p.name)) {
    const i = rest.findIndex((a) => /^(-c|-command|\/c)$/i.test(a));
    if (i >= 0 && rest[i + 1]) {
      return clip(`${name} -c ${rest.slice(i + 1).join(' ')}`, 70);
    }
    return name;
  }
  const flat = rest.map((a) => (/[\\/]/.test(a) ? baseName(a) : a)).join(' ');
  return clip(flat ? `${name} ${flat}` : name, 70);
}

/** Descendentes de `rootPid` (sem ele), em largura. Protege contra ciclos e contra PPID de PID reaproveitado. */
export function descendants(all: readonly RawProc[], rootPid: number): TreeNode[] {
  const byPid = new Map(all.map((p) => [p.pid, p]));
  const kids = new Map<number, RawProc[]>();
  for (const p of all) {
    if (p.pid !== p.ppid) {
      const list = kids.get(p.ppid) ?? [];
      list.push(p);
      kids.set(p.ppid, list);
    }
  }
  const seen = new Set<number>([rootPid]);
  const out: TreeNode[] = [];
  let level = [rootPid];
  for (let depth = 1; level.length; depth++) {
    const next: number[] = [];
    for (const parent of level) {
      const par = byPid.get(parent);
      for (const c of kids.get(parent) ?? []) {
        // Filho que nasceu antes do pai não é filho: o PPID aponta para um PID reaproveitado.
        const orphan = par?.startedMs !== undefined && c.startedMs !== undefined && c.startedMs < par.startedMs - 2000;
        if (seen.has(c.pid) || orphan) {
          continue;
        }
        seen.add(c.pid);
        out.push({ ...c, depth, short: shortCommand(c) });
        next.push(c.pid);
      }
    }
    level = next;
  }
  return out;
}

/** PIDs dos ancestrais de `pid` (sem ele), do pai para cima. */
export function ancestorsOf(all: readonly RawProc[], pid: number): number[] {
  const byPid = new Map(all.map((p) => [p.pid, p]));
  const out: number[] = [];
  let cur = byPid.get(pid);
  while (cur && cur.ppid && !out.includes(cur.ppid) && out.length < 64) {
    out.push(cur.ppid);
    cur = byPid.get(cur.ppid);
  }
  return out;
}

export function hostMemory(): HostMemory {
  const m = process.memoryUsage();
  return { rssBytes: m.rss, heapUsedBytes: m.heapUsed, externalBytes: m.external + m.arrayBuffers };
}

const WIN_SCRIPT =
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,CommandLine,KernelModeTime,UserModeTime,' +
  "@{n='Started';e={if($_.CreationDate){[int64]([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}else{$null}}} | ConvertTo-Json -Compress";

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; err: string }> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
        resolve({ stdout: String(stdout ?? ''), err: String(stderr ?? '') || (err ? err.message : '') });
      });
    } catch (e) {
      resolve({ stdout: '', err: e instanceof Error ? e.message : String(e) });
    }
  });
}

/** Uma chamada para todos os processos do sistema. */
export async function readProcesses(): Promise<Snapshot> {
  const at = Date.now();
  if (process.platform === 'win32') {
    const encoded = Buffer.from(WIN_SCRIPT, 'utf16le').toString('base64');
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], 25_000);
    const procs = parseWin32Json(r.stdout);
    return { procs, at, error: procs.length ? undefined : r.err || 'PowerShell não devolveu processos' };
  }
  const r = await run('ps', ['-A', '-o', 'pid=,ppid=,rss=,time=,etime=,args='], 10_000);
  const procs = parsePs(r.stdout, at);
  return { procs, at, error: procs.length ? undefined : r.err || 'ps não devolveu processos' };
}
