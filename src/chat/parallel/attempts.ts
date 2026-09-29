/**
 * Best-of-N: N agentes independentes fazem a mesma tarefa, cada um no seu worktree, e o hub escolhe a melhor
 * tentativa por uma métrica declarada antes de começar. As tentativas não se veem; o relatório de cada uma fica
 * guardado no nó dela, e só quando todas terminam o hub entrega UM relatório consolidado (ranking + o relatório
 * completo da vencedora). Mesclar a vencedora continua sendo clique do usuário.
 *
 * O número vem de arquivo, não do texto do modelo: `result.json` na raiz do worktree (com sha256) ou, sem ele,
 * o último log_run do agente com a métrica.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createWorktree, discardWorktree } from '../worktree';
import type { AgentInfo, AttemptInfo, WorktreeInfo } from '../protocol';
import { fmtNum } from '../lab/evaluate';
import type { ParallelHost, RawBudget } from './host';

export const RESULT_FILE = 'result.json';
export const MAX_ATTEMPTS = 8;

interface Group {
  id: string;
  description: string;
  members: string[];
  metric: string;
  direction: 'higher' | 'lower';
  destination: string;
  closed: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export interface AttemptsArgs {
  description: string;
  prompt: string;
  n: number;
  select_by: { metric: string; direction: 'higher' | 'lower' };
  model?: string;
  effort?: string;
  color?: string;
  budget?: RawBudget;
  report_to?: string;
  protected_paths?: string[];
  box?: string;
  account?: string;
}

export class Attempts {
  private readonly groups = new Map<string, Group>();
  private seq = 0;

  constructor(private readonly host: ParallelHost) {}

  /** Cria o grupo. Todos os worktrees primeiro: se um falhar, os já criados saem do disco e nada roda. */
  async spawn(callerId: string, args: AttemptsArgs): Promise<string | Error> {
    const n = Math.round(args.n);
    if (n < 2 || n > MAX_ATTEMPTS) {
      return new Error(`n vai de 2 a ${MAX_ATTEMPTS}.`);
    }
    const metric = args.select_by.metric.trim();
    if (!metric) {
      return new Error('select_by.metric não pode ser vazio.');
    }
    const destination = this.host.resolveTarget(args.report_to, callerId);
    if (destination instanceof Error) {
      return destination;
    }
    const box = this.host.resolveBox(args.box, callerId);
    if (box instanceof Error) {
      return box;
    }
    // Conta antes dos worktrees: conta inválida não deixa pasta nem branch para trás.
    const accountId = await this.host.resolveAccount(args.account);
    if (accountId instanceof Error) {
      return accountId;
    }
    const free = this.host.freeSlots();
    if (free < n) {
      return new Error(`Não há vagas para ${n} tentativas: cabem ${Math.max(0, free)} agentes rodando agora (agentGraphMaster.maxRoutedAgents). Espere alguns terminarem ou peça menos tentativas.`);
    }
    const made: { id: string; worktree: WorktreeInfo }[] = [];
    for (let i = 1; i <= n; i++) {
      const id = this.host.reserveId();
      const wt = await createWorktree(this.host.cwd, id, `${args.description} ${i}`);
      if (wt instanceof Error) {
        for (const m of made) {
          await discardWorktree(m.worktree).catch(() => undefined);
        }
        return new Error(`Best-of-N precisa de um worktree por tentativa. ${wt.message}`);
      }
      made.push({ id, worktree: wt });
    }
    const group: Group = {
      id: `g${++this.seq}`,
      description: args.description.trim(),
      members: made.map((m) => m.id),
      metric,
      direction: args.select_by.direction,
      destination,
      closed: false,
    };
    this.groups.set(group.id, group);
    const budget = splitBudget(args.budget, n);
    let color = args.color;
    made.forEach((m, k) => {
      const i = k + 1;
      const attempt: AttemptInfo = { group: group.id, index: i, of: n, metric, direction: group.direction };
      const id = this.host.spawn({
        id: m.id,
        creator: callerId,
        description: `${group.description} · ${i}/${n}`,
        prompt: attemptPrompt(args.prompt, group, i, n, m.worktree),
        reportTo: destination,
        model: args.model,
        effort: args.effort,
        color,
        worktree: m.worktree,
        budget,
        protectedPaths: args.protected_paths?.map((p) => p.trim()).filter(Boolean),
        accountId,
        extra: { attempt, box },
      });
      // A primeira escolhe a cor (a pedida ou a primeira livre); as outras repetem: é a mesma frente.
      color ??= this.host.info(id)?.color;
    });
    const where = made.map((m) => `${m.id} (${m.worktree.branch})`).join(', ');
    return [
      `Grupo ${group.id} criado: ${n} tentativas de "${group.description}", cada uma no seu worktree: ${where}.`,
      `Seleção por ${metric} (${group.direction === 'higher' ? 'maior' : 'menor'} é melhor), lida do ${RESULT_FILE} de cada worktree ou do log_run de cada tentativa.`,
      `Quando todas terminarem, ${destination === callerId ? 'você recebe' : `${destination} recebe`} um relatório só, com o ranking e o relatório completo da vencedora. Não precisa esperar; siga com o seu trabalho. Mesclar a vencedora é decisão do usuário.`,
      budget ? `Orçamento por tentativa: ${budgetText(budget)}.` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** Relatório final de uma tentativa com o grupo aberto: fica no nó dela e não vai a ninguém ainda. */
  takeReport(id: string, text: string): boolean {
    const group = this.groupOf(id);
    if (!group || group.closed) {
      return false;
    }
    this.host.update(id, { report: text, reportedAt: new Date().toISOString() });
    this.schedule(group);
    return true;
  }

  /** Uma tentativa parou (terminou, falhou, foi parada ou o orçamento acabou): talvez o grupo feche. */
  onSettled(id: string): void {
    const group = this.groupOf(id);
    if (group && !group.closed) {
      this.schedule(group);
    }
  }

  /** Grupos voltam do disco pelo `attempt` salvo em cada agente. Aberto continua aberto: fecha quando as retomadas terminarem. */
  restore(): void {
    for (const a of this.host.agents()) {
      const at = a.attempt;
      if (!at) {
        continue;
      }
      this.seq = Math.max(this.seq, Number(/^g(\d+)$/.exec(at.group)?.[1] ?? 0));
      let group = this.groups.get(at.group);
      if (!group) {
        group = {
          id: at.group,
          description: a.description.replace(/\s·\s\d+\/\d+$/, ''),
          members: [],
          metric: at.metric,
          direction: at.direction,
          destination: a.reportTo ?? 'main',
          closed: !!at.closed,
        };
        this.groups.set(at.group, group);
      }
      group.members.push(a.id);
      group.closed ||= !!at.closed;
    }
  }

  reset(): void {
    for (const g of this.groups.values()) {
      clearTimeout(g.timer);
    }
    this.groups.clear();
    this.seq = 0;
  }

  private groupOf(id: string): Group | undefined {
    const g = this.host.info(id)?.attempt?.group;
    return g ? this.groups.get(g) : undefined;
  }

  /** O fim do turno grava o relatório depois de marcar o status: espera o turno acabar de fato antes de olhar. */
  private schedule(group: Group): void {
    clearTimeout(group.timer);
    group.timer = setTimeout(() => this.check(group), 400);
  }

  private check(group: Group): void {
    if (group.closed) {
      return;
    }
    const members = group.members.map((id) => this.host.info(id)).filter((a): a is AgentInfo => !!a);
    if (members.some((a) => a.status === 'running' || this.host.isBusy(a.id))) {
      return;
    }
    this.close(group, members);
  }

  private close(group: Group, members: AgentInfo[]): void {
    group.closed = true;
    const rows = members.map((a) => ({ a, ...this.measure(a, group.metric) }));
    const better = (x: number, y: number) => (group.direction === 'higher' ? y - x : x - y);
    const ranked = rows.filter((r) => r.value !== undefined).sort((x, y) => better(x.value!, y.value!) || x.a.attempt!.index - y.a.attempt!.index);
    const winner = ranked[0]?.a;
    for (const r of rows) {
      const rank = ranked.indexOf(r) + 1 || undefined;
      this.host.update(r.a.id, {
        attempt: { ...r.a.attempt!, closed: true, value: r.value, source: r.source, hash: r.hash, rank, winner: r.a.id === winner?.id },
        // O relatório de cada uma entrou no consolidado: o mapa mostra a entrega feita.
        ...(r.a.report && r.a.id !== winner?.id ? { reportedTo: group.destination } : {}),
      });
    }
    const unit = `${group.metric} (${group.direction === 'higher' ? 'maior' : 'menor'} é melhor)`;
    const line = (r: (typeof rows)[number], pos?: number) => {
      const wt = r.a.worktree;
      const state = r.a.status === 'completed' ? 'concluída' : r.a.status === 'failed' ? 'falhou' : r.a.status === 'stopped' ? 'parada' : r.a.status;
      const value = r.value !== undefined ? `${group.metric} = ${fmtNum(r.value)}` : `sem ${group.metric} (${RESULT_FILE} ausente e nenhum log_run com a métrica)`;
      const from = r.source === 'result.json' ? `, ${RESULT_FILE} sha256 ${r.hash}` : r.source === 'log_run' ? `, log_run ${r.runId}` : '';
      return `${pos ? `${pos}. ` : '- '}${r.a.id}: ${value}${from} · ${state}${wt ? ` · branch ${wt.branch}` : ''}`;
    };
    const others = rows.filter((r) => r.a.id !== winner?.id);
    const text = [
      `Best-of-N ${group.id} ("${group.description}"): ${rows.length} tentativas, ${ranked.length} com a métrica.${winner ? ` Vencedora: ${winner.id}${winner.worktree ? ` (branch ${winner.worktree.branch})` : ''} com ${group.metric} = ${fmtNum(rows.find((r) => r.a.id === winner.id)!.value)}.` : ' Nenhuma tentativa gravou a métrica: não há vencedora.'}`,
      '',
      `Ranking por ${unit}:`,
      ...ranked.map((r, i) => line(r, i + 1)),
      ...rows.filter((r) => r.value === undefined).map((r) => line(r)),
      '',
      winner
        ? `Mesclar a vencedora é decisão do usuário (botão Mesclar no popup do nó ${winner.id}). As outras continuam nos worktrees delas até o usuário descartar. Os valores vieram de arquivo lido pelo host; uma tentativa só é um ponto: para afirmar que a abordagem vencedora é melhor, registre uma hipótese e rode seeds.`
        : 'Veja os relatórios de cada tentativa no mapa. Nada foi mesclado.',
      ...(winner?.report ? ['', `Relatório completo da vencedora (${winner.id}):`, '', winner.report.trim()] : []),
      ...(others.length ? ['', 'Outras tentativas, primeira linha do relatório:', ...others.map((r) => `- ${r.a.id}: ${firstLine(r.a.report) || 'sem relatório'}`)] : []),
    ].join('\n');
    const from = winner?.id ?? members[0]?.id;
    if (from) {
      this.host.deliverReport(group.destination, text, from);
    }
    if (winner) {
      this.host.post({ type: 'notice', level: 'info', text: `Best-of-N ${group.id}: vencedora ${winner.id} por ${group.metric}. Mesclar fica com você, no popup do nó.` });
    }
  }

  /** Métrica da tentativa: result.json do worktree, senão o último log_run dela com a métrica. */
  private measure(a: AgentInfo, metric: string): { value?: number; source?: AttemptInfo['source']; hash?: string; runId?: string } {
    const dir = a.worktree?.cwd;
    if (dir) {
      const read = readResult(path.join(dir, RESULT_FILE), metric);
      if (read) {
        return { value: read.value, source: 'result.json', hash: read.hash };
      }
    }
    const run = this.host.lab.store
      .runs()
      .filter((r) => r.agent === a.id && Number.isFinite(r.metrics[metric]))
      .at(-1);
    return run ? { value: run.metrics[metric], source: 'log_run', runId: run.id } : {};
  }
}

/** `{"metric": 1}` ou `{"metrics": {"metric": 1}}`, como o metrics_file do laboratório. */
export function readResult(file: string, metric: string): { value: number; hash: string } | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const src = data && typeof data.metrics === 'object' && data.metrics ? (data.metrics as Record<string, unknown>) : data;
    const value = src?.[metric];
    return typeof value === 'number' && Number.isFinite(value) ? { value, hash: createHash('sha256').update(raw).digest('hex').slice(0, 16) } : undefined;
  } catch {
    return undefined;
  }
}

function attemptPrompt(task: string, group: Group, i: number, n: number, wt: WorktreeInfo): string {
  return [
    task.trim(),
    '',
    '---',
    `Você é a tentativa ${i} de ${n} do grupo ${group.id} (Best-of-N). Outras ${n - 1} tentativas fazem a mesma tarefa em worktrees separados; você não as vê e não fala com elas. Trabalhe de forma independente e faça a sua melhor escolha.`,
    `Métrica de seleção: ${group.metric} (${group.direction === 'higher' ? 'maior' : 'menor'} é melhor).`,
    `Ao terminar, grave ${RESULT_FILE} na raiz do seu diretório de trabalho (${wt.cwd}) com o valor medido, por exemplo {"${group.metric}": 0.123} (ou {"metrics": {"${group.metric}": 0.123}}). O valor tem de sair de uma execução real; o hub lê o número desse arquivo, não do seu texto.`,
    `Se o experimento aceitar seed e a tarefa não disser qual, use ${i}.`,
  ].join('\n');
}

/** Orçamento do grupo: tokens e custo divididos entre as tentativas; minutos valem para cada uma (rodam em paralelo). */
function splitBudget(b: RawBudget | undefined, n: number): RawBudget | undefined {
  if (!b) {
    return undefined;
  }
  return {
    max_tokens: b.max_tokens ? Math.max(1, Math.floor(b.max_tokens / n)) : undefined,
    max_usd: b.max_usd ? b.max_usd / n : undefined,
    max_minutes: b.max_minutes,
  };
}

function budgetText(b: RawBudget): string {
  return [b.max_tokens ? `${b.max_tokens} tokens` : '', b.max_usd ? `US$ ${b.max_usd.toFixed(2)}` : '', b.max_minutes ? `${b.max_minutes} min` : ''].filter(Boolean).join(', ');
}

function firstLine(text: string | undefined): string {
  const line = (text ?? '').trim().split('\n')[0]?.trim() ?? '';
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}
