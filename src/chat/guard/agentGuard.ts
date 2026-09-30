import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { HookCallbackMatcher, HookEvent } from '@anthropic-ai/claude-agent-sdk';
import type { AgentBudget, AgentInfo, AgentSpent, BoxInfo, GuardAlert, HostMessage, PermissionDecision } from '../protocol';
import { BUDGET_WARN, budgetFraction, budgetLines, fmtMinutes, fmtTokensShort, fmtUsd, hasBudget } from './format';
import { PathRules, checkToolCall, patternsWithoutFiles, protectHooks, readProjectGuard } from './protect';
import { NO_HYPOTHESIS, finishEvaluation, findLockbox, hashText, lockboxPatterns, lockboxState, lockboxSummary, nextLockboxId, outputNumbers, readLockboxes, recordBlocked, reserveEvaluation, writeLockboxes, type Lockbox } from './lockbox';
import { formatEvaluation, runEvaluation } from './evaluation';
import { parallelLaunchHint } from './heavy';

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
  /** Caixas do mapa, com o budget de cada uma. Sem isto, não há orçamento por caixa. */
  boxes?(): BoxInfo[];
  /** Todos os agentes da conversa, para somar o gasto de uma caixa. */
  agents?(): AgentInfo[];
  /** Grava campos da caixa (budget ampliado), publica e persiste. */
  updateBox?(id: string, patch: Partial<BoxInfo>): void;
  /**
   * Depois de lockbox_evaluate de uma hipótese: grava o resultado como run dela no laboratório (hipótese de avaliação
   * única). `ok: false` com `note` quando a hipótese não é dessas; a nota vai para a resposta do orquestrador.
   */
  recordLockboxRun?(a: { hypothesisId: string; lockboxId: string; evalId: string; command: string; metrics: Record<string, number>; stdoutHash: string; agent: string }): { ok: boolean; note?: string };
}

/** Gasto de uma caixa contra os tetos dela (soma dos agentes da caixa e das filhas). */
export interface BoxSpendSummary {
  boxId: string;
  name: string;
  /** Agentes somados. */
  members: number;
  spent: AgentSpent;
  /** Tetos definidos; undefined se a caixa não tem nenhum. */
  budget?: AgentBudget;
  /** Medida mais apertada, 0 a 1 ou mais; undefined sem teto medível. */
  fraction?: number;
  /** 80% ou mais. */
  warn: boolean;
  /** 100% ou mais. */
  exhausted: boolean;
  /** "1,2M de 2M tokens processados · 12 de 150 min de trabalho · US$ 3,10 de US$ 35,00 estimados". Mostra todo teto definido. */
  text: string;
}

/** Caminhos protegidos de um agente: os do projeto, os dos cofres e os do spawn_agent. */
export function protectedPatternsFor(cwd: string, info: Pick<AgentInfo, 'protectedPaths'> | undefined): string[] {
  return [...new Set([...readProjectGuard(cwd).patterns, ...lockboxPatterns(cwd), ...(info?.protectedPaths ?? [])])];
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
  '- Orçamento da frente inteira: create_box com budget. O gasto de todos os agentes da caixa e das caixas-filhas soma contra ele, com ou sem budget próprio, e vale também para agente que você esqueceu de limitar. Aos 80% o usuário é avisado; em 100% o hub interrompe os agentes da caixa, recusa agente novo nela e o usuário decide se dá mais. Numa rodada com vários agentes, crie a caixa com budget antes do primeiro spawn_agent.',
  '- Tokens contam entrada (com cache) e saída de cada chamada ao modelo, então crescem rápido: cada chamada já leva o contexto inteiro, e um agente com 20 ferramentas passa fácil de 500 mil. Para limitar tempo e dinheiro, prefira max_minutes e max_usd (custo estimado pelo SDK; não existe para agentes Codex).',
  '- Referência: leitura ou levantamento com haiku, max_minutes 10; código com sonnet, max_minutes 30 e max_usd 2; revisão com opus, max_usd 5. Ajuste ao que o usuário disser.',
  '- Caminhos protegidos: protected_paths no spawn_agent (globs relativos ao projeto, ex.: "eval/**", "data/test/**", "evaluate.py") somam-se aos de .agm/protected.json. Agentes Claude não leem nem gravam esses caminhos, nem por Bash. Agentes Codex não têm essa proteção: não use Codex em experimento com avaliador congelado.',
  '- A avaliação oficial roda só por você, com run_evaluation (o usuário aprova na primeira vez). Nunca peça a um agente para rodar a avaliação, ler o conjunto de teste ou mexer no avaliador, e não copie dado de teste para o prompt de ninguém.',
  '- Conjunto de teste de verdade vai para um cofre: register_lockbox({ name, paths, hypothesis_ids?, command }) protege os caminhos para todos os agentes, fixa UM comando de avaliação (pode levar {hypothesis}) e liga as hipóteses. hypothesis_ids é opcional: para uma avaliação única, omita (o cofre conta as avaliações dele) ou use uma hipótese de avaliação única do laboratório (register_hypothesis com comparison "single"), e o resultado vira run dela. Se um glob não casa com nenhum arquivo, a resposta avisa e diz a raiz do projeto usada. lockbox_evaluate({ lockbox, hypothesis_id? }) roda o comando; a primeira avaliação de cada hipótese (ou do cofre, sem hipóteses) sai direto, a segunda pede aprovação do usuário com a hora da primeira. Os números da saída (última linha JSON) ficam guardados e o aviso de número sem registro os aceita. O host conta as tentativas de agente barradas e lockbox_status mostra tudo. Registre o cofre antes de criar os agentes do experimento; avalie no cofre só no fim, depois de declare_result com dados de validação.',
  '- Processos pesados que o hub roda (seeds, trials, avaliações) dividem as vagas de agentGraphMaster.maxHeavyProcesses (padrão: metade dos núcleos) entre todos os agentes; com mais de um rodando, saem com OMP_NUM_THREADS=1 e parentes. Não mande cada agente rodar treino pesado por Bash em paralelo: use run_seeds e start_sweep, que entram na fila.',
  '- Agente com a mesma chamada repetida ou sem progresso aparece em âmbar no mapa como possivelmente preso; o usuário decide. Se você perceber o mesmo, mande uma mensagem objetiva com send_to_agent ou pare com stop_agent.',
];

/** Estado do orçamento de uma caixa no guarda. */
interface BoxState {
  /** Aviso dos 80% já dado. */
  warned: boolean;
  /** Cartão "caixa esgotada". */
  alert?: string;
  /** O usuário parou a caixa: nenhum agente novo entra e turno novo é interrompido até ele reabrir. */
  closed?: boolean;
  /** Cartão "caixa fechada", com o botão que reabre. */
  releaseAlert?: string;
}

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
  /** run_evaluation e lockbox_evaluate em andamento, por quem chamou (hoje só "main"). */
  private readonly controllers = new Map<string, Set<AbortController>>();
  /** Aviso de cofre ilegível já mostrado (o texto do erro). */
  private lockboxWarned?: string;
  /** Orçamento por caixa: aviso dos 80% já dado e cartão aberto de caixa esgotada. */
  private readonly boxStates = new Map<string, BoxState>();

  constructor(private readonly host: GuardHost) {}

  // ---------- Configuração ----------

  /** Orçamento do spawn_agent em snake_case; sem nada, vale agentGraphMaster.defaultAgentBudget. */
  static budgetFrom(raw: { max_tokens?: number; max_minutes?: number; max_usd?: number } | undefined): AgentBudget | undefined {
    const source = raw ?? vscode.workspace.getConfiguration('agentGraphMaster').get<{ max_tokens?: number; max_minutes?: number; max_usd?: number }>('defaultAgentBudget', {});
    const pos = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
    const budget: AgentBudget = { maxTokens: pos(source?.max_tokens), maxMinutes: pos(source?.max_minutes), maxUsd: pos(source?.max_usd) };
    return hasBudget(budget) ? budget : undefined;
  }

  /** Orçamento do create_box em snake_case. Sem nada, a caixa fica sem limite (não herda defaultAgentBudget). */
  static boxBudgetFrom(raw: { max_tokens?: number; max_minutes?: number; max_usd?: number } | undefined): AgentBudget | undefined {
    return raw ? AgentGuard.budgetFrom(raw) : undefined;
  }

  /** Regras de caminho do agente: as do projeto, as dos cofres e as do spawn_agent. Undefined quando não há nenhuma. */
  rulesFor(id: string, sessionCwd: string): PathRules | undefined {
    this.warnLockbox();
    const patterns = protectedPatternsFor(this.host.cwd, this.host.info(id));
    if (!patterns.length) {
      return undefined;
    }
    return new PathRules(patterns, [...new Set([sessionCwd, this.host.cwd])]);
  }

  hooksFor(id: string, sessionCwd: string): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    const hooks = protectHooks(
      () => this.rulesFor(id, sessionCwd),
      (toolName, _reason, input) => {
        this.host.log(id, `> Guarda: ${toolName} bloqueado por tocar caminho protegido.`);
        this.countLockboxAccess(id, sessionCwd, toolName, input);
      },
    );
    hooks.PreToolUse = [...(hooks.PreToolUse ?? []), this.ownershipHook(id, sessionCwd), this.parallelHook(id)];
    return hooks;
  }

  // ---------- Reserva de arquivos (owns) ----------

  /** Agentes vivos (rodando) que reivindicaram arquivos com owns no spawn_agent, menos `except`. */
  private claims(except: string): { id: string; description: string; owns: string[] }[] {
    return (this.host.agents?.() ?? [])
      .filter((a) => a.id !== except && (a.status === 'running' || a.status === 'waiting') && ownsOf(a).length)
      .map((a) => ({ id: a.id, description: a.description, owns: ownsOf(a) }));
  }

  /** Dono vivo de `target` (caminho do agente), ou undefined. */
  ownerOf(editor: string, target: string, sessionCwd: string): { id: string; description: string; pattern: string } | undefined {
    for (const c of this.claims(editor)) {
      const hit = new PathRules(c.owns, [...new Set([sessionCwd, this.host.cwd])]).match(target);
      if (hit) {
        return { id: c.id, description: c.description, pattern: hit };
      }
    }
    return undefined;
  }

  /**
   * Edição em arquivo reivindicado por outro agente vivo: não bloqueia, mas diz a quem edita de quem é o arquivo
   * e como pedir a mudança. Um aviso por arquivo e dono em cada agente, para não repetir a cada Edit.
   */
  private ownershipHook(id: string, sessionCwd: string): HookCallbackMatcher {
    const warned = new Set<string>();
    return {
      matcher: '^(Write|Edit|MultiEdit|NotebookEdit)$',
      hooks: [
        async (input) => {
          if (input.hook_event_name !== 'PreToolUse') {
            return {};
          }
          const args = (input.tool_input ?? {}) as Record<string, unknown>;
          const target = typeof args.file_path === 'string' ? args.file_path : typeof args.notebook_path === 'string' ? args.notebook_path : '';
          const owner = target ? this.ownerOf(id, target, sessionCwd) : undefined;
          if (!owner || warned.has(`${owner.id}\n${target}`)) {
            return {};
          }
          warned.add(`${owner.id}\n${target}`);
          this.host.log(id, `> Guarda: ${target} é reservado de ${owner.id} (owns ${owner.pattern}); edição avisada, não bloqueada.`);
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              additionalContext: `Aviso: "${target}" está reservado pelo agente ${owner.id} ("${owner.description}"), que ainda está trabalhando (owns ${owner.pattern}). A edição não foi bloqueada, mas duas mãos no mesmo arquivo costumam se sobrescrever. Se a mudança não é trivial, desfaça e peça a ${owner.id} com send_to_agent({ agent_id: "${owner.id}", message }) mandando o trecho exato; se já editou, avise ${owner.id} do que mudou.`,
            },
          };
        },
      ],
    };
  }

  /**
   * Bash/PowerShell que parece abrir processos paralelos pesados fora do semáforo: não bloqueia, sugere run_seeds e
   * start_sweep. No máximo 3 avisos por agente, para não virar ruído.
   */
  private parallelHook(id: string): HookCallbackMatcher {
    let warned = 0;
    return {
      matcher: '^(Bash|PowerShell)$',
      hooks: [
        async (input) => {
          if (input.hook_event_name !== 'PreToolUse' || warned >= 3) {
            return {};
          }
          const command = (input.tool_input as { command?: unknown } | undefined)?.command;
          const hint = typeof command === 'string' ? parallelLaunchHint(command) : undefined;
          if (!hint) {
            return {};
          }
          warned++;
          this.host.log(id, '> Guarda: comando com processos em paralelo por Bash, fora da fila do hub (avisado, não bloqueado).');
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: hint } };
        },
      ],
    };
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
    const box = this.boxBudgetLine(info.box);
    if (box) {
      lines.push(box);
    }
    const mine = ownsOf(info);
    if (mine.length) {
      lines.push(`Arquivos reservados para você (owns): ${mine.join(', ')}. Outro agente que editar um deles recebe aviso e deve pedir a mudança a você; responda com o que integrou.`);
    }
    const others = this.claims(id);
    if (others.length) {
      lines.push(`Arquivos reservados por outros agentes: ${others.map((c) => `${c.id} (${c.owns.join(', ')})`).join('; ')}. Não edite esses arquivos: peça a mudança ao dono com send_to_agent, com o trecho exato.`);
    }
    const patterns = protectedPatternsFor(this.host.cwd, info);
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
      this.checkBoxes(this.host.info(id)?.box);
    }
  }

  onBusy(id: string, busy: boolean): void {
    const t = this.track(id);
    const now = Date.now();
    if (busy && t.busySince === undefined) {
      t.busySince = now;
      t.lastProgress = now;
      // Turno novo numa caixa esgotada (mensagem de outro agente, por exemplo): para já, como o do orçamento próprio.
      if (this.exhaustedBox(this.host.info(id)?.box) && !t.haltedTurn) {
        t.haltedTurn = true;
        t.needsContinue = true;
        void this.host.interrupt(id);
      }
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
      this.checkBoxes(info.box);
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

  // ---------- Orçamento da caixa ----------

  private box(id: string | undefined): BoxInfo | undefined {
    return id ? this.host.boxes?.().find((b) => b.id === id) : undefined;
  }

  /** A caixa e a mãe dela: o gasto de um agente conta contra as duas. */
  private boxChain(id: string | undefined): BoxInfo[] {
    const box = this.box(id);
    if (!box) {
      return [];
    }
    const mother = this.box(box.parent);
    return mother ? [box, mother] : [box];
  }

  /** Agentes da caixa e das caixas-filhas. */
  private boxMembers(boxId: string): AgentInfo[] {
    const boxes = this.host.boxes?.() ?? [];
    const ids = new Set([boxId, ...boxes.filter((b) => b.parent === boxId).map((b) => b.id)]);
    return (this.host.agents?.() ?? []).filter((a) => a.box && ids.has(a.box));
  }

  /** Soma do gasto dos agentes da caixa e das filhas. Custo só aparece se algum agente informou. */
  boxSpent(boxId: string): AgentSpent {
    const total: AgentSpent = { tokens: 0, minutes: 0 };
    for (const a of this.boxMembers(boxId)) {
      total.tokens += a.spent?.tokens ?? 0;
      total.minutes += a.spent?.minutes ?? 0;
      if (a.spent?.usd !== undefined) {
        total.usd = (total.usd ?? 0) + a.spent.usd;
      }
    }
    total.minutes = Math.round(total.minutes * 100) / 100;
    return total;
  }

  /**
   * Gasto da caixa contra os tetos, para o mapa e para o resumo do hub. Mostra tokens, minutos e US$ gastos, e o teto
   * de cada medida definida (inclusive max_usd antes de qualquer custo chegar). Undefined se a caixa não existe.
   */
  boxSpendSummary(boxId: string): BoxSpendSummary | undefined {
    const box = this.box(boxId);
    if (!box) {
      return undefined;
    }
    const members = this.boxMembers(box.id);
    const spent = this.boxSpent(box.id);
    const fraction = hasBudget(box.budget) ? budgetFraction(box.budget, spent) : undefined;
    // Só agentes Codex (sem custo informado): a linha de custo diz isso em vez de prometer um valor.
    const provider = members.length && members.every((a) => a.provider === 'codex') ? 'codex' : undefined;
    return {
      boxId: box.id,
      name: box.name,
      members: members.length,
      spent,
      budget: hasBudget(box.budget) ? box.budget : undefined,
      fraction,
      warn: fraction !== undefined && fraction >= BUDGET_WARN,
      exhausted: fraction !== undefined && fraction >= 1,
      text: budgetLines({ budget: box.budget, spent, provider }).join(' · '),
    };
  }

  /** 'Orçamento da caixa b1 "Onda 1" (...): 1,2M de 2M tokens processados · ...'. Vazio sem budget. */
  boxBudgetText(boxId: string): string {
    const box = this.box(boxId);
    if (!box || !hasBudget(box.budget)) {
      return '';
    }
    return `Orçamento da caixa ${box.id} "${box.name}" (soma dos agentes dela e das filhas): ${budgetLines({ budget: box.budget, spent: this.boxSpent(box.id) }).join(' · ')}.`;
  }

  private boxBudgetLine(boxId: string | undefined): string | undefined {
    const limited = this.boxChain(boxId).filter((b) => hasBudget(b.budget));
    if (!limited.length) {
      return undefined;
    }
    return `${limited.map((b) => this.boxBudgetText(b.id)).join(' ')} Quando a caixa esgota, o sistema interrompe todos os agentes dela e pergunta ao usuário. Gaste só o que a tarefa pede.`;
  }

  /** Caixa (ou mãe) fechada pelo usuário, ou com orçamento esgotado e cartão ainda aberto. */
  private exhaustedBox(boxId: string | undefined): BoxInfo | undefined {
    return this.boxChain(boxId).find((b) => {
      const st = this.boxStates.get(b.id);
      // `b.closed` vem do disco: vale depois de reabrir a conversa, quando o guarda já não tem estado.
      return !!b.closed || (!!st && (st.closed || (st.alert !== undefined && this.alerts.get(st.alert)?.status === 'pending')));
    });
  }

  /** Motivo para recusar agente novo nesta caixa, ou undefined. O hub chama antes de criar. */
  boxSpawnBlock(boxId: string): string | undefined {
    const box = this.exhaustedBox(boxId);
    if (!box) {
      return undefined;
    }
    const closed = box.closed || this.boxStates.get(box.id)?.closed;
    if (closed) {
      this.ensureReleaseCard(box);
    }
    return closed
      ? `A caixa ${box.id} "${box.name}" foi parada pelo usuário quando o orçamento esgotou. Nenhum agente novo entra nela até ele reabrir no cartão da caixa ("Dar mais").`
      : `A caixa ${box.id} "${box.name}" está com o orçamento esgotado e espera a decisão do usuário (${budgetLines({ budget: box.budget, spent: this.boxSpent(box.id) }).join(' · ')}). Nenhum agente novo entra nela até lá.`;
  }

  /** Caixa fechada gravada no disco e sem cartão nesta sessão (conversa reaberta): abre o cartão de reabrir. */
  private ensureReleaseCard(box: BoxInfo): void {
    const st = this.boxStates.get(box.id) ?? { warned: false };
    this.boxStates.set(box.id, st);
    st.closed = true;
    if (st.releaseAlert && this.alerts.get(st.releaseAlert)?.status === 'pending') {
      return;
    }
    const release = this.newAlert(box.id, 'budget', `A caixa ${box.id} "${box.name}" está fechada desde uma sessão anterior: nenhum agente novo entra nela. "Dar mais" reabre com orçamento maior; "Parar de vez" a mantém fechada.`);
    release.extendPercent = EXTEND_PERCENT;
    st.releaseAlert = release.id;
    this.host.post({ type: 'guardAlert', alert: release });
  }

  private checkBoxes(boxId: string | undefined): void {
    for (const box of this.boxChain(boxId)) {
      if (!hasBudget(box.budget)) {
        continue;
      }
      const spent = this.boxSpent(box.id);
      const frac = budgetFraction(box.budget, spent);
      if (frac === undefined) {
        continue;
      }
      const st = this.boxStates.get(box.id) ?? { warned: false };
      this.boxStates.set(box.id, st);
      if (st.closed || box.closed) {
        // Fechada pelo usuário: o cartão de reabrir já está aberto; não abre outro.
        continue;
      }
      if (frac >= 1) {
        this.haltBox(box, spent);
      } else if (frac >= BUDGET_WARN && !st.warned) {
        st.warned = true;
        const line = `Caixa ${box.id} "${box.name}" em ${Math.round(frac * 100)}% do orçamento: ${budgetLines({ budget: box.budget, spent }).join(' · ')}.`;
        this.host.post({ type: 'notice', level: 'info', text: `${line} Em 100% o hub interrompe os agentes dela.` });
        for (const a of this.boxMembers(box.id).filter((m) => m.status === 'running')) {
          this.host.log(a.id, `> Guarda: ${line}`);
        }
      }
    }
  }

  /** Esgotou: interrompe os turnos em andamento da caixa e abre UM cartão para ela. */
  private haltBox(box: BoxInfo, spent: AgentSpent): void {
    const members = this.boxMembers(box.id);
    for (const a of members) {
      if (!this.host.isBusy(a.id)) {
        continue;
      }
      const t = this.track(a.id);
      if (!t.haltedTurn) {
        t.haltedTurn = true;
        t.needsContinue = true;
        void this.host.interrupt(a.id);
        this.host.update(a.id, { summary: `caixa ${box.id} sem orçamento, esperando o usuário` });
      }
    }
    const st = this.boxStates.get(box.id)!;
    if (st.alert && this.alerts.get(st.alert)?.status === 'pending') {
      return;
    }
    const lines = budgetLines({ budget: box.budget, spent });
    const alert = this.newAlert(
      box.id,
      'budget',
      `A caixa ${box.id} "${box.name}" atingiu o orçamento: ${lines.join(' · ')} (soma de ${members.length} agente(s)). Os agentes dela que estavam trabalhando foram interrompidos e nenhum agente novo entra nela até a sua decisão.`,
    );
    alert.extendPercent = EXTEND_PERCENT;
    st.alert = alert.id;
    for (const a of members.filter((m) => m.status === 'running')) {
      this.host.log(a.id, `> Guarda: caixa ${box.id} sem orçamento (${lines.join(' · ')}).`);
    }
    this.host.post({ type: 'guardAlert', alert });
  }

  private async resolveBox(alert: GuardAlert, action: 'extend' | 'stop' | 'ignore' | 'message'): Promise<void> {
    const box = this.box(alert.agentId);
    const st = this.boxStates.get(alert.agentId) ?? { warned: false };
    this.boxStates.set(alert.agentId, st);
    const members = box ? this.boxMembers(box.id) : [];
    const halted = members.filter((a) => this.tracks.get(a.id)?.needsContinue);
    // Cartão "caixa fechada": só o usuário reabre; qualquer outro clique a mantém fechada.
    if (alert.id === st.releaseAlert) {
      if (action === 'extend' && box?.budget) {
        const budget = this.extended(box.budget, this.boxSpent(box.id), alert.extendPercent ?? EXTEND_PERCENT);
        st.closed = false;
        this.host.updateBox?.(box.id, { closed: false });
        st.warned = false;
        st.alert = undefined;
        st.releaseAlert = undefined;
        this.host.updateBox?.(box.id, { budget });
        alert.status = 'extended';
        alert.note = `Caixa reaberta com orçamento novo: ${budgetLines({ budget, spent: this.boxSpent(box.id) }).join(' · ')}.`;
      } else {
        alert.status = 'stopped';
        alert.note = 'A caixa continua fechada.';
      }
      this.host.post({ type: 'guardAlert', alert });
      return;
    }
    if (action === 'extend' && box?.budget) {
      const budget = this.extended(box.budget, this.boxSpent(box.id), alert.extendPercent ?? EXTEND_PERCENT);
      alert.status = 'extended';
      alert.note = `Orçamento novo da caixa: ${budgetLines({ budget, spent: this.boxSpent(box.id) }).join(' · ')}.`;
      this.host.updateBox?.(box.id, { budget });
      const st = this.boxStates.get(box.id);
      if (st) {
        st.warned = false;
      }
      this.host.post({ type: 'guardAlert', alert });
      for (const a of halted) {
        // Agente com o orçamento próprio também esgotado continua esperando o cartão dele.
        if ((budgetFraction(a.budget, a.spent) ?? 0) >= 1) {
          continue;
        }
        this.tracks.get(a.id)!.needsContinue = false;
        this.host.continueAgent(a.id, `O usuário aprovou mais orçamento para a caixa ${box.id} (${alert.note}) Continue a tarefa de onde parou e entregue o relatório final como combinado.`);
      }
      return;
    }
    // Parar de vez: a caixa fecha e continua fechada até o usuário reabrir (não basta o cartão sair da tela).
    st.closed = true;
    if (box) {
      this.host.updateBox?.(box.id, { closed: true });
    }
    const live = members.filter((a) => a.status === 'running' || a.status === 'waiting' || this.tracks.get(a.id)?.needsContinue);
    alert.status = 'stopped';
    alert.note = `Caixa parada: ${live.length} agente(s) encerrado(s); nenhum agente novo entra nela.`;
    this.host.post({ type: 'guardAlert', alert });
    for (const a of live) {
      const t = this.tracks.get(a.id);
      if (t) {
        t.needsContinue = false;
      }
      await this.host.stopForGood(a.id, `orçamento da caixa ${alert.agentId} esgotado`);
    }
    const release = this.newAlert(
      alert.agentId,
      'budget',
      `A caixa ${alert.agentId}${box ? ` "${box.name}"` : ''} está fechada: nenhum agente novo entra nela. "Dar mais" reabre com orçamento maior; "Parar de vez" a mantém fechada.`,
    );
    release.extendPercent = alert.extendPercent ?? EXTEND_PERCENT;
    st.releaseAlert = release.id;
    this.host.post({ type: 'guardAlert', alert: release });
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
    const boxState = this.boxStates.get(id);
    if (alert.kind === 'budget' && (boxState?.alert === alertId || boxState?.releaseAlert === alertId)) {
      await this.resolveBox(alert, action);
      return;
    }
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

  // ---------- Cofre (lockbox) ----------

  /** Cofre ilegível: avisa o usuário uma vez por erro (a proteção já falhou fechada em lockboxPatterns). */
  private warnLockbox(): void {
    const err = lockboxState(this.host.cwd).error;
    if (err && err !== this.lockboxWarned) {
      this.lockboxWarned = err;
      this.host.post({ type: 'notice', level: 'error', text: `Cofre: ${err}` });
    }
  }

  /** Tentativa barrada que caiu num cofre: conta no cofre, com agente, ferramenta e hora. */
  private countLockboxAccess(id: string, sessionCwd: string, toolName: string, input: Record<string, unknown>): void {
    const list = readLockboxes(this.host.cwd);
    for (const lb of list) {
      const rules = new PathRules(lb.paths, [...new Set([sessionCwd, this.host.cwd])]);
      const command = typeof input.command === 'string' ? input.command : undefined;
      const hit = command !== undefined ? rules.scanCommand(command) : checkToolCall(rules, toolName, input);
      if (hit) {
        recordBlocked(this.host.cwd, lb.id, { at: new Date().toISOString(), agent: id, tool: toolName });
        this.host.log(id, `> Guarda: tentativa no cofre ${lb.id} "${lb.name}" registrada.`);
      }
    }
  }

  private askUser(toolName: string, input: Record<string, unknown>, reason: string): Promise<boolean> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      this.evalRequests.set(requestId, resolve);
      this.host.post({ type: 'permission', requestId, toolName, input, canAlways: false, reason });
    });
  }

  /** Ferramentas só do orquestrador: avaliação oficial e cofre. */
  mainTools() {
    return [this.evaluationTool(), ...this.lockboxTools()];
  }

  private lockboxTools() {
    const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
    const fail = (t: string) => ({ ...text(t), isError: true });
    return [
      tool(
        'register_lockbox',
        'Cofre do conjunto de teste: protege os caminhos para todos os agentes (como protected_paths, mas para todos e para sempre neste projeto), fixa UM comando de avaliação e liga as hipóteses que ele avalia. Depois, só lockbox_evaluate roda esse comando; a segunda avaliação da mesma hipótese pede aprovação do usuário. O usuário aprova o registro.',
        {
          name: z.string().describe('Nome curto, ex.: "teste final CIFAR"'),
          paths: z.array(z.string()).min(1).describe('Globs relativos ao projeto, ex.: ["data/test/**", "eval/labels.csv"]'),
          hypothesis_ids: z
            .array(z.string())
            .optional()
            .describe('Hipóteses que este cofre avalia, ex.: ["h3", "h4"]. Omitido: cofre sem braços, uma contagem só para o cofre (a segunda avaliação pede aprovação). Com hipótese de avaliação única do laboratório, o resultado vira run dela.'),
          command: z.string().describe('O comando de avaliação, único. Pode levar {hypothesis}, trocado pelo id avaliado. Ex.: "python eval.py --final --tag {hypothesis}"'),
          timeout_minutes: z.number().positive().optional().describe('Tempo máximo de cada avaliação. Omitido: agentGraphMaster.evaluationTimeoutMinutes'),
        },
        async (args) => {
          const list = readLockboxes(this.host.cwd);
          const name = args.name.trim();
          if (!name || findLockbox(list, name)) {
            return fail(name ? `Já existe um cofre chamado "${name}". Cofres não mudam: registre outro com nome novo.` : 'Dê um nome ao cofre.');
          }
          const paths = [...new Set(args.paths.map((p) => p.trim()).filter(Boolean))];
          const hypotheses = [...new Set((args.hypothesis_ids ?? []).map((h) => h.trim()).filter(Boolean))];
          const command = args.command.trim();
          if (!paths.length || !command) {
            return fail('Passe caminhos e o comando.');
          }
          const root = this.host.cwd;
          const found = patternsWithoutFiles(root, paths);
          const warning = [
            found.missing.length ? `Nenhum arquivo ou pasta de ${root} casa com: ${found.missing.join(', ')}. O cofre protegeria o nada.` : '',
            found.outside.length ? `Fora do projeto (não protegem nada): ${found.outside.join(', ')}.` : '',
          ]
            .filter(Boolean)
            .join(' ');
          const ok = await this.askUser(
            'register_lockbox',
            { name, raiz: root, paths: paths.join(', '), hypotheses: hypotheses.join(', ') || '(nenhuma: o cofre conta as avaliações dele)', command, ...(warning ? { aviso: warning } : {}) },
            `Cofre: estes caminhos ficam fora do alcance de todos os agentes deste projeto, e este é o único comando de avaliação${hypotheses.length ? ' das hipóteses listadas' : ''}. A primeira avaliação${hypotheses.length ? ' de cada hipótese' : ''} roda sem perguntar; a segunda pede a sua aprovação. Para desfazer, apague o cofre em .agm/lockbox.json.${warning ? ` ATENÇÃO: ${warning} Confira se esta é a pasta certa do projeto.` : ''}`,
          );
          if (!ok) {
            return fail('O usuário recusou o cofre.');
          }
          const lb: Lockbox = {
            id: nextLockboxId(list),
            name,
            paths,
            hypotheses,
            command,
            timeoutMinutes: args.timeout_minutes,
            createdAt: new Date().toISOString(),
            createdBy: 'main',
            blockedCount: 0,
            blocked: [],
            evaluations: [],
          };
          try {
            writeLockboxes(this.host.cwd, [...list, lb]);
          } catch (err) {
            return fail(`Não gravei o cofre: ${err instanceof Error ? err.message : String(err)}`);
          }
          return text(
            [
              `Cofre ${lb.id} "${name}" registrado. Raiz do projeto usada: ${root}. Caminhos protegidos para todos os agentes a partir do próximo uso de ferramenta: ${paths.join(', ')}.`,
              warning ? `AVISO: ${warning} Se a raiz não é a do projeto, o cofre está no lugar errado (abra a pasta certa no VS Code e registre de novo; apagar o cofre errado é com o usuário, em .agm/lockbox.json).` : '',
              `Avalie com lockbox_evaluate({ lockbox: "${lb.id}"${hypotheses.length ? ', hypothesis_id' : ''} }) só depois do veredito com dados de validação.${hypotheses.length ? '' : ' Sem hipótese ligada, o cofre conta as avaliações dele: a segunda pede aprovação do usuário.'}`,
            ]
              .filter(Boolean)
              .join(' '),
          );
        },
        { alwaysLoad: true },
      ),
      tool(
        'lockbox_evaluate',
        'Roda o comando do cofre para uma hipótese dele e registra hora, código de saída e hash da saída. A primeira avaliação de cada hipótese sai direto; a segunda pede aprovação do usuário, com a hora e o resultado da primeira.',
        {
          lockbox: z.string().describe('Id (lb1) ou nome do cofre'),
          hypothesis_id: z.string().optional().describe('Obrigatório se o cofre tem hipóteses; um cofre sem hipóteses não usa.'),
        },
        async (args) => {
          const list = readLockboxes(this.host.cwd);
          const lb = findLockbox(list, args.lockbox);
          if (!lb) {
            return fail(`Cofre "${args.lockbox}" não existe.${list.length ? ` Cofres: ${list.map((l) => `${l.id} "${l.name}"`).join(', ')}.` : ' Registre com register_lockbox.'}`);
          }
          const hid = args.hypothesis_id?.trim() || (lb.hypotheses.length ? '' : NO_HYPOTHESIS);
          if (!hid) {
            return fail(`Passe hypothesis_id: o cofre ${lb.id} avalia ${lb.hypotheses.join(', ')}.`);
          }
          if (lb.hypotheses.length ? !lb.hypotheses.includes(hid) : args.hypothesis_id?.trim()) {
            return fail(
              lb.hypotheses.length
                ? `A hipótese ${hid} não está no cofre ${lb.id} (hipóteses: ${lb.hypotheses.join(', ')}). Cofres não mudam: registre outro se precisar.`
                : `O cofre ${lb.id} não tem hipóteses: chame lockbox_evaluate({ lockbox: "${lb.id}" }) sem hypothesis_id. Cofres não mudam: registre outro se precisar.`,
            );
          }
          return this.evaluateInLockbox(lb, hid, lb.command.replace(/\{hypothesis\}/g, hid === NO_HYPOTHESIS ? '' : hid), 'lockbox_evaluate');
        },
        { alwaysLoad: true },
      ),
      tool(
        'lockbox_status',
        'Cofres do projeto: caminhos, hipóteses, comando, cada avaliação com hora e as tentativas de agente barradas.',
        { lockbox: z.string().optional().describe('Id ou nome; omitido, todos') },
        async (args) => {
          const list = readLockboxes(this.host.cwd);
          const pick = args.lockbox ? findLockbox(list, args.lockbox) : undefined;
          if (args.lockbox && !pick) {
            return fail(`Cofre "${args.lockbox}" não existe.`);
          }
          const show = pick ? [pick] : list;
          const err = lockboxState(this.host.cwd).error;
          const body = show.length ? show.map(lockboxSummary).join('\n\n') : 'Nenhum cofre neste projeto. register_lockbox cria um.';
          return err ? fail(`ATENÇÃO: ${err}\n\n${body}`) : text(body);
        },
        { alwaysLoad: true },
      ),
    ];
  }


  /** Hipótese fictícia das avaliações do cofre feitas por run_evaluation sem hipótese reconhecível. */
  private static readonly VIA_RUN_EVALUATION = '(run_evaluation)';

  /**
   * run_evaluation que é, na prática, uma avaliação de cofre: o comando é o do cofre (com {hypothesis} trocado por
   * uma hipótese dele, ou literal) ou cita os caminhos do cofre. Nesse caso passa pela mesma reserva e contagem.
   */
  private lockboxFor(command: string): { lb: Lockbox; hid: string } | undefined {
    const norm = (c: string) => c.replace(/\s+/g, ' ').trim();
    const cmd = norm(command);
    for (const lb of readLockboxes(this.host.cwd)) {
      const hit = lb.hypotheses.find((h) => norm(lb.command.replace(/\{hypothesis\}/g, h)) === cmd);
      if (hit) {
        return { lb, hid: hit };
      }
      if (norm(lb.command) === cmd || new PathRules(lb.paths, [this.host.cwd]).scanCommand(command)) {
        // Cofre sem hipóteses: a contagem é uma só, a mesma do lockbox_evaluate.
        return { lb, hid: lb.hypotheses.length ? AgentGuard.VIA_RUN_EVALUATION : NO_HYPOTHESIS };
      }
    }
    return undefined;
  }

  /**
   * Avaliação no cofre. A reserva é a primeira coisa, síncrona (antes de qualquer await): duas chamadas no mesmo
   * turno não passam as duas como primeira. Da segunda avaliação da mesma hipótese em diante, o usuário aprova.
   */
  private async evaluateInLockbox(lb: Lockbox, hid: string, command: string, via: 'lockbox_evaluate' | 'run_evaluation') {
    const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
    const fail = (t: string) => ({ ...text(t), isError: true });
    const reserved = reserveEvaluation(this.host.cwd, lb.id, hid, 'main', command);
    if (reserved instanceof Error) {
      return fail(reserved.message);
    }
    const { evalId, previous } = reserved;
    const what = hid === AgentGuard.VIA_RUN_EVALUATION ? 'pedida por run_evaluation, sem hipótese' : hid === NO_HYPOTHESIS ? 'do cofre' : `hipótese ${hid}`;
    if (previous.length) {
      const last = previous[previous.length - 1];
      const fmt = (iso: string) => new Date(iso).toLocaleString('pt-BR');
      const interrupted = previous.filter((e) => e.state === 'interrompida');
      const ok = await this.askUser(
        via,
        { cofre: `${lb.id} "${lb.name}"`, hipótese: hid, comando: command, avaliações_anteriores: previous.length, última: fmt(last.at), interrompidas: interrupted.length },
        [
          `Nova avaliação no cofre ${lb.id} "${lb.name}" (${what}): já houve ${previous.length}, a primeira em ${fmt(previous[0].at)}.`,
          interrupted.length ? `${interrupted.length} delas ficou sem resultado porque a janela fechou no meio (${interrupted.map((e) => fmt(e.at)).join(', ')}); o processo pode ter lido o teste, por isso conta.` : '',
          'Avaliar de novo no teste e escolher pelo resultado contamina o número final. Aprove só se a anterior falhou por motivo técnico.',
        ]
          .filter(Boolean)
          .join(' '),
      );
      if (!ok) {
        safely(() => finishEvaluation(this.host.cwd, lb.id, evalId, undefined));
        return fail(`O usuário recusou a nova avaliação (${what}). A avaliação que vale é a de ${fmt(previous[0].at)}.`);
      }
    }
    const minutes = lb.timeoutMinutes ?? vscode.workspace.getConfiguration('agentGraphMaster').get<number>('evaluationTimeoutMinutes', 30);
    const result = await this.withAbort('main', (signal) => runEvaluation(command, this.host.cwd, Math.max(1, minutes) * 60_000, { label: `cofre ${lb.id} ${hid}`, priority: true, signal }));
    // Guardam-se os números da saída, não o stdout inteiro (o hash já identifica a saída).
    const out = outputNumbers(result.stdout);
    const stdoutHash = hashText(result.stdout);
    // Parada no meio também conta: o processo pode ter lido o teste.
    safely(() =>
      finishEvaluation(this.host.cwd, lb.id, evalId, {
        at: new Date(Date.now() - result.durationMs).toISOString(),
        command,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        aborted: result.aborted,
        durationMs: result.durationMs,
        stdoutHash,
        repeatApproved: previous.length ? true : undefined,
        numbers: out.numbers.length ? out.numbers : undefined,
        metrics: Object.keys(out.metrics).length ? out.metrics : undefined,
      }),
    );
    const label = hid === NO_HYPOTHESIS ? '' : `, hipótese ${hid}`;
    const head = via === 'run_evaluation' ? `Este comando avalia o cofre ${lb.id} "${lb.name}": entrou na contagem dele${label}.` : `Cofre ${lb.id}${label}.`;
    const note = this.recordLockboxRun(lb, hid, evalId, command, out.metrics, stdoutHash, result);
    return { ...text(`${head} Avaliação ${previous.length + 1}.${note ? ` ${note}` : ''}\n${formatEvaluation(result)}`), isError: result.timedOut || result.exitCode !== 0 };
  }

  /** Grava o resultado como run da hipótese de avaliação única (laboratório). Devolve a nota para a resposta, ou vazio. */
  private recordLockboxRun(lb: Lockbox, hid: string, evalId: string, command: string, metrics: Record<string, number>, stdoutHash: string, result: { exitCode: number | null; timedOut: boolean; aborted?: boolean }): string {
    if (hid === NO_HYPOTHESIS || hid === AgentGuard.VIA_RUN_EVALUATION || !this.host.recordLockboxRun) {
      return '';
    }
    if (result.timedOut || result.aborted || result.exitCode !== 0) {
      return 'Sem run no laboratório: a avaliação não terminou bem (a tentativa conta no cofre).';
    }
    if (!Object.keys(metrics).length) {
      return `Sem run no laboratório: a saída não termina com uma linha JSON de métricas. Se a hipótese ${hid} é de avaliação única, declare o número citando esta saída.`;
    }
    try {
      const r = this.host.recordLockboxRun({ hypothesisId: hid, lockboxId: lb.id, evalId, command, metrics, stdoutHash, agent: 'main' });
      return r.note ?? (r.ok ? `Resultado gravado como run da ${hid}.` : '');
    } catch (err) {
      return `Não gravei o run da ${hid} no laboratório: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // ---------- Avaliação oficial ----------

  private async withAbort<T>(callerId: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const c = new AbortController();
    const mine = this.controllers.get(callerId) ?? new Set<AbortController>();
    mine.add(c);
    this.controllers.set(callerId, mine);
    try {
      return await run(c.signal);
    } finally {
      mine.delete(c);
    }
  }

  /** Quem chamou foi parado: as avaliações dele saem da fila e os processos morrem. */
  stopWorkOf(agentId: string): void {
    for (const c of this.controllers.get(agentId) ?? []) {
      c.abort();
    }
    this.controllers.delete(agentId);
  }

  /** Conversa trocada ou fechada: para todas as avaliações. */
  stopAllWork(): void {
    for (const id of [...this.controllers.keys()]) {
      this.stopWorkOf(id);
    }
  }

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
        // Comando do cofre (ou que cita os caminhos dele): mesma reserva e contagem do lockbox_evaluate.
        const box = this.lockboxFor(command);
        if (box) {
          return this.evaluateInLockbox(box.lb, box.hid, command, 'run_evaluation');
        }
        if (!this.approvedEvaluations.has(command)) {
          const ok = await this.askEvaluation(command, command === cfg.evaluationCommand);
          if (!ok) {
            return { ...text('O usuário recusou rodar a avaliação.'), isError: true };
          }
          this.approvedEvaluations.add(command);
        }
        const minutes = cfg.evaluationTimeoutMinutes ?? vscode.workspace.getConfiguration('agentGraphMaster').get<number>('evaluationTimeoutMinutes', 30);
        // Prioridade: a avaliação do orquestrador não espera atrás de seeds e trials dos agentes.
        const result = await this.withAbort('main', (signal) => runEvaluation(command, this.host.cwd, Math.max(1, minutes) * 60_000, { label: 'run_evaluation', priority: true, signal }));
        return { ...text(formatEvaluation(result)), isError: result.timedOut || result.exitCode !== 0 };
      },
      { alwaysLoad: true },
    );
  }

  // ---------- Ciclo de vida ----------

  /** Conversa trocada ou fechada: estado e aprovações não passam para a próxima. */
  reset(): void {
    this.stopAllWork();
    for (const resolve of this.evalRequests.values()) {
      resolve(false);
    }
    this.evalRequests.clear();
    this.tracks.clear();
    this.alerts.clear();
    this.boxStates.clear();
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

/** Globs reivindicados pelo agente no spawn_agent (AgentInfo.owns). */
function ownsOf(info: AgentInfo): string[] {
  const owns = (info as AgentInfo & { owns?: unknown }).owns;
  return Array.isArray(owns) ? owns.filter((g): g is string => typeof g === 'string' && !!g.trim()) : [];
}

/** Gravação do cofre depois de rodar: se o arquivo ficou ilegível no meio, o registro "rodando" continua valendo. */
function safely(write: () => void): void {
  try {
    write();
  } catch {
    // lockboxState já avisa e falha fechado; a reserva gravada antes conta como avaliação feita.
  }
}
