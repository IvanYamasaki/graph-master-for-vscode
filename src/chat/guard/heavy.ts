/**
 * Semáforo dos processos pesados que o hub lança por conta própria: seeds do run_seeds, trials de varredura,
 * avaliação oficial e cofre. Um só por processo da extensão, então vale para todos os agentes e conversas da
 * janela: cinco agentes pedindo varredura ao mesmo tempo dividem as mesmas vagas em vez de disputar a CPU.
 *
 * Limite: agentGraphMaster.maxHeavyProcesses (0 = metade dos núcleos). Com mais de um processo rodando, os novos
 * saem com OMP_NUM_THREADS e parentes em 1: cada biblioteca numérica (OpenMP, MKL, OpenBLAS) abre um fio por
 * núcleo, e cinco processos assim na mesma máquina travam uns aos outros.
 */
import * as os from 'node:os';
import * as vscode from 'vscode';

/** Variáveis de fios das bibliotecas numéricas mais comuns (numpy, scipy, torch na CPU, scikit-learn, LightGBM). */
export const THREAD_VARS = ['OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'NUMEXPR_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS'] as const;

export interface HeavySlot {
  /** Ambiente do processo: o do host, com os fios em 1 quando há (ou vai haver) outro processo pesado rodando. */
  env: NodeJS.ProcessEnv;
  /** Quantos rodavam, contando este, quando a vaga saiu. */
  running: number;
  /** Quanto tempo esperou na fila, em ms. */
  waitedMs: number;
  release(): void;
}

interface Waiter {
  label: string;
  /** true: ganhou a vaga (quem libera já contou); false: desistiu (abort) sem vaga. */
  resolve: (granted: boolean) => void;
}

let running = 0;
const queue: Waiter[] = [];
const labels = new Map<number, string>();
let seq = 0;

export function heavyLimit(): number {
  const raw = vscode.workspace.getConfiguration('agentGraphMaster').get<number>('maxHeavyProcesses', 0);
  const auto = Math.max(1, Math.floor(cpuCount() / 2));
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : auto;
}

function cpuCount(): number {
  return typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length || 1;
}

/** "3 de 4 vagas ocupadas, 2 na fila (sw1 trial 7, run_seeds h2)". */
export function heavyStatus(): string {
  const waiting = queue.length ? `, ${queue.length} na fila (${queue.slice(0, 4).map((w) => w.label).join(', ')}${queue.length > 4 ? '...' : ''})` : '';
  const now = labels.size ? ` (${[...labels.values()].slice(0, 4).join(', ')}${labels.size > 4 ? '...' : ''})` : '';
  return `${running} de ${heavyLimit()} vagas de processo pesado ocupadas${now}${waiting}`;
}

export interface HeavyRequest {
  /** Quem pede já vai rodar vários ao mesmo tempo (run_seeds com paralelismo, varredura com parallel > 1): fios em 1 desde o primeiro. */
  concurrent?: boolean;
  /** Consultado ao sair da fila; true devolve a vaga e dá undefined. */
  cancelled?: () => boolean;
  /** Abortado na fila: sai dela na hora, sem vaga, e dá undefined. Já abortado: nem entra. */
  signal?: AbortSignal;
  /**
   * Avaliação oficial do orquestrador: não entra na fila nem espera atrás de seeds e trials dos agentes. Conta como
   * processo rodando (os outros veem e usam um fio só), e pode passar do limite por esse processo.
   */
  priority?: boolean;
  onQueued?: (status: string) => void;
}

/** Espera uma vaga e devolve o ambiente do processo; undefined se cancelado ou abortado antes de rodar. */
export async function acquireHeavy(label: string, opts: HeavyRequest = {}): Promise<HeavySlot | undefined> {
  const started = Date.now();
  if (opts.signal?.aborted) {
    return undefined;
  }
  if (!opts.priority && (running >= heavyLimit() || queue.length)) {
    opts.onQueued?.(heavyStatus());
    // Quem libera já conta a vaga para este antes de acordá-lo.
    let onAbort: (() => void) | undefined;
    const granted = await new Promise<boolean>((resolve) => {
      const waiter: Waiter = { label, resolve };
      queue.push(waiter);
      onAbort = () => {
        const i = queue.indexOf(waiter);
        if (i >= 0) {
          queue.splice(i, 1);
          resolve(false);
        }
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });
    });
    // Ganhou a vaga: o sinal de uma varredura é um só para todos os trials, e ouvinte esquecido acumula
    // (MaxListenersExceededWarning depois de 10).
    if (onAbort) {
      opts.signal?.removeEventListener('abort', onAbort);
    }
    if (!granted) {
      return undefined;
    }
  } else {
    running++;
  }
  if (opts.cancelled?.() || opts.signal?.aborted) {
    releaseOne();
    return undefined;
  }
  const id = ++seq;
  labels.set(id, label);
  const shared = opts.concurrent || running > 1 || queue.length > 0;
  let released = false;
  return {
    env: shared ? singleThreadEnv(process.env) : { ...process.env },
    running,
    waitedMs: Date.now() - started,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      labels.delete(id);
      releaseOne();
    },
  };
}

function releaseOne(): void {
  running = Math.max(0, running - 1);
  // O limite pode ter mudado no meio: solta quantos couberem.
  while (queue.length && running < heavyLimit()) {
    running++;
    queue.shift()!.resolve(true);
  }
}

/** Fios em 1, sem sobrescrever o que o usuário já definiu no ambiente. */
export function singleThreadEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const v of THREAD_VARS) {
    if (!env[v]) {
      env[v] = '1';
    }
  }
  return env;
}

/** Quantos esperam na fila (para teste e diagnóstico). */
export function heavyQueueLength(): number {
  return queue.length;
}

/** Só para teste: zera o estado do módulo. */
export function resetHeavyForTest(): void {
  running = 0;
  queue.length = 0;
  labels.clear();
}

// Palavras-chave de comando que costumam abrir vários processos de uma vez. O texto do comando é tudo que o hook vê:
// um script que faz isso por dentro (ProcessPoolExecutor, joblib) só aparece se o comando disser.
// `-P` só vale no xargs (em scp/ssh é porta) e `-j` só em minúsculas (make, ninja). Start-Process só conta com várias
// ocorrências e sem -Wait: um Start-Process -Wait é sequencial, e um só abre um programa.
const SHORT_J = /(?:^|\s)-j\s*([2-9]|\d{2,})(?=\s|$)/;
const PARALLEL_WORDS = /\b(?:ProcessPoolExecutor|multiprocessing|joblib|Start-Job|ForEach-Object\s+-Parallel)\b/;
const XARGS_P = /\bxargs\b[^|;&\n]*?\s-P\s*([2-9]|\d{2,})(?=\s|$)/;
const LONG_FLAG = /(?:^|\s)--(?:parallel|paralelo|workers|num[-_]?workers|n[-_]?jobs|jobs|procs|processes|processos)[=\s]+([2-9]|\d{2,})(?=\s|$)/i;

function startProcessMany(command: string): string | undefined {
  const uses = command.match(/\bStart-Process\b/gi) ?? [];
  return uses.length >= 2 && !/-Wait\b/i.test(command) ? 'Start-Process' : undefined;
}

/**
 * Aviso para um comando de Bash/PowerShell que parece abrir processos paralelos pesados por fora do semáforo do hub
 * (run_seeds e start_sweep entram na fila). Heurística sobre o texto: não bloqueia, só sugere. Undefined quando o
 * comando não tem cara disso.
 */
export function parallelLaunchHint(command: string): string | undefined {
  const hit = LONG_FLAG.exec(command) ?? SHORT_J.exec(command) ?? XARGS_P.exec(command) ?? PARALLEL_WORDS.exec(command);
  const why = hit ? hit[0].trim() : startProcessMany(command);
  if (!why) {
    return undefined;
  }
  return `Aviso: este comando parece abrir vários processos em paralelo ("${why}"). O hub reparte as vagas de agentGraphMaster.maxHeavyProcesses entre todos os agentes, mas só para o que passa por run_seeds e start_sweep; o que você sobe por Bash fica fora da fila e disputa CPU com os outros agentes. Para treino, seeds ou busca de hiperparâmetros, use run_seeds ou start_sweep. Se for uma tarefa curta e leve, siga: o comando não foi bloqueado.`;
}
