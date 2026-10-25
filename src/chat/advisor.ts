/**
 * Advisor tool do Claude Code nos agentes roteados: o executor consulta um modelo mais forte nos pontos de decisão.
 * Aqui ficam o pareamento (quem pode aconselhar quem), a família de cada alias e a conta do uso do advisor, que vem
 * em `usage.iterations` com type "advisor_message" e fica fora do usage de topo. Sem VS Code, para testar com node.
 */
import { ADVISOR_REDACTED } from './protocol';
import { estimateUsd } from './usdEstimate';

export type AdvisorFamily = 'haiku' | 'sonnet' | 'opus' | 'fable';

export interface ModelVersion {
  family: AdvisorFamily;
  /** 4.5, 5, 5.5... Ausente quando o id não traz versão legível. */
  version?: number;
}

/**
 * O que cada alias resolvia no CLI 2.1.274 (supportedModels, 2026-10-12): opus → claude-opus-5, sonnet →
 * claude-sonnet-5. O alias depende da conta e da versão do CLI; quem tem a lista viva passa `resolve` e ela vale antes.
 */
const ALIASES: Record<string, Required<ModelVersion>> = {
  haiku: { family: 'haiku', version: 4.5 },
  sonnet: { family: 'sonnet', version: 5 },
  opus: { family: 'opus', version: 5 },
  fable: { family: 'fable', version: 5.1 },
};

/** Alias → id completo pela lista viva do CLI (supportedModels). Sem lista ou alias fora dela: undefined. */
export type AliasResolver = (alias: string) => string | undefined;

const FAMILIES: readonly AdvisorFamily[] = ['haiku', 'sonnet', 'opus', 'fable'];

const NAMES: Record<AdvisorFamily, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' };

/**
 * Família e versão pelo alias ou pelo id ("opus", "claude-sonnet-5-5", "claude-haiku-4-5-20251001",
 * "claude-opus-4-8[1m]"). Mythos conta como Fable. Fora disso (gpt-5, "default"): undefined.
 */
export function parseModel(model: string | undefined, resolve?: AliasResolver): ModelVersion | undefined {
  const m = (model ?? '').trim().toLowerCase().replace(/\[\d+m\]$/, '');
  if (!m) {
    return undefined;
  }
  if (ALIASES[m]) {
    const id = resolve?.(m);
    const live = id && !ALIASES[id.toLowerCase()] ? parseModel(id) : undefined;
    return live?.version !== undefined ? live : { ...ALIASES[m] };
  }
  const parts = m.replace(/^claude-/, '').split('-');
  const family = (parts[0] === 'mythos' ? 'fable' : parts[0]) as AdvisorFamily;
  if (!FAMILIES.includes(family)) {
    return undefined;
  }
  // Data no fim (20251001) não é versão: só números curtos contam.
  const nums = parts.slice(1).filter((p) => /^\d{1,2}$/.test(p));
  return nums.length ? { family, version: Number(`${nums[0]}.${nums[1] ?? 0}`) } : { family };
}

/** "Opus 5,5", "Sonnet" (sem versão). */
export function advisorName(model: string | undefined, resolve?: AliasResolver): string {
  const v = parseModel(model, resolve);
  if (!v) {
    return model || '?';
  }
  return `${NAMES[v.family]}${v.version !== undefined ? ` ${String(v.version).replace('.', ',')}` : ''}`;
}

/** Advisor aceito: família e versão mínima (sem versão mínima, qualquer uma da família). */
type Accepts = { family: AdvisorFamily; min?: number }[];

/**
 * Quem pode aconselhar o executor: o advisor precisa de rank igual ou maior. Tabela das docs do advisor tool
 * (2026-10). Executor que a tabela não cobre: undefined, e quem chama deixa o CLI decidir.
 */
function acceptedBy(exec: ModelVersion): Accepts | undefined {
  const v = exec.version;
  if (v === undefined) {
    return undefined;
  }
  switch (exec.family) {
    case 'fable':
      return v >= 5.1 ? [{ family: 'fable', min: 5.1 }] : v >= 5 ? [{ family: 'fable', min: 5 }] : undefined;
    case 'opus':
      if (v >= 5) {
        return [{ family: 'fable' }, { family: 'opus', min: 5 }];
      }
      return v >= 4.7 ? [{ family: 'fable' }, { family: 'opus', min: 4.7 }, { family: 'sonnet', min: 5.5 }] : undefined;
    case 'sonnet':
      if (v >= 5.5) {
        return [{ family: 'fable' }, { family: 'opus', min: 5 }, { family: 'sonnet', min: 5.5 }];
      }
      if (v >= 5) {
        return [{ family: 'fable' }, { family: 'opus', min: 4.7 }, { family: 'sonnet', min: 5 }, { family: 'haiku', min: 5.5 }];
      }
      return v >= 4.6 ? [{ family: 'fable' }, { family: 'opus' }, { family: 'sonnet' }, { family: 'haiku', min: 5.5 }] : undefined;
    case 'haiku':
      if (v >= 5.5) {
        return [{ family: 'fable' }, { family: 'opus', min: 4.7 }, { family: 'sonnet', min: 5 }, { family: 'haiku', min: 5.5 }];
      }
      return v >= 4.5 ? [{ family: 'fable' }, { family: 'opus' }, { family: 'sonnet' }, { family: 'haiku', min: 5.5 }] : undefined;
  }
}

export type AdvisorCheck =
  | { ok: true; advisor: string; note?: string }
  | { ok: false; reason: string };

/**
 * Confere o par executor/advisor. Par inválido o CLI só não anexa, sem erro: aqui ele vira aviso no retorno do
 * spawn_agent, e o agente sobe sem advisor. Executor desconhecido (modelo padrão do chat, id fora da tabela) passa,
 * com nota.
 */
export function checkAdvisor(executor: string | undefined, advisor: string, resolve?: AliasResolver): AdvisorCheck {
  const raw = advisor.trim();
  const adv = parseModel(raw, resolve);
  if (!adv) {
    return { ok: false, reason: `advisor "${raw}" não é um modelo Claude conhecido (use "opus", "sonnet", "fable" ou um id claude-*); subiu sem advisor` };
  }
  const exec = parseModel(executor, resolve);
  const accepts = exec ? acceptedBy(exec) : undefined;
  if (!exec || !accepts) {
    return { ok: true, advisor: raw, note: `não sei se ${executor ? advisorName(executor, resolve) : 'o modelo padrão'} aceita ${advisorName(raw, resolve)} como advisor; se não aceitar, o CLI sobe sem ele` };
  }
  const fits = accepts.some((a) => a.family === adv.family && (a.min === undefined || (adv.version ?? 0) >= a.min - 1e-9));
  return fits ? { ok: true, advisor: raw } : { ok: false, reason: `advisor ${advisorName(raw, resolve)} não pode aconselhar ${advisorName(executor, resolve)}; subiu sem advisor` };
}

/** Uso do advisor numa mensagem do executor: soma das iterações "advisor_message", com o preço do modelo de cada uma. */
export interface AdvisorSpend {
  tokens: number;
  /** Ausente quando o modelo do advisor está fora da tabela de preços. */
  usd?: number;
  model?: string;
}

interface IterationLike {
  type?: string;
  model?: string;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function advisorSpend(usage: unknown): AdvisorSpend | undefined {
  const iterations = (usage as { iterations?: unknown } | null | undefined)?.iterations;
  if (!Array.isArray(iterations)) {
    return undefined;
  }
  let found = false;
  const out: AdvisorSpend = { tokens: 0 };
  for (const it of iterations as IterationLike[]) {
    if (it?.type !== 'advisor_message') {
      continue;
    }
    found = true;
    out.tokens += (it.input_tokens ?? 0) + (it.output_tokens ?? 0) + (it.cache_read_input_tokens ?? 0) + (it.cache_creation_input_tokens ?? 0);
    const usd = estimateUsd(it, it.model);
    if (usd !== undefined) {
      out.usd = (out.usd ?? 0) + usd;
    }
    out.model ??= it.model;
  }
  return found ? out : undefined;
}

/** Linha do advisor no log: o resultado legível, o cifrado ou o erro do servidor. */
export function advisorResultText(content: unknown): { text: string; isError: boolean } {
  const c = (content ?? {}) as { type?: string; text?: unknown; error_code?: unknown };
  if (c.type === 'advisor_result' && typeof c.text === 'string') {
    return { text: c.text, isError: false };
  }
  if (c.type === 'advisor_redacted_result') {
    return { text: ADVISOR_REDACTED, isError: false };
  }
  if (c.type === 'advisor_tool_result_error') {
    return { text: `o advisor falhou: ${String(c.error_code ?? 'erro')}`, isError: true };
  }
  return { text: '', isError: false };
}
