/**
 * Cérebro compartilhado do projeto, em `.agm/brain/`: notas Markdown ligadas por links relativos, para consulta
 * rápida de qualquer agente. Fica sempre na raiz do projeto principal (o host resolve o caminho; agente em worktree
 * não escreve na cópia dele) e é versionado junto com `lab/`.
 *
 * Regras que garantem que agentes em paralelo não se atropelam:
 * - toda escrita passa por uma fila única por pasta (e por um arquivo de trava, para duas janelas do VS Code);
 * - escrita de agente só acrescenta entradas; mudar texto existente exige o texto antigo exato (edit), então quem
 *   editou em cima de outro recebe erro em vez de apagar sem ver;
 * - a ficha de cada nota (bloco entre `brain:ficha`), a seção "Mencionado em" e o `index.md` são derivados: o host
 *   os regenera a cada escrita a partir dos metadados e dos links, nunca a partir do texto de um modelo.
 *
 * Fatos (decisões, achados, regras, armadilhas, perguntas, estado) são UMA NOTA POR FATO em `fatos/`, no formato que
 * o usuário já usa à mão (frontmatter `data`, `tipo`, `area`, `status`, `origem`; título que já diz o fato; "Por que
 * importa", "Como aplicar", "Evidência"), mais `agente` e `confianca`. Frentes, agentes e temas são notas de entradas
 * acrescentadas. `COMO_USAR.md`, o `ESTADO.md` de cada frente e o `index.md` (uma linha por fato) são do host.
 *
 * Sem VS Code e sem SDK: roda no teste com node puro.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { NewsEvent } from './news';

export const BRAIN_DIR = path.join('.agm', 'brain');

/** Página do brain_read, em caracteres. */
export const PAGE_CHARS = 10_000;
/** Nota acima disso recebe aviso para resumir. */
export const NOTE_WARN_CHARS = 24_000;
/** Entrada de agente acima disso é recusada: o cérebro é consulta rápida, não depósito de relatório. */
export const ENTRY_MAX_CHARS = 4_000;
/** O índice é resumo: as listas encolhem até ele caber aqui. */
export const INDEX_MAX_CHARS = 12_000;

const FOLDERS = ['agentes', 'frentes', 'temas', 'fatos'] as const;
type Folder = (typeof FOLDERS)[number];

export const FACT_KINDS = ['decisao', 'achado', 'regra', 'armadilha', 'pergunta', 'estado'] as const;
export type FactKind = (typeof FACT_KINDS)[number];
export const FACT_STATUS = ['vigente', 'hipotese', 'superada'] as const;
export type FactStatus = (typeof FACT_STATUS)[number];
/** Como EXTRACTED/INFERRED/AMBIGUOUS no graphify: confirmado só com origem verificável. */
export const CONFIDENCE = ['confirmado', 'inferido', 'hipotese'] as const;
export type Confidence = (typeof CONFIDENCE)[number];

/** Notas de entradas das versões anteriores que agora viram notas de fato (brain_write nelas cria um fato). */
const LEGACY_FACT_NOTES: Record<string, FactKind> = {
  achados: 'achado',
  decisoes: 'decisao',
  'perguntas-abertas': 'pergunta',
  perguntas: 'pergunta',
  regras: 'regra',
  armadilhas: 'armadilha',
};
/** Título de fato acima disso é recusado: o título é uma frase, o detalhe vai no corpo. */
const FACT_TITLE_MAX = 160;

export interface AgentCard {
  id: string;
  description: string;
  /** Prompt inicial; a ficha mostra só o começo. */
  task?: string;
  creator?: string;
  reportTo?: string;
  /** "claude" ou "codex". */
  provider?: string;
  account?: string;
  model?: string;
  effort?: string;
  /** Id da caixa no mapa (b1...). */
  boxId?: string;
  status?: string;
  worktreeBranch?: string;
  files?: string[];
}

export interface FrontCard {
  boxId: string;
  name: string;
  description?: string;
  parentBoxId?: string;
}

interface BaseMeta {
  kind: 'base';
  project?: string;
}
interface TopicMeta {
  kind: 'tema';
  createdBy: string;
  createdAt: string;
}
interface FrontMeta extends FrontCard {
  kind: 'frente';
  conversation?: string;
  createdAt: string;
}
interface AgentMeta extends AgentCard {
  kind: 'agente';
  conversation?: string;
  createdAt: string;
  /** headline: primeira linha do relatório, para o ESTADO.md da frente. */
  lastReport?: { at: string; to: string; headline?: string };
}
/** Frontmatter de uma nota de fato (nomes em português, como nas notas que o usuário escreve à mão). */
interface FactMeta {
  kind: 'fato';
  /** AAAA-MM-DD. */
  data: string;
  tipo: FactKind;
  area: string[];
  agente: string;
  status: FactStatus;
  confianca: Confidence;
  origem?: string;
  /** Caixa do agente que registrou. */
  frente?: string;
  conversa?: string;
  /** ISO. */
  criado: string;
  /** Nota (fatos/...) que substituiu esta. */
  superadaPor?: string;
  /** Wikilinks `[[...]]` para quem abre no Obsidian; o corpo tem os links relativos. */
  relacionadas?: string[];
}
type NoteMeta = BaseMeta | TopicMeta | FrontMeta | AgentMeta | FactMeta;

interface Note {
  /** Caminho relativo à pasta do cérebro, com barras: "achados.md", "agentes/a1-x.md". */
  rel: string;
  title: string;
  meta: NoteMeta;
  body: string;
  /** Texto lido do disco; ausente em nota nova. */
  raw?: string;
}

type Workspace = Map<string, Note>;

interface Base {
  rel: string;
  title: string;
  about: string;
  section: string;
}

const BASE: Base[] = [
  { rel: 'projeto.md', title: 'O projeto', about: 'O que é o projeto, o objetivo e onde fica cada parte. Qualquer agente pode completar.', section: 'Notas' },
  { rel: 'glossario.md', title: 'Glossário', about: 'Termos do projeto e o que significam aqui.', section: 'Termos' },
];

export interface FactArgs {
  /** Frase que já diz o fato; vira o título e o nome do arquivo. */
  title: string;
  /** O fato em poucas frases, com números e a fonte. */
  body?: string;
  whyItMatters?: string;
  howToApply?: string;
  kind?: string;
  area?: string[];
  status?: string;
  confidence?: string;
  origin?: string;
  links?: string[];
  /** Fato que este substitui: o antigo fica como "superada", com o link para este. */
  supersedes?: string;
  author: string;
}

export interface WriteArgs {
  note: string;
  section?: string;
  content: string;
  links?: string[];
  origin?: string;
  /** Título, se a nota for criada agora. */
  title?: string;
  /** Id do agente, "main", "user" ou "host". */
  author: string;
}

export interface WriteResult {
  rel: string;
  entryId: string;
  created: boolean;
  warnings: string[];
}

export interface EditArgs {
  note: string;
  oldText: string;
  newText: string;
  author: string;
}

export interface ReadResult {
  rel: string;
  text: string;
  page: number;
  pages: number;
  warning?: string;
}

export interface SearchHit {
  rel: string;
  title: string;
  section?: string;
  entryId?: string;
  author?: string;
  at?: string;
  snippet: string;
  score: number;
}

const queues = new Map<string, Promise<unknown>>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class BrainStore {
  readonly dir: string;
  private readonly now: () => Date;
  private readonly conversationOf: () => string | undefined;
  /** Entradas gravadas (e editadas) numa operação, entregues depois que ela chega ao disco. */
  onChange?: (events: NewsEvent[]) => void;
  private events: NewsEvent[] = [];

  /**
   * @param root raiz do projeto principal (nunca o worktree de um agente)
   * @param conversation id da conversa do hub: ids de agente e de caixa (a1, b1) se repetem entre conversas.
   *   Função porque a conversa só ganha id depois do primeiro turno.
   */
  constructor(
    readonly root: string,
    conversation?: string | (() => string | undefined),
    opts?: { now?: () => Date; graphStaleDays?: () => number },
  ) {
    this.dir = path.join(root, BRAIN_DIR);
    this.now = opts?.now ?? (() => new Date());
    this.conversationOf = typeof conversation === 'function' ? conversation : () => conversation;
    this.graphStaleDays = opts?.graphStaleDays ?? (() => 14);
  }

  private readonly graphStaleDays: () => number;
  /** Grafo do graphify e memória manual achados no projeto; a busca anda pelo disco, então vale por 5 minutos. */
  private maps?: { at: number; list: ExternalMap[] };

  get conversation(): string | undefined {
    return this.conversationOf() || undefined;
  }

  get indexPath(): string {
    return path.join(this.dir, 'index.md');
  }

  exists(): boolean {
    return fs.existsSync(this.indexPath);
  }

  // ---------- Operações do host (sem modelo) ----------

  /** Cria o cérebro se ainda não existe: notas base e índice. Devolve true se criou agora. */
  ensure(project: string): Promise<boolean> {
    return this.mutate((ws) => this.seed(ws, project));
  }

  /**
   * Liga o cérebro numa conversa que já tem caixas e agentes: cria o que falta e atualiza fichas numa escrita só.
   */
  activate(project: string, fronts: FrontCard[], agents: AgentCard[]): Promise<boolean> {
    return this.mutate((ws) => {
      const created = this.seed(ws, project);
      for (const f of fronts) {
        this.putFront(ws, f);
      }
      for (const a of agents) {
        this.putAgent(ws, a);
      }
      return created;
    });
  }

  /** Nota da frente (caixa), criada ou atualizada. Devolve o caminho relativo. */
  upsertFront(card: FrontCard): Promise<string> {
    return this.mutate((ws) => this.putFront(ws, card).rel);
  }

  /** Nota do agente, criada ou atualizada (campos ausentes ficam como estavam). Devolve o caminho relativo. */
  upsertAgent(card: AgentCard): Promise<string> {
    return this.mutate((ws) => this.putAgent(ws, card).rel);
  }

  /**
   * Relatório final entregue: resumo determinístico na nota do agente (destino, primeiras linhas, arquivos
   * alterados) e ficha atualizada. Sem nota do agente, não faz nada.
   */
  recordReport(agentId: string, r: { to: string; text: string; files?: string[]; status?: string }): Promise<string | undefined> {
    return this.mutate((ws) => {
      const note = this.agentNote(ws, agentId);
      if (!note || note.meta.kind !== 'agente') {
        return undefined;
      }
      const at = this.now().toISOString();
      const lines = r.text.trim().split('\n');
      note.meta = {
        ...note.meta,
        lastReport: { at, to: r.to, headline: oneLine(firstLine(r.text), 160) },
        ...(r.files ? { files: r.files.slice(0, 200) } : {}),
        ...(r.status ? { status: r.status } : {}),
      };
      const head = lines.slice(0, 10).join('\n').slice(0, 900);
      const cut = head.length < r.text.trim().length;
      const parts = [
        `Relatório entregue a ${r.to} (${r.text.trim().length} caracteres).`,
        '',
        ...head.split('\n').map((l) => `> ${l}`),
        ...(cut ? ['>', '> (continua no mapa de agentes)'] : []),
      ];
      if (r.files?.length) {
        const shown = r.files.slice(0, 20).map((f) => `\`${f}\``);
        parts.push('', `Arquivos alterados: ${shown.join(', ')}${r.files.length > 20 ? ` e mais ${r.files.length - 20}` : ''}.`);
      }
      this.appendEntry(ws, note, 'Relatórios', parts.join('\n'), 'host', {
        actor: agentId,
        line: `relatório entregue a ${r.to}: ${lines.find((l) => l.trim()) ?? ''}`,
      });
      return note.rel;
    });
  }

  /**
   * Veredito do laboratório vira nota de fato confirmada, com a hipótese como origem. Quem declarou aparece como
   * agente (é ele quem não recebe o aviso de novidade).
   */
  recordVerdict(v: { hypothesisId: string; title: string; verdict: string; detail?: string; by: string; reportPath?: string }): Promise<WriteResult> {
    const origin = v.reportPath ? v.reportPath : `.agm/lab/hypotheses.jsonl (hipótese ${v.hypothesisId})`;
    return this.fact({
      title: `Hipótese ${v.hypothesisId} (${v.title}): ${v.verdict}`,
      body: `Veredito do laboratório declarado por ${v.by}, pela estatística do declare_result (IC por bootstrap, correção BH).${v.detail ? ` ${v.detail}` : ''}`,
      whyItMatters: 'É o resultado registrado do experimento; número citado sem este veredito não vale.',
      howToApply: `read_board({ hypothesis_id: "${v.hypothesisId}" }) mostra os runs com comando e commit.`,
      kind: 'achado',
      area: ['laboratorio', v.hypothesisId],
      confidence: 'confirmado',
      origin,
      author: v.by,
    });
  }

  /**
   * Uma nota por fato em `fatos/AAAA-MM-DD-slug.md`. "confirmado" exige origem (senão vira "inferido", com aviso).
   * Com `supersedes`, o fato antigo fica "superada" e ganha o link para este; nada é apagado.
   */
  fact(args: FactArgs): Promise<WriteResult> {
    return this.mutate((ws) => {
      const warnings: string[] = [];
      if (!this.exists()) {
        this.seed(ws, path.basename(this.root));
      }
      const title = oneLine(args.title.replace(/^#+\s*/, ''), 400);
      if (!title) {
        throw new BrainError('O fato precisa de um título: uma frase que já diga o fato.');
      }
      if (title.length > FACT_TITLE_MAX) {
        throw new BrainError(`Título com ${title.length} caracteres (máximo ${FACT_TITLE_MAX}). Deixe só a frase do fato no título e o detalhe no corpo.`);
      }
      const size = [args.body, args.whyItMatters, args.howToApply].reduce((n, t) => n + (t?.length ?? 0), 0);
      if (args.author !== 'host' && size > ENTRY_MAX_CHARS) {
        throw new BrainError(`Fato com ${size} caracteres (máximo ${ENTRY_MAX_CHARS}). Uma ideia por nota, em poucas frases; dois fatos independentes são duas notas.`);
      }
      const kind = factKind(args.kind);
      if (!kind) {
        throw new BrainError(`tipo "${args.kind}" não existe. Use ${FACT_KINDS.join(', ')}.`);
      }
      const origin = args.origin?.trim() || undefined;
      let confidence = pick(CONFIDENCE, args.confidence) ?? (origin ? 'confirmado' : 'inferido');
      if (confidence === 'confirmado' && !origin) {
        confidence = 'inferido';
        warnings.push('Sem origem verificável, o fato ficou como "inferido". Para "confirmado", passe origin (arquivo:linha, run, commit, URL).');
      }
      const status = factStatus(args.status) ?? (confidence === 'hipotese' ? 'hipotese' : 'vigente');
      const iso = this.now().toISOString();
      const day = localDay(iso);
      const base = `${day}-${slug(title, 60)}`;
      let rel = `fatos/${base}.md`;
      for (let i = 2; ws.has(rel); i++) {
        rel = `fatos/${base}-${i}.md`;
      }
      const author = this.agentNote(ws, args.author, true)?.meta;
      const note: Note = {
        rel,
        title,
        meta: {
          kind: 'fato',
          data: day,
          tipo: kind,
          area: (args.area ?? []).map((a) => slug(a, 40)).filter((a) => a !== 'nota').slice(0, 12),
          agente: args.author,
          status,
          confianca: confidence,
          origem: origin,
          frente: author?.kind === 'agente' ? author.boxId : undefined,
          conversa: this.conversation,
          criado: iso,
        },
        body: '',
      };
      ws.set(rel, note);
      const refs: Note[] = [];
      for (const name of args.links ?? []) {
        const dest = this.linkTarget(ws, name, args.author, warnings);
        if (dest && dest.rel !== rel) {
          refs.push(dest);
        }
      }
      let old: Note | undefined;
      if (args.supersedes) {
        old = this.findNote(ws, args.supersedes);
        if (!old || old.meta.kind !== 'fato') {
          warnings.push(`"${args.supersedes}" não é uma nota de fato; nada foi marcado como superado.`);
          old = undefined;
        } else {
          refs.unshift(old);
        }
      }
      const para = (label: string, t?: string) => (t?.trim() ? `**${label}:** ${this.wikiLinks(ws, note, sanitize(t.trim()), args.author, warnings)}` : undefined);
      note.body = [
        args.body?.trim() ? this.wikiLinks(ws, note, sanitize(args.body.trim()), args.author, warnings) : undefined,
        para('Por que importa', args.whyItMatters),
        para('Como aplicar', args.howToApply),
        `**Evidência:** ${origin ? this.renderOrigin(rel, origin) : 'sem origem registrada'} (confiança: ${confidence}).`,
        refs.length ? `**Relacionadas:** ${refs.map((n) => `[${n.title}](${relLink(rel, n.rel)})`).join(', ')}` : undefined,
      ]
        .filter(Boolean)
        .join('\n\n');
      (note.meta as FactMeta).relacionadas = refs.length ? refs.map((n) => `[[${n.rel.replace(/\.md$/, '')}]]`) : undefined;
      if (old && old.meta.kind === 'fato') {
        old.meta = { ...old.meta, status: 'superada', superadaPor: rel };
        old.body = `**Superada por:** [${title}](${relLink(old.rel, rel)}) em ${day}.\n\n${old.body.replace(/^\*\*Superada por:\*\*[^\n]*\n+/, '')}`;
      }
      this.events.push({ rel, author: args.author, line: title, boxId: (note.meta as FactMeta).frente, at: iso });
      return { rel, entryId: 'fato', created: true, warnings };
    });
  }

  // ---------- Operações dos agentes ----------

  /**
   * Acrescenta uma entrada. Cria a nota (em temas/) e as notas de destino dos links que não existirem.
   * Em "achados", "decisoes", "perguntas-abertas", "regras" ou "armadilhas" cria uma nota de fato (a primeira linha
   * vira o título): é o formato de uma nota por fato, e o nome antigo continua funcionando.
   */
  write(args: WriteArgs): Promise<WriteResult> {
    const legacy = legacyFactKind(args.note);
    if (legacy) {
      const content = args.content.trim();
      const [head, ...rest] = content.split('\n');
      const title = oneLine(head.replace(/^\s*(?:[-*+]\s+|#{1,6}\s+|>\s*)/, '').replace(/\*\*/g, ''), FACT_TITLE_MAX);
      return this.fact({
        title,
        body: rest.join('\n').trim() || (head.length > FACT_TITLE_MAX ? content : undefined),
        kind: legacy,
        origin: args.origin,
        links: args.links,
        author: args.author,
      }).then((r) => ({
        ...r,
        warnings: [...r.warnings, `Gravado como nota de fato em ${r.rel} (uma nota por fato). Da próxima vez use brain_fact, com por que importa e como aplicar.`],
      }));
    }
    return this.mutate((ws) => {
      const content = args.content.trim();
      if (!content) {
        throw new BrainError('Conteúdo vazio.');
      }
      if (args.author !== 'host' && content.length > ENTRY_MAX_CHARS) {
        throw new BrainError(
          `Entrada com ${content.length} caracteres (máximo ${ENTRY_MAX_CHARS}). Resuma: o cérebro guarda decisões e achados curtos e verificáveis, não o relatório inteiro.`,
        );
      }
      const warnings: string[] = [];
      if (!this.exists()) {
        this.seed(ws, path.basename(this.root));
      }
      const target = this.resolveForWrite(ws, args.note, args.author, args.title);
      const note = target.note;
      if (note.meta.kind === 'fato') {
        throw new BrainError(
          `${note.rel} é uma nota de fato: não recebe entradas. Para corrigir, brain_edit com o texto antigo exato; para um fato novo que substitui este, brain_fact com supersedes "${note.rel}".`,
        );
      }
      const section = args.section?.trim() || defaultSection(note);
      let text = this.wikiLinks(ws, note, sanitize(content), args.author, warnings);
      const refs: string[] = [];
      for (const name of args.links ?? []) {
        const dest = this.linkTarget(ws, name, args.author, warnings);
        if (dest && dest.rel !== note.rel) {
          refs.push(`[${dest.title}](${relLink(note.rel, dest.rel)})`);
        }
      }
      const origin = args.origin?.trim() ? this.renderOrigin(note.rel, args.origin) : undefined;
      const tail = [origin && `Origem: ${origin}`, refs.length ? `Ver também: ${refs.join(', ')}` : undefined].filter(Boolean).join(' · ');
      if (tail) {
        text += `\n\n${tail}`;
      }
      const entryId = this.appendEntry(ws, note, section, text, args.author);
      const size = serialize(note, '', '').length;
      if (size > NOTE_WARN_CHARS) {
        warnings.push(
          `A nota ${note.rel} tem ${Math.round(size / 1000)} mil caracteres. Resuma: grave um resumo curto com brain_write (seção "Resumo") e apague as entradas antigas que ele cobre com brain_edit.`,
        );
      }
      return { rel: note.rel, entryId, created: target.created, warnings };
    });
  }

  /**
   * Troca um trecho exato do corpo da nota. Falha se o texto antigo não aparece exatamente uma vez: quem edita em
   * cima de uma versão desatualizada vê o erro em vez de apagar o que outro escreveu.
   */
  edit(args: EditArgs): Promise<{ rel: string; entryId?: string }> {
    return this.mutate((ws) => {
      const note = this.findNote(ws, args.note);
      if (!note) {
        throw new BrainError(`A nota "${args.note}" não existe. Use brain_read() para ver o índice.`);
      }
      if (!args.oldText) {
        throw new BrainError('old_text vazio. Para acrescentar, use brain_write.');
      }
      if (/<!--|-->/.test(args.oldText) || /<!--|-->/.test(args.newText)) {
        throw new BrainError('Os comentários <!-- --> são marcas do host (autor e data de cada entrada) e não podem ser editados.');
      }
      const body = note.body.replace(/\r\n/g, '\n');
      const old = args.oldText.replace(/\r\n/g, '\n');
      const count = body.split(old).length - 1;
      if (count === 0) {
        throw new BrainError(
          `O texto antigo não bate com a nota ${note.rel} (alguém pode ter mudado depois da sua leitura, ou o trecho está na ficha ou em "Mencionado em", que o host gera). Releia com brain_read e tente de novo.`,
        );
      }
      if (count > 1) {
        throw new BrainError(`O texto antigo aparece ${count} vezes em ${note.rel}. Inclua mais contexto para ele ficar único.`);
      }
      const at = body.indexOf(old);
      let next = body.slice(0, at) + sanitize(args.newText.replace(/\r\n/g, '\n')) + body.slice(at + old.length);
      // Marca a entrada que continha o trecho (se ele cabia numa só): o marcador ganha quem editou e quando.
      const entry = entrySpans(body).find((e) => e.start <= at && at + old.length <= e.end);
      if (entry) {
        const stamp = `editada: ${args.author} ${this.now().toISOString()}`;
        next = next.replace(entry.marker, entry.marker.replace(/(?: \| editada: [^>]*?)? -->$/, ` | ${stamp} -->`));
        next = next.replace(entry.header, entry.header.replace(/(?: · editada por [^*]*)?\*\*$/, ` · editada por ${args.author} em ${fmtDate(this.now().toISOString())}**`));
      }
      note.body = next;
      this.events.push({
        rel: note.rel,
        author: args.author,
        entryId: entry?.id,
        line: firstLine(args.newText) || '(trecho apagado)',
        boxId: this.boxOfNote(ws, note, args.author),
        edited: true,
        at: this.now().toISOString(),
      });
      return { rel: note.rel, entryId: entry?.id };
    });
  }

  // ---------- Leitura (sem fila: as gravações são atômicas) ----------

  /** Sem nota: o índice. Com nota: o conteúdo, paginado. */
  read(noteName?: string, page = 1): ReadResult | BrainError {
    if (!this.exists()) {
      return new BrainError('O cérebro deste projeto ainda não existe. O host cria quando há caixa ou dois ou mais agentes em paralelo.');
    }
    let rel = 'index.md';
    if (noteName && !/^index(\.md)?$/i.test(noteName.trim())) {
      const note = this.findNote(this.load(), noteName);
      if (!note) {
        return new BrainError(`A nota "${noteName}" não existe. Use brain_read() para ver o índice ou brain_search para procurar.`);
      }
      rel = note.rel;
    }
    const text = readText(path.join(this.dir, rel)) ?? '';
    const pages = paginate(text);
    const p = Math.min(Math.max(1, Math.floor(page)), pages.length);
    let out = pages[p - 1];
    if (pages.length > 1) {
      out += `\n\n(página ${p} de ${pages.length}${p < pages.length ? `; continue com brain_read({ note: "${rel}", page: ${p + 1} })` : ''})`;
    }
    const warning =
      rel !== 'index.md' && text.length > NOTE_WARN_CHARS
        ? `Nota longa (${Math.round(text.length / 1000)} mil caracteres). Se você escreve nela, resuma as entradas antigas.`
        : undefined;
    return { rel, text: out, page: p, pages: pages.length, warning };
  }

  /** Busca textual sem acento e sem caixa. Trechos que têm todos os termos vêm antes. */
  search(query: string, limit = 12): SearchHit[] {
    const terms = fold(query)
      .split(/[^a-z0-9_.:/-]+/)
      .filter((t) => t.length >= 2 || /^\d$/.test(t));
    if (!terms.length || !fs.existsSync(this.dir)) {
      return [];
    }
    const hits: SearchHit[] = [];
    for (const note of this.load().values()) {
      const titleFold = fold(note.title);
      for (const block of blocksOf(note)) {
        const f = fold(block.text);
        const matched = terms.filter((t) => hasTerm(f, t) || hasTerm(titleFold, t));
        if (!matched.length) {
          continue;
        }
        const inText = terms.filter((t) => hasTerm(f, t));
        if (!inText.length) {
          continue;
        }
        hits.push({
          rel: note.rel,
          title: note.title,
          section: block.section,
          entryId: block.id,
          author: block.author,
          at: block.at,
          snippet: snippet(block.text, inText[0]),
          score: matched.length * 10 + inText.length * 2 + terms.filter((t) => hasTerm(titleFold, t)).length * 3 + (block.id ? 1 : 0),
        });
      }
    }
    hits.sort((a, b) => b.score - a.score || (b.at ?? '').localeCompare(a.at ?? ''));
    const best = hits[0]?.score ?? 0;
    // Com algum trecho cobrindo todos os termos, os que cobrem só parte deles viram ruído.
    const full = terms.length * 10;
    return (best >= full ? hits.filter((h) => h.score >= full) : hits).slice(0, limit);
  }

  /** Caminho absoluto da nota do agente (para o link no popup), se existir. */
  agentNotePath(agentId: string): string | undefined {
    if (!fs.existsSync(this.dir)) {
      return undefined;
    }
    const note = this.agentNote(this.load(), agentId);
    return note && path.join(this.dir, note.rel);
  }

  /** Caminho absoluto da nota da frente (caixa), se existir. */
  frontNotePath(boxId: string): string | undefined {
    if (!fs.existsSync(this.dir)) {
      return undefined;
    }
    const note = this.frontNote(this.load(), boxId);
    return note && path.join(this.dir, note.rel);
  }

  // ---------- Fila e gravação ----------

  private mutate<T>(fn: (ws: Workspace) => T): Promise<T> {
    const key = path.resolve(this.dir).toLowerCase();
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() =>
        this.withLock(() => {
          this.events = [];
          const ws = this.load();
          const out = fn(ws);
          this.finish(ws);
          const events = this.events.splice(0);
          if (events.length) {
            try {
              this.onChange?.(events);
            } catch (err) {
              console.error('[agm] cérebro, aviso de novidade:', err);
            }
          }
          return out;
        }),
      );
    queues.set(key, next);
    return next;
  }

  /** Trava entre processos (duas janelas no mesmo projeto). `*.tmp` já está no `.agm/.gitignore`. */
  private async withLock<T>(fn: () => T): Promise<T> {
    fs.mkdirSync(this.dir, { recursive: true });
    const lock = path.join(this.dir, 'escrita.lock.tmp');
    for (let i = 0; ; i++) {
      try {
        fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // No Windows, criar o arquivo enquanto a trava anterior está sendo apagada dá EPERM, não EEXIST.
        if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') {
          throw err;
        }
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > 15_000) {
            fs.unlinkSync(lock);
            continue;
          }
        } catch {
          continue;
        }
        if (i > 400) {
          throw new BrainError('O cérebro está travado por outra janela há mais de 20 s. Tente de novo.');
        }
        await sleep(50);
      }
    }
    try {
      return fn();
    } finally {
      try {
        fs.unlinkSync(lock);
      } catch {
        // já removida
      }
    }
  }

  private load(): Workspace {
    const ws: Workspace = new Map();
    const add = (rel: string) => {
      const raw = readText(path.join(this.dir, rel));
      if (raw !== undefined) {
        ws.set(rel, { ...parse(rel, raw), raw });
      }
    };
    for (const f of listMd(this.dir)) {
      // index.md e COMO_USAR.md são do host, regenerados; os ESTADO.md ficam em subpastas de frentes/ e não entram.
      if (f !== 'index.md' && f !== HOW_TO_FILE) {
        add(f);
      }
    }
    for (const folder of FOLDERS) {
      for (const f of listMd(path.join(this.dir, folder))) {
        add(`${folder}/${f}`);
      }
    }
    return ws;
  }

  /** Regenera fichas, "Mencionado em" e o índice, e grava só o que mudou. */
  private finish(ws: Workspace): void {
    if (!ws.size) {
      return;
    }
    const fichas = new Map<string, string>();
    for (const note of ws.values()) {
      fichas.set(note.rel, this.renderFicha(ws, note));
    }
    const mentions = new Map<string, Set<string>>();
    for (const note of ws.values()) {
      for (const dest of linksIn(note.rel, `${fichas.get(note.rel)}\n${note.body}`)) {
        if (dest !== note.rel && ws.has(dest)) {
          (mentions.get(dest) ?? mentions.set(dest, new Set()).get(dest)!).add(note.rel);
        }
      }
    }
    for (const note of ws.values()) {
      const from = [...(mentions.get(note.rel) ?? [])].map((r) => ws.get(r)!).sort((a, b) => a.title.localeCompare(b.title));
      const list = from.map((n) => `- [${n.title}](${relLink(note.rel, n.rel)})`).join('\n');
      const text = serialize(note, fichas.get(note.rel)!, list);
      if (text !== note.raw) {
        writeAtomic(path.join(this.dir, note.rel), text);
        note.raw = text;
      }
    }
    for (const front of ws.values()) {
      if (front.meta.kind === 'frente') {
        writeIfChanged(path.join(this.dir, stateRel(front.rel)), this.renderState(ws, front));
      }
    }
    writeIfChanged(path.join(this.dir, HOW_TO_FILE), HOW_TO);
    writeIfChanged(this.indexPath, this.renderIndex(ws));
  }

  // ---------- Notas ----------

  private seed(ws: Workspace, project: string): boolean {
    const created = !this.exists();
    for (const b of BASE) {
      if (!ws.has(b.rel)) {
        ws.set(b.rel, { rel: b.rel, title: b.title, meta: b.rel === 'projeto.md' ? { kind: 'base', project } : { kind: 'base' }, body: '' });
      }
    }
    const p = ws.get('projeto.md')!;
    if (p.meta.kind === 'base' && !p.meta.project) {
      p.meta = { ...p.meta, project };
    }
    return created;
  }

  private putFront(ws: Workspace, card: FrontCard): Note {
    const existing = this.frontNote(ws, card.boxId, true);
    if (existing && existing.meta.kind === 'frente') {
      existing.meta = { ...existing.meta, ...definedOnly(card) };
      existing.title = card.name || existing.title;
      return existing;
    }
    const base = slug(card.name, 48);
    let rel = `frentes/${base}.md`;
    if (ws.has(rel)) {
      rel = `frentes/${base}-${slug(card.boxId)}${this.conversation ? `-${slug(this.conversation, 8)}` : ''}.md`;
    }
    const note: Note = {
      rel,
      title: card.name,
      meta: { kind: 'frente', ...card, conversation: this.conversation, createdAt: this.now().toISOString() },
      body: '',
    };
    ws.set(rel, note);
    return note;
  }

  private putAgent(ws: Workspace, card: AgentCard): Note {
    const existing = this.agentNote(ws, card.id, true);
    if (existing && existing.meta.kind === 'agente') {
      // Campo ausente fica como estava; boxId presente e vazio tira o agente da caixa.
      existing.meta = { ...existing.meta, ...definedOnly(card), ...('boxId' in card ? { boxId: card.boxId } : {}) };
      existing.title = `${card.id} · ${card.description || existing.meta.description}`;
      return existing;
    }
    const base = `${slug(card.id, 12)}-${slug(card.description, 40)}`;
    let rel = `agentes/${base}.md`;
    for (let i = 2; ws.has(rel); i++) {
      rel = `agentes/${base}-${i}.md`;
    }
    const note: Note = {
      rel,
      title: `${card.id} · ${card.description}`,
      meta: { kind: 'agente', ...card, conversation: this.conversation, createdAt: this.now().toISOString() },
      body: '',
    };
    ws.set(rel, note);
    return note;
  }

  /** Nota do agente nesta conversa; sem conversa igual, a mais recente com esse id. */
  private agentNote(ws: Workspace, agentId: string, sameConversation = false): Note | undefined {
    const all = [...ws.values()].filter((n) => n.meta.kind === 'agente' && n.meta.id === agentId);
    const own = all.find((n) => (n.meta as AgentMeta).conversation === this.conversation);
    return sameConversation ? own : (own ?? latest(all));
  }

  private frontNote(ws: Workspace, boxId: string, sameConversation = false): Note | undefined {
    const all = [...ws.values()].filter((n) => n.meta.kind === 'frente' && n.meta.boxId === boxId);
    const own = all.find((n) => (n.meta as FrontMeta).conversation === this.conversation);
    return sameConversation ? own : (own ?? latest(all));
  }

  /**
   * Nome dado por um agente para uma nota que já existe: "achados", "decisões.md", "agentes/a3", "a3", "b1",
   * "frentes/onda-1", "temas/x", ".agm/brain/temas/x.md".
   */
  private findNote(ws: Workspace, name: string): Note | undefined {
    const parsed = parseName(name);
    if (parsed instanceof BrainError) {
      return undefined;
    }
    const { folder, base } = parsed;
    if (folder) {
      const exact = ws.get(`${folder}/${base}.md`);
      if (exact) {
        return exact;
      }
      if (folder === 'agentes') {
        return this.agentNote(ws, base);
      }
      if (folder === 'frentes') {
        return this.frontNote(ws, base);
      }
      if (folder === 'fatos') {
        return this.factByName(ws, base);
      }
      return undefined;
    }
    return (
      ws.get(`${base}.md`) ??
      ws.get(`temas/${base}.md`) ??
      ws.get(`frentes/${base}.md`) ??
      ws.get(`agentes/${base}.md`) ??
      (/^a\d+$/.test(base) ? this.agentNote(ws, base) : undefined) ??
      (/^b\d+$/.test(base) ? this.frontNote(ws, base) : undefined) ??
      this.factByName(ws, base) ??
      [...ws.values()].find((n) => fold(n.title) === fold(name.trim()))
    );
  }

  /** Fato pelo nome do arquivo, com ou sem a data na frente ("2026-09-29-porta-e-4817" ou "porta-e-4817"). */
  private factByName(ws: Workspace, base: string): Note | undefined {
    const exact = ws.get(`fatos/${base}.md`);
    if (exact) {
      return exact;
    }
    const facts = [...ws.values()].filter((n) => n.meta.kind === 'fato');
    return facts.find((n) => path.posix.basename(n.rel, '.md').replace(/^\d{4}-\d{2}-\d{2}-/, '') === base);
  }

  private resolveForWrite(ws: Workspace, name: string, author: string, title?: string): { note: Note; created: boolean } {
    if (/^(\.agm\/brain\/)?index(\.md)?$/i.test(name.trim().replace(/\\/g, '/'))) {
      throw new BrainError('O index.md é gerado pelo host a cada escrita. Escreva numa nota (achados, decisoes, temas/...) e ele aparece no índice.');
    }
    const found = this.findNote(ws, name);
    if (found) {
      return { note: found, created: false };
    }
    const parsed = parseName(name);
    if (parsed instanceof BrainError) {
      throw parsed;
    }
    if (parsed.folder === 'agentes' || parsed.folder === 'frentes') {
      throw new BrainError(
        `A nota "${name}" não existe. Notas de agente e de frente são criadas pelo host quando o agente ou a caixa nascem; para um tema novo, use "temas/<nome>".`,
      );
    }
    if (parsed.folder === 'fatos') {
      throw new BrainError(`O fato "${name}" não existe. Fatos novos nascem com brain_fact; brain_search acha os que existem.`);
    }
    const rel = `temas/${parsed.base}.md`;
    const note: Note = {
      rel,
      title: title?.trim() || humanize(parsed.base),
      meta: { kind: 'tema', createdBy: author, createdAt: this.now().toISOString() },
      body: '',
    };
    ws.set(rel, note);
    return { note, created: true };
  }

  /** Destino de um link pedido por um agente: nota existente ou tema novo (vazio). */
  private linkTarget(ws: Workspace, name: string, author: string, warnings: string[]): Note | undefined {
    try {
      return this.resolveForWrite(ws, name, author).note;
    } catch (err) {
      warnings.push(`Link "${name}" ignorado: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** `[[nota]]` e `[[nota|texto]]` viram links relativos, que funcionam no VS Code e no GitHub. */
  private wikiLinks(ws: Workspace, from: Note, text: string, author: string, warnings: string[]): string {
    return mapOutsideCode(text, (chunk) =>
      chunk.replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g, (whole, name: string, label?: string) => {
        const dest = this.linkTarget(ws, name.trim(), author, warnings);
        return dest ? `[${(label ?? dest.title).trim()}](${relLink(from.rel, dest.rel)})` : whole;
      }),
    );
  }

  /** "src/a.ts:10" vira link para o arquivo (com #L10) se ele existir no projeto; URL vira link; o resto fica em código. */
  private renderOrigin(fromRel: string, origin: string): string {
    return origin
      .split(/\s*;\s*/)
      .filter(Boolean)
      .map((o) => {
        if (/^https?:\/\/\S+$/.test(o)) {
          return `<${o}>`;
        }
        const m = /^([^\s:()]+\.[A-Za-z0-9]+)(?::(\d+)(?:-\d+)?)?(.*)$/.exec(o);
        if (m && !m[1].includes('..')) {
          const file = m[1].replace(/\\/g, '/').replace(/^\.\//, '');
          if (fs.existsSync(path.join(this.root, file))) {
            const from = path.posix.dirname(`${BRAIN_DIR.replace(/\\/g, '/')}/${fromRel}`);
            const href = encodeURI(path.posix.relative(from, file)) + (m[2] ? `#L${m[2]}` : '');
            return `[${file}${m[2] ? `:${m[2]}` : ''}](${href})${m[3]}`;
          }
        }
        return `\`${o.replace(/`/g, "'")}\``;
      })
      .join('; ');
  }

  /**
   * Entrada: marcador invisível (id, autor, data ISO), cabeçalho visível e o texto. Devolve o id.
   * `news`: quem aparece no aviso de novidade (no resumo do relatório o host escreve em nome do agente) e a linha.
   */
  private appendEntry(ws: Workspace, note: Note, section: string, text: string, author: string, news?: { actor?: string; line?: string }): string {
    const iso = this.now().toISOString();
    const max = [...note.body.matchAll(MARKER)].reduce((m, x) => Math.max(m, Number(x[1].slice(1))), 0);
    const id = `e${max + 1}`;
    const who = this.authorLabel(ws, note.rel, author);
    const entry = `<!-- ${id} | ${author.replace(/[|>]/g, '')} | ${iso} -->\n**${fmtDate(iso)} · ${who}**\n${text}`;
    note.body = insertInSection(note.body, section, entry);
    const actor = news?.actor ?? author;
    this.events.push({ rel: note.rel, author: actor, entryId: id, line: news?.line ?? firstLine(text), boxId: this.boxOfNote(ws, note, actor), at: iso });
    return id;
  }

  /** Caixa de uma nota: a da frente, a do agente dono da nota ou, nas notas gerais, a de quem escreveu. */
  private boxOfNote(ws: Workspace, note: Note, author: string): string | undefined {
    if (note.meta.kind === 'frente' || note.meta.kind === 'agente') {
      return note.meta.boxId;
    }
    if (note.meta.kind === 'fato') {
      return note.meta.frente;
    }
    const a = this.agentNote(ws, author, true)?.meta;
    return a?.kind === 'agente' ? a.boxId : undefined;
  }

  private authorLabel(ws: Workspace, fromRel: string, author: string): string {
    if (author === 'host') {
      return 'host';
    }
    if (author === 'user') {
      return 'usuário';
    }
    const n = this.agentNote(ws, author);
    return n && n.rel !== fromRel ? `[${author}](${relLink(fromRel, n.rel)})` : author;
  }

  // ---------- Fichas e índice ----------

  private renderFicha(ws: Workspace, note: Note): string {
    const m = note.meta;
    const link = (n: Note, label = n.title) => `[${label}](${relLink(note.rel, n.rel)})`;
    if (m.kind === 'fato') {
      return ''; // o frontmatter faz o papel da ficha
    }
    if (m.kind === 'base') {
      const about = BASE.find((b) => b.rel === note.rel)?.about;
      return [`> ${about ?? 'Nota geral do projeto.'}`, ...(m.project ? ['', `Projeto: ${m.project}.`] : [])].join('\n');
    }
    if (m.kind === 'tema') {
      return `> Nota livre, criada por ${this.authorLabel(ws, note.rel, m.createdBy)} em ${fmtDate(m.createdAt)}.`;
    }
    if (m.kind === 'frente') {
      const agents = this.agentsOf(ws, m);
      const running = agents.filter((a) => (a.meta as AgentMeta).status === 'running').length;
      const parent = m.parentBoxId ? this.frontNote(ws, m.parentBoxId) : undefined;
      const children = [...ws.values()].filter(
        (n) => n.meta.kind === 'frente' && n.meta.parentBoxId === m.boxId && n.meta.conversation === m.conversation,
      );
      const lines = [
        `> Frente (caixa ${m.boxId} no mapa de agentes), criada em ${fmtDate(m.createdAt)}.`,
        '',
        `- Objetivo: ${oneLine(m.description || '(sem descrição)', 400)}`,
        `- Estado: ${frontState(agents.length, running)}. Feito, pendente e bloqueado em [ESTADO.md](${relLink(note.rel, stateRel(note.rel))})`,
      ];
      const facts = this.factsOf(ws, m.boxId);
      if (facts.length) {
        lines.push(`- Fatos: ${facts.slice(0, 15).map((f) => link(f)).join(', ')}${facts.length > 15 ? ` e mais ${facts.length - 15}` : ''}`);
      }
      if (parent) {
        lines.push(`- Dentro de: ${link(parent)}`);
      }
      if (children.length) {
        lines.push(`- Etapas: ${children.map((c) => link(c)).join(', ')}`);
      }
      lines.push(agents.length ? '- Agentes:' : '- Agentes: nenhum ainda.');
      for (const a of agents) {
        const am = a.meta as AgentMeta;
        lines.push(`  - ${link(a)}: ${statusLabel(am.status)}${am.model ? ` · ${am.model}` : ''}${am.lastReport ? ` · relatório a ${am.lastReport.to}` : ''}`);
      }
      return lines.join('\n');
    }
    const front = m.boxId ? this.frontNote(ws, m.boxId) : undefined;
    const account = [m.provider === 'codex' ? 'Codex' : 'Claude', m.account && `conta ${m.account}`, m.model, m.effort && `esforço ${m.effort}`]
      .filter(Boolean)
      .join(' · ');
    const lines = [
      `> Agente ${m.id}, criado por ${m.creator ?? 'main'} em ${fmtDate(m.createdAt)}. Estado: ${statusLabel(m.status)}.`,
      '',
      `- Tarefa: ${oneLine(m.task || m.description, 400)}`,
      `- Frente: ${front ? link(front) : m.boxId ? `caixa ${m.boxId}` : 'nenhuma (agente solto)'}`,
      `- Conta e modelo: ${account}`,
      `- Relatório vai para: ${m.reportTo ?? 'quem criou'}${m.lastReport ? ` (último entregue a ${m.lastReport.to} em ${fmtDate(m.lastReport.at)})` : ''}`,
    ];
    if (m.worktreeBranch) {
      lines.push(`- Worktree: branch \`${m.worktreeBranch}\``);
    }
    if (m.files?.length) {
      const shown = m.files.slice(0, 20).map((f) => `\`${f}\``);
      lines.push(`- Arquivos alterados: ${shown.join(', ')}${m.files.length > 20 ? ` e mais ${m.files.length - 20}` : ''}`);
    }
    return lines.join('\n');
  }

  private agentsOf(ws: Workspace, f: FrontMeta): Note[] {
    return [...ws.values()]
      .filter((n) => n.meta.kind === 'agente' && n.meta.boxId === f.boxId && n.meta.conversation === f.conversation)
      .sort((a, b) => agentOrder(a) - agentOrder(b));
  }

  /** Fatos vigentes ou hipóteses registrados por agentes da caixa, do mais novo para o mais velho. */
  private factsOf(ws: Workspace, boxId: string): Note[] {
    return [...ws.values()]
      .filter((n) => n.meta.kind === 'fato' && n.meta.frente === boxId && n.meta.status !== 'superada')
      .sort((a, b) => (b.meta as FactMeta).criado.localeCompare((a.meta as FactMeta).criado));
  }

  /** `frentes/<frente>/ESTADO.md`: feito, pendente e bloqueado, só a partir dos agentes da caixa e dos fatos dela. */
  private renderState(ws: Workspace, front: Note): string {
    const m = front.meta as FrontMeta;
    const rel = stateRel(front.rel);
    const link = (n: Note, label = n.title) => `[${label}](${relLink(rel, n.rel)})`;
    const done: string[] = [];
    const pending: string[] = [];
    const blocked: string[] = [];
    for (const a of this.agentsOf(ws, m)) {
      const am = a.meta as AgentMeta;
      if (am.status === 'completed') {
        done.push(`- ${link(a)}: ${am.lastReport?.headline ?? 'concluído'}${am.lastReport ? ` (${fmtDate(am.lastReport.at)})` : ''}`);
      } else if (am.status === 'failed' || am.status === 'stopped') {
        blocked.push(`- ${link(a)}: ${statusLabel(am.status)}${am.lastReport?.headline ? `. ${am.lastReport.headline}` : ''}`);
      } else {
        pending.push(`- ${link(a)}: ${statusLabel(am.status)} · ${oneLine(am.task || am.description, 140)}`);
      }
    }
    const facts = this.factsOf(ws, m.boxId);
    for (const f of facts) {
      const fm = f.meta as FactMeta;
      if (fm.tipo === 'pergunta') {
        pending.push(`- Pergunta aberta: ${link(f)}`);
      } else if (fm.tipo === 'estado') {
        done.push(`- Estado registrado: ${link(f)} (${fm.agente}, ${fm.data})`);
      }
    }
    const section = (title: string, items: string[]) => [`## ${title}`, '', ...(items.length ? items : ['Nada.']), ''];
    return [
      `# Estado: ${front.title}`,
      '',
      `> Gerado pelo host a partir dos agentes da caixa ${m.boxId} e dos fatos dela; não edite. Frente: ${link(front)}. [Índice do cérebro](${relLink(rel, 'index.md')})`,
      '',
      ...section('Feito', done),
      ...section('Pendente', pending),
      ...section('Bloqueado', blocked),
    ].join('\n');
  }

  /** Grafo do graphify e memória escrita à mão que já existem no projeto (fora do cérebro). */
  private externalMaps(): ExternalMap[] {
    if (!this.maps || Date.now() - this.maps.at > 5 * 60_000) {
      this.maps = { at: Date.now(), list: findExternalMaps(this.root) };
    }
    return this.maps.list;
  }

  private renderIndex(ws: Workspace): string {
    for (const cap of [25, 15, 8, 4, 2]) {
      const text = this.indexWith(ws, cap);
      if (text.length <= INDEX_MAX_CHARS || cap === 2) {
        return text;
      }
    }
    return '';
  }

  private indexWith(ws: Workspace, cap: number): string {
    const notes = [...ws.values()];
    const project = (ws.get('projeto.md')?.meta as BaseMeta | undefined)?.project ?? path.basename(this.root);
    const more = (n: number) => (n > 0 ? [`- e mais ${n} (use brain_search)`] : []);
    const newest = (a: Note, b: Note) => metaDate(b).localeCompare(metaDate(a));
    const out = [
      `# Cérebro compartilhado: ${project}`,
      '',
      `> Memória do projeto para qualquer agente: uma nota por fato em fatos/, uma por frente e uma por agente. Leia este índice inteiro antes de investigar; convenções em [COMO_USAR.md](${HOW_TO_FILE}). O host regenera este arquivo a cada escrita; não edite à mão.`,
      '',
    ];
    const maps = this.externalMaps();
    if (maps.length) {
      const staleDays = this.graphStaleDays();
      for (const map of maps) {
        const href = encodeURI(path.posix.relative(BRAIN_DIR.replace(/\\/g, '/'), map.path));
        if (map.kind === 'memoria') {
          out.push(
            `- Memória escrita à mão que já existe no projeto: [${map.path}](${href})${map.notes ? ` (${map.notes} notas)` : ''}. Leia também antes de investigar; não duplique aqui o que já está lá.`,
          );
        } else {
          const age = Math.floor((Date.now() - map.mtimeMs) / 86_400_000);
          out.push(
            `- Mapa estático do código: [${map.path}](${href}) (gerado em ${localDay(new Date(map.mtimeMs).toISOString())}${age > staleDays ? `, há ${age} dias: pode estar desatualizado` : ''}). Só para consulta sob demanda (rg por um nome, ou a ferramenta do grafo, se houver); nunca leia o arquivo inteiro${map.graphJson ? ', muito menos o graph.json' : ''}.`,
          );
        }
      }
      out.push('');
    }
    const proj = ws.get('projeto.md');
    const firstEntry = proj && blocksOf(proj).find((b) => b.id);
    out.push('## Projeto', '', `${firstEntry ? oneLine(stripHeader(firstEntry.text), 300) + ' ' : ''}Ver [O projeto](projeto.md) e o [Glossário](glossario.md).`, '');

    const fronts = notes.filter((n) => n.meta.kind === 'frente').sort(newest);
    out.push('## Frentes', '');
    if (!fronts.length) {
      out.push('Nenhuma ainda. Cada caixa do mapa de agentes vira uma frente.');
    }
    for (const f of fronts.slice(0, cap)) {
      const m = f.meta as FrontMeta;
      const agents = this.agentsOf(ws, m);
      const running = agents.filter((a) => (a.meta as AgentMeta).status === 'running').length;
      out.push(`- [${f.title}](${f.rel}) · ${frontState(agents.length, running)} · ${agents.length} agente${agents.length === 1 ? '' : 's'} · [estado](${stateRel(f.rel)})`);
    }
    out.push(...more(fronts.length - cap), '');

    // Uma linha por fato, como no INDICE.md escrito à mão: título, tipo, confiança, áreas, quem e quando.
    const facts = notes.filter((n) => n.meta.kind === 'fato').sort((a, b) => (b.meta as FactMeta).criado.localeCompare((a.meta as FactMeta).criado));
    const factLine = (n: Note) => {
      const m = n.meta as FactMeta;
      return `- [${n.title}](${n.rel}) — ${m.tipo} · ${m.confianca}${m.area.length ? ` · ${m.area.join(', ')}` : ''} · ${m.agente} · ${m.data}`;
    };
    const factCap = cap * 3;
    const live = facts.filter((n) => (n.meta as FactMeta).status === 'vigente' && (n.meta as FactMeta).tipo !== 'pergunta');
    out.push(`## Fatos vigentes (${live.length})`, '');
    if (!live.length) {
      out.push('Nenhum ainda. brain_fact registra um (uma nota por fato).');
    }
    out.push(...live.slice(0, factCap).map(factLine), ...more(live.length - factCap), '');
    const open = facts.filter((n) => (n.meta as FactMeta).status === 'hipotese' || ((n.meta as FactMeta).tipo === 'pergunta' && (n.meta as FactMeta).status !== 'superada'));
    if (open.length) {
      out.push(`## Hipóteses e perguntas abertas (${open.length})`, '', ...open.slice(0, cap).map(factLine), ...more(open.length - cap), '');
    }
    const gone = facts.filter((n) => (n.meta as FactMeta).status === 'superada');
    if (gone.length) {
      out.push(`## Superados (${gone.length})`, '', ...gone.slice(0, Math.min(cap, 5)).map(factLine), ...more(gone.length - Math.min(cap, 5)), '');
    }

    const agents = notes.filter((n) => n.meta.kind === 'agente').sort(newest);
    out.push('## Agentes', '');
    if (!agents.length) {
      out.push('Nenhum ainda.');
    }
    for (const a of agents.slice(0, cap)) {
      const m = a.meta as AgentMeta;
      const front = m.boxId ? this.frontNote(ws, m.boxId) : undefined;
      out.push(`- [${a.title}](${a.rel}) · ${statusLabel(m.status)}${front ? ` · [${front.title}](${front.rel})` : ''}`);
    }
    out.push(...more(agents.length - cap), '');

    const topics = notes.filter((n) => n.meta.kind === 'tema').sort((a, b) => lastEntryAt(b).localeCompare(lastEntryAt(a)));
    if (topics.length) {
      out.push('## Temas', '');
      for (const t of topics.slice(0, cap)) {
        out.push(`- [${t.title}](${t.rel})${entryStats(t)}`);
      }
      out.push(...more(topics.length - cap), '');
    }

    const recent = [
      ...notes.flatMap((n) => blocksOf(n).filter((b) => b.id && b.at).map((b) => ({ n, at: b.at!, who: b.author ?? '', text: stripHeader(b.text) }))),
      ...facts.map((n) => ({ n, at: (n.meta as FactMeta).criado, who: (n.meta as FactMeta).agente, text: `novo fato: ${n.title}` })),
    ]
      .sort((x, y) => y.at.localeCompare(x.at))
      .slice(0, Math.min(cap, 8));
    out.push('## Últimas atualizações', '');
    if (!recent.length) {
      out.push('Nada escrito ainda.');
    }
    for (const r of recent) {
      out.push(`- ${fmtDate(r.at)} · ${r.who} em [${r.n.title}](${r.n.rel}): ${oneLine(r.text, 110)}`);
    }
    return out.join('\n') + '\n';
  }
}

export class BrainError extends Error {}

// ---------- Formato das notas ----------

const MARKER = /<!-- (e\d+) \| ([^|>]*?) \| ([^|>]*?)(?: \| editada: ([^>]*?))? -->/g;
const FICHA = /<!-- brain:ficha (.*?) -->\n([\s\S]*?)<!-- \/brain:ficha -->\n?/;
const MENTIONS = /\n*<!-- brain:mencoes -->[\s\S]*?<!-- \/brain:mencoes -->\n?/;

function parse(rel: string, raw: string): Omit<Note, 'raw'> {
  let text = raw.replace(/\r\n/g, '\n');
  let front: Record<string, string | string[]> | undefined;
  const fm = /^---\n([\s\S]*?)\n---\n*/.exec(text);
  if (fm) {
    front = parseFrontmatter(fm[1]);
    text = text.slice(fm[0].length);
  }
  const titleMatch = /^# (.+)\n?/.exec(text);
  const title = titleMatch ? titleMatch[1].trim() : humanize(path.posix.basename(rel, '.md'));
  if (titleMatch) {
    text = text.slice(titleMatch[0].length);
  }
  text = text.replace(/^\s*\[Índice do cérebro\]\([^)]*\)\s*\n/, '');
  let meta: NoteMeta | undefined;
  const ficha = FICHA.exec(text);
  if (ficha) {
    try {
      meta = JSON.parse(ficha[1]) as NoteMeta;
    } catch {
      meta = undefined;
    }
    text = text.slice(0, ficha.index) + text.slice(ficha.index + ficha[0].length);
  }
  text = text.replace(MENTIONS, '\n');
  if (!meta && rel.startsWith('fatos/')) {
    meta = factMetaFrom(front ?? {}, rel);
  }
  if (!meta) {
    meta = BASE.some((b) => b.rel === rel) ? { kind: 'base' } : { kind: 'tema', createdBy: 'usuário', createdAt: new Date(0).toISOString() };
  }
  return { rel, title, meta, body: text.trim() };
}

/** Frontmatter de fato lido do disco; campo que falta (nota escrita à mão) ganha um valor neutro. */
function factMetaFrom(f: Record<string, string | string[]>, rel: string): FactMeta {
  const str = (k: string) => (typeof f[k] === 'string' ? (f[k] as string) : undefined);
  const list = (k: string) => (Array.isArray(f[k]) ? (f[k] as string[]) : str(k) ? [str(k)!] : []);
  const day = str('data') ?? /(\d{4}-\d{2}-\d{2})/.exec(rel)?.[1] ?? '1970-01-01';
  return {
    kind: 'fato',
    data: day,
    tipo: factKind(str('tipo')) ?? 'achado',
    area: list('area'),
    agente: str('agente') ?? 'usuário',
    status: factStatus(str('status')) ?? 'vigente',
    confianca: pick(CONFIDENCE, str('confianca')) ?? (str('origem') ? 'confirmado' : 'inferido'),
    origem: str('origem'),
    frente: str('frente'),
    conversa: str('conversa'),
    criado: str('criado') ?? `${day}T00:00:00.000Z`,
    superadaPor: str('superada_por'),
    relacionadas: list('relacionadas').length ? list('relacionadas') : undefined,
  };
}

/** Frontmatter no formato das notas do usuário: escalares simples e listas `[a, b]`. */
function renderFrontmatter(m: FactMeta): string {
  const lines: [string, string | string[] | undefined][] = [
    ['data', m.data],
    ['tipo', m.tipo],
    ['area', m.area],
    ['agente', m.agente],
    ['status', m.status],
    ['confianca', m.confianca],
    ['origem', m.origem],
    ['frente', m.frente],
    ['conversa', m.conversa],
    ['criado', m.criado],
    ['superada_por', m.superadaPor],
    ['relacionadas', m.relacionadas],
  ];
  const scalar = (v: string) => (/^[\w.\-/ À-ÿ]+$/.test(v) && !/^\s|\s$/.test(v) ? v : JSON.stringify(v));
  const out = ['---'];
  for (const [k, v] of lines) {
    if (v === undefined || (Array.isArray(v) && !v.length && k !== 'area')) {
      continue;
    }
    out.push(`${k}: ${Array.isArray(v) ? `[${v.map(scalar).join(', ')}]` : scalar(v)}`);
  }
  out.push('---');
  return out.join('\n');
}

function parseFrontmatter(text: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const unquote = (v: string) => {
    const t = v.trim();
    if (/^".*"$/.test(t)) {
      try {
        return JSON.parse(t) as string;
      } catch {
        return t.slice(1, -1);
      }
    }
    return t.replace(/^'(.*)'$/, '$1');
  };
  for (const line of text.split('\n')) {
    const m = /^([\w-]+):\s*(.*?)\s*(?:#.*)?$/.exec(line);
    if (!m) {
      continue;
    }
    const v = m[2];
    if (/^\[.*\]$/.test(v)) {
      out[m[1]] = splitList(v.slice(1, -1)).map(unquote).filter(Boolean);
    } else if (v) {
      out[m[1]] = unquote(v);
    }
  }
  return out;
}

/** Separa `a, "b, c", d` respeitando aspas. */
function splitList(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = '';
  for (const ch of s) {
    if (q) {
      cur += ch;
      if (ch === q) {
        q = '';
      }
    } else if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

function serialize(note: Note, ficha: string, mentions: string): string {
  if (note.meta.kind === 'fato') {
    const parts = [renderFrontmatter(note.meta), '', `# ${note.title}`, '', `[Índice do cérebro](${relLink(note.rel, 'index.md')})`];
    if (note.body.trim()) {
      parts.push('', note.body.trim());
    }
    if (mentions) {
      parts.push('', '<!-- brain:mencoes -->', '## Mencionado em', '', mentions, '<!-- /brain:mencoes -->');
    }
    return parts.join('\n') + '\n';
  }
  const json = JSON.stringify(note.meta).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  const parts = [
    `# ${note.title}`,
    '',
    `[Índice do cérebro](${relLink(note.rel, 'index.md')})`,
    '',
    `<!-- brain:ficha ${json} -->`,
    ficha,
    '<!-- /brain:ficha -->',
  ];
  if (note.body.trim()) {
    parts.push('', note.body.trim());
  }
  if (mentions) {
    parts.push('', '<!-- brain:mencoes -->', '## Mencionado em', '', mentions, '<!-- /brain:mencoes -->');
  }
  return parts.join('\n') + '\n';
}

interface Block {
  text: string;
  section?: string;
  id?: string;
  author?: string;
  at?: string;
}

/** Ficha, entradas e parágrafos soltos do corpo, com a seção de cada um. Base da busca e das "últimas atualizações". */
function blocksOf(note: Note): Block[] {
  // A ficha em disco (tarefa, modelo, agentes da frente) também é buscável; o título entra junto com ela.
  const ficha = note.raw ? FICHA.exec(note.raw.replace(/\r\n/g, '\n'))?.[2] : undefined;
  const blocks: Block[] = [{ text: `${note.title}\n${ficha ?? ''}`.trim(), section: 'Ficha' }];
  const spans = entrySpans(note.body);
  let cursor = 0;
  const loose = (from: number, to: number) => {
    const chunk = note.body.slice(from, to);
    for (const para of chunk.split(/\n\s*\n/)) {
      const t = para.trim();
      if (t && !/^## /.test(t)) {
        blocks.push({ text: t, section: sectionAt(note.body, from + chunk.indexOf(para)) });
      }
    }
  };
  for (const e of spans) {
    loose(cursor, e.start);
    blocks.push({ text: note.body.slice(e.start, e.end).replace(e.marker, '').trim(), section: sectionAt(note.body, e.start), id: e.id, author: e.author, at: e.at });
    cursor = e.end;
  }
  loose(cursor, note.body.length);
  if (note.meta.kind === 'fato') {
    // Fato não tem entradas: quem e quando vêm do frontmatter; tipo e áreas entram na busca junto com o título.
    const m = note.meta;
    blocks[0].text = `${note.title}\n${m.tipo} ${m.confianca} ${m.status} ${m.area.join(' ')}`;
    for (const b of blocks) {
      b.author = m.agente;
      b.at = m.criado;
    }
  }
  return blocks;
}

interface Span {
  id: string;
  author: string;
  at: string;
  start: number;
  end: number;
  marker: string;
  header: string;
}

/** Cada entrada vai do marcador até o próximo marcador, a próxima seção ou o fim do corpo. */
function entrySpans(body: string): Span[] {
  const found = [...body.matchAll(MARKER)];
  return found.map((m, i) => {
    const start = m.index!;
    const nextMarker = i + 1 < found.length ? found[i + 1].index! : body.length;
    const after = body.slice(start + m[0].length, nextMarker);
    const heading = headingOffsets(after)[0];
    const end = heading === undefined ? nextMarker : start + m[0].length + heading;
    const header = /^\n(\*\*[^\n]*\*\*)/.exec(after)?.[1] ?? '';
    return { id: m[1], author: m[2], at: m[3], start, end, marker: m[0], header };
  });
}

/** Posições dos títulos `#`/`##` fora de blocos de código. */
function headingOffsets(text: string): number[] {
  const out: number[] = [];
  let fence = false;
  let pos = 0;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
    } else if (!fence && /^#{1,2} /.test(line)) {
      out.push(pos);
    }
    pos += line.length + 1;
  }
  return out;
}

function sectionAt(body: string, offset: number): string | undefined {
  let current: string | undefined;
  let fence = false;
  let pos = 0;
  for (const line of body.split('\n')) {
    if (pos > offset) {
      break;
    }
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
    } else if (!fence && line.startsWith('## ')) {
      current = line.slice(3).trim();
    }
    pos += line.length + 1;
  }
  return current;
}

/** Acrescenta a entrada no fim da seção (criando a seção no fim do corpo, se não existir). */
function insertInSection(body: string, section: string, entry: string): string {
  const lines = body ? body.split('\n') : [];
  const want = fold(section);
  let fence = false;
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence || !/^#{1,2} /.test(line)) {
      continue;
    }
    if (start >= 0) {
      end = i;
      break;
    }
    if (line.startsWith('## ') && fold(line.slice(3).trim()) === want) {
      start = i;
    }
  }
  if (start < 0) {
    return `${body.trimEnd()}${body.trim() ? '\n\n' : ''}## ${section.replace(/\n/g, ' ')}\n\n${entry}`;
  }
  const before = lines.slice(0, end).join('\n').trimEnd();
  const after = lines.slice(end).join('\n').trim();
  return `${before}\n\n${entry}${after ? `\n\n${after}` : ''}`;
}

function defaultSection(note: Note): string {
  const base = BASE.find((b) => b.rel === note.rel);
  if (base) {
    return base.section;
  }
  return note.meta.kind === 'agente' ? 'Notas do agente' : note.meta.kind === 'frente' ? 'Notas da frente' : 'Notas';
}

/**
 * Texto de modelo não pode quebrar a estrutura: comentário HTML vira texto e título de nível 1 ou 2 desce para 3
 * (seções são `##`). Dentro de bloco de código nada muda.
 */
function sanitize(text: string): string {
  return mapOutsideCode(text.replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;'), (chunk) => chunk.replace(/^#{1,2} /gm, '### '));
}

function mapOutsideCode(text: string, fn: (chunk: string) => string): string {
  const out: string[] = [];
  let buf: string[] = [];
  let fence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (!fence && buf.length) {
        out.push(fn(buf.join('\n')));
        buf = [];
      }
      fence = !fence;
      out.push(line);
      continue;
    }
    if (fence) {
      out.push(line);
    } else {
      buf.push(line);
    }
  }
  if (buf.length) {
    out.push(fn(buf.join('\n')));
  }
  // `out` mistura pedaços de várias linhas e linhas de código: juntar com \n recompõe o texto original.
  return out.join('\n');
}

/** Links relativos para notas `.md` no texto, resolvidos para o caminho relativo à pasta do cérebro. */
function linksIn(fromRel: string, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g)) {
    if (/^[a-z]+:/i.test(m[1])) {
      continue;
    }
    const dest = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), decodeURI(m[1])));
    if (!dest.startsWith('..')) {
      out.push(dest);
    }
  }
  return out;
}

function relLink(fromRel: string, toRel: string): string {
  return encodeURI(path.posix.relative(path.posix.dirname(fromRel), toRel));
}

function parseName(name: string): { folder?: Folder; base: string } | BrainError {
  let n = name.trim().replace(/\\/g, '/').replace(/^\.?\//, '');
  n = n.replace(/^\.agm\/brain\//i, '').replace(/\.md$/i, '');
  const segs = n.split('/').filter(Boolean);
  if (!segs.length || segs.some((s) => s === '..' || s === '.')) {
    return new BrainError(`Nome de nota inválido: "${name}".`);
  }
  if (segs.length > 2) {
    return new BrainError(`Nome de nota inválido: "${name}". Use "nota" ou "pasta/nota", com pasta agentes, frentes, fatos ou temas.`);
  }
  if (segs.length === 2) {
    const folder = slug(segs[0]) as Folder;
    if (!FOLDERS.includes(folder)) {
      return new BrainError(`Pasta "${segs[0]}" não existe no cérebro. Use agentes/, frentes/, fatos/ ou temas/.`);
    }
    return { folder, base: slug(segs[1], 90) };
  }
  return { base: slug(segs[0], 90) };
}

// ---------- Fatos, estado e convenções ----------

/** Tipo de fato, com os sinônimos do formato do usuário ("descoberta") e com ou sem acento. */
function factKind(raw?: string): FactKind | undefined {
  if (!raw?.trim()) {
    return raw === undefined ? 'achado' : undefined;
  }
  const t = fold(raw.trim());
  const alias: Record<string, FactKind> = { descoberta: 'achado', fato: 'achado', decisoes: 'decisao', achados: 'achado', perguntas: 'pergunta', regras: 'regra' };
  return (FACT_KINDS as readonly string[]).includes(t) ? (t as FactKind) : alias[t];
}

/** "obsoleta" é o nome do pedido original para o que o usuário chama de "superada"; "pendente" vira hipótese. */
function factStatus(raw?: string): FactStatus | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  const t = fold(raw.trim());
  const alias: Record<string, FactStatus> = { obsoleta: 'superada', obsoleto: 'superada', superado: 'superada', pendente: 'hipotese' };
  return (FACT_STATUS as readonly string[]).includes(t) ? (t as FactStatus) : alias[t];
}

function pick<T extends string>(allowed: readonly T[], raw?: string): T | undefined {
  const t = raw ? fold(raw.trim()) : '';
  return (allowed as readonly string[]).includes(t) ? (t as T) : undefined;
}

function legacyFactKind(note: string): FactKind | undefined {
  const p = parseName(note);
  return p instanceof BrainError || p.folder ? undefined : LEGACY_FACT_NOTES[p.base];
}

/** Dia local AAAA-MM-DD: é o que vai no nome do arquivo e no `data:`. */
function localDay(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** `frentes/onda-1.md` → `frentes/onda-1/ESTADO.md`. */
function stateRel(frontRel: string): string {
  return `${frontRel.replace(/\.md$/, '')}/ESTADO.md`;
}

function writeIfChanged(file: string, text: string): void {
  if (readText(file) !== text) {
    writeAtomic(file, text);
  }
}

const HOW_TO_FILE = 'COMO_USAR.md';
/** Convenções do cérebro, para agente e para gente. O host regrava se o texto mudar numa versão nova. */
const HOW_TO = [
  '# Como usar o cérebro compartilhado',
  '',
  '[Índice do cérebro](index.md)',
  '',
  'Memória de trabalho do projeto, mantida pelo host e pelos agentes que rodam em paralelo. Serve para ninguém reaprender pagando o mesmo preço. Não é changelog nem resumo de relatório: entra aqui o que muda a próxima decisão de alguém.',
  '',
  '## Duas regras',
  '',
  '1. Antes de investigar, leia o `index.md` inteiro (é curto) e a nota da sua frente, e procure pelas palavras do problema (brain_search, ou `rg -il "<palavra>" .agm/brain`).',
  '2. Ao terminar, registre cada decisão ou descoberta que ainda não esteja aqui, uma por nota (brain_fact).',
  '',
  '## O que tem aqui',
  '',
  '- `fatos/AAAA-MM-DD-slug.md`: uma nota por fato (decisão, achado, regra, armadilha, pergunta, estado).',
  '- `frentes/<frente>.md`: uma por caixa do mapa de agentes; `frentes/<frente>/ESTADO.md` diz o que está feito, pendente e bloqueado.',
  '- `agentes/<id>-<slug>.md`: uma por agente, com tarefa, conta, modelo e o resumo do relatório final.',
  '- `temas/<nome>.md`: notas livres, por acréscimo. `projeto.md` e `glossario.md`: o projeto e os termos dele.',
  '- `index.md`, `COMO_USAR.md` e os `ESTADO.md` são gerados pelo host. Não edite à mão.',
  '',
  '## Formato de um fato',
  '',
  '```markdown',
  '---',
  'data: 2026-09-29',
  'tipo: achado         # decisao | achado | regra | armadilha | pergunta | estado',
  'area: [webview, csp] # palavras que alguém vai procurar',
  'agente: a3           # ou usuário',
  'status: vigente      # vigente | hipotese | superada',
  'confianca: confirmado # confirmado (tem origem verificável) | inferido | hipotese',
  'origem: src/webview/main.ts:120',
  '---',
  '',
  '# Título que já diz o fato',
  '',
  'O fato, em poucas frases. Números com a fonte.',
  '',
  '**Por que importa:** o que dá errado sem saber disso.',
  '',
  '**Como aplicar:** o que fazer diferente da próxima vez.',
  '',
  '**Evidência:** o arquivo:linha, o run do laboratório, o commit, a URL.',
  '```',
  '',
  '## Regras de escrita',
  '',
  '- Datas absolutas. "Hoje" não significa nada daqui a um mês.',
  '- "confirmado" só com origem que outro agente consegue conferir. Sem ela, "inferido"; palpite, "hipotese".',
  '- Atualize em vez de duplicar: fato que mudou ganha um fato novo com `supersedes` apontando o antigo, que fica "superada" com o link. Nada é apagado.',
  '- Uma ideia por nota. Dois fatos independentes são duas notas.',
  '- Nada de segredo: token, senha, chave e dado pessoal ficam fora.',
  '- Links: `[[nota]]` no texto vira link relativo (funciona no VS Code, no GitHub e no Obsidian).',
  '- Mensagens "Novidades no cérebro compartilhado" são avisos do host: informativos, só abra a nota se for relevante para a sua tarefa.',
  '',
].join('\n');

export interface ExternalMap {
  kind: 'grafo' | 'memoria';
  /** Relativo à raiz do projeto, com barras. */
  path: string;
  mtimeMs: number;
  /** grafo: existe graph.json ao lado (pode ser enorme). */
  graphJson?: boolean;
  /** memória: quantas notas a pasta tem. */
  notes?: number;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.agm', 'out', 'dist', 'build', '.venv', 'venv', '__pycache__', '.next', 'target', '.wt', '.cache', 'coverage']);

/**
 * `graphify-out/` (GRAPH_REPORT.md ou graph.json) e memória escrita à mão (um INDICE.md ao lado de um COMO_USAR.md,
 * ou numa pasta `decisoes/`), até 4 níveis abaixo da raiz. Só olha nomes de arquivo: nada é lido nem indexado.
 */
export function findExternalMaps(root: string): ExternalMap[] {
  const found: ExternalMap[] = [];
  let visited = 0;
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 4 || visited++ > 3000) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.map((e) => e.name));
    const at = (name: string) => (rel ? `${rel}/${name}` : name);
    if (path.basename(dir) === 'graphify-out' && (names.has('GRAPH_REPORT.md') || names.has('graph.json'))) {
      const file = names.has('GRAPH_REPORT.md') ? 'GRAPH_REPORT.md' : 'graph.json';
      found.push({ kind: 'grafo', path: at(file), mtimeMs: fs.statSync(path.join(dir, file)).mtimeMs, graphJson: names.has('graph.json') });
      return;
    }
    if (names.has('INDICE.md') && (names.has('COMO_USAR.md') || path.basename(dir) === 'decisoes')) {
      const notes = entries.filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'INDICE.md' && e.name !== 'COMO_USAR.md').length;
      found.push({ kind: 'memoria', path: at('INDICE.md'), mtimeMs: fs.statSync(path.join(dir, 'INDICE.md')).mtimeMs, notes });
    }
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !(e.name.startsWith('.') && e.name !== '.claude')) {
        walk(path.join(dir, e.name), at(e.name), depth + 1);
      }
    }
  };
  walk(root, '', 0);
  return found.sort((a, b) => a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path)).slice(0, 6);
}

// ---------- Utilidades ----------

export function fold(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export function slug(s: string, max = 48): string {
  return (
    fold(s)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/, '') || 'nota'
  );
}

function humanize(base: string): string {
  const t = base.replace(/-/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/<!--/g, '&lt;!--').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Primeira linha com texto, sem marcação de lista, título ou citação. */
function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim() && !/^\s*(```|~~~)/.test(l)) ?? '';
  return line.replace(/^\s*(?:[-*+]\s+|#{1,6}\s+|>\s*|\d+\.\s+)/, '').trim();
}

function stripHeader(text: string): string {
  return text.replace(/^\*\*[^\n]*\*\*\n?/, '');
}

/** Termo de até 2 caracteres ("7", "h3") só casa como palavra inteira: senão toda data e todo id batem. */
function hasTerm(folded: string, term: string): boolean {
  if (term.length > 2) {
    return folded.includes(term);
  }
  // Os termos só têm [a-z0-9_.:/-] (ver search): basta escapar o ponto.
  return new RegExp(`(^|[^a-z0-9])${term.replace(/\./g, '\\.')}($|[^a-z0-9])`).test(folded);
}

function snippet(text: string, term: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = fold(flat).indexOf(term);
  const start = Math.max(0, at - 90);
  const s = flat.slice(start, start + 260);
  return `${start > 0 ? '…' : ''}${s}${start + 260 < flat.length ? '…' : ''}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function statusLabel(s?: string): string {
  return (
    { running: 'rodando', completed: 'concluído', failed: 'falhou', stopped: 'parado', queued: 'na fila', pending: 'na fila' }[s ?? ''] ?? s ?? 'criado'
  );
}

function frontState(agents: number, running: number): string {
  if (!agents) {
    return 'aberta, sem agentes';
  }
  return running ? `em andamento (${running} de ${agents} rodando)` : 'sem agentes rodando';
}

function entryStats(n: Note): string {
  const entries = [...n.body.matchAll(MARKER)];
  if (!entries.length) {
    return ' · vazia';
  }
  const last = entries.map((e) => e[3]).sort().at(-1)!;
  return ` · ${entries.length} entrada${entries.length === 1 ? '' : 's'} · última ${fmtDate(last)}`;
}

function lastEntryAt(n: Note): string {
  return [...n.body.matchAll(MARKER)].map((e) => e[3]).sort().at(-1) ?? metaDate(n);
}

function metaDate(n: Note): string {
  return 'createdAt' in n.meta ? n.meta.createdAt : '';
}

function agentOrder(n: Note): number {
  return Number(/^a(\d+)$/.exec((n.meta as AgentMeta).id)?.[1] ?? 1e9);
}

function latest(notes: Note[]): Note | undefined {
  return [...notes].sort((a, b) => metaDate(b).localeCompare(metaDate(a)))[0];
}

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function paginate(text: string): string[] {
  if (text.length <= PAGE_CHARS) {
    return [text];
  }
  const pages: string[] = [];
  let rest = text;
  while (rest.length > PAGE_CHARS) {
    let cut = rest.lastIndexOf('\n', PAGE_CHARS);
    if (cut < PAGE_CHARS / 2) {
      cut = PAGE_CHARS;
    }
    pages.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) {
    pages.push(rest);
  }
  return pages;
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function listMd(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.md'))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** Grava num temporário e renomeia: quem lê no meio (brain_read, preview do VS Code) nunca vê meia nota. */
function writeAtomic(file: string, text: string): void {
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
