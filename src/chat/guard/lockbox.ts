/**
 * Cofre (lockbox) do conjunto de teste. Protegido só por convenção, o teste acaba lido "só para conferir" ou
 * avaliado de novo depois de cada ajuste, e o número final deixa de valer. O cofre liga três coisas:
 *   - caminhos protegidos (somam-se aos de .agm/protected.json para todos os agentes, com os mesmos hooks);
 *   - as hipóteses que ele avalia;
 *   - UM comando de avaliação, fixado no registro.
 * O host conta cada tentativa barrada de agente, registra a hora de cada avaliação e recusa a segunda avaliação
 * da mesma hipótese sem um clique do usuário. Tudo fica em .agm/lockbox.json, que os agentes não leem nem gravam.
 *
 * Duas regras de segurança:
 * - a avaliação é reservada de forma síncrona (registro "rodando" gravado antes de qualquer await), então duas
 *   chamadas no mesmo turno não passam as duas como "primeira";
 * - arquivo ilegível falha fechado: vale a última lista boa (memória ou .agm/lockbox.json.bak) e, sem ela, tudo
 *   fica protegido ("**") até o usuário consertar o arquivo. Nenhuma escrita acontece nesse estado.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const LOCKBOX_FILE = '.agm/lockbox.json';
const BACKUP_SUFFIX = '.bak';
/** Padrão que protege tudo: o que vale quando o cofre está ilegível e não há cópia boa. */
export const PROTECT_ALL = '**';
/** Chave das avaliações de um cofre sem hipóteses: a contagem é do próprio cofre. */
export const NO_HYPOTHESIS = '(cofre)';
/** Tentativas barradas guardadas por cofre (as mais recentes). */
const MAX_ACCESS_LOG = 200;

export interface LockboxEvaluation {
  /** "e1", "e2"... dentro do cofre. Ausente nos registros antigos. */
  id?: string;
  /**
   * "rodando": reservada e ainda sem resultado. "interrompida": a janela que reservou fechou (ou o processo morreu)
   * antes do resultado. As duas contam como avaliação feita. Ausente: terminada.
   */
  state?: 'rodando' | 'interrompida';
  /** Processo da extensão que reservou: se ele não existe mais, a reserva virou "interrompida". */
  pid?: number;
  hypothesisId: string;
  /** ISO. */
  at: string;
  by: string;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** sha256 da saída padrão: a mesma avaliação repetida dá o mesmo hash. */
  stdoutHash: string;
  /** Avaliação repetida da mesma hipótese, liberada pelo usuário. */
  repeatApproved?: boolean;
  /** Parada no meio (agente parado ou conversa trocada). Conta como feita: o processo pode ter lido o teste. */
  aborted?: boolean;
  /** Números da saída (não o stdout): valores da última linha JSON e números soltos do texto. Só eles ficam guardados. */
  numbers?: number[];
  /** Números nomeados da última linha JSON da saída (chaves aninhadas viram "a.b"). */
  metrics?: Record<string, number>;
}

export interface LockboxAccess {
  at: string;
  agent: string;
  tool: string;
}

export interface Lockbox {
  id: string;
  name: string;
  paths: string[];
  /** Pode ser vazio: cofre sem braços, com uma contagem só (chave NO_HYPOTHESIS). */
  hypotheses: string[];
  /** Pode levar {hypothesis}, trocado pelo id da hipótese avaliada. */
  command: string;
  timeoutMinutes?: number;
  createdAt: string;
  createdBy: string;
  /** Tentativas de agente barradas pelos hooks (total desde o registro). */
  blockedCount: number;
  blocked: LockboxAccess[];
  evaluations: LockboxEvaluation[];
}

interface FileShape {
  lockboxes: Lockbox[];
}

export interface LockboxState {
  list: Lockbox[];
  /** Arquivo ilegível: o motivo. Com erro, `list` é a última cópia boa (ou vazia) e nada se grava. */
  error?: string;
  /** Com erro e sem cópia boa: tudo protegido. */
  protectAll?: boolean;
}

let cache: { root: string; at: number; value: LockboxState } | undefined;
const TTL_MS = 2000;
/** Última lista lida sem erro, por projeto. */
const lastGood = new Map<string, Lockbox[]>();

function file(root: string): string {
  return path.join(root, LOCKBOX_FILE);
}

function parse(text: string): Lockbox[] {
  const raw = JSON.parse(text) as Partial<FileShape>;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.lockboxes)) {
    throw new Error('falta a lista "lockboxes"');
  }
  return raw.lockboxes.map((l, i) => {
    if (!l || typeof l.id !== 'string' || !Array.isArray(l.paths) || !Array.isArray(l.hypotheses) || typeof l.command !== 'string') {
      throw new Error(`cofre ${i + 1} sem id, paths, hypotheses ou command`);
    }
    return { ...l, blockedCount: l.blockedCount ?? 0, blocked: Array.isArray(l.blocked) ? l.blocked : [], evaluations: Array.isArray(l.evaluations) ? l.evaluations : [] };
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: existe, mas é de outro usuário.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Reserva "rodando" de um processo que não existe mais (janela fechada no meio da avaliação) vira "interrompida" e
 * é gravada assim. Continua contando como avaliação feita: a próxima pede aprovação, e o cartão diz o que houve.
 */
function markInterrupted(root: string, list: Lockbox[]): Lockbox[] {
  let changed = false;
  const out = list.map((l) => ({
    ...l,
    evaluations: l.evaluations.map((e) => {
      if (e.state !== 'rodando' || (e.pid !== undefined && (e.pid === process.pid || alive(e.pid)))) {
        return e;
      }
      changed = true;
      return { ...e, state: 'interrompida' as const };
    }),
  }));
  if (changed) {
    try {
      const text = JSON.stringify({ lockboxes: out } satisfies FileShape, null, 2);
      fs.writeFileSync(file(root), text, 'utf8');
      fs.writeFileSync(file(root) + BACKUP_SUFFIX, text, 'utf8');
    } catch {
      // Sem gravar, a marcação vale só em memória; a reserva continua contando do mesmo jeito.
    }
  }
  return out;
}

export function lockboxState(root: string): LockboxState {
  if (cache && cache.root === root && Date.now() - cache.at < TTL_MS) {
    return cache.value;
  }
  let value: LockboxState;
  let text: string | undefined;
  try {
    text = fs.readFileSync(file(root), 'utf8');
  } catch {
    // Sem arquivo: nenhum cofre.
  }
  if (text === undefined) {
    value = { list: [] };
  } else {
    try {
      value = { list: markInterrupted(root, parse(text)) };
      lastGood.set(root, value.list);
    } catch (err) {
      let fallback = lastGood.get(root);
      if (!fallback) {
        try {
          fallback = parse(fs.readFileSync(file(root) + BACKUP_SUFFIX, 'utf8'));
        } catch {
          fallback = undefined;
        }
      }
      const why = `${LOCKBOX_FILE} ilegível (${err instanceof Error ? err.message : String(err)})`;
      value = fallback
        ? { list: fallback, error: `${why}. Valem os cofres da última cópia boa até o arquivo ser consertado; nenhum cofre novo nem avaliação até lá.` }
        : { list: [], protectAll: true, error: `${why} e sem cópia boa: TODOS os caminhos ficam protegidos para os agentes até o usuário consertar ou apagar o arquivo.` };
    }
  }
  cache = { root, at: Date.now(), value };
  return value;
}

/** Os cofres legíveis (com arquivo ilegível, os da última cópia boa). */
export function readLockboxes(root: string): Lockbox[] {
  return lockboxState(root).list;
}

/** Grava a lista e a cópia .bak. Recusa com o arquivo ilegível: consertar é do usuário. */
export function writeLockboxes(root: string, list: Lockbox[]): void {
  const st = lockboxState(root);
  if (st.error) {
    throw new Error(st.error);
  }
  const text = JSON.stringify({ lockboxes: list } satisfies FileShape, null, 2);
  fs.mkdirSync(path.dirname(file(root)), { recursive: true });
  fs.writeFileSync(file(root), text, 'utf8');
  fs.writeFileSync(file(root) + BACKUP_SUFFIX, text, 'utf8');
  lastGood.set(root, list);
  cache = { root, at: Date.now(), value: { list } };
}

/** Padrões que os cofres somam aos caminhos protegidos, incluindo o próprio arquivo do cofre. */
export function lockboxPatterns(root: string): string[] {
  const st = lockboxState(root);
  if (st.protectAll) {
    return [PROTECT_ALL];
  }
  return st.list.length || st.error ? [...new Set([...st.list.flatMap((l) => l.paths), LOCKBOX_FILE, LOCKBOX_FILE + BACKUP_SUFFIX])] : [];
}

/**
 * Reserva uma avaliação de forma síncrona: grava o registro "rodando" ANTES de qualquer espera e devolve as
 * avaliações anteriores da mesma hipótese (inclusive as que ainda rodam). A segunda chamada do mesmo turno já vê a
 * primeira e cai na aprovação do usuário.
 */
export function reserveEvaluation(root: string, lockboxId: string, hypothesisId: string, by: string, command: string): { evalId: string; previous: LockboxEvaluation[] } | Error {
  const list = readLockboxes(root).map((l) => ({ ...l, evaluations: [...l.evaluations] }));
  const lb = list.find((l) => l.id === lockboxId);
  if (!lb) {
    return new Error(`Cofre ${lockboxId} não existe.`);
  }
  const previous = lb.evaluations.filter((e) => e.hypothesisId === hypothesisId);
  const max = lb.evaluations.reduce((m, e) => Math.max(m, Number(/^e(\d+)$/.exec(e.id ?? '')?.[1] ?? 0)), 0);
  const evalId = `e${Math.max(max, lb.evaluations.length) + 1}`;
  lb.evaluations.push({ id: evalId, state: 'rodando', pid: process.pid, hypothesisId, at: new Date().toISOString(), by, command, exitCode: null, timedOut: false, durationMs: 0, stdoutHash: '' });
  try {
    writeLockboxes(root, list);
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  return { evalId, previous };
}

/** Fecha a reserva com o resultado (ou apaga, com `result` undefined: o usuário recusou a repetição). */
export function finishEvaluation(root: string, lockboxId: string, evalId: string, result: Omit<LockboxEvaluation, 'id' | 'state' | 'hypothesisId' | 'by'> | undefined): void {
  const list = readLockboxes(root).map((l) => ({ ...l, evaluations: [...l.evaluations] }));
  const lb = list.find((l) => l.id === lockboxId);
  const i = lb ? lb.evaluations.findIndex((e) => e.id === evalId) : -1;
  if (!lb || i < 0) {
    return;
  }
  if (result) {
    const { state: _running, pid: _pid, ...kept } = lb.evaluations[i];
    lb.evaluations[i] = { ...kept, ...result };
  } else {
    lb.evaluations.splice(i, 1);
  }
  writeLockboxes(root, list);
}

export function findLockbox(list: Lockbox[], raw: string): Lockbox | undefined {
  const key = raw.trim().toLowerCase();
  return list.find((l) => l.id.toLowerCase() === key) ?? list.find((l) => l.name.toLowerCase() === key);
}

export function nextLockboxId(list: Lockbox[]): string {
  const max = list.reduce((m, l) => Math.max(m, Number(/^lb(\d+)$/.exec(l.id)?.[1] ?? 0)), 0);
  return `lb${max + 1}`;
}

export function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Acrescenta uma tentativa barrada e grava. */
export function recordBlocked(root: string, lockboxId: string, access: LockboxAccess): void {
  if (lockboxState(root).error) {
    return;
  }
  const list = readLockboxes(root).map((l) => ({ ...l }));
  const lb = list.find((l) => l.id === lockboxId);
  if (!lb) {
    return;
  }
  lb.blockedCount = (lb.blockedCount ?? 0) + 1;
  lb.blocked = [...(lb.blocked ?? []), access].slice(-MAX_ACCESS_LOG);
  writeLockboxes(root, list);
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export function lockboxSummary(lb: Lockbox): string {
  const evals = lb.evaluations.length
    ? lb.evaluations.map(
        (e) =>
          `  - ${e.hypothesisId === NO_HYPOTHESIS ? 'avaliação' : e.hypothesisId} em ${fmtTime(e.at)} por ${e.by}: ${e.state === 'rodando' ? 'RODANDO (conta como feita)' : e.state === 'interrompida' ? 'INTERROMPIDA sem resultado: a janela fechou no meio (conta como feita; a próxima pede aprovação)' : e.timedOut ? 'estourou o tempo' : `código ${e.exitCode ?? '?'}`}, ${(e.durationMs / 1000).toFixed(1)}s, stdout sha256 ${e.stdoutHash.slice(0, 12)}${e.repeatApproved ? ' (repetição aprovada pelo usuário)' : ''}`,
      )
    : ['  - nenhuma avaliação ainda'];
  const lastBlocked = lb.blocked.slice(-3).map((a) => `${a.agent} (${a.tool}, ${fmtTime(a.at)})`);
  return [
    `${lb.id} "${lb.name}", criado em ${fmtTime(lb.createdAt)} por ${lb.createdBy}`,
    `  caminhos: ${lb.paths.join(', ')}`,
    `  hipóteses: ${lb.hypotheses.length ? lb.hypotheses.join(', ') : '(nenhuma: o cofre conta as avaliações dele)'}`,
    `  comando: ${lb.command}`,
    `  tentativas de agente barradas: ${lb.blockedCount}${lastBlocked.length ? ` (últimas: ${lastBlocked.join('; ')})` : ''}`,
    '  avaliações:',
    ...evals,
  ].join('\n');
}

const MAX_NUMBERS = 500;

/** Valores numéricos de um JSON, com chaves aninhadas em "a.b". */
function flattenNumbers(value: unknown, prefix: string, out: Record<string, number>): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    out[prefix || 'value'] = value;
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => flattenNumbers(v, prefix ? `${prefix}.${i}` : String(i), out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      flattenNumbers(v, prefix ? `${prefix}.${k}` : k, out);
    }
  }
}

/**
 * Números de uma saída: a última linha que é um JSON (objeto ou lista) vira `metrics`; `numbers` junta esses valores
 * com os números soltos do texto (uma tabela impressa antes do JSON também vale). Sem JSON, só os do texto.
 */
export function outputNumbers(stdout: string): { metrics: Record<string, number>; numbers: number[] } {
  const metrics: Record<string, number> = {};
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/^[{[]/.test(lines[i])) {
      continue;
    }
    try {
      flattenNumbers(JSON.parse(lines[i]), '', metrics);
      break;
    } catch {
      // Não era JSON inteiro (linha de log que começa por "["): olha a anterior.
    }
  }
  const seen = new Set<number>(Object.values(metrics));
  for (const m of stdout.matchAll(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
    const n = Number(m[0]);
    if (Number.isFinite(n)) {
      seen.add(n);
    }
  }
  return { metrics, numbers: [...seen].slice(0, MAX_NUMBERS) };
}

/**
 * Números das saídas das avaliações do cofre, para o aviso de "número sem registro" do laboratório aceitá-los.
 * `sinceIso` deixa só as avaliações a partir dessa hora (início da conversa). Interrompidas não têm saída.
 */
export function lockboxNumbers(root: string, sinceIso?: string): number[] {
  const since = sinceIso ? Date.parse(sinceIso) : undefined;
  const out = new Set<number>();
  for (const lb of readLockboxes(root)) {
    for (const e of lb.evaluations) {
      if (since !== undefined && Number.isFinite(since) && Date.parse(e.at) < since) {
        continue;
      }
      for (const n of e.numbers ?? []) {
        out.add(n);
      }
    }
  }
  return [...out];
}

/** Só para teste: esquece cache e cópia boa em memória. */
export function resetLockboxCacheForTest(): void {
  cache = undefined;
  lastGood.clear();
}
