import { spawn } from 'child_process';
import { acquireHeavy } from './heavy';

/** Quanto de cada saída volta ao orquestrador. O fim é o que importa (métricas costumam sair por último). */
const TAIL_CHARS = 20_000;

export interface EvaluationResult {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  /** Tempo na fila do semáforo de processos pesados, em ms (fora de durationMs). */
  waitedMs?: number;
  /** Rodou com OMP_NUM_THREADS e parentes em 1 porque havia outro processo pesado. */
  singleThread?: boolean;
  /** Parado por AbortSignal (stop do agente ou conversa trocada). */
  aborted?: boolean;
}

export interface HeavyOptions {
  /** Nome na fila do semáforo (ex.: "run_seeds h2 seed 3"). */
  label: string;
  /** Quem chama já vai rodar vários ao mesmo tempo: fios em 1 desde o primeiro. */
  concurrent?: boolean;
  /** Avaliação do orquestrador: não espera na fila (heavy.ts, priority). */
  priority?: boolean;
  /** Parar: sai da fila, ou mata a árvore do processo se já rodava. */
  signal?: AbortSignal;
}

/**
 * Roda o comando de avaliação oficial no diretório do projeto, fora dos hooks dos agentes (é o processo da
 * extensão que executa, não uma sessão do Claude). Estourando o tempo, mata a árvore de processos.
 */
export async function runEvaluation(command: string, cwd: string, timeoutMs: number, heavy: HeavyOptions = { label: 'avaliação' }): Promise<EvaluationResult> {
  // O tempo máximo conta do início do processo, não da espera na fila.
  const slot = await acquireHeavy(heavy.label, { concurrent: heavy.concurrent, priority: heavy.priority, signal: heavy.signal });
  if (!slot) {
    return { command, exitCode: null, timedOut: false, durationMs: 0, stdout: '', stderr: 'interrompido antes de começar (parado na fila de processos pesados)', aborted: true };
  }
  try {
    const r = await spawnEvaluation(command, cwd, timeoutMs, slot.env, heavy.signal);
    return { ...r, waitedMs: slot.waitedMs, singleThread: slot.env.OMP_NUM_THREADS !== process.env.OMP_NUM_THREADS };
  } finally {
    slot.release();
  }
}

function spawnEvaluation(command: string, cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<EvaluationResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const keep = (acc: string, chunk: Buffer): string => {
      const next = acc + chunk.toString('utf8');
      return next.length > TAIL_CHARS * 2 ? next.slice(-TAIL_CHARS) : next;
    };
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env });
    child.stdout?.on('data', (c: Buffer) => (stdout = keep(stdout, c)));
    child.stderr?.on('data', (c: Buffer) => (stderr = keep(stderr, c)));
    const killTree = () => {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      killTree();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (exitCode: number | null, extra = '') => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        aborted: aborted || undefined,
        command,
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
        stdout: stdout.slice(-TAIL_CHARS),
        stderr: (stderr + extra).slice(-TAIL_CHARS),
      });
    };
    child.on('error', (err) => finish(null, `\n${err.message}`));
    child.on('close', (code) => finish(code));
  });
}

export function formatEvaluation(r: EvaluationResult): string {
  const secs = (r.durationMs / 1000).toFixed(1);
  const queued = r.waitedMs && r.waitedMs >= 1000 ? ` Esperou ${(r.waitedMs / 1000).toFixed(0)}s na fila de processos pesados.` : '';
  const head = `${r.timedOut ? `Avaliação interrompida por tempo depois de ${secs}s.` : `Avaliação terminou com código ${r.exitCode ?? '?'} em ${secs}s.`}${queued}`;
  return [
    head,
    `Comando: ${r.command}`,
    '',
    'Saída padrão (fim):',
    r.stdout.trim() || '(vazia)',
    ...(r.stderr.trim() ? ['', 'Saída de erro (fim):', r.stderr.trim()] : []),
  ].join('\n');
}
