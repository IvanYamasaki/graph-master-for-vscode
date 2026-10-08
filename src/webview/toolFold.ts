import { SHOW_IMAGE_TOOL } from '../chat/imageShare';

/**
 * Lógica pura do recolhimento de ferramentas no chat. Uma sequência de chamadas entre duas falas vira um grupo
 * de uma linha só ("6 ações · Bash, Read, Edit"); o DOM fica em main.ts. Sem DOM aqui, para testar sem VS Code.
 */

export type FoldState = 'running' | 'completed' | 'failed';

export interface FoldTool {
  id: string;
  name: string;
  /** Nome para o usuário ("Bash", "Navegador", "agents · list_models"). */
  label: string;
  /** O que a chamada faz, em uma linha (arquivo, comando, padrão). Chega no toolUse, depois do toolStart. */
  summary: string;
  state: FoldState;
}

/** Ferramentas que ficam fora do grupo, com a linha própria: o resultado delas é o que o usuário quer ver. */
const STANDALONE = new Set(['AskUserQuestion', 'ExitPlanMode', 'mcp__agents__web_research', 'mcp__agents__generate_image', SHOW_IMAGE_TOOL]);

/** Vale agrupar? Pergunta, plano, pesquisa e imagens não: ficam visíveis. */
export function isFoldable(name: string): boolean {
  return !STANDALONE.has(name);
}

/**
 * Ferramentas cuja linha some do log principal: o cartão do agente já conta a história. Orquestração
 * (spawn_agent, send_to_agent...) e os subagentes nativos (Agent, Task) entram aqui.
 */
export function isAgentSpawn(name: string): boolean {
  return name === 'Agent' || name === 'Task';
}

/** Estado agregado: qualquer uma rodando = rodando; senão, qualquer erro = erro; senão, ok. */
export function groupState(tools: readonly Pick<FoldTool, 'state'>[]): FoldState {
  if (tools.some((t) => t.state === 'running')) {
    return 'running';
  }
  return tools.some((t) => t.state === 'failed') ? 'failed' : 'completed';
}

/** Rótulos sem repetição, na ordem em que apareceram. */
export function uniqueLabels(tools: readonly Pick<FoldTool, 'label'>[]): string[] {
  return [...new Set(tools.map((t) => t.label).filter(Boolean))];
}

export interface FoldLabel {
  /** Parte em destaque da linha. */
  head: string;
  /** Parte discreta, depois do ponto médio. */
  tail: string;
  state: FoldState;
  /** Texto inteiro, para title e leitor de tela. */
  title: string;
}

export interface LabelOptions {
  /**
   * Enquanto roda, a linha mostra a ação atual (true) ou só conta (false). Com o balão de pensamento ligado ele já
   * mostra a ação atual, então a linha só conta para não dizer a mesma coisa duas vezes.
   */
  showCurrent: boolean;
  /** Quantos nomes cabem na lista antes do "+N". */
  maxNames?: number;
}

export function countLabel(n: number): string {
  return n === 1 ? '1 ação' : `${n} ações`;
}

/** A ação em andamento: a última que ainda roda (rodar em paralelo é raro; a mais recente é a que importa). */
export function currentAction(tools: readonly FoldTool[]): FoldTool | undefined {
  for (let i = tools.length - 1; i >= 0; i--) {
    if (tools[i].state === 'running') {
      return tools[i];
    }
  }
  return undefined;
}

/**
 * Texto da linha recolhida.
 *  - terminou: "6 ações" + "Bash, Read, Edit" (com "1 com erro" quando falhou alguma);
 *  - rodando, showCurrent: "Edit media/chat.css" + "6 ações";
 *  - rodando, sem showCurrent: "6 ações" + "em andamento".
 */
export function foldLabel(tools: readonly FoldTool[], opts: LabelOptions): FoldLabel {
  const state = groupState(tools);
  const total = countLabel(tools.length);
  const failed = tools.filter((t) => t.state === 'failed').length;
  const make = (head: string, tail: string): FoldLabel => ({ head, tail, state, title: tail ? `${head} · ${tail}` : head });
  if (state === 'running') {
    const now = currentAction(tools);
    if (opts.showCurrent && now) {
      return make([now.label, now.summary].filter(Boolean).join(' '), total);
    }
    return make(total, 'em andamento');
  }
  const max = opts.maxNames ?? 3;
  const names = uniqueLabels(tools);
  const list = names.length > max ? `${names.slice(0, max).join(', ')} +${names.length - max}` : names.join(', ');
  const errors = failed ? `${failed === 1 ? '1 com erro' : `${failed} com erro`}` : '';
  return make(total, [errors, list].filter(Boolean).join(' · '));
}

/**
 * Um grupo: as chamadas de uma sequência, na ordem em que começaram. Só dados; quem pinta é o main.ts.
 * start() é idempotente (toolStart e toolUse chegam para o mesmo id).
 */
export class FoldGroup {
  private readonly map = new Map<string, FoldTool>();

  get tools(): FoldTool[] {
    return [...this.map.values()];
  }

  get size(): number {
    return this.map.size;
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  start(id: string, name: string, label: string): void {
    if (!this.map.has(id)) {
      this.map.set(id, { id, name, label, summary: '', state: 'running' });
    }
  }

  describe(id: string, summary: string): void {
    const t = this.map.get(id);
    if (t) {
      t.summary = summary;
    }
  }

  finish(id: string, isError: boolean): void {
    const t = this.map.get(id);
    if (t) {
      t.state = isError ? 'failed' : 'completed';
    }
  }

  state(): FoldState {
    return groupState(this.tools);
  }

  label(opts: LabelOptions): FoldLabel {
    return foldLabel(this.tools, opts);
  }
}
