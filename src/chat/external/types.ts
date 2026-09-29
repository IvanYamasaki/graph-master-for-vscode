/** Quem atende a pesquisa ou a imagem: Gemini (Google) ou OpenAI (GPT). */
export type ExternalProvider = 'gemini' | 'openai';

export const PROVIDER_LABEL: Record<ExternalProvider, string> = { gemini: 'Gemini', openai: 'GPT' };

export interface Source {
  title: string;
  url: string;
}

export interface ResearchResult {
  provider: ExternalProvider;
  /** Caminho usado, para o usuário saber o que foi cobrado: "Codex CLI", "Antigravity (Gemini)", "API". */
  via: string;
  text: string;
  sources: Source[];
}

export interface GeneratedImage {
  bytes: Buffer;
  /** Prompt reescrito pelo modelo, quando ele informa. */
  revisedPrompt?: string;
}

export interface ImageResult {
  provider: ExternalProvider;
  via: string;
  images: GeneratedImage[];
  model?: string;
}

export interface ImageOptions {
  /** "1024x1024", "1536x1024", "1024x1536" ou "auto". */
  size?: string;
  count?: number;
}

/** Provedor sem CLI logado e sem chave. O chat mostra um aviso com botão para configurar a chave. */
export class ProviderUnavailableError extends Error {
  constructor(
    readonly provider: ExternalProvider,
    message: string,
  ) {
    super(message);
  }
}

/** Links markdown e URLs soltas de um texto, sem repetir. */
export function linksIn(text: string): Source[] {
  const found = new Map<string, Source>();
  for (const m of text.matchAll(/\[([^\]\n]{1,200})\]\((https?:\/\/[^)\s]+)\)/g)) {
    if (!found.has(m[2])) {
      found.set(m[2], { title: m[1].trim(), url: m[2] });
    }
  }
  for (const m of text.matchAll(/(?<![(\[])\bhttps?:\/\/[^\s)<>\]]+/g)) {
    const url = m[0].replace(/[.,;:]+$/, '');
    if (!found.has(url)) {
      found.set(url, { title: hostOf(url), url });
    }
  }
  return [...found.values()];
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Instrução comum dos pedidos de pesquisa, para a resposta vir no mesmo formato por qualquer caminho. */
export const RESEARCH_RULES =
  'Pesquise na web e responda em markdown, no idioma da pergunta, de forma direta e sem enrolação. Cite só o que encontrou nas fontes. Termine com uma seção "Fontes:" listando cada fonte usada como link markdown [título](url).';

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
