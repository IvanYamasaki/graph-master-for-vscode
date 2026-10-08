/**
 * show_image: o agente mostra ao usuário imagens que já estão no disco (prints, capturas, gráficos). Este módulo é
 * puro (sem fs) porque o webview também o importa: o resultado da ferramenta leva os caminhos absolutos numa linha
 * marcada, e o chat monta a bolha de imagens a partir dela, ao vivo e no replay do histórico.
 */

export const SHOW_IMAGE_TOOL = 'mcp__agents__show_image';

/** Teto por arquivo. Acima disso a ferramenta recusa com erro claro. */
export const MAX_SHOW_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_SHOW_IMAGES = 10;

/** SVG entra só como <img>, onde o navegador não roda script nem carrega recurso externo. */
export const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

export function imageMime(file: string): string | undefined {
  const m = /\.[^./\\]+$/.exec(file);
  return m ? IMAGE_MIME[m[0].toLowerCase()] : undefined;
}

export interface ShownImages {
  paths: string[];
  caption?: string;
}

const MARK = 'show_image:';

/** Texto do resultado: uma frase para o modelo e a linha marcada que o chat lê. */
export function formatShowImage(shown: ShownImages, refused: string[]): string {
  const n = shown.paths.length;
  const lines = [`${n === 1 ? 'Imagem mostrada' : `${n} imagens mostradas`} ao usuário no chat. Você não vê a imagem por aqui; não descreva de novo o que ela mostra.`];
  if (refused.length) {
    lines.push('', 'Ficaram de fora:', ...refused.map((r) => `- ${r}`));
  }
  lines.push('', `${MARK} ${JSON.stringify({ paths: shown.paths, caption: shown.caption || undefined })}`);
  return lines.join('\n');
}

/** Lê a linha marcada de um resultado do show_image. Undefined se o texto não tem a marca ou ela está quebrada. */
export function parseShowImage(text: string): ShownImages | undefined {
  const line = text.split('\n').find((l) => l.startsWith(MARK));
  if (!line) {
    return undefined;
  }
  try {
    const raw = JSON.parse(line.slice(MARK.length)) as { paths?: unknown; caption?: unknown };
    const paths = Array.isArray(raw.paths) ? raw.paths.filter((p): p is string => typeof p === 'string' && !!p) : [];
    if (!paths.length) {
      return undefined;
    }
    return { paths, caption: typeof raw.caption === 'string' && raw.caption.trim() ? raw.caption : undefined };
  } catch {
    return undefined;
  }
}

/** Nome do arquivo, para o texto alternativo e o título no visualizador. */
export function baseName(file: string): string {
  return file.split(/[\\/]/).pop() || file;
}
