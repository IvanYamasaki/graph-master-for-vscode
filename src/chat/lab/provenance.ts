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
 *   quadro (diferença, IC, médias, desvios, p, efeito) e as melhoras mínimas registradas. Casa por
 *   arredondamento ou truncamento na precisão citada, em valor absoluto; porcentagem casa com valor/100.
 * - Só roda quando o projeto tem quadro de laboratório. Sem hipótese registrada, relatório nenhum ganha aviso.
 */

const CODE_BLOCK = /```[\s\S]*?```|`[^`\n]*`/g;
// Número com decimal ou com %, sem letra, dígito ou ponto encostado dos lados (tira versões e unidades coladas).
const NUMBER = /(?<![\w.,])[-−+]?(\d+(?:[.,]\d+)?)(\s?%)?(?![\w%]|[.,]\d)/g;

export interface CitedNumber {
  text: string;
  value: number;
  decimals: number;
  percent: boolean;
}

export function citedNumbers(report: string): CitedNumber[] {
  const out: CitedNumber[] = [];
  for (const m of report.replace(CODE_BLOCK, ' ').matchAll(NUMBER)) {
    const digits = m[1];
    const percent = !!m[2];
    const decimals = /[.,](\d+)$/.exec(digits)?.[1].length ?? 0;
    // "100.000" e "1,500" são milhares em pt-BR ou en-US, não decimais: ambíguo demais para acusar.
    const thousands = decimals === 3 && /^[1-9]\d{0,2}[.,]\d{3}$/.test(digits);
    if ((!decimals && !percent) || thousands) {
      continue;
    }
    out.push({ text: m[0].trim(), value: Number(digits.replace(',', '.')), decimals, percent });
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
