import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { GeneratedImage, RESEARCH_RULES, Source, linksIn } from './types';

/**
 * Gemini por dois caminhos:
 * - Antigravity CLI (`agy`) logado com a conta Google: pesquisa com as ferramentas search_web e read_url_content
 *   dele, em modo não interativo (`-p ... --output-format json`).
 * - API do Gemini com chave do usuário: pesquisa com grounding no Google Search e imagem com um modelo de imagem.
 *   Os modelos saem de GET /v1beta/models.
 *
 * O Gemini CLI (`@google/gemini-cli`) saiu: desde 18/06/2026 o Google não atende mais o Gemini CLI em contas
 * pessoais (Code Assist individual, Google AI Pro e Ultra), e o substituto oficial é o agy.
 * O agy tem uma ferramenta generate_image, mas em 29/09/2026 ela respondia 500 a toda chamada numa conta Google
 * AI Pro; por isso a imagem do Gemini segue só pela chave.
 */

const API = 'https://generativelanguage.googleapis.com/v1beta';
const AGY_TIMEOUT_MS = 4 * 60_000;

/**
 * Configuração do agy para a pesquisa. Busca e leitura de URL liberadas; shell, escrita, MCP e URL executável
 * negados (deny vence allow). Leitura fora do diretório de trabalho pede aprovação, e no modo -p pedido de
 * aprovação é recusado sem perguntar.
 */
function agySettings(workDir: string): unknown {
  return {
    toolPermission: 'request-review',
    trustedWorkspaces: [workDir],
    permissions: {
      allow: ['read_url(*)'],
      deny: ['command(*)', 'unsandboxed(*)', 'write_file(*)', 'mcp(*)', 'execute_url(*)'],
    },
  };
}

interface AgyResult {
  status?: string;
  response?: string;
  error?: string | { message?: string };
  denied_actions?: { action?: string }[];
}

/**
 * Roda o agy numa pasta pessoal temporária (USERPROFILE/HOME trocados): ele lê dali o settings.json acima, em vez
 * do ~/.gemini/antigravity-cli do usuário, e o histórico da conversa não entra no do usuário. O login fica no
 * cofre do sistema, que não depende da pasta pessoal. O diretório de trabalho é uma pasta vazia dentro dela, e
 * tudo é apagado no fim.
 */
export async function agyResearch(exe: string, prompt: string, model: string): Promise<{ text: string; sources: Source[] }> {
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agm-agy-'));
  const work = path.join(home, 'work');
  try {
    await fs.promises.mkdir(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    await fs.promises.mkdir(work);
    await fs.promises.writeFile(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify(agySettings(work), null, 2));
    const full = `${RESEARCH_RULES} Use a busca do Google (search_web) e leia as páginas que precisar. Não rode comandos, não leia nem altere arquivos e não faça perguntas.\n\nPedido: ${prompt}`;
    const args = ['-p', full, '--output-format', 'json', '--disable-slash-commands', ...(model ? ['--model', model] : [])];
    const { stdout, stderr, code } = await run(exe, args, work, { ...process.env, USERPROFILE: home, HOME: home });
    const start = stdout.indexOf('{');
    let parsed: AgyResult | undefined;
    try {
      parsed = start >= 0 ? (JSON.parse(stdout.slice(start)) as AgyResult) : undefined;
    } catch {
      parsed = undefined;
    }
    if (parsed?.status === 'SUCCESS' && parsed.response?.trim()) {
      return { text: parsed.response.trim(), sources: linksIn(parsed.response) };
    }
    const err = typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message;
    const denied = parsed?.denied_actions?.map((d) => d.action).filter(Boolean).join(', ');
    const why = err || (denied ? `ferramenta recusada (${denied})` : '') || stderr.trim().split('\n').pop() || '';
    throw new Error(`o agy terminou ${parsed?.status ? `com status ${parsed.status}` : `com código ${code}`} e sem resposta${why ? `: ${why}` : ''}`);
  } finally {
    // O servidor do agy pode segurar arquivos por um instante depois de sair.
    await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  }
}

function run(exe: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`o agy não terminou em ${AGY_TIMEOUT_MS / 60000} min`));
    }, AGY_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (stdout += d));
    child.stderr.on('data', (d: string) => (stderr = (stderr + d).slice(-3000)));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

// ---------- API ----------

interface GeminiModel {
  name: string;
  supportedGenerationMethods?: string[];
}

let modelCache: { key: string; list: GeminiModel[] } | undefined;

async function call<T>(key: string, route: string, body?: unknown, timeoutMs = 180_000): Promise<T> {
  const res = await fetch(`${API}/${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-goog-api-key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      // Fica o começo do corpo.
    }
    throw new Error(`API do Gemini respondeu ${res.status}: ${message}`);
  }
  return JSON.parse(text) as T;
}

export async function listGeminiModels(key: string): Promise<GeminiModel[]> {
  if (modelCache?.key === key) {
    return modelCache.list;
  }
  const list: GeminiModel[] = [];
  let page = '';
  do {
    const res = await call<{ models?: GeminiModel[]; nextPageToken?: string }>(key, `models?pageSize=1000${page ? `&pageToken=${page}` : ''}`, undefined, 30_000);
    list.push(...(res.models ?? []));
    page = res.nextPageToken ?? '';
  } while (page);
  modelCache = { key, list };
  return list;
}

/** Número de versão do nome ("gemini-2.5-flash" → 2.5), para preferir o mais novo. */
function version(name: string): number {
  return Number(/gemini-(\d+(?:\.\d+)?)/.exec(name)?.[1] ?? 0);
}

const bare = (m: GeminiModel) => m.name.replace(/^models\//, '');
const canGenerate = (m: GeminiModel) => m.supportedGenerationMethods?.includes('generateContent');

async function textModel(key: string, configured: string): Promise<string> {
  if (configured) {
    return configured;
  }
  const flash = (await listGeminiModels(key))
    .filter((m) => canGenerate(m) && /^models\/gemini-[\d.]+-flash$/.test(m.name))
    .sort((a, b) => version(b.name) - version(a.name));
  const any = (await listGeminiModels(key)).filter((m) => canGenerate(m) && /^models\/gemini-/.test(m.name) && !/image|tts|live|audio|embed/.test(m.name));
  const pick = flash[0] ?? any.sort((a, b) => version(b.name) - version(a.name))[0];
  if (!pick) {
    throw new Error('a chave do Gemini não lista modelo gemini-* de texto');
  }
  return bare(pick);
}

async function imageModel(key: string, configured: string): Promise<string> {
  if (configured) {
    return configured;
  }
  const pick = (await listGeminiModels(key))
    .filter((m) => canGenerate(m) && /^models\/gemini-.*image/.test(m.name))
    .sort((a, b) => version(b.name) - version(a.name) || Number(/preview/.test(a.name)) - Number(/preview/.test(b.name)))[0];
  if (!pick) {
    throw new Error('a chave do Gemini não lista modelo de imagem (gemini-*-image) com generateContent');
  }
  return bare(pick);
}

interface GenerateResponse {
  candidates?: {
    content?: { parts?: { text?: string; inlineData?: { mimeType?: string; data?: string } }[] };
    groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
}

export async function geminiApiResearch(key: string, prompt: string, configuredModel: string): Promise<{ text: string; sources: Source[]; model: string }> {
  const model = await textModel(key, configuredModel);
  const res = await call<GenerateResponse>(key, `models/${model}:generateContent`, {
    systemInstruction: { parts: [{ text: RESEARCH_RULES }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
  });
  const cand = res.candidates?.[0];
  const text = (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
  if (!text) {
    throw new Error(`a API do Gemini respondeu sem texto${res.promptFeedback?.blockReason ? ` (bloqueado: ${res.promptFeedback.blockReason})` : ''}`);
  }
  const sources = new Map<string, Source>();
  for (const chunk of cand?.groundingMetadata?.groundingChunks ?? []) {
    if (chunk.web?.uri && !sources.has(chunk.web.uri)) {
      sources.set(chunk.web.uri, { title: chunk.web.title || chunk.web.uri, url: chunk.web.uri });
    }
  }
  return { text, sources: sources.size ? [...sources.values()] : linksIn(text), model };
}

function aspectRatio(size?: string): string | undefined {
  const m = /^(\d+)x(\d+)$/.exec(size ?? '');
  if (!m) {
    return undefined;
  }
  const r = Number(m[1]) / Number(m[2]);
  const options: [string, number][] = [['1:1', 1], ['3:2', 1.5], ['2:3', 2 / 3], ['16:9', 16 / 9], ['9:16', 9 / 16], ['4:3', 4 / 3], ['3:4', 0.75]];
  return options.reduce((best, cur) => (Math.abs(cur[1] - r) < Math.abs(best[1] - r) ? cur : best))[0];
}

export async function geminiApiImages(key: string, prompt: string, count: number, size: string | undefined, configuredModel: string): Promise<{ images: GeneratedImage[]; model: string }> {
  const model = await imageModel(key, configuredModel);
  const ratio = aspectRatio(size);
  const images: GeneratedImage[] = [];
  // Uma chamada por imagem: o generateContent devolve uma imagem por resposta.
  for (let i = 0; i < count; i++) {
    const body = (withRatio: boolean) => ({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], ...(withRatio && ratio ? { imageConfig: { aspectRatio: ratio } } : {}) },
    });
    let res: GenerateResponse;
    try {
      res = await call<GenerateResponse>(key, `models/${model}:generateContent`, body(true), 300_000);
    } catch (err) {
      // Modelo que não aceita imageConfig: tenta de novo sem a proporção.
      if (!ratio || !/imageConfig|aspect/i.test(String(err))) {
        throw err;
      }
      res = await call<GenerateResponse>(key, `models/${model}:generateContent`, body(false), 300_000);
    }
    for (const part of res.candidates?.[0]?.content?.parts ?? []) {
      if (part.inlineData?.data) {
        images.push({ bytes: Buffer.from(part.inlineData.data, 'base64') });
      }
    }
  }
  if (!images.length) {
    throw new Error('a API do Gemini não devolveu imagem');
  }
  return { images: images.slice(0, count), model };
}
