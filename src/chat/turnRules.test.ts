/**
 * Testes das regras puras do fim de turno (pendência, trava de laço, limite de uso, corte de relatório). Sem VS Code:
 *   npx esbuild src/chat/turnRules.test.ts --bundle --platform=node --outfile=$TEMP/turnRules.test.js && node $TEMP/turnRules.test.js
 */
import * as assert from 'node:assert/strict';
import { clipReport, consumedCauses, deliveryWindow, limitFromText, limitSummary, mainAnswerTargets, mergeHeldReport, nextHeldReport, pendingInfo, pendingLabel, untilIso } from './turnRules';
import { pendingText } from './protocol';

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

const now = new Date('2026-09-29T12:00:00.000Z');

test('sem pendência não há PendingInfo', () => {
  assert.equal(pendingInfo({ background: [], children: [], asked: [] }), undefined);
});

test('processo em segundo plano vira pendência com nota curta', () => {
  const p = pendingInfo({ background: [{ id: 't1', description: 'sleep 12' }], children: [], asked: [] }, { now, note: 'x'.repeat(700) });
  assert.ok(p);
  assert.deepEqual(p.reasons, ['background']);
  assert.equal(p.since, now.toISOString());
  assert.equal(p.note?.length, 601);
  assert.equal(pendingLabel(p), 'aguardando processo em segundo plano');
});

test('filhos e pergunta entram no rótulo, e since é preservado', () => {
  const p = pendingInfo({ background: [], children: ['a3', 'a4'], asked: ['main'] }, { since: '2026-09-29T11:00:00.000Z', now });
  assert.ok(p);
  assert.deepEqual(p.reasons, ['children', 'question']);
  assert.equal(p.since, '2026-09-29T11:00:00.000Z');
  assert.equal(pendingLabel(p), 'aguardando 2 subagentes (a3, a4), resposta de main');
  // O webview usa a mesma frase, a partir do AgentInfo.
  assert.equal(pendingText({ pending: p }), pendingLabel(p));
});

test('trava de laço conta só a janela e nunca zera o agente para sempre', () => {
  const t0 = 1_000_000;
  const old = Array.from({ length: 10 }, (_, i) => t0 - 11 * 60_000 + i);
  const w = deliveryWindow(old, t0, 10);
  assert.equal(w.kept.length, 0);
  assert.equal(w.allowed, true);
  const recent = Array.from({ length: 10 }, (_, i) => t0 - i * 1000);
  assert.equal(deliveryWindow(recent, t0, 10).allowed, false);
  assert.equal(deliveryWindow(recent.slice(0, 9), t0, 10).allowed, true);
});

test('limite de uso é reconhecido e a hora de reset é lida', () => {
  const l = limitFromText("You've hit your limit · resets 3pm (America/Sao_Paulo)", now);
  assert.ok(l);
  assert.ok(l.until);
  assert.equal(new Date(l.until!).getHours(), 15);
  assert.equal(limitFromText('model_not_found: no such model'), undefined);
  assert.ok(limitFromText('API error 429 Too Many Requests'));
  assert.equal(limitSummary({}), 'limite de uso');
  assert.match(limitSummary({ until: l.until }), /^limite de uso até \d{2}:\d{2}$/);
});

test('hora que já passou cai para amanhã', () => {
  const at = untilIso('9am', new Date('2026-09-29T15:00:00'));
  assert.ok(at);
  const d = new Date(at!);
  assert.equal(d.getDate(), 30);
  assert.equal(d.getHours(), 9);
  assert.equal(untilIso('nada'), undefined);
});

test('relatório longo é cortado num parágrafo e cita o arquivo; curto passa inteiro', () => {
  const short = 'Conclusão.\n\nDetalhe.';
  assert.equal(clipReport(short, '.agm/reports/a1.md'), short);
  const long = Array.from({ length: 40 }, (_, i) => `Parágrafo ${i} ${'palavra '.repeat(30)}`).join('\n\n');
  const cut = clipReport(long, '.agm/reports/a1.md');
  assert.ok(cut.length < long.length);
  assert.ok(cut.includes('.agm/reports/a1.md'));
  assert.ok(cut.startsWith('Parágrafo 0'));
  // Sem arquivo (não deu para gravar), não corta: melhor longo do que perdido.
  assert.equal(clipReport(long, undefined), long);
});

test('relatório segurado sai com o turno de acordar: curto vira atualização, longo substitui, vazio devolve o segurado', () => {
  const held = 'Conclusão: pronto.\n\n' + 'Detalhe do trabalho. '.repeat(20);
  // A função devolve o texto sem espaços nas pontas.
  assert.equal(mergeHeldReport(held, ''), held.trim());
  assert.equal(mergeHeldReport(undefined, 'só o turno'), 'só o turno');
  const merged = mergeHeldReport(held, 'Recebi o relatório de a4, tudo certo.');
  assert.ok(merged.startsWith(held.trim()));
  assert.ok(merged.includes('Atualização depois de a pendência acabar:\nRecebi o relatório de a4'));
  const rewritten = 'Conclusão nova.\n\n' + 'Relatório reescrito inteiro. '.repeat(20);
  assert.equal(mergeHeldReport(held, rewritten), rewritten.trim());
});

test('turno aberto pelo CLI sozinho não consome a causa de uma mensagem ainda na fila', () => {
  // Turno normal: pelo menos uma causa, mesmo que a fila esteja vazia (a causa do próprio turno).
  assert.equal(consumedCauses(1, 0, false), 1);
  assert.equal(consumedCauses(0, 0, false), 1);
  assert.equal(consumedCauses(3, 1, false), 2);
  // Turno automático: só o que já não está na fila; com uma pergunta enfileirada, nada.
  assert.equal(consumedCauses(1, 1, true), 0);
  assert.equal(consumedCauses(1, 0, true), 1);
  assert.equal(consumedCauses(0, 0, true), 0);
});

test('limite não é reconhecido só porque o texto cita 429 sem contexto de erro', () => {
  // limitFromText continua casando; quem decide é a sessão, que só a chama com o texto de erro do result.
  assert.ok(limitFromText('API error 429 Too Many Requests'));
  assert.equal(limitFromText('tudo certo, o teste passou'), undefined);
});

test('resposta do main só vai a quem perguntou antes de o turno começar, e só com a fila vazia', () => {
  const askers = [
    { id: 'a3', askedAt: 100 },
    { id: 'a4', askedAt: 250 },
  ];
  // Turno aberto antes da pergunta de a4 (mas depois da de a3): responde só a3.
  assert.deepEqual(mainAnswerTargets(askers, 200, 0), ['a3']);
  // Turno aberto no mesmo instante em que a pergunta chegou (main ocioso): responde.
  assert.deepEqual(mainAnswerTargets(askers, 250, 0), ['a3', 'a4']);
  // Turno aberto antes de qualquer pergunta: ninguém.
  assert.deepEqual(mainAnswerTargets(askers, 50, 0), []);
  // Com mensagem ainda na fila do CLI, este turno não é a resposta.
  assert.deepEqual(mainAnswerTargets(askers, 300, 1), []);
});

test('relatório segurado junta os turnos e ignora turno de resposta', () => {
  const report = 'Conclusão: pronto.\n\n' + 'Detalhe do trabalho. '.repeat(20);
  const held1 = nextHeldReport(undefined, report, false);
  assert.equal(held1, report.trim());
  // Filho 1 chegou, pai escreve uma linha: o relatório original continua na frente.
  const held2 = nextHeldReport(held1, 'Recebi a3, falta a4.', false);
  assert.ok(held2?.startsWith(report.trim()));
  assert.ok(held2?.endsWith('Recebi a3, falta a4.'));
  // Pergunta de B respondida enquanto aguarda: a resposta não entra no relatório.
  assert.equal(nextHeldReport(held2, 'B, o arquivo é src/x.ts.', true), held2);
  // Turno segurado sem texto não apaga nada.
  assert.equal(nextHeldReport(held2, '   ', false), held2);
});

if (failed) {
  console.log(`\n${failed} teste(s) falharam`);
  process.exit(1);
}
console.log('\ntodos os testes passaram');
