/**
 * Lado do host do show_image: confere cada arquivo (extensão, tamanho, caminho protegido) e entrega ao webview
 * um endereço que ele consegue carregar. Dentro das raízes do webview (localResourceRoots) vai como URI de
 * recurso, sem copiar bytes; fora delas (pasta temporária do Playwright, por exemplo), como data URL.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { IMAGE_MIME, MAX_SHOW_IMAGE_BYTES, baseName, imageMime } from './imageShare';
import { PathRules } from './guard/protect';
import { protectedPatternsFor } from './guard/agentGuard';
import type { HostMessage, WebviewMessage } from './protocol';
import { SessionStore } from './sessionStore';

export interface CheckedImage {
  abs: string;
  mime: string;
  bytes: number;
  mtimeMs: number;
}

function fmtMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

/** Confere um arquivo de imagem. Devolve o motivo da recusa como texto, ou os dados do arquivo. */
export async function checkImageFile(file: string, cwd: string, rules?: PathRules): Promise<CheckedImage | string> {
  const abs = path.resolve(cwd, file);
  const mime = imageMime(abs);
  if (!mime) {
    return `${file}: formato não aceito (aceita ${Object.keys(IMAGE_MIME).join(', ')})`;
  }
  const hit = rules?.match(abs);
  if (hit) {
    return `${file}: caminho protegido (${hit})`;
  }
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(abs);
  } catch {
    return `${file}: arquivo não encontrado (${abs})`;
  }
  if (!stat.isFile()) {
    return `${file}: não é um arquivo`;
  }
  if (stat.size > MAX_SHOW_IMAGE_BYTES) {
    return `${file}: ${fmtMb(stat.size)}, acima do teto de ${fmtMb(MAX_SHOW_IMAGE_BYTES)}`;
  }
  if (!stat.size) {
    return `${file}: arquivo vazio`;
  }
  // Link simbólico (ou junção) com nome de imagem apontando para arquivo protegido: confere o destino real também,
  // e a extensão dele, porque a cópia em .agm/sessions/ seria legível pelo agente.
  let real: string;
  try {
    real = await fs.promises.realpath(abs);
  } catch {
    return `${file}: arquivo não encontrado (${abs})`;
  }
  if (real !== abs) {
    const realHit = rules?.match(real);
    if (realHit) {
      return `${file}: aponta para caminho protegido (${realHit})`;
    }
    if (!imageMime(real)) {
      return `${file}: aponta para um arquivo que não é imagem`;
    }
  }
  return { abs, mime, bytes: stat.size, mtimeMs: stat.mtimeMs };
}

/** Entrada do índice `images` da pasta da conversa: o que o show_image mostrou, por quem e quando. */
export interface ShownRecord {
  agentId: string;
  /** Caminho relativo à raiz do projeto quando está dentro dela; senão, absoluto. */
  path: string;
  caption?: string;
  at: string;
}

/**
 * Onde a imagem mostrada fica guardada para a conversa reabrir igual: uma cópia em .agm/sessions/<id>/files/,
 * porque print costuma ser sobrescrito (screenshot.png) ou morar numa pasta temporária. Sem id de conversa
 * ainda, ou se a cópia falhar, vale o próprio arquivo.
 */
export async function keepShownImage(image: CheckedImage, root: string, sessionId: string | undefined): Promise<string> {
  if (!sessionId) {
    return image.abs;
  }
  try {
    const store = SessionStore.for(root);
    if (inside(store.dir(sessionId), image.abs)) {
      return image.abs;
    }
    return store.saveFile(sessionId, path.basename(image.abs), await fs.promises.readFile(image.abs));
  } catch {
    return image.abs;
  }
}

/** Acrescenta ao índice `images` da conversa. Falha de disco não impede a imagem de aparecer. */
export function recordShown(root: string, sessionId: string | undefined, records: ShownRecord[]): void {
  if (!sessionId || !records.length) {
    return;
  }
  try {
    const store = SessionStore.for(root);
    const list = store.read<ShownRecord[]>(sessionId, 'images');
    const rel = (p: string) => (inside(root, p) ? path.relative(root, p).split(path.sep).join('/') : p);
    store.write(sessionId, 'images', [...(Array.isArray(list) ? list : []), ...records.map((r) => ({ ...r, path: rel(r.path) }))]);
  } catch {
    // índice é só registro
  }
}

function inside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export interface ResolvedImage {
  path: string;
  src?: string;
  error?: string;
}

/** Endereços das imagens para o webview. `roots`: as pastas que o webview já carrega direto. */
export async function resolveForWebview(webview: vscode.Webview, paths: string[], roots: string[], rules?: PathRules): Promise<ResolvedImage[]> {
  return Promise.all(
    paths.slice(0, 20).map(async (p): Promise<ResolvedImage> => {
      // Só caminho absoluto: o resultado do show_image já grava assim, e o pedido vem do webview.
      if (!path.isAbsolute(p)) {
        return { path: p, error: 'caminho relativo' };
      }
      const checked = await checkImageFile(p, path.dirname(p), rules);
      if (typeof checked === 'string') {
        return { path: p, error: checked };
      }
      if (roots.some((r) => inside(path.resolve(r), checked.abs))) {
        // O ?v= troca quando o arquivo muda, para o webview não mostrar a versão antiga do cache.
        return { path: p, src: String(webview.asWebviewUri(vscode.Uri.file(checked.abs).with({ query: `v=${Math.round(checked.mtimeMs)}` }))) };
      }
      try {
        const data = await fs.promises.readFile(checked.abs);
        return { path: p, src: `data:${checked.mime};base64,${data.toString('base64')}` };
      } catch (err) {
        return { path: p, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
}

/** "Salvar como" do visualizador: copia o arquivo ou grava o data URL no destino escolhido. */
export async function saveImageTo(target: string, source: { path?: string; src?: string }): Promise<void> {
  if (source.path && path.isAbsolute(source.path) && imageMime(source.path)) {
    await fs.promises.copyFile(source.path, target);
    return;
  }
  const m = /^data:image\/[\w.+-]+;base64,(.+)$/s.exec(source.src ?? '');
  if (!m) {
    throw new Error('Imagem sem arquivo nem dados para salvar.');
  }
  await fs.promises.writeFile(target, Buffer.from(m[1], 'base64'));
}

/**
 * Mensagens de imagem do webview, iguais no chat e na consulta lateral. `roots`: as pastas do localResourceRoots;
 * `cwd`: raiz do projeto, para os caminhos protegidos (.agm/protected.json e cofres).
 */
export async function handleImageMessage(
  webview: vscode.Webview,
  msg: Extract<WebviewMessage, { type: 'resolveImages' | 'imageAction' }>,
  cwd: string,
  roots: string[],
  post: (m: HostMessage) => void,
): Promise<void> {
  const patterns = protectedPatternsFor(cwd, undefined);
  const rules = patterns.length ? new PathRules(patterns, [cwd]) : undefined;
  if (msg.type === 'resolveImages') {
    post({ type: 'imagesResolved', requestId: msg.requestId, items: await resolveForWebview(webview, msg.paths, roots, rules) });
    return;
  }
  const file = msg.path && path.isAbsolute(msg.path) && imageMime(msg.path) && !rules?.match(msg.path) ? msg.path : undefined;
  if (msg.action === 'open') {
    if (file) {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file), { preview: true, viewColumn: vscode.ViewColumn.One });
    }
    return;
  }
  const name = file ? baseName(file) : msg.name || 'imagem.png';
  const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(cwd, name)), title: 'Salvar imagem' });
  if (!target) {
    return;
  }
  try {
    await saveImageTo(target.fsPath, { path: file, src: msg.src });
  } catch (err) {
    void vscode.window.showErrorMessage(`Não foi possível salvar a imagem: ${err instanceof Error ? err.message : String(err)}`);
  }
}
