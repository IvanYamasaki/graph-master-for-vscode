/**
 * Testes da lógica do Jev (jev_decide): corpo da requisição, leitura da resposta, texto das probabilidades, custo e
 * novas tentativas. Sem VS Code e sem rede (fetch falso):
 *   npx esbuild src/chat/jev.test.ts --bundle --platform=node --outfile=$TEMP/jev.test.js && node $TEMP/jev.test.js
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  FetchLike,
  JEV_INPUT_USD_PER_MTOK,
  JevError,
  JevQuestions,
  buildRequest,
  checkQuestions,
  errorText,
  fmtJevUsd,
  formatDecision,
  jevCost,
  jevDecide,
  jevListModels,
  questionsFromList,
  readAnswers,
  retryDelayMs,
  shouldRetry,
} from './jev';
import { budgetLines } from './guard/format';

let failed = 0;
const pending: Promise<void>[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  pending.push(
    (async () => {
      try {
        await fn();
        console.log(`ok   ${name}`);
      } catch (err) {
        failed++;
        console.log(`FALHA ${name}\n${err instanceof Error ? err.stack : String(err)}`);
      }
    })(),
  );
}

const QUESTIONS: JevQuestions = {
  pronto: { type: 'noul', instructions: 'O código está pronto para revisão?' },
  modelo: { type: 'choice', instructions: 'Qual modelo cabe nesta tarefa?', criteria: ['haiku', 'sonnet', 'opus'] },
  risco: { type: 'score', instructions: 'Qual o risco da mudança?', criteria: ['Baixo', 'Médio', 'Alto'] },
};

const ANSWER = {
  model: 'jev-1.13.0',
  answers: {
    pronto: { type: 'noul', noul: 0.97 },
    modelo: { type: 'choice', choice: 'sonnet', confidence: 0.81, probabilities: { haiku: 0.05, sonnet: 0.88, opus: 0.07 } },
    risco: { type: 'score', score: 1.43, confidence: 0.35, legend: { '0': 'Baixo', '1': 'Médio', '2': 'Alto' }, probabilities: { '0': 0, '1': 0.57, '2': 0.43 } },
  },
  usage: { input_tokens: 296, output_tokens: 20 },
};

/** fetch falso: devolve as respostas em ordem e guarda as chamadas. */
function fakeFetch(responses: { status: number; body: unknown; headers?: Record<string, string> }[]) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: unknown }[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null },
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
    };
  };
  return { f, calls };
}

test('corpo: TypeSafe e Vercel, choice em lista vira objeto, score mantém a lista', () => {
  const t = buildRequest('typesafe', 'estado', QUESTIONS);
  assert.equal(t.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(t.body.model, 'jev-latest');
  assert.deepEqual(t.body.questions.pronto, { type: 'noul', instructions: 'O código está pronto para revisão?' });
  assert.deepEqual(t.body.questions.modelo.criteria, { haiku: null, sonnet: null, opus: null });
  assert.deepEqual(t.body.questions.risco.criteria, ['Baixo', 'Médio', 'Alto']);
  const v = buildRequest('vercel', 'estado', QUESTIONS);
  assert.equal(v.url, 'https://ai-gateway.vercel.sh/typesafe/v1/systemone');
  assert.equal(v.body.model, 'typesafe-ai/jev');
  // choice já em objeto passa como está, com descrições.
  const o = buildRequest('typesafe', 's', { d: { type: 'choice', instructions: 'Time?', criteria: { billing: 'Cobrança', technical: null } } });
  assert.deepEqual(o.body.questions.d.criteria, { billing: 'Cobrança', technical: null });
});

test('checkQuestions recusa estado vazio, score fora de 2 a 10 e choice com uma opção', () => {
  assert.equal(checkQuestions('s', QUESTIONS), undefined);
  assert.match(checkQuestions('  ', QUESTIONS) ?? '', /state/);
  assert.match(checkQuestions('s', {}) ?? '', /questions/);
  assert.match(checkQuestions('s', { a: { type: 'score', instructions: 'x', criteria: ['só um'] } }) ?? '', /2 a 10/);
  assert.match(checkQuestions('s', { a: { type: 'score', instructions: 'x', criteria: Array.from({ length: 11 }, (_, i) => String(i)) } }) ?? '', /2 a 10/);
  assert.match(checkQuestions('s', { a: { type: 'choice', instructions: 'x', criteria: ['a'] } }) ?? '', /choice/);
  assert.match(checkQuestions('s', { a: { type: 'noul', instructions: ' ' } }) ?? '', /instructions/);
});

test('respostas na ordem das perguntas; a que falta vem marcada', () => {
  const a = readAnswers({ answers: { modelo: ANSWER.answers.modelo } }, QUESTIONS);
  assert.deepEqual(a.map((x) => x.name), ['pronto', 'modelo', 'risco']);
  assert.equal(a[0].missing, true);
  assert.equal(a[1].choice, 'sonnet');
  // Score sem legend na resposta: monta com os níveis que mandamos.
  const s = readAnswers({ answers: { risco: { type: 'score', score: 0.2, confidence: 0.9, probabilities: { '0': 0.8, '1': 0.2, '2': 0 } } } }, QUESTIONS)[2];
  assert.deepEqual(s.legend, { '0': 'Baixo', '1': 'Médio', '2': 'Alto' });
});

test('texto: probabilidades, confiança baixa marcada, custo', () => {
  const usage = { inputTokens: 296, outputTokens: 20 };
  const text = formatDecision({ model: 'jev-1.13.0', answers: readAnswers(ANSWER, QUESTIONS), usage, cost: jevCost(usage), retries: 0 }, QUESTIONS, 'typesafe');
  assert.match(text, /Jev \(jev-1\.13\.0\) via TypeSafe/);
  assert.match(text, /P\(sim\) = 0,97\n/);
  assert.match(text, /escolha: sonnet \(confiança 0,81\)/);
  assert.match(text, /sonnet 0,88 · opus 0,07 · haiku 0,05/);
  assert.match(text, /nível mais provável: 1 "Médio"; nível esperado 1,43 numa escala de 0 a 2 \(confiança 0,35; confiança abaixo de 0,70/);
  assert.match(text, / {2}2 Alto: 0,43/);
  assert.match(text, /296 tokens de entrada/);
  // noul perto de 0,5 é incerto: |2p - 1| < 0,7.
  const unsure = formatDecision({ answers: [{ name: 'pronto', type: 'noul', noul: 0.6 }], usage, cost: jevCost(usage), retries: 0 }, QUESTIONS, 'vercel');
  assert.match(unsure, /P\(sim\) = 0,60; confiança abaixo/);
  // Fallback de LLM no gateway: probabilities vazio.
  const fb = formatDecision({ answers: [{ name: 'modelo', type: 'choice', choice: 'opus', confidence: 0, probabilities: {} }], usage, cost: jevCost(usage), retries: 0 }, QUESTIONS, 'vercel');
  assert.match(fb, /resposta opus, probabilidades indisponíveis/);
});

test('custo: preço da constante, saída grátis; custo do gateway vale primeiro', () => {
  const c = jevCost({ inputTokens: 1_000_000, outputTokens: 500 });
  assert.equal(c.tokens, 1_000_500);
  assert.ok(Math.abs(c.usd - JEV_INPUT_USD_PER_MTOK) < 1e-12);
  assert.equal(jevCost({ inputTokens: 275, outputTokens: 20 }, 0.00001155).usd, 0.00001155);
  assert.equal(fmtJevUsd(0.0000124), 'US$ 0,000012');
  assert.equal(fmtJevUsd(0.5), 'US$ 0,50');
});

test('gasto do agente: linha do Jev no resumo de orçamento', () => {
  const lines = budgetLines({ spent: { tokens: 12_000, minutes: 1, usd: 0.5, jev: { tokens: 900, usd: 0.0000378, calls: 3 } } });
  assert.ok(lines.includes('Jev: 3 consultas, 900 tokens, US$ 0,000038'), lines.join(' | '));
  assert.ok(!budgetLines({ spent: { tokens: 1, minutes: 0 } }).some((l) => l.startsWith('Jev')));
});

test('backoff: 0,5 s dobrando até 5 s; retry-after em segundos ou data vale primeiro, até 30 s', () => {
  assert.equal(retryDelayMs(0), 500);
  assert.equal(retryDelayMs(1), 1000);
  assert.equal(retryDelayMs(5), 5000);
  assert.equal(retryDelayMs(0, '3'), 3000);
  assert.equal(retryDelayMs(0, '120'), 30_000);
  assert.equal(retryDelayMs(1, '0'), 1000);
  const now = Date.parse('2026-10-15T12:00:00Z');
  assert.equal(retryDelayMs(0, 'Thu, 15 Oct 2026 12:00:02 GMT', now), 2000);
  assert.equal(retryDelayMs(0, 'lixo'), 500);
  assert.ok(shouldRetry(429) && shouldRetry(529) && shouldRetry(503));
  assert.ok(!shouldRetry(401) && !shouldRetry(422));
});

test('erro: mensagem do corpo, sem a chave', () => {
  assert.equal(errorText(422, JSON.stringify({ message: "questions.a.type: expected one of 'noul'", error_type: 'invalid_request' })), "a requisição não passou na validação (422): questions.a.type: expected one of 'noul'");
  assert.equal(errorText(401, '{"error":{"message":"bad key sk-123"}}', 'sk-123'), 'chave inválida ou ausente (401): bad key ***');
  assert.equal(errorText(500, ''), 'erro 500');
});

test('jevDecide: Bearer, corpo e leitura completa', async () => {
  const { f, calls } = fakeFetch([{ status: 200, body: ANSWER, headers: { 'x-typesafe-request-id': 'req_1' } }]);
  const d = await jevDecide({ provider: 'typesafe', key: 'k-segredo', state: 'estado', questions: QUESTIONS, fetch: f, sleep: async () => undefined });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.Authorization, 'Bearer k-segredo');
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.equal((calls[0].body as { state: string }).state, 'estado');
  assert.equal(d.model, 'jev-1.13.0');
  assert.equal(d.requestId, 'req_1');
  assert.equal(d.usage.inputTokens, 296);
  assert.equal(d.answers[0].noul, 0.97);
  assert.equal(d.retries, 0);
});

test('jevDecide: tenta de novo 2x em 529/429 e respeita retry-after', async () => {
  const waits: number[] = [];
  const { f, calls } = fakeFetch([
    { status: 529, body: { message: 'overloaded' } },
    { status: 429, body: { message: 'slow down' }, headers: { 'retry-after': '2' } },
    { status: 200, body: ANSWER },
  ]);
  const d = await jevDecide({ provider: 'vercel', key: 'k', state: 's', questions: QUESTIONS, fetch: f, sleep: async (ms) => void waits.push(ms) });
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [500, 2000]);
  assert.equal(d.retries, 2);
  // Terceira falha seguida: desiste com o erro da última.
  const again = fakeFetch([{ status: 503, body: { message: 'down' } }]);
  await assert.rejects(
    jevDecide({ provider: 'typesafe', key: 'k', state: 's', questions: QUESTIONS, fetch: again.f, sleep: async () => undefined }),
    (err: unknown) => err instanceof JevError && err.status === 503 && /down/.test(err.message),
  );
  assert.equal(again.calls.length, 3);
});

test('jevDecide: 401 não repete e marca chave inválida', async () => {
  const { f, calls } = fakeFetch([{ status: 401, body: { message: 'invalid api key' } }]);
  await assert.rejects(
    jevDecide({ provider: 'typesafe', key: 'k', state: 's', questions: QUESTIONS, fetch: f, sleep: async () => undefined }),
    (err: unknown) => err instanceof JevError && err.invalidKey,
  );
  assert.equal(calls.length, 1);
});

test('jevDecide: custo do gateway da Vercel', async () => {
  const { f } = fakeFetch([{ status: 200, body: { ...ANSWER, provider_metadata: { gateway: { cost: '0.00001155' } } } }]);
  const d = await jevDecide({ provider: 'vercel', key: 'k', state: 's', questions: QUESTIONS, fetch: f });
  assert.equal(d.cost.usd, 0.00001155);
});

test('jevListModels: GET /v1/models com "models" ou "data"', async () => {
  const a = fakeFetch([{ status: 200, body: { models: [{ name: 'jev-latest' }, { name: 'jev-1.13.0' }] } }]);
  assert.deepEqual(await jevListModels({ provider: 'typesafe', key: 'k', fetch: a.f }), ['jev-latest', 'jev-1.13.0']);
  assert.equal(a.calls[0].url, 'https://api.typesafe.ai/v1/models');
  assert.equal(a.calls[0].method, 'GET');
  assert.equal(a.calls[0].headers['Content-Type'], undefined);
  const b = fakeFetch([{ status: 200, body: { data: [{ id: 'typesafe-ai/jev' }] } }]);
  assert.deepEqual(await jevListModels({ provider: 'vercel', key: 'k', fetch: b.f }), ['typesafe-ai/jev']);
  assert.equal(b.calls[0].url, 'https://ai-gateway.vercel.sh/typesafe/v1/models');
});

test('questionsFromList converte a lista da ferramenta', () => {
  const q = questionsFromList([
    { name: 'pronto', type: 'noul', instructions: 'Pronto?' },
    { name: 'modelo', type: 'choice', instructions: 'Qual?', options: [{ name: 'haiku', description: 'barato' }, { name: 'opus' }] },
    { name: 'nomes', type: 'choice', instructions: 'Qual?', criteria: ['a', 'b'] },
    { name: 'risco', type: 'score', instructions: 'Risco?', criteria: ['Baixo', 'Alto'] },
    { name: ' ', type: 'noul', instructions: 'sem nome' },
  ]);
  assert.deepEqual(Object.keys(q), ['pronto', 'modelo', 'nomes', 'risco']);
  assert.deepEqual(q.modelo.criteria, { haiku: 'barato', opus: null });
  assert.deepEqual(q.nomes.criteria, ['a', 'b']);
  assert.equal(q.pronto.criteria, undefined);
  assert.equal(checkQuestions('s', q), undefined);
  assert.deepEqual(buildRequest('typesafe', 's', q).body.questions.nomes.criteria, { a: null, b: null });
});

// z.record (e z.map) quebram a conversão de schema do SDK: o tools/list falha e o servidor "agents" some da sessão
// inteira, sem erro visível. Aconteceu com a jev_decide em 2026-10-15.
test('nenhum código da extensão usa z.record ou z.map em schema de ferramenta', () => {
  const root = path.resolve(process.cwd(), 'src');
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) {
        fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
          if (/z\.(record|map)\(/.test(line) && !line.trim().startsWith('//')) {
            hits.push(`${path.relative(root, p)}:${i + 1}`);
          }
        });
      }
    }
  };
  walk(root);
  assert.deepEqual(hits, []);
});

void Promise.all(pending).then(() => {
  if (failed) {
    console.log(`\n${failed} teste(s) falharam`);
    process.exit(1);
  }
  console.log('\ntodos passaram');
});
