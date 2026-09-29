import { GeneratedImage, RESEARCH_RULES, Source, linksIn } from './types';

/**
 * OpenAI pela API, com chave do usuário (cobrada à parte da assinatura do ChatGPT). Só entra quando o Codex CLI
 * não está logado ou quando falha. Os nomes de modelo saem de GET /v1/models: nada de chutar.
 */

const BASE = 'https://api.openai.com/v1';

interface ModelEntry {
  id: string;
  created?: number;
}

let modelCache: { key: string; list: ModelEntry[] } | undefined;

async function call<T>(key: string, path: string, body?: unknown, timeoutMs = 180_000): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      // Corpo que não é JSON: fica o começo dele.
    }
    throw new Error(`API da OpenAI respondeu ${res.status}: ${message}`);
  }
  return JSON.parse(text) as T;
}

export async function listOpenAIModels(key: string): Promise<ModelEntry[]> {
  if (modelCache?.key === key) {
    return modelCache.list;
  }
  const res = await call<{ data: ModelEntry[] }>(key, '/models', undefined, 30_000);
  modelCache = { key, list: res.data };
  return res.data;
}

/** Modelo de texto para a pesquisa: o configurado, senão o gpt-* de conversa mais novo da conta, preferindo os "mini" (mais baratos). */
async function textModel(key: string, configured: string): Promise<string> {
  if (configured) {
    return configured;
  }
  const chat = (await listOpenAIModels(key))
    .filter((m) => /^gpt-\d/.test(m.id) && !/image|audio|realtime|transcribe|tts|search|codex|instruct|embed|\d{4}-\d{2}-\d{2}/.test(m.id))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  const pick = chat.find((m) => /mini/.test(m.id)) ?? chat[0];
  if (!pick) {
    throw new Error('a chave da OpenAI não lista nenhum modelo gpt-* de texto');
  }
  return pick.id;
}

async function imageModel(key: string, configured: string): Promise<string> {
  if (configured) {
    return configured;
  }
  const list = (await listOpenAIModels(key)).sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  const pick = list.find((m) => /^gpt-image/.test(m.id)) ?? list.find((m) => /^dall-e-3/.test(m.id));
  if (!pick) {
    throw new Error('a chave da OpenAI não lista modelo de imagem (gpt-image-* ou dall-e-3)');
  }
  return pick.id;
}

interface ResponsesOutput {
  output?: {
    type: string;
    content?: { type: string; text?: string; annotations?: { type: string; url?: string; title?: string }[] }[];
  }[];
}

export async function openaiResearch(key: string, prompt: string, configuredModel: string): Promise<{ text: string; sources: Source[]; model: string }> {
  const model = await textModel(key, configuredModel);
  const res = await call<ResponsesOutput>(key, '/responses', {
    model,
    instructions: RESEARCH_RULES,
    input: prompt,
    tools: [{ type: 'web_search' }],
  });
  const parts: string[] = [];
  const sources = new Map<string, Source>();
  for (const out of res.output ?? []) {
    if (out.type !== 'message') {
      continue;
    }
    for (const c of out.content ?? []) {
      if (c.type === 'output_text' && c.text) {
        parts.push(c.text);
        for (const a of c.annotations ?? []) {
          if (a.type === 'url_citation' && a.url && !sources.has(a.url)) {
            sources.set(a.url, { title: a.title || a.url, url: a.url });
          }
        }
      }
    }
  }
  const text = parts.join('\n\n').trim();
  if (!text) {
    throw new Error('a API da OpenAI respondeu sem texto');
  }
  return { text, sources: sources.size ? [...sources.values()] : linksIn(text), model };
}

export async function openaiImages(key: string, prompt: string, count: number, size: string | undefined, configuredModel: string): Promise<{ images: GeneratedImage[]; model: string }> {
  const model = await imageModel(key, configuredModel);
  const body: Record<string, unknown> = { model, prompt, n: count };
  if (size && size !== 'auto') {
    body.size = size;
  }
  if (model.startsWith('dall-e')) {
    body.response_format = 'b64_json';
  }
  const res = await call<{ data: { b64_json?: string; revised_prompt?: string }[] }>(key, '/images/generations', body, 300_000);
  const images = res.data.filter((d) => d.b64_json).map((d) => ({ bytes: Buffer.from(d.b64_json!, 'base64'), revisedPrompt: d.revised_prompt }));
  if (!images.length) {
    throw new Error('a API da OpenAI não devolveu imagem');
  }
  return { images, model };
}
