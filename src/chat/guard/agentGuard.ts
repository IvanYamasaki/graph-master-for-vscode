import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { HookCallbackMatcher, HookEvent } from '@anthropic-ai/claude-agent-sdk';
import type { AgentBudget, AgentInfo, AgentSpent, GuardAlert, HostMessage, PermissionDecision } from '../protocol';
import { budgetFraction, budgetLines, fmtMinutes, fmtTokensShort, fmtUsd, hasBudget } from './format';
import { PathRules, protectHooks, readProjectGuard } from './protect';
import { formatEvaluation, runEvaluation } from './evaluation';

/** O que o guarda precisa do hub. Mantém a regra aqui e o ciclo de vida do agente lá. */
export interface GuardHost {
  /** Diretório do projeto (o do chat principal). */
  cwd: string;
  info(id: string): AgentInfo | undefined;
  update(id: string, patch: Partial<AgentInfo>): void;
  post(msg: HostMessage): void;
  isBusy(id: string): boolean;
  /** Interrompe o turno em andamento sem marcar como parado pelo usuário. */
  interrupt(id: string): Promise<void>;
  /** Manda uma mensagem ao agente sem nova causa: o fim do turno entrega o relatório ao destino original. */
  continueAgent(id: string, text: string): void;
  /** Para de vez e avisa quem receberia o relatório. */
  stopForGood(id: string, why: string): Promise<void>;
  sendFromUser(id: string, text: string): void;
  stop(id: string): Promise<void>;
  /** Linha no log do agente. */
  log(id: string, text: string): void;
}

/** Uso reportado pela sessão. Claude: tokens por mensagem (repetida por bloco, daí o id) e custo acumulado no fim do turno. */
export interface UsageReport {
  messageId?: string;
  tokens?: number;
  /** Total acumulado do query() do SDK até aqui, não o do turno. */
  costUsdTotal?: number;
}

/** Trecho do prompt do orquestrador sobre orçamento, avaliador congelado e agente preso. */
export const GUARD_GUIDE = [
  'Orçamento, avaliador congelado e agente preso:',
  '- Em experimento, dê orçamento a cada agente: spawn_agent com budget { max_tokens, max_minutes, max_usd }. Aos 80% o mapa avisa; em 100% o sistema interrompe o agente e o usuário decide se dá mais ou para. Sem budget vale agentGraphMaster.defaultAgentBudget.',
  '- Tokens contam entrada (com cache) e saída de cada chamada ao modelo, então crescem rápido: cada chamada já leva o contexto inteiro, e um agente com 20 ferramentas passa fácil de 500 mil. Para limitar tempo e dinheiro, prefira max_minutes e max_usd (custo estimado pelo SDK; não existe para agentes Codex).',
  '- Referência: leitura ou levantamento com haiku, max_minutes 10; código com sonnet, max_minutes 30 e max_usd 2; revisão com opus, max_usd 5. Ajuste ao que o usuário disser.',
  '- Caminhos protegidos: protected_paths no spawn_agent (globs relativos ao projeto, ex.: "eval/**", "data/test/**", "evaluate.py") somam-se aos de .agm/protected.json. Agentes Claude não leem nem gravam esses caminhos, nem por Bash. Agentes Codex não têm essa proteção: não use Codex em experimento com avaliador congelado.',
  '- A avaliação oficial roda só por você, com run_evaluation (o usuário aprova na primeira vez). Nunca peça a um agente para rodar a avaliação, ler o conjunto de teste ou mexer no avaliador, e não copie dado de teste para o prompt de ninguém.',
  '- Agente com a mesma chamada repetida ou sem progresso aparece em âmbar no mapa como possivelmente preso; o usuário decide. Se você perceber o mesmo, mande uma mensagem objetiva com send_to_agent ou pare com stop_agent.',
];

/** "Dar mais" acrescenta esta fração do limite atual. */
const EXTEND_PERCENT = 50;
/** Janela das últimas chamadas de ferramenta que o detector de agente preso guarda. */
const CALL_WINDOW = 12;
const TICK_MS = 5000;

interface Track {
  /** Tokens já contados por id de mensagem: o SDK repete a mesma mensagem, com o mesmo uso, a cada bloco. */
  seenMessages: Map<string, number>;
  /** Último custo acumulado lido. Sobrevive a reinícios do processo: o resume continua do total salvo. */
  lastCostTotal: number;
  /** Tempo de trabalho já fechado, em ms; o turno aberto soma `now - busySince`. */
  activeMs: number;
  busySince?: number;
  /** O guarda interrompeu o turno atual por orçamento; o fim desse turno não entrega relatório. */
  haltedTurn: boolean;
  /** O turno interrompido ainda precisa continuar quando o usuário der mais orçamento. */
  needsContinue: boolean;
  budgetAlert?: string;
  calls: string[];
  lastProgress: number;
  seenFiles: Set<string>;
  seenTexts: Set<string>;
  waitingPermission: number;
  stuckAlert?: string;
  /** "Ignorar" cala o detector até o agente voltar a progredir. */
  ignoreUntilProgress: boolean;
}

export class AgentGuard {
  private readonly tracks = new Map<string, Track>();
  private readonly alerts = new Map<string, GuardAlert>();
  private alertSeq = 0;
  /** Comandos de avaliação já aprovados nesta conversa. */
  private readonly approvedEvaluations = new Set<string>();
  private readonly evalRequests = new Map<string, (ok: boolean) => void>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly host: GuardHost) {}

  // ---------- Configuração ----------

  /** Orçamento do spawn_agent em snake_case; sem nada, vale agentGraphMaster.defaultAgentBudget. */
  static budgetFrom(raw: { max_tokens?: number; max_minutes?: number; max_usd?: number } | undefined): AgentBudget | undefined {
    const source = raw ?? vscode.workspace.getConfiguration('agentGraphMaster').get<{ max_tokens?: number; max_minutes?: number; max_usd?: number }>('defaultAgentBudget', {});
    const pos = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
    const budget: AgentBudget = { maxTokens: pos(source?.max_tokens), maxMinutes: pos(source?.max_minutes), maxUsd: pos(source?.max_usd) };
    return hasBudget(budget) ? budget : undefined;
  }

  /** Regras de caminho do agente: as do projeto mais as do spawn_agent. Undefined quando não há nenhuma. */
  rulesFor(id: string, sessionCwd: string): PathRules | undefined {
    const project = readProjectGuard(this.host.cwd);
    const own = this.host.info(id)?.protectedPaths ?? [];
    const patterns = [...project.patterns, ...own];
    if (!patterns.length) {
      return undefined;
    }
    return new PathRules(patterns, [...new Set([sessionCwd, this.host.cwd])]);
  }

  hooksFor(id: string, sessionCwd: string): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    return protectHooks(
      () => this.rulesFor(id, sessionCwd),
      (toolName) => this.host.log(id, `> Guarda: ${toolName} bloqueado por tocar caminho protegido.`),
    );
  }

  /** Trecho do prompt do agente: o orçamento e os caminhos que ele não pode tocar. */
  agentPromptLines(id: string): string[] {
    const info = this.host.info(id);
    if (!info) {
      return [];
    }
    const lines: string[] = [];
    if (hasBudget(info.budget)) {
      const b = info.budget!;
      const parts = [b.maxTokens ? `${fmtTokensShort(b.maxTokens)} tokens processados` : '', b.maxMinutes ? `${fmtMinutes(b.maxMinutes)} de trabalho` : '', b.maxUsd ? `${fmtUsd(b.maxUsd)} de custo estimado` : ''].filter(Boolean);
      lines.push(`Orçamento deste agente: ${parts.join(', ')}. Ao atingir o limite o sistema interrompe você e pergunta ao usuário. Trabalhe direto e pare assim que tiver o resultado pedido.`);
    }
    const patterns = [...readProjectGuard(this.host.cwd).patterns, ...(info.protectedPaths ?? [])];
    if (patterns.length && info.provider !== 'codex') {
      lines.push(
        `Caminhos protegidos (avaliador congelado): ${patterns.join(', ')}. Você não lê, não grava e não cita esses caminhos em comandos; as tentativas são bloqueadas. Não tente contornar: diga no relatório se precisava deles. A avaliação oficial é rodada pelo orquestrador.`,
      );
    }
    return lines;
  }

  // ---------- Eventos do hub ----------

  private track(id: string): Track {
    let t = this.tracks.get(id);
    if (!t) {
      const spent = this.host.info(id)?.spent;
      t = {
        seenMessages: new Map(),
        // Agente retomado: o resume do SDK costuma continuar do total salvo na sessão, que é o que já foi contado.
        lastCostTotal: spent?.usd ?? 0,
        activeMs: (spent?.minutes ?? 0) * 60_000,
        haltedTurn: false,
        needsContinue: false,
        calls: [],
        lastProgress: Date.now(),
        seenFiles: new Set(),
        seenTexts: new Set(),
        waitingPermission: 0,
        ignoreUntilProgress: false,
      };
      this.tracks.set(id, t);
    }
    this.ensureTimer();
    return t;
  }

  onUsage(id: string, u: UsageReport): void {
    const info = this.host.info(id);
    if (!info) {
      return;
    }
    const t = this.track(id);
    const spent: AgentSpent = { ...(info.spent ?? { tokens: 0, minutes: 0 }) };
    let changed = false;
    if (u.tokens !== undefined && u.tokens > 0) {
      const before = u.messageId ? (t.seenMessages.get(u.messageId) ?? 0) : 0;
      const delta = u.tokens - before;
      if (delta > 0) {
        spent.tokens += delta;
        changed = true;
        if (u.messageId) {
          t.seenMessages.set(u.messageId, u.tokens);
        }
      }
    }
    if (u.costUsdTotal !== undefined && u.costUsdTotal >= 0) {
      // Total menor que o último: o processo recomeçou sem trazer o total salvo; o valor novo é todo gasto novo.
      const delta = u.costUsdTotal >= t.lastCostTotal ? u.costUsdTotal - t.lastCostTotal : u.costUsdTotal;
      t.lastCostTotal = u.costUsdTotal;
      if (delta > 0 || spent.usd === undefined) {
        spent.usd = (spent.usd ?? 0) + delta;
        changed = true;
      }
    }
    if (changed) {
      spent.minutes = this.minutes(t);
      this.host.update(id, { spent });
      this.checkBudget(id);
    }
  }

  onBusy(id: string, busy: boolean): void {
    const t = this.track(id);
    const now = Date.now();
    if (busy && t.busySince === undefined) {
      t.busySince = now;
      t.lastProgress = now;
    } else if (!busy && t.busySince !== undefined) {
      t.activeMs += now - t.busySince;
      t.busySince = undefined;
      this.refreshMinutes(id);
    }
  }

  /** Mensagens que a sessão do agente manda ao hub: é daqui que sai o sinal de progresso. */
  onMessage(id: string, msg: HostMessage): void {
    switch (msg.type) {
      case 'toolUse':
        this.onToolUse(id, msg.name, msg.input);
        return;
      case 'assistantText': {
        const key = msg.text.trim().slice(0, 400);
        const t = this.track(id);
        if (key && !t.seenTexts.has(key)) {
          t.seenTexts.add(key);
          this.progress(id);
        }
        return;
      }
      case 'permission':
        // Esperando o usuário não é estar preso.
        this.track(id).waitingPermission++;
        return;
      case 'permissionClosed': {
        const t = this.track(id);
        t.waitingPermission = Math.max(0, t.waitingPermission - 1);
        t.lastProgress = Date.now();
        return;
      }
      default:
        return;
    }
  }

  /** Fim de turno. Devolve true quando o guarda interrompeu esse turno: o hub não entrega relatório. */
  onTurnEnd(id: string): boolean {
    const t = this.track(id);
    t.calls = [];
    t.seenMessages.clear();
    this.clearStuck(id, 'o turno terminou');
    const halted = t.haltedTurn;
    t.haltedTurn = false;
    return halted;
  }

  forget(id: string): void {
    this.tracks.delete(id);
  }

  // ---------- Orçamento ----------

  private minutes(t: Track): number {
    const ms = t.activeMs + (t.busySince !== undefined ? Date.now() - t.busySince : 0);
    return Math.round((ms / 60_000) * 100) / 100;
  }

  private refreshMinutes(id: string): void {
    const info = this.host.info(id);
    const t = this.tracks.get(id);
    if (!info || !t) {
      return;
    }
    const minutes = this.minutes(t);
    if (Math.abs((info.spent?.minutes ?? 0) - minutes) >= 0.05) {
      this.host.update(id, { spent: { ...(info.spent ?? { tokens: 0, minutes: 0 }), minutes } });
      this.checkBudget(id);
    }
  }

  private checkBudget(id: string): void {
    const info = this.host.info(id);
    const t = this.tracks.get(id);
    const frac = budgetFraction(info?.budget, info?.spent);
    if (!info || !t || frac === undefined || frac < 1) {
      return;
    }
    if (this.host.isBusy(id) && !t.haltedTurn) {
      t.haltedTurn = true;
      t.needsContinue = true;
      void this.host.interrupt(id);
    }
    const pending = t.budgetAlert && this.alerts.get(t.budgetAlert)?.status === 'pending';
    if (pending) {
      return;
    }
    this.host.update(id, { summary: 'orçamento esgotado, esperando o usuário' });
    const alert = this.newAlert(id, 'budget', `O agente ${id} ("${info.description}") atingiu o orçamento: ${budgetLines(info).join(' · ')}. Ele foi interrompido e espera a sua decisão.`);
    alert.extendPercent = EXTEND_PERCENT;
    t.budgetAlert = alert.id;
    this.host.log(id, `> Guarda: orçamento esgotado (${budgetLines(info).join(' · ')}).`);
    this.host.post({ type: 'guardAlert', alert });
  }

  /** Novo limite: o maior entre o limite e o já gasto, mais `percent` do limite. */
  private extended(b: AgentBudget, s: AgentSpent | undefined, percent: number): AgentBudget {
    const grow = (limit: number | undefined, used: number | undefined) =>
      limit ? Math.round((Math.max(limit, used ?? 0) + (limit * percent) / 100) * 100) / 100 : undefined;
    return { maxTokens: grow(b.maxTokens, s?.tokens), maxMinutes: grow(b.maxMinutes, s?.minutes), maxUsd: grow(b.maxUsd, s?.usd) };
  }

  // ---------- Agente preso ----------

  private onToolUse(id: string, name: string, input: unknown): void {
    const t = this.track(id);
    // `description` é narração do modelo ("Print ping 2"): muda a cada chamada sem mudar o que ela faz.
    const { description: _narration, ...essence } = (input && typeof input === 'object' ? input : { value: input }) as Record<string, unknown>;
    const key = `${name}:${stableStringify(essence)}`;
    const repeated = t.calls.includes(key);
    t.calls.push(key);
    if (t.calls.length > CALL_WINDOW) {
      t.calls.shift();
    }
    const file = fileOf(input);
    const newFile = !!file && !t.seenFiles.has(file);
    if (file) {
      t.seenFiles.add(file);
    }
    const limit = stuckRepeatCount();
    const tail = t.calls.slice(-limit);
    if (limit > 1 && tail.length === limit && tail.every((c) => c === key)) {
      this.markStuck(id, `repetiu a mesma chamada ${limit} vezes seguidas (${name}${describeInput(input)})`);
      return;
    }
    if (!repeated || newFile) {
      this.progress(id);
    }
  }

  private progress(id: string): void {
    const t = this.track(id);
    t.lastProgress = Date.now();
    t.ignoreUntilProgress = false;
    this.clearStuck(id, 'voltou a progredir');
  }

  private markStuck(id: string, reason: string): void {
    const t = this.track(id);
    const info = this.host.info(id);
    if (!info || t.ignoreUntilProgress || info.stuck) {
      return;
    }
    this.host.update(id, { stuck: { reason, since: new Date().toISOString() } });
    this.host.log(id, `> Guarda: possivelmente preso, ${reason}.`);
    const alert = this.newAlert(id, 'stuck', `O agente ${id} ("${info.description}") parece preso: ${reason}. Ele continua rodando; decida se quer intervir.`);
    t.stuckAlert = alert.id;
    this.host.post({ type: 'guardAlert', alert });
  }

  private clearStuck(id: string, note: string): void {
    const t = this.tracks.get(id);
    const info = this.host.info(id);
    if (info?.stuck) {
      // `update` ignora undefined; o campo sai direto do objeto antes de publicar.
      delete info.stuck;
      this.host.update(id, {});
    }
    const alert = t?.stuckAlert ? this.alerts.get(t.stuckAlert) : undefined;
    if (alert?.status === 'pending') {
      alert.status = 'resolved';
      alert.note = note;
      this.host.post({ type: 'guardAlert', alert });
    }
    if (t) {
      t.stuckAlert = undefined;
    }
  }

  private tick(): void {
    const minutes = stuckMinutes();
    const now = Date.now();
    for (const [id, t] of this.tracks) {
      if (t.busySince === undefined) {
        continue;
      }
      this.refreshMinutes(id);
      if (minutes > 0 && !t.waitingPermission && now - t.lastProgress > minutes * 60_000) {
        this.markStuck(id, `sem progresso há ${Math.round((now - t.lastProgress) / 60_000)} min (nenhuma ferramenta, arquivo ou texto novo)`);
      }
    }
  }

  private ensureTimer(): void {
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), TICK_MS);
      this.timer.unref?.();
    }
  }

  // ---------- Cartões ----------

  private newAlert(agentId: string, kind: GuardAlert['kind'], text: string): GuardAlert {
    const alert: GuardAlert = { id: `g${++this.alertSeq}`, agentId, kind, text, at: new Date().toISOString(), status: 'pending' };
    this.alerts.set(alert.id, alert);
    return alert;
  }

  /** Clique num cartão. */
  async resolve(alertId: string, action: 'extend' | 'stop' | 'ignore' | 'message', text?: string): Promise<void> {
    const alert = this.alerts.get(alertId);
    if (!alert || alert.status !== 'pending') {
      return;
    }
    const id = alert.agentId;
    const info = this.host.info(id);
    const t = this.tracks.get(id);
    if (alert.kind === 'budget') {
      if (action === 'extend' && info?.budget) {
        const budget = this.extended(info.budget, info.spent, alert.extendPercent ?? EXTEND_PERCENT);
        alert.status = 'extended';
        alert.note = `Orçamento novo: ${budgetLines({ ...info, budget }).join(' · ')}.`;
        this.host.update(id, { budget, summary: 'orçamento ampliado' });
        this.host.post({ type: 'guardAlert', alert });
        if (t?.needsContinue) {
          t.needsContinue = false;
          this.host.continueAgent(id, `O usuário aprovou mais orçamento (${alert.note}) Continue a tarefa de onde parou e entregue o relatório final como combinado.`);
        }
        return;
      }
      alert.status = 'stopped';
      alert.note = 'Parado de vez.';
      if (t) {
        t.needsContinue = false;
      }
      this.host.post({ type: 'guardAlert', alert });
      await this.host.stopForGood(id, 'orçamento esgotado');
      return;
    }
    if (action === 'message' && text?.trim()) {
      alert.status = 'messaged';
      alert.note = 'Mensagem enviada ao agente.';
      this.host.post({ type: 'guardAlert', alert });
      this.progress(id);
      this.host.sendFromUser(id, text.trim());
      return;
    }
    if (action === 'stop') {
      alert.status = 'stopped';
      alert.note = 'Agente parado.';
      this.host.post({ type: 'guardAlert', alert });
      this.clearStuck(id, 'parado');
      await this.host.stop(id);
      return;
    }
    alert.status = 'ignored';
    alert.note = 'Ignorado até o agente voltar a progredir.';
    this.host.post({ type: 'guardAlert', alert });
    this.clearStuck(id, 'ignorado');
    if (t) {
      t.ignoreUntilProgress = true;
      t.lastProgress = Date.now();
    }
  }

  // ---------- Avaliação oficial ----------

  ownsPermission(requestId: string): boolean {
    return this.evalRequests.has(requestId);
  }

  respondPermission(requestId: string, answer: PermissionDecision): void {
    const resolve = this.evalRequests.get(requestId);
    this.evalRequests.delete(requestId);
    this.host.post({ type: 'permissionClosed', requestId });
    resolve?.(answer.decision === 'allow' || answer.decision === 'always');
  }

  private askEvaluation(command: string, configured: boolean): Promise<boolean> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      this.evalRequests.set(requestId, resolve);
      this.host.post({
        type: 'permission',
        requestId,
        toolName: 'run_evaluation',
        input: { command },
        canAlways: false,
        reason: `Avaliação oficial, fora das restrições dos agentes${configured ? '' : ' (comando diferente do configurado)'}. A aprovação vale para este comando até o fim desta conversa.`,
      });
    });
  }

  /** Ferramenta MCP só do orquestrador. */
  evaluationTool() {
    return tool(
      'run_evaluation',
      'Roda a avaliação oficial do experimento (o comando configurado em .agm/protected.json ou agentGraphMaster.evaluationCommand) no diretório do projeto, fora das restrições de caminhos protegidos dos agentes, e devolve a saída. Na primeira vez de cada comando nesta conversa o usuário aprova.',
      {
        command: z.string().optional().describe('Comando a rodar. Omita para usar o configurado; um comando diferente pede aprovação própria.'),
      },
      async (args) => {
        const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
        const cfg = readProjectGuard(this.host.cwd);
        const command = args.command?.trim() || cfg.evaluationCommand;
        if (!command) {
          return {
            ...text(`Nenhum comando de avaliação configurado. Peça ao usuário para definir "evaluationCommand" em .agm/protected.json (ou o setting agentGraphMaster.evaluationCommand), ou passe command.${cfg.error ? ` ${cfg.error}` : ''}`),
            isError: true,
          };
        }
        if (!this.approvedEvaluations.has(command)) {
          const ok = await this.askEvaluation(command, command === cfg.evaluationCommand);
          if (!ok) {
            return { ...text('O usuário recusou rodar a avaliação.'), isError: true };
          }
          this.approvedEvaluations.add(command);
        }
        const minutes = cfg.evaluationTimeoutMinutes ?? vscode.workspace.getConfiguration('agentGraphMaster').get<number>('evaluationTimeoutMinutes', 30);
        const result = await runEvaluation(command, this.host.cwd, Math.max(1, minutes) * 60_000);
        return { ...text(formatEvaluation(result)), isError: result.timedOut || result.exitCode !== 0 };
      },
      { alwaysLoad: true },
    );
  }

  // ---------- Ciclo de vida ----------

  /** Conversa trocada ou fechada: estado e aprovações não passam para a próxima. */
  reset(): void {
    for (const resolve of this.evalRequests.values()) {
      resolve(false);
    }
    this.evalRequests.clear();
    this.tracks.clear();
    this.alerts.clear();
    this.approvedEvaluations.clear();
  }

  dispose(): void {
    this.reset();
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

function stuckRepeatCount(): number {
  return vscode.workspace.getConfiguration('agentGraphMaster').get<number>('stuckRepeatCount', 3);
}

function stuckMinutes(): number {
  return vscode.workspace.getConfiguration('agentGraphMaster').get<number>('stuckMinutes', 10);
}

/** JSON com as chaves em ordem: a mesma entrada com chaves em outra ordem conta como repetição. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) {
    return `[${v.map(stableStringify).join(',')}]`;
  }
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

function fileOf(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }
  const o = input as Record<string, unknown>;
  const f = o.file_path ?? o.notebook_path ?? o.path;
  return typeof f === 'string' && f ? f : undefined;
}

function describeInput(input: unknown): string {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const hint = o.command ?? o.file_path ?? o.pattern ?? o.url ?? o.query;
  return typeof hint === 'string' && hint ? ` "${hint.length > 60 ? `${hint.slice(0, 57)}...` : hint}"` : '';
}

