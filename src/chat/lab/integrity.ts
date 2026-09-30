/**
 * Detector de p-hacking do laboratório: a família da correção Benjamini-Hochberg e três avisos. Nunca bloqueia
 * nada; só avisa (notice no chat, texto no resultado da ferramenta e linha no relatório de experimento).
 *
 * Contexto de cada hipótese: conversa e ramo git em que foi registrada, em `.agm/lab/context.jsonl` (só acréscimo,
 * como o resto do quadro). Hipótese registrada antes deste arquivo existir não tem conversa, e o ramo dela é a
 * família gravada (que por padrão já era o ramo).
 *
 * Família BH. Antes, a família era só o texto `family` da hipótese: quem passasse um `family` diferente em cada
 * register_hypothesis (ou registrasse a derivada com outra família) ficava com família de tamanho 1 e escapava da
 * correção. Agora duas hipóteses confirmatórias estão na mesma família quando qualquer uma destas vale, e a relação
 * é transitiva (componentes conexos):
 *   - mesmo texto `family`;
 *   - mesmo ramo;
 *   - mesma conversa;
 *   - uma é `derivedFrom` da outra.
 * Hipótese exploratória de varredura (`sweepId`) fica de fora: não compara braços nem passa por declare_result.
 *
 * Avisos, com limiares fixos e simples:
 *   1. Troca de métrica após o resultado: hipótese H registrada até 24 h depois de um veredito inconclusiva ou
 *      refutada de P, com no máximo 2 outras hipóteses registradas no meio, mesma conversa (ou mesmo ramo quando
 *      a conversa é desconhecida), métrica diferente e "mesma pergunta": H derivada de P, mesmos dois braços, ou
 *      enunciados parecidos (Jaccard de palavras com 4+ letras >= 0,5).
 *   2. Muitas hipóteses no mesmo ramo sem ordem pré-registrada: 5 ou mais hipóteses com veredito no ramo, e pelo
 *      menos metade delas registrada depois do primeiro veredito do ramo. Repete a cada 5 hipóteses a mais.
 *   3. Parada opcional: declare_result repetido na mesma hipótese com mais seeds que na tentativa anterior (o lab
 *      grava o número da tentativa e o n de cada braço). Mais forte quando a anterior não era suportada e esta é.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isSingleEval, type Hypothesis, type LabStore, type Verdict } from './store';

export interface HypothesisContext {
  hypothesisId: string;
  conversation?: string;
  branch?: string;
  agent: string;
  at: string;
}

export type IntegrityKind = 'troca-de-metrica' | 'muitas-hipoteses' | 'parada-opcional';

export interface IntegrityWarning {
  /** Estável: o hub avisa uma vez por chave. */
  key: string;
  kind: IntegrityKind;
  hypothesisIds: string[];
  branch?: string;
  text: string;
}

const SWITCH_WINDOW_MS = 24 * 3600 * 1000;
const SWITCH_MAX_BETWEEN = 2;
const SIMILAR = 0.5;
const MANY_TESTS = 5;

export class LabIntegrity {
  private readonly file: string;

  constructor(
    root: string,
    private readonly store: LabStore,
  ) {
    this.file = path.join(root, '.agm', 'lab', 'context.jsonl');
  }

  // ---------- Contexto ----------

  contexts(): Map<string, HypothesisContext> {
    const out = new Map<string, HypothesisContext>();
    let raw = '';
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return out;
    }
    for (const line of raw.split('\n')) {
      try {
        const c = line.trim() && (JSON.parse(line) as HypothesisContext);
        if (c && c.hypothesisId && !out.has(c.hypothesisId)) {
          out.set(c.hypothesisId, c);
        }
      } catch {
        // Linha cortada: o resto vale.
      }
    }
    return out;
  }

  tag(h: Hypothesis, ctx: { conversation?: string; branch?: string; agent: string }): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const rec: HypothesisContext = { hypothesisId: h.id, conversation: ctx.conversation || undefined, branch: ctx.branch, agent: ctx.agent, at: new Date().toISOString() };
      fs.appendFileSync(this.file, JSON.stringify(rec) + '\n', 'utf8');
    } catch {
      // Sem contexto a hipótese ainda entra na família pelo texto `family` e pelo ramo.
    }
  }

  branchOf(h: Hypothesis, ctx = this.contexts()): string {
    return ctx.get(h.id)?.branch ?? h.family;
  }

  conversationOf(h: Hypothesis, ctx = this.contexts()): string | undefined {
    return ctx.get(h.id)?.conversation;
  }

  // ---------- Família BH ----------

  /** Hipóteses confirmatórias da família de `h` (inclui `h`), na ordem do quadro, e um rótulo para o veredito. */
  family(h: Hypothesis): { members: Hypothesis[]; label: string } {
    // Avaliação única (cofre) não tem p: entraria no BH com p = 1 e só apertaria as outras.
    const all = this.store.hypotheses().filter((o) => !o.sweepId && !isSingleEval(o));
    if (!all.some((o) => o.id === h.id)) {
      all.push(h);
    }
    const ctx = this.contexts();
    const parent = new Map(all.map((o) => [o.id, o.id]));
    const find = (id: string): string => {
      let r = id;
      while (parent.get(r) !== r) {
        r = parent.get(r)!;
      }
      parent.set(id, r);
      return r;
    };
    const union = (a: string, b: string) => {
      if (parent.has(a) && parent.has(b)) {
        parent.set(find(a), find(b));
      }
    };
    const firstBy = new Map<string, string>();
    const link = (key: string | undefined, id: string) => {
      if (!key) {
        return;
      }
      const seen = firstBy.get(key);
      seen ? union(seen, id) : firstBy.set(key, id);
    };
    for (const o of all) {
      link(`f:${o.family}`, o.id);
      link(`b:${this.branchOf(o, ctx)}`, o.id);
      link(ctx.get(o.id)?.conversation && `c:${ctx.get(o.id)!.conversation}`, o.id);
      if (o.derivedFrom) {
        union(o.id, o.derivedFrom);
      }
    }
    const root = find(h.id);
    const members = all.filter((o) => find(o.id) === root);
    const extra = members.filter((o) => o.family !== h.family).length;
    return { members, label: extra ? `${h.family} + ${extra} da mesma conversa, ramo ou derivação` : h.family };
  }

  /** Quantas hipóteses e métricas foram testadas numa conversa ou num ramo (o relatório mostra). */
  counts(members: readonly Hypothesis[]): { hypotheses: number; metrics: number; declared: number; attempts: number } {
    const verdicts = this.store.verdicts();
    const declared = members.filter((h) => verdicts.some((v) => v.hypothesisId === h.id));
    return {
      hypotheses: members.length,
      metrics: new Set(members.map((h) => h.metric)).size,
      declared: declared.length,
      attempts: verdicts.filter((v) => members.some((h) => h.id === v.hypothesisId)).length,
    };
  }

  // ---------- Avisos ----------

  /** Todos os avisos do quadro inteiro; `only` filtra os que tocam essas hipóteses. */
  warnings(only?: ReadonlySet<string>): IntegrityWarning[] {
    const hyps = this.store.hypotheses().filter((h) => !h.sweepId && !isSingleEval(h));
    const verdicts = this.store.verdicts();
    const ctx = this.contexts();
    const out = [...this.metricSwitches(hyps, verdicts, ctx), ...this.manyTests(hyps, verdicts, ctx), ...this.optionalStops(hyps, verdicts)];
    return only ? out.filter((w) => w.hypothesisIds.some((id) => only.has(id))) : out;
  }

  private metricSwitches(hyps: Hypothesis[], verdicts: Verdict[], ctx: Map<string, HypothesisContext>): IntegrityWarning[] {
    const out: IntegrityWarning[] = [];
    for (const h of hyps) {
      const hAt = Date.parse(h.createdAt);
      const convH = ctx.get(h.id)?.conversation;
      for (const p of hyps) {
        if (p.id === h.id || p.metric === h.metric || Date.parse(p.createdAt) >= hAt) {
          continue;
        }
        const convP = ctx.get(p.id)?.conversation;
        const related = convH && convP ? convH === convP : this.branchOf(h, ctx) === this.branchOf(p, ctx);
        if (!related) {
          continue;
        }
        const v = verdicts.filter((x) => x.hypothesisId === p.id && Date.parse(x.at) < hAt).at(-1);
        if (!v || v.verdict === 'suportada' || hAt - Date.parse(v.at) > SWITCH_WINDOW_MS) {
          continue;
        }
        const between = hyps.filter((o) => o.id !== h.id && Date.parse(o.createdAt) > Date.parse(v.at) && Date.parse(o.createdAt) < hAt).length;
        if (between > SWITCH_MAX_BETWEEN) {
          continue;
        }
        const why =
          h.derivedFrom === p.id
            ? `derivada de ${p.id}`
            : sameArms(h, p)
              ? `mesmos braços (${h.arms.join(' x ')})`
              : similarity(`${h.title} ${h.statement}`, `${p.title} ${p.statement}`) >= SIMILAR
                ? 'enunciado parecido'
                : '';
        if (!why) {
          continue;
        }
        out.push({
          key: `troca:${p.id}:${h.id}`,
          kind: 'troca-de-metrica',
          hypothesisIds: [p.id, h.id],
          text: `Troca de métrica após o resultado: ${h.id} mede "${h.metric}" logo depois de ${p.id} medir "${p.metric}" e dar ${v.verdict} (${v.id}); ${why}. Se a métrica nova é a certa, diga por quê no enunciado; ${h.id} e ${p.id} contam na mesma família BH.`,
        });
      }
    }
    return out;
  }

  private manyTests(hyps: Hypothesis[], verdicts: Verdict[], ctx: Map<string, HypothesisContext>): IntegrityWarning[] {
    const out: IntegrityWarning[] = [];
    const byBranch = new Map<string, Hypothesis[]>();
    for (const h of hyps) {
      const b = this.branchOf(h, ctx);
      byBranch.set(b, [...(byBranch.get(b) ?? []), h]);
    }
    for (const [branch, list] of byBranch) {
      const ids = new Set(list.map((h) => h.id));
      const vs = verdicts.filter((v) => ids.has(v.hypothesisId));
      const tested = list.filter((h) => vs.some((v) => v.hypothesisId === h.id));
      if (tested.length < MANY_TESTS) {
        continue;
      }
      const first = Math.min(...vs.map((v) => Date.parse(v.at)));
      const late = list.filter((h) => Date.parse(h.createdAt) > first);
      if (late.length * 2 < tested.length) {
        continue;
      }
      const bucket = Math.floor(tested.length / MANY_TESTS) * MANY_TESTS;
      out.push({
        key: `muitas:${branch}:${bucket}`,
        kind: 'muitas-hipoteses',
        hypothesisIds: tested.map((h) => h.id),
        branch,
        text: `Muitas hipóteses no ramo "${branch}" sem ordem pré-registrada: ${tested.length} testadas, ${late.length} registradas depois do primeiro resultado. A família BH conta todas; trate o que passar como exploratório até repetir numa hipótese nova com seeds novas.`,
      });
    }
    return out;
  }

  private optionalStops(hyps: Hypothesis[], verdicts: Verdict[]): IntegrityWarning[] {
    const out: IntegrityWarning[] = [];
    for (const h of hyps) {
      const vs = verdicts.filter((v) => v.hypothesisId === h.id);
      for (let i = 1; i < vs.length; i++) {
        const prev = vs[i - 1];
        const cur = vs[i];
        const n = (v: Verdict) => v.arms.reduce((s, a) => s + (a.n ?? 0), 0);
        if (n(cur) <= n(prev)) {
          continue;
        }
        const flipped = prev.verdict !== 'suportada' && cur.verdict === 'suportada';
        out.push({
          key: `parada:${h.id}:${cur.id}`,
          kind: 'parada-opcional',
          hypothesisIds: [h.id],
          text: `Parada opcional em ${h.id}: declare_result tentativa ${cur.attempt ?? i + 1} com ${n(cur)} runs contra ${n(prev)} na anterior (${prev.id}: ${prev.verdict}, ${cur.id}: ${cur.verdict}).${flipped ? ' O resultado virou para suportada só depois de mais seeds: o falso positivo real é maior que o alpha declarado.' : ''} Fixe o número de seeds antes e declare uma vez.`,
        });
      }
    }
    return out;
  }
}

function sameArms(a: Hypothesis, b: Hypothesis): boolean {
  return a.arms[0] === b.arms[0] && a.arms[1] === b.arms[1];
}

/** Jaccard das palavras com 4 letras ou mais, sem acento. */
export function similarity(a: string, b: string): number {
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 4),
    );
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) {
    return 0;
  }
  let inter = 0;
  for (const w of A) {
    inter += B.has(w) ? 1 : 0;
  }
  return inter / (A.size + B.size - inter);
}
