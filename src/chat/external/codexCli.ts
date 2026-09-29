import * as fs from 'fs';
import type { Profile } from '../../profiles';
import { codexEnv } from '../../codex';
import { resolveCodexExecutable } from '../../codexPath';
import { CodexRpc, unsupported } from '../codexRpc';
import { GeneratedImage, RESEARCH_RULES, Source, hostOf, linksIn } from './types';

/**
 * Pesquisa e imagem pelo Codex CLI já logado (assinatura do ChatGPT). Cada pedido sobe um `codex app-server`,
 * abre uma thread efêmera (não aparece no histórico do Codex), roda um turno e encerra. O token da conta fica
 * com o CLI; a extensão só conversa com o processo.
 *
 * - Pesquisa: thread com `web_search = "live"`. Os itens `webSearch` trazem título e URL de cada resultado.
 * - Imagem: a ferramenta de geração de imagem do Codex devolve um item `imageGeneration` com o PNG em base64.
 */

const RESEARCH_TIMEOUT_MS = 4 * 60_000;
const IMAGE_TIMEOUT_MS = 6 * 60_000;

type Item = { type: string; [key: string]: any };

interface TurnOutput {
  finalText: string;
  items: Item[];
}

const NO_TOOLS =
  'Você atende um pedido vindo de outra ferramenta. Não rode comandos, não leia nem altere arquivos e não faça perguntas: faça só o que o pedido diz e responda.';

export async function codexResearch(profile: Profile, cwd: string, prompt: string): Promise<{ text: string; sources: Source[] }> {
  const out = await runTurn(profile, cwd, {
    config: { web_search: 'live' },
    developerInstructions: `${NO_TOOLS} ${RESEARCH_RULES}`,
    prompt,
    timeoutMs: RESEARCH_TIMEOUT_MS,
  });
  if (!out.finalText.trim()) {
    throw new Error('o Codex terminou a pesquisa sem resposta');
  }
  // As fontes citadas no texto vêm primeiro; os resultados de busca completam quando o texto não cita nada.
  const cited = linksIn(out.finalText);
  const searched: Source[] = [];
  for (const item of out.items) {
    if (item.type !== 'webSearch') {
      continue;
    }
    for (const r of Array.isArray(item.results) ? item.results : []) {
      if (typeof r?.url === 'string') {
        searched.push({ title: typeof r.title === 'string' && r.title ? r.title : hostOf(r.url), url: r.url });
      }
    }
    if (item.action?.type === 'open_page' && typeof item.action.url === 'string') {
      searched.push({ title: hostOf(item.action.url), url: item.action.url });
    }
  }
  const sources = cited.length ? cited : dedupe(searched).slice(0, 8);
  return { text: out.finalText.trim(), sources };
}

export async function codexImages(profile: Profile, cwd: string, prompt: string, count: number, size?: string): Promise<GeneratedImage[]> {
  const shape = sizeHint(size);
  const ask = [
    count > 1
      ? `Gere ${count} imagens distintas com a ferramenta de geração de imagem, uma chamada por imagem.`
      : 'Gere uma imagem com a ferramenta de geração de imagem.',
    shape,
    `Descrição: ${prompt}`,
    'Não escreva código nem salve arquivos: só gere e responda "pronto".',
  ]
    .filter(Boolean)
    .join('\n');
  const out = await runTurn(profile, cwd, { config: {}, developerInstructions: NO_TOOLS, prompt: ask, timeoutMs: IMAGE_TIMEOUT_MS });
  const images: GeneratedImage[] = [];
  for (const item of out.items) {
    if (item.type !== 'imageGeneration' || item.status === 'failed') {
      continue;
    }
    let bytes: Buffer | undefined;
    if (typeof item.result === 'string' && item.result.length > 100) {
      bytes = Buffer.from(item.result, 'base64');
    } else if (typeof item.savedPath === 'string' && fs.existsSync(item.savedPath)) {
      bytes = await fs.promises.readFile(item.savedPath);
    }
    if (bytes?.length) {
      images.push({ bytes, revisedPrompt: typeof item.revisedPrompt === 'string' ? item.revisedPrompt : undefined });
    }
  }
  if (!images.length) {
    const said = out.finalText.trim();
    throw new Error(`o Codex não gerou imagem${said ? `. Resposta dele: ${said.slice(0, 300)}` : ''}`);
  }
  return images.slice(0, count);
}

function sizeHint(size?: string): string {
  const m = /^(\d+)x(\d+)$/.exec(size ?? '');
  if (!m) {
    return '';
  }
  const [w, h] = [Number(m[1]), Number(m[2])];
  return w === h ? 'Formato quadrado.' : w > h ? `Formato paisagem (${w}x${h}).` : `Formato retrato (${w}x${h}).`;
}

function dedupe(list: Source[]): Source[] {
  const seen = new Set<string>();
  return list.filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true)));
}

async function runTurn(
  profile: Profile,
  cwd: string,
  opts: { config: Record<string, unknown>; developerInstructions: string; prompt: string; timeoutMs: number },
): Promise<TurnOutput> {
  const exe = await resolveCodexExecutable();
  if (!exe) {
    throw new Error('Codex CLI não encontrado (npm i -g @openai/codex)');
  }
  const items: Item[] = [];
  let finalText = '';
  let lastText = '';
  let settle: { resolve: () => void; reject: (e: Error) => void } | undefined;
  const done = new Promise<void>((resolve, reject) => (settle = { resolve, reject }));
  const rpc = new CodexRpc(exe, codexEnv(profile), cwd, {
    notification: (method, params) => {
      if (method === 'item/completed' && params?.item) {
        const item = params.item as Item;
        items.push(item);
        if (item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) {
          lastText = item.text;
          if (item.phase === 'final_answer') {
            finalText = item.text;
          }
        }
      } else if (method === 'turn/completed') {
        const turn = params?.turn;
        if (turn?.status === 'failed') {
          settle?.reject(new Error(turn.error?.message ?? 'o turno do Codex falhou'));
        } else {
          settle?.resolve();
        }
      } else if (method === 'error' && params?.willRetry === false) {
        settle?.reject(new Error(params?.error?.message ?? 'erro do Codex'));
      }
    },
    // Aprovações e perguntas não têm quem responda aqui: recusa tudo.
    request: async (method) => {
      if (method.endsWith('requestApproval')) {
        return { decision: 'decline' };
      }
      throw unsupported(method);
    },
    exit: (info) => {
      if (!info.expected) {
        settle?.reject(new Error(`o processo do Codex parou${info.stderr ? `: ${info.stderr.trim().split('\n').pop()}` : ''}`));
      }
    },
  });
  const timer = setTimeout(() => settle?.reject(new Error(`o Codex não terminou em ${Math.round(opts.timeoutMs / 60000)} min`)), opts.timeoutMs);
  try {
    await rpc.start();
    const account = await rpc.request<{ account: unknown; requiresOpenaiAuth: boolean }>('account/read', { refreshToken: false }, 20000).catch(() => undefined);
    if (account && !account.account && account.requiresOpenaiAuth) {
      throw new Error(`a conta Codex "${profile.name}" não tem login`);
    }
    const thread = await rpc.request<{ thread: { id: string } }>(
      'thread/start',
      { cwd, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true, config: opts.config, developerInstructions: opts.developerInstructions },
      60000,
    );
    await rpc.request('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: opts.prompt }], effort: 'low' }, 60000);
    await done;
    return { finalText: finalText || lastText, items };
  } finally {
    clearTimeout(timer);
    rpc.dispose();
  }
}
