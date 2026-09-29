/**
 * Quadro de experimentos do projeto, em `.agm/lab/`. Quatro arquivos JSONL só de acréscimo:
 * hypotheses, runs, findings e verdicts. Nada é reescrito nem apagado, então o histórico inteiro fica
 * auditável: quem registrou cada número, quando, com que comando e em que commit.
 *
 * Métrica e critério de uma hipótese não mudam porque não existe operação que mude. Hipótese nova com
 * `derivedFrom` é o caminho para ajustar. O status é derivado (runs e último veredito), não gravado.
 *
 * Sem VS Code e sem dependência nativa: roda no teste com node puro.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LabHypothesisStatus, LabVerdictInfo } from '../protocol';

export interface Hypothesis {
  id: string;
  title: string;
  statement: string;
  metric: string;
  direction: 'higher' | 'lower';
  minImprovement: number;
  improvementKind: 'absolute' | 'relative';
  /** [baseline, variante]. */
  arms: [string, string];
  minSeeds: number;
  alpha: number;
  budget?: { maxRuns?: number; note?: string };
  family: string;
  derivedFrom?: string;
  createdBy: string;
  createdAt: string;
  /** Hipótese exploratória criada por uma varredura (src/chat/search): guarda os trials, não passa por declare_result. */
  sweepId?: string;
}

export interface Run {
  id: string;
  hypothesisId: string;
  arm: string;
  seed: number;
  metrics: Record<string, number>;
  /** Valores por amostra (por exemplo, acerto em cada item do conjunto de teste), por métrica. */
  samples?: Record<string, number[]>;
  command?: string;
  commit?: string;
  dirty?: boolean;
  artifact?: string;
  /** sha256 (16 primeiros hex) do arquivo de métricas lido pelo host. */
  metricsFileHash?: string;
  source: 'arquivo' | 'declarado';
  agent: string;
  at: string;
  /** Trial de varredura: número no estudo e os parâmetros sorteados. O hub mediu, nenhum modelo declarou. */
  trial?: number;
  params?: Record<string, number | string>;
}

export interface Finding {
  id: string;
  text: string;
  runIds: string[];
  hypothesisId?: string;
  agent: string;
  at: string;
}

export interface Verdict extends LabVerdictInfo {
  id: string;
  hypothesisId: string;
}

/**
 * Poda feita pelo usuário na árvore de hipóteses: o ramo fica esmaecido, nada é apagado. Vale o último evento
 * de cada hipótese, então podar e restaurar ficam os dois no histórico.
 */
export interface PruneEvent {
  id: string;
  hypothesisId: string;
  pruned: boolean;
  by: string;
  at: string;
}

type Kind = 'hypotheses' | 'runs' | 'findings' | 'verdicts' | 'prunes';
const PREFIX: Record<Kind, string> = { hypotheses: 'h', runs: 'r', findings: 'f', verdicts: 'v', prunes: 'p' };

export class LabStore {
  readonly dir: string;

  constructor(root: string) {
    this.dir = path.join(root, '.agm', 'lab');
  }

  hypotheses(): Hypothesis[] {
    return this.read<Hypothesis>('hypotheses');
  }

  hypothesis(id: string): Hypothesis | undefined {
    return this.hypotheses().find((h) => h.id === id);
  }

  runs(hypothesisId?: string): Run[] {
    const all = this.read<Run>('runs');
    return hypothesisId ? all.filter((r) => r.hypothesisId === hypothesisId) : all;
  }

  findings(): Finding[] {
    return this.read<Finding>('findings');
  }

  verdicts(hypothesisId?: string): Verdict[] {
    const all = this.read<Verdict>('verdicts');
    return hypothesisId ? all.filter((v) => v.hypothesisId === hypothesisId) : all;
  }

  lastVerdict(hypothesisId: string): Verdict | undefined {
    return this.verdicts(hypothesisId).at(-1);
  }

  status(h: Hypothesis): LabHypothesisStatus {
    const v = this.lastVerdict(h.id);
    if (v) {
      return v.verdict === 'suportada' ? 'concluída' : v.verdict;
    }
    return this.runs(h.id).length ? 'rodando' : 'registrada';
  }

  addHypothesis(h: Omit<Hypothesis, 'id' | 'createdAt'>): Hypothesis {
    return this.append('hypotheses', { ...h, createdAt: new Date().toISOString() });
  }

  addRun(r: Omit<Run, 'id' | 'at'>): Run {
    return this.append('runs', { ...r, at: new Date().toISOString() });
  }

  addFinding(f: Omit<Finding, 'id' | 'at'>): Finding {
    return this.append('findings', { ...f, at: new Date().toISOString() });
  }

  addVerdict(v: Omit<Verdict, 'id'>): Verdict {
    return this.append('verdicts', v);
  }

  /** Última poda da hipótese, se ela está podada agora. */
  pruned(hypothesisId: string): PruneEvent | undefined {
    const last = this.read<PruneEvent>('prunes').filter((p) => p.hypothesisId === hypothesisId).at(-1);
    return last?.pruned ? last : undefined;
  }

  setPruned(hypothesisId: string, pruned: boolean, by: string): PruneEvent {
    return this.append('prunes', { hypothesisId, pruned, by, at: new Date().toISOString() });
  }

  hasData(): boolean {
    return fs.existsSync(path.join(this.dir, 'hypotheses.jsonl'));
  }

  private file(kind: Kind): string {
    return path.join(this.dir, `${kind}.jsonl`);
  }

  /** Lê o arquivo inteiro a cada chamada: outra janela do VS Code pode ter acrescentado linhas. Linha quebrada é pulada. */
  private read<T>(kind: Kind): T[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file(kind), 'utf8');
    } catch {
      return [];
    }
    const out: T[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        // Linha cortada por uma gravação interrompida: o resto do arquivo continua valendo.
      }
    }
    return out;
  }

  /** Id sequencial pelo maior já gravado (h1, h2...), para não repetir mesmo com linhas de outra janela. */
  private append<T extends object>(kind: Kind, rec: T): T & { id: string } {
    fs.mkdirSync(this.dir, { recursive: true });
    const prefix = PREFIX[kind];
    const max = this.read<{ id?: string }>(kind).reduce((m, r) => Math.max(m, Number(/^\D+(\d+)$/.exec(r.id ?? '')?.[1] ?? 0)), 0);
    const withId = { id: `${prefix}${max + 1}`, ...rec };
    fs.appendFileSync(this.file(kind), JSON.stringify(withId) + '\n', 'utf8');
    return withId;
  }
}
