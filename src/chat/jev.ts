/**
 * Jev (System One da TypeSafe AI): modelo de decisão que não escreve texto. Recebe um `state` e perguntas tipadas
 * (noul, score, choice) e devolve probabilidades calibradas. Aqui fica a lógica pura da ferramenta jev_decide:
 * montar o corpo, chamar com novas tentativas, ler a resposta, formatar as probabilidades e contar o custo.
 * Sem VS Code e sem rede própria (o fetch é injetado), para testar com node.
 *
 * Formatos conferidos em 2026-10-15:
 * - docs.typesafe.ai/primitives/score: `criteria` é lista ordenada de 2 a 10 níveis; a resposta traz `score`
 *   (soma nível vezes probabilidade), `legend` e `probabilities` com o índice do nível em texto ("0", "1"...) e `confidence`.
 * - docs.typesafe.ai/primitives/choice: `criteria` é objeto opção → descrição (null quando o nome basta), até 255
 *   opções; a resposta traz `choice`, `probabilities` por opção e `confidence`.
 * - docs.typesafe.ai/confidence: noul não tem `confidence`; a própria probabilidade carrega a incerteza.
 * - vercel.com/docs/ai-gateway/sdks-and-apis/typesafe: mesmo formato em https://ai-gateway.vercel.sh/typesafe,
 *   modelo "typesafe-ai/jev", chave do AI Gateway; a resposta traz o custo em provider_metadata.gateway.cost.
 */

export type JevProvider = 'typesafe' | 'vercel';

export const JEV_PROVIDER_LABEL: Record<JevProvider, string> = { typesafe: 'TypeSafe', vercel: 'Vercel AI Gateway' };

const BASE_URL: Record<JevProvider, string> = {
  typesafe: 'https://api.typesafe.ai',
  vercel: 'https://ai-gateway.vercel.sh/typesafe',
};

export const JEV_MODEL: Record<JevProvider, string> = { typesafe: 'jev-latest', vercel: 'typesafe-ai/jev' };

/** Preço do Jev por milhão de tokens (2026-10): entrada US$ 0,042, saída grátis. */
export const JEV_INPUT_USD_PER_MTOK = 0.042;
export const JEV_OUTPUT_USD_PER_MTOK = 0;

/** Abaixo disso a resposta vem marcada como incerta: o Claude decide sozinho ou consulta o advisor. */
export const JEV_LOW_CONFIDENCE = 0.7;

export const MAX_SCORE_LEVELS = 10;
export const MAX_CHOICE_OPTIONS = 255;
/** Limite nosso, não da API: cada pergunta é avaliada em paralelo, e uma consulta com dezenas vira lista ilegível. */
export const MAX_QUESTIONS = 32;

/** Novas tentativas em 429, 529 e 5xx, com espera de 0,5 s dobrando até 5 s (ou o retry-after, até 30 s). */
export const JEV_RETRIES = 2;
const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 5000;
const RETRY_AFTER_MAX_MS = 30_000;
const TIMEOUT_MS = 60_000;

export type JevQuestionType = 'noul' | 'score' | 'choice';

/** Pergunta como o Claude manda na ferramenta. score: lista de níveis, do menor ao maior; choice: opções. */
export interface JevQuestionInput {
  type: JevQuestionType;
  instructions: string;
  criteria?: string[] | Record<string, string | null>;
}

export type JevQuestions = Record<string, JevQuestionInput>;

/**
 * Pergunta como chega na ferramenta jev_decide: lista com nome, sem objetos de chave livre. z.record quebra a
 * conversão de schema do SDK e derruba o servidor "agents" inteiro (o mesmo motivo de lab/tools.ts).
 */
export interface JevQuestionListItem {
  name: string;
  type: JevQuestionType;
  instructions: string;
  /** score: níveis do menor ao maior. choice: nomes das opções (quando a descrição não importa). */
  criteria?: string[];
  /** choice: opções com descrição. */
  options?: { name: string; description?: string }[];
}

/** Lista da ferramenta → JevQuestions. Nome repetido: vale o último. */
export function questionsFromList(list: JevQuestionListItem[]): JevQuestions {
  const out: JevQuestions = {};
  for (const q of list ?? []) {
    const name = q?.name?.trim();
    if (!name) {
      continue;
    }
    const base = { type: q.type, instructions: q.instructions };
    if (q.type === 'choice' && q.options?.length) {
      out[name] = { ...base, criteria: Object.fromEntries(q.options.filter((o) => o?.name?.trim()).map((o) => [o.name.trim(), o.description?.trim() || null])) };
    } else {
      out[name] = q.criteria ? { ...base, criteria: q.criteria } : base;
    }
  }
  return out;
}

/** Confere as perguntas antes de gastar uma chamada. Devolve o erro em português ou undefined. */
export function checkQuestions(state: string, questions: JevQuestions): string | undefined {
  if (!state.trim()) {
    return 'state está vazio: descreva a situação que o Jev vai avaliar.';
  }
  const names = Object.keys(questions ?? {});
  if (!names.length) {
    return 'questions está vazio: mande pelo menos uma pergunta.';
  }
  if (names.length > MAX_QUESTIONS) {
    return `${names.length} perguntas numa consulta; o máximo aqui é ${MAX_QUESTIONS}.`;
  }
  for (const name of names) {
    const q = questions[name];
    if (!q?.instructions?.trim()) {
      return `A pergunta "${name}" está sem instructions.`;
    }
    if (q.type === 'score') {
      const levels = Array.isArray(q.criteria) ? q.criteria : undefined;
      if (!levels || levels.length < 2 || levels.length > MAX_SCORE_LEVELS) {
        return `A pergunta "${name}" (score) precisa de criteria com 2 a ${MAX_SCORE_LEVELS} níveis numa lista, do menor ao maior.`;
      }
    } else if (q.type === 'choice') {
      const options = choiceCriteria(q.criteria);
      const count = Object.keys(options).length;
      if (count < 2 || count > MAX_CHOICE_OPTIONS) {
        return `A pergunta "${name}" (choice) precisa de criteria com 2 a ${MAX_CHOICE_OPTIONS} opções (objeto opção → descrição, ou lista de nomes).`;
      }
    } else if (q.type !== 'noul') {
      return `A pergunta "${name}" tem tipo "${String((q as { type?: unknown }).type)}"; use noul, score ou choice.`;
    }
  }
  return undefined;
}

/** choice aceita lista de nomes por conveniência; a API quer objeto opção → descrição (null quando o nome basta). */
function choiceCriteria(criteria: JevQuestionInput['criteria']): Record<string, string | null> {
  if (Array.isArray(criteria)) {
    return Object.fromEntries(criteria.filter((o) => typeof o === 'string' && o.trim()).map((o) => [o.trim(), null]));
  }
  return criteria && typeof criteria === 'object' ? criteria : {};
}

export interface JevRequest {
  url: string;
  body: { model: string; state: string; questions: Record<string, { type: JevQuestionType; instructions: string; criteria?: unknown }> };
}

export function buildRequest(provider: JevProvider, state: string, questions: JevQuestions): JevRequest {
  const out: JevRequest['body']['questions'] = {};
  for (const [name, q] of Object.entries(questions)) {
    const base = { type: q.type, instructions: q.instructions.trim() };
    out[name] = q.type === 'score' ? { ...base, criteria: q.criteria } : q.type === 'choice' ? { ...base, criteria: choiceCriteria(q.criteria) } : base;
  }
  return { url: `${BASE_URL[provider]}/v1/systemone`, body: { model: JEV_MODEL[provider], state, questions: out } };
}

export function modelsUrl(provider: JevProvider): string {
  return `${BASE_URL[provider]}/v1/models`;
}

// ---------- Resposta ----------

export interface JevAnswer {
  name: string;
  type: JevQuestionType;
  /** noul: probabilidade de sim. */
  noul?: number;
  /** choice: opção mais provável. */
  choice?: string;
  /** score: nível esperado (soma nível vezes probabilidade), de 0 ao último índice. */
  score?: number;
  /** choice: por opção; score: por índice do nível em texto ("0", "1"...). */
  probabilities?: Record<string, number>;
  /** score: índice → descrição do nível. */
  legend?: Record<string, string>;
  confidence?: number;
  /** A resposta não trouxe esta pergunta. */
  missing?: boolean;
}

export interface JevUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface JevCost {
  tokens: number;
  usd: number;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);

function numRecord(v: unknown): Record<string, number> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return undefined;
  }
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const n = num(x);
    if (n !== undefined) {
      out[k] = n;
    }
  }
  return out;
}

function textRecord(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object') {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    out[k] = typeof x === 'string' ? x : x && typeof x === 'object' && typeof (x as { what?: unknown }).what === 'string' ? (x as { what: string }).what : JSON.stringify(x);
  }
  return out;
}

/** Lê as respostas na ordem das perguntas. Campo que faltar fica ausente; pergunta sem resposta vem com missing. */
export function readAnswers(json: unknown, questions: JevQuestions): JevAnswer[] {
  const answers = ((json ?? {}) as { answers?: Record<string, unknown> }).answers ?? {};
  return Object.entries(questions).map(([name, q]): JevAnswer => {
    const a = answers[name] as Record<string, unknown> | undefined;
    if (!a || typeof a !== 'object') {
      return { name, type: q.type, missing: true };
    }
    const type = (typeof a.type === 'string' ? a.type : q.type) as JevQuestionType;
    // Legenda do score: a da resposta, senão a montada com os níveis que mandamos.
    const legend =
      textRecord(a.legend) ?? (type === 'score' && Array.isArray(q.criteria) ? Object.fromEntries(q.criteria.map((c, i) => [String(i), typeof c === 'string' ? c : JSON.stringify(c)])) : undefined);
    return {
      name,
      type,
      noul: num(a.noul),
      choice: typeof a.choice === 'string' ? a.choice : undefined,
      score: num(a.score),
      probabilities: numRecord(a.probabilities),
      legend: type === 'score' ? legend : undefined,
      confidence: num(a.confidence),
    };
  });
}

export function readUsage(json: unknown): JevUsage {
  const u = ((json ?? {}) as { usage?: { input_tokens?: unknown; output_tokens?: unknown } }).usage ?? {};
  return { inputTokens: num(u.input_tokens) ?? 0, outputTokens: num(u.output_tokens) ?? 0 };
}

/** Custo cobrado que o AI Gateway da Vercel informa na resposta; a API da TypeSafe não informa. */
export function gatewayCost(json: unknown): number | undefined {
  const cost = num((json as { provider_metadata?: { gateway?: { cost?: unknown } } } | undefined)?.provider_metadata?.gateway?.cost);
  return cost !== undefined && cost >= 0 ? cost : undefined;
}

/** Tokens e US$ de uma consulta: o custo informado pelo gateway quando vem, senão a tabela de preço. */
export function jevCost(usage: JevUsage, reported?: number): JevCost {
  const usd = reported ?? (usage.inputTokens * JEV_INPUT_USD_PER_MTOK + usage.outputTokens * JEV_OUTPUT_USD_PER_MTOK) / 1_000_000;
  return { tokens: usage.inputTokens + usage.outputTokens, usd };
}

// ---------- Texto devolvido ao modelo ----------

/** 0,97 com vírgula. */
export function fmtProb(p: number): string {
  return p.toFixed(2).replace('.', ',');
}

/** US$ com casas suficientes para o custo de uma consulta, que costuma ficar em milésimos de centavo. */
export function fmtJevUsd(usd: number): string {
  if (usd <= 0) {
    return 'US$ 0';
  }
  const digits = usd >= 0.01 ? 2 : Math.min(8, 1 - Math.floor(Math.log10(usd)));
  return `US$ ${usd.toFixed(digits).replace('.', ',')}`;
}

/** Confiança no estilo das outras perguntas para o noul: |2p - 1| (sugestão de docs.typesafe.ai/confidence). */
export function noulConfidence(p: number): number {
  return Math.abs(2 * p - 1);
}

const LOW = `confiança abaixo de ${fmtProb(JEV_LOW_CONFIDENCE)}: decida por conta própria ou consulte o advisor`;

function clip(text: string, max = 80): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function answerLines(a: JevAnswer, q: JevQuestionInput | undefined): string[] {
  const head = `${a.name}: ${clip(q?.instructions ?? '', 120)}`;
  if (a.missing) {
    return [head, '  sem resposta para esta pergunta'];
  }
  if (a.type === 'noul') {
    if (a.noul === undefined) {
      return [head, '  resposta sem probabilidade'];
    }
    const conf = noulConfidence(a.noul);
    return [head, `  P(sim) = ${fmtProb(a.noul)}${conf < JEV_LOW_CONFIDENCE ? `; ${LOW}` : ''}`];
  }
  const probs = a.probabilities ?? {};
  // Fallback de modelo de linguagem no gateway: confidence 0 e probabilities vazio querem dizer "indisponível".
  if (!Object.keys(probs).length) {
    const picked = a.type === 'choice' ? a.choice : a.score !== undefined ? fmtProb(a.score) : undefined;
    return [head, `  ${picked ? `resposta ${picked}, ` : ''}probabilidades indisponíveis (resposta de um modelo de fallback); trate como incerta`];
  }
  const conf = a.confidence;
  const confText = conf !== undefined ? `confiança ${fmtProb(conf)}${conf < JEV_LOW_CONFIDENCE ? `; ${LOW}` : ''}` : 'sem confiança informada';
  const ranked = Object.entries(probs).sort((x, y) => y[1] - x[1]);
  if (a.type === 'choice') {
    return [head, `  escolha: ${a.choice ?? ranked[0][0]} (${confText})`, `  ${ranked.map(([k, p]) => `${k} ${fmtProb(p)}`).join(' · ')}`];
  }
  const legend = a.legend ?? {};
  const levels = Object.keys(probs).sort((x, y) => Number(x) - Number(y));
  const top = ranked[0][0];
  return [
    head,
    `  nível mais provável: ${top}${legend[top] ? ` "${clip(legend[top], 60)}"` : ''}${a.score !== undefined ? `; nível esperado ${fmtProb(a.score)} numa escala de 0 a ${levels.length - 1}` : ''} (${confText})`,
    ...levels.map((k) => `  ${k}${legend[k] ? ` ${clip(legend[k], 60)}` : ''}: ${fmtProb(probs[k])}`),
  ];
}

export interface JevDecision {
  /** Modelo versionado que respondeu ("jev-1.13.0"). */
  model?: string;
  answers: JevAnswer[];
  usage: JevUsage;
  cost: JevCost;
  requestId?: string;
  /** Tentativas que voltaram com 429/529/5xx antes da resposta. */
  retries: number;
}

export function formatDecision(d: JevDecision, questions: JevQuestions, provider: JevProvider): string {
  return [
    `Jev${d.model ? ` (${d.model})` : ''} via ${JEV_PROVIDER_LABEL[provider]}. É sinal com probabilidade, não ordem: a decisão continua sua.`,
    '',
    ...d.answers.flatMap((a) => [...answerLines(a, questions[a.name]), '']),
    `Custo: ${d.usage.inputTokens.toLocaleString('pt-BR')} tokens de entrada, ${d.usage.outputTokens.toLocaleString('pt-BR')} de saída, ${fmtJevUsd(d.cost.usd)}.${d.retries ? ` ${d.retries} nova(s) tentativa(s) por sobrecarga.` : ''}`,
  ].join('\n');
}

// ---------- Rede ----------

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<FetchResponseLike>;

export class JevError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly requestId?: string,
  ) {
    super(message);
  }

  /** A chave não vale (401) ou não tem acesso ao modelo (403). */
  get invalidKey(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export function shouldRetry(status: number): boolean {
  return status === 429 || status === 529 || status >= 500;
}

/** Espera antes da tentativa `attempt` (0 = primeira nova tentativa). retry-after em segundos ou data HTTP vale primeiro. */
export function retryDelayMs(attempt: number, retryAfter?: string | null, now = Date.now()): number {
  const backoff = Math.min(BACKOFF_START_MS * 2 ** attempt, BACKOFF_MAX_MS);
  const raw = retryAfter?.trim();
  if (raw) {
    const secs = Number(raw);
    const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(raw) - now;
    if (Number.isFinite(ms) && ms >= 0) {
      return Math.min(Math.max(ms, backoff), RETRY_AFTER_MAX_MS);
    }
  }
  return backoff;
}

/** Mensagem legível do corpo de erro ({message}, {error: {message}}, {detail}), sem a chave se ela aparecer. */
export function errorText(status: number, body: string, key?: string): string {
  let detail = '';
  try {
    const j = JSON.parse(body) as { message?: unknown; error?: unknown; detail?: unknown };
    const e = j.error as { message?: unknown } | string | undefined;
    const d = Array.isArray(j.detail) ? j.detail.map((x: { msg?: unknown; loc?: unknown }) => `${Array.isArray(x?.loc) ? `${x.loc.join('.')}: ` : ''}${String(x?.msg ?? '')}`).join('; ') : j.detail;
    detail = String(j.message ?? (typeof e === 'string' ? e : e?.message) ?? d ?? '');
  } catch {
    detail = body.slice(0, 300);
  }
  detail = detail.trim();
  if (key) {
    detail = detail.split(key).join('***');
  }
  const what =
    status === 401
      ? 'chave inválida ou ausente (401)'
      : status === 403
        ? 'a chave não tem acesso ao Jev (403)'
        : status === 422
          ? 'a requisição não passou na validação (422)'
          : status === 429
            ? 'limite de requisições atingido (429)'
            : status === 529
              ? 'o Jev está sobrecarregado (529)'
              : `erro ${status}`;
  return detail ? `${what}: ${detail}` : what;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface CallOptions {
  provider: JevProvider;
  key: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

async function call(opts: CallOptions, url: string, method: 'GET' | 'POST', body?: unknown): Promise<{ json: unknown; requestId?: string; retries: number }> {
  const f = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    let res: FetchResponseLike;
    try {
      res = await f(url, {
        method,
        headers: { Authorization: `Bearer ${opts.key}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout?.(opts.timeoutMs ?? TIMEOUT_MS),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new JevError(`não consegui falar com ${JEV_PROVIDER_LABEL[opts.provider]}: ${opts.key ? msg.split(opts.key).join('***') : msg}`);
    }
    const requestId = res.headers.get('x-typesafe-request-id') ?? undefined;
    const text = await res.text();
    if (res.ok) {
      try {
        return { json: text ? JSON.parse(text) : {}, requestId, retries: attempt };
      } catch {
        throw new JevError(`resposta que não é JSON (${text.slice(0, 120)})`, res.status, requestId);
      }
    }
    if (attempt < JEV_RETRIES && shouldRetry(res.status)) {
      await sleep(retryDelayMs(attempt, res.headers.get('retry-after')));
      continue;
    }
    throw new JevError(errorText(res.status, text, opts.key), res.status, requestId);
  }
}

/** Uma consulta ao Jev. Confira as perguntas com checkQuestions antes. */
export async function jevDecide(opts: CallOptions & { state: string; questions: JevQuestions }): Promise<JevDecision> {
  const req = buildRequest(opts.provider, opts.state, opts.questions);
  const { json, requestId, retries } = await call(opts, req.url, 'POST', req.body);
  const usage = readUsage(json);
  const model = (json as { model?: unknown }).model;
  return {
    model: typeof model === 'string' ? model : undefined,
    answers: readAnswers(json, opts.questions),
    usage,
    cost: jevCost(usage, gatewayCost(json)),
    requestId,
    retries,
  };
}

/** Valida a chave listando os modelos (GET /v1/models). Devolve os nomes; lista vazia ainda conta como chave válida. */
export async function jevListModels(opts: CallOptions): Promise<string[]> {
  const { json } = await call(opts, modelsUrl(opts.provider), 'GET');
  const j = (json ?? {}) as { models?: unknown; data?: unknown };
  const list = Array.isArray(j.models) ? j.models : Array.isArray(j.data) ? j.data : [];
  return list
    .map((m) => (typeof m === 'string' ? m : ((m as { name?: unknown; id?: unknown })?.name ?? (m as { id?: unknown })?.id)))
    .filter((m): m is string => typeof m === 'string');
}
