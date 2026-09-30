/**
 * Mata uma árvore de processos. Windows: taskkill /T /F. POSIX: SIGTERM nos filhos primeiro, espera curta, SIGKILL no que sobrou.
 * Nunca mata o processo atual nem seus ancestrais (o extension host e o VS Code), e nunca lança.
 */
import { indexOf, protectedPids } from './tree';
import { run, scanProcesses } from './system';
import type { ProcInfo } from './types';

export interface KillFailure {
  pid: number;
  error: string;
}

export interface KillResult {
  /** PIDs que existiam na árvore e deixaram de existir. */
  killed: number[];
  failed: KillFailure[];
  /** Por que nada foi feito (PID protegido, inválido ou sem lista de processos para provar que é seguro). */
  refused?: string;
  /** O PID já não existia: nada a matar. */
  gone?: boolean;
  /** PIDs da árvore viva que não batem com a foto (`snapshot`) e por isso ficaram intactos. */
  skipped?: number[];
}

/** Identidade de um processo: o PID sozinho não basta, o Windows reaproveita PIDs. */
export interface ProcSnap {
  pid: number;
  name: string;
  startedAt?: Date;
}

export const snapOf = (procs: readonly ProcInfo[]): ProcSnap[] => procs.map((p) => ({ pid: p.pid, name: p.name, startedAt: p.startedAt }));

/** Mesmo PID, mesmo nome e mesma hora de início (folga de 1 s: o lstart do ps não tem milissegundos). */
export function matchesSnap(p: ProcInfo, snap: ProcSnap): boolean {
  if (p.pid !== snap.pid || p.name.toLowerCase() !== snap.name.toLowerCase()) {
    return false;
  }
  return !(p.startedAt && snap.startedAt && Math.abs(p.startedAt.getTime() - snap.startedAt.getTime()) > 1000);
}

/** Pontos de entrada do sistema, trocáveis no teste. */
export interface KillIo {
  platform: NodeJS.Platform;
  /** PID do processo atual: a proteção parte dele. */
  selfPid: number;
  listProcs(): Promise<ProcInfo[]>;
  /** Lança se o processo não existe (ESRCH) ou não há permissão (EPERM). */
  signal(pid: number, sig: 'SIGTERM' | 'SIGKILL'): void;
  isAlive(pid: number): boolean;
  taskkill(args: string[]): Promise<{ code: number; stderr: string }>;
  sleep(ms: number): Promise<void>;
}

export const realKillIo: KillIo = {
  platform: process.platform,
  selfPid: process.pid,
  listProcs: async () => (await scanProcesses()).value,
  signal: (pid, sig) => {
    process.kill(pid, sig);
  },
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      // EPERM: existe, mas é de outro usuário.
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  taskkill: async (args) => {
    const r = await run('taskkill.exe', args, 20_000);
    return { code: r.code, stderr: r.stderr || r.stdout };
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export interface KillOptions {
  /** Quanto esperar o SIGTERM antes do SIGKILL (POSIX). Padrão 2000 ms. */
  graceMs?: number;
  /**
   * Foto dos processos que o chamador viu (pid, nome, início). Só morre o que bate com ela: se a raiz não bate, o PID foi
   * reaproveitado e nada é morto (`refused`); descendentes sem foto ou que não batem ficam vivos e voltam em `skipped`.
   */
  snapshot?: readonly ProcSnap[];
  io?: Partial<KillIo>;
}

/** Folhas primeiro: o pai só morre depois dos filhos. */
function leavesFirst(root: ProcInfo, procs: readonly ProcInfo[]): ProcInfo[] {
  const idx = indexOf(procs);
  const order: ProcInfo[] = [];
  const seen = new Set<number>();
  const visit = (p: ProcInfo): void => {
    seen.add(p.pid);
    for (const c of idx.children.get(p.pid) ?? []) {
      if (!seen.has(c.pid)) {
        visit(c);
      }
    }
    order.push(p);
  };
  visit(root);
  return order;
}

export async function killTree(pid: number, options: KillOptions = {}): Promise<KillResult> {
  const io: KillIo = { ...realKillIo, ...options.io };
  try {
    return await killTreeUnsafe(pid, io, options.graceMs ?? 2000, options.snapshot);
  } catch (e) {
    return { killed: [], failed: [{ pid, error: e instanceof Error ? e.message : String(e) }] };
  }
}

async function killTreeUnsafe(pid: number, io: KillIo, graceMs: number, snapshot?: readonly ProcSnap[]): Promise<KillResult> {
  if (!Number.isInteger(pid) || pid <= 4) {
    return { killed: [], failed: [], refused: `PID ${pid} inválido ou do sistema` };
  }
  const procs = await io.listProcs();
  const prot = protectedPids(procs, io.selfPid);
  if (prot.has(pid)) {
    return { killed: [], failed: [], refused: `PID ${pid} é o próprio processo ou um ancestral dele (extension host, VS Code)` };
  }
  if (!procs.length) {
    // Sem a lista não há como provar que o PID não é um ancestral além do pai direto.
    return { killed: [], failed: [], refused: 'sem a lista de processos não dá para garantir que o PID é seguro' };
  }
  const idx = indexOf(procs);
  const root = idx.byPid.get(pid);
  if (!root) {
    return { killed: [], failed: [], gone: true };
  }
  let victims = leavesFirst(root, procs).filter((p) => !prot.has(p.pid));
  let skipped: number[] | undefined;
  if (snapshot) {
    const known = (p: ProcInfo): boolean => snapshot.some((s) => matchesSnap(p, s));
    if (!known(root)) {
      return { killed: [], failed: [], refused: `PID ${pid} não bate com a foto (nome ou hora de início diferentes): o PID foi reaproveitado` };
    }
    const off = victims.filter((v) => !known(v));
    victims = victims.filter(known);
    skipped = off.length ? off.map((v) => v.pid) : undefined;
  }
  const alive = (p: ProcInfo, now: readonly ProcInfo[]): boolean => {
    const cur = now.find((n) => n.pid === p.pid);
    // O mesmo PID com outra hora de início é outro processo (PID reaproveitado).
    return !!cur && !(cur.startedAt && p.startedAt && cur.startedAt.getTime() !== p.startedAt.getTime());
  };

  if (io.platform === 'win32') {
    // Um a um, sem /T: o /T segue o ppid do Windows, que pode apontar para um PID reaproveitado. O pai morre primeiro,
    // senão um --watch recria o filho que acabou de cair.
    const errs = new Map<number, string>();
    const killAll = async (list: readonly ProcInfo[]): Promise<void> => {
      for (const v of list) {
        if (!prot.has(v.pid)) {
          const t = await io.taskkill(['/F', '/PID', String(v.pid)]);
          if (t.code !== 0) {
            errs.set(v.pid, t.stderr.trim() || `taskkill ${t.code}`);
          }
        }
      }
    };
    const order = [...victims].reverse();
    await killAll(order);
    await io.sleep(300);
    let now = await io.listProcs();
    let left = now.length ? victims.filter((v) => alive(v, now)) : [];
    if (left.length) {
      // Acesso negado ou corrida com o encerramento: mais uma tentativa só nos sobreviventes.
      await killAll(left);
      await io.sleep(300);
      now = await io.listProcs();
      left = now.length ? victims.filter((v) => alive(v, now)) : left;
    }
    if (!now.length) {
      // Não deu para reler: vale o código de cada taskkill.
      return { killed: victims.filter((v) => !errs.has(v.pid)).map((v) => v.pid), failed: victims.filter((v) => errs.has(v.pid)).map((v) => ({ pid: v.pid, error: errs.get(v.pid)! })), skipped };
    }
    const failedSet = new Set(left.map((l) => l.pid));
    return {
      killed: victims.filter((v) => !failedSet.has(v.pid)).map((v) => v.pid),
      failed: left.map((l) => ({ pid: l.pid, error: errs.get(l.pid) ?? 'continua vivo depois do taskkill' })),
      skipped,
    };
  }

  const errors = new Map<number, string>();
  const send = (list: readonly ProcInfo[], sig: 'SIGTERM' | 'SIGKILL'): void => {
    for (const v of list) {
      try {
        io.signal(v.pid, sig);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') {
          errors.set(v.pid, (e as Error).message);
        }
      }
    }
  };
  send(victims, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  let left = victims.filter((v) => io.isAlive(v.pid));
  while (left.length && Date.now() < deadline) {
    await io.sleep(100);
    left = left.filter((v) => io.isAlive(v.pid));
  }
  if (left.length) {
    send(left, 'SIGKILL');
    await io.sleep(300);
    left = left.filter((v) => io.isAlive(v.pid));
  }
  const failedSet = new Set(left.map((l) => l.pid));
  return {
    killed: victims.filter((v) => !failedSet.has(v.pid)).map((v) => v.pid),
    failed: left.map((l) => ({ pid: l.pid, error: errors.get(l.pid) ?? 'continua vivo depois do SIGKILL' })),
    skipped,
  };
}

/** Mata várias árvores em sequência (os grupos de findOrphans). Cada uma passa pela mesma proteção. */
export async function killTrees(pids: readonly number[], options: KillOptions = {}): Promise<KillResult> {
  const total: KillResult = { killed: [], failed: [] };
  const refusals: string[] = [];
  for (const pid of pids) {
    const r = await killTree(pid, options);
    total.killed.push(...r.killed);
    total.failed.push(...r.failed);
    if (r.refused) {
      refusals.push(r.refused);
    }
  }
  if (refusals.length) {
    total.refused = refusals.join('; ');
  }
  return total;
}

