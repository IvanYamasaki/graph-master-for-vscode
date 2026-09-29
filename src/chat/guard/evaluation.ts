import { spawn } from 'child_process';

/** Quanto de cada saída volta ao orquestrador. O fim é o que importa (métricas costumam sair por último). */
const TAIL_CHARS = 20_000;

export interface EvaluationResult {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

/**
 * Roda o comando de avaliação oficial no diretório do projeto, fora dos hooks dos agentes (é o processo da
 * extensão que executa, não uma sessão do Claude). Estourando o tempo, mata a árvore de processos.
 */
export function runEvaluation(command: string, cwd: string, timeoutMs: number): Promise<EvaluationResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const keep = (acc: string, chunk: Buffer): string => {
      const next = acc + chunk.toString('utf8');
      return next.length > TAIL_CHARS * 2 ? next.slice(-TAIL_CHARS) : next;
    };
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env: process.env });
    child.stdout?.on('data', (c: Buffer) => (stdout = keep(stdout, c)));
    child.stderr?.on('data', (c: Buffer) => (stderr = keep(stderr, c)));
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    const finish = (exitCode: number | null, extra = '') => {
      clearTimeout(timer);
      resolve({
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
  const head = r.timedOut
    ? `Avaliação interrompida por tempo depois de ${secs}s.`
    : `Avaliação terminou com código ${r.exitCode ?? '?'} em ${secs}s.`;
  return [
    head,
    `Comando: ${r.command}`,
    '',
    'Saída padrão (fim):',
    r.stdout.trim() || '(vazia)',
    ...(r.stderr.trim() ? ['', 'Saída de erro (fim):', r.stderr.trim()] : []),
  ].join('\n');
}
