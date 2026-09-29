import { ChildProcessWithoutNullStreams, execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as readline from 'readline';

/**
 * Cliente do `codex app-server`: o mesmo protocolo que a extensão oficial da OpenAI usa. JSON-RPC 2.0 sem o campo
 * "jsonrpc", uma mensagem JSON por linha no stdin/stdout. O servidor manda notificações (eventos do turno) e
 * também pedidos (aprovação de comando, de edição, pergunta ao usuário), que precisam de resposta com o mesmo id.
 */

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> };

export class CodexRpcError extends Error {
  constructor(readonly method: string, readonly rpc: RpcError) {
    super(rpc.message);
  }
}

export interface CodexRpcHandlers {
  notification: (method: string, params: any) => void;
  /** Pedido do servidor. Devolva o `result`; exceção vira resposta de erro. */
  request: (method: string, params: any, id: number | string) => Promise<unknown>;
  /** O processo saiu. `expected` quando fomos nós que encerramos. */
  exit: (info: { code: number | null; expected: boolean; stderr: string }) => void;
}

const CLIENT_INFO = { name: 'agent_graph_master', title: 'Agent Graph Master', version: '0.4.0' };

export class CodexRpc {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closing = false;
  /** Fim do stderr, para explicar uma saída inesperada. */
  private stderrTail = '';
  userAgent = '';
  codexHome = '';

  constructor(
    private readonly exe: string,
    private readonly env: Record<string, string>,
    private readonly cwd: string,
    private readonly handlers: CodexRpcHandlers,
  ) {}

  get alive(): boolean {
    return !!this.child && !this.closing;
  }

  /** Sobe o processo e faz o aperto de mão `initialize` / `initialized`. */
  async start(): Promise<void> {
    // Pasta inexistente faz o spawn falhar com ENOENT, que parece "binário não achado". A thread recebe o cwd à parte.
    const cwd = fs.existsSync(this.cwd) ? this.cwd : undefined;
    const child = spawn(this.exe, ['app-server'], { env: this.env, cwd, windowsHide: true, stdio: 'pipe' });
    this.child = child;
    child.stdin.on('error', () => undefined);
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    child.stderr.on('data', (d) => {
      this.stderrTail = (this.stderrTail + String(d)).slice(-4000);
    });
    child.on('error', (err) => this.onExit(null, err.message));
    child.on('exit', (code) => this.onExit(code));

    const init = (await this.request('initialize', {
      clientInfo: CLIENT_INFO,
      capabilities: { experimentalApi: false, requestAttestation: false },
    })) as { userAgent?: string; codexHome?: string };
    this.userAgent = init.userAgent ?? '';
    this.codexHome = init.codexHome ?? '';
    this.notify('initialized');
  }

  request<T = any>(method: string, params?: unknown, timeoutMs = 0): Promise<T> {
    if (!this.child || this.closing) {
      return Promise.reject(new Error('o processo do Codex não está rodando'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { resolve: resolve as (v: unknown) => void, reject };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${method}: sem resposta em ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  dispose(): void {
    if (!this.child || this.closing) {
      return;
    }
    this.closing = true;
    const child = this.child;
    try {
      child.stdin.end();
    } catch {
      // stdin já fechado.
    }
    // O app-server abre filhos (comandos, servidores MCP). No Windows, matar só o pai deixaria esses órfãos.
    if (process.platform === 'win32' && child.pid) {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => undefined);
    } else {
      child.kill();
    }
  }

  private write(msg: unknown): void {
    try {
      this.child?.stdin.write(`${JSON.stringify(msg)}\n`);
    } catch {
      // O processo morreu no meio; o evento de saída cuida do resto.
    }
  }

  private onLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    let msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: RpcError };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      void this.answer(msg.id, msg.method, msg.params);
    } else if (msg.method !== undefined) {
      try {
        this.handlers.notification(msg.method, msg.params);
      } catch (err) {
        console.error('[codex] erro tratando notificação', msg.method, err);
      }
    } else if (typeof msg.id === 'number') {
      const entry = this.pending.get(msg.id);
      if (!entry) {
        return;
      }
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(new CodexRpcError('', msg.error));
      } else {
        entry.resolve(msg.result);
      }
    }
  }

  private async answer(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.handlers.request(method, params, id);
      this.write({ id, result });
    } catch (err) {
      const rpc = err instanceof CodexRpcError ? err.rpc : { code: -32603, message: err instanceof Error ? err.message : String(err) };
      this.write({ id, error: rpc });
    }
  }

  private onExit(code: number | null, reason?: string): void {
    if (!this.child) {
      return;
    }
    this.child = undefined;
    const expected = this.closing;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason ?? 'o processo do Codex encerrou'));
    }
    this.pending.clear();
    this.handlers.exit({ code, expected, stderr: reason ?? this.stderrTail });
  }
}

/** Resposta de erro "método não suportado" para pedidos do servidor que este cliente não implementa. */
export function unsupported(method: string): CodexRpcError {
  return new CodexRpcError(method, { code: -32601, message: `${method} não é suportado por este cliente` });
}
