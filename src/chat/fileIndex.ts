import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { FileResult } from './protocol';

/** Teto do findFiles. Acima disso o índice fica parcial, mas a busca continua útil. */
const MAX_FILES = 20000;
const MAX_RESULTS = 50;
/** Espera depois do último criar/apagar antes de reler a árvore. Um `npm install` dispara milhares de eventos. */
const REBUILD_DELAY = 1000;
/** Fora do índice sempre, mesmo que o usuário não tenha configurado. */
// .agm guarda os worktrees dos agentes isolados: cópias do projeto que só poluiriam o "@".
const ALWAYS_EXCLUDE = ['**/node_modules/**', '**/.git/**', '**/out/**', '**/dist/**', '**/*.vsix', '**/.agm/**'];
/** Eventos do watcher nessas pastas não mexem no índice. */
const IGNORED_SEGMENT = /(^|\/)(node_modules|\.git|out|dist|\.agm)(\/|$)/;

interface Entry extends FileResult {
  lowerPath: string;
  lowerName: string;
  depth: number;
}

export interface EditorFiles {
  /** Arquivos abertos nas abas, caminho absoluto. */
  open: string[];
  active?: string;
}

/**
 * Lista de arquivos do cwd para o autocompletar de "@". Um índice por cwd, dividido entre os painéis
 * que usam a mesma pasta; o último a sair descarta o watcher.
 */
export class FileIndex {
  private static readonly shared = new Map<string, FileIndex>();

  private entries: Entry[] = [];
  private readonly mtimes = new Map<string, number>();
  private building?: Promise<void>;
  private rebuildTimer?: ReturnType<typeof setTimeout>;
  private readonly disposables: vscode.Disposable[] = [];
  private refs = 0;

  static acquire(cwd: string): FileIndex {
    let index = FileIndex.shared.get(cwd);
    if (!index) {
      index = new FileIndex(cwd, !!vscode.workspace.workspaceFolders?.length);
      FileIndex.shared.set(cwd, index);
    }
    index.refs++;
    return index;
  }

  private constructor(
    readonly cwd: string,
    /** Sem pasta aberta o cwd é a home: indexar tudo ali seria lento e inútil. */
    private readonly indexable: boolean,
  ) {
    if (!indexable) {
      return;
    }
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(cwd), '**/*'));
    this.disposables.push(
      watcher,
      watcher.onDidCreate((uri) => this.onTreeChange(uri)),
      watcher.onDidDelete((uri) => this.onTreeChange(uri)),
      watcher.onDidChange((uri) => {
        const rel = this.relative(uri.fsPath);
        if (rel && !IGNORED_SEGMENT.test(rel)) {
          this.mtimes.set(rel, Date.now());
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('files.exclude') || e.affectsConfiguration('search.exclude')) {
          this.scheduleRebuild();
        }
      }),
    );
    this.building = this.build();
  }

  release(): void {
    if (--this.refs > 0) {
      return;
    }
    FileIndex.shared.delete(this.cwd);
    clearTimeout(this.rebuildTimer);
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  async search(query: string, editors: EditorFiles): Promise<{ list: FileResult[]; notice?: string }> {
    const active = editors.active ? this.relative(editors.active) : undefined;
    const open = new Set(editors.open.map((p) => this.relative(p)).filter((p): p is string => !!p));
    if (active) {
      open.add(active);
    }
    if (!this.indexable) {
      const list = rank([...open].map((p) => toEntry(p)), query.toLowerCase(), open, active);
      return { list, notice: 'Sem pasta aberta: só aparecem os arquivos abertos no editor.' };
    }
    await this.building;
    const q = query.toLowerCase();
    if (!q) {
      return { list: this.recent(open, active) };
    }
    // Arquivo aberto fora da pasta também entra, pelo caminho absoluto.
    const known = new Set(this.entries.map((e) => e.path));
    const extra = [...open].filter((p) => !known.has(p)).map((p) => toEntry(p));
    return { list: rank(extra.length ? [...this.entries, ...extra] : this.entries, q, open, active) };
  }

  /** "@" sozinho: abertos no editor (o ativo primeiro), depois os modificados por último. */
  private recent(open: Set<string>, active?: string): FileResult[] {
    const first = [...open].sort((a, b) => Number(b === active) - Number(a === active));
    const rest = this.entries
      .filter((e) => e.kind === 'file' && !open.has(e.path))
      .sort((a, b) => (this.mtimes.get(b.path) ?? 0) - (this.mtimes.get(a.path) ?? 0));
    return [...first.map((p) => toEntry(p)), ...rest].slice(0, MAX_RESULTS).map(plain);
  }

  private onTreeChange(uri: vscode.Uri): void {
    const rel = this.relative(uri.fsPath);
    if (!rel || IGNORED_SEGMENT.test(rel)) {
      return;
    }
    this.mtimes.set(rel, Date.now());
    this.scheduleRebuild();
  }

  private scheduleRebuild(): void {
    clearTimeout(this.rebuildTimer);
    // Enquanto relê, as buscas seguem no índice antigo; a troca é de uma vez no fim do build.
    this.rebuildTimer = setTimeout(() => void this.build(), REBUILD_DELAY);
  }

  private async build(): Promise<void> {
    let uris: vscode.Uri[];
    try {
      uris = await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(this.cwd), '**/*'), excludeGlob(), MAX_FILES);
    } catch {
      return;
    }
    const files = new Set<string>();
    for (const uri of uris) {
      const rel = this.relative(uri.fsPath);
      if (rel) {
        files.add(rel);
      }
    }
    // Pastas saem dos caminhos dos arquivos: não existe findFiles para diretório.
    const folders = new Set<string>();
    for (const file of files) {
      for (let dir = path.posix.dirname(file); dir !== '.' && !folders.has(dir); dir = path.posix.dirname(dir)) {
        folders.add(dir);
      }
    }
    this.entries = [
      ...[...folders].map((p) => toEntry(p, 'folder')),
      ...[...files].map((p) => toEntry(p, 'file')),
    ];
    void this.readMtimes([...files].filter((f) => !this.mtimes.has(f)));
  }

  /** Datas de modificação para a lista do "@" vazio. Em segundo plano, em lotes, para não travar a busca. */
  private async readMtimes(files: string[]): Promise<void> {
    for (let i = 0; i < files.length; i += 64) {
      await Promise.all(
        files.slice(i, i + 64).map(async (rel) => {
          try {
            const st = await fs.promises.stat(path.join(this.cwd, rel));
            if (!this.mtimes.has(rel)) {
              this.mtimes.set(rel, st.mtimeMs);
            }
          } catch {
            // Sumiu entre o findFiles e o stat; o watcher cuida.
          }
        }),
      );
    }
  }

  /** Relativo ao cwd com "/", ou o absoluto quando o arquivo está fora. */
  private relative(fsPath: string): string | undefined {
    const rel = path.relative(this.cwd, fsPath).replace(/\\/g, '/');
    if (!rel) {
      return undefined;
    }
    return rel === '..' || rel.startsWith('../') || path.isAbsolute(rel) ? fsPath : rel;
  }
}

/** Arquivos abertos nas abas de texto e o ativo. Abas de diff, webview e afins ficam de fora. */
export function editorFiles(active: vscode.TextEditor | undefined): EditorFiles {
  const open = new Set<string>();
  for (const group of vscode.window.tabGroups?.all ?? []) {
    for (const tab of group.tabs) {
      const uri = (tab.input as { uri?: vscode.Uri } | undefined)?.uri;
      if (uri?.scheme === 'file') {
        open.add(uri.fsPath);
      }
    }
  }
  for (const editor of vscode.window.visibleTextEditors ?? []) {
    if (editor.document.uri.scheme === 'file') {
      open.add(editor.document.uri.fsPath);
    }
  }
  const doc = active?.document;
  return { open: [...open], active: doc && doc.uri.scheme === 'file' && !doc.isClosed ? doc.uri.fsPath : undefined };
}

/** files.exclude e search.exclude do usuário mais as pastas de build que nunca interessam. */
function excludeGlob(): string {
  const patterns = new Set(ALWAYS_EXCLUDE);
  for (const section of ['files', 'search']) {
    const map = vscode.workspace.getConfiguration(section).get<Record<string, unknown>>('exclude') ?? {};
    for (const [glob, on] of Object.entries(map)) {
      // Condicionais ({ when: ... }) ficam de fora, e chaves com chaves ou vírgula quebrariam o {a,b} de fora.
      if (on === true && !/[{},]/.test(glob)) {
        patterns.add(glob);
      }
    }
  }
  return `{${[...patterns].join(',')}}`;
}

function toEntry(p: string, kind: 'file' | 'folder' = 'file'): Entry {
  const name = p.slice(p.replace(/\\/g, '/').lastIndexOf('/') + 1);
  const lowerPath = p.toLowerCase().replace(/\\/g, '/');
  return { path: p, name, kind, lowerPath, lowerName: name.toLowerCase(), depth: lowerPath.split('/').length };
}

function plain(e: Entry): FileResult {
  return { path: e.path, name: e.name, kind: e.kind };
}

function rank(entries: Entry[], q: string, open: Set<string>, active?: string): FileResult[] {
  const scored: { e: Entry; s: number }[] = [];
  for (const e of entries) {
    let s = q ? score(e, q) : 0;
    if (s === null) {
      continue;
    }
    if (open.has(e.path)) {
      s += 150;
    }
    if (e.path === active) {
      s += 100;
    }
    scored.push({ e, s });
  }
  scored.sort((a, b) => b.s - a.s || a.e.depth - b.e.depth || a.e.lowerPath.localeCompare(b.e.lowerPath));
  return scored.slice(0, MAX_RESULTS).map((x) => plain(x.e));
}

/**
 * Pontuação no estilo do Ctrl+P: nome antes de caminho, prefixo antes de trecho, trecho antes de letras
 * soltas em sequência. Com "/" na busca, o que está dentro da pasta digitada vem primeiro.
 */
function score(e: Entry, q: string): number | null {
  const slash = q.lastIndexOf('/');
  if (slash < 0) {
    const byName = nameScore(e.lowerName, q);
    if (byName !== null) {
      return byName - (e.kind === 'folder' ? 5 : 0);
    }
    if (e.lowerPath.includes(q)) {
      return 300;
    }
    const f = fuzzy(e.lowerPath, q);
    return f === null ? null : 100 + f;
  }
  const dir = q.slice(0, slash);
  const rest = q.slice(slash + 1);
  if (dir && e.lowerPath.startsWith(`${dir}/`)) {
    const tail = e.lowerPath.slice(dir.length + 1);
    const direct = !tail.includes('/');
    if (!rest) {
      // "src/": o conteúdo direto da pasta, pastas antes de arquivos; o resto da árvore depois.
      return direct ? 900 + (e.kind === 'folder' ? 10 : 0) : 500 - e.depth;
    }
    const byName = nameScore(e.lowerName, rest);
    if (byName !== null) {
      return byName + (direct ? 200 : 0);
    }
    const f = fuzzy(tail, rest);
    return f === null ? null : 100 + f;
  }
  if (e.lowerPath.startsWith(q)) {
    return 700;
  }
  if (e.lowerPath.includes(q)) {
    return 300;
  }
  const f = fuzzy(e.lowerPath, q);
  return f === null ? null : 100 + f;
}

function nameScore(name: string, q: string): number | null {
  if (name === q) {
    return 1000;
  }
  if (name.startsWith(q)) {
    return 800 - Math.min(name.length - q.length, 50);
  }
  const at = name.indexOf(q);
  if (at >= 0) {
    return 600 - Math.min(at, 50);
  }
  const f = fuzzy(name, q);
  return f === null ? null : 400 + f;
}

/** Letras da busca na ordem, não necessariamente juntas. Sequência contígua e começo de palavra valem mais. */
function fuzzy(text: string, q: string): number | null {
  let from = 0;
  let prev = -2;
  let points = 0;
  for (const ch of q) {
    const i = text.indexOf(ch, from);
    if (i < 0) {
      return null;
    }
    points += 1;
    if (i === prev + 1) {
      points += 5;
    }
    if (i === 0 || '/._- '.includes(text[i - 1])) {
      points += 3;
    }
    prev = i;
    from = i + 1;
  }
  return Math.min(points, 150);
}
