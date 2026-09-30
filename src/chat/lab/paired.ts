/**
 * Predições por linha para o modo pareado (hipótese com `comparison: "paired_bootstrap"`). O agente grava um CSV
 * ou JSON por braço, com uma linha por item avaliado, e passa o caminho em log_run({ predictions_file }). O host lê,
 * guarda as linhas no run e calcula ele mesmo a métrica primária: o número não passa pelo texto do modelo.
 *
 * Formatos aceitos (nomes de coluna sem diferença de maiúscula):
 * - CSV/TSV com cabeçalho: id, unit, label, score. Sinônimos: row_id/row/index para id; cluster/group/grupo/unidade
 *   para unit; y/target/alvo/rotulo para label; pred/prob/proba/value/valor para score. Separador vírgula, ponto e
 *   vírgula ou tab.
 * - JSON: lista de objetos com essas chaves, ou objeto de colunas { "id": [...], "unit": [...], "label": [...], "score": [...] }.
 * Sem coluna unit, cada linha é a própria unidade (e o log_run recusa o arquivo se a hipótese declara `unit`). Sem
 * coluna id, o id é a posição da linha.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { auc, mean, rowValue, type RowMetric } from './stats';
import type { RunRows } from './store';

/** Limite do arquivo de predições: acima disso o runs.jsonl fica pesado demais para ler a cada mudança. */
export const MAX_PREDICTION_BYTES = 20 * 1024 * 1024;
export const MAX_PREDICTION_ROWS = 200_000;

type Column = 'id' | 'unit' | 'label' | 'score';
const ALIASES: Record<Column, string[]> = {
  id: ['id', 'row_id', 'row', 'index', 'idx'],
  unit: ['unit', 'cluster', 'group', 'grupo', 'unidade'],
  label: ['label', 'y', 'target', 'alvo', 'rotulo', 'rótulo', 'y_true'],
  score: ['score', 'pred', 'prediction', 'prob', 'proba', 'value', 'valor', 'y_pred', 'y_score'],
};

function pick(names: string[], field: Column): number {
  const lower = names.map((n) => n.trim().toLowerCase().replace(/^"|"$/g, ''));
  return lower.findIndex((n) => ALIASES[field].includes(n));
}

function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === sep) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function fromColumns(cols: { id?: unknown[]; unit?: unknown[]; label?: unknown[]; score?: unknown[] }, where: string): RunRows | Error {
  if (!cols.score?.length) {
    return new Error(`${where}: falta a coluna score (ou pred, prob, value).`);
  }
  const n = cols.score.length;
  for (const k of ['id', 'unit', 'label'] as const) {
    if (cols[k] && cols[k]!.length !== n) {
      return new Error(`${where}: a coluna ${k} tem ${cols[k]!.length} valores e score tem ${n}.`);
    }
  }
  if (n > MAX_PREDICTION_ROWS) {
    return new Error(`${where}: ${n} linhas, acima do limite de ${MAX_PREDICTION_ROWS}. Avalie numa amostra fixa ou agregue por unidade.`);
  }
  const num = (x: unknown) => (typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x.trim().replace(',', '.')) : NaN);
  const score = cols.score.map(num);
  const bad = score.findIndex((x) => !Number.isFinite(x));
  if (bad >= 0) {
    return new Error(`${where}: score não numérico na linha ${bad + 1} (${String(cols.score[bad])}).`);
  }
  const id = (cols.id ?? score.map((_, i) => i)).map((x) => String(x).trim());
  if (new Set(id).size !== n) {
    return new Error(`${where}: há id de linha repetido; cada linha precisa de um id único para parear os braços.`);
  }
  const rows: RunRows = cols.unit ? { id, unit: cols.unit.map((x) => String(x).trim()), score } : { id, unit: id.slice(), score, unitFromRow: true };
  if (cols.label) {
    rows.label = cols.label.map(num);
  }
  return rows;
}

export function parsePredictions(raw: string, file: string): RunRows | Error {
  const text = raw.replace(/^﻿/, '');
  if (/\.json$/i.test(file) || /^\s*[[{]/.test(text)) {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return new Error(`${file} não é JSON válido.`);
    }
    if (Array.isArray(data)) {
      const keys = data.length && data[0] && typeof data[0] === 'object' ? Object.keys(data[0] as object) : [];
      const col = (field: Column) => {
        const k = keys[pick(keys, field)];
        return k === undefined ? undefined : data.map((o) => (o as Record<string, unknown>)[k]);
      };
      return fromColumns({ id: col('id'), unit: col('unit'), label: col('label'), score: col('score') }, file);
    }
    if (data && typeof data === 'object') {
      const obj = data as Record<string, unknown>;
      const src = obj.predictions && typeof obj.predictions === 'object' ? (obj.predictions as Record<string, unknown>) : obj;
      if (Array.isArray(src)) {
        return parsePredictions(JSON.stringify(src), file);
      }
      const keys = Object.keys(src);
      const col = (field: Column) => {
        const v = src[keys[pick(keys, field)]];
        return Array.isArray(v) ? v : undefined;
      };
      return fromColumns({ id: col('id'), unit: col('unit'), label: col('label'), score: col('score') }, file);
    }
    return new Error(`${file}: esperava lista de linhas ou objeto de colunas.`);
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) {
    return new Error(`${file}: CSV sem cabeçalho ou sem linhas.`);
  }
  const sep = ['\t', ';', ','].find((s) => lines[0].includes(s)) ?? ',';
  const header = splitCsvLine(lines[0], sep);
  const idx = { id: pick(header, 'id'), unit: pick(header, 'unit'), label: pick(header, 'label'), score: pick(header, 'score') };
  if (idx.score < 0) {
    return new Error(`${file}: o cabeçalho (${header.join(', ')}) não tem coluna score (ou pred, prob, value).`);
  }
  const body = lines.slice(1).map((l) => splitCsvLine(l, sep));
  const col = (i: number) => (i < 0 ? undefined : body.map((cells) => cells[i]));
  return fromColumns({ id: col(idx.id), unit: col(idx.unit), label: col(idx.label), score: col(idx.score) }, file);
}

export function readPredictionsFile(file: string): { rows: RunRows; hash: string } | Error {
  let raw: string;
  try {
    const size = fs.statSync(file).size;
    if (size > MAX_PREDICTION_BYTES) {
      return new Error(`${file} tem ${Math.round(size / 1024 / 1024)} MB, acima do limite de ${MAX_PREDICTION_BYTES / 1024 / 1024} MB.`);
    }
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return new Error(`Não achei o predictions_file ${file}.`);
  }
  const rows = parsePredictions(raw, file);
  return rows instanceof Error ? rows : { rows, hash: createHash('sha256').update(raw).digest('hex').slice(0, 16) };
}

/** Amostras já por item (log_run samples ou "samples" do metrics_file): cada posição é uma linha e a própria unidade. */
export function rowsFromSamples(values: readonly number[]): RunRows {
  const id = values.map((_, i) => String(i));
  return { id, unit: id.slice(), score: [...values], unitFromRow: true };
}

/** Confere se as linhas servem para a métrica: rótulo 0/1 onde ele é preciso. */
export function checkRows(rows: RunRows, metric: RowMetric): string | undefined {
  if (metric === 'mean') {
    return undefined;
  }
  if (!rows.label) {
    return `A métrica "${metric}" precisa da coluna label (0/1) nas predições.`;
  }
  const bad = rows.label.findIndex((y) => y !== 0 && y !== 1);
  if (bad >= 0) {
    return `label precisa ser 0 ou 1; a linha ${bad + 1} (id ${rows.id[bad]}) tem ${rows.label[bad]}.`;
  }
  if (metric === 'auc' && (!rows.label.includes(0) || !rows.label.includes(1))) {
    return 'AUC precisa de linhas das duas classes (label 0 e 1).';
  }
  return undefined;
}

/** A métrica primária calculada pelo host a partir das linhas, com todas valendo 1. */
export function rowsMetric(rows: RunRows, metric: RowMetric): number {
  if (metric === 'auc') {
    return auc(rows.label ?? [], rows.score);
  }
  return mean(rows.score.map((s, i) => rowValue(metric, s, rows.label?.[i] ?? NaN)));
}
