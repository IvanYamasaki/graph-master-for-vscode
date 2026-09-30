/**
 * Processos das tarefas de shell do painel: a árvore de cada tarefa, o encerramento dela e os órfãos do projeto.
 * Liga as tarefas do SDK ao módulo ./proc. Sem VS Code: quem confirma com o usuário é o painel.
 *
 * Regra de segurança: a raiz de uma tarefa só é procurada enquanto ela roda, entre os descendentes do CLI da própria
 * sessão e numa janela fechada em torno do início. A identidade achada (PID, nome, hora de início) vira uma foto, e
 * depois disso vale só a foto. Tarefa que não roda mais e não tem foto não é procurada: um comando igual de outra
 * tarefa casaria com a busca, e o "Encerrar" derrubaria o servidor errado.
 */
import * as fs from 'fs';
import * as path from 'path';
import { KillResult, ProcInfo, ProcSnap, findOrphans, findRootPid, flatten, killTree, listProcesses, matchesSnap, scanPorts, scanProcesses, snapOf, treeOf } from './proc';
import type { AgentInfo, OrphanView, ProcView, TaskProcs } from './protocol';
import { commandNeedle, commandPorts } from './taskLiveness';

/** Folga em torno do início da tarefa para achar a raiz dela. */
export const ROOT_WINDOW_MS = 5000;

function view(p: ProcInfo, ports: ReadonlyMap<number, number[]>): ProcView {
  return {
    pid: p.pid,
    ppid: p.ppid,
    name: p.name,
    commandLine: p.commandLine,
    cwd: p.cwd || undefined,
    startedAt: p.startedAt?.toISOString(),
    ports: ports.get(p.pid) ?? [],
  };
}

/** Foto que viaja pelo webview (datas em ISO) de volta a ProcSnap. */
export function snapFromView(v: { pid: number; name: string; startedAt?: string }): ProcSnap {
  return { pid: v.pid, name: v.name, startedAt: v.startedAt ? new Date(v.startedAt) : undefined };
}

/**
 * Raiz da tarefa pela busca: descendente do CLI desta sessão, com um trecho do comando na linha, começado a até 5 s
 * do início da tarefa (o mais perto vence), subindo pelos executores (npm, cmd /c) que o lançaram. O SDK não expõe o PID.
 */
export function searchTaskRoot(info: Pick<AgentInfo, 'command' | 'startedAt'>, procs: readonly ProcInfo[], cliPid: number | undefined): ProcInfo | undefined {
  const needle = commandNeedle(info.command);
  const started = info.startedAt ? Date.parse(info.startedAt) : NaN;
  if (!needle || cliPid === undefined || !Number.isFinite(started)) {
    return undefined;
  }
  const pid = findRootPid(procs, { commandIncludes: needle, parentPid: cliPid, startedNear: new Date(started), windowMs: ROOT_WINDOW_MS, climb: true });
  return pid === undefined ? undefined : procs.find((p) => p.pid === pid);
}

export interface TaskProcsRead {
  procs: TaskProcs;
  /** Identidade da raiz: a de antes, ou a achada agora pela busca. */
  root?: ProcSnap;
  /** Foto da árvore viva (raiz e descendentes) nesta leitura: é o que um kill confirmado pode matar. */
  snap: ProcSnap[];
}

/**
 * Árvore de processos de uma tarefa de shell, com portas em escuta e as portas que o comando cita. Com `root`, vale só
 * a foto; sem ela, busca apenas se `search` (tarefa rodando, CLI desta sessão vivo).
 */
export async function readTaskProcs(info: AgentInfo, opts: { root?: ProcSnap; cliPid?: number; search: boolean }): Promise<TaskProcsRead> {
  const [procs, ports] = await Promise.all([scanProcesses(), scanPorts()]);
  const listening = new Set([...ports.value.values()].flat());
  let rootSnap = opts.root;
  let root: ProcInfo | undefined;
  if (rootSnap) {
    root = procs.value.find((p) => matchesSnap(p, rootSnap!));
  } else if (opts.search) {
    root = searchTaskRoot(info, procs.value, opts.cliPid);
    rootSnap = root ? snapOf([root])[0] : undefined;
  }
  const tree = root ? treeOf(root.pid, procs.value) : undefined;
  const members = tree ? flatten(tree) : [];
  const out: TaskProcs = {
    agentId: info.id,
    members: members.map((p) => view(p, ports.value)),
    root: members.length ? view(members[0], ports.value) : undefined,
    identified: !!rootSnap,
    expectedPorts: commandPorts(info.command).map((port) => ({ port, up: listening.has(port) })),
    error: procs.error ?? ports.error,
    scannedAt: new Date().toISOString(),
  };
  return { procs: out, root: rootSnap, snap: snapOf(members) };
}

/** Resultado de um kill com foto: o que não bateu com a foto ficou vivo e volta aqui. */
export interface StampedKill extends KillResult {
  /** PIDs da foto que não conferiam mais (PID reaproveitado, processo novo) e por isso não foram mortos. */
  skipped?: number[];
}

/**
 * Encerra o que da foto ainda está vivo com a mesma identidade (PID, nome, início), releando a lista agora. Cada
 * sobrevivente leva só os descendentes que também estão na foto.
 */
export async function killSnapshot(snap: readonly ProcSnap[]): Promise<StampedKill> {
  const total: StampedKill = { killed: [], failed: [] };
  if (!snap.length) {
    return total;
  }
  const alive = await listProcesses();
  const skipped = new Set<number>();
  const refusals: string[] = [];
  for (const s of snap) {
    const p = alive.find((a) => a.pid === s.pid);
    if (!p) {
      continue;
    }
    if (!matchesSnap(p, s)) {
      skipped.add(s.pid);
      continue;
    }
    if (total.killed.includes(s.pid)) {
      continue;
    }
    const r = await killTree(s.pid, { snapshot: [...snap] });
    total.killed.push(...r.killed.filter((k) => !total.killed.includes(k)));
    total.failed.push(...r.failed);
    r.skipped?.forEach((k) => skipped.add(k));
    if (r.refused && !r.gone) {
      refusals.push(r.refused);
    }
  }
  if (skipped.size) {
    total.skipped = [...skipped];
  }
  if (refusals.length) {
    total.refused = refusals.join('; ');
  }
  return total;
}

/** Pastas do projeto em que um processo solto conta como órfão: a raiz, os worktrees em .agm/worktrees e o .wt, se existir. */
export function orphanRoots(cwd: string): string[] {
  const roots = [cwd];
  const worktrees = path.join(cwd, '.agm', 'worktrees');
  try {
    for (const e of fs.readdirSync(worktrees, { withFileTypes: true })) {
      if (e.isDirectory()) {
        roots.push(path.join(worktrees, e.name));
      }
    }
  } catch {
    // Sem worktrees.
  }
  for (const wt of [path.join(cwd, '.wt'), `${cwd}.wt`]) {
    if (fs.existsSync(wt)) {
      roots.push(wt);
    }
  }
  return roots;
}

export interface OrphanScan {
  groups: OrphanView[];
  /** Foto de cada árvore, pela raiz: o kill confirmado só mata o que ainda bate com ela. */
  snaps: Map<number, ProcSnap[]>;
  error?: string;
}

/**
 * Árvores órfãs do projeto: primeiro as de pai morto (sobras de sessão), da mais antiga para a mais nova; depois as de
 * pai vivo (terminal externo, outro claude), que o usuário pode ter aberto de propósito.
 */
export async function scanOrphans(cwd: string): Promise<OrphanScan> {
  const [procs, ports] = await Promise.all([scanProcesses(), scanPorts()]);
  const groups = findOrphans(procs.value, { roots: orphanRoots(cwd), ownedPids: [], excludeAncestorsOf: process.pid, ports: ports.value });
  const byPid = new Map(procs.value.map((p) => [p.pid, p]));
  const t = (p: ProcInfo): number => p.startedAt?.getTime() ?? 0;
  groups.sort((a, b) => Number(a.parentAlive) - Number(b.parentAlive) || t(a.root) - t(b.root));
  const snaps = new Map<number, ProcSnap[]>();
  const views = groups.map((g) => {
    snaps.set(g.root.pid, snapOf(g.members));
    const parent = byPid.get(g.root.ppid);
    return {
      root: view(g.root, ports.value),
      members: g.members.map((m) => view(m, ports.value)),
      ports: g.ports,
      parentAlive: g.parentAlive,
      parent: { pid: g.root.ppid, name: g.parentAlive && parent ? parent.name : undefined, alive: g.parentAlive },
    };
  });
  return { groups: views, snaps, error: procs.error ?? (procs.value.length ? undefined : 'a lista de processos veio vazia') };
}

/** Quebra um texto longo (linha de comando) em linhas de até `width` caracteres. */
export function wrapLines(text: string, width = 100): string[] {
  const one = text.replace(/\s+/g, ' ').trim();
  const out: string[] = [];
  for (let i = 0; i < one.length; i += width) {
    out.push(one.slice(i, i + width));
  }
  return out.length ? out : [''];
}

/** Detalhe do modal de confirmação: por árvore, pai (e se vive), início, portas e o comando inteiro quebrado em linhas. */
export function orphanDetail(groups: readonly OrphanView[]): string {
  return groups
    .map((g, i) => {
      const r = g.root;
      const parent = g.parent?.alive ? `pai: ${g.parent.name ?? '?'} PID ${g.parent.pid}, ainda aberto` : `pai: PID ${g.parent?.pid ?? r.ppid}, encerrado`;
      return [
        `${i + 1}. ${r.name} PID ${r.pid} · ${g.members.length} ${g.members.length === 1 ? 'processo' : 'processos'}`,
        `   ${parent}`,
        `   início: ${r.startedAt ? new Date(r.startedAt).toLocaleString() : 'desconhecido'} · portas: ${g.ports.length ? g.ports.join(', ') : 'nenhuma'}`,
        ...wrapLines(r.commandLine || r.name).map((l) => `   ${l}`),
      ].join('\n');
    })
    .join('\n\n');
}

/** Frase curta do resultado de um kill, para o aviso. */
export function killSummary(r: StampedKill): string {
  const parts = [`${r.killed.length} ${r.killed.length === 1 ? 'processo encerrado' : 'processos encerrados'}`];
  if (r.failed.length) {
    parts.push(`${r.failed.length} falharam (${r.failed.map((f) => `${f.pid}: ${f.error}`).join('; ').slice(0, 200)})`);
  }
  if (r.skipped?.length) {
    parts.push(`${r.skipped.length} não conferiam mais com a lista e ficaram vivos (PID ${r.skipped.join(', ')})`);
  }
  if (r.refused) {
    parts.push(`recusado: ${r.refused}`);
  }
  return parts.join(', ');
}
