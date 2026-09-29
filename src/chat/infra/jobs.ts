/**
 * Jobs de GPU remota (Slurm, Modal, RunPod) e o backend local, pelo CLI de cada um. Não existe servidor MCP
 * oficial para nenhum deles. Aqui fica só o mecanismo: montar o comando, submeter, consultar o estado e
 * cancelar. Aprovação, teto de gasto, eventos e nós do grafo ficam em index.ts.
 *
 * Sem VS Code: roda no teste com node puro.
 */
import { ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ToolProbe, probe, run } from './detect';

export type Backend = 'slurm' | 'modal' | 'runpod' | 'local';
export const BACKENDS: Backend[] = ['local', 'slurm', 'modal', 'runpod'];
export type JobState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'lost';
export const TERMINAL: JobState[] = ['completed', 'failed', 'cancelled', 'lost'];

export interface JobResources {
  gpus: number;
  gpuType?: string;
  hours: number;
}

export interface JobRecord {
  id: string;
  name: string;
  backend: Backend;
  script: string;
  resources: JobResources;
  /** Quem pediu (id do agente ou "main"). O resultado vira mensagem para ele. */
  owner: string;
  state: JobState;
  submittedAt: string;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number;
  /** Id no backend: job do Slurm, app do Modal, pod do RunPod. */
  externalId?: string;
  pid?: number;
  /** Preço por hora usado na estimativa (todas as GPUs juntas). Ausente = custo desconhecido. */
  usdPerHour?: number;
  estimatedCostUsd?: number;
  /** Pasta do job: .agm/jobs/<id>/ com output.log e, por padrão, metrics.json. */
  dir: string;
  logFile: string;
  metricsFile: string;
  lab?: { hypothesisId: string; arm: string; seed: number };
  note?: string;
  /** O resultado já foi entregue a quem pediu; não repete depois de reabrir a janela. */
  reported?: boolean;
}

export interface Poll {
  state: JobState;
  exitCode?: number;
  note?: string;
}

/** Custo acumulado até agora (ou até o fim). Undefined quando o preço é desconhecido. */
export function accruedUsd(job: JobRecord, now = Date.now()): number | undefined {
  if (job.usdPerHour === undefined) {
    return undefined;
  }
  if (!job.startedAt) {
    return 0;
  }
  const end = job.endedAt ? Date.parse(job.endedAt) : now;
  return Math.max(0, ((end - Date.parse(job.startedAt)) / 3_600_000) * job.usdPerHour);
}

/** Comando local para um script: .py com Python, .sh com bash, .ps1 com PowerShell; o resto vai para o shell. */
function localCommand(script: string, cwd: string): { cmd: string; args: string[]; shell: boolean } {
  const file = path.resolve(cwd, script);
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.py') {
      return { cmd: process.platform === 'win32' ? 'python' : 'python3', args: ['-u', file], shell: false };
    }
    if (ext === '.sh') {
      return { cmd: 'bash', args: [file], shell: false };
    }
    if (ext === '.ps1') {
      return { cmd: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], shell: false };
    }
    if (ext === '.js' || ext === '.mjs') {
      return { cmd: process.execPath, args: [file], shell: false };
    }
  }
  return { cmd: script, args: [], shell: true };
}

function hhmmss(hours: number): string {
  const total = Math.max(60, Math.round(hours * 3600));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export interface BackendImpl {
  /** CLI presente na máquina? A mensagem de indisponível diz o que instalar. */
  available(): Promise<ToolProbe>;
  submit(job: JobRecord, cwd: string, env: NodeJS.ProcessEnv): Promise<{ externalId?: string; pid?: number; child?: ChildProcess }>;
  poll(job: JobRecord, cwd: string): Promise<Poll>;
  cancel(job: JobRecord, cwd: string): Promise<string | undefined>;
}

/** Processos filhos vivos desta janela, por id de job. O estado deles vem do evento de saída, não de consulta. */
const children = new Map<string, { child: ChildProcess; exit?: Poll }>();

function attach(job: JobRecord, child: ChildProcess, parseExternal?: (chunk: string) => string | undefined): void {
  const slot: { child: ChildProcess; exit?: Poll } = { child };
  children.set(job.id, slot);
  const log = fs.createWriteStream(job.logFile, { flags: 'a' });
  const onData = (buf: Buffer) => {
    log.write(buf);
    const found = parseExternal?.(buf.toString('utf8'));
    if (found && !job.externalId) {
      job.externalId = found;
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.on('error', (err) => {
    log.write(`\n[agm] erro ao iniciar: ${err.message}\n`);
    slot.exit = { state: 'failed', note: err.message };
  });
  child.on('close', (code, signal) => {
    log.end();
    if (!slot.exit) {
      slot.exit = signal ? { state: 'cancelled', note: `encerrado por ${signal}` } : { state: code === 0 ? 'completed' : 'failed', exitCode: code ?? undefined };
    }
  });
}

/** Processo ainda vivo? Serve para job local de uma janela anterior, cujo evento de saída se perdeu. */
function alive(pid: number | undefined): boolean {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killTree(pid: number | undefined): Promise<void> {
  if (!pid) {
    return;
  }
  if (process.platform === 'win32') {
    await run('taskkill', ['/PID', String(pid), '/T', '/F']);
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Já tinha saído.
    }
  }
}

function childPoll(job: JobRecord): Poll {
  const slot = children.get(job.id);
  if (slot) {
    return slot.exit ?? { state: 'running' };
  }
  // Janela recarregada: não há como saber o código de saída.
  if (alive(job.pid)) {
    return { state: 'running' };
  }
  return fs.existsSync(job.metricsFile)
    ? { state: 'completed', note: 'terminou enquanto a janela estava fechada; código de saída desconhecido' }
    : { state: 'lost', note: 'o processo sumiu enquanto a janela estava fechada; resultado desconhecido' };
}

const local: BackendImpl = {
  available: async () => ({ ok: true, version: 'esta máquina' }),
  async submit(job, cwd, env) {
    const c = localCommand(job.script, cwd);
    const child = spawn(c.cmd, c.args, { cwd, env, shell: c.shell, windowsHide: true, detached: process.platform !== 'win32' });
    attach(job, child);
    return { pid: child.pid, child };
  },
  poll: async (job) => childPoll(job),
  async cancel(job) {
    const slot = children.get(job.id);
    if (slot && !slot.exit) {
      slot.exit = { state: 'cancelled', note: 'cancelado pelo usuário' };
    }
    await killTree(job.pid);
    return undefined;
  },
};

const slurm: BackendImpl = {
  async available() {
    const p = await probe('sbatch');
    return p.ok ? p : { ok: false, why: 'sbatch não está no PATH desta máquina. Rode a extensão num nó de login do cluster (Remote SSH) ou instale o cliente do Slurm.' };
  },
  async submit(job, cwd, env) {
    const gres = job.resources.gpus > 0 ? [`--gres=gpu:${job.resources.gpuType ? `${job.resources.gpuType}:` : ''}${job.resources.gpus}`] : [];
    const r = await run('sbatch', ['--parsable', `--job-name=agm-${job.id}`, `--output=${job.logFile}`, `--time=${hhmmss(job.resources.hours)}`, ...gres, job.script], { cwd, env, timeoutMs: 60_000 });
    // --parsable devolve "id" ou "id;cluster".
    const id = r.stdout.trim().split(/\r?\n/).pop()?.split(';')[0].trim();
    if (r.code !== 0 || !id) {
      throw new Error(`sbatch falhou: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
    }
    return { externalId: id };
  },
  async poll(job, cwd) {
    const q = await run('squeue', ['-j', job.externalId ?? '', '-h', '-o', '%T'], { cwd });
    const live = q.stdout.trim().split(/\s+/)[0]?.toUpperCase();
    if (q.code === 0 && live) {
      return { state: live === 'PENDING' || live === 'CONFIGURING' ? 'pending' : 'running' };
    }
    const a = await run('sacct', ['-j', job.externalId ?? '', '-n', '-X', '-o', 'State,ExitCode'], { cwd });
    const [stateRaw, exitRaw] = a.stdout.trim().split(/\s+/);
    const st = (stateRaw ?? '').toUpperCase();
    const exitCode = exitRaw ? Number(exitRaw.split(':')[0]) : undefined;
    if (!st) {
      return { state: 'completed', note: 'saiu da fila; o sacct não informou o estado final (accounting desligado?)' };
    }
    if (st.startsWith('COMPLETED')) {
      return { state: 'completed', exitCode };
    }
    if (st.startsWith('CANCELLED')) {
      return { state: 'cancelled', note: st };
    }
    if (st.startsWith('PENDING') || st.startsWith('RUNNING')) {
      return { state: st.startsWith('PENDING') ? 'pending' : 'running' };
    }
    return { state: 'failed', exitCode, note: st };
  },
  async cancel(job, cwd) {
    const r = await run('scancel', [job.externalId ?? ''], { cwd });
    return r.code === 0 ? undefined : (r.stderr || r.stdout).trim();
  },
};

/**
 * Modal: `modal run --detach` sobe o app e acompanha a saída; o processo local termina junto com a função.
 * O id do app (ap-...) é lido da saída quando aparece. Depois de recarregar a janela, o estado vem de `modal app list --json`.
 */
const modal: BackendImpl = {
  async available() {
    const p = await probe('modal');
    return p.ok ? p : { ok: false, why: 'o CLI do Modal não está instalado (pip install modal num venv do projeto, depois "modal setup" para logar).' };
  },
  async submit(job, cwd, env) {
    const child = spawn('modal', ['run', '--detach', job.script], { cwd, env, windowsHide: true, detached: process.platform !== 'win32' });
    attach(job, child, (chunk) => /\b(ap-[A-Za-z0-9]+)\b/.exec(chunk)?.[1]);
    return { pid: child.pid, child };
  },
  async poll(job, cwd) {
    if (children.has(job.id)) {
      return childPoll(job);
    }
    if (!job.externalId) {
      return childPoll(job);
    }
    const r = await run('modal', ['app', 'list', '--json'], { cwd, timeoutMs: 30_000 });
    try {
      const apps = JSON.parse(r.stdout) as Record<string, unknown>[];
      const app = apps.find((a) => Object.values(a).includes(job.externalId));
      const state = String(app ? (app.State ?? app.state ?? '') : '').toLowerCase();
      if (!app || /stop/.test(state)) {
        return { state: 'completed', note: 'o app do Modal parou; código de saída desconhecido depois de recarregar a janela' };
      }
      return { state: 'running' };
    } catch {
      return { state: 'running', note: 'não consegui ler modal app list --json' };
    }
  },
  async cancel(job, cwd) {
    let err: string | undefined;
    if (job.externalId) {
      const r = await run('modal', ['app', 'stop', '-y', job.externalId], { cwd, timeoutMs: 60_000 });
      err = r.code === 0 ? undefined : (r.stderr || r.stdout).trim();
    }
    await killTree(job.pid);
    return err;
  },
};

/**
 * RunPod: cria um pod com a imagem de agentGraphMaster.jobs.runpodImage. O comando do job vai na variável
 * AGM_COMMAND: a imagem (ou o template) precisa executá-la. O pod cobra enquanto existir, mesmo parado.
 */
function runpodBackend(image: () => string): BackendImpl {
  return {
    async available() {
      const p = await probe('runpodctl');
      if (!p.ok) {
        return { ok: false, why: 'runpodctl não está instalado (github.com/runpod/runpodctl; depois "runpodctl config --apiKey ...").' };
      }
      return image() ? p : { ok: false, why: 'defina a imagem do pod em agentGraphMaster.jobs.runpodImage (ela precisa executar o comando da variável AGM_COMMAND).' };
    },
    async submit(job, cwd, env) {
      const args = ['pod', 'create', '--name', `agm-${job.id}`, '--image', image(), '--gpu-count', String(Math.max(1, job.resources.gpus)), '--env', `AGM_COMMAND=${job.script}`, '--env', `AGM_JOB_ID=${job.id}`, '--output', 'json'];
      if (job.resources.gpuType) {
        args.push('--gpu-id', job.resources.gpuType);
      }
      const r = await run('runpodctl', args, { cwd, env, timeoutMs: 120_000 });
      let id: string | undefined;
      try {
        const data = JSON.parse(r.stdout) as { id?: string };
        id = data.id;
      } catch {
        id = /\b([a-z0-9]{10,})\b/.exec(r.stdout)?.[1];
      }
      if (r.code !== 0 || !id) {
        throw new Error(`runpodctl pod create falhou: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
      }
      return { externalId: id };
    },
    async poll(job, cwd) {
      const r = await run('runpodctl', ['pod', 'get', job.externalId ?? '', '--output', 'json'], { cwd, timeoutMs: 30_000 });
      try {
        const data = JSON.parse(r.stdout) as { desiredStatus?: string; status?: string };
        const st = String(data.desiredStatus ?? data.status ?? '').toUpperCase();
        if (st === 'RUNNING' || st === 'CREATED' || st === 'STARTING') {
          return { state: st === 'RUNNING' ? 'running' : 'pending' };
        }
        if (st === 'EXITED') {
          return { state: 'completed', note: 'o pod saiu, mas continua existindo e pode cobrar disco: remova com cancel_job depois de copiar o resultado' };
        }
        if (st === 'TERMINATED') {
          return { state: 'cancelled', note: 'pod removido' };
        }
        return { state: 'running', note: st ? `estado ${st}` : undefined };
      } catch {
        return r.code === 0 ? { state: 'running' } : { state: 'lost', note: (r.stderr || r.stdout).trim().slice(0, 200) };
      }
    },
    async cancel(job, cwd) {
      const r = await run('runpodctl', ['pod', 'delete', job.externalId ?? ''], { cwd, timeoutMs: 60_000 });
      return r.code === 0 ? undefined : (r.stderr || r.stdout).trim();
    },
  };
}

export function backendImpl(b: Backend, runpodImage: () => string): BackendImpl {
  switch (b) {
    case 'slurm':
      return slurm;
    case 'modal':
      return modal;
    case 'runpod':
      return runpodBackend(runpodImage);
    default:
      return local;
  }
}

// ---------- Persistência ----------

/** Jobs do projeto em .agm/jobs/jobs.json: o acompanhamento continua depois de recarregar a janela. */
export class JobStore {
  readonly dir: string;
  private readonly file: string;

  constructor(root: string) {
    this.dir = path.join(root, '.agm', 'jobs');
    this.file = path.join(this.dir, 'jobs.json');
  }

  load(): JobRecord[] {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(data) ? (data as JobRecord[]) : [];
    } catch {
      return [];
    }
  }

  save(jobs: JobRecord[]): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}

/** Últimas linhas de um arquivo de log, sem ler o arquivo inteiro. */
export function tailFile(file: string, lines = 15): string[] {
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(size, 16 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    try {
      fs.readSync(fd, buf, 0, len, size - len);
    } finally {
      fs.closeSync(fd);
    }
    return buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim()).slice(-lines);
  } catch {
    return [];
  }
}
