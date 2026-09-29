// Isolamento por worktree: cada agente criado com isolation "worktree" trabalha numa cópia git própria,
// para N experimentos em paralelo não sobrescreverem arquivos, checkpoints e configs uns dos outros.
//
// Por que a extensão cria o worktree em vez de usar o `--worktree` do Claude Code: o do CLI escolhe sozinho a pasta
// e a branch, parte por padrão de origin/<branch padrão> (não do HEAD local), não existe no Codex e amarra a retomada
// da sessão às verificações de segurança dele. Criando com `git worktree add`, a extensão sabe o caminho e a branch
// desde o início, passa o caminho como cwd da sessão (Claude ou Codex) e consegue mesclar e descartar depois.
//
// Onde: <raiz do repositório>/.agm/worktrees/<nome>. Dentro do projeto o worktree fica no mesmo disco (a cópia do
// .worktreeinclude é rápida), é fácil de achar e some junto com o projeto. O `.agm/.gitignore` (AGM_IGNORE) tira do
// `git status` só os worktrees e os temporários, sem mexer no .gitignore do usuário. `.agm/lab/` (hipóteses, runs,
// vereditos, verificações), `.agm/brain/` (cérebro compartilhado) e `.agm/protected.json` ficam versionados: a
// proveniência viaja com o repositório.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { AgentInfo, WorktreeAction, WorktreeInfo } from './protocol';

export type Isolation = 'shared' | 'worktree';

/** Arquivo, na raiz do repositório, com os ignorados pelo git que vão para cada worktree (sintaxe do .gitignore). */
const INCLUDE_FILE = '.worktreeinclude';
/** Lista dos arquivos copiados do .worktreeinclude, guardada no git dir privado do worktree (some junto com ele). */
const COPIED_LIST = 'agm-include';
const MAX_LISTED = 40;

// ---------- git ----------

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stderr ? err.message : '')) });
      },
    );
  });
}

async function gitOk(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) {
    throw new Error(`git ${args[0]} falhou: ${(r.stderr || r.stdout).trim()}`);
  }
  return r.stdout;
}

/** Commit precisa de autor. Sem user.email configurado, usa um neutro só para este comando. */
async function identity(cwd: string): Promise<string[]> {
  const r = await git(cwd, ['config', 'user.email']);
  return r.stdout.trim() ? [] : ['-c', 'user.name=Agent Graph Master', '-c', 'user.email=agm@localhost'];
}

/** Uma operação que escreve no repositório por vez: dois spawns juntos disputariam o index.lock e os refs. */
const locks = new Map<string, Promise<unknown>>();
function serial<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(repo).toLowerCase();
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  locks.set(key, next);
  return next;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function splitZ(out: string): string[] {
  return out.split('\0').filter(Boolean);
}

/** "Treina ResNet com mixup" → "treina-resnet-com-mixup". */
function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
}

// ---------- criar ----------

/** Conteúdo do `.agm/.gitignore`: worktrees e temporários fora do git; lab/ e protected.json versionados. */
export const AGM_IGNORE = [
  '# Agent Graph Master. Versionado: lab/ (quadro de experimentos e proveniência), brain/ (cérebro compartilhado) e protected.json.',
  '# Fora do git: os worktrees dos agentes isolados e os temporários.',
  'worktrees/',
  'verify-tmp/',
  'cache/',
  '*.tmp',
  '',
].join('\n');

/**
 * Cria o `.agm/.gitignore`, ou troca o da versão anterior (uma linha `*`, que escondia também o laboratório).
 * Arquivo editado pelo usuário fica como está; só ganha `worktrees/` se ainda não ignorar os worktrees.
 */
export function ensureAgmIgnore(repo: string): void {
  const file = path.join(repo, '.agm', '.gitignore');
  let current: string | undefined;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    current = undefined;
  }
  const rules = (current ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (current === undefined || (rules.length === 1 && rules[0] === '*')) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, AGM_IGNORE);
    return;
  }
  if (!rules.some((r) => r === '*' || /^\/?worktrees\/?(\*\*?)?$/.test(r))) {
    fs.appendFileSync(file, `${current.endsWith('\n') ? '' : '\n'}worktrees/\n`);
  }
}

/**
 * Cria o worktree do agente `id` a partir do HEAD atual. Devolve Error com texto pronto para o orquestrador
 * quando o projeto não é repositório git ou ainda não tem commit.
 */
export async function createWorktree(cwd: string, id: string, description: string): Promise<WorktreeInfo | Error> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) {
    return new Error(
      `O projeto (${cwd}) não é um repositório git, então não dá para isolar o agente num worktree. Peça ao usuário para rodar "git init" e fazer um primeiro commit, ou crie o agente com isolation "shared".`,
    );
  }
  const repo = path.resolve(top.stdout.trim());
  const head = await git(repo, ['rev-parse', '--verify', 'HEAD']);
  if (head.code !== 0) {
    return new Error('O repositório ainda não tem nenhum commit, e o worktree precisa de um ponto de partida. Peça ao usuário para fazer o primeiro commit, ou crie o agente com isolation "shared".');
  }
  const baseCommit = head.stdout.trim();
  const branchName = await git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const base = branchName.code === 0 ? branchName.stdout.trim() : baseCommit;
  const slug = slugify(description);

  try {
    return await serial(repo, async () => {
      const root = path.join(repo, '.agm', 'worktrees');
      fs.mkdirSync(root, { recursive: true });
      ensureAgmIgnore(repo);
      // Ids recomeçam em a1 a cada conversa: nome ou branch já usados ganham sufixo.
      let name = id;
      let branch = '';
      for (let n = 2; ; n++) {
        branch = slug ? `agm/${name}-${slug}` : `agm/${name}`;
        const taken = fs.existsSync(path.join(root, name)) || (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
        if (!taken) {
          break;
        }
        name = `${id}-${n}`;
      }
      const wtPath = path.join(root, name);
      await gitOk(repo, ['worktree', 'add', '-b', branch, wtPath, baseCommit]);
      await copyIncluded(repo, wtPath);
      const rel = path.relative(repo, path.resolve(cwd));
      const agentCwd = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? path.join(wtPath, rel) : wtPath;
      fs.mkdirSync(agentCwd, { recursive: true });
      const info: WorktreeInfo = { path: wtPath, branch, base, baseCommit, repo, cwd: agentCwd, status: 'active', changed: 0, ahead: 0 };
      return info;
    });
  } catch (err) {
    return new Error(`Não consegui criar o worktree: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Copia para o worktree os arquivos fora do git que casam com o .worktreeinclude e anota quais foram. */
async function copyIncluded(repo: string, wtPath: string): Promise<void> {
  if (!fs.existsSync(path.join(repo, INCLUDE_FILE))) {
    return;
  }
  // Só arquivos que o git não rastreia: os rastreados o worktree já tem.
  const out = await gitOk(repo, ['ls-files', '--others', '--ignored', `--exclude-from=${INCLUDE_FILE}`, '-z']);
  const files = splitZ(out).filter((f) => !f.startsWith('.agm/'));
  for (const rel of files) {
    const dest = path.join(wtPath, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(repo, rel), dest);
  }
  const gitDir = (await gitOk(wtPath, ['rev-parse', '--absolute-git-dir'])).trim();
  fs.writeFileSync(path.join(gitDir, COPIED_LIST), files.join('\n'));
}

async function copiedFiles(wtPath: string): Promise<Set<string>> {
  const gitDir = await git(wtPath, ['rev-parse', '--absolute-git-dir']);
  try {
    return new Set(fs.readFileSync(path.join(gitDir.stdout.trim(), COPIED_LIST), 'utf8').split('\n').filter(Boolean));
  } catch {
    return new Set();
  }
}

// ---------- consultar ----------

export interface ChangedFile {
  /** A (novo), M (alterado), D (apagado), T (tipo mudou). */
  status: string;
  path: string;
}

export interface WorktreeStatus {
  exists: boolean;
  ahead: number;
  files: ChangedFile[];
  /** Resumo do git (arquivos, inserções, remoções) contra o ponto de partida. */
  shortstat: string;
}

/**
 * O que o agente mudou desde o ponto de partida: commits dele, alterações não commitadas e arquivos novos.
 * Os copiados pelo .worktreeinclude não contam: não são trabalho do agente.
 */
export async function worktreeStatus(wt: WorktreeInfo): Promise<WorktreeStatus> {
  if (!fs.existsSync(wt.path)) {
    return { exists: false, ahead: 0, files: [], shortstat: '' };
  }
  const [ahead, tracked, untracked, copied, stat] = await Promise.all([
    git(wt.path, ['rev-list', '--count', `${wt.baseCommit}..HEAD`]),
    git(wt.path, ['diff', '--name-status', '--no-renames', '-z', wt.baseCommit]),
    git(wt.path, ['ls-files', '--others', '--exclude-standard', '-z']),
    copiedFiles(wt.path),
    git(wt.path, ['diff', '--shortstat', wt.baseCommit]),
  ]);
  const files: ChangedFile[] = [];
  const parts = splitZ(tracked.stdout);
  for (let i = 0; i + 1 < parts.length; i += 2) {
    files.push({ status: parts[i][0], path: parts[i + 1] });
  }
  for (const f of splitZ(untracked.stdout)) {
    if (!copied.has(f)) {
      files.push({ status: 'A', path: f });
    }
  }
  return { exists: true, ahead: Number(ahead.stdout.trim()) || 0, files, shortstat: stat.stdout.trim() };
}

/** Contagem para o popup e o mapa. Devolve só o que mudou, ou nada. */
export async function refreshWorktreeInfo(wt: WorktreeInfo): Promise<Partial<WorktreeInfo> | undefined> {
  if (wt.status === 'discarded') {
    return undefined;
  }
  const st = await worktreeStatus(wt);
  if (!st.exists) {
    return wt.status === 'missing' ? undefined : { status: 'missing' };
  }
  const patch: Partial<WorktreeInfo> = { changed: st.files.length, ahead: st.ahead };
  if (wt.status === 'missing') {
    patch.status = 'active';
  }
  return patch.changed === wt.changed && patch.ahead === wt.ahead && !patch.status ? undefined : patch;
}

/** Texto do worktree_status: branch, ponto de partida, commits à frente, arquivos e o que o usuário pode fazer. */
export async function describeWorktree(agent: AgentInfo): Promise<string> {
  const wt = agent.worktree;
  if (!wt) {
    return `O agente ${agent.id} não é isolado: trabalha no diretório compartilhado.`;
  }
  if (wt.status === 'discarded') {
    return `O worktree do agente ${agent.id} foi descartado pelo usuário (branch ${wt.branch} apagada).`;
  }
  const st = await worktreeStatus(wt);
  if (!st.exists) {
    return `O worktree do agente ${agent.id} (${wt.path}) não existe mais no disco.`;
  }
  const lines = [
    `Agente ${agent.id} (${agent.status}), branch ${wt.branch}, saiu de ${wt.base} @ ${wt.baseCommit.slice(0, 7)}${wt.status === 'merged' ? ' (já mesclado uma vez; a contagem parte da última mesclagem)' : ''}.`,
    `Worktree: ${wt.path}`,
    `${st.ahead} ${st.ahead === 1 ? 'commit' : 'commits'} à frente, ${st.files.length} ${st.files.length === 1 ? 'arquivo alterado' : 'arquivos alterados'}${st.shortstat ? ` (${st.shortstat})` : ''}.`,
    ...st.files.slice(0, MAX_LISTED).map((f) => `  ${f.status} ${f.path}`),
    ...(st.files.length > MAX_LISTED ? [`  ... e mais ${st.files.length - MAX_LISTED}`] : []),
    'Mesclar e descartar são do usuário, pelos botões do popup do nó. Você pode propor; não execute.',
  ];
  return lines.join('\n');
}

// ---------- mesclar e descartar ----------

/** Commita no worktree o que o agente deixou sem commitar, fora os copiados do .worktreeinclude. */
async function commitPending(wt: WorktreeInfo, agentId: string, description: string): Promise<void> {
  const copied = [...(await copiedFiles(wt.path))];
  await gitOk(wt.path, ['add', '-A']);
  if (copied.length) {
    await git(wt.path, ['reset', '-q', '--', ...copied]);
  }
  const staged = await git(wt.path, ['diff', '--cached', '--quiet']);
  if (staged.code === 0) {
    return;
  }
  await gitOk(wt.path, [...(await identity(wt.path)), 'commit', '-q', '-m', `agm: trabalho do agente ${agentId} (${description})`]);
}

export type MergeResult = { ok: true; text: string; baseCommit: string } | { ok: false; text: string };

/**
 * Mescla a branch do agente na branch de origem, no checkout principal, sempre com commit de merge (--no-ff).
 * Conflito aborta a mesclagem e devolve a lista: nada é resolvido sozinho.
 */
export function mergeWorktree(wt: WorktreeInfo, agentId: string, description: string): Promise<MergeResult> {
  return serial(wt.repo, async (): Promise<MergeResult> => {
    if (!fs.existsSync(wt.path)) {
      return { ok: false, text: `O worktree ${wt.path} não existe mais.` };
    }
    if (/^[0-9a-f]{40}$/.test(wt.base)) {
      return { ok: false, text: `O agente saiu de um HEAD solto (${wt.base.slice(0, 7)}), sem branch para receber a mesclagem. Mescle à mão: git merge --no-ff ${wt.branch}` };
    }
    const current = await git(wt.repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (current.stdout.trim() !== wt.base) {
      return {
        ok: false,
        text: `O checkout principal está em ${current.stdout.trim() || 'HEAD solto'}, mas o agente saiu de ${wt.base}. Volte para ${wt.base} (git switch ${wt.base}) e mescle de novo.`,
      };
    }
    try {
      await commitPending(wt, agentId, description);
    } catch (err) {
      return { ok: false, text: `Não consegui commitar o trabalho pendente no worktree: ${err instanceof Error ? err.message : String(err)}` };
    }
    const pending = await git(wt.repo, ['rev-list', '--count', `${wt.base}..${wt.branch}`]);
    if (Number(pending.stdout.trim()) === 0) {
      return { ok: false, text: `Nada para mesclar: ${wt.branch} não tem commit que ${wt.base} ainda não tenha.` };
    }
    const merge = await git(wt.repo, [...(await identity(wt.repo)), 'merge', '--no-ff', '--no-edit', '-m', `Mescla ${wt.branch} (agente ${agentId}: ${description})`, wt.branch]);
    if (merge.code !== 0) {
      const conflicts = splitZ((await git(wt.repo, ['diff', '--name-only', '--diff-filter=U', '-z'])).stdout);
      const inMerge = (await git(wt.repo, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])).code === 0;
      if (inMerge) {
        await git(wt.repo, ['merge', '--abort']);
      }
      if (conflicts.length) {
        return {
          ok: false,
          text: `Conflito ao mesclar ${wt.branch} em ${wt.base}: ${conflicts.join(', ')}. A mesclagem foi abortada e ${wt.base} ficou como estava. Resolva à mão com: git merge --no-ff ${wt.branch}`,
        };
      }
      return { ok: false, text: `O git recusou a mesclagem de ${wt.branch} em ${wt.base}: ${(merge.stderr || merge.stdout).trim()}` };
    }
    const tip = (await gitOk(wt.repo, ['rev-parse', wt.branch])).trim();
    return { ok: true, text: `${wt.branch} mesclada em ${wt.base}.`, baseCommit: tip };
  });
}

/** Remove o worktree e apaga a branch. No Windows o processo do agente pode segurar a pasta por um instante. */
export function discardWorktree(wt: WorktreeInfo): Promise<{ ok: boolean; text: string }> {
  return serial(wt.repo, async () => {
    let removed = !fs.existsSync(wt.path);
    let last = '';
    for (let attempt = 0; !removed && attempt < 6; attempt++) {
      const r = await git(wt.repo, ['worktree', 'remove', '--force', '--force', wt.path]);
      removed = r.code === 0 || !fs.existsSync(wt.path);
      last = (r.stderr || r.stdout).trim();
      if (!removed) {
        await sleep(700);
      }
    }
    if (!removed) {
      try {
        fs.rmSync(wt.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
        removed = true;
      } catch {
        return { ok: false, text: `Não consegui remover ${wt.path}: ${last}` };
      }
    }
    await git(wt.repo, ['worktree', 'prune']);
    const del = await git(wt.repo, ['branch', '-D', wt.branch]);
    const branchGone = del.code === 0 || (await git(wt.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${wt.branch}`])).code !== 0;
    return branchGone
      ? { ok: true, text: `Worktree removido e branch ${wt.branch} apagada.` }
      : { ok: false, text: `Worktree removido, mas a branch ${wt.branch} ficou: ${(del.stderr || del.stdout).trim()}` };
  });
}

// ---------- diff no editor ----------

const BASE_SCHEME = 'agm-base';
let providerReady = false;

/** Conteúdo de um arquivo no commit de partida, lido do banco de objetos (que o worktree divide com o repositório). */
function ensureBaseProvider(): void {
  if (providerReady) {
    return;
  }
  providerReady = true;
  vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, {
    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
      const q = JSON.parse(uri.query) as { repo: string; commit: string; path: string };
      if (!q.commit) {
        return '';
      }
      const r = await git(q.repo, ['show', `${q.commit}:${q.path}`]);
      return r.code === 0 ? r.stdout : '';
    },
  });
}

function baseUri(wt: WorktreeInfo, rel: string, commit: string): vscode.Uri {
  return vscode.Uri.from({ scheme: BASE_SCHEME, path: `/${rel}`, query: JSON.stringify({ repo: wt.repo, commit, path: rel }) });
}

/** Abre no editor de mudanças do VS Code cada arquivo alterado: ponto de partida à esquerda, worktree à direita. */
export async function openWorktreeDiff(wt: WorktreeInfo, agentId: string): Promise<string | undefined> {
  const st = await worktreeStatus(wt);
  if (!st.exists) {
    return `O worktree ${wt.path} não existe mais.`;
  }
  if (!st.files.length) {
    return `O agente ${agentId} ainda não mudou nenhum arquivo no worktree.`;
  }
  ensureBaseProvider();
  const resources = st.files.map((f) => {
    const right = f.status === 'D' ? baseUri(wt, f.path, '') : vscode.Uri.file(path.join(wt.path, f.path));
    const left = baseUri(wt, f.path, f.status === 'A' ? '' : wt.baseCommit);
    return [vscode.Uri.file(path.join(wt.path, f.path)), left, right] as [vscode.Uri, vscode.Uri, vscode.Uri];
  });
  const title = `${agentId} · ${wt.branch} (${st.files.length} ${st.files.length === 1 ? 'arquivo' : 'arquivos'})`;
  try {
    await vscode.commands.executeCommand('vscode.changes', title, resources);
  } catch {
    // VS Code sem o editor de mudanças múltiplas: abre o diff do primeiro arquivo.
    const [, left, right] = resources[0];
    await vscode.commands.executeCommand('vscode.diff', left, right, `${title} · ${st.files[0].path}`);
  }
  return undefined;
}

// ---------- ações da interface ----------

/** O que a ação precisa do hub, sem expor o RoutedAgent. */
export interface WorktreeActionHost {
  agent: AgentInfo;
  running: boolean;
  /** Derruba o processo do agente: no Windows, pasta que é cwd de um processo não sai do disco. */
  stopSession(): Promise<void>;
  update(patch: Partial<AgentInfo>): void;
  notice(text: string, level: 'info' | 'error'): void;
}

/** Ver diff, Mesclar ou Descartar, sempre por clique do usuário. Mesclar e Descartar pedem confirmação modal. */
export async function runWorktreeAction(action: WorktreeAction, host: WorktreeActionHost): Promise<void> {
  const a = host.agent;
  const wt = a.worktree;
  if (!wt || wt.status === 'discarded') {
    return;
  }
  const setWt = (patch: Partial<WorktreeInfo>) => host.update({ worktree: { ...wt, ...patch } });
  if (action === 'diff') {
    const problem = await openWorktreeDiff(wt, a.id);
    if (problem) {
      host.notice(problem, 'info');
    }
    return;
  }
  if (action === 'merge') {
    if (host.running) {
      host.notice(`O agente ${a.id} ainda está trabalhando. Espere ele terminar (ou pare) antes de mesclar.`, 'error');
      return;
    }
    const st = await worktreeStatus(wt);
    const pick = await vscode.window.showWarningMessage(
      `Mesclar ${wt.branch} em ${wt.base}?`,
      {
        modal: true,
        detail: `${st.files.length} ${st.files.length === 1 ? 'arquivo' : 'arquivos'} do agente ${a.id} ("${a.description}"). O que ele deixou sem commitar vira um commit na branch dele; depois entra um commit de merge em ${wt.base}. Se houver conflito, a mesclagem é abortada e nada muda.`,
      },
      'Mesclar',
    );
    if (pick !== 'Mesclar') {
      return;
    }
    const result = await mergeWorktree(wt, a.id, a.description);
    if (result.ok) {
      setWt({ status: 'merged', baseCommit: result.baseCommit, changed: 0, ahead: 0 });
      host.notice(result.text, 'info');
    } else {
      host.notice(result.text, 'error');
    }
    return;
  }
  const pick = await vscode.window.showWarningMessage(
    `Descartar o worktree do agente ${a.id}?`,
    {
      modal: true,
      detail: `Apaga ${wt.path} e a branch ${wt.branch}, com tudo o que não foi mesclado${host.running ? '. O agente está rodando e será parado' : ''}. Não dá para desfazer.`,
    },
    'Descartar',
  );
  if (pick !== 'Descartar') {
    return;
  }
  await host.stopSession();
  const result = await discardWorktree(wt);
  if (result.ok) {
    setWt({ status: 'discarded', changed: 0, ahead: 0 });
  }
  host.notice(result.text, result.ok ? 'info' : 'error');
}

// ---------- prompt e ferramenta ----------

/** Trecho do prompt do orquestrador sobre isolation. */
export const WORKTREE_GUIDE: readonly string[] = [
  'Isolamento (spawn_agent com isolation):',
  '- "worktree" põe o agente numa cópia git própria do projeto (worktree em .agm/worktrees/<id>, branch agm/<id>-<descrição>), criada a partir do HEAD atual. Use para experimentos e tarefas que editam ou geram arquivos em paralelo: treinos, checkpoints, configs, variações do mesmo script. Dois agentes isolados podem gravar o mesmo caminho sem colidir.',
  '- "shared" (padrão) é o diretório do projeto como está. Use para leitura, pesquisa, revisão e tarefas que precisam ver o trabalho atual não commitado.',
  '- O worktree parte do último commit: alteração não commitada no diretório principal não vai para ele. Arquivos fora do git (datasets pequenos, .env, configs locais) só entram se estiverem no .worktreeinclude da raiz do repositório (sintaxe do .gitignore). Se o experimento precisar deles e o arquivo não existir, avise o usuário.',
  '- Só funciona em repositório git com pelo menos um commit; se o spawn_agent recusar, repasse a sugestão ao usuário.',
  '- worktree_status(agent_id) mostra branch, commits à frente e arquivos alterados de um agente isolado. O agente não precisa commitar.',
  '- Mesclar na branch de origem e descartar o worktree são decisões do usuário, pelos botões no popup do nó do agente. Você pode propor ("a3 chegou em acurácia maior; sugiro mesclar a3 e descartar a4"), mas nunca rode git merge, git worktree remove, git branch -D nem apague a pasta por conta própria, a menos que o usuário peça explicitamente nesta conversa.',
];

/** Trecho do prompt de um agente isolado (Claude ou Codex). */
export function worktreeAgentGuide(wt: WorktreeInfo | undefined): string[] {
  if (!wt || wt.status === 'discarded') {
    return [];
  }
  return [
    '',
    `Você trabalha num worktree git próprio, em "${wt.cwd}", na branch ${wt.branch} (saiu de ${wt.base}). Outros agentes trabalham em cópias separadas.`,
    `- Grave tudo aqui dentro. O diretório principal do projeto ("${wt.repo}") não é seu: não escreva lá.`,
    '- Não precisa commitar nem mesclar: o usuário revisa o diff e decide. Não troque de branch (checkout, switch), não rode reset, rebase ou merge neste worktree.',
    '- Arquivos fora do git que você esperava e não achou (dataset, .env) não foram listados no .worktreeinclude: diga no relatório em vez de buscar no diretório principal.',
  ];
}

type TextResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** Ferramenta worktree_status do servidor "agents". Só lê: não mescla nem descarta. */
export function worktreeTools(lookup: (id: string) => AgentInfo | undefined, text: (t: string) => TextResult) {
  return [
    tool(
      'worktree_status',
      'Mostra o worktree de um agente criado com isolation "worktree": branch, ponto de partida, commits à frente e arquivos alterados. Só lê; mesclar e descartar são do usuário.',
      { agent_id: z.string() },
      async (args) => {
        const agent = lookup(args.agent_id.trim());
        if (!agent) {
          return { ...text(`Agente "${args.agent_id}" não existe. Use list_agents.`), isError: true };
        }
        return text(await describeWorktree(agent));
      },
      { alwaysLoad: true },
    ),
  ];
}
