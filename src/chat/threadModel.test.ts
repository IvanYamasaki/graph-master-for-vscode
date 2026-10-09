/**
 * Testes do modelo de posts e threads do chat. Sem VS Code:
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
  claudeThreadId,
  clockLabel,
  emptyThread,
  lastReplyLabel,
  latestPost,
  migrateLegacy,
  parseThreadMessage,
  participants,
  postsOf,
  relativeTime,
  replyCount,
  resolveThreadId,
  splitBlocks,
  threadFooter,
  threadKind,
  threadsFromHistory,
  threadsFromStore,
  threadsToStore,
  userThreadId,
  wrapThreadMessage,
  type AgentPost,
  type ChatThread,
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
  t = appendMessage(t, { from: 'claude', text: 'resposta', at: NOW - 3 * MIN });
  t = appendMessage(t, { from: 'user', text: 'e agora?', at: NOW - 2 * MIN });
  assert.equal(replyCount(t), 3);
  assert.equal(threadFooter(t, NOW)?.count, '3 respostas');
  // Mensagem refeita do transcrito não tem hora: conta, mas sem "Última resposta".
  t = appendMessage(t, { from: 'claude', text: 'do transcrito', at: 0 });
  assert.deepEqual(threadFooter(t, NOW), { count: '4 respostas', last: '' });
});

test('appendMessage não muda a thread de entrada, gera ids únicos e corta o excesso', () => {
  const t0 = emptyThread(P3);
  const t1 = appendMessage(t0, { from: 'user', text: 'x', at: NOW });
  const t2 = appendMessage(t1, { from: 'claude', text: 'y', at: NOW });
  assert.equal(t0.messages.length, 0);
  assert.notEqual(t2.messages[0].id, t2.messages[1].id);
  let t = appendMessage(t0, { from: 'claude', text: 'z'.repeat(MAX_MESSAGE_CHARS + 50), at: NOW });
  assert.equal(t.messages[0].text.length, MAX_MESSAGE_CHARS);
  for (let i = 0; i < MAX_THREAD_MESSAGES + 5; i++) {
    t = appendMessage(t, { from: 'user', text: String(i), at: NOW + i });
  }
  assert.equal(t.messages.length, MAX_THREAD_MESSAGES);
});

test('participantes, iniciais e nomes: Você, o Claude e o agente pelo nome dele', () => {
  let t = emptyThread(P3);
  t = appendMessage(t, { from: 'user', text: '1', at: 1 });
  t = appendMessage(t, { from: 'agent', agentId: 'a3', text: '2', at: 2 });
  t = appendMessage(t, { from: 'claude', text: '3', at: 3 });
  t = appendMessage(t, { from: 'user', text: '4', at: 4 });
  t = appendMessage(t, { from: 'agent', agentId: 'a3', text: '5', at: 5 });
  assert.deepEqual(participants(t), [{ from: 'agent', agentId: 'a3' }, { from: 'user' }, { from: 'claude' }]);
  assert.deepEqual(participants(t, 1), [{ from: 'agent', agentId: 'a3' }]);
  assert.equal(authorInitials({ from: 'agent', agentId: 'a12' }), 'a12');
  assert.equal(authorInitials({ from: 'user' }), 'Eu');
  assert.equal(authorInitials({ from: 'claude' }), '');
  assert.equal(authorName({ from: 'user' }, 'Bancada'), 'Você');
  assert.equal(authorName({ from: 'agent', agentId: 'a3' }, 'Bancada'), 'Bancada');
  assert.equal(authorName({ from: 'agent', agentId: 'a3' }), 'Agente a3');
  assert.equal(authorName({ from: 'claude' }, undefined, 'Codex'), 'Codex');
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
  const r = splitBlocks('<post agent="a3">Li as 84 calls. Três sem transcrição.</post>\n\nVou pedir a lista ao a4.');
  assert.deepEqual(r.blocks, [{ agentId: 'a3', text: 'Li as 84 calls. Três sem transcrição.' }]);
  assert.equal(r.text, 'Vou pedir a lista ao a4.');
  const two = splitBlocks("Antes.\n<post agent='a1'>um</post>\n<POST agent=a2 >dois\nlinhas</post>\nDepois.");
  assert.deepEqual(two.blocks.map((b) => [b.agentId, b.text]), [['a1', 'um'], ['a2', 'dois\nlinhas']]);
  assert.equal(two.text, 'Antes.\n\nDepois.');
  const plain = 'Nada de bloco aqui, nem a < b.';
  assert.equal(splitBlocks(plain).text, plain);
});

test('bloco <post> em streaming: o pedaço aberto não aparece', () => {
  assert.equal(splitBlocks('<post agent="a3">Li as 84').text, '');
  assert.equal(splitBlocks('Ok. <post agent="a3">Li').text, 'Ok.');
  assert.equal(splitBlocks('Ok. <po').text, 'Ok.');
  assert.equal(splitBlocks('Ok. <').text, 'Ok.');
  assert.equal(splitBlocks('<post agent="a3">x</post> Próximo passo: <').text, 'Próximo passo:');
  // Tag que não é <post> fica.
  assert.equal(splitBlocks('Use <pre> aqui').text, 'Use <pre> aqui');
  assert.deepEqual(splitBlocks('<post agent="a3">Li as 84').blocks, []);
});

test('bloco <thread>: sai do texto, com e sem "as", junto de <post>', () => {
  const r = splitBlocks('<post agent="a3">Li tudo.</post>\n<thread id="a3#2" as="a3">Eu não rodei os testes.</thread>\nNo chat: vou seguir.');
  assert.deepEqual(r.blocks, [{ agentId: 'a3', text: 'Li tudo.' }]);
  assert.deepEqual(r.threads, [{ id: 'a3#2', as: 'a3', text: 'Eu não rodei os testes.' }]);
  assert.equal(r.text, 'No chat: vou seguir.');
  // Atributos em qualquer ordem, aspas simples, sem "as": fala o Claude.
  const two = splitBlocks("<thread as='a5' id='a5'>um</thread><THREAD id=\"c:msg_01.1\">dois\nlinhas</thread>");
  assert.deepEqual(two.threads, [{ id: 'a5', as: 'a5', text: 'um' }, { id: 'c:msg_01.1', as: undefined, text: 'dois\nlinhas' }]);
  assert.equal(two.text, '');
  // Sem id, ou vazio, não vira mensagem (e some do texto).
  assert.deepEqual(splitBlocks('<thread>sem id</thread><thread id="u:1">  </thread>ok').threads, []);
  // O embrulho que o usuário manda não é bloco de resposta.
  const wrapped = wrapThreadMessage('a3#1', { kind: 'post', agentId: 'a3', text: 'x' }, 'oi');
  assert.deepEqual(splitBlocks(wrapped).threads, []);
});

test('bloco <thread> em streaming: o pedaço aberto e o começo da tag não aparecem', () => {
  assert.equal(splitBlocks('<thread id="a3#1">Eu li').text, '');
  assert.equal(splitBlocks('Certo. <thread id="u:9" as').text, 'Certo.');
  assert.equal(splitBlocks('Certo. <th').text, 'Certo.');
  assert.equal(splitBlocks('Certo. <thre').text, 'Certo.');
  assert.equal(splitBlocks('<thread id="a3#1">x</thread> Agora <').text, 'Agora');
  assert.deepEqual(splitBlocks('<thread id="a3#1">Eu li').threads, []);
  // Tag que não é <thread> fica.
  assert.equal(splitBlocks('Use <table> e <threads> aqui').text, 'Use <table> e <threads> aqui');
});

test('ids das mensagens-mãe e destino do bloco <thread>', () => {
  assert.equal(claudeThreadId('msg_01'), 'c:msg_01');
  assert.equal(claudeThreadId('msg_01', 2), 'c:msg_01.2');
  assert.equal(userThreadId('5f2c'), 'u:5f2c');
  assert.equal(threadKind('c:msg_01'), 'claude');
  assert.equal(threadKind('u:5f2c'), 'user');
  assert.equal(threadKind('a3#2'), 'post');
  const posts = reports(['a3', 'r1', 1000], ['a3', 'r2', 2000]);
  const has = (id: string) => id === 'u:5f2c';
  assert.equal(resolveThreadId('u:5f2c', posts, has), 'u:5f2c');
  assert.equal(resolveThreadId('a3#1', posts, has), 'a3#1');
  // Só o agente: o post mais recente dele.
  assert.equal(resolveThreadId('a3', posts, has), 'a3#2');
  assert.equal(resolveThreadId('a9', posts, has), undefined);
  assert.equal(resolveThreadId('u:outra', posts, has), undefined);
  assert.equal(resolveThreadId(' ', posts, has), undefined);
});

test('embrulho da mensagem de thread: ida ao orquestrador e reconhecimento no replay', () => {
  const parent = { kind: 'claude' as const, text: 'Rodei os testes.\nDois falharam: <trecho> no meio.' };
  const text = 'Quais falharam?\nE por quê?';
  const wrapped = wrapThreadMessage('c:msg_01', parent, text);
  assert.match(wrapped, /^<thread-msg id="c:msg_01" mae="fala sua \(Claude\) no chat">/);
  assert.match(wrapped, /<trecho>Rodei os testes\. Dois falharam: {2}no meio\.<\/trecho>/);
  assert.match(wrapped, /responda nela, num bloco <thread id="c:msg_01">/);
  assert.deepEqual(parseThreadMessage(wrapped), { threadId: 'c:msg_01', text });
  // Com as novidades do cérebro na frente (withNews), também.
  assert.deepEqual(parseThreadMessage(`Novidades no cérebro...\n\n---\n\n${wrapped}`), { threadId: 'c:msg_01', text });
  // Post: a mãe diz de qual agente; sem trecho, a linha some.
  const post = wrapThreadMessage('a3#2', { kind: 'post', agentId: 'a3', text: '' }, 'oi');
  assert.match(post, /mae="post do agente a3"/);
  assert.ok(!post.includes('<trecho>'));
  assert.deepEqual(parseThreadMessage(post), { threadId: 'a3#2', text: 'oi' });
  assert.equal(parseThreadMessage('mensagem comum com <thread id="x">'), undefined);
});

test('replay: thread que o threads.json não tem volta do transcrito, sem hora', () => {
  const posts = reports(['a3', 'r1', 1000]);
  const items = [
    { kind: 'user', text: wrapThreadMessage('u:1', { kind: 'user', text: 'minha pergunta original' }, 'e isso?') },
    { kind: 'text', text: 'Vou ver.\n<thread id="u:1">Isso é o X.</thread>' },
    { kind: 'user', text: wrapThreadMessage('a3#1', { kind: 'post', agentId: 'a3', text: '' }, 'por que?') },
    { kind: 'text', text: '<thread id="a3" as="a3">Porque sim.</thread>' },
    { kind: 'user', text: wrapThreadMessage('c:salva', { kind: 'claude', text: 'x' }, 'já gravada') },
    { kind: 'tool', id: 't', name: 'Read', input: {} },
  ];
  const out = threadsFromHistory(items, posts, (id) => id === 'c:salva');
  assert.deepEqual(out.map((t) => t.id), ['u:1', 'a3#1']);
  const u = out[0];
  assert.deepEqual(u.parent, { kind: 'user', text: 'minha pergunta original' });
  assert.deepEqual(u.messages.map((m) => [m.from, m.text, m.at]), [['user', 'e isso?', 0], ['claude', 'Isso é o X.', 0]]);
  assert.deepEqual(out[1].messages.map((m) => [m.from, m.agentId, m.text]), [['user', undefined, 'por que?'], ['agent', 'a3', 'Porque sim.']]);
});

test('replay: blocos do transcrito só completam agente sem nenhum resumo gravado', () => {
  let posts = reports(['a3', 'r1', 1000], ['a3', 'r2', 2000], ['a5', 'r', 3000]);
  posts = applyPostSummary(posts, 'a5', 'gravado ao vivo').posts;
  const blocks = splitBlocks('<post agent="a3">fiz o 1</post> <post agent="a5">antigo</post>').blocks.concat(splitBlocks('<post agent="a3">fiz o 2</post>').blocks);
  const out = applyHistorySummaries(posts, blocks);
  assert.deepEqual(postsOf(out, 'a3').map((p) => p.summary), ['fiz o 1', 'fiz o 2']);
  assert.equal(postsOf(out, 'a5')[0].summary, 'gravado ao vivo');
});

test('guardar: posts e só threads com conteúdo, sem o "esperando"', () => {
  const posts = reports(['a1', 'r', 10], ['a2', 'r', 20]);
  const t1 = { ...appendMessage(emptyThread(posts[0]), { from: 'user', text: 'x', at: 30 }), waiting: true };
  const orphan = appendMessage(emptyThread({ id: 'a9#1', agentId: 'a9' }), { from: 'user', text: 'x', at: 30 });
  const claude: ChatThread = appendMessage({ id: 'c:msg_7', parent: { kind: 'claude', text: 'Rodei.', at: 25 }, messages: [] }, { from: 'user', text: 'e?', at: 40 });
  const emptyUser: ChatThread = { id: 'u:1', parent: { kind: 'user', text: 'oi' }, messages: [] };
  const stored = threadsToStore(posts, [t1, emptyThread(posts[1]), orphan, claude, emptyUser]);
  assert.equal(stored.version, 3);
  assert.equal(stored.posts.length, 2);
  assert.deepEqual(stored.threads.map((t) => t.id), ['a1#1', 'c:msg_7']);
  assert.equal(stored.threads[0].waiting, undefined);
  // Ida e volta pelo disco.
  const back = threadsFromStore(JSON.parse(JSON.stringify(stored)));
  assert.deepEqual(back.posts.map((p) => p.id), ['a1#1', 'a2#1']);
  assert.deepEqual(back.threads.map((t) => t.id), ['a1#1', 'c:msg_7']);
  assert.deepEqual(back.threads[0].parent, { kind: 'post', agentId: 'a1', text: '' });
  assert.deepEqual(back.threads[1].parent, { kind: 'claude', text: 'Rodei.', at: 25 });
  assert.deepEqual(back.legacy, []);
});

test('ler do disco: descarta o que não tem formato', () => {
  assert.deepEqual(threadsFromStore(undefined), { posts: [], threads: [], legacy: [] });
  assert.deepEqual(threadsFromStore('x'), { posts: [], threads: [], legacy: [] });
  const r = threadsFromStore({
    posts: [{ agentId: 'a1', n: 1, at: 5, report: 'r' }, { agentId: 'a2', n: 'um', at: 5, report: 'r' }, null],
    threads: [
      { id: 'a1#1', parent: { kind: 'post' }, messages: [{ id: 'x', from: 'user', text: 'oi', at: 1 }, { id: 'y', from: 'robô', text: 'z', at: 2 }] },
      { id: 'a7#1', messages: [] },
      { id: 'u:sem-mensagem', parent: { text: 'x' }, messages: [] },
      { id: 'a1#1', messages: [{ id: 'dup', from: 'user', text: 'repetida', at: 3 }] },
      null,
    ],
  });
  assert.deepEqual(r.posts.map((p) => p.id), ['a1#1']);
  assert.deepEqual(r.threads.map((t) => t.id), ['a1#1']);
  assert.deepEqual(r.threads[0].messages.map((m) => m.id), ['x']);
});

test('migração v2: thread de post com a persona só leitura abre sem erro, e a consulta vira o agente', () => {
  const v2 = {
    version: 2,
    posts: [{ id: 'a3#1', agentId: 'a3', n: 1, at: 100, report: 'Resumo: ok.', summary: 'Fiz.' }],
    threads: [
      {
        postId: 'a3#1',
        agentId: 'a3',
        consultSessionId: 'sessao-velha',
        messages: [
          { id: 'm1', from: 'user', text: 'por quê?', at: 200 },
          { id: 'm2', from: 'agent', text: 'porque sim', at: 300, error: false },
          { id: 'm3', from: 'consult', text: 'formato mais antigo', at: 400 },
        ],
      },
      { postId: 'a9#1', agentId: 'a9', messages: [{ id: 'k', from: 'user', text: 'post sumiu', at: 1 }] },
    ],
  };
  const r = threadsFromStore(v2);
  assert.deepEqual(r.threads.map((t) => t.id), ['a3#1']);
  const t = r.threads[0];
  assert.deepEqual(t.parent, { kind: 'post', agentId: 'a3', text: '' });
  assert.deepEqual(t.messages.map((m) => [m.from, m.agentId]), [['user', undefined], ['agent', 'a3'], ['agent', 'a3']]);
  assert.ok(!('consultSessionId' in t));
  // Gravado de novo, sai no formato novo.
  const again = threadsToStore(r.posts, r.threads);
  assert.equal(again.version, 3);
  assert.ok(!JSON.stringify(again).includes('consultSessionId'));
  assert.deepEqual(threadsFromStore(JSON.parse(JSON.stringify(again))).threads[0].messages.map((m) => m.from), ['user', 'agent', 'agent']);
});

test('migração v1: threads.json antigo (por agente) vai para a thread do post mais recente', () => {
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
  assert.deepEqual(stored.legacy[0].messages.map((m) => [m.from, m.agentId]), [['user', undefined], ['agent', 'a1'], ['agent', 'a1']]);
  const posts = reports(['a1', 'r1', 100], ['a1', 'r2', 200]);
  const existing = appendMessage(emptyThread(posts[1]), { from: 'user', text: 'nova', at: 500 });
  const migrated = migrateLegacy(stored.legacy, posts, [existing]);
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].id, 'a1#2');
  assert.deepEqual(migrated[0].messages.map((m) => m.text), ['oi', 'resposta da consulta', 'resposta do agente', 'nova']);
  // Sem post nenhum, a thread antiga é descartada sem erro.
  assert.deepEqual(migrateLegacy(stored.legacy, [], []), []);
});

if (failed) {
  console.log(`\n${failed} teste(s) falharam`);
  process.exit(1);
}
console.log('\ntodos passaram');
