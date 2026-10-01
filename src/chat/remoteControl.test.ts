/**
 * Testes do Remote Control sem VS Code nem CLI: estados da ponte, frames bridge_state e o filtro do eco remoto.
 *   npx esbuild src/chat/remoteControl.test.ts --bundle --platform=node --outfile=$TEMP/remoteControl.test.js && node $TEMP/remoteControl.test.js
 */
import * as assert from 'node:assert/strict';
import { RemoteControl, RemoteControlApi, RemoteControlResponse, isClaudeUrl, isRemoteEcho, remoteControlApi, remoteTransitionNotice } from './remoteControl';
import type { RemoteControlState } from './protocol';

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
        console.log(`FAIL ${name}\n     ${err instanceof Error ? err.message : String(err)}`);
      }
    })(),
  );
}

function fakeApi(reply: RemoteControlResponse | Error): RemoteControlApi & { calls: boolean[] } {
  const calls: boolean[] = [];
  return {
    calls,
    enableRemoteControl: (enabled) => {
      calls.push(enabled);
      if (!enabled) {
        return Promise.resolve({});
      }
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    },
  };
}

function tracked(): { rc: RemoteControl; states: RemoteControlState[] } {
  const states: RemoteControlState[] = [];
  return { rc: new RemoteControl((s) => states.push(s)), states };
}

const OK = { session_url: 'https://claude.ai/code/session_abc', connect_url: 'https://claude.ai/code?environment=env_1', bridge_epoch: 3 };

test('ligar passa por conectando e termina conectado com o link', async () => {
  const { rc, states } = tracked();
  const api = fakeApi(OK);
  await rc.enable(api);
  assert.deepEqual(api.calls, [true]);
  assert.deepEqual(states.map((s) => s.status), ['connecting', 'connected']);
  assert.equal(rc.state.sessionUrl, OK.session_url);
  assert.equal(rc.wanted, true);
});

test('resposta sem session_url vira desconectado com motivo, como na oficial', async () => {
  const { rc } = tracked();
  await rc.enable(fakeApi({ bridge_epoch: 1 }));
  assert.equal(rc.state.status, 'disconnected');
  assert.match(rc.state.reason ?? '', /link/);
  assert.equal(rc.wanted, false);
});

test('erro do CLI ao ligar aparece como motivo', async () => {
  const { rc } = tracked();
  await rc.enable(fakeApi(new Error('Remote Control requires a claude.ai subscription')));
  assert.equal(rc.state.status, 'disconnected');
  assert.match(rc.state.reason ?? '', /subscription/);
});

test('erro de política ao ligar vira indisponível', async () => {
  const { rc } = tracked();
  await rc.enable(fakeApi(new Error('Remote Control is disabled by your organization policy')));
  assert.equal(rc.state.status, 'unavailable');
  await rc.enable(fakeApi(OK));
  assert.equal(rc.state.status, 'unavailable', 'indisponível não liga de novo');
});

test('sem processo ainda, ligar só marca a vontade', async () => {
  const { rc } = tracked();
  await rc.enable(undefined);
  assert.equal(rc.wanted, true);
  assert.equal(rc.state.status, 'connecting');
});

test('desligar chama enableRemoteControl(false) e volta a off', async () => {
  const { rc } = tracked();
  const api = fakeApi(OK);
  await rc.enable(api);
  await rc.disable(api);
  assert.deepEqual(api.calls, [true, false]);
  assert.equal(rc.state.status, 'off');
  assert.equal(rc.wanted, false);
});

test('resposta de um ligar já substituído por desligar não religa', async () => {
  const { rc } = tracked();
  let release!: (r: RemoteControlResponse) => void;
  const slow: RemoteControlApi = { enableRemoteControl: (on) => (on ? new Promise((r) => (release = r)) : Promise.resolve({})) };
  const on = rc.enable(slow);
  await rc.disable(slow);
  release(OK);
  await on;
  assert.equal(rc.state.status, 'off');
});

test('bridge_state failed derruba; connected do mesmo epoch reconecta; outro epoch é ignorado', async () => {
  const { rc } = tracked();
  await rc.enable(fakeApi(OK));
  rc.onBridgeState({ state: 'failed', detail: 'heartbeat timeout', bridge_epoch: 2 });
  assert.equal(rc.state.status, 'connected', 'epoch antigo não conta');
  rc.onBridgeState({ state: 'failed', detail: 'heartbeat timeout', bridge_epoch: 3 });
  assert.equal(rc.state.status, 'disconnected');
  assert.match(rc.state.reason ?? '', /heartbeat/);
  assert.equal(rc.state.sessionUrl, OK.session_url);
  rc.onBridgeState({ state: 'connected', bridge_epoch: 3 });
  assert.equal(rc.state.status, 'connected');
});

test('bridge_state policy_disabled deixa indisponível', async () => {
  const { rc } = tracked();
  await rc.enable(fakeApi(OK));
  rc.onBridgeState({ state: 'policy_disabled', detail: 'disabled by admin', bridge_epoch: 3 });
  assert.equal(rc.state.status, 'unavailable');
  assert.equal(rc.wanted, false);
});

test('frame failed sem o usuário ter ligado não mexe no estado', () => {
  const { rc, states } = tracked();
  rc.onBridgeState({ state: 'failed' });
  assert.equal(states.length, 0);
});

test('desligar que o CLI recusa mostra o erro (stuck), não "desligado"', async () => {
  const { rc } = tracked();
  const api: RemoteControlApi = { enableRemoteControl: (on) => (on ? Promise.resolve(OK) : Promise.reject(new Error('bridge busy'))) };
  await rc.enable(api);
  await rc.disable(api);
  assert.equal(rc.state.status, 'disconnected');
  assert.equal(rc.state.stuck, true);
  assert.match(rc.state.reason ?? '', /bridge busy/);
  assert.equal(rc.wanted, false);
  assert.equal(rc.mayReceive, true, 'a ponte pode continuar de pé');
  assert.match(remoteTransitionNotice({ status: 'connected', sessionUrl: OK.session_url }, rc.state)?.text ?? '', /não desligou/);
});

test('ponte fantasma: connected sem o usuário querer desliga de novo e avisa', async () => {
  const warnings: string[] = [];
  const rc = new RemoteControl(() => undefined, (t) => warnings.push(t));
  const api = fakeApi(OK);
  await rc.enable(api);
  await rc.disable(api);
  rc.onBridgeState({ state: 'connected', bridge_epoch: 3 }, api);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(api.calls, [true, false, false]);
  assert.equal(warnings.length, 1);
  assert.equal(rc.state.status, 'off');
  assert.equal(rc.mayReceive, false);
});

test('ponte fantasma que não desliga fica como erro, e desiste depois de 3 tentativas', async () => {
  const warnings: string[] = [];
  const rc = new RemoteControl(() => undefined, (t) => warnings.push(t));
  const calls: boolean[] = [];
  const api: RemoteControlApi = {
    enableRemoteControl: (on) => {
      calls.push(on);
      return Promise.reject(new Error('nope'));
    },
  };
  for (let i = 0; i < 5; i++) {
    rc.onBridgeState({ state: 'ready' }, api);
    await new Promise((r) => setTimeout(r, 0));
  }
  assert.equal(calls.length, 3);
  assert.equal(rc.state.status, 'disconnected');
  assert.equal(rc.state.stuck, true);
  assert.equal(rc.mayReceive, true);
});

test('frames durante o desligar não contam como fantasma', async () => {
  const warnings: string[] = [];
  const rc = new RemoteControl(() => undefined, (t) => warnings.push(t));
  let release!: () => void;
  const calls: boolean[] = [];
  const api: RemoteControlApi = {
    enableRemoteControl: (on) => {
      calls.push(on);
      return on ? Promise.resolve(OK) : new Promise((r) => (release = () => r({})));
    },
  };
  await rc.enable(api);
  const off = rc.disable(api);
  rc.onBridgeState({ state: 'ready', bridge_epoch: 3 }, api);
  release();
  await off;
  assert.deepEqual(calls, [true, false]);
  assert.equal(warnings.length, 0);
  assert.equal(rc.state.status, 'off');
});

test('bypass: pede confirmação com a ponte ligada; sair do bypass zera a confirmação', async () => {
  const { rc } = tracked();
  assert.equal(rc.needsBypassConfirm('bypassPermissions'), false, 'ponte desligada não pergunta');
  await rc.enable(fakeApi(OK));
  assert.equal(rc.needsBypassConfirm('default'), false);
  assert.equal(rc.needsBypassConfirm('bypassPermissions'), true);
  rc.bypassConfirmed = true;
  assert.equal(rc.needsBypassConfirm('bypassPermissions'), false);
  assert.equal(rc.needsBypassConfirm('acceptEdits'), false);
  assert.equal(rc.needsBypassConfirm('bypassPermissions'), true, 'voltar ao bypass pergunta de novo');
  rc.bypassConfirmed = true;
  await rc.disable(fakeApi(OK));
  assert.equal(rc.bypassConfirmed, false, 'desligar esquece a confirmação');
});

test('isClaudeUrl: só https no claude.ai ou subdomínio', () => {
  assert.equal(isClaudeUrl('https://claude.ai/code/session_1'), true);
  assert.equal(isClaudeUrl('https://www.claude.ai/code'), true);
  assert.equal(isClaudeUrl('http://claude.ai/code'), false);
  assert.equal(isClaudeUrl('https://claude.ai.evil.com/x'), false);
  assert.equal(isClaudeUrl('https://evilclaude.ai/x'), false);
  assert.equal(isClaudeUrl('file:///C:/Windows/system32/calc.exe'), false);
  assert.equal(isClaudeUrl('javascript:alert(1)'), false);
  assert.equal(isClaudeUrl('não é url'), false);
  assert.equal(isClaudeUrl(undefined), false);
});

test('processo reiniciado com a ponte ligada fica conectando; processo caído fica desconectado com motivo', async () => {
  const { rc } = tracked();
  await rc.enable(fakeApi(OK));
  rc.processEnded(true);
  assert.equal(rc.state.status, 'connecting');
  assert.equal(rc.wanted, true);
  rc.processEnded(false);
  assert.equal(rc.state.status, 'disconnected');
  assert.match(rc.state.reason ?? '', /próxima mensagem/);
});

test('processo reiniciado sem a ponte não muda nada', () => {
  const { rc, states } = tracked();
  rc.processEnded(true);
  assert.equal(states.length, 0);
});

test('remoteControlApi só aceita quem tem enableRemoteControl', () => {
  assert.equal(remoteControlApi(undefined), undefined);
  assert.equal(remoteControlApi({}), undefined);
  assert.ok(remoteControlApi({ enableRemoteControl: () => Promise.resolve({}) }));
});

test('eco do nosso uuid não é remoto; o de uuid desconhecido é', () => {
  const own = new Set(['u-1']);
  const msg = (uuid: string, content: unknown, extra: object = {}) => ({ uuid, parent_tool_use_id: null, message: { content }, ...extra });
  assert.equal(isRemoteEcho(msg('u-1', 'oi'), own, true), false);
  assert.equal(isRemoteEcho(msg('u-2', 'oi do celular'), own, true), true);
  assert.equal(isRemoteEcho(msg('u-2', 'oi do celular'), own, false), false, 'sem a ponte não há remoto');
  assert.equal(isRemoteEcho(msg('u-3', 'aviso', { isSynthetic: true }), own, true), false);
  assert.equal(isRemoteEcho(msg('u-4', '<local-command-stdout>ok</local-command-stdout>'), own, true), false);
  assert.equal(isRemoteEcho(msg('u-5', [{ type: 'tool_result', tool_use_id: 't', content: 'x' }]), own, true), false);
  assert.equal(isRemoteEcho(msg('u-6', [{ type: 'text', text: 'olha isto' }, { type: 'image', source: {} }]), own, true), true);
  assert.equal(isRemoteEcho(msg('u-7', [{ type: 'image', source: {} }]), own, true), true);
  assert.equal(isRemoteEcho({ ...msg('u-8', 'x'), parent_tool_use_id: 'toolu_1' }, own, true), false);
});

test('eco com origem que não é humana não é remoto', () => {
  const own = new Set<string>();
  const msg = (origin: object | undefined) => ({ uuid: 'u-9', parent_tool_use_id: null, message: { content: 'oi' }, ...(origin ? { origin } : {}) });
  assert.equal(isRemoteEcho(msg(undefined), own, true), true);
  assert.equal(isRemoteEcho(msg({ kind: 'human' }), own, true), true);
  assert.equal(isRemoteEcho(msg({ kind: 'peer', from: 'x' }), own, true), false);
  assert.equal(isRemoteEcho(msg({ kind: 'channel', server: 's' }), own, true), false);
  assert.equal(isRemoteEcho(msg({ kind: 'task-notification' }), own, true), false);
});

test('eco com tags do CLI no começo não é remoto', () => {
  const own = new Set<string>();
  const echo = (text: string) => isRemoteEcho({ uuid: 'u-10', parent_tool_use_id: null, message: { content: text } }, own, true);
  assert.equal(echo('<command-message>compact</command-message>\n<command-name>/compact</command-name>'), false);
  assert.equal(echo('<command-name>/rename</command-name>\n<command-args>x</command-args>'), false);
  assert.equal(echo('<local-command-stdout>ok</local-command-stdout>'), false);
  assert.equal(echo('<local-command-caveat>x</local-command-caveat>\nresto'), false);
  assert.equal(echo('<task-notification>\n<task-id>b1</task-id>\n</task-notification>'), false);
  assert.equal(echo('<system-reminder>x</system-reminder> e mais texto'), false);
  assert.equal(echo('<bash-input>ls</bash-input>'), false);
  assert.equal(echo('<bash-stdout>a</bash-stdout><bash-stderr></bash-stderr>'), false);
  assert.equal(echo('<b>negrito</b> escrito no celular e mais'), true, 'tag qualquer no meio de texto do usuário passa');
  assert.equal(echo('como uso <command-name> no Claude Code?'), true);
});

test('o mesmo uuid próprio ecoado duas vezes continua sendo nosso', () => {
  const own = new Set(['u-1']);
  const m = { uuid: 'u-1', parent_tool_use_id: null, message: { content: 'oi' } };
  assert.equal(isRemoteEcho(m, own, true), false);
  assert.equal(isRemoteEcho(m, own, true), false);
});

test('avisos do chat: conectado com link, queda, desligado; indisponível só para quem tentou', () => {
  const off: RemoteControlState = { status: 'off' };
  const connecting: RemoteControlState = { status: 'connecting' };
  const connected: RemoteControlState = { status: 'connected', sessionUrl: OK.session_url };
  assert.match(remoteTransitionNotice(connecting, connected)?.text ?? '', /claude\.ai\/code\/session_abc/);
  assert.equal(remoteTransitionNotice(connected, connected), undefined);
  assert.equal(remoteTransitionNotice(off, connecting), undefined);
  assert.equal(remoteTransitionNotice(connected, { status: 'disconnected', reason: 'x' })?.level, 'error');
  assert.match(remoteTransitionNotice(connecting, { status: 'disconnected', reason: 'x' })?.text ?? '', /não conectou/);
  assert.match(remoteTransitionNotice(connected, off)?.text ?? '', /desligado/);
  assert.equal(remoteTransitionNotice(off, { status: 'unavailable', reason: 'política' }), undefined);
  assert.equal(remoteTransitionNotice(connecting, { status: 'unavailable', reason: 'política' })?.level, 'error');
});

void Promise.all(pending).then(() => {
  if (failed) {
    console.log(`\n${failed} teste(s) falharam`);
    process.exit(1);
  }
  console.log('\ntodos os testes passaram');
});
