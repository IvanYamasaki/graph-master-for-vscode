/**
 * Ferramentas de busca do orquestrador: torneio de hipóteses e varredura de hiperparâmetros. Cada busca vira um
 * nó no mapa (um AgentInfo com `search`, sem sessão de modelo por trás), com progresso ao vivo no popup, e o
 * relatório final vai ao destino como o de um agente. O estado inteiro fica em .agm/search/<id>.json.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { Profile } from '../../profiles';
import type { AgentInfo, HistoryItem, HostMessage, PermissionDecision } from '../protocol';
import { gitBranch, gitInfo, readMetricsFile, type Lab } from '../lab/tools';
import { Tournament, ranking, tournamentMarkdown, tournamentProgress, tournamentReport, type TournamentState } from './tournament';
import { Sweep, sweepMarkdown, sweepProgress, sweepReport, type SweepState } from './sweep';
import { detectPython, installOptuna, missingOptunaText, type Detection } from './optuna';
import type { ParamSpec } from './sampler';

export interface SearchHost {
  cwd: string;
  profile(): Profile;
  /** Conversa principal (sessionId): vai no arquivo da busca para ela voltar ao mapa quando a conversa reabrir. */
  conversation?(): string;
  lab: Lab;
  /** O quadro mudou: o hub manda o estado novo ao webview. */
  labChanged(): void;
  post(msg: HostMessage): void;
  resolveTarget(raw: string | undefined, callerId: string): string | Error;
  /** Entrega o relatório final a "main" ou a um agente. `user` não chega aqui. */
  deliver(target: string, text: string, fromId: string): void;
}

type Text = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (t: string): Text => ({ content: [{ type: 'text', text: t }] });
const fail = (t: string): Text => ({ ...text(t), isError: true });

interface Entry {
  info: AgentInfo;
  runner: Tournament | Sweep;
  started: number;
  conversation?: string;
}

/** Nome de parâmetro que vira placeholder e categórico que entra no comando sem aspas. */
const SAFE_NAME = /^[A-Za-z_]\w*$/;
const SAFE_CHOICE = /^[\w.+\-/:=@,]+$/;
const RESERVED = new Set(['trial', 'out', 'progress']);

export const SEARCH_GUIDE = [
  'Busca (servidor "agents"): torneio de hipóteses e varredura de hiperparâmetros. As duas rodam no hub, aparecem como nó no mapa com progresso ao vivo e mandam o relatório final para report_to.',
  '- Torneio (start_tournament): quando há muitas ideias e verba para testar poucas. Juízes-modelo comparam as ideias em pares pelos critérios, com Elo; geradores baratos podem propor candidatos a partir da pergunta; evolve cria variantes das duas melhores. O torneio PRIORIZA o que testar; não conclui nada empírico. A ideia escolhida vira hipótese com promote_to_hypothesis e só se prova com runs e declare_result.',
  '- Juiz: "haiku" é barato e serve para triagem; "sonnet" julga melhor quando a decisão pesa. both_orders julga cada par nas duas ordens (o dobro de partidas) e marca empate quando a ordem muda o veredito.',
  '- Varredura (start_sweep): quando o espaço de parâmetros é contínuo ou grande e há uma métrica clara que o script grava num JSON. O hub roda o comando por trial, sem modelo no laço, com Optuna (se houver Python com optuna) ou com o amostrador embutido. Cada trial vira run no laboratório. Na primeira vez de cada comando o usuário aprova.',
  '- Sem Optuna, diga ao usuário o que start_sweep informou. setup_optuna instala o optuna num venv do projeto (.agm/venv), com aprovação; nunca instale pacote no Python global.',
  '- O melhor trial de uma varredura é otimista. Para afirmar melhora, registre hipótese confirmatória (melhores parâmetros contra o baseline, várias seeds) e use declare_result.',
  '- As duas respeitam orçamento: max_matches e max_usd no torneio; n_trials, timeout_minutes e max_minutes na varredura. stop_search interrompe; search_status mostra o estado. Um agente só entra para analisar o resultado se o usuário pedir.',
];

export class SearchManager {
  private readonly entries = new Map<string, Entry>();
  private readonly permissions = new Map<string, (ok: boolean) => void>();
  /** Comandos de varredura já aprovados nesta conversa (template + pasta). */
  private readonly approved = new Set<string>();
  /** Buscas de uma conversa reaberta, lidas de .agm/search/: só leitura, sem runner. */
  private readonly restored = new Map<string, AgentInfo>();
  private detection?: Promise<Detection>;

  constructor(private readonly host: SearchHost) {}

  private get dir(): string {
    return path.join(this.host.cwd, '.agm', 'search');
  }

  has(id: string): boolean {
    return this.entries.has(id) || this.restored.has(id);
  }

  stop(id: string): void {
    this.entries.get(id)?.runner.stop();
  }

  ownsPermission(requestId: string): boolean {
    return this.permissions.has(requestId);
  }

  respondPermission(requestId: string, answer: PermissionDecision): void {
    const resolve = this.permissions.get(requestId);
    this.permissions.delete(requestId);
    this.host.post({ type: 'permissionClosed', requestId });
    resolve?.(answer.decision === 'allow' || answer.decision === 'always');
  }

  /** Conversa trocada ou fechada: para o que roda e esquece as aprovações. Os arquivos ficam. */
  reset(): void {
    for (const e of this.entries.values()) {
      e.runner.stop();
    }
    for (const resolve of this.permissions.values()) {
      resolve(false);
    }
    this.permissions.clear();
    this.entries.clear();
    this.restored.clear();
    this.approved.clear();
  }

  /**
   * Conversa reaberta: os torneios e varreduras dela voltam ao mapa a partir de .agm/search/<id>.json. Nenhum dos
   * dois módulos sabe continuar de um estado salvo, então tudo volta só para leitura: o que tinha terminado, com o
   * relatório; o que ainda rodava quando a janela fechou, como interrompido, com o relatório parcial.
   */
  restore(conversation: string): void {
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => /^(tor|sw)\d+\.json$/.test(f));
    } catch {
      return;
    }
    for (const f of files) {
      const id = f.slice(0, -'.json'.length);
      if (this.entries.has(id) || this.restored.has(id)) {
        continue;
      }
      let state: (TournamentState | SweepState) & { conversation?: string };
      let mtime: number;
      try {
        const file = path.join(this.dir, f);
        state = JSON.parse(fs.readFileSync(file, 'utf8'));
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (state.conversation !== conversation || (state.kind !== 'tournament' && state.kind !== 'sweep')) {
        continue;
      }
      const wasRunning = state.status === 'rodando' || state.status === 'gerando';
      const where = path.join('.agm', 'search', `${id}.json`);
      const report = state.kind === 'tournament' ? tournamentReport(state, where) : sweepReport(state, path.join('.agm', 'search', id));
      const base = this.node(state);
      const info: AgentInfo = {
        ...base,
        status: wasRunning ? 'stopped' : base.status,
        summary: `${wasRunning ? 'interrompida quando a janela fechou' : state.status} · ${base.search?.progress ?? ''} · só leitura`,
        durationMs: Math.max(0, (state.endedAt ? Date.parse(state.endedAt) : mtime) - Date.parse(state.startedAt)),
        report: wasRunning ? `Interrompida quando a janela fechou; resultado parcial, sem retomada.\n\n${report}` : report,
        reportedTo: state.spec.reportTo,
      };
      this.restored.set(id, info);
      this.host.post({ type: 'agent', agent: info });
      this.host.post({ type: 'agentItem', id, item: { kind: 'user', text: info.prompt ?? '' } });
    }
  }

  private ask(toolName: string, input: Record<string, unknown>, reason: string): Promise<boolean> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      this.permissions.set(requestId, resolve);
      this.host.post({ type: 'permission', requestId, toolName, input, canAlways: false, reason });
    });
  }

  /** Próximo id livre, olhando também os arquivos de outras janelas: tor1, tor2... e sw1, sw2... */
  private nextId(prefix: 'tor' | 'sw'): string {
    let max = 0;
    const re = new RegExp(`^${prefix}(\\d+)(\\.json)?$`);
    try {
      for (const f of fs.readdirSync(this.dir)) {
        max = Math.max(max, Number(re.exec(f)?.[1] ?? 0));
      }
    } catch {
      // Pasta ainda não existe.
    }
    for (const id of this.entries.keys()) {
      max = Math.max(max, Number(re.exec(id)?.[1] ?? 0));
    }
    return `${prefix}${max + 1}`;
  }

  private save(state: TournamentState | SweepState): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const conversation = this.entries.get(state.id)?.conversation;
      fs.writeFileSync(path.join(this.dir, `${state.id}.json`), JSON.stringify(conversation ? { ...state, conversation } : state, null, 2), 'utf8');
    } catch {
      // Disco cheio ou pasta sem permissão: a busca continua, só perde o arquivo.
    }
  }

  private log(id: string, line: string): void {
    const item: HistoryItem = { kind: 'text', text: line };
    this.host.post({ type: 'agentItem', id, item });
  }

  // ---------- Nó do mapa ----------

  private node(state: TournamentState | SweepState): AgentInfo {
    const prev = this.entries.get(state.id)?.info;
    const running = state.kind === 'tournament' ? state.status === 'gerando' || state.status === 'rodando' : state.status === 'rodando';
    const failed = state.status === 'falhou';
    const stopped = ['interrompido', 'interrompida', 'orçamento'].includes(state.status);
    const t = state.kind === 'tournament' ? state : undefined;
    const sw = state.kind === 'sweep' ? state : undefined;
    const leader = t ? ranking(t)[0] : undefined;
    return {
      ...(prev ?? {}),
      id: state.id,
      kind: 'routed',
      description: t ? `Torneio: ${short(t.spec.question, 60)}` : `Varredura: ${sw!.spec.name}`,
      prompt: t ? `Torneio de hipóteses\nPergunta: ${t.spec.question}\nCritérios: ${t.spec.criteria}` : `Varredura de hiperparâmetros\n${sw!.spec.commandTemplate}`,
      creator: state.spec.creator,
      reportTo: state.spec.reportTo,
      status: running ? 'running' : failed ? 'failed' : stopped ? 'stopped' : 'completed',
      totalTokens: t?.tokens ?? 0,
      durationMs: Date.now() - Date.parse(state.startedAt),
      toolUses: t ? t.matches.filter((m) => m.winner).length : sw!.trials.filter((x) => x.state !== 'running').length,
      model: t?.spec.judgeModel,
      color: prev?.color ?? (t ? 'indigo' : 'oliva'),
      summary: `${state.status} · ${t ? tournamentProgress(t) : sweepProgress(sw!)}`,
      search: {
        kind: state.kind,
        progress: t ? tournamentProgress(t) : sweepProgress(sw!),
        markdown: t ? tournamentMarkdown(t) : sweepMarkdown(sw!),
        label: t ? 'Ranking Elo' : 'Melhores trials',
        leader: leader && t?.matches.some((m) => m.winner) ? { id: leader.id, title: leader.title } : undefined,
      },
    };
  }

  private changed(state: TournamentState | SweepState): void {
    const entry = this.entries.get(state.id);
    if (!entry) {
      return;
    }
    entry.info = this.node(state);
    this.host.post({ type: 'agent', agent: entry.info });
    this.save(state);
  }

  /** Fim da busca: relatório no nó e entregue ao destino. */
  private finish(state: TournamentState | SweepState, report: string): void {
    const entry = this.entries.get(state.id);
    if (!entry) {
      return;
    }
    const target = state.spec.reportTo;
    entry.info = { ...this.node(state), report, reportedTo: target, reportedAt: new Date().toISOString() };
    this.host.post({ type: 'agent', agent: entry.info });
    this.save(state);
    if (target !== 'user') {
      this.host.deliver(target, `Relatório final ${state.kind === 'tournament' ? 'do torneio' : 'da varredura'} ${state.id}:\n\n${report}`, state.id);
    }
  }

  // ---------- Ferramentas ----------

  tools(callerId: string): SdkMcpToolDefinition<any>[] {
    return [this.tournamentTool(callerId), this.promoteTool(callerId), this.sweepTool(callerId), this.setupTool(), this.statusTool(), this.stopTool()];
  }

  private tournamentTool(callerId: string) {
    return tool(
      'start_tournament',
      'Torneio de hipóteses: juízes-modelo comparam candidatos em pares pelos critérios e o Elo ordena. Serve para PRIORIZAR ideias antes de gastar com experimento, não para concluir resultado empírico (isso é só declare_result). Roda em segundo plano; o ranking final vai para report_to.',
      {
        question: z.string().describe('Pergunta de pesquisa que as hipóteses respondem'),
        criteria: z.string().describe('Critérios de julgamento, em texto (ex.: "plausibilidade, novidade, custo de testar, tamanho do efeito esperado")'),
        candidates: z.array(z.object({ title: z.string(), text: z.string() })).optional().describe('Hipóteses candidatas. Com menos de duas, os geradores completam'),
        n_generate: z.number().int().min(0).max(12).optional().describe('Quantos geradores propõem candidatos novos a partir da pergunta. Omitido: 0 com 2+ candidatos, 4 sem'),
        rounds: z.number().int().min(1).max(10).describe('Rodadas; em cada uma, cada candidato joga uma partida contra um de Elo parecido'),
        judge_model: z.string().optional().describe('Modelo dos juízes e da evolução. Omitido: "sonnet"; "haiku" para triagem barata'),
        generator_model: z.string().optional().describe('Modelo dos geradores. Omitido: "haiku"'),
        k: z.number().positive().max(100).optional().describe('K do Elo. Omitido: 32'),
        evolve: z.boolean().optional().describe('Depois de cada rodada (menos a última), as duas melhores geram uma variante que entra no torneio. Omitido: false'),
        both_orders: z.boolean().optional().describe('Julga cada par nas duas ordens A/B; ordens que discordam viram empate. Custa o dobro. Omitido: false (a ordem é sorteada)'),
        max_matches: z.number().int().min(1).max(200).optional().describe('Orçamento: partidas no máximo. Omitido: 40'),
        max_usd: z.number().positive().optional().describe('Orçamento: custo estimado máximo em dólares, somando geradores, juízes e evolução. Omitido: 2'),
        parallel: z.number().int().min(1).max(8).optional().describe('Chamadas ao modelo ao mesmo tempo. Omitido: 4'),
        seed: z.number().int().optional().describe('Semente do sorteio de pares e da ordem A/B'),
        report_to: z.string().optional().describe('Destino do ranking final: "parent" (você, padrão), "main", "user" ou o id de um agente'),
      },
      async (args) => {
        const reportTo = this.host.resolveTarget(args.report_to, callerId);
        if (reportTo instanceof Error) {
          return fail(reportTo.message);
        }
        const given = (args.candidates ?? []).filter((c) => c.title.trim() && c.text.trim());
        const nGenerate = args.n_generate ?? (given.length >= 2 ? 0 : 4);
        if (given.length + nGenerate < 2) {
          return fail('O torneio precisa de pelo menos dois candidatos: passe candidates ou n_generate.');
        }
        const id = this.nextId('tor');
        const t = new Tournament(
          id,
          {
            question: args.question.trim(),
            criteria: args.criteria.trim(),
            rounds: args.rounds,
            k: args.k ?? 32,
            judgeModel: args.judge_model?.trim() || 'sonnet',
            generatorModel: args.generator_model?.trim() || 'haiku',
            evolve: !!args.evolve,
            bothOrders: !!args.both_orders,
            maxMatches: args.max_matches ?? 40,
            maxUsd: args.max_usd ?? 2,
            parallel: args.parallel ?? 4,
            seed: args.seed ?? Math.floor(Math.random() * 2 ** 31),
            creator: callerId,
            reportTo,
          },
          given,
          {
            profile: this.host.profile(),
            cwd: this.host.cwd,
            changed: (s) => this.changed(s),
            log: (line) => this.log(id, line),
          },
        );
        const entry: Entry = { info: this.node(t.state), runner: t, started: Date.now(), conversation: this.host.conversation?.() || undefined };
        this.entries.set(id, entry);
        this.host.post({ type: 'agent', agent: entry.info });
        this.host.post({ type: 'agentItem', id, item: { kind: 'user', text: entry.info.prompt ?? '' } });
        void t.run(nGenerate).then(() => this.finish(t.state, tournamentReport(t.state, path.join('.agm', 'search', `${id}.json`))));
        return text(
          `Torneio ${id} iniciado: ${given.length} candidato(s)${nGenerate ? ` e ${nGenerate} gerador(es) (${t.state.spec.generatorModel})` : ''}, ${args.rounds} rodada(s), juiz ${t.state.spec.judgeModel}, orçamento ${t.state.spec.maxMatches} partidas e US$ ${t.state.spec.maxUsd}. O ranking final vai para ${reportTo === callerId ? 'você' : reportTo}; siga com o seu trabalho. search_status({ id: "${id}" }) mostra o andamento.`,
        );
      },
      { alwaysLoad: true },
    );
  }

  private findTournament(id: string): TournamentState | undefined {
    const live = this.entries.get(id)?.runner;
    if (live && live.state.kind === 'tournament') {
      return live.state;
    }
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), 'utf8')) as TournamentState;
      return saved.kind === 'tournament' ? saved : undefined;
    } catch {
      return undefined;
    }
  }

  private promoteTool(callerId: string) {
    return tool(
      'promote_to_hypothesis',
      'Registra um candidato de torneio como hipótese pré-registrada do laboratório, para ser testado de verdade (runs com log_run e veredito com declare_result). O texto do candidato vira o enunciado.',
      {
        tournament_id: z.string(),
        candidate_id: z.string().describe('Id do candidato no torneio (ex.: "c2")'),
        metric: z.string().describe('Métrica primária do experimento que vai testar a ideia'),
        direction: z.enum(['higher', 'lower']),
        min_improvement: z.number().min(0).optional(),
        improvement_kind: z.enum(['absolute', 'relative']).optional(),
        baseline_arm: z.string().optional(),
        variant_arm: z.string().optional(),
        min_seeds: z.number().int().min(2).max(200).optional(),
        alpha: z.number().gt(0).lt(0.5).optional(),
        family: z.string().optional(),
      },
      async (args) => {
        const t = this.findTournament(args.tournament_id.trim());
        if (!t) {
          return fail(`Torneio "${args.tournament_id}" não existe (procurei também em .agm/search/).`);
        }
        const c = t.candidates.find((x) => x.id === args.candidate_id.trim());
        if (!c) {
          return fail(`Candidato "${args.candidate_id}" não está no torneio ${t.id}. Candidatos: ${t.candidates.map((x) => x.id).join(', ')}.`);
        }
        const baseline = (args.baseline_arm ?? 'baseline').trim();
        const variant = (args.variant_arm ?? 'variante').trim();
        if (!baseline || !variant || baseline === variant) {
          return fail('Os dois braços precisam de nomes diferentes e não vazios.');
        }
        const pos = ranking(t).findIndex((x) => x.id === c.id) + 1;
        const h = this.host.lab.store.addHypothesis({
          title: c.title,
          statement: `${c.text}\n\n(Candidato ${c.id} do torneio ${t.id}: ${pos}º lugar, Elo ${Math.round(c.elo)}, ${c.wins}-${c.losses}. O torneio só priorizou a ideia; nada aqui foi medido.)`,
          metric: args.metric.trim(),
          direction: args.direction,
          minImprovement: args.min_improvement ?? 0,
          improvementKind: args.improvement_kind ?? 'absolute',
          arms: [baseline, variant],
          minSeeds: args.min_seeds ?? 5,
          alpha: args.alpha ?? 0.05,
          family: args.family?.trim() || gitBranch(this.host.cwd) || 'padrão',
          createdBy: callerId,
        });
        const integrity = this.host.lab.onHypothesis?.(h, callerId);
        this.host.labChanged();
        return text(
          `Hipótese ${h.id} registrada a partir de ${c.id} ("${c.title}") do torneio ${t.id}. Métrica ${h.metric} (${h.direction === 'higher' ? 'maior' : 'menor'} é melhor), braços ${h.arms[0]} x ${h.arms[1]}, ${h.minSeeds} seeds por braço. Registre as execuções com log_run({ hypothesis_id: "${h.id}", ... }).${integrity ? `\n${integrity}` : ''}`,
        );
      },
      { alwaysLoad: true },
    );
  }

  private sweepTool(callerId: string) {
    return tool(
      'start_sweep',
      'Varredura de hiperparâmetros sem modelo no laço: o hub pede pontos ao Optuna (ou ao amostrador embutido, se não houver Optuna), roda command_template com cada ponto, lê a métrica do JSON gravado pelo script e registra cada trial como run no laboratório. No fim: melhores parâmetros, importância e, com vários objetivos, a fronteira de Pareto. Na primeira vez de cada comando o usuário aprova.',
      {
        name: z.string().describe('Nome curto da varredura'),
        command_template: z
          .string()
          .describe(
            'Comando com placeholders: {nome} de cada parâmetro, {out} (JSON de métricas que o script deve gravar, na pasta da varredura), {trial} (número do trial) e {progress} (arquivo onde o script acrescenta linhas {"step": k, "value": v}, para a poda). Ex.: "python train.py --lr {lr} --layers {layers} --out {out}"',
          ),
        params: z
          .array(
            z.object({
              name: z.string(),
              type: z.enum(['float', 'int', 'categorical']),
              low: z.number().optional(),
              high: z.number().optional(),
              log: z.boolean().optional().describe('Escala logarítmica (low > 0)'),
              step: z.number().positive().optional(),
              choices: z.array(z.string()).optional().describe('Só para categorical: os valores, como texto'),
            }),
          )
          .min(1)
          .describe('Espaço de busca'),
        metric: z.string().describe('Métrica principal, como aparece no JSON de saída'),
        direction: z.enum(['minimize', 'maximize']),
        extra_objectives: z
          .array(z.object({ metric: z.string(), direction: z.enum(['minimize', 'maximize']) }))
          .optional()
          .describe('Outros objetivos, para otimização multiobjetivo (fronteira de Pareto)'),
        n_trials: z.number().int().min(1).max(1000),
        parallel: z.number().int().min(1).max(16).optional().describe('Trials ao mesmo tempo. Omitido: 1'),
        sampler: z.enum(['tpe', 'random', 'cmaes', 'gp', 'qmc', 'nsgaii']).optional().describe('Só com Optuna. Omitido: "tpe"'),
        pruner: z.enum(['none', 'median', 'hyperband', 'successive_halving']).optional().describe('Poda de trials ruins no meio; exige que o script escreva em {progress}. Omitido: "none"'),
        backend: z.enum(['auto', 'optuna', 'builtin']).optional().describe('"auto" (padrão): Optuna se houver, senão o embutido; "optuna" falha sem ele; "builtin" força o embutido'),
        metrics_file: z.string().optional().describe('Caminho do JSON de métricas, se o script não aceitar {out}; aceita os mesmos placeholders. Sem {out} nem isto, o hub lê a última linha JSON do stdout'),
        workdir: z.string().optional().describe('Pasta onde o comando roda, relativa ao projeto. Omitido: o projeto'),
        timeout_minutes: z.number().positive().optional().describe('Tempo máximo por trial. Omitido: 30'),
        max_minutes: z.number().positive().optional().describe('Orçamento de tempo total; nenhum trial novo começa depois dele'),
        seed: z.number().int().optional(),
        report_to: z.string().optional().describe('Destino do relatório final: "parent" (você, padrão), "main", "user" ou o id de um agente'),
      },
      async (args) => {
        const reportTo = this.host.resolveTarget(args.report_to, callerId);
        if (reportTo instanceof Error) {
          return fail(reportTo.message);
        }
        const params = args.params.map((p) => ({ ...p, name: p.name.trim() })) as ParamSpec[];
        const bad = validateParams(params, args.command_template);
        if (bad) {
          return fail(bad);
        }
        const workdir = path.resolve(this.host.cwd, args.workdir ?? '.');
        if (!fs.existsSync(workdir)) {
          return fail(`A pasta ${workdir} não existe.`);
        }
        let detection: Detection | undefined;
        let note = '';
        if (args.backend !== 'builtin') {
          detection = await this.detect();
          if (!detection.ready) {
            note = missingOptunaText(detection);
            if (args.backend === 'optuna') {
              return fail(note);
            }
            this.host.post({ type: 'notice', level: 'info', text: `Varredura sem Optuna. ${note}` });
          }
        } else {
          note = 'embutido por escolha (backend "builtin")';
        }
        const python = detection?.ready;
        const approval = `${args.command_template}\n${workdir}`;
        if (!this.approved.has(approval)) {
          const ok = await this.ask(
            'start_sweep',
            { command_template: args.command_template, workdir, n_trials: args.n_trials, parallel: args.parallel ?? 1 },
            `Varredura "${args.name}": o hub roda este comando ${args.n_trials} vez(es), ${args.parallel ?? 1} por vez, fora das restrições dos agentes. A aprovação vale para este comando até o fim desta conversa.`,
          );
          if (!ok) {
            return fail('O usuário recusou a varredura.');
          }
          this.approved.add(approval);
        }
        const id = this.nextId('sw');
        const objectives = [{ metric: args.metric.trim(), direction: args.direction }, ...(args.extra_objectives ?? []).map((o) => ({ metric: o.metric.trim(), direction: o.direction }))];
        const lab = this.host.lab;
        const h = lab.store.addHypothesis({
          title: `Varredura ${id}: ${args.name.trim()}`,
          statement: `Exploratória: busca de ${params.map((p) => p.name).join(', ')} com ${python ? `Optuna (${args.sampler ?? 'tpe'})` : 'o amostrador embutido'}, ${args.n_trials} trials. Cada run é um trial; o melhor é otimista e precisa de hipótese confirmatória.`,
          metric: objectives[0].metric,
          direction: objectives[0].direction === 'minimize' ? 'lower' : 'higher',
          minImprovement: 0,
          improvementKind: 'absolute',
          arms: ['trials', 'confirmação'],
          minSeeds: 2,
          alpha: 0.05,
          // Família própria: a hipótese exploratória não entra na correção de múltiplas comparações das outras.
          family: `varredura:${id}`,
          createdBy: callerId,
          sweepId: id,
        });
        this.host.labChanged();
        const dir = path.join(this.dir, id);
        const sweep = new Sweep(
          id,
          {
            name: args.name.trim(),
            commandTemplate: args.command_template,
            params,
            objectives,
            nTrials: args.n_trials,
            parallel: args.parallel ?? 1,
            sampler: args.sampler ?? (objectives.length > 1 ? 'nsgaii' : 'tpe'),
            pruner: args.pruner ?? 'none',
            metricsFile: args.metrics_file,
            workdir,
            timeoutMinutes: args.timeout_minutes ?? 30,
            maxMinutes: args.max_minutes,
            seed: args.seed ?? Math.floor(Math.random() * 2 ** 31),
            creator: callerId,
            reportTo,
          },
          python,
          python
            ? `Optuna ${python.optuna} em ${python.source}`
            : !detection
              ? 'escolhido com backend "builtin"'
              : detection.base
                ? `Python ${detection.base.version} sem o pacote optuna`
                : 'Python não encontrado',
          {
            dir,
            changed: (s) => this.changed(s),
            log: (line) => this.log(id, line),
            readMetrics: (file) => readMetricsFile(file),
            logRun: (trial, metrics, file) => {
              const git = gitInfo(workdir);
              const run = lab.store.addRun({
                hypothesisId: h.id,
                arm: 'trials',
                seed: typeof trial.params.seed === 'number' ? trial.params.seed : trial.number,
                metrics,
                command: trial.command,
                commit: git.commit,
                dirty: git.dirty,
                artifact: file ? path.relative(this.host.cwd, file.artifact) : `stdout do trial ${trial.number}`,
                metricsFileHash: file?.hash,
                source: 'arquivo',
                agent: id,
                trial: trial.number,
                params: trial.params,
              });
              this.host.labChanged();
              return run.id;
            },
          },
        );
        sweep.state.hypothesisId = h.id;
        const entry: Entry = { info: this.node(sweep.state), runner: sweep, started: Date.now(), conversation: this.host.conversation?.() || undefined };
        this.entries.set(id, entry);
        this.host.post({ type: 'agent', agent: entry.info });
        this.host.post({ type: 'agentItem', id, item: { kind: 'user', text: entry.info.prompt ?? '' } });
        void sweep.run().then(() => this.finish(sweep.state, sweepReport(sweep.state, path.relative(this.host.cwd, dir) || dir)));
        return text(
          [
            `Varredura ${id} iniciada: ${args.n_trials} trials, ${args.parallel ?? 1} por vez, ${python ? `Optuna ${python.optuna} (${python.source}), sampler ${sweep.state.spec.sampler}, estudo em ${path.join(dir, 'study.db')}` : 'amostrador embutido (TPE simples)'}. Trials viram runs da hipótese exploratória ${h.id}. O relatório final vai para ${reportTo === callerId ? 'você' : reportTo}.`,
            ...(note && !python ? ['', note] : []),
          ].join('\n'),
        );
      },
      { alwaysLoad: true },
    );
  }

  private detect(): Promise<Detection> {
    this.detection ??= detectPython(this.host.cwd);
    return this.detection;
  }

  private setupTool() {
    return tool(
      'setup_optuna',
      'Cria o venv .agm/venv neste projeto e instala o optuna nele (pip), depois de o usuário aprovar. Não mexe no Python global. Sem argumentos: só informa o que achou.',
      { install: z.boolean().optional().describe('true: pede aprovação e instala. Omitido: só detecta') },
      async (args) => {
        this.detection = undefined;
        const d = await this.detect();
        if (d.ready) {
          return text(`Optuna ${d.ready.optuna} pronto em ${d.ready.source} (${d.ready.exe}, Python ${d.ready.version}).`);
        }
        if (!args.install || !d.base) {
          return text(missingOptunaText(d));
        }
        const ok = await this.ask(
          'setup_optuna',
          { python: d.base.exe, venv: path.join(this.host.cwd, '.agm', 'venv'), pacote: 'optuna' },
          `Criar o venv .agm/venv com o Python ${d.base.version} e instalar o optuna nele (baixa pacotes do PyPI). O Python global não muda.`,
        );
        if (!ok) {
          return fail('O usuário recusou a instalação.');
        }
        this.host.post({ type: 'notice', level: 'info', text: 'Instalando o optuna em .agm/venv...' });
        const r = await installOptuna(d.base, this.host.cwd, () => undefined);
        this.detection = undefined;
        const after = await this.detect();
        if (!r.ok || !after.ready) {
          return fail(`A instalação falhou.\n${r.output}`);
        }
        this.host.post({ type: 'notice', level: 'info', text: `Optuna ${after.ready.optuna} instalado em .agm/venv.` });
        return text(`Optuna ${after.ready.optuna} instalado em .agm/venv (Python ${after.ready.version}). As próximas varreduras usam ele.`);
      },
      { alwaysLoad: true },
    );
  }

  private statusTool() {
    return tool(
      'search_status',
      'Estado dos torneios e varreduras desta conversa: ranking Elo ou melhores trials. Sem id, lista todos.',
      { id: z.string().optional() },
      async (args) => {
        // As restauradas (só leitura) entram junto com as que rodam nesta janela.
        const infos = new Map<string, AgentInfo>([...this.restored, ...[...this.entries].map(([id, e]) => [id, e.info] as [string, AgentInfo])]);
        if (!infos.size) {
          return text('Nenhum torneio nem varredura nesta conversa.');
        }
        if (args.id) {
          const info = infos.get(args.id.trim());
          if (!info) {
            return fail(`"${args.id}" não existe. Ids: ${[...infos.keys()].join(', ')}.`);
          }
          return text(`${info.description}\n${info.search?.markdown ?? ''}`);
        }
        return text([...infos.values()].map((info) => `${info.id} | ${info.description} | ${info.summary}`).join('\n'));
      },
      { alwaysLoad: true },
    );
  }

  private stopTool() {
    return tool(
      'stop_search',
      'Interrompe um torneio ou uma varredura. O que já rodou fica, e o relatório parcial vai para o destino.',
      { id: z.string() },
      async (args) => {
        const e = this.entries.get(args.id.trim());
        if (!e) {
          return fail(`"${args.id}" não existe.`);
        }
        e.runner.stop();
        return text(`${args.id} interrompido. O relatório parcial vai para ${e.info.reportTo}.`);
      },
      { alwaysLoad: true },
    );
  }
}

function short(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Erros do espaço de busca antes de gastar qualquer trial. */
export function validateParams(params: ParamSpec[], template: string): string | undefined {
  const names = new Set<string>();
  for (const p of params) {
    if (!SAFE_NAME.test(p.name) || RESERVED.has(p.name)) {
      return `Nome de parâmetro inválido: "${p.name}" (letras, números e _, sem ${[...RESERVED].join(', ')}).`;
    }
    if (names.has(p.name)) {
      return `Parâmetro repetido: ${p.name}.`;
    }
    names.add(p.name);
    if (!template.includes(`{${p.name}}`)) {
      return `O comando não usa {${p.name}}: o parâmetro não chegaria ao script.`;
    }
    if (p.type === 'categorical') {
      if (!p.choices?.length) {
        return `${p.name}: categorical precisa de choices.`;
      }
      const unsafe = p.choices.find((c) => typeof c === 'string' && !SAFE_CHOICE.test(c));
      if (unsafe !== undefined) {
        return `${p.name}: a escolha "${unsafe}" tem caractere que o shell interpretaria (use letras, números e . _ - + / : = @ ,).`;
      }
      continue;
    }
    if (typeof p.low !== 'number' || typeof p.high !== 'number' || !(p.low < p.high)) {
      return `${p.name}: ${p.type} precisa de low < high.`;
    }
    if (p.log && (p.low <= 0 || p.step)) {
      return `${p.name}: escala log exige low > 0 e não aceita step.`;
    }
    if (p.type === 'int' && (!Number.isInteger(p.low) || !Number.isInteger(p.high))) {
      return `${p.name}: int precisa de low e high inteiros.`;
    }
  }
  return undefined;
}

