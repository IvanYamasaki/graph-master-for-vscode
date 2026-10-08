/**
 * Testes do modelo de posts e threads dos agentes. Sem VS Code:
 *   npx esbuild src/chat/threadModel.test.ts --bundle --platform=node --outfile=$TEMP/threadModel.test.js && node $TEMP/threadModel.test.js
 */
import * as assert from 'node:assert/strict';
import {
  MAX_MESSAGE_CHARS,
  MAX_THREAD_MESSAGES,
  addReport,
  appendMessage,
  applyHistorySummaries,
  applyPostSummary,
  authorInitials,
  authorName,
  clockLabel,
  consultPrompt,
  consultToolLabel,
  emptyThread,
  lastReplyLabel,
  latestPost,
  migrateLegacy,
  participants,
  postsOf,
  relativeTime,
  replyCount,
  splitPostBlocks,
  threadFooter,
  threadsFromStore,
  threadsToStore,
  type AgentPost,
} from './threadModel';

let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n     ${err instanceof Error ? err.message : String(err)}`);
  }
}

const MIN = 60_000;
const NOW = new Date(2026, 9, 8, 15, 0, 0).getTime();
const P3: AgentPost = { id: 'a3#1', agentId: 'a3', n: 1, at: NOW - 60 * MIN, report: 'Resumo: li tudo.' };

/** Posts de vários relatórios, como o host monta. */
function reports(...list: [string, string, number][]): AgentPost[] {
  let posts: AgentPost[] = [];
  for (const [agentId, report, at] of list) {
    posts = addReport(posts, { agentId, report, at }).posts;
  }
  return posts;
}

test('tempo relativo: agora, minutos, horas, ontem, dias e data', () => {
  assert.equal(relativeTime(NOW - 10_000, NOW), 'agora');
  assert.equal(relativeTime(NOW - 2 * MIN, NOW), 'há 2 min');
  assert.equal(relativeTime(NOW - 59 * MIN, NOW), 'há 59 min');
  assert.equal(relativeTime(NOW - 3 * 60 * MIN, NOW), 'há 3 h');
  assert.equal(relativeTime(NOW - 30 * 60 * MIN, NOW), 'ontem');
  assert.equal(relativeTime(NOW - 4 * 24 * 60 * MIN, NOW), 'há 4 dias');
  assert.match(relativeTime(NOW - 10 * 24 * 60 * MIN, NOW), /^\d\d\/\d\d$/);
  assert.equal(relativeTime(NOW + 5 * MIN, NOW), 'agora');
});

test('hora do post e da última resposta como no Slack', () => {
  assert.equal(clockLabel(new Date(2026, 9, 8, 10, 57).getTime()), '10h57');
  assert.equal(clockLabel(new Date(2026, 9, 8, 9, 5).getTime()), '9h05');
  assert.equal(lastReplyLabel(new Date(2026, 9, 8, 14, 24).getTime(), NOW), 'Última resposta hoje às 14h24');
  // Ontem pelo calendário, mesmo com menos de 24 h.
  assert.equal(lastReplyLabel(new Date(2026, 9, 7, 23, 50).getTime(), NOW), 'Última resposta ontem às 23h50');
  assert.equal(lastReplyLabel(new Date(2026, 9, 5, 12, 0).getTime(), NOW), 'Última resposta há 3 dias');
});

test('rodapé: plural, singular e thread vazia', () => {
  let t = emptyThread(P3);
  assert.equal(threadFooter(t, NOW), undefined);
  assert.equal(threadFooter(undefined, NOW), undefined);
  t = appendMessage(t, { from: 'user', text: 'oi', at: NOW - 5 * MIN });
  assert.deepEqual(threadFooter(t, NOW), { count: '1 resposta', last: `Última resposta hoje às ${clockLabel(NOW - 5 * MIN)}` });
  t = appendMessage(t, { from: 'agent', text: 'resposta', at: NOW - 3 * MIN });
  t = appendMessage(t, { from: 'user', text: 'e agora?', at: NOW - 2 * MIN });
  assert.equal(replyCount(t), 3);
  assert.equal(threadFooter(t, NOW)?.count, '3 respostas');
});

test('appendMessage não muda a thread de entrada, gera ids únicos e corta o excesso', () => {
  const t0 = emptyThread(P3);
  const t1 = appendMessage(t0, { from: 'user', text: 'x', at: NOW });
  const t2 = appendMessage(t1, { from: 'agent', text: 'y', at: NOW });
  assert.equal(t0.messages.length, 0);
  assert.notEqual(t2.messages[0].id, t2.messages[1].id);
  let t = appendMessage(t0, { from: 'agent', text: 'z'.repeat(MAX_MESSAGE_CHARS + 50), at: NOW });
  assert.equal(t.messages[0].text.length, MAX_MESSAGE_CHARS);
  for (let i = 0; i < MAX_THREAD_MESSAGES + 5; i++) {
    t = appendMessage(t, { from: 'user', text: String(i), at: NOW + i });
  }
  assert.equal(t.messages.length, MAX_THREAD_MESSAGES);
});

test('participantes, iniciais e nomes: Você e o agente pelo nome dele', () => {
  let t = emptyThread(P3);
  t = appendMessage(t, { from: 'user', text: '1', at: 1 });
  t = appendMessage(t, { from: 'agent', text: '2', at: 2 });
  t = appendMessage(t, { from: 'user', text: '3', at: 3 });
  assert.deepEqual(participants(t), ['user', 'agent']);
  assert.deepEqual(participants(t, 1), ['user']);
  assert.equal(authorInitials('agent', 'a12'), 'a12');
  assert.equal(authorInitials('user', 'a12'), 'Eu');
  assert.equal(authorName('user', 'a3', 'Bancada'), 'Você');
  assert.equal(authorName('agent', 'a3', 'Bancada'), 'Bancada');
  assert.equal(authorName('agent', 'a3'), 'Agente a3');
});

test('cada relatório vira um post numerado por agente, na ordem da entrega', () => {
  const posts = reports(['a3', 'primeiro', 1000], ['a5', 'outro', 2000], ['a3', 'segundo', 3000]);
  assert.deepEqual(posts.map((p) => p.id), ['a3#1', 'a5#1', 'a3#2']);
  assert.deepEqual(postsOf(posts, 'a3').map((p) => p.report), ['primeiro', 'segundo']);
  assert.equal(latestPost(posts, 'a3')?.id, 'a3#2');
  assert.equal(latestPost(posts, 'a9'), undefined);
});

test('o mesmo relatório gravado de novo não duplica o post', () => {
  let posts = reports(['a3', 'relatório', 1000]);
  // Mesma hora de entrega (agente restaurado) e o mesmo texto entregue a dois destinos logo em seguida.
  assert.equal(addReport(posts, { agentId: 'a3', report: 'relatório', at: 1000 }).added, undefined);
  assert.equal(addReport(posts, { agentId: 'a3', report: 'relatório', at: 1050 }).added, undefined);
  // Mesmo texto muito depois é outro relatório (agente retomado que repetiu a conclusão).
  posts = addReport(posts, { agentId: 'a3', report: 'relatório', at: 1000 + 10 * MIN }).posts;
  assert.equal(postsOf(posts, 'a3').length, 2);
  assert.equal(addReport(posts, { agentId: 'a3', report: '  ', at: 9e9 }).added, undefined);
});

test('texto do orquestrador vai ao post mais recente sem resumo, sem passar por cima de um resumido', () => {
  let posts = reports(['a3', 'r1', 1000], ['a3', 'r2', 2000]);
  let r = applyPostSummary(posts, 'a3', 'Terminei o segundo.');
  assert.equal(r.changed?.id, 'a3#2');
  posts = r.posts;
  // O último já tem texto: um bloco a mais não volta para o relatório antigo.
  r = applyPostSummary(posts, 'a3', 'Outro bloco.');
  assert.equal(r.changed, undefined);
  assert.equal(postsOf(r.posts, 'a3')[0].summary, undefined);
  // Dois relatórios seguidos sem resumo: o primeiro bloco vai ao mais recente.
  posts = reports(['a4', 'r1', 1000], ['a4', 'r2', 2000]);
  assert.equal(applyPostSummary(posts, 'a4', 'x').changed?.id, 'a4#2');
  assert.equal(applyPostSummary(posts, 'a9', 'x').changed, undefined);
});

test('bloco <post>: sai do texto mostrado e vira resumo do agente', () => {
  const r = splitPostBlocks('<post agent="a3">Li as 84 calls. Três sem transcrição.</post>\n\nVou pedir a lista ao a4.');
  assert.deepEqual(r.blocks, [{ agentId: 'a3', text: 'Li as 84 calls. Três sem transcrição.' }]);
  assert.equal(r.text, 'Vou pedir a lista ao a4.');
  const two = splitPostBlocks("Antes.\n<post agent='a1'>um</post>\n<POST agent=a2 >dois\nlinhas</post>\nDepois.");
  assert.deepEqual(two.blocks.map((b) => [b.agentId, b.text]), [['a1', 'um'], ['a2', 'dois\nlinhas']]);
  assert.equal(two.text, 'Antes.\n\nDepois.');
  const plain = 'Nada de bloco aqui, nem a < b.';
  assert.equal(splitPostBlocks(plain).text, plain);
});

test('bloco <post> em streaming: o pedaço aberto não aparece', () => {
  assert.equal(splitPostBlocks('<post agent="a3">Li as 84').text, '');
  assert.equal(splitPostBlocks('Ok. <post agent="a3">Li').text, 'Ok.');
  assert.equal(splitPostBlocks('Ok. <po').text, 'Ok.');
  assert.equal(splitPostBlocks('Ok. <').text, 'Ok.');
  assert.equal(splitPostBlocks('<post agent="a3">x</post> Próximo passo: <').text, 'Próximo passo:');
  // Tag que não é <post> fica.
  assert.equal(splitPostBlocks('Use <pre> aqui').text, 'Use <pre> aqui');
  assert.deepEqual(splitPostBlocks('<post agent="a3">Li as 84').blocks, []);
});

test('replay: blocos do transcrito só completam agente sem nenhum resumo gravado', () => {
  let posts = reports(['a3', 'r1', 1000], ['a3', 'r2', 2000], ['a5', 'r', 3000]);
  posts = applyPostSummary(posts, 'a5', 'gravado ao vivo').posts;
  const blocks = splitPostBlocks('<post agent="a3">fiz o 1</post> <post agent="a5">antigo</post>').blocks.concat(splitPostBlocks('<post agent="a3">fiz o 2</post>').blocks);
  const out = applyHistorySummaries(posts, blocks);
  assert.deepEqual(postsOf(out, 'a3').map((p) => p.summary), ['fiz o 1', 'fiz o 2']);
  assert.equal(postsOf(out, 'a5')[0].summary, 'gravado ao vivo');
});

test('pergunta da thread: a primeira leva o relatório do post e fala com o agente; as seguintes só lembram qual', () => {
  const post: AgentPost = { id: 'a4#2', agentId: 'a4', n: 2, at: new Date(2026, 9, 8, 10, 57).getTime(), report: 'Resumo: testes passam.' };
  const first = consultPrompt(post, 'Bancada de testes', 'Por que falhou?', true, 3);
  assert.match(first, /Você é o agente a4 \("Bancada de testes"\)/);
  assert.match(first, /relatório nº 2 de 3/);
  assert.match(first, /10h57/);
  assert.match(first, /agent_activity/);
  assert.match(first, /agent_report traz o relatório mais novo/);
  assert.ok(first.includes('Resumo: testes passam.'));
  assert.ok(first.endsWith('Por que falhou?'));
  const next = consultPrompt(post, '', 'E depois?', false, 2);
  assert.ok(!/agent_activity/.test(next));
  assert.ok(next.endsWith('E depois?'));
  assert.ok(!/nº/.test(consultPrompt(P3, '', 'oi', true)));
});

test('rótulo da ferramenta na thread', () => {
  assert.equal(consultToolLabel('mcp__companion__agent_activity'), 'relendo o que fez');
  assert.equal(consultToolLabel('Grep'), 'lendo arquivos do projeto');
  assert.equal(consultToolLabel('mcp__outro__qualquer'), 'pensando');
});

test('guardar: posts e só threads com conteúdo de post existente, sem o "esperando"', () => {
  const posts = reports(['a1', 'r', 10], ['a2', 'r', 20]);
  const t1 = { ...appendMessage(emptyThread(posts[0]), { from: 'user', text: 'x', at: 30 }), waiting: true };
  const orphan = appendMessage(emptyThread({ id: 'a9#1', agentId: 'a9' }), { from: 'user', text: 'x', at: 30 });
  const onlySession = { ...emptyThread(posts[1]), consultSessionId: 's1' };
  const stored = threadsToStore(posts, [t1, emptyThread(posts[1]), orphan, onlySession]);
  assert.equal(stored.version, 2);
  assert.equal(stored.posts.length, 2);
  assert.deepEqual(stored.threads.map((t) => t.postId), ['a1#1', 'a2#1']);
  assert.equal(stored.threads[0].waiting, undefined);
  // Ida e volta pelo disco.
  const back = threadsFromStore(JSON.parse(JSON.stringify(stored)));
  assert.deepEqual(back.posts.map((p) => p.id), ['a1#1', 'a2#1']);
  assert.equal(back.threads.find((t) => t.postId === 'a2#1')?.consultSessionId, 's1');
  assert.equal(back.threads[0].agentId, 'a1');
  assert.deepEqual(back.legacy, []);
});

test('ler do disco: descarta o que não tem formato', () => {
  assert.deepEqual(threadsFromStore(undefined), { posts: [], threads: [], legacy: [] });
  assert.deepEqual(threadsFromStore('x'), { posts: [], threads: [], legacy: [] });
  const r = threadsFromStore({
    posts: [{ agentId: 'a1', n: 1, at: 5, report: 'r' }, { agentId: 'a2', n: 'um', at: 5, report: 'r' }, null],
    threads: [
      { postId: 'a1#1', messages: [{ id: 'x', from: 'user', text: 'oi', at: 1 }, { id: 'y', from: 'robô', text: 'z', at: 2 }] },
      { postId: 'a7#1', messages: [] },
    ],
  });
  assert.deepEqual(r.posts.map((p) => p.id), ['a1#1']);
  assert.deepEqual(r.threads.map((t) => t.postId), ['a1#1']);
  assert.deepEqual(r.threads[0].messages.map((m) => m.id), ['x']);
});

test('migração: threads.json antigo (por agente) vai para a thread do post mais recente', () => {
  const legacyFile = [
    {
      agentId: 'a1',
      consultSessionId: 's-velha',
      messages: [
        { id: 'm1', from: 'user', text: 'oi', at: 1, toAgent: true },
        { id: 'm2', from: 'consult', text: 'resposta da consulta', at: 2 },
        { id: 'm3', from: 'agent', text: 'resposta do agente', at: 3 },
      ],
    },
    { agentId: 'a2', messages: [{ id: 'k', from: 'user', text: 'sem post', at: 1 }] },
    { agentId: 7, messages: [] },
  ];
  const stored = threadsFromStore(legacyFile);
  assert.deepEqual(stored.posts, []);
  assert.deepEqual(stored.legacy.map((t) => t.agentId), ['a1', 'a2']);
  assert.deepEqual(stored.legacy[0].messages.map((m) => m.from), ['user', 'agent', 'agent']);
  const posts = reports(['a1', 'r1', 100], ['a1', 'r2', 200]);
  const existing = appendMessage(emptyThread(posts[1]), { from: 'user', text: 'nova', at: 500 });
  const migrated = migrateLegacy(stored.legacy, posts, [existing]);
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].postId, 'a1#2');
  assert.deepEqual(migrated[0].messages.map((m) => m.text), ['oi', 'resposta da consulta', 'resposta do agente', 'nova']);
  assert.equal(migrated[0].consultSessionId, undefined);
  // Sem post nenhum, a thread antiga é descartada sem erro.
  assert.deepEqual(migrateLegacy(stored.legacy, [], []), []);
});

if (failed) {
  console.log(`\n${failed} teste(s) falharam`);
  process.exit(1);
}
console.log('\ntodos passaram');
