/**
 * Quanto falta para um processo em segundo plano terminar, em camadas e sem chute:
 * 1. pela saída: o fim do arquivo de saída traz uma porcentagem, um N/M ou o contador de testes (vitest, jest, pytest);
 * 2. pela duração das últimas execuções do mesmo comando (assinatura normalizada, mediana);
 * 3. sem nenhum dos dois, nada: a barra fica indeterminada e só o tempo decorrido aparece.
 * Regras puras, sem fs: o host lê os arquivos e o webview só faz a conta com o relógio.
 */

/** Progresso lido da saída: fração de 0 a 1 e o trecho que a justificou ("45%", "12/40", "3 de 12 arquivos"). */
export interface OutputProgress {
  fraction: number;
  label: string;
}

/** Estimativa que vai ao webview dentro de BackgroundTaskInfo. */
export interface BgEstimate {
  source: 'output' | 'history';
  /** Só pela saída: fração lida e quando foi lida (epoch ms). */
  fraction?: number;
  label?: string;
  readAt?: number;
  /** Só pelo histórico: mediana das durações (ms) e quantas execuções entraram nela. */
  expectedMs?: number;
  runs?: number;
}

/** Durações guardadas por assinatura: as últimas, em ms, e quando a última entrou (para podar as velhas). */
export interface DurationBook {
  [signature: string]: { ms: number[]; at: number };
}

/** Quantas durações ficam por assinatura e quantas assinaturas no total. */
export const KEEP_RUNS = 5;
export const KEEP_SIGNATURES = 200;
/** Abaixo disto não vale guardar: comando que acaba em segundos não precisa de barra. */
export const MIN_RECORD_MS = 5000;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;

/** Linhas do fim da saída, sem cores, a última primeiro. \r separa os redesenhos de barra na mesma linha. */
function lastLines(tail: string, max = 40): string[] {
  return tail
    .replace(ANSI, '')
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-max)
    .reverse();
}

function ratio(done: number, total: number, label: string): OutputProgress | undefined {
  if (!(total > 0) || done < 0 || done > total) {
    return undefined;
  }
  return { fraction: done / total, label };
}

/** Soma "3 passed | 1 failed | 2 skipped" (vitest) ou "1 failed, 12 passed" (jest). */
function sumCounts(text: string): number {
  let n = 0;
  for (const m of text.matchAll(/(\d+)\s+(?:passed|failed|skipped|todo|pending)\b/gi)) {
    n += Number(m[1]);
  }
  return n;
}

/** Uma linha: o formato mais específico primeiro. */
function lineProgress(line: string): OutputProgress | undefined {
  // vitest: "Test Files  3 passed | 1 failed (12)" e "Tests  40 passed (120)".
  let m = /^(Test Files|Tests)\s+(.*?)\((\d+)\)\s*$/.exec(line);
  if (m) {
    const done = sumCounts(m[2]);
    return ratio(done, Number(m[3]), m[1] === 'Test Files' ? `${done} de ${m[3]} arquivos de teste` : `${done} de ${m[3]} testes`);
  }
  // jest: "Test Suites: 3 passed, 12 total", "Tests: 1 failed, 12 passed, 40 total".
  m = /^(Test Suites|Tests):\s+(.*?),?\s*(\d+)\s+total\b/.exec(line);
  if (m) {
    const done = sumCounts(m[2]);
    return ratio(done, Number(m[3]), m[1] === 'Test Suites' ? `${done} de ${m[3]} arquivos de teste` : `${done} de ${m[3]} testes`);
  }
  // "12 passed, 3 remaining".
  m = /(\d+)\s+(?:passed|done|completed?)\b.*?(\d+)\s+remaining\b/i.exec(line);
  if (m) {
    const done = Number(m[1]);
    return ratio(done, done + Number(m[2]), `${done} de ${done + Number(m[2])}`);
  }
  // pytest: "tests/test_x.py ....F.. [ 45%]".
  m = /\[\s*(\d{1,3})%\]\s*$/.exec(line);
  if (m) {
    return ratio(Number(m[1]), 100, `${m[1]}%`);
  }
  // "[12/40]", "12/40", "12 of 40", "12 de 40". Data (10/11/2026) e caminho (src/12/40) não contam.
  m = /\[\s*(\d+)\s*\/\s*(\d+)\s*\]/.exec(line) ?? /(?:^|[\s(])(\d+(?:\.\d+)?)\s*(?:\/|\bof\b|\bde\b)\s*(\d+(?:\.\d+)?)(?=$|[\s),:;]|\s?[kMG]?i?B\b)/.exec(line);
  if (m && !/\d\/\d+\/\d/.test(line.slice(Math.max(0, m.index - 3), m.index + m[0].length + 3))) {
    const done = Number(m[1]);
    const total = Number(m[2]);
    if (total >= 2) {
      const p = ratio(done, total, `${m[1]}/${m[2]}`);
      if (p) {
        return p;
      }
    }
  }
  // "45%", "45.2 %" (npm, pip, git, curl).
  const pcts = [...line.matchAll(/(?:^|[^\w.])(\d{1,3}(?:\.\d+)?)\s?%/g)].map((x) => Number(x[1])).filter((v) => v <= 100);
  if (pcts.length) {
    const v = pcts[pcts.length - 1];
    return ratio(v, 100, `${Math.round(v)}%`);
  }
  // Barra desenhada: "[#####.....]", "⸨████░░░░⸩", "|=====     |".
  m = /[[⸨|]([#█▇■=>]+)([\s░·.\-]*)[\]⸩|]/.exec(line);
  if (m && m[1].length + m[2].length >= 10) {
    const v = m[1].length / (m[1].length + m[2].length);
    return ratio(v, 1, `${Math.round(v * 100)}%`);
  }
  return undefined;
}

/** Progresso pelo fim da saída: a última linha que traz um, olhando as ~40 últimas. Nada reconhecível: undefined. */
export function parseProgress(tail: string): OutputProgress | undefined {
  for (const line of lastLines(tail)) {
    const p = lineProgress(line);
    if (p) {
      return p;
    }
  }
  return undefined;
}

/**
 * Assinatura do comando para o histórico: o mesmo comando com outro arquivo temporário, outro id ou outro worktree
 * cai na mesma entrada. Tira o `cd ... &&` do começo, os redirecionamentos e o tee, e troca o que varia por marcadores.
 */
export function commandSignature(command: string): string {
  let s = command.trim();
  // cd do começo (o worktree muda de agente para agente).
  s = s.replace(/^(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*)+/, '');
  // Redirecionamentos e tee: o destino costuma ser um arquivo de vez.
  s = s.replace(/\s*\|\s*tee(?:\s+-a)?\s+(?:"[^"]*"|'[^']*'|\S+)/g, '');
  s = s.replace(/\s*\d?>&\d/g, '');
  s = s.replace(/\s*(?:&>>?|\d?>>?)\s*(?:"[^"]*"|'[^']*'|\S+)/g, '');
  // O que varia de execução para execução.
  s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>');
  s = s.replace(/(?:\/tmp\/|[A-Za-z]:[\\/][^\s"']*?[\\/]Temp[\\/]|\$TEMP[\\/]|%TEMP%[\\/])[^\s"']*/gi, '<tmp>');
  s = s.replace(/\.agm[\\/]worktrees[\\/][^\s"'\\/]+/g, '.agm/worktrees/<wt>');
  s = s.replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gi, '<hash>');
  s = s.replace(/\d{4,}/g, '<n>');
  return s.replace(/\s+/g, ' ').trim().slice(0, 400);
}

export function median(xs: number[]): number | undefined {
  if (!xs.length) {
    return undefined;
  }
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Guarda uma duração: as últimas KEEP_RUNS por assinatura, e no máximo KEEP_SIGNATURES assinaturas (some a mais velha). */
export function recordDuration(book: DurationBook, signature: string, ms: number, now = Date.now()): DurationBook {
  if (!signature || !(ms >= MIN_RECORD_MS)) {
    return book;
  }
  const prev = book[signature]?.ms ?? [];
  const next: DurationBook = { ...book, [signature]: { ms: [...prev, Math.round(ms)].slice(-KEEP_RUNS), at: now } };
  const keys = Object.keys(next);
  if (keys.length > KEEP_SIGNATURES) {
    keys.sort((a, b) => next[a].at - next[b].at);
    for (const k of keys.slice(0, keys.length - KEEP_SIGNATURES)) {
      delete next[k];
    }
  }
  return next;
}

/** A estimativa de um processo: a saída manda; sem ela, o histórico; sem nenhum, nada. */
export function estimate(progress: OutputProgress | undefined, history: number[] | undefined, readAt = Date.now()): BgEstimate | undefined {
  if (progress) {
    return { source: 'output', fraction: progress.fraction, label: progress.label, readAt };
  }
  const expectedMs = history?.length ? median(history) : undefined;
  if (expectedMs && expectedMs > 0) {
    return { source: 'history', expectedMs, runs: history!.length };
  }
  return undefined;
}

/** O que a barra mostra agora: fração (ausente: indeterminada), quanto falta e se já passou da média. */
export interface EtaView {
  fraction?: number;
  leftMs?: number;
  over: boolean;
}

/**
 * Conta do webview a cada segundo. Pela saída, o que falta sai do ritmo até aqui (decorrido / fração), só depois de 5%
 * e de 10 s, para não prometer cedo demais. Pelo histórico, mediana menos o decorrido; passou dela, "passou da média".
 */
export function etaView(est: BgEstimate | undefined, elapsedMs: number): EtaView {
  if (!est) {
    return { over: false };
  }
  if (est.source === 'output' && est.fraction !== undefined) {
    const f = est.fraction;
    const leftMs = f >= 0.05 && f < 1 && elapsedMs >= 10000 ? (elapsedMs * (1 - f)) / f : undefined;
    return { fraction: f, leftMs, over: false };
  }
  if (est.source === 'history' && est.expectedMs) {
    if (elapsedMs > est.expectedMs) {
      return { fraction: 1, over: true };
    }
    return { fraction: elapsedMs / est.expectedMs, leftMs: est.expectedMs - elapsedMs, over: false };
  }
  return { over: false };
}

/** "falta ~4 min", "falta ~40 s", "falta ~1h 10min". */
export function fmtLeft(ms: number): string {
  const s = Math.max(0, ms / 1000);
  if (s < 50) {
    return `falta ~${Math.max(5, Math.round(s / 5) * 5)} s`;
  }
  const min = Math.round(s / 60);
  if (min < 60) {
    return `falta ~${Math.max(1, min)} min`;
  }
  return `falta ~${Math.floor(min / 60)}h ${min % 60}min`;
}

/** De onde veio a estimativa, para o tooltip. */
export function etaSource(est: BgEstimate | undefined): string {
  if (!est) {
    return 'Sem estimativa: a saída não mostra progresso e este comando ainda não rodou até o fim aqui.';
  }
  if (est.source === 'output') {
    return `Estimativa pela saída do processo (${est.label ?? 'progresso'}), supondo o mesmo ritmo até o fim.`;
  }
  return est.runs === 1 ? 'Estimativa pela duração da última execução deste comando.' : `Estimativa pela duração das últimas ${est.runs} execuções deste comando (mediana).`;
}

/** Destino de `> arquivo`, `>> arquivo`, `&> arquivo` ou `| tee arquivo` do comando, como escrito; o último vence. */
export function redirectTarget(command: string): string | undefined {
  let found: string | undefined;
  for (const m of command.matchAll(/(?:\|\s*tee(?:\s+-a)?|&>>?|(?<![\d&])1?>>?)\s*("[^"]*"|'[^']*'|[^\s;&|<>]+)/g)) {
    const raw = m[1].replace(/^["']|["']$/g, '');
    if (raw && !raw.startsWith('&') && raw !== '/dev/null' && raw.toLowerCase() !== 'nul') {
      found = raw;
    }
  }
  return found;
}

/** Diretório do `cd X &&` do começo do comando, se houver. */
export function leadingCd(command: string): string | undefined {
  const m = /^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*(?:&&|;)/.exec(command);
  return m ? m[1].replace(/^["']|["']$/g, '') : undefined;
}

/**
 * Caminho escrito no comando (bash do Git no Windows ou shell POSIX) para um caminho do sistema: /tmp vira a pasta
 * temporária, /c/... vira C:/..., ~ vira a home e relativo parte de `cwd`.
 */
export function resolveShellPath(raw: string, env: { cwd: string; tmp: string; home: string; win: boolean }): string {
  const join = (a: string, b: string) => `${a.replace(/[\\/]+$/, '')}/${b.replace(/^[\\/]+/, '')}`;
  if (env.win) {
    if (/^\/tmp(\/|$)/.test(raw)) {
      return join(env.tmp, raw.slice(4));
    }
    const drive = /^\/([a-zA-Z])(\/.*)?$/.exec(raw);
    if (drive) {
      return `${drive[1].toUpperCase()}:${drive[2] ?? '/'}`;
    }
    if (/^[a-zA-Z]:[\\/]/.test(raw)) {
      return raw;
    }
  } else if (raw.startsWith('/')) {
    return raw;
  }
  if (raw === '~' || raw.startsWith('~/')) {
    return join(env.home, raw.slice(1));
  }
  return join(env.cwd, raw);
}
