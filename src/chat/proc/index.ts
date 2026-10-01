/** Processos, portas e órfãos das tarefas de shell. Sem VS Code. */
export type { ProcInfo, ProcNode, Scan } from './types';
export { parseWin32Json, parsePs, parsePortsJson, parseNetstat, parseLsof, parseSs } from './parse';
export { descendants, treeOf, flatten, ancestors, ancestorsWhile, protectedPids, isShell, isNode, isEditor, isShellOrNode, isPackageRunner, isCommandShell, isLauncher } from './tree';
export { findRootPid, findRootPids, findOrphans, mentionsDir, type RootHint, type OrphanOptions, type OrphanGroup } from './find';
export { listProcesses, listeningPorts, scanProcesses, scanPorts } from './system';
export { killTree, killTrees, snapOf, matchesSnap, type KillResult, type KillOptions, type KillFailure, type ProcSnap } from './kill';
