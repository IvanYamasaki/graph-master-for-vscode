/**
 * Lado do host da estimativa dos processos em segundo plano (as regras ficam em bgEta.ts): lê o fim da saída de cada
 * processo, no máximo a cada poucos segundos e só quando o arquivo cresceu, e guarda a duração dos que terminam em
 * .agm/bg-durations.json, por assinatura do comando.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BgEstimate, DurationBook, OutputProgress, commandSignature, estimate, leadingCd, parseProgress, recordDuration, redirectTarget, resolveShellPath } from './bgEta';

/** Quanto do fim do arquivo é lido. */
const TAIL_BYTES = 4096;

/** O que o host sabe de um processo para estimar. */
export interface BgTaskRef {
  taskId: string;
  command?: string;
  /** Arquivo de saída que o CLI informou ao pôr o comando em segundo plano. */
  outputFile?: string;
}

export class BgProgress {
  /** Última leitura por arquivo: só relê quando tamanho ou data mudam. */
  private readonly tails = new Map<string, { size: number; mtime: number; progress?: OutputProgress; readAt: number }>();
  private book: DurationBook | undefined;
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly root: string) {}

  private get file(): string {
    return path.join(this.root, '.agm', 'bg-durations.json');
  }

  private loadBook(): DurationBook {
    if (!this.book) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { runs?: DurationBook };
        this.book = raw.runs && typeof raw.runs === 'object' ? raw.runs : {};
      } catch {
        this.book = {};
      }
    }
    return this.book;
  }

  /** Arquivos onde a saída pode estar: o destino do `> arquivo` do comando primeiro (aí o do CLI fica vazio). */
  private candidates(t: BgTaskRef, cwd: string): string[] {
    const out: string[] = [];
    const raw = t.command ? redirectTarget(t.command) : undefined;
    if (raw && t.command) {
      const cd = leadingCd(t.command);
      const env = { tmp: os.tmpdir(), home: os.homedir(), win: process.platform === 'win32' };
      const base = cd ? resolveShellPath(cd, { ...env, cwd }) : cwd;
      out.push(path.normalize(resolveShellPath(raw, { ...env, cwd: base })));
    }
    if (t.outputFile) {
      out.push(t.outputFile);
    }
    return out;
  }

  /** Estimativa com o que já foi lido, sem tocar no disco (o histórico vem do cache carregado uma vez). */
  estimateFor(t: BgTaskRef, cwd: string): BgEstimate | undefined {
    let progress: OutputProgress | undefined;
    let readAt: number | undefined;
    for (const f of this.candidates(t, cwd)) {
      const tail = this.tails.get(f);
      if (tail?.progress) {
        progress = tail.progress;
        readAt = tail.readAt;
        break;
      }
    }
    const history = t.command ? this.loadBook()[commandSignature(t.command)]?.ms : undefined;
    return estimate(progress, history, readAt);
  }

  /** Relê o fim das saídas que mudaram. Devolve se alguma leitura trouxe progresso novo. */
  async poll(tasks: BgTaskRef[], cwd: string): Promise<boolean> {
    let changed = false;
    const seen = new Set<string>();
    for (const t of tasks) {
      for (const f of this.candidates(t, cwd)) {
        seen.add(f);
        changed = (await this.readTail(f)) || changed;
      }
    }
    for (const f of [...this.tails.keys()]) {
      if (!seen.has(f)) {
        this.tails.delete(f);
      }
    }
    return changed;
  }

  private async readTail(file: string): Promise<boolean> {
    let fh: fs.promises.FileHandle | undefined;
    try {
      const st = await fs.promises.stat(file);
      const prev = this.tails.get(file);
      if (prev && prev.size === st.size && prev.mtime === st.mtimeMs) {
        return false;
      }
      const len = Math.min(TAIL_BYTES, st.size);
      const buf = Buffer.alloc(len);
      fh = await fs.promises.open(file, 'r');
      await fh.read(buf, 0, len, st.size - len);
      const progress = parseProgress(buf.toString('utf8'));
      this.tails.set(file, { size: st.size, mtime: st.mtimeMs, progress, readAt: Date.now() });
      return progress?.fraction !== prev?.progress?.fraction || progress?.label !== prev?.progress?.label;
    } catch {
      return false;
    } finally {
      await fh?.close().catch(() => undefined);
    }
  }

  /** Processo terminou: guarda a duração. Parado pelo usuário não conta (não foi até o fim). */
  record(command: string | undefined, startedAt: string | undefined, status: string | undefined, endedAt = Date.now()): void {
    const since = startedAt ? Date.parse(startedAt) : NaN;
    if (!command || Number.isNaN(since) || status === 'stopped') {
      return;
    }
    const before = this.loadBook();
    const next = recordDuration(before, commandSignature(command), endedAt - since, endedAt);
    if (next === before) {
      return;
    }
    this.book = next;
    const body = JSON.stringify({ version: 1, runs: next }, null, 1);
    this.saving = this.saving.then(async () => {
      try {
        await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
        await fs.promises.writeFile(this.file, body, 'utf8');
      } catch {
        // Sem histórico gravado a barra só fica indeterminada na próxima vez.
      }
    });
  }
}

/** Um por raiz de projeto: os chats do mesmo projeto dividem o histórico em memória e não se sobrescrevem no disco. */
const byRoot = new Map<string, BgProgress>();

export function bgProgressFor(root: string): BgProgress {
  let p = byRoot.get(root);
  if (!p) {
    p = new BgProgress(root);
    byRoot.set(root, p);
  }
  return p;
}
