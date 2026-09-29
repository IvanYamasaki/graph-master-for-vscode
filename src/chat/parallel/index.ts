/**
 * Paralelismo de experimento: Best-of-N (spawn_attempts), K seeds rodadas pelo host (run_seeds) e o verificador
 * independente (request_verification, submit_verification e o disparo automático depois de "suportada").
 * O hub registra `tools()` no servidor `agents`, repassa relatórios e mudanças de status das tentativas e
 * encaminha as aprovações de run_seeds.
 */
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { z } from 'zod';
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { AgentInfo, PermissionDecision } from '../protocol';
import { AGENT_COLOR_NAMES, EFFORT_LEVELS } from '../protocol';
import { Attempts, MAX_ATTEMPTS, RESULT_FILE } from './attempts';
import { MAX_SEEDS, runSeeds } from './seeds';
import { VERIFIER_BLOCKED_TOOLS, Verifier } from './verify';
import type { ParallelHost } from './host';

export type { ParallelHost, SpawnRequest } from './host';

type Text = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (t: string): Text => ({ content: [{ type: 'text', text: t }] });
const fail = (t: string): Text => ({ ...text(t), isError: true });
const out = (r: string | Error): Text => (r instanceof Error ? fail(r.message) : text(r));

/** Trecho do prompt do orquestrador. */
export const PARALLEL_GUIDE: readonly string[] = [
  'Best-of-N, K seeds e verificação independente (servidor "agents"):',
  `- spawn_attempts({ description, prompt, n, select_by: { metric, direction }, model, effort, budget, report_to }) cria n agentes (2 a ${MAX_ATTEMPTS}) com a MESMA tarefa, cada um no seu worktree, na mesma cor, agrupados (g1, g2...). Cada tentativa grava a métrica em ${RESULT_FILE} (ou log_run). Quando todas terminam, o hub escolhe a melhor e entrega UM relatório: ranking das n com a métrica e o relatório completo só da vencedora. No mapa as outras esmaecem. Mesclar a vencedora é do usuário.`,
  '- Use Best-of-N quando a tarefa tem variância alta entre execuções (o agente pode acertar ou errar o caminho: ajuste de hiperparâmetro à mão, engenharia de atributos, depuração de desempenho, uma solução de competição) e existe uma métrica numérica clara que um script mede. No MLE-bench, 8 tentativas por tarefa subiram as medalhas de 16,9% para 34,1%. Não use para tarefa determinística, sem métrica ou quando o custo de n agentes não compensa; comece com n de 3 a 5, model "haiku" ou "sonnet". O budget do grupo é dividido entre as tentativas (tokens e custo); max_minutes vale para cada uma.',
  '- A vencedora de um Best-of-N é um ponto, não uma conclusão. Para afirmar que uma configuração é melhor, use o laboratório com seeds.',
  `- run_seeds({ hypothesis_id, arm, command_template, seeds, metrics_file_template }) roda o MESMO comando com várias seeds, sem LLM, com paralelismo limitado (agentGraphMaster.seedParallelism), e registra cada execução como run do braço, lendo o número do arquivo. O template leva {seed} (e pode levar {arm}). Sem metrics_file_template, o host lê a última linha JSON da saída. Até ${MAX_SEEDS} seeds por chamada; o usuário aprova cada modelo de comando na primeira vez da conversa. Prefira run_seeds a um agente que roda seeds em laço: é mais barato e determinístico.`,
  '- Fluxo de um experimento comparativo: 1) register_hypothesis; 2) run_seeds para o baseline e para a variante (mesmas seeds nos dois braços, pelo menos min_seeds); 3) declare_result; 4) se der "suportada", o hub cria sozinho um verificador independente (agentGraphMaster.autoVerify), só leitura, que reexecuta cada braço com seed nova, procura vazamento e dá o parecer. O selo ("verificado", "divergente" ou "inconclusivo") sai no cartão da hipótese e o relatório do verificador chega a você. Só comunique o resultado como firme depois do selo "verificado"; "divergente" se conta ao usuário com o motivo.',
  '- request_verification({ hypothesis_id }) pede a verificação quando o usuário quiser, ou de um veredito que não foi "suportada".',
];

export class Parallel {
  private readonly attempts: Attempts;
  private readonly verifier: Verifier;
  /** Modelos de comando do run_seeds já aprovados nesta conversa (pasta + template). */
  private readonly approved = new Set<string>();
  private readonly requests = new Map<string, (ok: boolean) => void>();

  constructor(private readonly host: ParallelHost) {
    this.attempts = new Attempts(host);
    this.verifier = new Verifier(host);
    host.lab.extraInfo = (h, v) => this.verifier.infoFor(h, v);
    host.lab.onVerdict = (h, v) => {
      if (v.verdict !== 'suportada' || !vscode.workspace.getConfiguration('agentGraphMaster').get<boolean>('autoVerify', true)) {
        return undefined;
      }
      const r = this.verifier.start(h.id, 'declare_result deu suportada (verificação automática)');
      return r instanceof Error ? `Verificação automática não começou: ${r.message}` : r;
    };
  }

  /** Ferramentas por quem chama: spawn_attempts para quem cria agentes, run_seeds e request_verification só no orquestrador, submit_verification só no verificador. */
  tools(callerId: string, role: { isMain: boolean; canSpawn: boolean }): SdkMcpToolDefinition<any>[] {
    const info = this.host.info(callerId);
    const list: SdkMcpToolDefinition<any>[] = [];
    if (info?.verifier) {
      list.push(
        tool(
          'submit_verification',
          'Grava o parecer do verificador independente. O host lê do arquivo o número de cada reexecução, confere se cai no intervalo de predição do braço e decide o selo.',
          {
            hypothesis_id: z.string(),
            verdict: z.enum(['confirmado', 'divergente', 'inconclusivo']),
            notes: z.string().describe('O que você viu, curto: reexecuções, vazamento, números'),
            reruns: z
              .array(z.object({ arm: z.string(), seed: z.number().int(), command: z.string(), metrics_file: z.string().describe('JSON gravado pela reexecução, relativo ao seu diretório') }))
              .optional()
              .describe('Reexecuções com seed nova, pelo menos uma por braço'),
            leakage: z.enum(['nenhum', 'suspeito', 'encontrado']).optional().describe('Vazamento entre treino e teste'),
          },
          async (args) => out(this.verifier.submit(callerId, args)),
          { alwaysLoad: true },
        ),
      );
      return list;
    }
    if (role.canSpawn) {
      const effortValues = EFFORT_LEVELS.filter(Boolean) as [string, ...string[]];
      list.push(
        tool(
          'spawn_attempts',
          `Best-of-N: cria n agentes (2 a ${MAX_ATTEMPTS}) com a mesma tarefa, cada um no seu worktree, e entrega um relatório só quando todos terminam: ranking pela métrica e o relatório completo da vencedora. Use quando a tarefa tem variância alta e métrica clara.`,
          {
            description: z.string().describe('Nome curto da tarefa, 3 a 6 palavras; cada tentativa aparece como "<description> · i/n"'),
            prompt: z.string().describe(`Instruções completas, iguais para todas. O hub acrescenta o número da tentativa e pede o ${RESULT_FILE}`),
            n: z.number().int().min(2).max(MAX_ATTEMPTS).describe('Quantas tentativas. 3 a 5 costuma bastar'),
            select_by: z
              .object({
                metric: z.string().describe(`Nome da métrica no ${RESULT_FILE} (ou no log_run) de cada tentativa`),
                direction: z.enum(['higher', 'lower']).describe('"higher": maior é melhor; "lower": menor é melhor'),
              })
              .describe('Métrica e direção que escolhem a vencedora'),
            model: z.string().optional().describe('Modelo de cada tentativa ("haiku", "sonnet", "opus"...). Omitido: herda o do chat'),
            effort: z.enum(effortValues).optional(),
            color: z.enum([...AGENT_COLOR_NAMES] as [string, ...string[]]).optional().describe('Cor do grupo inteiro. Omita para o sistema escolher'),
            budget: z
              .object({
                max_tokens: z.number().positive().optional(),
                max_minutes: z.number().positive().optional(),
                max_usd: z.number().positive().optional(),
              })
              .optional()
              .describe('Orçamento do grupo: tokens e custo divididos entre as tentativas; max_minutes vale para cada uma'),
            report_to: z.string().optional().describe('Destino do relatório consolidado: "parent" (você, padrão), "main", "user" ou o id de um agente'),
            protected_paths: z.array(z.string()).optional().describe('Globs que as tentativas não leem nem gravam (avaliador, teste)'),
            box: z.string().optional().describe('Caixa do mapa para as tentativas: id (b1) ou nome; nome novo cria a caixa. Omitido: a caixa de quem chama'),
            account: z
              .string()
              .optional()
              .describe('Conta Claude das tentativas (nome, id ou e-mail), escolhida pelo usuário. Omitida: a conta deste chat. Só passe quando o usuário pedir essa conta'),
          },
          async (args) => out(await this.attempts.spawn(callerId, args)),
          { alwaysLoad: true },
        ),
      );
    }
    if (role.isMain) {
      list.push(
        tool(
          'run_seeds',
          'Roda o mesmo comando com K seeds pelo próprio host (sem LLM, paralelismo limitado) e registra cada execução no laboratório como run do braço, com o número lido de arquivo. O usuário aprova o modelo de comando na primeira vez da conversa.',
          {
            hypothesis_id: z.string(),
            arm: z.string().describe('Um dos dois braços da hipótese'),
            command_template: z.string().describe('Comando com {seed} (e opcionalmente {arm}), ex.: "python train.py --lr 0.01 --seed {seed} --out results/{arm}_{seed}.json"'),
            seeds: z.array(z.number().int()).min(1).max(MAX_SEEDS).describe('Seeds a rodar, ex.: [1, 2, 3, 4, 5]. Use as mesmas nos dois braços'),
            metrics_file_template: z.string().optional().describe('JSON de métricas que cada execução grava, com {seed}, relativo a workdir (ex.: "results/{arm}_{seed}.json"). Omitido: a última linha JSON da saída'),
            workdir: z.string().optional().describe('Pasta onde rodar, relativa ao projeto (um worktree, por exemplo). Omitido: o projeto'),
            parallel: z.number().int().min(1).max(8).optional().describe('Execuções ao mesmo tempo. Omitido: agentGraphMaster.seedParallelism'),
            timeout_minutes: z.number().positive().optional().describe('Tempo máximo de cada execução. Omitido: agentGraphMaster.evaluationTimeoutMinutes'),
          },
          async (args) =>
            out(
              await runSeeds(this.host, callerId, args, {
                approved: (key) => this.approved.has(key),
                remember: (key) => this.approved.add(key),
                ask: (input, reason) => this.ask(input, reason),
              }),
            ),
          { alwaysLoad: true },
        ),
        tool(
          'request_verification',
          'Cria o verificador independente do último veredito de uma hipótese: agente só leitura, num worktree próprio, que reexecuta cada braço com seed nova, procura vazamento e dá o parecer. O selo sai no cartão da hipótese.',
          {
            hypothesis_id: z.string(),
            model: z.string().optional().describe('Omitido: agentGraphMaster.verifierModel (padrão "sonnet")'),
            effort: z.enum(EFFORT_LEVELS.filter(Boolean) as [string, ...string[]]).optional().describe('Omitido: agentGraphMaster.verifierEffort (padrão "medium")'),
          },
          async (args) => out(this.verifier.start(args.hypothesis_id, 'pedido do orquestrador', { model: args.model, effort: args.effort })),
          { alwaysLoad: true },
        ),
      );
    }
    return list;
  }

  /** Ferramentas negadas no processo do agente (verificador); undefined para os demais. */
  blockedTools(info: AgentInfo): string[] | undefined {
    return info.verifier ? VERIFIER_BLOCKED_TOOLS : undefined;
  }

  /** Relatório final de uma tentativa com o grupo aberto: o hub não entrega, o grupo consolida. */
  takeReport(id: string, text: string): boolean {
    return this.attempts.takeReport(id, text);
  }

  /** Agente saiu de "rodando". */
  onSettled(info: AgentInfo): void {
    if (info.attempt) {
      this.attempts.onSettled(info.id);
    }
    if (info.verifier) {
      setTimeout(() => this.verifier.onSettled(info.id), 400);
    }
  }

  restore(): void {
    this.attempts.restore();
  }

  ownsPermission(requestId: string): boolean {
    return this.requests.has(requestId);
  }

  respondPermission(requestId: string, answer: PermissionDecision): void {
    const resolve = this.requests.get(requestId);
    this.requests.delete(requestId);
    this.host.post({ type: 'permissionClosed', requestId });
    resolve?.(answer.decision === 'allow' || answer.decision === 'always');
  }

  reset(): void {
    for (const resolve of this.requests.values()) {
      resolve(false);
    }
    this.requests.clear();
    this.approved.clear();
    this.attempts.reset();
    this.verifier.reset();
  }

  private ask(input: Record<string, unknown>, reason: string): Promise<boolean> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      this.requests.set(requestId, resolve);
      this.host.post({ type: 'permission', requestId, toolName: 'run_seeds', input, canAlways: false, reason });
    });
  }
}
