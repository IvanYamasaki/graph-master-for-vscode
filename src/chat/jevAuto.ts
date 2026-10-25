/**
 * Usos automáticos do Jev: o host consulta sozinho, sem turno de modelo, nos pontos onde antes valia uma regra fixa.
 * Quatro usos, cada um ligado por uma configuração própria (agentGraphMaster.jev.auto.*), todos desligados por padrão:
 * - spawnRouting: modelo e effort de um agente novo quando o spawn_agent não diz;
 * - stuckCheck: antes do cartão de agente preso, pergunta se as chamadas recentes ainda avançam;
 * - reportCheck: antes de entregar o relatório final, pergunta se ele responde à tarefa (devolve uma vez se não);
 * - proposalFilter: segura proposta de vigia que não é tarefa do usuário ou repete outra.
 * Tudo aqui é puro (estado, perguntas, leitura das respostas); a chamada fica com quem integra. Sem resposta a tempo,
 * resposta incerta ou erro: segue a regra antiga (fail-open). O state sai para a TypeSafe ou a Vercel.
 */
import { JEV_LOW_CONFIDENCE, JevAnswer, JevQuestions } from './jev';

export type JevAutoUse = 'spawnRouting' | 'stuckCheck' | 'reportCheck' | 'proposalFilter';

/** Chave da configuração de cada uso, dentro de agentGraphMaster. */
export const JEV_AUTO_SETTING: Record<JevAutoUse, string> = {
  spawnRouting: 'jev.auto.spawnRouting',
  stuckCheck: 'jev.auto.stuckCheck',
  reportCheck: 'jev.auto.reportCheck',
  proposalFilter: 'jev.auto.proposalFilter',
};

/** Quanto o host espera o Jev antes de seguir sem ele. */
export const JEV_AUTO_TIMEOUT_MS = 4000;

/** noul só decide quando passa disto (ou fica abaixo de 1 menos isto). Equivale a confiança |2p-1| ≥ 0,7. */
export const NOUL_DECISIVE = 0.85;

/** Texto longo no state: começo e fim, que é onde costumam estar o pedido e a conclusão. */
export function clipMiddle(text: string, max: number): string {
  const t = (text ?? '').trim();
  if (t.length <= max) {
    return t;
  }
  const head = Math.ceil(max * 0.6);
  const tail = max - head;
  return `${t.slice(0, head)}\n[… ${t.length - max} caracteres cortados …]\n${t.slice(t.length - tail)}`;
}

/** Espera a promessa até `ms`; passou disso ou falhou, devolve undefined (quem chama segue sem o Jev). */
export async function withTimeout<T>(p: Promise<T>, ms = JEV_AUTO_TIMEOUT_MS): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((r) => {
    timer = setTimeout(() => r(undefined), ms);
  });
  try {
    return await Promise.race([p.catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function answer(answers: JevAnswer[], name: string): JevAnswer | undefined {
  const a = answers.find((x) => x.name === name);
  return a && !a.missing ? a : undefined;
}

/** noul decisivo: 'yes' acima de NOUL_DECISIVE, 'no' abaixo de 1 - NOUL_DECISIVE, senão 'unsure'. */
export function noulVerdict(a: JevAnswer | undefined): 'yes' | 'no' | 'unsure' {
  if (a?.noul === undefined) {
    return 'unsure';
  }
  return a.noul >= NOUL_DECISIVE ? 'yes' : a.noul <= 1 - NOUL_DECISIVE ? 'no' : 'unsure';
}

/** Opção mais provável de choice/score com probabilidades e confiança ≥ JEV_LOW_CONFIDENCE; senão undefined. */
function confidentTop(a: JevAnswer | undefined): { key: string; confidence: number } | undefined {
  const probs = a?.probabilities;
  if (!a || !probs || !Object.keys(probs).length || a.confidence === undefined || a.confidence < JEV_LOW_CONFIDENCE) {
    return undefined;
  }
  const key = a.type === 'choice' && a.choice ? a.choice : Object.entries(probs).sort((x, y) => y[1] - x[1])[0][0];
  return { key, confidence: a.confidence };
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

// ---------- 1. Modelo e effort do agente novo ----------

export const ROUTE_MODELS: Record<string, string> = {
  haiku: 'busca, leitura, levantamento de arquivos, resumo, vigia ou tarefa mecânica sem decisões no meio',
  sonnet: 'edição de código rotineira, testes, documentação, ajuste de interface, integração',
  opus: 'código difícil, depuração com causa incerta, projeto de solução ou revisão crítica',
  fable: 'trabalho longo, arquitetural ou muito difícil, com muitas decisões encadeadas',
};

export const ROUTE_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;

export interface RouteInput {
  description: string;
  prompt: string;
  model?: string;
  effort?: string;
}

export function routingState(input: RouteInput): string {
  return [`Tarefa de um agente de programação: ${input.description.trim()}`, '', clipMiddle(input.prompt, 6000)].join('\n');
}

export function routingQuestions(): JevQuestions {
  return {
    model: {
      type: 'choice',
      instructions: 'Qual é o modelo mais barato que ainda faz esta tarefa bem? Do mais barato ao mais caro: haiku, sonnet, opus, fable.',
      criteria: ROUTE_MODELS,
    },
    effort: {
      type: 'score',
      instructions: 'Quanto raciocínio por passo esta tarefa precisa?',
      criteria: ['low: mecânica, poucos passos óbvios', 'medium: rotina com algumas decisões', 'high: difícil, causa incerta ou projeto', 'xhigh: muito difícil e longa'],
    },
  };
}

export interface RouteAdvice {
  /** Aplicar no spawn: só o que o Claude não disse e o Jev respondeu com confiança. */
  model?: string;
  effort?: string;
  /** Sugestão do Jev que contraria o que o Claude escolheu: vira nota no retorno do spawn, não troca nada. */
  note?: string;
  /** Linha curta para o log ("Jev escolheu haiku (91%), effort low (88%)"). */
  summary?: string;
}

const MODEL_RANK: Record<string, number> = { haiku: 0, sonnet: 1, opus: 2, fable: 3 };

function family(model: string | undefined): string | undefined {
  const m = (model ?? '').toLowerCase();
  return Object.keys(MODEL_RANK).find((f) => m.includes(f));
}

export function readRouting(answers: JevAnswer[], input: RouteInput): RouteAdvice {
  const m = confidentTop(answer(answers, 'model'));
  const e = confidentTop(answer(answers, 'effort'));
  const modelKey = m && MODEL_RANK[m.key] !== undefined ? m.key : undefined;
  const effortKey = e ? ROUTE_EFFORTS[Number(e.key)] : undefined;
  const out: RouteAdvice = {};
  const parts: string[] = [];
  if (modelKey && !input.model) {
    out.model = modelKey;
    parts.push(`modelo ${modelKey} (${pct(m!.confidence)})`);
  }
  if (effortKey && !input.effort) {
    out.effort = effortKey;
    parts.push(`effort ${effortKey} (${pct(e!.confidence)})`);
  }
  if (parts.length) {
    out.summary = `Jev escolheu ${parts.join(', ')}`;
  }
  // Escolha explícita do Claude bem mais cara que a do Jev: só avisa. Dois níveis ou mais (opus → haiku, fable → sonnet).
  const given = family(input.model);
  if (modelKey && given && MODEL_RANK[given] - MODEL_RANK[modelKey] >= 2) {
    out.note = `O Jev acha que ${modelKey} basta para esta tarefa (confiança ${pct(m!.confidence)}); você pediu ${input.model}. Mantive a sua escolha.`;
  }
  return out;
}

// ---------- 2. Agente possivelmente preso ----------

export interface StuckInput {
  description: string;
  /** Chamadas recentes, da mais antiga à mais nova, já resumidas ("Read src/a.ts", "Bash npm test → falhou"). */
  recentCalls: string[];
  /** Motivo do detector ("mesma chamada 4 vezes", "15 min sem progresso"). */
  reason: string;
}

export function stuckState(input: StuckInput): string {
  const calls = input.recentCalls.slice(-20).map((c, i) => `${i + 1}. ${clipMiddle(c, 300)}`);
  return [`Tarefa do agente: ${input.description.trim()}`, `Alerta do detector: ${input.reason}`, '', 'Chamadas recentes, da mais antiga à mais nova:', ...calls].join('\n');
}

export function stuckQuestions(): JevQuestions {
  return {
    progressing: {
      type: 'noul',
      instructions: 'O agente está avançando na tarefa: as chamadas recentes trazem informação nova ou mudam coisas diferentes, em vez de repetir o mesmo passo sem resultado.',
    },
  };
}

/** 'progressing': segura o cartão. 'stuck' ou 'unsure': mostra como antes (a decisão é do usuário). */
export function readStuck(answers: JevAnswer[]): { verdict: 'progressing' | 'stuck' | 'unsure'; summary: string } {
  const a = answer(answers, 'progressing');
  const v = noulVerdict(a);
  const p = a?.noul !== undefined ? ` (P = ${pct(a.noul)})` : '';
  return v === 'yes'
    ? { verdict: 'progressing', summary: `Jev: o agente parece avançar${p}; cartão de preso segurado` }
    : v === 'no'
      ? { verdict: 'stuck', summary: `Jev: o agente parece preso${p}` }
      : { verdict: 'unsure', summary: `Jev incerto sobre o agente preso${p}` };
}

// ---------- 3. Relatório final ----------

export interface ReportInput {
  description: string;
  prompt: string;
  report: string;
}

export function reportState(input: ReportInput): string {
  return [`Tarefa pedida ao agente (${input.description.trim()}):`, clipMiddle(input.prompt, 4000), '', 'Relatório final do agente:', clipMiddle(input.report, 6000)].join('\n');
}

export function reportQuestions(): JevQuestions {
  return {
    delivers: {
      type: 'noul',
      instructions: 'O relatório entrega o que a tarefa pediu, ou explica com clareza por que não deu e o que falta.',
    },
  };
}

/** 'incomplete' só com P(entrega) ≤ 1 - NOUL_DECISIVE; quem integra devolve ao agente uma vez, nunca duas. */
export function readReport(answers: JevAnswer[]): { verdict: 'ok' | 'incomplete' | 'unsure'; summary: string } {
  const a = answer(answers, 'delivers');
  const v = noulVerdict(a);
  const p = a?.noul !== undefined ? ` (P = ${pct(a.noul)})` : '';
  return v === 'no'
    ? { verdict: 'incomplete', summary: `Jev: o relatório não parece responder à tarefa${p}` }
    : { verdict: v === 'yes' ? 'ok' : 'unsure', summary: `Jev: relatório ${v === 'yes' ? 'responde à tarefa' : 'incerto'}${p}` };
}

/** Mensagem que volta ao agente quando o relatório não passa. */
export function reportBounceMessage(): string {
  return 'Antes de entregar: uma checagem automática achou que o seu relatório não responde ao que a tarefa pediu. Releia o pedido original e complete o que faltar, ou diga com clareza por que não deu. Esta checagem só acontece uma vez.';
}

// ---------- 4. Proposta de vigia ----------

export interface ProposalInput {
  proposal: string;
  /** Propostas já feitas por este vigia (as mais recentes). */
  previous: string[];
}

export function proposalState(input: ProposalInput): string {
  const prev = input.previous.slice(-15).map((p, i) => `${i + 1}. ${clipMiddle(p, 300)}`);
  return [
    'Um vigia leu mensagens de terceiros e propõe uma tarefa para o usuário.',
    '',
    'Proposta nova:',
    clipMiddle(input.proposal, 3000),
    '',
    prev.length ? 'Propostas anteriores do mesmo vigia:' : 'Nenhuma proposta anterior.',
    ...prev,
  ].join('\n');
}

export function proposalQuestions(hasPrevious: boolean): JevQuestions {
  return {
    isTask: { type: 'noul', instructions: 'A proposta nova é um pedido ou tarefa de verdade dirigida ao usuário, que ele precisa fazer ou responder.' },
    ...(hasPrevious ? { duplicate: { type: 'noul' as const, instructions: 'A proposta nova repete o mesmo pedido de uma das propostas anteriores.' } } : {}),
  };
}

/** 'drop' só com resposta decisiva; quem integra registra a proposta segurada no log, não some com ela. */
export function readProposal(answers: JevAnswer[]): { verdict: 'pass' | 'drop'; summary: string } {
  const dup = answer(answers, 'duplicate');
  const task = answer(answers, 'isTask');
  if (noulVerdict(dup) === 'yes') {
    return { verdict: 'drop', summary: `Jev: repete uma proposta anterior (P = ${pct(dup!.noul!)}); proposta segurada` };
  }
  if (noulVerdict(task) === 'no') {
    return { verdict: 'drop', summary: `Jev: não parece tarefa do usuário (P = ${pct(task!.noul!)}); proposta segurada` };
  }
  return { verdict: 'pass', summary: 'Jev: proposta liberada' };
}

// ---------- Medição ----------

export interface LatencyStats {
  n: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export function latencyStats(samples: number[]): LatencyStats | undefined {
  const s = samples.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (!s.length) {
    return undefined;
  }
  const q = (p: number) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
  return { n: s.length, meanMs: Math.round(s.reduce((a, b) => a + b, 0) / s.length), p50Ms: q(0.5), p95Ms: q(0.95), maxMs: s[s.length - 1] };
}

