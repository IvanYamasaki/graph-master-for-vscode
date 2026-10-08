import type { AgentInfo } from '../chat/protocol';

/** Prefixo do id do nó-resumo de concluídos; o resto é o id de quem os criou (ou "main"). */
export const DONE_NODE = 'done:';

const FINAL = new Set<AgentInfo['status']>(['completed', 'failed', 'stopped', 'lost']);

export interface FoldOptions {
  /** Criadores cujos concluídos o usuário abriu (o resumo vira "recolher"). */
  expanded: ReadonlySet<string>;
  /** Agente que fica à vista mesmo terminado: decisão pendente, aberto no detalhe, terminou há pouco. */
  keep(a: AgentInfo): boolean;
  /** Abaixo disso não vale trocar os nós por um resumo. */
  minGroup?: number;
}

/**
 * Lista para o grafo com os agentes terminados recolhidos em quem os criou. Um agente recolhe quando ele e toda a
 * subárvore dele terminaram e nada pede para mantê-lo à vista; os recolhidos de um mesmo criador viram um nó-resumo
 * "N concluídos", pendurado no criador. Com o criador em `expanded`, eles voltam e o resumo vira "recolher".
 */
export function foldDone(agents: AgentInfo[], opts: FoldOptions): AgentInfo[] {
  const ids = new Set(agents.map((a) => a.id));
  const parentOf = (a: AgentInfo) => (a.creator && a.creator !== a.id && (a.creator === 'main' || ids.has(a.creator)) ? a.creator : 'main');
  const children = new Map<string, AgentInfo[]>();
  for (const a of agents) {
    const p = parentOf(a);
    children.set(p, [...(children.get(p) ?? []), a]);
  }
  const memo = new Map<string, boolean>();
  const foldable = (a: AgentInfo, path = new Set<string>()): boolean => {
    const known = memo.get(a.id);
    if (known !== undefined) {
      return known;
    }
    if (path.has(a.id)) {
      return false;
    }
    path.add(a.id);
    const ok = FINAL.has(a.status) && !opts.keep(a) && (children.get(a.id) ?? []).every((c) => foldable(c, path));
    memo.set(a.id, ok);
    return ok;
  };
  const hidden = new Set<string>();
  const hideTree = (a: AgentInfo) => {
    if (hidden.has(a.id)) {
      return;
    }
    hidden.add(a.id);
    for (const c of children.get(a.id) ?? []) {
      hideTree(c);
    }
  };
  const subtree = (a: AgentInfo, out: AgentInfo[] = []): AgentInfo[] => {
    if (!out.includes(a)) {
      out.push(a);
      for (const c of children.get(a.id) ?? []) {
        subtree(c, out);
      }
    }
    return out;
  };
  const summaries: AgentInfo[] = [];
  // Em largura a partir da raiz: o criador decide antes dos filhos, e criador escondido não ganha resumo.
  const order = ['main'];
  for (let i = 0; i < order.length; i++) {
    order.push(...(children.get(order[i]) ?? []).map((c) => c.id).filter((id) => !order.includes(id)));
  }
  for (const parent of order) {
    const folded = (children.get(parent) ?? []).filter((c) => foldable(c));
    if (folded.length < (opts.minGroup ?? 2) || hidden.has(parent)) {
      continue;
    }
    const open = opts.expanded.has(parent);
    const all = folded.flatMap((c) => subtree(c));
    if (!open) {
      folded.forEach(hideTree);
    }
    const failed = all.filter((a) => a.status === 'failed' || a.status === 'lost').length;
    const boxesUsed = new Set(folded.map((a) => a.box));
    const word = folded.length === 1 ? 'concluído' : 'concluídos';
    summaries.push({
      id: `${DONE_NODE}${parent}`,
      kind: 'routed',
      description: open ? `Recolher ${folded.length} ${word}` : `${folded.length} ${word}`,
      creator: parent,
      status: 'completed',
      totalTokens: all.reduce((s, a) => s + a.totalTokens, 0),
      durationMs: 0,
      toolUses: 0,
      box: boxesUsed.size === 1 ? folded[0].box : undefined,
      foldSummary: { count: folded.length, total: all.length, failed, expanded: open, names: folded.map((a) => a.description?.trim() || a.id) },
    });
  }
  return [...agents.filter((a) => !hidden.has(a.id)), ...summaries];
}

export function isDoneNode(id: string): boolean {
  return id.startsWith(DONE_NODE);
}

export function doneNodeParent(id: string): string {
  return id.slice(DONE_NODE.length);
}

/** Terminou de vez: concluído, falhou, parado ou perdido. */
export function isFinal(status: AgentInfo['status']): boolean {
  return FINAL.has(status);
}
