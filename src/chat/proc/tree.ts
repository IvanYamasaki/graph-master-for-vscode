/** Árvore de processos por ParentProcessId e predicados de "quem é quem". Funções puras sobre uma lista já lida. */
import type { ProcInfo, ProcNode } from './types';

export interface ProcIndex {
  byPid: Map<number, ProcInfo>;
  children: Map<number, ProcInfo[]>;
  /** Pai real do processo, ou undefined (pai morto, pid 0 ou pid reaproveitado). */
  parentOf(p: ProcInfo): ProcInfo | undefined;
}

/**
 * O Windows reaproveita PIDs e não reparenta órfãos: o ppid de um filho pode apontar para um processo novo que
 * nada tem a ver com ele. Um pai iniciado depois do filho não é pai, e a aresta é descartada.
 */
function isRealParent(parent: ProcInfo | undefined, child: ProcInfo): parent is ProcInfo {
  if (!parent || parent.pid === child.pid) {
    return false;
  }
  if (parent.startedAt && child.startedAt && parent.startedAt.getTime() > child.startedAt.getTime()) {
    return false;
  }
  return true;
}

export function indexOf(procs: readonly ProcInfo[]): ProcIndex {
  const byPid = new Map<number, ProcInfo>();
  for (const p of procs) {
    byPid.set(p.pid, p);
  }
  const children = new Map<number, ProcInfo[]>();
  const parentOf = (p: ProcInfo): ProcInfo | undefined => {
    const parent = byPid.get(p.ppid);
    return isRealParent(parent, p) ? parent : undefined;
  };
  for (const p of byPid.values()) {
    const parent = parentOf(p);
    if (parent) {
      const list = children.get(parent.pid) ?? [];
      list.push(p);
      children.set(parent.pid, list);
    }
  }
  return { byPid, children, parentOf };
}

/** Todos os descendentes de `pid` (sem ele), em largura. Seguro contra ciclos. */
export function descendants(pid: number, procs: readonly ProcInfo[]): ProcInfo[] {
  return descendantsIn(pid, indexOf(procs));
}

export function descendantsIn(pid: number, idx: ProcIndex): ProcInfo[] {
  const out: ProcInfo[] = [];
  const seen = new Set<number>([pid]);
  const queue = [pid];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const c of idx.children.get(cur) ?? []) {
      if (!seen.has(c.pid)) {
        seen.add(c.pid);
        out.push(c);
        queue.push(c.pid);
      }
    }
  }
  return out;
}

/** A árvore com filhos a partir de `rootPid`, ou undefined se ele não existe na lista. */
export function treeOf(rootPid: number, procs: readonly ProcInfo[]): ProcNode | undefined {
  const idx = indexOf(procs);
  const root = idx.byPid.get(rootPid);
  if (!root) {
    return undefined;
  }
  const seen = new Set<number>();
  const build = (p: ProcInfo): ProcNode => {
    seen.add(p.pid);
    const node: ProcNode = { proc: p, children: [] };
    for (const c of idx.children.get(p.pid) ?? []) {
      if (!seen.has(c.pid)) {
        node.children.push(build(c));
      }
    }
    return node;
  };
  return build(root);
}

/** Achata uma árvore (raiz primeiro). */
export function flatten(node: ProcNode): ProcInfo[] {
  return [node.proc, ...node.children.flatMap(flatten)];
}

/** Ancestrais de `pid`, do pai para cima. Sem `pid` na lista, vazio. */
export function ancestors(pid: number, procs: readonly ProcInfo[]): ProcInfo[] {
  return ancestorsWhile(pid, procs, () => true);
}

/**
 * Sobe a partir do pai de `pid` enquanto `pred` for verdadeiro e devolve os ancestrais aceitos, o mais próximo primeiro.
 * Para no primeiro que falha. Caso típico: npm (node) → cmd /c → node, subindo só por shells e executores de pacote.
 */
export function ancestorsWhile(pid: number, procs: readonly ProcInfo[], pred: (p: ProcInfo) => boolean): ProcInfo[] {
  const idx = indexOf(procs);
  const out: ProcInfo[] = [];
  const seen = new Set<number>([pid]);
  let cur = idx.byPid.get(pid);
  while (cur) {
    const parent = idx.parentOf(cur);
    if (!parent || seen.has(parent.pid) || !pred(parent)) {
      break;
    }
    seen.add(parent.pid);
    out.push(parent);
    cur = parent;
  }
  return out;
}

const SHELL_NAMES = /^(cmd|powershell|pwsh|bash|sh|zsh|dash|fish|wsl|conhost|openconsole)(\.exe)?$/i;
const NODE_NAMES = /^(node|nodejs|bun|deno)(\.exe)?$/i;
const EDITOR_NAMES = /^(code|code - insiders|code-insiders|cursor|windsurf|codium|vscodium|code-oss)(\.exe)?$/i;
const RUNNER_CMD = /(^|[\\/\s"'])(npm|npx|pnpm|pnpx|yarn|bun|bunx)(-cli)?(\.cjs|\.js|\.cmd|\.ps1|\.exe)?(\s|$|["'])|[\\/](npm|pnpm|yarn)[\\/](bin|dist)[\\/]/i;

export const isShell = (p: ProcInfo): boolean => SHELL_NAMES.test(p.name);
export const isNode = (p: ProcInfo): boolean => NODE_NAMES.test(p.name);
/** Code.exe, code, Cursor e derivados: o editor e seus processos auxiliares (o extension host também é um Code.exe). */
export const isEditor = (p: ProcInfo): boolean => EDITOR_NAMES.test(p.name);
export const isShellOrNode = (p: ProcInfo): boolean => isShell(p) || isNode(p);
/** npm, npx, pnpm, yarn ou bun na linha de comando (o `node npm-cli.js run dev` do Windows também conta). */
export const isPackageRunner = (p: ProcInfo): boolean => RUNNER_CMD.test(p.commandLine);
/** Shell que roda um comando e sai (`cmd /c ...`, `sh -c ...`), ao contrário de um terminal interativo. */
export const isCommandShell = (p: ProcInfo): boolean => isShell(p) && /(^|\s)(\/[ck]|-c|-command|-encodedcommand)(\s|$)/i.test(p.commandLine);
/** Seguro de subir por ele ao procurar o dono de um servidor: executor de pacote ou shell de comando, nunca terminal interativo. */
export const isLauncher = (p: ProcInfo): boolean => isPackageRunner(p) || isCommandShell(p);

/** Pid de `selfPid` e de todos os seus ancestrais: o que nunca se mata. */
export function protectedPids(procs: readonly ProcInfo[], selfPid: number = process.pid): Set<number> {
  const set = new Set<number>([selfPid]);
  for (const a of ancestors(selfPid, procs)) {
    set.add(a.pid);
  }
  // Sem a lista (ou com ela incompleta) o pai direto ainda é conhecido pelo Node.
  if (selfPid === process.pid && process.ppid > 0) {
    set.add(process.ppid);
  }
  return set;
}
