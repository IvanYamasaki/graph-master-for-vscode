/** Parsers puros da saída do sistema (PowerShell, ps, lsof, ss, netstat). Separados da execução para testar com fixture. */
import type { ProcInfo } from './types';

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v.trim()) : typeof v === 'number' ? v : NaN;
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Aceita ms em número, "/Date(ms)/" (PowerShell 5.1), ISO e o formato WMI "20260930101500.000000-180". */
export function parseCimDate(v: unknown): Date | undefined {
  if (typeof v === 'number') {
    return Number.isFinite(v) && v > 0 ? new Date(v) : undefined;
  }
  if (typeof v !== 'string' || !v) {
    return undefined;
  }
  const d = /Date\((-?\d+)/.exec(v);
  if (d) {
    return new Date(Number(d[1]));
  }
  const w = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.\d+([+-]\d+)$/.exec(v);
  if (w) {
    const offMin = Number(w[7]);
    return new Date(Date.UTC(+w[1], +w[2] - 1, +w[3], +w[4], +w[5], +w[6]) - offMin * 60_000);
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : new Date(t);
}

/**
 * JSON de `Get-CimInstance Win32_Process | Select ... | ConvertTo-Json`. Com um único processo o PowerShell devolve um objeto
 * em vez de lista. Os nomes são os do Win32_Process (ProcessId, ParentProcessId, Name, CommandLine) mais `Started` em ms.
 */
export function parseWin32Json(text: string): ProcInfo[] {
  const t = stripBom(text).trim();
  if (!t) {
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(t);
  } catch {
    return [];
  }
  const rows = Array.isArray(data) ? data : [data];
  const out: ProcInfo[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      continue;
    }
    const o = row as Record<string, unknown>;
    const pid = num(o.ProcessId ?? o.pid);
    if (pid === undefined) {
      continue;
    }
    out.push({
      pid,
      ppid: num(o.ParentProcessId ?? o.ppid) ?? 0,
      name: String(o.Name ?? o.name ?? ''),
      commandLine: typeof o.CommandLine === 'string' ? o.CommandLine : '',
      startedAt: parseCimDate(o.Started ?? o.CreationDate),
    });
  }
  return out;
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s*(.*)$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** lstart do ps ("Tue Sep 30 10:00:00 2026", hora local). */
export function parseLstart(s: string): Date | undefined {
  const m = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(s.trim());
  if (!m) {
    return undefined;
  }
  const mon = MONTHS.indexOf(m[1]);
  return mon < 0 ? undefined : new Date(+m[6], mon, +m[2], +m[3], +m[4], +m[5]);
}

/** Saída de `ps -eo pid=,ppid=,lstart=,comm=,args=`. `comm` vem inteiro no macOS (caminho) e curto no Linux. */
export function parsePs(text: string): ProcInfo[] {
  const out: ProcInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = PS_LINE.exec(line);
    if (!m) {
      continue;
    }
    const comm = m[4];
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      name: comm.slice(comm.lastIndexOf('/') + 1),
      commandLine: m[5].trim(),
      startedAt: parseLstart(m[3]),
    });
  }
  return out;
}

function addPort(map: Map<number, number[]>, pid: number | undefined, port: number | undefined): void {
  if (pid === undefined || port === undefined || port <= 0 || port > 65535) {
    return;
  }
  const list = map.get(pid) ?? [];
  if (!list.includes(port)) {
    list.push(port);
    list.sort((a, b) => a - b);
  }
  map.set(pid, list);
}

/** JSON de `Get-NetTCPConnection -State Listen | Select LocalPort,OwningProcess | ConvertTo-Json`. */
export function parsePortsJson(text: string): Map<number, number[]> {
  const map = new Map<number, number[]>();
  const t = stripBom(text).trim();
  if (!t) {
    return map;
  }
  let data: unknown;
  try {
    data = JSON.parse(t);
  } catch {
    return map;
  }
  for (const row of Array.isArray(data) ? data : [data]) {
    if (row && typeof row === 'object') {
      const o = row as Record<string, unknown>;
      addPort(map, num(o.OwningProcess), num(o.LocalPort));
    }
  }
  return map;
}

/** `netstat -ano`: só as linhas TCP com endereço remoto de porta 0 (LISTENING, sem depender do idioma do Windows). */
export function parseNetstat(text: string): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+(\S+):0\s+\S+\s+(\d+)\s*$/i.exec(line);
    if (m) {
      addPort(map, Number(m[4]), Number(m[2]));
    }
  }
  return map;
}

/** `lsof -iTCP -sTCP:LISTEN -nP`: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME (LISTEN). */
export function parseLsof(text: string): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (const line of text.split(/\r?\n/)) {
    if (!/\(LISTEN\)\s*$/.test(line)) {
      continue;
    }
    const cols = line.trim().split(/\s+/);
    const name = /(\S+):(\d+)\s+\(LISTEN\)\s*$/.exec(line);
    addPort(map, num(cols[1]), name ? Number(name[2]) : undefined);
  }
  return map;
}

/** `ss -ltnp`: a coluna de endereço local e `users:(("node",pid=1234,fd=19),...)`. */
export function parseSs(text: string): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== 'LISTEN' || cols.length < 5) {
      continue;
    }
    const local = /:(\d+)$/.exec(cols[3]);
    const port = local ? Number(local[1]) : undefined;
    for (const m of line.matchAll(/pid=(\d+)/g)) {
      addPort(map, Number(m[1]), port);
    }
  }
  return map;
}
