/**
 * K seeds sem LLM: o próprio hub roda o mesmo comando com K seeds, com paralelismo limitado, e registra cada
 * execução no laboratório como run do mesmo braço. Mais barato e determinístico que um agente fazendo o laço,
 * e o número vem de arquivo (metrics_file ou a última linha JSON da saída, gravada em .agm/lab/outputs/).
 *
 * Roda fora dos hooks dos agentes, como o run_evaluation: por isso o usuário aprova cada modelo de comando na
 * primeira vez da conversa, venha o pedido do orquestrador ou de um subagente. Cada execução espera vaga no
 * semáforo de processos pesados (guard/heavy.ts), que vale para todos os agentes ao mesmo tempo.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { runEvaluation } from '../guard/evaluation';
import { heavyStatus } from '../guard/heavy';
import { fmtNum } from '../lab/evaluate';
import type { ParallelHost } from './host';

export const MAX_SEEDS = 50;
const MAX_PARALLEL = 8;

export interface SeedsArgs {
  hypothesis_id: string;
  arm: string;
  command_template: string;
  seeds: number[];
  metrics_file_template?: string;
  workdir?: string;
  parallel?: number;
  timeout_minutes?: number;
}

/**
 * Subagente com caminhos protegidos: o hub só confere o TEXTO do comando (commandBlocked). Um script que abre
 * data/test por dentro passa, porque o processo roda fora dos hooks do agente. Por isso, para esse agente, cada
 * chamada pede aprovação do usuário (nada fica lembrado) e a saída do processo não volta ao agente.
 */
export interface SeedsGuard {
  /** Caminhos protegidos do agente que chama (vazio: orquestrador ou agente sem proteção). */
  protectedPatterns: string[];
  /** Parar o agente ou trocar de conversa: seeds na fila saem, processos rodando morrem. */
  signal?: AbortSignal;
}

/** "Já aprovado?" e "pergunte ao usuário" vêm do Parallel, que é dono dos pedidos de permissão. */
export interface SeedsApproval {
  approved(key: string): boolean;
  ask(input: Record<string, unknown>, reason: string): Promise<boolean>;
  remember(key: string): void;
}

export async function runSeeds(host: ParallelHost, callerId: string, args: SeedsArgs, approval: SeedsApproval, guard: SeedsGuard = { protectedPatterns: [] }): Promise<string | Error> {
  const guarded = callerId !== 'main' && guard.protectedPatterns.length > 0;
  const h = host.lab.store.hypothesis(args.hypothesis_id);
  if (!h) {
    return new Error(`Hipótese "${args.hypothesis_id}" não existe. Registre com register_hypothesis ou veja read_board.`);
  }
  if (!h.arms.includes(args.arm)) {
    return new Error(`Braço "${args.arm}" não é desta hipótese. Braços registrados: ${h.arms.join(', ')}.`);
  }
  const template = args.command_template.trim();
  if (!template.includes('{seed}')) {
    return new Error('command_template precisa de {seed}, que o hub troca por cada seed (ex.: "python train.py --seed {seed} --out results/{arm}_{seed}.json").');
  }
  if (args.metrics_file_template && !args.metrics_file_template.includes('{seed}')) {
    return new Error('metrics_file_template precisa de {seed}: cada execução grava o próprio arquivo.');
  }
  const seeds = [...new Set(args.seeds.map((s) => Math.trunc(s)))];
  if (!seeds.length || seeds.length > MAX_SEEDS) {
    return new Error(`Passe de 1 a ${MAX_SEEDS} seeds diferentes.`);
  }
  const existing = host.lab.store.runs(h.id);
  if (h.budget?.maxRuns && existing.length + seeds.length > h.budget.maxRuns) {
    return new Error(`Orçamento da hipótese: ${h.id} aceita ${h.budget.maxRuns} runs, já tem ${existing.length} e você pediu ${seeds.length}.`);
  }
  // Agente em worktree roda no worktree dele: o script que ele escreveu está lá, não no projeto.
  const base = host.info(callerId)?.worktree?.cwd ?? host.cwd;
  const workdir = args.workdir ? path.resolve(base, args.workdir) : base;
  if (!fs.existsSync(workdir)) {
    return new Error(`A pasta ${workdir} não existe.`);
  }
  const key = `${workdir}\n${template}`;
  if (guarded || !approval.approved(key)) {
    const who = callerId === 'main' ? 'O orquestrador' : `O agente ${callerId}${host.info(callerId)?.description ? ` ("${host.info(callerId)!.description}")` : ''}`;
    const reason = guarded
      ? `${who}, que tem caminhos protegidos (${guard.protectedPatterns.join(', ')}), pediu: o hub vai rodar este comando ${seeds.length} vez(es), trocando {seed}, FORA dos hooks do agente. O hub só conferiu que o texto do comando não cita esses caminhos; se o script os abrir por dentro, nada impede. Aprove só se conhece o script. Vale só para esta chamada, e a saída dos processos não volta ao agente.`
      : `${who} pediu: o hub vai rodar este comando ${seeds.length} vez(es), trocando {seed}, fora das restrições dos agentes (caminhos protegidos não valem aqui). A aprovação vale para este modelo de comando nesta pasta até o fim desta conversa, para qualquer agente sem caminhos protegidos.`;
    const ok = await approval.ask({ command_template: template, workdir, seeds: seeds.join(', '), arm: args.arm, hypothesis: h.id }, reason);
    if (!ok) {
      return new Error('O usuário recusou rodar os seeds.');
    }
    if (!guarded) {
      approval.remember(key);
    }
  }
  const cfg = vscode.workspace.getConfiguration('agentGraphMaster');
  const parallel = Math.max(1, Math.min(MAX_PARALLEL, Math.round(args.parallel ?? cfg.get<number>('seedParallelism', 2))));
  const timeoutMs = Math.max(0.1, args.timeout_minutes ?? cfg.get<number>('evaluationTimeoutMinutes', 30)) * 60_000;
  const fill = (t: string, seed: number) => t.replace(/\{seed\}/g, String(seed)).replace(/\{arm\}/g, args.arm);

  const results: { seed: number; line: string; ok: boolean }[] = [];
  const queue = [...seeds];
  const worker = async () => {
    for (let seed = queue.shift(); seed !== undefined; seed = queue.shift()) {
      if (guard.signal?.aborted) {
        results.push({ seed, ok: false, line: `seed ${seed}: não rodou, parado antes de começar` });
        continue;
      }
      const command = fill(template, seed);
      const r = await runEvaluation(command, workdir, timeoutMs, { label: `run_seeds ${h.id} ${args.arm} seed ${seed}`, concurrent: parallel > 1, signal: guard.signal });
      if (r.aborted) {
        results.push({ seed, ok: false, line: `seed ${seed}: parado (agente parado ou conversa trocada); nada registrado` });
        continue;
      }
      if (r.timedOut || r.exitCode !== 0) {
        // Agente com caminho protegido não vê a saída: um erro pode imprimir o conteúdo que ele não pode ler.
        const tail = guarded ? '' : (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ');
        results.push({ seed, ok: false, line: `seed ${seed}: ${r.timedOut ? 'estourou o tempo' : `saiu com código ${r.exitCode ?? '?'}`}${tail ? ` (${tail.slice(0, 300)})` : ''}; nada registrado` });
        continue;
      }
      let file: string;
      if (args.metrics_file_template) {
        file = path.resolve(workdir, fill(args.metrics_file_template, seed));
      } else {
        const json = lastJsonLine(r.stdout);
        if (!json) {
          results.push({ seed, ok: false, line: `seed ${seed}: sem metrics_file_template e a saída não termina com uma linha JSON; nada registrado` });
          continue;
        }
        // A saída vira arquivo: o run fica com hash e artefato como qualquer metrics_file.
        const dir = path.join(host.cwd, '.agm', 'lab', 'outputs');
        fs.mkdirSync(dir, { recursive: true });
        file = path.join(dir, `${h.id}-${args.arm.replace(/[^\w.-]+/g, '_')}-s${seed}-${Date.now()}.json`);
        fs.writeFileSync(file, json);
      }
      if (guarded) {
        // Agente com caminho protegido: só o número da métrica pedida chega ao quadro e a ele. Nomes de chave,
        // mensagens de erro e o resto do JSON podem carregar o que ele não pode ler.
        const only = onlyMetric(file, h.metric, path.join(host.cwd, '.agm', 'lab', 'outputs'), `${h.id}-${args.arm.replace(/[^\w.-]+/g, '_')}-s${seed}-${Date.now()}-limpo.json`);
        if (!args.metrics_file_template) {
          // A linha JSON crua da saída não fica no disco: só a cópia limpa.
          fs.rmSync(file, { force: true });
        }
        if (only instanceof Error) {
          results.push({ seed, ok: false, line: `seed ${seed}: ${only.message}; nada registrado` });
          continue;
        }
        file = only;
      }
      const run = host.lab.addHostRun({ hypothesisId: h.id, arm: args.arm, seed, command, metricsFile: file, workdir, agent: callerId });
      results.push(
        run instanceof Error
          ? { seed, ok: false, line: `seed ${seed}: ${guarded ? 'o laboratório recusou o run' : run.message}` }
          : { seed, ok: true, line: `seed ${seed}: ${run.id}, ${h.metric} = ${fmtNum(run.metrics[h.metric])} (${run.artifact}, sha256 ${run.metricsFileHash})` },
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, seeds.length) }, worker));
  results.sort((x, y) => x.seed - y.seed);

  const all = host.lab.store.runs(h.id);
  const perArm = h.arms.map((a) => `${a} ${new Set(all.filter((r) => r.arm === a).map((r) => r.seed)).size}/${h.minSeeds}`).join(', ');
  const ok = results.filter((r) => r.ok).length;
  const ready = h.arms.every((a) => new Set(all.filter((r) => r.arm === a).map((r) => r.seed)).size >= h.minSeeds);
  return [
    `run_seeds em ${h.id}, braço ${args.arm}: ${ok} de ${seeds.length} execuções registradas (paralelismo ${parallel}, pasta ${workdir}; ${heavyStatus()}).`,
    ...results.map((r) => `- ${r.line}`),
    `Seeds por braço agora: ${perArm}.`,
    ready ? `Os dois braços têm o mínimo de seeds: chame declare_result({ hypothesis_id: "${h.id}" }).` : 'Ainda faltam seeds para o mínimo registrado.',
  ].join('\n');
}

/**
 * Copia só `metric` (número finito) do JSON de métricas para um arquivo novo e devolve o caminho dele. Erro com
 * texto fixo, sem o conteúdo nem os nomes de chave do arquivo original.
 */
export function onlyMetric(file: string, metric: string, dir: string, name: string): string | Error {
  let value: unknown;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const metrics = data && typeof data.metrics === 'object' && data.metrics ? (data.metrics as Record<string, unknown>) : data;
    value = metrics?.[metric];
  } catch {
    return new Error(`não consegui ler o JSON de métricas como objeto`);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return new Error(`faltou a métrica "${metric}" como número no JSON de métricas`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, name);
  fs.writeFileSync(out, JSON.stringify({ [metric]: value }));
  return out;
}

/** Última linha da saída que é um objeto JSON (o que scripts de experimento costumam imprimir no fim). */
function lastJsonLine(stdout: string): string | undefined {
  const lines = stdout.trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) {
      continue;
    }
    try {
      const v = JSON.parse(t);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        return t;
      }
    } catch {
      // Linha que parece JSON e não é: continua procurando mais acima.
    }
  }
  return undefined;
}
