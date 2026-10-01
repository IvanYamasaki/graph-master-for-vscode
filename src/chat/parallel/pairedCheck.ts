/**
 * Reexecução do verificador no modo pareado por unidade (hipótese com comparison "paired_bootstrap"). Modelo
 * congelado não tem seed para trocar: o verificador regera o predictions_file de cada braço e o host recalcula a
 * métrica das linhas com rowsMetric. A predição é determinística, então o número tem de bater com o do run
 * original até a tolerância relativa de ponto flutuante, e não cair num intervalo de predição (que com n = 1 é
 * [média, média]).
 */
import { checkRows, readPredictionsFile, rowsMetric } from '../lab/paired';
import type { RowMetric } from '../lab/stats';
import type { Run } from '../lab/store';

export const PAIRED_REL_TOL = 1e-9;

export interface PairedRerunCheck {
  /** Métrica recalculada das linhas regeradas; undefined se o arquivo não serviu. */
  value?: number;
  /** A métrica do run original (das linhas gravadas nele, ou do número registrado). */
  original?: number;
  /** Bate com o original dentro da tolerância. undefined: não deu para comparar. */
  inside?: boolean;
  /** Mesmo sha256 (16 primeiros hex) do arquivo original: bytes idênticos. */
  sameHash?: boolean;
  line: string;
}

export function sameRel(a: number, b: number, tol = PAIRED_REL_TOL): boolean {
  return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
}

export function checkPairedRerun(arm: string, file: string, shown: string, original: Run | undefined, metric: RowMetric, metricName: string): PairedRerunCheck {
  const read = readPredictionsFile(file);
  if (read instanceof Error) {
    return { line: `${arm}: ${read.message}` };
  }
  const bad = checkRows(read.rows, metric);
  if (bad) {
    return { line: `${arm}: ${shown} não serve para ${metric}: ${bad}` };
  }
  const value = rowsMetric(read.rows, metric);
  const origValue = original?.rows ? rowsMetric(original.rows, metric) : original?.metrics[metricName];
  if (origValue === undefined || !Number.isFinite(origValue)) {
    return { value, line: `${arm}: ${metricName} = ${value} recalculado de ${shown} (sha256 ${read.hash}), mas o run original do braço não tem valor para comparar` };
  }
  const sameIds = original?.rows ? sameIdSet(original.rows.id, read.rows.id) : undefined;
  const inside = sameRel(value, origValue) && sameIds !== false;
  const sameHash = original?.metricsFileHash ? original.metricsFileHash === read.hash : undefined;
  const hashNote = sameHash === undefined ? 'o run original não guardou sha256' : sameHash ? `sha256 ${read.hash} igual ao do arquivo original` : `sha256 ${read.hash} diferente do original ${original!.metricsFileHash} (formato ou ordem mudou; vale a métrica)`;
  return {
    value,
    original: origValue,
    inside,
    sameHash,
    line: `${arm}: ${metricName} = ${value} recalculado pelo host de ${shown} (${read.rows.id.length} linhas) contra ${origValue} do run ${original?.id ?? '?'} → ${inside ? 'bate' : 'NÃO BATE'} (tolerância relativa ${PAIRED_REL_TOL})${sameIds === false ? '; os ids de linha não são os mesmos do run original' : ''}; ${hashNote}`,
  };
}

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const s = new Set(a);
  return b.every((x) => s.has(x));
}
