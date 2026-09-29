/**
 * Chamada única a um modelo Claude que devolve a resposta por uma ferramenta estruturada: juiz de partida,
 * gerador e evolução de candidatos do torneio. Não é um agente do mapa: sem ferramentas do Claude Code, sem
 * CLAUDE.md, sem outros servidores MCP e sem sessão gravada. Só o prompt e a ferramenta de resposta.
 */
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type { ZodRawShape } from 'zod';
import type { Profile } from '../../profiles';
import { resolveClaudeExecutable } from '../../claudePath';
import { profileEnv } from '../session';

export interface OneShotRequest<S extends ZodRawShape> {
  profile: Profile;
  cwd: string;
  model: string;
  system: string;
  prompt: string;
  toolName: string;
  toolDescription: string;
  shape: S;
  signal: AbortSignal;
}

export interface OneShotResult<T> {
  value?: T;
  costUsd: number;
  tokens: number;
  error?: string;
}

const SERVER = 'resposta';

export async function oneShot<S extends ZodRawShape, T>(req: OneShotRequest<S>): Promise<OneShotResult<T>> {
  const executable = await resolveClaudeExecutable();
  if (!executable) {
    return { costUsd: 0, tokens: 0, error: 'Não achei o executável do Claude Code (agentGraphMaster.claudePath).' };
  }
  let value: T | undefined;
  const server = createSdkMcpServer({
    name: SERVER,
    version: '1.0.0',
    tools: [
      tool(req.toolName, req.toolDescription, req.shape, async (args) => {
        value ??= args as T;
        return { content: [{ type: 'text' as const, text: 'Recebido. Encerre sem mais texto.' }] };
      }),
    ],
  });
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  req.signal.addEventListener('abort', onAbort, { once: true });
  let costUsd = 0;
  let tokens = 0;
  let error: string | undefined;
  try {
    const q = query({
      prompt: req.prompt,
      options: {
        pathToClaudeCodeExecutable: executable,
        cwd: req.cwd,
        // Conectores do claude.ai (Slack, Drive...) só gastariam contexto aqui.
        env: { ...profileEnv(req.profile), ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
        model: req.model,
        systemPrompt: req.system,
        tools: [],
        mcpServers: { [SERVER]: server },
        strictMcpConfig: true,
        // Sem ferramentas embutidas e só este servidor: a única coisa que o modelo pode chamar é a resposta.
        allowedTools: [`mcp__${SERVER}__${req.toolName}`],
        settingSources: [],
        persistSession: false,
        maxTurns: 3,
        abortController: abort,
      },
    });
    for await (const m of q) {
      if (m.type === 'result') {
        costUsd = m.total_cost_usd ?? 0;
        const u = m.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
        tokens = (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);
        if (m.subtype !== 'success' && !value) {
          error = `terminou com ${m.subtype}`;
        }
      }
    }
  } catch (err) {
    error = req.signal.aborted ? 'interrompido' : err instanceof Error ? err.message : String(err);
  } finally {
    req.signal.removeEventListener('abort', onAbort);
  }
  if (!value && !error) {
    error = `o modelo não chamou ${req.toolName}`;
  }
  return { value, costUsd, tokens, error: value ? undefined : error };
}

/** Roda `jobs` com no máximo `limit` ao mesmo tempo, na ordem. */
export async function pool<T>(jobs: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, jobs.length)) }, worker));
  return out;
}
