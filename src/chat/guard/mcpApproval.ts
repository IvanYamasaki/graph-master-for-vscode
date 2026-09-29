/**
 * Aprovação dos servidores MCP do `.mcp.json` do projeto.
 *
 * As sessões sobem com settingSources 'project' (para ler CLAUDE.md e .claude/settings.json), e com isso o CLI
 * executa os servidores do `.mcp.json` sem perguntar nada: abrir o repositório de outra pessoa bastaria para os
 * agentes rodarem os comandos que ela escreveu lá. O mecanismo que fecha isso, conferido contra o CLI 2.1.284:
 * `disabledMcpjsonServers` passado como flag settings (opção `settings` do SDK). O CLI junta essa lista com a dos
 * outros arquivos de configuração, e servidor na lista de desligados não sobe, mesmo que o `.claude/settings.json`
 * do próprio projeto traga `enableAllProjectMcpServers: true` ou o nome em `enabledMcpjsonServers`.
 * `strictMcpConfig` não serve: desligaria também os servidores do usuário e os conectores do claude.ai.
 *
 * Cada entrada é aprovada pelo nome e pelo sha256 do conteúdo (chaves ordenadas). Entrada que muda de conteúdo
 * volta a ser desconhecida e fica desligada até nova aprovação. As decisões ficam no workspaceState.
 * O comando "Configurar pacote de pesquisa" grava no `.mcp.json` depois de uma confirmação modal; o que ele grava
 * conta como aprovado (`approveEntries`).
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Memento } from 'vscode';

const KEY = 'agentGraphMaster.mcpApprovals';

export interface ProjectMcpServer {
  name: string;
  /** Linha legível: comando e argumentos, ou tipo e endereço. */
  command: string;
  hash: string;
  entry: unknown;
}

interface Decision {
  name: string;
  hash: string;
  decision: 'allow' | 'block';
  at: string;
  by: 'usuário' | 'pacote de pesquisa';
}

let memento: Memento | undefined;
/** Pedido em aberto por pasta: dois painéis abertos juntos não mostram dois modais. */
const inFlight = new Map<string, Promise<string[]>>();

export function initMcpApprovals(m: Memento): void {
  memento = m;
}

function decisions(): Record<string, Decision> {
  return memento?.get<Record<string, Decision>>(KEY, {}) ?? {};
}

const keyOf = (name: string, hash: string) => `${name}\n${hash}`;

/** JSON com as chaves em ordem: mesma entrada, mesmo hash, venha de onde vier. */
function canonical(x: unknown): string {
  if (Array.isArray(x)) {
    return `[${x.map(canonical).join(',')}]`;
  }
  if (x && typeof x === 'object') {
    return `{${Object.keys(x as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((x as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(x) ?? 'null';
}

export function entryHash(entry: unknown): string {
  return createHash('sha256').update(canonical(entry)).digest('hex').slice(0, 16);
}

/** Servidores do `.mcp.json` da pasta. Arquivo ausente ou inválido: lista vazia e, se inválido, o erro. */
export function readProjectMcp(cwd: string): { servers: ProjectMcpServer[]; error?: string } {
  const file = path.join(cwd, '.mcp.json');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { servers: [] };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { servers: [], error: `${file} não é JSON válido (${err instanceof Error ? err.message : String(err)}).` };
  }
  const map = data && typeof data === 'object' ? (data as { mcpServers?: unknown }).mcpServers : undefined;
  if (!map || typeof map !== 'object') {
    return { servers: [] };
  }
  return {
    servers: Object.entries(map as Record<string, unknown>).map(([name, entry]) => ({ name, command: describe(entry), hash: entryHash(entry), entry })),
  };
}

function describe(entry: unknown): string {
  const e = (entry ?? {}) as { command?: unknown; args?: unknown; url?: unknown; type?: unknown };
  if (typeof e.command === 'string') {
    const args = Array.isArray(e.args) ? e.args.map((a) => String(a)) : [];
    return [e.command, ...args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');
  }
  if (typeof e.url === 'string') {
    return `${typeof e.type === 'string' ? e.type : 'http'} ${e.url}`;
  }
  return JSON.stringify(entry).slice(0, 200);
}

export function decisionFor(s: ProjectMcpServer): 'allow' | 'block' | undefined {
  return decisions()[keyOf(s.name, s.hash)]?.decision;
}

/**
 * Flag settings para a sessão: todo servidor do `.mcp.json` que não está aprovado com o conteúdo atual vai para
 * `disabledMcpjsonServers`. Sem `.mcp.json`, nada.
 */
export function projectMcpSettings(cwd: string): { disabledMcpjsonServers: string[] } | undefined {
  const { servers } = readProjectMcp(cwd);
  const off = servers.filter((s) => decisionFor(s) !== 'allow').map((s) => s.name);
  return off.length ? { disabledMcpjsonServers: off } : undefined;
}

export async function record(servers: readonly ProjectMcpServer[], decision: 'allow' | 'block', by: Decision['by']): Promise<void> {
  if (!memento || !servers.length) {
    return;
  }
  const all = { ...decisions() };
  const at = new Date().toISOString();
  for (const s of servers) {
    all[keyOf(s.name, s.hash)] = { name: s.name, hash: s.hash, decision, at, by };
  }
  await memento.update(KEY, all);
}

/** O pacote de pesquisa gravou estas entradas com confirmação do usuário: contam como aprovadas. */
export async function approveEntries(entries: Record<string, unknown>): Promise<void> {
  await record(
    Object.entries(entries).map(([name, entry]) => ({ name, entry, hash: entryHash(entry), command: describe(entry) })),
    'allow',
    'pacote de pesquisa',
  );
}

export interface ApprovalUi {
  /** Modal com a lista; devolve o botão escolhido ou undefined (fechado sem escolher). */
  ask(message: string, detail: string, buttons: string[]): Thenable<string | undefined>;
  notice(text: string): void;
}

/**
 * Pergunta sobre os servidores ainda sem decisão. Devolve os nomes que passaram a ser permitidos agora (o chamador
 * reinicia a sessão para carregá-los). Fechar o modal sem escolher não grava nada: continuam desligados e a pergunta
 * volta na próxima abertura. `where` nomeia a origem na pergunta: o worktree de um agente pode trazer um `.mcp.json`
 * diferente do projeto (branch com outro conteúdo), e aí a pergunta precisa dizer de quem é.
 */
export function checkProjectMcp(cwd: string, ui: ApprovalUi, where = 'Este projeto'): Promise<string[]> {
  const running = inFlight.get(cwd);
  if (running) {
    return running;
  }
  const job = (async () => {
    const { servers, error } = readProjectMcp(cwd);
    if (error) {
      ui.notice(`${error} Os servidores MCP do projeto não foram conferidos.`);
    }
    const pending = servers.filter((s) => !decisionFor(s));
    if (!pending.length) {
      return [];
    }
    const changed = pending.filter((s) => Object.values(decisions()).some((d) => d.name === s.name));
    const detail = [
      'Os agentes executam estes servidores com as suas permissões. Enquanto não houver aprovação, nenhum deles sobe.',
      '',
      ...pending.map((s) => `• ${s.name}${changed.includes(s) ? ' (conteúdo mudou desde a última aprovação)' : ''}: ${s.command}`),
      '',
      `Arquivo: ${path.join(cwd, '.mcp.json')}`,
    ].join('\n');
    const answer = await ui.ask(`${where} declara ${pending.length} servidor(es) MCP em .mcp.json. Permitir que os agentes os executem?`, detail, ['Permitir', 'Bloquear']);
    if (answer === 'Permitir') {
      await record(pending, 'allow', 'usuário');
      return pending.map((s) => s.name);
    }
    if (answer === 'Bloquear') {
      await record(pending, 'block', 'usuário');
      ui.notice(`Servidores MCP do projeto bloqueados: ${pending.map((s) => s.name).join(', ')}. Eles não sobem nas sessões desta pasta; se o conteúdo mudar, a pergunta volta.`);
    } else {
      ui.notice(`Servidores MCP do projeto sem aprovação (${pending.map((s) => s.name).join(', ')}): continuam desligados. A pergunta volta no próximo chat.`);
    }
    return [];
  })().finally(() => inFlight.delete(cwd));
  inFlight.set(cwd, job);
  return job;
}
