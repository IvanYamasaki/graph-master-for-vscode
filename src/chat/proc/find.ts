/** Localiza a raiz de uma tarefa de shell e os processos órfãos de um projeto. Puro: recebe a lista de processos já lida. */
import { ancestorsWhile, descendantsIn, indexOf, isEditor, isLauncher, protectedPids } from './tree';
import type { ProcInfo } from './types';

const DEFAULT_CASE_INSENSITIVE = process.platform !== 'linux';

/** Caminho em forma comparável: barras normais, sem barras duplicadas (JSON escapa "\\"), sem barra final. */
export function normPath(s: string, caseInsensitive: boolean = DEFAULT_CASE_INSENSITIVE): string {
  const n = s.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return caseInsensitive ? n.toLowerCase() : n;
}

const PATH_CHAR = /[a-z0-9_.-]/i;

/**
 * `text` cita a pasta `dir`? A pasta precisa começar e terminar num limite: "wt/a1" não está em "wt/a1-foo" nem "wt/a10".
 * Serve para linha de comando (citação no meio do texto) e para cwd (texto igual à pasta ou dentro dela).
 */
export function mentionsDir(text: string, dir: string, caseInsensitive: boolean = DEFAULT_CASE_INSENSITIVE): boolean {
  const d = normPath(dir, caseInsensitive);
  if (!d || !text) {
    return false;
  }
  const t = normPath(text, caseInsensitive);
  for (let from = 0; ; ) {
    const i = t.indexOf(d, from);
    if (i < 0) {
      return false;
    }
    const before = i === 0 ? '' : t[i - 1];
    const after = t[i + d.length] ?? '';
    if ((!before || !PATH_CHAR.test(before)) && (!after || !PATH_CHAR.test(after))) {
      return true;
    }
    from = i + 1;
  }
}

export interface RootHint {
  /** Trecho da linha de comando (sem diferenciar maiúsculas). */
  commandIncludes?: string;
  /** Pasta de trabalho da tarefa: vale o cwd do processo ou uma linha de comando que a cita. */
  cwd?: string;
  /** Janela de início: o processo começou em [startedAfter, startedBefore]. Fora dela não é candidato, nunca "o mais recente". */
  startedAfter?: Date;
  startedBefore?: Date;
  /** Início esperado: só casa quem começou em [startedNear - windowMs, startedNear + windowMs], e a ordem é pela distância a ele. */
  startedNear?: Date;
  /** Meia-janela de `startedNear`, em ms. Padrão 5000. */
  windowMs?: number;
  /** O processo é descendente (em qualquer nível) deste PID, ex.: o CLI do Claude Code ou process.pid. */
  parentPid?: number;
  /** Sobe até o executor de pacote/shell de comando que lançou o processo achado (npm → cmd → node). Padrão: false. */
  climb?: boolean;
  /** PID do processo atual, para a proteção. Padrão: process.pid. */
  selfPid?: number;
}

/**
 * Todos os PIDs que casam com a dica e não têm pai que também case (as raízes), do mais provável ao menos.
 * Com `startedNear`, `startedAfter` ou `startedBefore` vale o candidato que começou mais perto desse marco; sem janela, o mais recente.
 * Candidato fora da janela não existe: sem nenhum dentro dela o resultado é vazio.
 * Sem nenhum critério devolve vazio: uma dica vazia casaria com tudo.
 */
export function findRootPids(procs: readonly ProcInfo[], hint: RootHint): number[] {
  if (!hint.commandIncludes && !hint.cwd && !hint.startedAfter && !hint.startedBefore && !hint.startedNear && hint.parentPid === undefined) {
    return [];
  }
  const idx = indexOf(procs);
  const prot = protectedPids(procs, hint.selfPid ?? process.pid);
  const under = hint.parentPid !== undefined ? new Set(descendantsIn(hint.parentPid, idx).map((p) => p.pid)) : undefined;
  const needle = hint.commandIncludes?.toLowerCase();
  const matches = (p: ProcInfo): boolean => {
    if (prot.has(p.pid) || isEditor(p)) {
      return false;
    }
    if (under && !under.has(p.pid)) {
      return false;
    }
    if (needle && !p.commandLine.toLowerCase().includes(needle)) {
      return false;
    }
    if (hint.cwd && !(mentionsDir(p.commandLine, hint.cwd) || (p.cwd && mentionsDir(p.cwd, hint.cwd)))) {
      return false;
    }
    if ((hint.startedAfter || hint.startedBefore || hint.startedNear) && !p.startedAt) {
      return false;
    }
    if (hint.startedAfter && p.startedAt!.getTime() < hint.startedAfter.getTime()) {
      return false;
    }
    if (hint.startedBefore && p.startedAt!.getTime() > hint.startedBefore.getTime()) {
      return false;
    }
    if (hint.startedNear && Math.abs(p.startedAt!.getTime() - hint.startedNear.getTime()) > (hint.windowMs ?? 5000)) {
      return false;
    }
    return true;
  };
  const hit = new Set(procs.filter(matches).map((p) => p.pid));
  const found = [...hit]
    .map((pid) => idx.byPid.get(pid)!)
    .filter((p) => {
      const parent = idx.parentOf(p);
      return !parent || !hit.has(parent.pid);
    });
  // `at` é a hora do processo que casou; a ordem não muda se o climb trocar a raiz por um executor que nasceu antes da janela.
  let roots = found.map((r) => ({ pid: r.pid, at: r.startedAt?.getTime() ?? 0 }));
  if (hint.climb) {
    // Só por executores de pacote e shells de comando, e nunca por um protegido ou pelo PID de parentPid.
    roots = found.map((r) => {
      const up = ancestorsWhile(r.pid, procs, (a) => isLauncher(a) && !prot.has(a.pid) && !isEditor(a) && a.pid !== hint.parentPid);
      return { pid: up.length ? up[up.length - 1].pid : r.pid, at: r.startedAt?.getTime() ?? 0 };
    });
  }
  const anchor = (hint.startedNear ?? hint.startedAfter ?? hint.startedBefore)?.getTime();
  roots.sort(anchor !== undefined ? (a, b) => Math.abs(a.at - anchor) - Math.abs(b.at - anchor) || a.pid - b.pid : (a, b) => b.at - a.at || b.pid - a.pid);
  return [...new Set(roots.map((r) => r.pid))];
}

export function findRootPid(procs: readonly ProcInfo[], hint: RootHint): number | undefined {
  return findRootPids(procs, hint)[0];
}

export interface OrphanOptions {
  /** Pastas do projeto: .agm/worktrees/<agente>, .wt, a raiz. Um processo que cita uma delas (linha de comando ou cwd) é candidato. */
  roots: readonly string[];
  /** PIDs que o painel ainda rastreia. Eles e seus descendentes nunca são órfãos. */
  ownedPids: ReadonlySet<number> | readonly number[];
  /** O extension host (process.pid). Ele, seus ancestrais e seus descendentes ficam de fora. */
  excludeAncestorsOf: number;
  /** Portas por PID (listeningPorts), só para anotar os grupos. */
  ports?: ReadonlyMap<number, number[]>;
  /** Saída extra: verdadeiro tira o processo dos candidatos. */
  exclude?: (p: ProcInfo) => boolean;
  caseInsensitive?: boolean;
}

export interface OrphanGroup {
  /** Raiz da árvore órfã: o processo cujo pai não está no grupo. */
  root: ProcInfo;
  /** Raiz e descendentes, raiz primeiro. */
  members: ProcInfo[];
  /** Os que citam a pasta (os demais entraram por descendência ou por serem o executor que lançou o servidor). */
  matchedPids: number[];
  /** Portas em escuta em qualquer membro, sem repetição. */
  ports: number[];
  /** O pai da raiz ainda existe (um terminal externo, por exemplo) em vez de ter morrido. */
  parentAlive: boolean;
}

/**
 * Processos vivos que citam uma pasta do projeto e não pertencem ao painel nem ao editor: o que sobra depois que o Claude Code
 * esquece uma tarefa. O grupo inclui os descendentes sem a pasta na linha (esbuild, conhost) e os executores que lançaram o
 * servidor (npm, cmd /c), que no Windows costumam ser a única ponte viva até o node --watch.
 *
 * Ficam de fora: o editor (Code.exe e derivados, e tudo abaixo de qualquer um deles), o extension host com ancestrais e
 * descendentes, os PIDs possuídos com seus descendentes. Devolve sugestões; quem mata confirma com o usuário.
 */
export function findOrphans(procs: readonly ProcInfo[], opts: OrphanOptions): OrphanGroup[] {
  const ci = opts.caseInsensitive ?? DEFAULT_CASE_INSENSITIVE;
  const dirs = opts.roots.filter((r) => r && r.trim());
  if (!dirs.length) {
    return [];
  }
  const idx = indexOf(procs);

  const excluded = protectedPids(procs, opts.excludeAncestorsOf);
  const shield = (pid: number): void => {
    if (idx.byPid.has(pid)) {
      excluded.add(pid);
      for (const d of descendantsIn(pid, idx)) {
        excluded.add(d.pid);
      }
    }
  };
  shield(opts.excludeAncestorsOf);
  for (const pid of opts.ownedPids) {
    shield(pid);
  }
  for (const p of procs) {
    if (isEditor(p)) {
      shield(p.pid);
    }
  }
  const skip = (p: ProcInfo): boolean => excluded.has(p.pid) || (opts.exclude?.(p) ?? false);

  const mentions = (p: ProcInfo): boolean => dirs.some((d) => mentionsDir(p.commandLine, d, ci) || (!!p.cwd && mentionsDir(p.cwd, d, ci)));
  const matched = procs.filter((p) => !skip(p) && mentions(p));
  if (!matched.length) {
    return [];
  }

  // Candidatos: os que citam a pasta, os executores que os lançaram e tudo que desce de qualquer um deles.
  const set = new Map<number, ProcInfo>();
  const add = (p: ProcInfo): void => {
    if (!skip(p)) {
      set.set(p.pid, p);
    }
  };
  for (const m of matched) {
    add(m);
    for (const a of ancestorsWhile(m.pid, procs, (x) => isLauncher(x) && !skip(x))) {
      add(a);
    }
  }
  for (const p of [...set.values()]) {
    for (const d of descendantsIn(p.pid, idx)) {
      add(d);
    }
  }

  const matchedSet = new Set(matched.map((p) => p.pid));
  const groups: OrphanGroup[] = [];
  for (const p of set.values()) {
    const parent = idx.parentOf(p);
    if (parent && set.has(parent.pid)) {
      continue;
    }
    const members = [p, ...descendantsIn(p.pid, idx).filter((d) => set.has(d.pid))];
    const ports = new Set<number>();
    for (const m of members) {
      for (const port of opts.ports?.get(m.pid) ?? []) {
        ports.add(port);
      }
    }
    groups.push({
      root: p,
      members,
      matchedPids: members.filter((m) => matchedSet.has(m.pid)).map((m) => m.pid),
      ports: [...ports].sort((a, b) => a - b),
      parentAlive: !!parent,
    });
  }
  groups.sort((a, b) => (a.root.startedAt?.getTime() ?? 0) - (b.root.startedAt?.getTime() ?? 0) || a.root.pid - b.root.pid);
  return groups;
}
