/**
 * Optuna pelo Python do usuário. Por que este caminho e não o servidor MCP oficial (optuna/optuna-mcp):
 * o optuna-mcp é feito para o modelo chamar ask e tell a cada trial, o que põe uma chamada de LLM por trial
 * e depende de uv/uvx; aqui o hub pede e devolve sozinho. Então o hub fala com um processo Python pequeno
 * (a ponte abaixo, gravada em .agm/search/optuna_bridge.py) por JSON em linhas: ask, tell, report e summary.
 * O estudo fica num SQLite do projeto (.agm/search/<id>.db): dá para abrir no optuna-dashboard e retomar.
 * Um processo só coordena, então não há disputa de trava do SQLite no Windows; o paralelismo é dos trials.
 *
 * Detecção: AGM_PYTHON, depois venvs do projeto (.agm/venv, .venv, venv), depois py -3, python e python3.
 * Nada é instalado sozinho: setup (com aprovação do usuário) cria .agm/venv e instala o optuna só lá.
 */
import { spawn, execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { Direction, ParamSpec, Params } from './sampler';

export interface PythonInfo {
  /** Comando e argumentos iniciais (ex.: ["py", "-3"]). */
  cmd: string[];
  exe: string;
  version: string;
  optuna?: string;
  /** De onde veio: "AGM_PYTHON", ".agm/venv", "py -3"... */
  source: string;
}

export interface Detection {
  /** Primeiro Python com optuna. */
  ready?: PythonInfo;
  /** Primeiro Python achado, com ou sem optuna (para o setup criar o venv). */
  base?: PythonInfo;
  tried: string[];
}

const PROBE = 'import sys,json\ntry:\n import optuna; v=optuna.__version__\nexcept Exception:\n v=None\nprint(json.dumps({"exe":sys.executable,"version":sys.version.split()[0],"optuna":v}))';

function probe(cmd: string[], source: string, cwd: string): Promise<PythonInfo | undefined> {
  return new Promise((resolve) => {
    execFile(cmd[0], [...cmd.slice(1), '-c', PROBE], { cwd, timeout: 20_000, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve(undefined);
        return;
      }
      try {
        const line = stdout.trim().split(/\r?\n/).at(-1) ?? '';
        const j = JSON.parse(line) as { exe: string; version: string; optuna: string | null };
        resolve({ cmd, exe: j.exe, version: j.version, optuna: j.optuna ?? undefined, source });
      } catch {
        resolve(undefined);
      }
    });
  });
}

export function venvPython(dir: string): string {
  return process.platform === 'win32' ? path.join(dir, 'Scripts', 'python.exe') : path.join(dir, 'bin', 'python');
}

export async function detectPython(cwd: string): Promise<Detection> {
  const list: { cmd: string[]; source: string }[] = [];
  if (process.env.AGM_PYTHON) {
    list.push({ cmd: [process.env.AGM_PYTHON], source: 'AGM_PYTHON' });
  }
  for (const v of ['.agm/venv', '.venv', 'venv']) {
    const exe = venvPython(path.join(cwd, v));
    if (fs.existsSync(exe)) {
      list.push({ cmd: [exe], source: v });
    }
  }
  if (process.platform === 'win32') {
    list.push({ cmd: ['py', '-3'], source: 'py -3' });
  }
  list.push({ cmd: ['python'], source: 'python' }, { cmd: ['python3'], source: 'python3' });
  const out: Detection = { tried: [] };
  for (const c of list) {
    out.tried.push(c.source);
    const info = await probe(c.cmd, c.source, cwd);
    if (!info) {
      continue;
    }
    out.base ??= info;
    if (info.optuna) {
      out.ready = info;
      return out;
    }
  }
  return out;
}

/** Texto para o usuário quando não há Optuna: o que foi achado e como instalar sem mexer no Python global. */
export function missingOptunaText(d: Detection): string {
  if (!d.base) {
    return [
      `Não achei Python (procurei em: ${d.tried.join(', ')}). A varredura usa o amostrador embutido.`,
      'Para usar o Optuna: instale o Python 3.9 ou mais novo (por exemplo, winget install Python.Python.3.12) e depois peça setup_optuna, ou aponte AGM_PYTHON para um Python com optuna.',
    ].join('\n');
  }
  return [
    `Achei Python ${d.base.version} (${d.base.source}, ${d.base.exe}), sem o pacote optuna. A varredura usa o amostrador embutido (TPE simples em TypeScript), sem os samplers e pruners do Optuna, sem importância por fANOVA e sem estudo em SQLite.`,
    'Para usar o Optuna, sem tocar no Python global:',
    '- setup_optuna cria .agm/venv neste projeto e instala o optuna só lá, depois de o usuário aprovar; ou',
    '- no terminal do projeto: py -m venv .venv e depois .venv\\Scripts\\python -m pip install optuna (ou uv venv e uv pip install optuna).',
  ].join('\n');
}

/** Cria .agm/venv e instala optuna nele. Só é chamado depois da aprovação do usuário. */
export function installOptuna(base: PythonInfo, cwd: string, log: (line: string) => void): Promise<{ ok: boolean; output: string }> {
  const dir = path.join(cwd, '.agm', 'venv');
  const run = (cmd: string, args: string[]) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      let out = '';
      const child = spawn(cmd, args, { cwd, windowsHide: true });
      const take = (b: Buffer) => {
        out += b.toString('utf8');
        const last = out.trim().split(/\r?\n/).at(-1);
        if (last) {
          log(last);
        }
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      const timer = setTimeout(() => child.kill(), 15 * 60_000);
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ code: null, out: out + e.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, out });
      });
    });
  return (async () => {
    const venv = await run(base.cmd[0], [...base.cmd.slice(1), '-m', 'venv', dir]);
    if (venv.code !== 0) {
      return { ok: false, output: venv.out.slice(-2000) };
    }
    const pip = await run(venvPython(dir), ['-m', 'pip', 'install', '--disable-pip-version-check', 'optuna']);
    return { ok: pip.code === 0, output: pip.out.slice(-2000) };
  })();
}

const BRIDGE = `# Ponte entre o Agent Graph Master e o Optuna: um pedido JSON por linha no stdin, uma resposta por linha no stdout.
import sys, json, warnings
warnings.filterwarnings("ignore")
import optuna
from optuna.distributions import FloatDistribution, IntDistribution, CategoricalDistribution
from optuna.trial import TrialState
optuna.logging.set_verbosity(optuna.logging.WARNING)

study = None
dists = {}
live = {}

def sampler_of(name, seed, multi, n_startup):
    s = optuna.samplers
    if name == "random": return s.RandomSampler(seed=seed)
    if name == "cmaes": return s.CmaEsSampler(seed=seed, n_startup_trials=n_startup)
    if name == "qmc": return s.QMCSampler(seed=seed)
    if name == "gp": return s.GPSampler(seed=seed, n_startup_trials=n_startup)
    if name == "nsgaii": return s.NSGAIISampler(seed=seed)
    return s.TPESampler(seed=seed, multivariate=True, constant_liar=True, n_startup_trials=n_startup)

def pruner_of(name):
    p = optuna.pruners
    if name == "median": return p.MedianPruner(n_startup_trials=3, n_warmup_steps=0)
    if name == "hyperband": return p.HyperbandPruner()
    if name == "successive_halving": return p.SuccessiveHalvingPruner()
    return p.NopPruner()

def dist_of(p):
    if p["type"] == "categorical": return CategoricalDistribution(p["choices"])
    if p["type"] == "int": return IntDistribution(int(p["low"]), int(p["high"]), log=bool(p.get("log")), step=int(p.get("step") or 1))
    return FloatDistribution(float(p["low"]), float(p["high"]), log=bool(p.get("log")), step=p.get("step"))

def brief(t):
    return {"number": t.number, "params": t.params, "values": t.values}

def handle(req):
    global study, dists
    op = req["op"]
    if op == "init":
        multi = len(req["directions"]) > 1
        study = optuna.create_study(storage=req["storage"], study_name=req["study_name"], directions=req["directions"],
            sampler=sampler_of(req.get("sampler") or "tpe", req.get("seed"), multi, req.get("n_startup") or 10),
            pruner=pruner_of(req.get("pruner") or "none"), load_if_exists=True)
        dists = {p["name"]: dist_of(p) for p in req["params"]}
        return {"existing": len(study.trials)}
    if op == "ask":
        t = study.ask(dists)
        live[t.number] = t
        return {"number": t.number, "params": t.params}
    if op == "report":
        t = live[req["number"]]
        t.report(float(req["value"]), int(req["step"]))
        return {"prune": bool(t.should_prune())}
    if op == "tell":
        t = live.pop(req["number"])
        state = {"complete": TrialState.COMPLETE, "fail": TrialState.FAIL, "pruned": TrialState.PRUNED}[req["state"]]
        if state == TrialState.COMPLETE:
            study.tell(t, req["values"] if len(req["values"]) > 1 else req["values"][0])
        else:
            study.tell(t, state=state)
        return {}
    if op == "summary":
        done = [t for t in study.trials if t.state == TrialState.COMPLETE]
        out = {"complete": len(done), "importances": [], "pareto": [], "best": None, "evaluator": "fANOVA"}
        multi = len(study.directions) > 1
        if done:
            if multi:
                out["pareto"] = [brief(t) for t in study.best_trials]
            else:
                out["best"] = brief(study.best_trial)
        if len(done) >= 2:
            for i in range(len(study.directions)):
                try:
                    imp = optuna.importance.get_param_importances(study, target=(lambda t, i=i: t.values[i]) if multi else None)
                    out["importances"].append({"objective": i, "items": [{"name": k, "value": v} for k, v in imp.items()]})
                except Exception as e:
                    out["importance_error"] = str(e)
        return out
    raise ValueError("op desconhecida: " + str(op))

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
        if req.get("op") == "close":
            break
        res = handle(req)
        res["ok"] = True
    except Exception as e:
        res = {"ok": False, "error": type(e).__name__ + ": " + str(e)}
    sys.stdout.write(json.dumps(res) + "\\n")
    sys.stdout.flush()
`;

export interface OptunaSummary {
  complete: number;
  best: { number: number; params: Params; values: number[] } | null;
  pareto: { number: number; params: Params; values: number[] }[];
  importances: { objective: number; items: { name: string; value: number }[] }[];
  importance_error?: string;
  evaluator: string;
}

/** Processo da ponte. Um pedido por vez: as respostas voltam na ordem, então a fila é uma corrente de promessas. */
export class OptunaBridge {
  private readonly child;
  private readonly lines: readline.Interface;
  private readonly waiting: ((line: string | undefined) => void)[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;
  private stderr = '';

  constructor(py: PythonInfo, dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    const script = path.join(dir, 'optuna_bridge.py');
    fs.writeFileSync(script, BRIDGE, 'utf8');
    this.child = spawn(py.cmd[0], [...py.cmd.slice(1), '-u', script], { cwd: dir, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    this.child.stderr.on('data', (b: Buffer) => (this.stderr = (this.stderr + b.toString('utf8')).slice(-4000)));
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on('line', (l) => this.waiting.shift()?.(l));
    this.child.on('close', () => {
      this.closed = true;
      for (const w of this.waiting.splice(0)) {
        w(undefined);
      }
    });
    this.child.on('error', () => undefined);
  }

  request<T>(req: Record<string, unknown>): Promise<T> {
    const next = this.chain.then(
      () =>
        new Promise<T>((resolve, reject) => {
          if (this.closed) {
            reject(new Error(`a ponte do Optuna fechou. ${this.stderr.trim().split(/\r?\n/).slice(-3).join(' ')}`));
            return;
          }
          this.waiting.push((line) => {
            if (line === undefined) {
              reject(new Error(`a ponte do Optuna fechou. ${this.stderr.trim().split(/\r?\n/).slice(-3).join(' ')}`));
              return;
            }
            try {
              const res = JSON.parse(line) as { ok: boolean; error?: string } & T;
              if (res.ok) {
                resolve(res);
              } else {
                reject(new Error(`Optuna: ${res.error}`));
              }
            } catch {
              reject(new Error(`resposta inválida da ponte: ${line.slice(0, 200)}`));
            }
          });
          this.child.stdin.write(JSON.stringify(req) + '\n');
        }),
    );
    this.chain = next.catch(() => undefined);
    return next;
  }

  init(args: { storage: string; studyName: string; directions: Direction[]; sampler: string; pruner: string; seed: number; nStartup: number; params: ParamSpec[] }): Promise<{ existing: number }> {
    return this.request({
      op: 'init',
      storage: args.storage,
      study_name: args.studyName,
      directions: args.directions,
      sampler: args.sampler,
      pruner: args.pruner,
      seed: args.seed,
      n_startup: args.nStartup,
      params: args.params,
    });
  }

  ask(): Promise<{ number: number; params: Params }> {
    return this.request({ op: 'ask' });
  }

  report(number: number, step: number, value: number): Promise<{ prune: boolean }> {
    return this.request({ op: 'report', number, step, value });
  }

  tell(number: number, state: 'complete' | 'fail' | 'pruned', values?: number[]): Promise<unknown> {
    return this.request({ op: 'tell', number, state, values });
  }

  summary(): Promise<OptunaSummary> {
    return this.request({ op: 'summary' });
  }

  close(): void {
    if (!this.closed) {
      this.child.stdin.write(JSON.stringify({ op: 'close' }) + '\n');
      this.child.stdin.end();
      setTimeout(() => {
        if (!this.closed) {
          this.child.kill();
        }
      }, 3000);
    }
  }
}

/** URL de storage do SQLAlchemy para um arquivo local, com barras normais (o Windows aceita). */
export function sqliteUrl(file: string): string {
  return `sqlite:///${file.replace(/\\/g, '/')}`;
}
