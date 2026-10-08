/**
 * Regras puras de vida das tarefas do SDK (subagentes e shells em segundo plano) que o painel lista. Sem VS Code.
 *
 * O CLI avisa começo e fim de cada tarefa por eventos de borda (task_started, task_notification). Se o processo do CLI
 * morre ou é trocado (retomada, compactação que abre sessão nova, troca de modelo), o fim nunca chega e o item ficaria
 * "trabalhando" para sempre. Aqui fica a decisão de quando parar de acreditar nele.
 */
import type { AgentStatus } from './protocol';

/** Rastreio de um item de tarefa dentro da sessão. */
export interface TaskLife {
  /** Processo do CLI (contador de start()) em que o CLI falou do item pela última vez. */
  epoch: number;
  /** Instante (ms) do último sinal de vida: task_started, task_progress, task_updated, presença no nível. */
  lastLifeAt: number;
  /** Está em segundo plano: só estes aparecem em background_tasks_changed. */
  backgrounded: boolean;
}

export interface ReconcileItem {
  id: string;
  taskId?: string;
  status: AgentStatus;
  life?: TaskLife;
}

export interface ReconcileState {
  /** Processo atual do CLI. */
  epoch: number;
  now: number;
  /** Último background_tasks_changed deste processo: ids vivos e quando chegou. Ausente: o CLI ainda não mandou. */
  level?: { ids: ReadonlySet<string>; at: number };
}

export interface ReconcileVerdict {
  id: string;
  status: 'lost' | 'completed';
  reason: string;
}

/** Quanto esperar depois de um nível sem a tarefa antes de dá-la por encerrada: o task_notification costuma vir logo atrás, com o status certo. */
export const LEVEL_GRACE_MS = 5000;

/** Com item rodando, de quanto em quanto tempo o painel reconcilia. */
export const RECONCILE_EVERY_MS = 2 * 60_000;

/**
 * Quais itens "trabalhando" deixam de estar. Regras, na ordem:
 * 1. O último sinal de vida é de um processo anterior do CLI: a tarefa morreu com ele (`lost`).
 * 2. Tarefa em segundo plano que um nível posterior ao último sinal dela não lista mais, passada a carência: terminou
 *    sem o aviso de fim (`completed`).
 */
export function reconcileTasks(items: readonly ReconcileItem[], state: ReconcileState): ReconcileVerdict[] {
  const out: ReconcileVerdict[] = [];
  for (const item of items) {
    if (item.status !== 'running' || !item.life) {
      continue;
    }
    if (item.life.epoch < state.epoch) {
      out.push({ id: item.id, status: 'lost', reason: 'encerrada com a sessão anterior do Claude Code' });
      continue;
    }
    const level = state.level;
    if (
      level &&
      item.life.backgrounded &&
      item.taskId &&
      !level.ids.has(item.taskId) &&
      level.at > item.life.lastLifeAt &&
      state.now - level.at >= LEVEL_GRACE_MS
    ) {
      out.push({ id: item.id, status: 'completed', reason: 'o Claude Code não lista mais a tarefa' });
    }
  }
  return out;
}

/** Quantos itens contam como trabalhando: só `running` confirmado (não restaurado do disco). */
export function workingCount(items: readonly { status: AgentStatus; restored?: boolean }[]): number {
  return items.filter((a) => a.status === 'running' && !a.restored).length;
}

const ORPHAN_PHRASES = [
  "didn't finish before the previous session ended",
  'Orphaned by a previous Claude Code process exit',
  'Stopped by a worker restart',
];

/** O texto é o aviso do CLI de tarefas que o processo anterior deixou sem fim ("They have been marked stopped"). */
export function isOrphanNotice(text: string | undefined): boolean {
  return !!text && ORPHAN_PHRASES.some((p) => text.includes(p));
}

/**
 * Ids de tarefa citados no aviso de órfãs: as tags <task-id> e a lista "Task ids: a, b, c." (ou "First 20 task ids:").
 * Vazio se o texto não for esse aviso. Os marcadores internos do CLI (__orphan_summary...) ficam de fora.
 */
export function orphanNoticeIds(text: string): string[] {
  if (!isOrphanNotice(text)) {
    return [];
  }
  const ids = new Set<string>();
  for (const m of text.matchAll(/<task-id>([^<]+)<\/task-id>/g)) {
    ids.add(m[1].trim());
  }
  for (const m of text.matchAll(/task ids: ([^\n<]+?)\.(?:\s|$|<)/gi)) {
    for (const id of m[1].split(',')) {
      ids.add(id.trim());
    }
  }
  return [...ids].filter((id) => id && !id.startsWith('__orphan_summary') && /^[\w-]+$/.test(id));
}

/**
 * Portas que um comando de shell cita: `--port 3002`, `--port=3002`, `-p 8080`, `PORT=3000`, `localhost:5173`.
 * Só de 1024 a 65535, sem repetir, na ordem em que aparecem.
 */
export function commandPorts(command: string | undefined): number[] {
  if (!command) {
    return [];
  }
  const found: number[] = [];
  const patterns = [/--port[= ](\d{2,5})\b/gi, /(?:^|\s)-p\s+(\d{2,5})\b/g, /\bPORT\s*=\s*(\d{2,5})\b/g, /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/gi];
  for (const re of patterns) {
    for (const m of command.matchAll(re)) {
      const port = Number(m[1]);
      if (port >= 1024 && port <= 65535 && !found.includes(port)) {
        found.push(port);
      }
    }
  }
  return found;
}

/**
 * Trecho do comando que serve para achar o processo raiz na tabela do sistema: a linha mais longa sem `cd`, redireção
 * ou `&` final, cortada em 60 caracteres. O shell do CLI embrulha o comando (bash -c "...", cmd /c), então o trecho
 * precisa ser um pedaço que sobrevive ao embrulho.
 */
/**
 * Nome de uma tarefa de shell no mapa. O CLI manda o próprio comando como descrição; o que diz o objetivo é o
 * `description` que o modelo passou ao Bash. Sem ele, o comando sem os `cd`/`export` da frente, numa linha só.
 */
export function shellTaskLabel(description: string | undefined, command: string | undefined): string {
  const given = description?.replace(/\s+/g, ' ').trim();
  if (given && given !== command?.replace(/\s+/g, ' ').trim()) {
    return given;
  }
  const text = command ?? description ?? '';
  const parts = text
    .split(/&&|;|\n/)
    .map((p) => p.trim())
    .filter((p) => p && !/^(cd|export|set|source|\.)\s/i.test(p));
  const label = (parts.join(' && ') || text).replace(/\s+/g, ' ').trim();
  return label.length > 80 ? `${label.slice(0, 79)}…` : label || 'tarefa de shell';
}

export function commandNeedle(command: string | undefined): string | undefined {
  if (!command) {
    return undefined;
  }
  const parts = command
    .split(/&&|\|\||;|\n/)
    .map((p) => p.replace(/\s+[12]?>>?\s*\S+/g, '').replace(/\s*&\s*$/, '').trim())
    .filter((p) => p && !/^cd\s/i.test(p) && !/^(export|set)\s/i.test(p));
  // Aspas e barras mudam no embrulho do shell (bash -c "...", \" no Windows): o trecho fica entre elas.
  const pieces = parts.flatMap((p) => p.split(/["'`\\]/)).map((p) => p.trim());
  const best = pieces.sort((a, b) => b.length - a.length)[0];
  if (!best || best.length < 4) {
    return undefined;
  }
  return best.slice(0, 60);
}
