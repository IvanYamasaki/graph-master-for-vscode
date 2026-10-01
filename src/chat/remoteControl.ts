import type { RemoteControlState } from './protocol';

export type { RemoteControlState };

/**
 * Remote Control do Claude Code: continuar esta sessão pelo claude.ai/code ou pelo app do celular.
 * Mesmo mecanismo da extensão oficial (docs/remote-control.md): o control request `remote_control` pelo
 * `Query.enableRemoteControl` do SDK, que existe em runtime mas não está no sdk.d.ts desta versão.
 */

/** Resposta do control request `remote_control` (CLI 2.1.284). */
export interface RemoteControlResponse {
  session_url?: string;
  connect_url?: string;
  environment_id?: string;
  bridge_epoch?: number;
  bridge_session_id?: string;
}

/** Frame `{ type: "system", subtype: "bridge_state" }` que o CLI emite depois de ligar a ponte. */
export interface BridgeStateFrame {
  state: string;
  detail?: string;
  failure_kind?: string;
  bridge_epoch?: number;
}

export interface RemoteControlApi {
  enableRemoteControl(enabled: boolean, name?: string): Promise<RemoteControlResponse>;
}

/** O Query do SDK com o método que o sdk.d.ts não declara; undefined num SDK que não o tenha. */
export function remoteControlApi(q: unknown): RemoteControlApi | undefined {
  const fn = (q as { enableRemoteControl?: unknown } | undefined)?.enableRemoteControl;
  return typeof fn === 'function' ? (q as RemoteControlApi) : undefined;
}

const UNAVAILABLE =
  'o Claude Code diz que o Remote Control não está disponível aqui: desligado pela organização (disableRemoteControl nas managed settings), conta sem login no claude.ai ou provedor que não é a Anthropic';

/** Quantas vezes derrubar uma ponte fantasma antes de desistir e só mostrar o erro. */
const MAX_GHOST_KILLS = 3;

export class RemoteControl {
  /** O usuário ligou nesta conversa (interruptor, comando ou configuração). Só isto faz a ponte subir de novo num processo novo. */
  wanted = false;
  /**
   * O usuário confirmou o Remote Control com o modo bypass. Sair do bypass zera: voltar a ele pede de novo, e o
   * religar depois de reiniciar o processo também pede se o modo virou bypass sem confirmação.
   */
  bypassConfirmed = false;
  state: RemoteControlState = { status: 'off' };
  private epoch?: number;
  /** Cada liga/desliga troca o token: a resposta de um pedido que outro já substituiu não mexe no estado. */
  private token = 0;
  /** Desligar em andamento: frames da ponte que está saindo não contam como ponte fantasma. */
  private disabling = false;
  /** O CLI pode estar com a ponte de pé sem o usuário querer: desligar falhou, ou chegou frame de ponte viva. */
  private maybeAlive = false;
  private ghostInFlight = false;
  /** Tentativas de derrubar ponte fantasma desde o último ligar: sem limite, um CLI teimoso viraria laço. */
  private ghostKills = 0;

  constructor(
    private readonly onChange: (state: RemoteControlState) => void,
    private readonly warn: (text: string) => void = () => undefined,
  ) {}

  get available(): boolean {
    return this.state.status !== 'unavailable';
  }

  /** Mensagem do claude.ai pode chegar: a ponte foi pedida, ou pode ter ficado de pé contra a vontade do usuário. */
  get mayReceive(): boolean {
    return this.wanted || this.maybeAlive;
  }

  /**
   * O modo de permissão mudou (ou o processo vai religar a ponte com este modo). Devolve true quando é preciso
   * perguntar de novo ao usuário: bypass com a ponte querida ou possivelmente de pé, sem confirmação dada nesse bypass.
   */
  needsBypassConfirm(mode: string): boolean {
    if (mode !== 'bypassPermissions') {
      this.bypassConfirmed = false;
      return false;
    }
    return this.mayReceive && !this.bypassConfirmed;
  }

  /** Liga a ponte no processo `api`. Sem processo ainda, só marca a vontade: quem sobe o processo chama de novo. */
  async enable(api: RemoteControlApi | undefined): Promise<void> {
    if (!this.available) {
      return;
    }
    const token = ++this.token;
    this.wanted = true;
    this.disabling = false;
    this.ghostKills = 0;
    this.set({ status: 'connecting', sessionUrl: this.state.sessionUrl });
    if (!api) {
      return;
    }
    try {
      const r = await api.enableRemoteControl(true);
      if (token !== this.token) {
        return;
      }
      if (!r?.session_url) {
        throw new Error('o Claude Code não devolveu o link da sessão');
      }
      this.epoch = r.bridge_epoch;
      this.set({ status: 'connected', sessionUrl: r.session_url, connectUrl: r.connect_url });
    } catch (err) {
      if (token !== this.token) {
        return;
      }
      this.wanted = false;
      this.epoch = undefined;
      const text = errText(err);
      if (/policy|disableRemoteControl|disabled by (your )?organi[sz]ation/i.test(text)) {
        this.set({ status: 'unavailable', reason: text });
      } else {
        this.set({ status: 'disconnected', reason: text });
      }
    }
  }

  /**
   * Desliga. Sem processo não há ponte: vira desligado na hora. Com processo, só mostra desligado depois de o CLI
   * confirmar; se ele recusar, o painel mostra o erro (`stuck`), porque o claude.ai pode continuar mandando mensagens.
   */
  async disable(api: RemoteControlApi | undefined): Promise<void> {
    const token = ++this.token;
    const wasOn = this.wanted || this.maybeAlive || this.state.status === 'connected' || this.state.status === 'connecting' || this.state.status === 'disconnected';
    this.wanted = false;
    this.bypassConfirmed = false;
    this.epoch = undefined;
    if (!wasOn || !api) {
      this.maybeAlive = false;
      if (this.available && this.state.status !== 'off') {
        this.set({ status: 'off' });
      }
      return;
    }
    this.disabling = true;
    try {
      await api.enableRemoteControl(false);
      if (token !== this.token) {
        return;
      }
      this.maybeAlive = false;
      if (this.available) {
        this.set({ status: 'off' });
      }
    } catch (err) {
      if (token !== this.token) {
        return;
      }
      this.maybeAlive = true;
      this.set({
        status: 'disconnected',
        stuck: true,
        sessionUrl: this.state.sessionUrl,
        connectUrl: this.state.connectUrl,
        reason: `o Claude Code não desligou a ponte (${errText(err)}); o claude.ai pode continuar mandando mensagens para cá`,
      });
    } finally {
      if (token === this.token) {
        this.disabling = false;
      }
    }
  }

  /**
   * Frame bridge_state do CLI. Frame de uma ponte anterior (outro bridge_epoch) não conta. Ponte viva sem o usuário
   * querer (fantasma) é derrubada de novo com `api`, com aviso.
   */
  onBridgeState(frame: BridgeStateFrame, api?: RemoteControlApi): void {
    if (!this.wanted && frame.state !== 'policy_disabled') {
      if ((frame.state === 'connected' || frame.state === 'ready') && !this.disabling && this.available) {
        void this.killGhost(api);
      }
      return;
    }
    if (frame.bridge_epoch !== undefined && this.epoch !== undefined && frame.bridge_epoch !== this.epoch) {
      return;
    }
    switch (frame.state) {
      case 'policy_disabled':
        this.wanted = false;
        this.maybeAlive = false;
        this.epoch = undefined;
        this.set({ status: 'unavailable', reason: frame.detail || 'a política da organização desligou o Remote Control' });
        return;
      case 'failed':
        // O CLI marca a ponte como morta; um "connected" do mesmo epoch depois é reconexão. Ligar de novo recria.
        this.set({
          status: 'disconnected',
          sessionUrl: this.state.sessionUrl,
          connectUrl: this.state.connectUrl,
          reason: [frame.detail, frame.failure_kind && frame.failure_kind !== 'terminal' ? `(${frame.failure_kind})` : ''].filter(Boolean).join(' ') || 'a ligação com o claude.ai caiu',
        });
        return;
      case 'connected':
      case 'ready':
        if (this.state.sessionUrl && this.state.status !== 'connecting') {
          this.set({ status: 'connected', sessionUrl: this.state.sessionUrl, connectUrl: this.state.connectUrl });
        }
        return;
    }
  }

  /** Ponte de pé que o usuário não quer: desliga de novo, até MAX_GHOST_KILLS vezes, e avisa. */
  private async killGhost(api: RemoteControlApi | undefined): Promise<void> {
    if (this.ghostInFlight) {
      return;
    }
    this.maybeAlive = true;
    if (!api || this.ghostKills >= MAX_GHOST_KILLS) {
      if (!this.state.stuck) {
        this.set({
          status: 'disconnected',
          stuck: true,
          sessionUrl: this.state.sessionUrl,
          reason: 'o Claude Code continua com a ponte ligada e não desliga; feche este chat para encerrar o processo',
        });
      }
      return;
    }
    this.ghostKills++;
    this.ghostInFlight = true;
    const token = this.token;
    this.warn('O Claude Code estava com o Remote Control ligado sem você pedir. Desligando de novo.');
    try {
      await api.enableRemoteControl(false);
      if (token === this.token && !this.wanted) {
        this.maybeAlive = false;
        if (this.available && this.state.status !== 'off') {
          this.set({ status: 'off' });
        }
      }
    } catch (err) {
      if (token === this.token && !this.wanted) {
        this.set({ status: 'disconnected', stuck: true, sessionUrl: this.state.sessionUrl, reason: `a ponte ficou ligada e o Claude Code não a desligou (${errText(err)})` });
      }
    } finally {
      this.ghostInFlight = false;
    }
  }

  /**
   * O processo do CLI acabou e a ponte foi junto. `restarting`: um processo novo sobe já (raciocínio, navegador, MCP)
   * e liga de novo. Sem isso o processo caiu: a ponte volta quando ele subir de novo (próxima mensagem daqui).
   */
  processEnded(restarting: boolean): void {
    ++this.token;
    this.epoch = undefined;
    this.maybeAlive = false;
    this.disabling = false;
    if (!this.available) {
      return;
    }
    if (!this.wanted) {
      if (this.state.status !== 'off') {
        this.set({ status: 'off' });
      }
    } else if (restarting) {
      this.set({ status: 'connecting', sessionUrl: this.state.sessionUrl, reason: 'o processo do Claude Code reiniciou; ligando de novo' });
    } else {
      this.set({ status: 'disconnected', sessionUrl: this.state.sessionUrl, reason: 'o processo do Claude Code parou; o Remote Control volta com a próxima mensagem enviada daqui' });
    }
  }

  /** `remote_control_available === false` na resposta de initialize, ou conta sem suporte. */
  markUnavailable(reason = UNAVAILABLE): void {
    ++this.token;
    this.wanted = false;
    this.maybeAlive = false;
    this.epoch = undefined;
    this.set({ status: 'unavailable', reason });
  }

  private set(state: RemoteControlState): void {
    this.state = state;
    this.onChange(state);
  }
}

/** Blocos de texto do eco de uma mensagem do usuário, juntos. */
export function replayText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((b: { type?: string; text?: unknown }) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** Tags que o próprio CLI põe no começo de mensagens do usuário (comando de barra, saída de comando, avisos). */
const CLI_TAG = /^<(command-message|command-name|command-args|local-command-[\w-]+|task-notification|system-reminder|bash-[\w-]+)[\s>/]/;

/**
 * O eco (`isReplay`) é de uma mensagem que chegou pelo Remote Control? Só com a ponte possivelmente de pé, uuid que
 * não saiu deste painel, origem humana (ou sem origem), sem `isSynthetic` (avisos do próprio CLI) e sem as tags que o
 * CLI põe em comando de barra, saída de comando e notificação de tarefa.
 */
export function isRemoteEcho(
  m: { uuid?: string; isSynthetic?: boolean; parent_tool_use_id?: string | null; origin?: { kind?: string }; message?: { content?: unknown } },
  own: ReadonlySet<string>,
  mayReceive: boolean,
): boolean {
  if (!mayReceive || m.isSynthetic || m.parent_tool_use_id) {
    return false;
  }
  if (m.origin && m.origin.kind !== 'human') {
    return false;
  }
  if (m.uuid && own.has(m.uuid)) {
    return false;
  }
  const content = m.message?.content;
  if (Array.isArray(content) && content.some((b: { type?: string }) => b?.type === 'tool_result')) {
    return false;
  }
  const text = replayText(content).trim();
  if (!text) {
    return Array.isArray(content) && content.some((b: { type?: string }) => b?.type === 'image');
  }
  return !CLI_TAG.test(text) && !/^<([\w-]+)>[\s\S]*<\/\1>$/.test(text);
}

/** Link que o painel aceita abrir no navegador: só https no claude.ai ou num subdomínio dele. */
export function isClaudeUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return u.protocol === 'https:' && (host === 'claude.ai' || host.endsWith('.claude.ai'));
  } catch {
    return false;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Rótulo curto do estado, para a pílula e o menu. */
export function remoteStatusText(state: RemoteControlState): string {
  switch (state.status) {
    case 'connecting':
      return 'conectando';
    case 'connected':
      return 'conectado';
    case 'disconnected':
      return state.stuck ? 'não desligou' : 'desconectado';
    case 'unavailable':
      return 'indisponível';
    default:
      return 'desligado';
  }
}

/**
 * Linha que o chat ganha quando o estado muda, como o "Remote Control is active" da oficial. Nada quando a
 * mudança não diz nada novo (conectando, ou o mesmo estado de novo).
 */
export function remoteTransitionNotice(prev: RemoteControlState, next: RemoteControlState): { text: string; level: 'info' | 'error' } | undefined {
  if (prev.status === next.status && prev.sessionUrl === next.sessionUrl && prev.reason === next.reason) {
    return undefined;
  }
  switch (next.status) {
    case 'connected':
      if (prev.status === 'connected' && prev.sessionUrl === next.sessionUrl) {
        return undefined;
      }
      return { level: 'info', text: `Remote Control ligado. Continue aqui, no celular (app do Claude) ou em ${next.sessionUrl}` };
    case 'disconnected':
      if (next.stuck) {
        return { level: 'error', text: `Remote Control não desligou: ${next.reason ?? 'motivo não informado'}` };
      }
      return { level: 'error', text: `Remote Control ${prev.status === 'connected' ? 'caiu' : 'não conectou'}: ${next.reason ?? 'motivo não informado'}` };
    case 'unavailable':
      // Só avisa quem tentou ligar: a conta que nunca mexeu nisso (chave de API, por exemplo) não ganha linha a cada chat.
      return prev.status === 'off' || prev.status === 'unavailable' ? undefined : { level: 'error', text: `Remote Control indisponível: ${next.reason ?? 'o Claude Code não permite aqui'}` };
    case 'off':
      return prev.status === 'connected' || prev.status === 'disconnected' || prev.status === 'connecting'
        ? { level: 'info', text: 'Remote Control desligado. A sessão no claude.ai não recebe nem manda mais nada daqui.' }
        : undefined;
    default:
      return undefined;
  }
}
