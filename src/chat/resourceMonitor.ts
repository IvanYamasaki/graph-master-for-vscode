/**
 * Monitor de recursos da sessão: a cada N minutos lê a árvore de processos de cada chat (uma chamada ao sistema para todos),
 * acha o que ficou vivo sem fazer nada e monta um resumo curto. Não gasta modelo. Por padrão só sugere; encerrar exige
 * confirmação do usuário (resourceKill) ou `autoKillIdleMinutes` > 0.
 * As regras são funções puras (testadas em resourceMonitor.test.ts); a classe só liga relógio, leitura e kill.
 */
import { execFile } from 'node:child_process';
import { ancestorsOf, descendants, hostMemory, readProcesses, type RawProc, type Snapshot, type TreeNode } from './processTree';
import type { ChatResources, ProcKind, ProcView, ResourceLevel, ResourceReport, SuspectReason, SuspectView } from './resourceMonitorTypes';

export interface ResourceConfig {
  /** Minutos entre amostras. */
  intervalMinutes: number;
  /** Limites do total de um chat (CLI mais filhos), em MB. */
  highMb: number;
  criticalMb: number;
  /** Minutos sem CPU para um filho contar como ocioso. */
  idleMinutes: number;
  /** 0 = desligado: só sugere. Acima de 0, encerra sozinho o ocioso há tanto tempo (nunca servidor MCP ocioso). */
  autoKillIdleMinutes: number;
}

export const DEFAULT_RESOURCE_CONFIG: ResourceConfig = { intervalMinutes: 2, highMb: 1500, criticalMb: 3000, idleMinutes: 30, autoKillIdleMinutes: 0 };

const MB = 1024 * 1024;
/** Menos que isso de CPU entre duas amostras conta como parado. */
const ACTIVE_CPU_MS = 250;
/** Processos abaixo disso não valem um aviso (conhost e afins). */
const MIN_SUSPECT_BYTES = 20 * MB;

export function classifyLevel(bytes: number, cfg: Pick<ResourceConfig, 'highMb' | 'criticalMb'>): ResourceLevel {
  const mb = bytes / MB;
  return mb >= cfg.criticalMb ? 'critico' : mb >= cfg.highMb ? 'alto' : 'ok';
}

export function fmtBytes(b: number): string {
  const mb = b / MB;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1).replace('.', ',')} GB` : `${Math.round(mb)} MB`;
}

export function fmtDuration(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) {
    return 'menos de 1 min';
  }
  if (min < 60) {
    return `${min} min`;
  }
  const h = min / 60;
  return h < 10 ? `${Math.floor(h)} h${min % 60 ? ` ${min % 60} min` : ''}` : `${Math.round(h)} h`;
}

export function procKind(p: Pick<RawProc, 'name' | 'cmd'>): ProcKind {
  const n = p.name.toLowerCase().replace(/\.exe$/, '');
  if (n === 'conhost' || n === 'openconsole') {
    return 'console';
  }
  if (/^(bash|sh|zsh|fish|dash|cmd|powershell|pwsh)$/.test(n)) {
    return 'shell';
  }
  if (n === 'ffmpeg' || n === 'ffprobe' || n === 'ffplay') {
    return 'media';
  }
  if (/\b(mcp|[\w.-]+\.serve|fastmcp)\b/i.test(p.cmd) || /[-_]mcp\b/i.test(p.cmd)) {
    return 'mcp';
  }
  if (/^(python[\d.]*|pythonw|node|deno|bun|uv|uvx|npx)$/.test(n)) {
    return 'runtime';
  }
  return 'other';
}

/** Identidade de um servidor para achar duplicados: nome mais comando sem o caminho do executável. */
export function signature(p: Pick<RawProc, 'name' | 'cmd'>): string {
  return `${p.name.toLowerCase()}|${p.cmd.replace(/^\s*("[^"]*"|\S+)/, '').replace(/\s+/g, ' ').trim()}`;
}

interface Track {
  startedMs?: number;
  cpuMs?: number;
  lastActive: number;
  sampledAt: number;
  cpuPct?: number;
}

/** Guarda, por PID, quando o processo gastou CPU pela última vez. Uma instância por monitor; os chats não colidem (PIDs são únicos). */
export class IdleTracker {
  private tracks = new Map<number, Track>();

  update(nodes: readonly RawProc[], now: number): void {
    const live = new Set<number>();
    for (const n of nodes) {
      live.add(n.pid);
      const prev = this.tracks.get(n.pid);
      const same = prev && (prev.startedMs === undefined || n.startedMs === undefined || Math.abs(prev.startedMs - n.startedMs) < 2000);
      if (prev && same) {
        const delta = n.cpuMs !== undefined && prev.cpuMs !== undefined ? n.cpuMs - prev.cpuMs : undefined;
        const dt = now - prev.sampledAt;
        // Sem leitura de CPU não dá para afirmar nada: trata como ativo.
        const active = delta === undefined || delta > ACTIVE_CPU_MS;
        this.tracks.set(n.pid, {
          startedMs: n.startedMs ?? prev.startedMs,
          cpuMs: n.cpuMs,
          lastActive: active ? now : prev.lastActive,
          sampledAt: now,
          cpuPct: delta !== undefined && dt > 0 ? (delta / dt) * 100 : undefined
        });
      } else {
        // Primeira vez que vemos o processo. Se a CPU média da vida inteira é desprezível, ele está parado desde que nasceu.
        const age = n.startedMs !== undefined ? now - n.startedMs : 0;
        const quiet = n.cpuMs !== undefined && age > 0 && n.cpuMs < 2000 + age * 0.002;
        this.tracks.set(n.pid, { startedMs: n.startedMs, cpuMs: n.cpuMs, lastActive: quiet && n.startedMs !== undefined ? n.startedMs : now, sampledAt: now });
      }
    }
    for (const pid of [...this.tracks.keys()]) {
      if (!live.has(pid)) {
        this.tracks.delete(pid);
      }
    }
  }

  idleMs(pid: number, now: number): number {
    const t = this.tracks.get(pid);
    return t ? Math.max(0, now - t.lastActive) : 0;
  }

  cpuPct(pid: number): number | undefined {
    return this.tracks.get(pid)?.cpuPct;
  }
}

const subtreeOf = (nodes: readonly TreeNode[], pid: number): TreeNode[] => {
  const out: TreeNode[] = [];
  const seen = new Set<number>([pid]);
  let level = [pid];
  while (level.length) {
    const next: number[] = [];
    for (const n of nodes) {
      if (!seen.has(n.pid) && level.includes(n.ppid)) {
        seen.add(n.pid);
        out.push(n);
        next.push(n.pid);
      }
    }
    level = next;
  }
  return out;
};

const toView = (n: TreeNode, kind: ProcKind, idleMs: number, cpuPct?: number): ProcView => ({
  pid: n.pid, name: n.name, short: n.short, kind, rssBytes: n.rssBytes, cpuPct, startedMs: n.startedMs, idleMs, depth: n.depth
});

/**
 * Regras de suspeita, puras. `idleOf(pid)` dá o tempo sem CPU em ms.
 * - duplicado: o mesmo servidor MCP vivo mais de uma vez; vale o mais novo, os outros são sugeridos.
 * - ocioso: filho sem CPU há `idleMinutes` ou mais, e sem nenhum descendente ativo.
 * - shell-parado: shell sem filhos e sem CPU (tarefa em segundo plano que já terminou).
 * Só sobe o processo de cima de cada cadeia (o wrapper do python, não o python dentro dele).
 */
export function findSuspects(nodes: readonly TreeNode[], idleOf: (pid: number) => number, now: number, cfg: Pick<ResourceConfig, 'idleMinutes'>): SuspectView[] {
  const limit = cfg.idleMinutes * 60_000;
  const kinds = new Map(nodes.map((n) => [n.pid, procKind(n)]));
  const picked = new Map<number, SuspectView>();
  const mark = (n: TreeNode, reason: SuspectReason, label: string, risky: boolean): void => {
    const tree = [n, ...subtreeOf(nodes, n.pid)];
    picked.set(n.pid, { ...toView(n, kinds.get(n.pid) ?? 'other', idleOf(n.pid)), reason, label, risky, treeBytes: tree.reduce((s, x) => s + x.rssBytes, 0) });
  };

  // Duplicados: agrupa os "topos" de cada assinatura MCP.
  const mcp = nodes.filter((n) => kinds.get(n.pid) === 'mcp');
  const groups = new Map<string, TreeNode[]>();
  for (const n of mcp) {
    const parent = mcp.find((m) => m.pid === n.ppid);
    if (parent && signature(parent) === signature(n)) {
      continue;
    }
    groups.set(signature(n), [...(groups.get(signature(n)) ?? []), n]);
  }
  for (const group of groups.values()) {
    if (group.length > 1) {
      const newest = Math.max(...group.map((g) => g.startedMs ?? 0));
      const keep = group.find((g) => (g.startedMs ?? 0) === newest) ?? group[0];
      for (const g of group) {
        if (g !== keep) {
          mark(g, 'duplicado', `${g.short} duplicado, há outro mais novo`, false);
        }
      }
    }
  }

  const treeBytesOf = (n: TreeNode): number => n.rssBytes + subtreeOf(nodes, n.pid).reduce((s, x) => s + x.rssBytes, 0);
  for (const n of nodes) {
    const kind = kinds.get(n.pid) ?? 'other';
    if (picked.has(n.pid) || kind === 'console' || (treeBytesOf(n) < MIN_SUSPECT_BYTES && kind !== 'shell')) {
      continue;
    }
    const idle = idleOf(n.pid);
    const below = subtreeOf(nodes, n.pid);
    if (idle < limit || below.some((d) => idleOf(d.pid) < limit)) {
      continue;
    }
    if (kind === 'shell') {
      if (!below.length) {
        mark(n, 'shell-parado', `shell sem tarefa há ${fmtDuration(idle)}`, false);
      }
      continue;
    }
    const what = kind === 'mcp' ? 'servidor MCP' : kind === 'media' ? 'processo de mídia' : 'processo';
    mark(n, 'ocioso', `${what} ${n.short} ocioso há ${fmtDuration(idle)}`, kind === 'mcp');
  }

  // Só o topo de cada cadeia: se o pai também foi marcado, o filho some (o kill do pai leva a árvore junto).
  const out = [...picked.values()].filter((s) => !ancestorsIn(nodes, s.pid).some((a) => picked.has(a)));
  return out.sort((a, b) => b.treeBytes - a.treeBytes);
}

const ancestorsIn = (nodes: readonly RawProc[], pid: number): number[] => ancestorsOf(nodes, pid);

export interface ChatInput {
  chatId: string;
  cliPid?: number;
}

/** Monta o relatório de um chat a partir de uma leitura do sistema. */
export function buildChatReport(input: ChatInput, snap: Snapshot, tracker: IdleTracker, cfg: ResourceConfig): ChatResources {
  const now = snap.at;
  const root = input.cliPid !== undefined ? snap.procs.find((p) => p.pid === input.cliPid) : undefined;
  if (!root || input.cliPid === undefined) {
    return { chatId: input.chatId, cliPid: input.cliPid, alive: false, level: 'ok', totalBytes: 0, cliBytes: 0, childrenBytes: 0, top: [], suspects: [], at: now, error: snap.error };
  }
  const nodes = descendants(snap.procs, root.pid);
  const idleOf = (pid: number) => tracker.idleMs(pid, now);
  const cliBytes = root.rssBytes;
  const childrenBytes = nodes.reduce((s, n) => s + n.rssBytes, 0);
  const cli: TreeNode = { ...root, depth: 0, short: 'CLI' };
  const top = [cli, ...nodes]
    .sort((a, b) => b.rssBytes - a.rssBytes)
    .slice(0, 8)
    .map((n) => toView(n, n === cli ? 'cli' : procKind(n), n === cli ? 0 : idleOf(n.pid), tracker.cpuPct(n.pid)));
  return {
    chatId: input.chatId,
    cliPid: root.pid,
    alive: true,
    level: classifyLevel(cliBytes + childrenBytes, cfg),
    totalBytes: cliBytes + childrenBytes,
    cliBytes,
    childrenBytes,
    top,
    suspects: findSuspects(nodes, idleOf, now, cfg),
    at: now
  };
}

/** Uma linha para o modelo: "Recursos desta sessão: CLI 213 MB; graphify.serve 307 MB ocioso há 2 h; 2 shells parados (4 MB)." */
export function summaryText(r: ChatResources): string {
  if (!r.alive) {
    return 'Recursos desta sessão: sem processo do CLI para medir.';
  }
  const parts = [`CLI ${fmtBytes(r.cliBytes)}`];
  const shells = r.suspects.filter((s) => s.reason === 'shell-parado');
  for (const s of r.suspects.filter((x) => x.reason !== 'shell-parado').slice(0, 4)) {
    parts.push(s.reason === 'duplicado' ? `${s.short} ${fmtBytes(s.treeBytes)} duplicado` : `${s.short} ${fmtBytes(s.treeBytes)} ocioso há ${fmtDuration(s.idleMs)}`);
  }
  if (shells.length) {
    parts.push(`${shells.length} ${shells.length === 1 ? 'shell parado' : 'shells parados'}`);
  }
  const rest = r.childrenBytes - r.suspects.reduce((s, x) => s + x.treeBytes, 0);
  if (rest > MIN_SUSPECT_BYTES) {
    parts.push(`outros filhos ${fmtBytes(rest)}`);
  }
  const level = r.level === 'ok' ? '' : ` (${r.level === 'critico' ? 'crítico' : 'alto'})`;
  return `Recursos desta sessão: ${parts.join('; ')}. Total ${fmtBytes(r.totalBytes)}${level}.`;
}

/** Lê agentGraphMaster.resources.* (`get` é o `getConfiguration('agentGraphMaster.resources').get`); valor ruim cai no padrão. */
export function readResourceConfig(get: <T>(key: string, fallback: T) => T): ResourceConfig {
  const num = (key: keyof ResourceConfig, min: number): number => {
    const v = get<unknown>(key, DEFAULT_RESOURCE_CONFIG[key]);
    return typeof v === 'number' && Number.isFinite(v) && v >= min ? v : DEFAULT_RESOURCE_CONFIG[key];
  };
  return {
    intervalMinutes: num('intervalMinutes', 0.5),
    highMb: num('highMb', 1),
    criticalMb: num('criticalMb', 1),
    idleMinutes: num('idleMinutes', 1),
    autoKillIdleMinutes: num('autoKillIdleMinutes', 0)
  };
}

/**
 * Decide se a próxima mensagem do usuário leva o resumo de recursos. `prevKey` é a chave da última vez que foi enviado.
 * A chave muda com o nível e com o conjunto de suspeitos (não com os MB), então o mesmo estado não se repete a cada
 * mensagem; voltar a 'ok' e sem suspeitos zera a chave, e um problema novo depois é enviado de novo.
 */
export function resourceNote(chat: ChatResources | undefined, summary: string | undefined, prevKey: string | undefined): { note?: string; key?: string } {
  if (!chat || !chat.alive || !summary || (chat.level === 'ok' && !chat.suspects.length)) {
    return { key: undefined };
  }
  const key = `${chat.level}|${chat.suspects.map((s) => `${s.pid}:${s.reason}`).sort().join(',')}`;
  return key === prevKey ? { key } : { note: summary, key };
}

// ---------- Encerrar ----------

export interface KillExpect {
  name?: string;
  startedMs?: number;
}

export interface KillCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Só descendente do CLI desta sessão. Recusa o próprio CLI, o extension host, os ancestrais dele (VS Code) e,
 * com `expect`, qualquer PID que mudou de dono (nome ou hora de início diferentes: o Windows reaproveita PIDs).
 */
export function validateKillTarget(procs: readonly RawProc[], cliPid: number | undefined, pid: number, hostPid: number, expect?: KillExpect): KillCheck {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, reason: 'PID inválido' };
  }
  if (cliPid === undefined || !procs.some((p) => p.pid === cliPid)) {
    return { ok: false, reason: 'o CLI desta sessão não está mais vivo' };
  }
  if (pid === cliPid) {
    return { ok: false, reason: 'esse é o próprio CLI da sessão' };
  }
  if (pid === hostPid || ancestorsOf(procs, hostPid).includes(pid)) {
    return { ok: false, reason: 'esse processo é o VS Code' };
  }
  const target = procs.find((p) => p.pid === pid);
  if (!target) {
    return { ok: false, reason: 'o processo já não existe' };
  }
  if (!descendants(procs, cliPid).some((d) => d.pid === pid)) {
    return { ok: false, reason: 'não é filho desta sessão' };
  }
  if (expect?.name && expect.name.toLowerCase() !== target.name.toLowerCase()) {
    return { ok: false, reason: 'o PID agora é de outro processo' };
  }
  if (expect?.startedMs !== undefined && target.startedMs !== undefined && Math.abs(expect.startedMs - target.startedMs) > 2000) {
    return { ok: false, reason: 'o PID agora é de outro processo' };
  }
  return { ok: true };
}

function runQuiet(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { windowsHide: true, timeout: 15_000 }, (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });
}

export interface KillOutcome {
  ok: boolean;
  message: string;
}

/** Lê o sistema de novo, valida e encerra o processo e tudo que ele subiu. */
export async function killSessionProcess(cliPid: number | undefined, pid: number, expect?: KillExpect, read: () => Promise<Snapshot> = readProcesses): Promise<KillOutcome> {
  const snap = await read();
  const check = validateKillTarget(snap.procs, cliPid, pid, process.pid, expect);
  if (!check.ok) {
    return { ok: false, message: `Não encerrei: ${check.reason}.` };
  }
  let ok: boolean;
  if (process.platform === 'win32') {
    ok = await runQuiet('taskkill', ['/PID', String(pid), '/T', '/F']);
  } else {
    const all = descendants(snap.procs, cliPid!);
    const order = [...all.filter((d) => d.pid === pid), ...subtreeOf(all, pid)].reverse();
    ok = true;
    for (const n of order) {
      try {
        process.kill(n.pid, 'SIGTERM');
      } catch {
        ok = false;
      }
    }
  }
  return { ok, message: ok ? `Encerrei o processo ${pid}.` : `Não consegui encerrar o processo ${pid}.` };
}

// ---------- Relógio ----------

export interface MonitorDeps {
  config: () => ResourceConfig;
  chats: () => ChatInput[];
  onReport: (report: ResourceReport) => void;
  /** Avisa que a regra automática encerrou processos (para mostrar ao usuário). */
  onAutoKill?: (chatId: string, killed: SuspectView[]) => void;
  read?: () => Promise<Snapshot>;
}

export class ResourceMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private tracker = new IdleTracker();
  private busy = false;
  last?: ResourceReport;

  constructor(private deps: MonitorDeps) {}

  start(): void {
    this.stop();
    const ms = Math.max(0.5, this.deps.config().intervalMinutes) * 60_000;
    this.timer = setInterval(() => void this.sample(), ms);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Chame depois de mudar a configuração para valer o novo intervalo. */
  restart(): void {
    this.start();
  }

  /** Texto para o modelo, do último relatório. */
  summaryFor(chatId: string): string | undefined {
    return this.last?.summaries[chatId];
  }

  async sample(): Promise<ResourceReport | undefined> {
    if (this.busy) {
      return this.last;
    }
    this.busy = true;
    try {
      const cfg = this.deps.config();
      const snap = await (this.deps.read ?? readProcesses)();
      const inputs = this.deps.chats();
      const owned = inputs.flatMap((c) => (c.cliPid !== undefined ? descendants(snap.procs, c.cliPid) : []));
      this.tracker.update(owned, snap.at);
      const chats = inputs.map((c) => buildChatReport(c, snap, this.tracker, cfg));
      if (cfg.autoKillIdleMinutes > 0) {
        await this.autoKill(chats, snap, cfg);
      }
      const host = hostMemory();
      const grand = host.rssBytes + chats.reduce((s, c) => s + c.totalBytes, 0);
      const report: ResourceReport = {
        at: snap.at,
        host: { rssBytes: host.rssBytes, heapUsedBytes: host.heapUsedBytes },
        grandTotalBytes: grand,
        level: classifyLevel(grand, { highMb: cfg.highMb * 2, criticalMb: cfg.criticalMb * 2 }),
        chats,
        summaries: Object.fromEntries(chats.map((c) => [c.chatId, summaryText(c)]))
      };
      this.last = report;
      this.deps.onReport(report);
      return report;
    } catch {
      return this.last;
    } finally {
      this.busy = false;
    }
  }

  private async autoKill(chats: ChatResources[], snap: Snapshot, cfg: ResourceConfig): Promise<void> {
    const limit = cfg.autoKillIdleMinutes * 60_000;
    for (const chat of chats) {
      const victims = chat.suspects.filter((s) => !s.risky && s.idleMs >= limit);
      const killed: SuspectView[] = [];
      for (const v of victims) {
        const res = await killSessionProcess(chat.cliPid, v.pid, { name: v.name, startedMs: v.startedMs }, async () => snap);
        if (res.ok) {
          killed.push(v);
        }
      }
      if (killed.length) {
        chat.suspects = chat.suspects.filter((s) => !killed.includes(s));
        this.deps.onAutoKill?.(chat.chatId, killed);
      }
    }
  }
}
