/**
 * Caixas do mapa, vistas do webview: quem está em qual caixa, a ordem em que as caixas aparecem e o resumo
 * de cada uma. O grafo, a lista e o popup usam a mesma conta, então os três mostram os mesmos grupos.
 *
 * Regras:
 * - A caixa de um agente é a do campo `box`. Sem ela, vale a caixa de quem o criou (um agente que cria outro
 *   dentro de uma caixa continua na mesma frente). Sem nenhuma das duas, o agente é avulso.
 * - Caixa sem agente nenhum (nem nas caixas filhas) não aparece.
 * - Caixa filha cuja mãe sumiu sobe para o primeiro nível.
 * - Mais de LOOSE_LIMIT avulsos viram uma caixa neutra, "Avulsos" (id LOOSE_BOX), só visual.
 */
import { agentColor, type AgentInfo, type BoxInfo } from '../chat/protocol';

export const LOOSE_BOX = '__avulsos';
/** A partir de quantos avulsos eles se juntam na caixa "Avulsos". */
export const LOOSE_LIMIT = 8;
/** Cor neutra da caixa "Avulsos": fora da paleta dos agentes, igual à da raiz. */
export const LOOSE_COLOR = '#8b8f96';

export interface BoxGroup {
  id: string;
  /** Ausente na caixa "Avulsos". */
  box?: BoxInfo;
  name: string;
  description?: string;
  color: string;
  /** Caixa-mãe já resolvida (existe e aparece). */
  parent?: string;
  /** Agentes que estão direto nesta caixa, na ordem de criação. */
  agents: AgentInfo[];
  /** Caixas filhas que aparecem, na ordem. */
  children: string[];
  /** Agentes desta caixa e das filhas. */
  all: AgentInfo[];
}

export interface Grouping {
  groups: Map<string, BoxGroup>;
  /** Caixas de primeiro nível, na ordem do mapa (a "Avulsos", se existir, por último). */
  top: string[];
  /** Avulsos que ficam soltos (vazio quando eles formam a caixa "Avulsos"). */
  loose: AgentInfo[];
  /** Caixa em que cada agente aparece (a "Avulsos" inclusive); ausente = solto. */
  boxOf: Map<string, string>;
  /** Existe ao menos uma caixa de verdade com agentes. */
  hasBoxes: boolean;
}

export function boxColor(box: BoxInfo): string {
  return agentColor(box.color, box.id);
}

export function groupAgents(agents: AgentInfo[], boxes: BoxInfo[]): Grouping {
  const known = new Map(boxes.map((b) => [b.id, b]));
  const ids = new Map(agents.map((a) => [a.id, a]));
  const own = new Map<string, string | undefined>();

  const resolve = (a: AgentInfo): string | undefined => {
    if (own.has(a.id)) {
      return own.get(a.id);
    }
    const seen = new Set<string>();
    let cur: AgentInfo | undefined = a;
    let found: string | undefined;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.box && known.has(cur.box)) {
        found = cur.box;
        break;
      }
      if (own.has(cur.id)) {
        found = own.get(cur.id);
        break;
      }
      cur = cur.creator && cur.creator !== 'main' ? ids.get(cur.creator) : undefined;
    }
    own.set(a.id, found);
    return found;
  };

  const direct = new Map<string, AgentInfo[]>();
  const loose: AgentInfo[] = [];
  for (const a of agents) {
    const box = resolve(a);
    if (box) {
      const list = direct.get(box);
      if (list) {
        list.push(a);
      } else {
        direct.set(box, [a]);
      }
    } else {
      loose.push(a);
    }
  }

  // Mãe só vale se existir e não for filha de outra (um nível só).
  const parentOf = (b: BoxInfo): string | undefined => {
    const mother = b.parent ? known.get(b.parent) : undefined;
    return mother && !mother.parent && mother.id !== b.id ? mother.id : undefined;
  };
  const order = new Map(agents.map((a, i) => [a.id, i]));
  const first = (list: AgentInfo[]): number => Math.min(...list.map((a) => order.get(a.id) ?? Infinity));

  const groups = new Map<string, BoxGroup>();
  const make = (b: BoxInfo): BoxGroup => ({
    id: b.id,
    box: b,
    name: b.name,
    description: b.description,
    color: boxColor(b),
    parent: undefined,
    agents: direct.get(b.id) ?? [],
    children: [],
    all: [...(direct.get(b.id) ?? [])],
  });
  // Filhas primeiro: a mãe precisa saber se alguma filha tem gente.
  for (const b of boxes) {
    if (!parentOf(b)) {
      continue;
    }
    const g = make(b);
    if (g.all.length) {
      g.parent = parentOf(b);
      groups.set(b.id, g);
    }
  }
  for (const b of boxes) {
    if (parentOf(b)) {
      continue;
    }
    const g = make(b);
    const kids = [...groups.values()].filter((c) => c.parent === b.id).sort((x, y) => first(x.all) - first(y.all));
    g.children = kids.map((k) => k.id);
    for (const k of kids) {
      g.all.push(...k.all);
    }
    if (g.all.length) {
      groups.set(b.id, g);
    }
  }
  // Filha cuja mãe não apareceu (mãe vazia não existe: a filha tem gente, então a mãe apareceu).
  const top = [...groups.values()]
    .filter((g) => !g.parent)
    .sort((x, y) => first(x.all) - first(y.all))
    .map((g) => g.id);

  const boxOf = new Map<string, string>();
  for (const [box, list] of direct) {
    if (groups.has(box)) {
      for (const a of list) {
        boxOf.set(a.id, box);
      }
    }
  }
  let looseOut = loose;
  if (loose.length > LOOSE_LIMIT) {
    groups.set(LOOSE_BOX, { id: LOOSE_BOX, name: 'Avulsos', description: 'Agentes sem caixa. Peça ao orquestrador para organizar em caixas.', color: LOOSE_COLOR, agents: loose, children: [], all: loose });
    top.push(LOOSE_BOX);
    for (const a of loose) {
      boxOf.set(a.id, LOOSE_BOX);
    }
    looseOut = [];
  }
  return { groups, top, loose: looseOut, boxOf, hasBoxes: [...groups.keys()].some((k) => k !== LOOSE_BOX) };
}

export interface BoxStats {
  n: number;
  running: number;
  done: number;
  halted: number;
  failed: number;
  tokens: number;
  /** Agentes com worktree ativo ou mesclado. */
  worktrees: number;
}

export function boxStats(all: AgentInfo[]): BoxStats {
  return {
    n: all.length,
    running: all.filter((a) => a.status === 'running').length,
    done: all.filter((a) => a.status === 'completed').length,
    halted: all.filter((a) => a.status === 'failed' || a.status === 'stopped').length,
    failed: all.filter((a) => a.status === 'failed').length,
    tokens: all.reduce((s, a) => s + (a.totalTokens || 0), 0),
    worktrees: all.filter((a) => a.worktree && (a.worktree.status === 'active' || a.worktree.status === 'merged')).length,
  };
}

/** "3 agentes · 1 rodando", "5 agentes · 1 falhou". */
export function boxCountText(s: BoxStats): string {
  const parts = [`${s.n} ${s.n === 1 ? 'agente' : 'agentes'}`];
  if (s.running) {
    parts.push(`${s.running} rodando`);
  }
  if (s.failed) {
    parts.push(`${s.failed} ${s.failed === 1 ? 'falhou' : 'falharam'}`);
  }
  return parts.join(' · ');
}

/**
 * Sem a escolha do usuário, a caixa começa recolhida quando todos terminaram. Fica aberta se alguém roda,
 * falhou, está preso ou tem decisão pendente.
 */
export function autoCollapsed(all: AgentInfo[], attention: (id: string) => boolean): boolean {
  return !all.some((a) => a.status === 'running' || a.status === 'failed' || !!a.stuck || attention(a.id));
}
