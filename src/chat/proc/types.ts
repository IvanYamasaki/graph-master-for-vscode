/** Tipos do módulo de processos. Sem VS Code: roda no teste com node puro. */

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** Nome do executável (node.exe, cmd.exe, bash). */
  name: string;
  /** Linha de comando completa; vazia quando o sistema não a revela (processos protegidos). */
  commandLine: string;
  /** Pasta de trabalho. Só o Linux informa (/proc/<pid>/cwd); no Windows e no macOS fica vazio. */
  cwd?: string;
  startedAt?: Date;
}

/** Resultado de uma leitura do sistema: nunca lança, o erro vem junto de um valor vazio. */
export interface Scan<T> {
  value: T;
  error?: string;
  /** Quanto a leitura levou, em milissegundos. */
  ms: number;
}

export interface ProcNode {
  proc: ProcInfo;
  children: ProcNode[];
}
