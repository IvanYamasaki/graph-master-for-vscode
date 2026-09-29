import { spawn } from 'child_process';
import type { ConnectedBrowser } from './protocol';

const PROBE_TIMEOUT_MS = 15_000;

/**
 * Pergunta à ponte do Claude in Chrome (`claude --claude-in-chrome-mcp`, o mesmo servidor stdio que o CLI sobe com
 * `--chrome`) quais navegadores estão conectados à conta. Só chama `list_connected_browsers`, que é leitura, e não
 * passa pelo modelo: não gasta token. Leva cerca de 1,5 s.
 */
export function probeBrowsers(executable: string, env: Record<string, string | undefined>): Promise<ConnectedBrowser[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--claude-in-chrome-mcp'], { env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buffer = '';
    let done = false;
    const finish = (err: Error | undefined, list?: ConnectedBrowser[]) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      child.kill();
      if (err) {
        reject(err);
      } else {
        resolve(list ?? []);
      }
    };
    const timer = setTimeout(() => finish(new Error('A ponte do Claude in Chrome não respondeu.')), PROBE_TIMEOUT_MS);
    const write = (msg: object) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    child.on('error', (err) => finish(err));
    child.on('exit', () => finish(new Error('A ponte do Claude in Chrome fechou antes de responder.')));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) {
          continue;
        }
        let msg: { id?: number; result?: { content?: { type: string; text?: string }[]; isError?: boolean }; error?: { message?: string } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          write({ jsonrpc: '2.0', method: 'notifications/initialized' });
          write({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_connected_browsers', arguments: {} } });
        } else if (msg.id === 2) {
          const text = msg.result?.content?.find((c) => c.type === 'text')?.text ?? '';
          if (msg.error || msg.result?.isError) {
            finish(new Error(msg.error?.message ?? text ?? 'erro ao listar navegadores'));
            return;
          }
          finish(undefined, parseBrowsers(text));
        }
      }
    });
    write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-graph-master', version: '0' } } });
  });
}

/** O texto é um JSON com a lista; sem navegador, a ponte responde em prosa, e isso vira lista vazia. */
export function parseBrowsers(text: string): ConnectedBrowser[] {
  try {
    const raw = JSON.parse(text) as unknown;
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
      .map((b) => ({
        name: String(b.name ?? 'navegador'),
        osPlatform: typeof b.osPlatform === 'string' ? b.osPlatform : undefined,
        isLocal: typeof b.isLocal === 'boolean' ? b.isLocal : undefined,
        inUse: typeof b.inUse === 'boolean' ? b.inUse : undefined,
      }));
  } catch {
    return [];
  }
}
