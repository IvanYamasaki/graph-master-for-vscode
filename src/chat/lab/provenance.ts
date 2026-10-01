/**
 * Aviso de "número sem registro" no relatório final de um agente.
 *
 * Heurística, e ela tem limites que convém conhecer:
 * - Só olha números com casas decimais ("0.87", "0,87") e porcentagens ("87%", "12.5%"). Inteiros soltos são
 *   quase sempre contagens, seeds, linhas ou anos, e dariam aviso demais.
 * - Ignora blocos de código e trechos entre crases: ali costumam estar comandos e parâmetros, não resultados.
 *   Um agente pode esconder um número inventado ali; o aviso é um alerta, não uma prova.
 * - Número colado em letra ("1.5s", "3.2GB", "0.5x") também fica de fora, assim como versões ("0.7.1") e
 *   separador de milhar ("100.000", "1,500"): com três casas depois do separador e parte inteira não nula,
 *   não dá para saber se é decimal, então não acusa.
 * - Conta como registrado: qualquer métrica de run gravado pelo próprio agente, qualquer número de veredito do
 *   quadro (diferença, IC, médias, desvios, p, efeito), as melhoras mínimas registradas, média, soma, mínimo,
 *   máximo e mediana de cada braço e de cada hipótese (tools.ts, runAggregates) e os números das avaliações do
 *   cofre (guard/lockbox.ts, lockboxNumbers). Casa por
 *   arredondamento ou truncamento na precisão citada, em valor absoluto; porcentagem casa com valor/100.
 * - Só roda quando o projeto tem quadro de laboratório. Sem hipótese registrada, relatório nenhum ganha aviso.
 * - Parâmetro de protocolo não é resultado: nível comum (95%, 0.05, 80%...) perto de "IC", "alpha", "nível",
 *   "confiança" ou "poder", e porcentagem perto de "orçamento", "split" ou "holdout", não são citados.
 * - Também contam como registrados (tools.ts, checkReport): números do prompt que o agente recebeu e números de
 *   arquivo JSON/CSV cujo caminho aparece no próprio relatório, dentro do projeto e até MAX_FILE_BYTES.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const CODE_BLOCK = /```[\s\S]*?```|`[^`\n]*`/g;
// Número com decimal ou com %, sem letra, dígito ou ponto encostado dos lados (tira versões e unidades coladas).
// Com milhar e decimal ao mesmo tempo ("1.234,56" em pt-BR, "1,234.56" em en-US), o separador é inequívoco.
const NUMBER = /(?<![\w.,])[-−+]?(\d{1,3}(?:\.\d{3})+,\d+|\d{1,3}(?:,\d{3})+\.\d+|\d+(?:[.,]\d+)?)(\s?%)?(?![\w%]|[.,]\d)/g;
const GROUPED_BR = /^\d{1,3}(?:\.\d{3})+,\d+$/;
const GROUPED_US = /^\d{1,3}(?:,\d{3})+\.\d+$/;

/** "511,70", "1.234,56" e "1,234.56" viram número; o separador decimal é o último. */
function parseDecimal(digits: string): number {
  if (GROUPED_BR.test(digits)) {
    return Number(digits.replace(/\./g, '').replace(',', '.'));
  }
  if (GROUPED_US.test(digits)) {
    return Number(digits.replace(/,/g, ''));
  }
  return Number(digits.replace(',', '.'));
}

// Palavra de protocolo perto do número: nível de confiança, significância, poder.
const LEVEL_WORD = /(?<!\p{L})(IC|CI|alpha|alfa|α|n[íi]vel|confian[çc]a|confidence|signific[âa]ncia|significance|poder|power)(?!\p{L})/iu;
const LEVEL_PERCENT = new Set([1, 2.5, 5, 10, 20, 80, 90, 95, 97.5, 99, 99.9]);
const LEVEL_DECIMAL = new Set([0.001, 0.01, 0.025, 0.05, 0.1, 0.2, 0.8, 0.9, 0.95, 0.975, 0.99, 0.999]);
// Porcentagem de divisão de dados ou de orçamento: parâmetro, qualquer que seja o valor.
const SPLIT_WORD = /(?<!\p{L})(or[çc]amento|budget|split|holdout|hold-out)(?!\p{L})/iu;

/** Número que é parâmetro de protocolo ("IC de 95%", "alpha 0.05", "15% de orçamento"), não resultado. */
function isProtocol(value: number, percent: boolean, before: string, after: string): boolean {
  // Só a mesma oração: "O 95% CI saiu do veredito. Acurácia 95%" não livra o segundo 95%.
  const clause = /[.;,:!?\n](?=\s|$)/;
  const near = `${before.split(clause).at(-1)} ${after.split(clause)[0]}`;
  if (percent && SPLIT_WORD.test(near)) {
    return true;
  }
  return LEVEL_WORD.test(near) && (percent ? LEVEL_PERCENT.has(value) : LEVEL_DECIMAL.has(value));
}

export interface CitedNumber {
  text: string;
  value: number;
  decimals: number;
  percent: boolean;
}

export function citedNumbers(report: string): CitedNumber[] {
  const out: CitedNumber[] = [];
  const clean = report.replace(CODE_BLOCK, ' ');
  for (const m of clean.matchAll(NUMBER)) {
    const digits = m[1];
    const percent = !!m[2];
    const decimals = /[.,](\d+)$/.exec(digits)?.[1].length ?? 0;
    // "100.000" e "1,500" são milhares em pt-BR ou en-US, não decimais: ambíguo demais para acusar.
    const thousands = decimals === 3 && /^[1-9]\d{0,2}[.,]\d{3}$/.test(digits);
    if ((!decimals && !percent) || thousands) {
      continue;
    }
    const value = parseDecimal(digits);
    const at = m.index ?? 0;
    if (isProtocol(value, percent, clean.slice(Math.max(0, at - 30), at), clean.slice(at + m[0].length, at + m[0].length + 25))) {
      continue;
    }
    out.push({ text: m[0].trim(), value, decimals, percent });
  }
  return out;
}

/** O número citado bate com algum valor conhecido na precisão em que foi escrito? */
export function matches(n: CitedNumber, known: readonly number[]): boolean {
  const tol = 10 ** -n.decimals + 1e-12;
  const candidates = n.percent ? [n.value, n.value / 100] : [n.value];
  const tolFor = (c: number) => (n.percent && c !== n.value ? tol / 100 : tol);
  return known.some((k) => Number.isFinite(k) && candidates.some((c) => Math.abs(Math.abs(k) - c) < tolFor(c)));
}

/** Números citados sem correspondente registrado, sem repetição, na ordem do texto. */
export function unregistered(report: string, known: readonly number[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of citedNumbers(report)) {
    if (!matches(n, known) && !seen.has(n.text)) {
      seen.add(n.text);
      out.push(n.text);
    }
  }
  return out;
}

/**
 * Agregados que um relatório costuma citar de um grupo de runs: média, soma, mínimo, máximo e mediana. Quem chama
 * escolhe os grupos naturais (braço de uma hipótese, a hipótese inteira); combinação arbitrária de runs não entra,
 * senão quase qualquer número acharia um subconjunto que bate.
 */
export function aggregates(values: readonly number[]): { n: number; mean: number; sum: number; min: number; max: number; median: number } | undefined {
  const xs = values.filter((x) => Number.isFinite(x));
  if (!xs.length) {
    return undefined;
  }
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const sum = xs.reduce((s, x) => s + x, 0);
  return {
    n: xs.length,
    mean: sum / xs.length,
    sum,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
  };
}

/** Valores de um texto (o prompt do agente, por exemplo) para somar aos conhecidos; porcentagem entra também como fração. */
export function textNumbers(text: string | undefined): number[] {
  return text ? citedNumbers(text).flatMap((n) => (n.percent ? [n.value, n.value / 100] : [n.value])) : [];
}

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 10;
// Caminho terminado em .json/.jsonl/.csv/.tsv, com barra normal ou invertida e drive opcional. Sem espaço no caminho.
const DATA_PATH = /(?:[A-Za-z]:)?[\w.\-/\\]*[\w-]\.(?:json|jsonl|csv|tsv)(?!\w)/gi;
const FILE_NUMBER = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g;

/**
 * Números de arquivos JSON/CSV citados pelo caminho no texto. Só arquivos dentro de `root` (relativos a ele ou a um
 * worktree em .agm/worktrees/), até MAX_FILE_BYTES cada e no máximo MAX_FILES arquivos.
 */
export function fileNumbers(root: string, report: string): { numbers: number[]; files: string[] } {
  const numbers: number[] = [];
  const files: string[] = [];
  const inside = (abs: string) => {
    const rel = path.relative(root, abs);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  let worktrees: string[] | undefined;
  const candidates = (p: string): string[] => {
    if (path.isAbsolute(p)) {
      return [path.normalize(p)];
    }
    worktrees ??= listDirs(path.join(root, '.agm', 'worktrees'));
    return [path.resolve(root, p), ...worktrees.map((w) => path.resolve(w, p))];
  };
  const seen = new Set<string>();
  for (const m of report.matchAll(DATA_PATH)) {
    if (files.length >= MAX_FILES) {
      break;
    }
    for (const abs of candidates(m[0])) {
      if (seen.has(abs) || !inside(abs)) {
        continue;
      }
      seen.add(abs);
      let raw: string;
      try {
        const st = fs.statSync(abs);
        if (!st.isFile() || st.size > MAX_FILE_BYTES) {
          continue;
        }
        raw = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      for (const x of raw.matchAll(FILE_NUMBER)) {
        const v = Number(x[0]);
        if (Number.isFinite(v)) {
          numbers.push(v);
        }
      }
      files.push(path.relative(root, abs));
      break;
    }
  }
  return { numbers, files };
}

function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}
