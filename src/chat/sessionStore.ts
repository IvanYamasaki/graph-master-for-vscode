import * as fs from 'fs';
import * as path from 'path';

/**
 * Pasta de cada conversa principal: `.agm/sessions/<id da conversa>/`. Tudo o que é preciso para reabrir a conversa
 * igual fica ali, um JSON por chave (`agents.json`, `threads.json`, `images.json`...), mais `files/` para anexos
 * binários e `meta.json` com o resumo que o histórico lê sem abrir o resto.
 *
 * O transcrito continua com o Claude Code (pelo id da sessão); aqui fica só o estado da interface. A pasta inteira
 * fica fora do git (`.agm/sessions/.gitignore` com `*`): pode ter prompts, relatórios e imagens da conversa.
 */
export const SESSIONS_DIR = path.join('.agm', 'sessions');

/** Resumo da conversa, gravado em `meta.json`. O histórico lista as conversas por ele. */
export interface SessionMeta {
  id: string;
  /** ISO da última gravação de qualquer chave. */
  updatedAt: string;
  /** Agentes roteados do mapa (o AgentStore atualiza a cada gravação). */
  agents?: number;
  /** Conversa de onde esta saiu, quando o id mudou com a conversa viva (fork, /clear): a pasta foi copiada de lá. */
  forkOf?: string;
}

/** Chave vira nome de arquivo: só letras, números, ponto, hífen e sublinhado. */
const KEY_RE = /^[\w.-]{1,80}$/;
/** Id de conversa também vira pasta: uuid do Claude Code ou id de thread do Codex. */
const ID_RE = /^[\w.-]{1,120}$/;

const stores = new Map<string, SessionStore>();

export class SessionStore {
  readonly base: string;

  constructor(readonly root: string) {
    this.base = path.join(root, SESSIONS_DIR);
  }

  /** Uma instância por projeto: painéis e hubs da mesma janela dividem a mesma. */
  static for(root: string): SessionStore {
    let store = stores.get(root);
    if (!store) {
      store = new SessionStore(root);
      stores.set(root, store);
    }
    return store;
  }

  /** Caminho absoluto da pasta da conversa (não cria). */
  dir(sessionId: string): string {
    if (!ID_RE.test(sessionId)) {
      throw new Error(`Id de conversa inválido para pasta: ${sessionId}`);
    }
    return path.join(this.base, sessionId);
  }

  has(sessionId: string, key?: string): boolean {
    if (!ID_RE.test(sessionId)) {
      return false;
    }
    return fs.existsSync(key ? this.keyFile(sessionId, key) : this.dir(sessionId));
  }

  /** Lê `<key>.json`. Arquivo ausente ou corrompido devolve undefined; quem chama valida o formato. */
  read<T = unknown>(sessionId: string, key: string): T | undefined {
    if (!ID_RE.test(sessionId)) {
      return undefined;
    }
    try {
      return JSON.parse(fs.readFileSync(this.keyFile(sessionId, key), 'utf8')) as T;
    } catch {
      return undefined;
    }
  }

  /** Grava `<key>.json` de forma atômica (temporário + rename) e marca a hora em `meta.json`. */
  write(sessionId: string, key: string, value: unknown): void {
    writeAtomic(this.keyFile(sessionId, key), JSON.stringify(value, null, 1));
    this.touch(sessionId);
  }

  /** Apaga uma chave. A pasta fica, com o meta. */
  remove(sessionId: string, key: string): void {
    try {
      fs.unlinkSync(this.keyFile(sessionId, key));
    } catch {
      // já não existia
    }
  }

  /**
   * Guarda um arquivo binário em `files/<name>` (imagem mostrada no chat, por exemplo) e devolve o caminho absoluto.
   * Nome repetido não sobrescreve: ganha sufixo.
   */
  saveFile(sessionId: string, name: string, data: Uint8Array | string): string {
    const dir = path.join(this.dir(sessionId), 'files');
    fs.mkdirSync(dir, { recursive: true });
    const safe = path.basename(name).replace(/[^\w.-]+/g, '_') || 'arquivo';
    const ext = path.extname(safe);
    const stem = safe.slice(0, safe.length - ext.length);
    let file = path.join(dir, safe);
    for (let i = 2; fs.existsSync(file); i++) {
      file = path.join(dir, `${stem}-${i}${ext}`);
    }
    fs.writeFileSync(file, data);
    this.touch(sessionId);
    return file;
  }

  meta(sessionId: string): SessionMeta | undefined {
    const raw = this.read<Partial<SessionMeta>>(sessionId, 'meta');
    if (!raw || typeof raw.updatedAt !== 'string') {
      return undefined;
    }
    return { id: sessionId, updatedAt: raw.updatedAt, agents: typeof raw.agents === 'number' ? raw.agents : undefined, forkOf: typeof raw.forkOf === 'string' ? raw.forkOf : undefined };
  }

  /** Junta campos ao `meta.json` (e atualiza a hora). */
  updateMeta(sessionId: string, patch: Partial<Omit<SessionMeta, 'id' | 'updatedAt'>>): void {
    const current = this.meta(sessionId);
    writeAtomic(this.keyFile(sessionId, 'meta'), JSON.stringify({ ...current, ...patch, id: sessionId, updatedAt: new Date().toISOString() }, null, 1));
  }

  /** Todas as conversas com pasta, da mais recente para a mais antiga. */
  list(): SessionMeta[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.base);
    } catch {
      return [];
    }
    return names
      .filter((n) => ID_RE.test(n))
      .map((n) => this.meta(n))
      .filter((m): m is SessionMeta => !!m)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * A conversa ganhou id novo sem deixar de ser a mesma (fork, /clear): copia a pasta da origem para o destino.
   * Cópia, não referência: as duas seguem caminhos diferentes daqui em diante, e duas conversas gravando na mesma
   * pasta voltariam ao problema de quem grava por último apagar o que a outra fez. Chave que o destino já tem fica.
   */
  fork(sourceId: string, targetId: string): void {
    if (sourceId === targetId || !this.has(sourceId)) {
      return;
    }
    copyMissing(this.dir(sourceId), this.dir(targetId));
    this.updateMeta(targetId, { forkOf: sourceId });
  }

  private keyFile(sessionId: string, key: string): string {
    if (!KEY_RE.test(key)) {
      throw new Error(`Chave inválida na pasta da conversa: ${key}`);
    }
    return path.join(this.dir(sessionId), `${key}.json`);
  }

  private touch(sessionId: string): void {
    this.ensureIgnored();
    const current = this.read<Record<string, unknown>>(sessionId, 'meta') ?? {};
    writeAtomic(this.keyFile(sessionId, 'meta'), JSON.stringify({ ...current, id: sessionId, updatedAt: new Date().toISOString() }, null, 1));
  }

  private ignored = false;

  /** Conversas não vão para o git do usuário: a pasta tem prompts, relatórios e imagens. */
  private ensureIgnored(): void {
    if (this.ignored) {
      return;
    }
    this.ignored = true;
    const file = path.join(this.base, '.gitignore');
    if (!fs.existsSync(file)) {
      fs.mkdirSync(this.base, { recursive: true });
      fs.writeFileSync(file, '# Agent Graph Master: estado de cada conversa (agentes, threads, imagens). Fica fora do git.\n*\n');
    }
  }
}

/** Copia recursivamente o que ainda não existe no destino. */
function copyMissing(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyMissing(src, dst);
    } else if (entry.isFile() && !entry.name.endsWith('.tmp') && !fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
    }
  }
}

/** Grava num temporário e renomeia: quem lê no meio (outra janela, o histórico) nunca vê meio JSON. */
export function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows recusa o rename quando outro processo está com o arquivo aberto: grava direto.
    fs.writeFileSync(file, text, 'utf8');
    try {
      fs.unlinkSync(tmp);
    } catch {
      // some depois
    }
  }
}
