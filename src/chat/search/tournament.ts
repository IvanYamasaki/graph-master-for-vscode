/**
 * Torneio de hipóteses (inspirado no AI co-scientist, arXiv 2502.18864): candidatos vindos do orquestrador ou
 * de geradores baratos, rodadas de comparação em pares por juízes que só veem os dois textos e os critérios,
 * Elo com K configurável e, se pedido, uma variante "evoluída" das duas melhores a cada rodada.
 *
 * O torneio ordena ideias para decidir o que testar primeiro. Não mede nada: resultado empírico só sai de
 * experimento registrado no laboratório e de declare_result.
 */
import { z, type ZodRawShape } from 'zod';
import type { Profile } from '../../profiles';
import { ELO_START, eloUpdate, pairKey, rng, swissPairs } from './elo';
import { oneShot, pool } from './oneShot';

export interface Candidate {
  id: string;
  title: string;
  text: string;
  origin: 'orquestrador' | 'gerador' | 'evolução';
  parents?: string[];
  elo: number;
  wins: number;
  losses: number;
  draws: number;
}

export interface Match {
  n: number;
  round: number;
  /** Como o juiz viu: `first` foi apresentado como A. */
  first: string;
  second: string;
  /** Id do vencedor, "empate" (ordens discordaram) ou ausente se a partida falhou. */
  winner?: string;
  justification: string;
  /** Com both_orders: a justificativa da ordem trocada. */
  justification2?: string;
  costUsd: number;
  error?: string;
}

export interface TournamentSpec {
  question: string;
  criteria: string;
  rounds: number;
  k: number;
  judgeModel: string;
  generatorModel: string;
  evolve: boolean;
  bothOrders: boolean;
  maxMatches: number;
  maxUsd: number;
  parallel: number;
  seed: number;
  creator: string;
  reportTo: string;
}

export type TournamentStatus = 'gerando' | 'rodando' | 'concluído' | 'interrompido' | 'orçamento' | 'falhou';

export interface TournamentState {
  id: string;
  kind: 'tournament';
  spec: TournamentSpec;
  status: TournamentStatus;
  round: number;
  candidates: Candidate[];
  matches: Match[];
  costUsd: number;
  tokens: number;
  startedAt: string;
  endedAt?: string;
  note?: string;
}

export interface TournamentHooks {
  profile: Profile;
  cwd: string;
  changed(state: TournamentState): void;
  log(text: string): void;
}

const MAX_CANDIDATES = 16;

/** Pontos de vista dos geradores: sem eles, N geradores com o mesmo prompt devolvem N vezes a mesma ideia. */
const LENSES = [
  'mecanismo: uma explicação causal concreta, com uma previsão que um experimento pequeno confirmaria ou derrubaria',
  'simplicidade: a intervenção mais barata e simples que poderia funcionar',
  'contrária: questione a suposição mais comum sobre o problema e proponha o que decorre disso',
  'dados: qualidade, distribuição, rótulos, vazamento ou tamanho do conjunto',
  'otimização: treino, arquitetura, regularização ou hiperparâmetros',
  'analogia: uma ideia de outra área que se transfira para este problema',
];

const JUDGE_SYSTEM = [
  'Você é juiz de um torneio de hipóteses de pesquisa. O torneio serve para decidir o que testar primeiro; ele não conclui nada sobre resultado empírico.',
  'Compare as duas hipóteses só pelos critérios dados. Não favoreça a posição (A ou B), o tamanho do texto nem o tom confiante.',
  'Chame submit_match uma única vez: winner "A" ou "B" e uma justificativa de no máximo três frases que cite os critérios. Nada mais.',
].join('\n');

const GENERATOR_SYSTEM = [
  'Você propõe uma hipótese de pesquisa para um torneio que decide o que testar primeiro.',
  'A hipótese precisa ser específica e testável: o que muda, o que se espera medir e por quê.',
  'Chame submit_candidate uma única vez, com um título curto (até 10 palavras) e o texto (até 120 palavras). Nada mais.',
].join('\n');

export class Tournament {
  readonly state: TournamentState;
  private readonly abort = new AbortController();
  private readonly random: () => number;
  private readonly played = new Set<string>();
  private seq = 0;

  constructor(
    id: string,
    spec: TournamentSpec,
    given: { title: string; text: string }[],
    private readonly hooks: TournamentHooks,
  ) {
    this.random = rng(spec.seed);
    this.state = {
      id,
      kind: 'tournament',
      spec,
      status: given.length >= 2 ? 'rodando' : 'gerando',
      round: 0,
      candidates: [],
      matches: [],
      costUsd: 0,
      tokens: 0,
      startedAt: new Date().toISOString(),
    };
    for (const c of given) {
      this.add(c.title, c.text, 'orquestrador');
    }
  }

  get running(): boolean {
    return this.state.status === 'gerando' || this.state.status === 'rodando';
  }

  stop(): void {
    if (this.running) {
      this.state.status = 'interrompido';
      this.state.note = 'interrompido pelo usuário ou pelo orquestrador';
      this.abort.abort();
      this.hooks.changed(this.state);
    }
  }

  private add(title: string, text: string, origin: Candidate['origin'], parents?: string[]): Candidate | undefined {
    const clean = title.trim();
    if (!clean || this.state.candidates.length >= MAX_CANDIDATES) {
      return undefined;
    }
    if (this.state.candidates.some((c) => c.title.trim().toLowerCase() === clean.toLowerCase())) {
      return undefined;
    }
    const c: Candidate = { id: `c${++this.seq}`, title: clean, text: text.trim(), origin, parents, elo: ELO_START, wins: 0, losses: 0, draws: 0 };
    this.state.candidates.push(c);
    return c;
  }

  private overBudget(): boolean {
    const s = this.state.spec;
    return this.state.matches.length >= s.maxMatches || this.state.costUsd >= s.maxUsd;
  }

  async run(nGenerate: number): Promise<void> {
    try {
      if (nGenerate > 0) {
        await this.generate(nGenerate);
      }
      if (!this.running) {
        return;
      }
      if (this.state.candidates.length < 2) {
        this.state.status = 'falhou';
        this.state.note = 'menos de dois candidatos para comparar';
        return;
      }
      this.state.status = 'rodando';
      this.hooks.changed(this.state);
      for (let r = 1; r <= this.state.spec.rounds && this.running; r++) {
        this.state.round = r;
        await this.playRound(r);
        if (!this.running) {
          break;
        }
        if (this.overBudget()) {
          this.state.status = 'orçamento';
          this.state.note = `orçamento do torneio atingido (${this.state.matches.length} partidas, US$ ${this.state.costUsd.toFixed(3)})`;
          break;
        }
        if (this.state.spec.evolve && r < this.state.spec.rounds) {
          await this.evolve(r);
        }
      }
      if (this.running) {
        this.state.status = 'concluído';
      }
    } catch (err) {
      this.state.status = 'falhou';
      this.state.note = err instanceof Error ? err.message : String(err);
    } finally {
      this.state.endedAt = new Date().toISOString();
      this.hooks.changed(this.state);
    }
  }

  private charge(r: { costUsd: number; tokens: number }): void {
    this.state.costUsd += r.costUsd;
    this.state.tokens += r.tokens;
  }

  private async generate(n: number): Promise<void> {
    const s = this.state.spec;
    const existing = this.state.candidates.map((c) => `- ${c.title}`);
    const jobs = Array.from({ length: n }, (_, i) => async () => {
      if (!this.running || this.state.costUsd >= s.maxUsd) {
        return;
      }
      const lens = LENSES[i % LENSES.length];
      const r = await oneShot<ZodRawShape, { title: string; text: string }>({
        profile: this.hooks.profile,
        cwd: this.hooks.cwd,
        model: s.generatorModel,
        system: GENERATOR_SYSTEM,
        prompt: [
          `Pergunta de pesquisa: ${s.question}`,
          `Critérios com que as hipóteses serão julgadas: ${s.criteria}`,
          `Ponto de vista desta proposta: ${lens}.`,
          ...(existing.length ? ['Já estão no torneio (não repita):', ...existing] : []),
        ].join('\n'),
        toolName: 'submit_candidate',
        toolDescription: 'Entrega a hipótese proposta.',
        shape: { title: z.string().describe('Título curto'), text: z.string().describe('A hipótese, específica e testável') },
        signal: this.abort.signal,
      });
      this.charge(r);
      if (r.value) {
        const c = this.add(r.value.title, r.value.text, 'gerador');
        if (c) {
          this.hooks.log(`Gerador ${i + 1} (${lens.split(':')[0]}) propôs ${c.id}: ${c.title}`);
        }
      } else {
        this.hooks.log(`Gerador ${i + 1} falhou: ${r.error}`);
      }
      this.hooks.changed(this.state);
    });
    await pool(jobs, s.parallel);
  }

  private async playRound(round: number): Promise<void> {
    const s = this.state.spec;
    const pairs = swissPairs(this.state.candidates, this.played, this.random);
    const outcomes = await pool(
      pairs.map(([x, y]) => async () => {
        const needed = s.bothOrders ? 2 : 1;
        if (!this.running || this.state.matches.length + needed > s.maxMatches || this.state.costUsd >= s.maxUsd) {
          return undefined;
        }
        // Reserva o número agora: partidas em paralelo não passam juntas do limite.
        const match: Match = { n: this.state.matches.length + 1, round, first: x, second: y, justification: '', costUsd: 0 };
        if (this.random() < 0.5) {
          match.first = y;
          match.second = x;
        }
        this.state.matches.push(match);
        if (s.bothOrders) {
          this.state.matches.push({ ...match, n: match.n + 1, first: match.second, second: match.first, justification: '(ordem trocada da partida anterior)' });
        }
        await this.judge(match);
        return match;
      }),
      s.parallel,
    );
    // Elo depois da rodada inteira: cada candidato joga uma vez por rodada, então a ordem não muda nada.
    for (const m of outcomes) {
      if (!m || !m.winner) {
        continue;
      }
      const a = this.byId(m.first);
      const b = this.byId(m.second);
      const score = m.winner === 'empate' ? 0.5 : m.winner === a.id ? 1 : 0;
      [a.elo, b.elo] = eloUpdate(a.elo, b.elo, score, s.k);
      if (score === 0.5) {
        a.draws++;
        b.draws++;
      } else {
        (score === 1 ? a : b).wins++;
        (score === 1 ? b : a).losses++;
      }
      this.played.add(pairKey(a.id, b.id));
    }
    this.hooks.changed(this.state);
  }

  private byId(id: string): Candidate {
    const c = this.state.candidates.find((x) => x.id === id);
    if (!c) {
      throw new Error(`candidato ${id} sumiu`);
    }
    return c;
  }

  /** Uma chamada ao juiz com A e B na ordem dada. Devolve o id do vencedor. */
  private async ask(first: Candidate, second: Candidate): Promise<{ winner?: string; justification: string; costUsd: number; error?: string }> {
    const s = this.state.spec;
    const show = (tag: string, c: Candidate) => `Hipótese ${tag}: ${c.title}\n${c.text}`;
    let last: { winner?: string; justification: string; costUsd: number; error?: string } = { justification: '', costUsd: 0 };
    // Uma segunda tentativa quando o juiz não chama a ferramenta: acontece de vez em quando com modelo pequeno.
    for (let attempt = 0; attempt < 2 && this.running; attempt++) {
      const r = await oneShot<ZodRawShape, { winner: 'A' | 'B'; justification: string }>({
        profile: this.hooks.profile,
        cwd: this.hooks.cwd,
        model: s.judgeModel,
        system: JUDGE_SYSTEM,
        prompt: [`Pergunta de pesquisa: ${s.question}`, `Critérios: ${s.criteria}`, '', show('A', first), '', show('B', second)].join('\n'),
        toolName: 'submit_match',
        toolDescription: 'Entrega o veredito da partida: qual hipótese é melhor pelos critérios, e por quê.',
        shape: {
          winner: z.enum(['A', 'B']).describe('"A" ou "B"'),
          justification: z.string().describe('Até três frases, citando os critérios'),
        },
        signal: this.abort.signal,
      });
      this.charge(r);
      last = {
        winner: r.value ? (r.value.winner === 'A' ? first.id : second.id) : undefined,
        justification: r.value?.justification.trim() ?? '',
        costUsd: (last.costUsd ?? 0) + r.costUsd,
        error: r.error,
      };
      if (r.value) {
        break;
      }
    }
    return last;
  }

  private async judge(m: Match): Promise<void> {
    const a = this.byId(m.first);
    const b = this.byId(m.second);
    const one = await this.ask(a, b);
    m.costUsd = one.costUsd;
    m.justification = one.justification;
    m.error = one.error;
    if (!one.winner) {
      this.hooks.log(`Partida ${m.n} (${a.id} x ${b.id}) sem veredito: ${one.error ?? 'falhou'}`);
      return;
    }
    if (!this.state.spec.bothOrders) {
      m.winner = one.winner;
    } else {
      const two = await this.ask(b, a);
      m.costUsd += two.costUsd;
      m.justification2 = two.justification;
      const mirror = this.state.matches.find((x) => x.n === m.n + 1);
      if (mirror) {
        mirror.winner = two.winner;
        mirror.justification = two.justification || '(sem veredito)';
        mirror.costUsd = two.costUsd;
        mirror.error = two.error;
      }
      // As duas ordens concordam: vitória. Discordam (ou a segunda falhou): empate, que é o sinal de viés de posição.
      m.winner = two.winner === one.winner ? one.winner : 'empate';
    }
    const who = m.winner === 'empate' ? 'empate (as duas ordens discordaram)' : `${m.winner} venceu`;
    this.hooks.log(`Rodada ${m.round}, partida ${m.n}: ${a.id} (A) x ${b.id} (B), ${who}. ${m.justification}`);
    this.hooks.changed(this.state);
  }

  private async evolve(round: number): Promise<void> {
    const s = this.state.spec;
    if (this.state.candidates.length >= MAX_CANDIDATES || this.state.costUsd >= s.maxUsd) {
      return;
    }
    const [x, y] = [...this.state.candidates].sort((p, q) => q.elo - p.elo);
    if (!x || !y) {
      return;
    }
    const notes = this.state.matches
      .filter((m) => m.winner && [m.first, m.second].some((id) => id === x.id || id === y.id) && m.justification)
      .slice(-6)
      .map((m) => `- ${m.justification}`);
    const r = await oneShot<ZodRawShape, { title: string; text: string }>({
      profile: this.hooks.profile,
      cwd: this.hooks.cwd,
      model: s.judgeModel,
      system: GENERATOR_SYSTEM,
      prompt: [
        `Pergunta de pesquisa: ${s.question}`,
        `Critérios: ${s.criteria}`,
        'As duas hipóteses mais bem colocadas até agora:',
        `1. ${x.title}\n${x.text}`,
        `2. ${y.title}\n${y.text}`,
        ...(notes.length ? ['O que os juízes disseram nas partidas delas:', ...notes] : []),
        'Proponha uma variante nova que junte os pontos fortes das duas e corrija as fraquezas apontadas. Não copie nenhuma das duas.',
      ].join('\n'),
      toolName: 'submit_candidate',
      toolDescription: 'Entrega a hipótese evoluída.',
      shape: { title: z.string().describe('Título curto'), text: z.string().describe('A hipótese, específica e testável') },
      signal: this.abort.signal,
    });
    this.charge(r);
    if (r.value) {
      const c = this.add(r.value.title, r.value.text, 'evolução', [x.id, y.id]);
      if (c) {
        this.hooks.log(`Depois da rodada ${round}, ${x.id} e ${y.id} geraram a variante ${c.id}: ${c.title} (entra com Elo ${ELO_START}).`);
      }
    } else {
      this.hooks.log(`Evolução depois da rodada ${round} falhou: ${r.error}`);
    }
    this.hooks.changed(this.state);
  }
}

// ---------- Texto ----------

export function ranking(state: TournamentState): Candidate[] {
  return [...state.candidates].sort((a, b) => b.elo - a.elo || b.wins - a.wins);
}

const fmtElo = (x: number) => String(Math.round(x));
const cell = (s: string) => s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

export function tournamentProgress(state: TournamentState): string {
  const leader = ranking(state)[0];
  const done = state.matches.filter((m) => m.winner).length;
  if (state.status === 'gerando') {
    return `gerando candidatos · ${state.candidates.length}`;
  }
  return `${done}/${plannedMatches(state)} partidas${leader && done ? ` · líder ${leader.id} ${fmtElo(leader.elo)}` : ''}`;
}

/** Partidas previstas: rodadas vezes pares, ou o limite, o que for menor. */
export function plannedMatches(state: TournamentState): number {
  const s = state.spec;
  const perRound = Math.floor(state.candidates.length / 2) * (s.bothOrders ? 2 : 1);
  return Math.min(s.maxMatches, Math.max(perRound * s.rounds, state.matches.length));
}

export function tournamentTable(state: TournamentState): string {
  const rows = ranking(state).map(
    (c, i) => `| ${i + 1} | ${c.id} · ${cell(c.title)}${c.origin === 'evolução' ? ' (evoluída)' : ''} | ${fmtElo(c.elo)} | ${c.wins}-${c.losses}${c.draws ? `-${c.draws}` : ''} |`,
  );
  return ['| # | candidato | Elo | V-D' + (state.matches.some((m) => m.winner === 'empate') ? '-E' : '') + ' |', '|---|---|---|---|', ...rows].join('\n');
}

export function tournamentMarkdown(state: TournamentState): string {
  const s = state.spec;
  const recent = state.matches
    .filter((m) => m.winner)
    .slice(-4)
    .reverse()
    .map((m) => `- R${m.round} ${m.first} x ${m.second}: ${m.winner === 'empate' ? 'empate' : `**${m.winner}**`}. ${m.justification}`);
  return [
    `**${state.status}** · rodada ${state.round}/${s.rounds} · ${tournamentProgress(state)} · US$ ${state.costUsd.toFixed(3)}`,
    '',
    tournamentTable(state),
    ...(recent.length ? ['', 'Últimas partidas:', ...recent] : []),
    ...(state.note ? ['', `_${state.note}_`] : []),
  ].join('\n');
}

/** Relatório final entregue ao destino: ranking, textos, justificativas e o lembrete de que isto só prioriza. */
export function tournamentReport(state: TournamentState, file: string): string {
  const s = state.spec;
  const order = ranking(state);
  const leader = order[0];
  const played = state.matches.filter((m) => m.winner);
  const head =
    state.status === 'concluído'
      ? `Torneio ${state.id} concluído: ${leader ? `${leader.id} "${leader.title}" lidera com Elo ${fmtElo(leader.elo)}` : 'sem candidatos'} depois de ${played.length} partidas.`
      : `Torneio ${state.id} ${state.status}${state.note ? ` (${state.note})` : ''}: ranking parcial com ${played.length} partidas.`;
  const lines = [
    head,
    '',
    `Pergunta: ${s.question}`,
    `Critérios: ${s.criteria}`,
    `Juiz ${s.judgeModel}, K ${s.k}, ${state.round} de ${s.rounds} rodadas, ordem A/B sorteada${s.bothOrders ? ' e cada par julgado nas duas ordens' : ''}, custo estimado US$ ${state.costUsd.toFixed(3)}.`,
    '',
    tournamentTable(state),
    '',
    'Candidatos:',
    ...order.map((c) => `- ${c.id} (${c.origin}${c.parents ? ` de ${c.parents.join(' + ')}` : ''}) ${c.title}: ${c.text.replace(/\s+/g, ' ')}`),
    '',
    'Partidas e justificativas (o primeiro id foi apresentado como A):',
    ...state.matches.map(
      (m) => `- R${m.round} #${m.n} ${m.first} x ${m.second}: ${m.winner ? (m.winner === 'empate' ? 'empate' : `${m.winner} venceu`) : `sem veredito (${m.error ?? 'não jogada'})`}. ${m.justification}`,
    ),
    '',
    'O torneio prioriza ideias pela opinião de juízes-modelo; ele não é evidência empírica. Para testar uma delas: promote_to_hypothesis({ tournament_id, candidate_id, metric, direction, ... }), depois runs com log_run e o veredito com declare_result.',
    `Estado completo em ${file}.`,
  ];
  return lines.join('\n');
}
