import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { HookCallbackMatcher, HookEvent } from '@anthropic-ai/claude-agent-sdk';

/**
 * Avaliador congelado: caminhos que agentes não leem nem gravam (conjunto de teste, script de avaliação).
 *
 * O bloqueio roda no hook PreToolUse, que o CLI chama em qualquer modo, até em bypassPermissions. Read, Write,
 * Edit, MultiEdit, NotebookEdit, Grep e Glob são conferidos pelo caminho; Bash e PowerShell pelo texto do
 * comando. O PostToolUse ainda tira da saída de Grep, Glob e Bash as linhas que apontam para caminho protegido.
 *
 * Limites (é defesa em profundidade, não sandbox): um comando pode chegar ao arquivo por indireção que o texto
 * não mostra (variável, base64, glob como `ev*l/`, um script que abre o arquivo, `find . -exec cat`). Um
 * `grep -r` na raiz lê tudo; a saída é filtrada linha a linha, mas o que não começa pelo caminho passa.
 * Agentes Codex não passam por aqui: o app-server do Codex não tem hook antes da ferramenta nem sandbox
 * que negue leitura de uma pasta.
 */

/** Configuração do projeto. Aceita uma lista pura de padrões ou `{ patterns, evaluationCommand, evaluationTimeoutMinutes }`. */
export const PROTECTED_CONFIG = '.agm/protected.json';

export interface ProjectGuardConfig {
  patterns: string[];
  evaluationCommand?: string;
  evaluationTimeoutMinutes?: number;
  /** Erro de leitura do arquivo, para o orquestrador saber que a configuração não valeu. */
  error?: string;
}

const CONFIG_TTL_MS = 2000;
let configCache: { root: string; at: number; value: ProjectGuardConfig } | undefined;

/** Lê `.agm/protected.json` e o setting `agentGraphMaster.protectedPaths`. Cache curto: o hook roda a cada ferramenta. */
export function readProjectGuard(root: string): ProjectGuardConfig {
  if (configCache && configCache.root === root && Date.now() - configCache.at < CONFIG_TTL_MS) {
    return configCache.value;
  }
  const config = vscode.workspace.getConfiguration('agentGraphMaster');
  const value: ProjectGuardConfig = { patterns: [...(config.get<string[]>('protectedPaths', []) ?? [])] };
  const settingCommand = config.get<string>('evaluationCommand', '').trim();
  const file = path.join(root, PROTECTED_CONFIG);
  try {
    if (fs.existsSync(file)) {
      const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      const obj = Array.isArray(raw) ? { patterns: raw } : (raw as Record<string, unknown>);
      if (Array.isArray(obj.patterns)) {
        value.patterns.push(...obj.patterns.filter((p): p is string => typeof p === 'string'));
      }
      if (typeof obj.evaluationCommand === 'string' && obj.evaluationCommand.trim()) {
        value.evaluationCommand = obj.evaluationCommand.trim();
      }
      if (typeof obj.evaluationTimeoutMinutes === 'number' && obj.evaluationTimeoutMinutes > 0) {
        value.evaluationTimeoutMinutes = obj.evaluationTimeoutMinutes;
      }
    }
  } catch (err) {
    value.error = `${PROTECTED_CONFIG} não pôde ser lido: ${err instanceof Error ? err.message : String(err)}`;
  }
  // O arquivo do projeto vence o setting: é ele que viaja com o repositório.
  value.evaluationCommand ??= settingCommand || undefined;
  configCache = { root, at: Date.now(), value };
  return value;
}

const WIN = process.platform === 'win32';
const GLOB_CHARS = /[*?[{]/;

function fold(s: string): string {
  return WIN ? s.toLowerCase() : s;
}

/** `./eval/` → `eval/**`; `\data\test` → `data/test`. Padrão que sai do projeto (`..`) é descartado. */
export function normalizePattern(raw: string): string | undefined {
  let p = raw.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  if (!p || p === '.' || p.split('/').includes('..')) {
    return undefined;
  }
  if (p.endsWith('/')) {
    p += '**';
  }
  return fold(p);
}

function globToRegExp(pattern: string): RegExp {
  // `eval/**` vale também para a própria pasta `eval` (Grep ou ls apontando para ela).
  const dirTail = pattern.endsWith('/**');
  const glob = dirTail ? pattern.slice(0, -3) : pattern;
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end > i) {
        re += `(?:${glob
          .slice(i + 1, end)
          .split(',')
          .map((alt) => alt.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
          .join('|')})`;
        i = end;
      } else {
        re += '\\{';
      }
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}${dirTail ? '(?:/.*)?' : ''}$`);
}

/** Pedaço fixo do começo do padrão, até o primeiro segmento com curinga: `eval/**` → `eval`, `**\/x` → ``. */
function literalPrefix(pattern: string): string {
  const out: string[] = [];
  for (const seg of pattern.split('/')) {
    if (GLOB_CHARS.test(seg)) {
      break;
    }
    out.push(seg);
  }
  return out.join('/');
}

interface Rule {
  pattern: string;
  re: RegExp;
  prefix: string;
}

export class PathRules {
  private readonly rules: Rule[];
  /** Raízes normalizadas (com `/` e caixa dobrada no Windows), para tirar o prefixo absoluto de comandos e saídas. */
  private readonly foldedRoots: string[];

  /** `roots[0]` é o diretório do agente (onde caminhos relativos se resolvem); as demais, outras raízes do projeto. */
  constructor(
    patterns: string[],
    readonly roots: string[],
  ) {
    const seen = new Set<string>();
    this.rules = [];
    for (const raw of patterns) {
      const p = normalizePattern(raw);
      if (p && !seen.has(p)) {
        seen.add(p);
        this.rules.push({ pattern: p, re: globToRegExp(p), prefix: literalPrefix(p) });
      }
    }
    this.foldedRoots = [...new Set(roots.map((r) => fold(path.resolve(r).replace(/\\/g, '/').replace(/\/+$/, ''))))];
  }

  get empty(): boolean {
    return !this.rules.length;
  }

  get patterns(): string[] {
    return this.rules.map((r) => r.pattern);
  }

  /** Caminhos relativos a cada raiz em que `target` está dentro. */
  private relatives(target: string): string[] {
    const abs = path.resolve(this.roots[0], target);
    const candidates = [abs];
    try {
      const real = fs.realpathSync.native(abs);
      if (real !== abs) {
        candidates.push(real);
      }
    } catch {
      // Arquivo ainda não existe (Write de um novo): vale o caminho pedido.
    }
    const out = new Set<string>();
    for (const c of candidates) {
      for (const root of this.roots) {
        const rel = path.relative(root, c);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
          out.add(fold(rel.split(path.sep).join('/')));
        }
      }
    }
    return [...out];
  }

  /** Padrão que protege este caminho relativo (ou uma pasta acima dele). */
  private matchRel(rel: string): string | undefined {
    if (!rel) {
      return undefined;
    }
    const parts = rel.split('/');
    for (const rule of this.rules) {
      for (let n = parts.length; n > 0; n--) {
        if (rule.re.test(parts.slice(0, n).join('/'))) {
          return rule.pattern;
        }
      }
    }
    return undefined;
  }

  /** Padrão que protege `target` (absoluto ou relativo ao agente), ou undefined. */
  match(target: string): string | undefined {
    for (const rel of this.relatives(target)) {
      const hit = this.matchRel(rel);
      if (hit) {
        return hit;
      }
    }
    return undefined;
  }

  /** Uma busca a partir desta pasta pode alcançar caminho protegido. */
  reaches(dir: string): boolean {
    return this.relatives(dir).some((rel) => this.rules.some((r) => !r.prefix || !rel || r.prefix === rel || r.prefix.startsWith(`${rel}/`)));
  }

  /**
   * Heurística sobre o texto de um comando de shell: acha o começo fixo de um padrão (`eval`, `data/test`,
   * `evaluate.py`) escrito como caminho. Pega `cat eval/x`, `type eval\x`, `"./eval"`, `C:\proj\eval\x`
   * e `open('eval/x')`. Não pega indireção. Padrão que começa por curinga é testado token a token.
   */
  scanCommand(command: string): string | undefined {
    let text = fold(command.replace(/\\/g, '/'));
    for (const root of this.foldedRoots) {
      text = text.split(`${root}/`).join(' ');
    }
    const before = `(?:^|[\\s'"=(:,;|&<>\`@]|\\./)`;
    const after = `(?=$|[^a-z0-9_.\\-]|\\.(?![a-z0-9_]))`;
    for (const rule of this.rules) {
      if (rule.prefix) {
        const lit = rule.prefix.replace(/[.+^${}()|[\]\\*?]/g, '\\$&');
        if (new RegExp(`${before}${lit}${after}`).test(text)) {
          return rule.pattern;
        }
      }
    }
    const tokens = text.split(/[\s'"=(),;|&<>`]+/).map((t) => t.replace(/^(\.\/)+/, '')).filter(Boolean);
    for (const token of tokens) {
      const hit = this.matchRel(token);
      if (hit) {
        return hit;
      }
    }
    return undefined;
  }

  /** Linha de saída (grep, glob, ls) que começa por um caminho protegido. Testa cada corte em `:` ou `-`. */
  lineHits(line: string): boolean {
    let text = line.trim().replace(/\\/g, '/');
    const folded = fold(text);
    for (const root of this.foldedRoots) {
      if (folded.startsWith(`${root}/`)) {
        text = text.slice(root.length + 1);
        break;
      }
    }
    text = fold(text.replace(/^(\.\/)+/, ''));
    if (!text) {
      return false;
    }
    if (this.matchRel(text)) {
      return true;
    }
    for (let i = 1; i < text.length; i++) {
      if ((text[i] === ':' || text[i] === '-') && this.matchRel(text.slice(0, i))) {
        return true;
      }
    }
    return false;
  }
}

/** Arquivos que desligariam a proteção se um agente pudesse gravá-los. */
const GUARD_CONFIG_FILES = [PROTECTED_CONFIG, '.vscode/settings.json'];

const PATH_TOOLS: Record<string, string[]> = {
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  NotebookRead: ['notebook_path'],
};
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

function denyText(target: string, pattern: string): string {
  return `Bloqueado: "${target}" é caminho protegido (padrão ${pattern}). Agentes não leem nem gravam o avaliador e os dados de teste; a avaliação oficial é rodada pelo orquestrador. Siga sem esse arquivo e diga no relatório se ele era necessário.`;
}

/** Motivo do bloqueio, ou undefined se a chamada pode seguir. */
export function checkToolCall(rules: PathRules, toolName: string, input: Record<string, unknown>): string | undefined {
  const fields = PATH_TOOLS[toolName];
  if (fields) {
    for (const field of fields) {
      const target = typeof input[field] === 'string' ? (input[field] as string) : '';
      if (!target) {
        continue;
      }
      const hit = rules.match(target);
      if (hit) {
        return denyText(target, hit);
      }
      if (WRITE_TOOLS.has(toolName) && GUARD_CONFIG_FILES.some((f) => new PathRules([f], rules.roots).match(target))) {
        return `Bloqueado: "${target}" guarda a configuração dos caminhos protegidos, e agentes não podem alterá-la.`;
      }
    }
    return undefined;
  }
  if (toolName === 'Grep' || toolName === 'Glob') {
    const base = typeof input.path === 'string' && input.path ? input.path : '.';
    const hit = rules.match(base);
    if (hit) {
      return denyText(base, hit);
    }
    const pattern = typeof input.pattern === 'string' && toolName === 'Glob' ? input.pattern : typeof input.glob === 'string' ? input.glob : '';
    if (pattern) {
      // `eval/**/*.txt` a partir da raiz: o começo fixo do padrão já entra na pasta protegida.
      const fixed = literalPrefix(pattern.replace(/\\/g, '/').replace(/^(\.\/)+/, ''));
      const joined = fixed ? path.join(base, fixed) : '';
      const inside = joined && rules.match(joined);
      if (inside) {
        return denyText(`${base}/${pattern}`, inside);
      }
    }
    return undefined;
  }
  if (SHELL_TOOLS.has(toolName)) {
    const command = typeof input.command === 'string' ? input.command : '';
    const hit = command && rules.scanCommand(command);
    if (hit) {
      return `Bloqueado: o comando cita um caminho protegido (padrão ${hit}). Agentes não leem nem gravam o avaliador e os dados de teste, nem por comando de shell; a avaliação oficial é rodada pelo orquestrador. Siga sem esse caminho e diga no relatório se ele era necessário.`;
    }
    const config = command && new PathRules(GUARD_CONFIG_FILES, rules.roots).scanCommand(command);
    if (config && /(>|\bset-content\b|\bout-file\b|\badd-content\b|\bsed\s+-i\b|\bmv\b|\brm\b|\bdel\b|\bcopy\b|\bcp\b|\bmove\b)/i.test(command)) {
      return 'Bloqueado: o comando parece alterar a configuração dos caminhos protegidos, e agentes não podem alterá-la.';
    }
  }
  return undefined;
}

const OMITTED = (n: number) => `[${n} ${n === 1 ? 'linha omitida' : 'linhas omitidas'}: caminho protegido]`;

function filterLines(rules: PathRules, text: string): { text: string; removed: number } {
  const lines = text.split(/\r?\n/);
  const kept = lines.filter((l) => !rules.lineHits(l));
  const removed = lines.length - kept.length;
  return removed ? { text: [...kept, OMITTED(removed)].join('\n'), removed } : { text, removed: 0 };
}

/** Saída de Grep, Glob ou Bash sem as linhas de caminho protegido. Undefined quando não há o que tirar. */
export function redactToolOutput(rules: PathRules, toolName: string, output: unknown): unknown {
  if (typeof output === 'string') {
    const r = filterLines(rules, output);
    return r.removed ? r.text : undefined;
  }
  if (!output || typeof output !== 'object') {
    return undefined;
  }
  const o = { ...(output as Record<string, unknown>) };
  let changed = false;
  if (Array.isArray(o.filenames)) {
    const kept = (o.filenames as unknown[]).filter((f) => typeof f !== 'string' || !rules.lineHits(f));
    if (kept.length !== o.filenames.length) {
      changed = true;
      o.filenames = kept;
      if (typeof o.numFiles === 'number') {
        o.numFiles = kept.length;
      }
    }
  }
  for (const key of toolName === 'Grep' ? ['content'] : ['stdout', 'stderr']) {
    if (typeof o[key] === 'string') {
      const r = filterLines(rules, o[key] as string);
      if (r.removed) {
        changed = true;
        o[key] = r.text;
      }
    }
  }
  return changed ? o : undefined;
}

const PRE_MATCHER = '^(Read|Write|Edit|MultiEdit|NotebookEdit|NotebookRead|Grep|Glob|Bash|PowerShell)$';
const POST_MATCHER = '^(Grep|Glob|Bash|PowerShell)$';

/**
 * Hooks do SDK para uma sessão de agente. `rules` é chamado a cada ferramenta: a configuração do projeto
 * pode mudar com o agente rodando. `onBlock` avisa o hub (vai para o log do agente).
 */
export function protectHooks(rules: () => PathRules | undefined, onBlock?: (toolName: string, reason: string) => void): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PreToolUse: [
      {
        matcher: PRE_MATCHER,
        hooks: [
          async (input) => {
            if (input.hook_event_name !== 'PreToolUse') {
              return {};
            }
            const r = rules();
            if (!r || r.empty) {
              return {};
            }
            const reason = checkToolCall(r, input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
            if (!reason) {
              return {};
            }
            onBlock?.(input.tool_name, reason);
            return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
          },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: POST_MATCHER,
        hooks: [
          async (input) => {
            if (input.hook_event_name !== 'PostToolUse') {
              return {};
            }
            const r = rules();
            if (!r || r.empty) {
              return {};
            }
            const updated = redactToolOutput(r, input.tool_name, input.tool_response);
            return updated === undefined ? {} : { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: updated } };
          },
        ],
      },
    ],
  };
}
