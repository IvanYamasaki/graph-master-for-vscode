/**
 * Relatório de experimento em Markdown, montado só com o que está registrado: hipóteses, runs, vereditos e
 * achados de `.agm/lab/`, o contexto de `lab/integrity.ts` e os estados de busca de `.agm/search/`. Nenhum número
 * vem de texto de modelo. A interpretação opcional (lab/interpret.ts) entra no fim, numa seção separada e marcada.
 *
 * Sem VS Code aqui: o hub resolve o escopo, grava o arquivo e abre no editor.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { LabHypothesisInfo, LabState } from '../protocol';
import { fmtNum } from './evaluate';
import type { LabIntegrity } from './integrity';
import { citedNumbers, unregistered } from './provenance';
import type { Hypothesis, LabStore, Run, Verdict } from './store';

export type ReportScope = 'hypothesis' | 'branch' | 'conversation';

export interface ReportInput {
  root: string;
  store: LabStore;
  /** lab.state(): traz a verificação e a poda de cada hipótese. */
  state: LabState;
  integrity: LabIntegrity;
  scope: ReportScope;
  id: string;
}

export interface BuiltReport {
  markdown: string;
  slug: string;
  title: string;
  hypotheses: string[];
}

interface SearchFile {
  id: string;
  kind: 'tournament' | 'sweep';
  status: string;
  conversation?: string;
  hypothesisId?: string;
  spec: { question?: string; name?: string; creator?: string };
  candidates?: { id: string; title: string }[];
  trials?: { state: string }[];
  matches?: { winner?: string }[];
}

const cell = (s: string | undefined) => (s ?? '-').replace(/\|/g, '/').replace(/\s+/g, ' ').trim() || '-';
const code = (s: string | undefined) => (s ? `\`${s.replace(/`/g, "'").replace(/\|/g, '/')}\`` : '-');
const dirLabel = (h: Hypothesis) => (h.direction === 'higher' ? 'maior é melhor' : 'menor é melhor');

export function buildReport(input: ReportInput): BuiltReport | Error {
  const { store, integrity, scope, id } = input;
  const all = store.hypotheses();
  const ctx = integrity.contexts();
  const searches = readSearches(input.root);
  let picked: Hypothesis[];
  let title: string;
  let slug: string;
  if (scope === 'hypothesis') {
    const h = all.find((x) => x.id === id);
    if (!h) {
      return new Error(`Hipótese "${id}" não existe.`);
    }
    // A hipótese e as que derivam dela: o ajuste de critério faz parte da mesma história.
    picked = [h, ...all.filter((x) => x.derivedFrom === h.id)];
    title = `hipótese ${h.id} (${h.title})`;
    slug = `${h.id}-${slugify(h.title)}`;
  } else if (scope === 'branch') {
    picked = all.filter((h) => integrity.branchOf(h, ctx) === id || h.family === id);
    title = `ramo ${id}`;
    slug = `ramo-${slugify(id)}`;
  } else {
    const sweepHyps = new Set(searches.filter((s) => s.conversation === id && s.hypothesisId).map((s) => s.hypothesisId!));
    picked = all.filter((h) => ctx.get(h.id)?.conversation === id || sweepHyps.has(h.id));
    title = `conversa ${id.slice(0, 8)}`;
    slug = `conversa-${slugify(id.slice(0, 8))}`;
  }
  if (!picked.length && !(scope === 'conversation' && searches.some((s) => s.conversation === id))) {
    return new Error(`Nada registrado para ${title}. Hipóteses do quadro: ${all.map((h) => h.id).join(', ') || 'nenhuma'}.`);
  }
  const infos = new Map(input.state.hypotheses.map((x) => [x.id, x]));
  const ids = new Set(picked.map((h) => h.id));
  const confirm = picked.filter((h) => !h.sweepId);
  const verdicts = store.verdicts();
  const runs = store.runs();
  const L: string[] = [];

  L.push(`# Relatório de experimento: ${title}`, '');
  L.push(
    `Gerado em ${new Date().toISOString()} a partir de \`.agm/lab/\` (hipóteses, runs, vereditos, achados) e \`.agm/search/\`. Todo número daqui saiu desses arquivos; nenhum foi escrito por modelo. Uma interpretação gerada por modelo, se houver, fica separada no fim.`,
    '',
  );

  // ---------- Resumo ----------
  L.push('## Resumo', '');
  if (confirm.length) {
    L.push('| Hipótese | Métrica | Status | Veredito | Diferença [IC 95%] | p ajustado (BH) | Verificação |', '|---|---|---|---|---|---|---|');
    for (const h of confirm) {
      const v = verdicts.filter((x) => x.hypothesisId === h.id).at(-1);
      const info = infos.get(h.id);
      L.push(
        `| ${h.id} · ${cell(h.title)} | ${cell(h.metric)} | ${info?.status ?? store.status(h)}${info?.pruned ? ' (podada)' : ''} | ${v ? v.verdict : '-'} | ${v ? `${fmtNum(v.diff)} [${fmtNum(v.ci[0])}, ${fmtNum(v.ci[1])}]` : '-'} | ${v ? fmtNum(v.pAdjusted) : '-'} | ${seal(info, v)} |`,
      );
    }
    L.push('');
  }
  const c = integrity.counts(confirm);
  L.push(
    `Testado neste escopo: ${c.hypotheses} hipótese(s) confirmatória(s) em ${c.metrics} métrica(s) primária(s), ${c.declared} com veredito, ${c.attempts} chamada(s) de declare_result.${picked.length > confirm.length ? ` Mais ${picked.length - confirm.length} hipótese(s) exploratória(s) de varredura.` : ''}`,
    '',
  );

  // ---------- Avisos ----------
  const warnings = integrity.warnings(ids);
  L.push('## Avisos de integridade', '');
  L.push(...(warnings.length ? warnings.map((w) => `- ${w.text}`) : ['- Nenhum dos três sinais (troca de métrica após o resultado, muitas hipóteses sem ordem pré-registrada, parada opcional).']), '');

  // ---------- Hipóteses ----------
  for (const h of picked) {
    L.push(...hypothesisSection(h, store, verdicts.filter((v) => v.hypothesisId === h.id), runs.filter((r) => r.hypothesisId === h.id), infos.get(h.id), ctx));
  }

  // ---------- Descartadas e podadas ----------
  const dropped = confirm.filter((h) => infos.get(h.id)?.pruned || verdicts.filter((v) => v.hypothesisId === h.id).at(-1)?.verdict === 'refutada' || all.some((x) => x.derivedFrom === h.id));
  L.push('## Descartadas e podadas', '');
  if (!dropped.length) {
    L.push('- Nenhuma.');
  }
  for (const h of dropped) {
    const why: string[] = [];
    const pr = infos.get(h.id)?.pruned;
    if (pr) {
      why.push(`podada por ${pr.by} em ${pr.at}`);
    }
    const v = verdicts.filter((x) => x.hypothesisId === h.id).at(-1);
    if (v?.verdict === 'refutada') {
      why.push(`refutada (${v.id})`);
    }
    const kids = all.filter((x) => x.derivedFrom === h.id).map((x) => x.id);
    if (kids.length) {
      why.push(`substituída por ${kids.join(', ')} (derived_from)`);
    }
    L.push(`- ${h.id} · ${h.title}: ${why.join('; ')}.`);
  }
  L.push('');

  // ---------- Buscas ----------
  const tours = new Set(picked.flatMap((h) => [...h.statement.matchAll(/do torneio (tor\d+)/g)].map((m) => m[1])));
  const related = searches.filter((s) => (scope === 'conversation' && s.conversation === id) || (s.hypothesisId && ids.has(s.hypothesisId)) || tours.has(s.id));
  L.push('## Buscas relacionadas', '');
  if (!related.length) {
    L.push('- Nenhum torneio nem varredura ligado a este escopo.');
  }
  for (const s of related) {
    if (s.kind === 'tournament') {
      const done = (s.matches ?? []).filter((m) => m.winner).length;
      const promoted = picked.filter((h) => h.statement.includes(`do torneio ${s.id}`)).map((h) => h.id);
      L.push(
        `- Torneio ${s.id} (${s.status}): "${cell(s.spec.question)}". ${s.candidates?.length ?? 0} candidato(s), ${done} partida(s) decidida(s). Só prioriza ideias; não mede nada.${promoted.length ? ` Promovido a hipótese: ${promoted.join(', ')}.` : ''} Estado em \`.agm/search/${s.id}.json\`.`,
      );
    } else {
      const done = (s.trials ?? []).filter((t) => t.state === 'complete').length;
      L.push(
        `- Varredura ${s.id} (${s.status}): "${cell(s.spec.name)}". ${done} de ${s.trials?.length ?? 0} trial(s) completo(s)${s.hypothesisId ? `, runs na hipótese exploratória ${s.hypothesisId}` : ''}. O melhor trial é otimista: só uma hipótese confirmatória prova melhora. Estado em \`.agm/search/${s.id}.json\`.`,
      );
    }
  }
  L.push('');

  // ---------- O que não foi testado ----------
  L.push('## O que não foi testado', '');
  const gaps: string[] = [];
  for (const h of confirm) {
    const hr = runs.filter((r) => r.hypothesisId === h.id);
    for (const arm of h.arms) {
      const seeds = new Set(hr.filter((r) => r.arm === arm && Number.isFinite(r.metrics[h.metric])).map((r) => r.seed)).size;
      if (seeds < h.minSeeds) {
        gaps.push(`${h.id}: braço "${arm}" com ${seeds} de ${h.minSeeds} seeds pré-registradas.`);
      }
    }
    if (!verdicts.some((v) => v.hypothesisId === h.id)) {
      gaps.push(`${h.id}: sem declare_result; nenhuma conclusão comparativa sobre "${h.metric}".`);
    }
  }
  const primary = new Set(picked.map((h) => h.metric));
  const measured = new Set(runs.filter((r) => ids.has(r.hypothesisId)).flatMap((r) => Object.keys(r.metrics)));
  const untested = [...measured].filter((m) => !primary.has(m));
  if (untested.length) {
    gaps.push(`Métricas registradas nos runs e nunca testadas como primária: ${untested.join(', ')}. Qualquer afirmação sobre elas é exploratória.`);
  }
  L.push(...(gaps.length ? gaps.map((g) => `- ${g}`) : ['- Nada pendente: todos os braços têm as seeds pré-registradas e todas as hipóteses têm veredito.']), '');

  return { markdown: L.join('\n'), slug, title, hypotheses: picked.map((h) => h.id) };
}

function seal(info: LabHypothesisInfo | undefined, v: Verdict | undefined): string {
  const ver = info?.verification;
  if (!v || !ver || ver.verdictId !== v.id) {
    return v?.verdict === 'suportada' ? 'sem verificação' : '-';
  }
  return `${ver.seal} (${ver.agent})`;
}

function hypothesisSection(
  h: Hypothesis,
  store: LabStore,
  vs: Verdict[],
  runs: Run[],
  info: LabHypothesisInfo | undefined,
  ctx: ReturnType<LabIntegrity['contexts']>,
): string[] {
  const L: string[] = [];
  const where = ctx.get(h.id);
  L.push(`## ${h.id}: ${h.title}`, '');
  if (h.sweepId) {
    L.push(`Hipótese exploratória da varredura ${h.sweepId}: guarda os trials, não passa por declare_result.`, '');
  }
  L.push(`**Enunciado pré-registrado** (${h.createdAt}, por ${h.createdBy}${where?.conversation ? `, conversa ${where.conversation.slice(0, 8)}` : ''}${where?.branch ? `, ramo ${where.branch}` : ''}):`, '');
  L.push(...h.statement.split('\n').map((l) => `> ${l}`), '');
  L.push(
    `**Critério pré-registrado.** Métrica primária "${h.metric}" (${dirLabel(h)}); melhora mínima ${fmtNum(h.minImprovement)} ${h.improvementKind === 'relative' ? 'relativa ao baseline' : 'absoluta'}; braços "${h.arms[0]}" (baseline) x "${h.arms[1]}" (variante); mínimo de ${h.minSeeds} seeds por braço; alpha ${fmtNum(h.alpha)}; família "${h.family}".${h.derivedFrom ? ` Derivada de ${h.derivedFrom}.` : ''}${h.budget?.maxRuns ? ` Orçamento: ${h.budget.maxRuns} runs.` : ''}${h.budget?.note ? ` Orçamento: ${cell(h.budget.note)}.` : ''}${info?.pruned ? ` Podada por ${info.pruned.by} em ${info.pruned.at}.` : ''}`,
    '',
  );
  const seedsLine = h.arms.map((a) => {
    const seeds = [...new Set(runs.filter((r) => r.arm === a).map((r) => r.seed))].sort((x, y) => x - y);
    return `"${a}": ${seeds.length ? seeds.join(', ') : 'nenhuma'}`;
  });
  L.push(`**Seeds registradas.** ${seedsLine.join('; ')}.`, '');

  const v = vs.at(-1);
  if (v) {
    const [b, va] = v.arms;
    L.push(`### Veredito ${v.id}: ${v.verdict.toUpperCase()}`, '');
    L.push(`Tentativa ${v.attempt} de declare_result, por ${v.by} em ${v.at}. Selo de verificação: ${seal(info, v)}.`, '');
    L.push('| Braço | n | média ± desvio |', '|---|---|---|');
    for (const a of v.arms) {
      L.push(`| ${cell(a.arm)} | ${a.n} | ${fmtNum(a.mean)} ± ${fmtNum(a.sd)} |`);
    }
    L.push('');
    L.push(
      `- Diferença (${va?.arm ?? h.arms[1]} menos ${b?.arm ?? h.arms[0]}, positivo é melhora): ${fmtNum(v.diff)}${typeof v.relDiff === 'number' ? ` (${fmtNum(v.relDiff * 100)}% do baseline)` : ''}; IC ${fmtNum(v.ciLevel * 100)}% [${fmtNum(v.ci[0])}, ${fmtNum(v.ci[1])}], bootstrap ${v.mode === 'paired-samples' ? 'pareado por amostra' : 'por seed'}.`,
      `- Efeito ${v.mode === 'seeds' ? 'd de Cohen' : 'd_z'}: ${fmtNum(v.effect)}. p bruto ${fmtNum(v.p)}; p ajustado por Benjamini-Hochberg ${fmtNum(v.pAdjusted)}, família "${v.family}" com ${v.familySize} hipótese(s).`,
      `- Melhora mínima exigida na unidade da métrica: ${fmtNum(v.threshold)}.${v.verdict === 'inconclusiva' && v.seedsMissing !== undefined ? ` Seeds que faltam por braço (estimativa do veredito): ${v.seedsMissing}.` : ''}`,
      ...v.reasons.map((r) => `- ${r}`),
      ...v.warnings.map((w) => `- Atenção: ${w}`),
    );
    const older = vs.slice(0, -1);
    if (older.length) {
      L.push(`- Tentativas anteriores: ${older.map((o) => `${o.id} ${o.verdict} (p ajustado ${fmtNum(o.pAdjusted)}, n ${o.arms.map((a) => a.n).join('/')})`).join('; ')}.`);
    }
    L.push('');
  } else if (!h.sweepId) {
    L.push('Sem veredito: declare_result ainda não rodou nesta hipótese, então não há média, IC nem p a relatar.', '');
  }

  if (runs.length) {
    L.push(`### Runs (${runs.length})`, '');
    L.push(`| Run | Braço | Seed | ${cell(h.metric)} | Comando | Commit | sha256 do JSON | Fonte | Agente |`, '|---|---|---|---|---|---|---|---|---|');
    const shown = runs.length > 80 ? runs.slice(-80) : runs;
    for (const r of shown) {
      const val = r.metrics[h.metric];
      L.push(
        `| ${r.id} | ${cell(r.arm)} | ${r.seed} | ${Number.isFinite(val) ? String(val) : '-'} | ${code(r.command)} | ${r.commit ? code(r.commit.slice(0, 10)) + (r.dirty ? ' + alterações' : '') : '-'} | ${code(r.metricsFileHash)} | ${r.source} | ${r.agent} |`,
      );
    }
    if (shown.length < runs.length) {
      L.push('', `Mostrando os ${shown.length} mais recentes; o resto está em \`.agm/lab/runs.jsonl\`.`);
    }
    L.push('');
  }
  const findings = store.findings().filter((f) => f.hypothesisId === h.id);
  if (findings.length) {
    L.push('### Achados', '', ...findings.map((f) => `- ${f.id} (${f.agent}, runs ${f.runIds.join(', ')}): ${f.text}`), '');
  }
  return L;
}

/** Acrescenta a interpretação do modelo numa seção separada, com os números dela conferidos contra os do relatório. */
export function withInterpretation(markdown: string, text: string, model: string): string {
  const known = citedNumbers(markdown).flatMap((n) => (n.percent ? [n.value, n.value / 100] : [n.value]));
  const loose = unregistered(text, known);
  return [
    markdown,
    '---',
    '',
    `## Interpretação, gerada por modelo, a verificar`,
    '',
    `_Texto escrito por ${model} a partir das seções acima. Não é dado registrado: confira cada afirmação nas tabelas._`,
    '',
    text.trim(),
    '',
    loose.length ? `> Números da interpretação que não aparecem nas seções acima: ${loose.join(', ')}. Trate como não verificados.` : '> Todos os números com casas decimais da interpretação aparecem nas seções acima.',
    '',
  ].join('\n');
}

/** Grava em `.agm/lab/reports/<data>-<slug>.md` sem sobrescrever (sufixo -2, -3...). */
export function saveReport(root: string, slug: string, markdown: string): string {
  const dir = path.join(root, '.agm', 'lab', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const base = `${new Date().toISOString().slice(0, 10)}-${slug}`;
  let file = path.join(dir, `${base}.md`);
  for (let i = 2; fs.existsSync(file); i++) {
    file = path.join(dir, `${base}-${i}.md`);
  }
  fs.writeFileSync(file, markdown, 'utf8');
  return file;
}

export function readSearches(root: string): SearchFile[] {
  const dir = path.join(root, '.agm', 'search');
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((f) => /^(tor|sw)\d+\.json$/.test(f));
  } catch {
    return [];
  }
  const out: SearchFile[] = [];
  for (const f of names) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as SearchFile;
      if (s && (s.kind === 'tournament' || s.kind === 'sweep')) {
        out.push(s);
      }
    } catch {
      // Arquivo pela metade: fica de fora.
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'relatorio'
  );
}

/** Ferramenta experiment_report; o hub resolve o escopo, grava, abre no editor e devolve o caminho. */
export function reportTool(generate: (args: { scope: ReportScope; id?: string; interpret?: boolean }) => Promise<string | Error>): SdkMcpToolDefinition<any> {
  return tool(
    'experiment_report',
    'Gera o relatório de experimento em Markdown (.agm/lab/reports/) só com dados registrados: hipóteses e critérios pré-registrados, seeds, média ± desvio, diferença com IC, p ajustado e família BH, veredito e selo de verificação, runs com comando, commit e sha, descartadas/podadas, buscas relacionadas, o que não foi testado e avisos de p-hacking. Abre o arquivo no editor do usuário.',
    {
      scope: z.enum(['hypothesis', 'branch', 'conversation']).describe('"hypothesis": uma hipótese (id obrigatório); "branch": um ramo git (id omitido: o ramo atual); "conversation": esta conversa (padrão do id)'),
      id: z.string().optional().describe('Id da hipótese (ex.: "h3"), nome do ramo ou id da conversa'),
      interpret: z.boolean().optional().describe('true: um modelo barato escreve uma interpretação curta, numa seção separada e marcada como "a verificar". Omitido: false'),
    },
    async (args) => {
      const r = await generate({ scope: args.scope, id: args.id?.trim() || undefined, interpret: args.interpret });
      return r instanceof Error ? { content: [{ type: 'text' as const, text: r.message }], isError: true } : { content: [{ type: 'text' as const, text: r }] };
    },
    { alwaysLoad: true },
  );
}
