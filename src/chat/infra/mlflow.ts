/**
 * Cliente mínimo da API REST 2.0 do MLflow (/api/2.0/mlflow/...). Serve para espelhar os runs do laboratório
 * num servidor MLflow e para o vigia de treino ler o histórico de uma métrica. Não depende do servidor MCP:
 * gravar é coisa do host, com número vindo do quadro, não do modelo.
 *
 * Autenticação opcional pelas variáveis que o próprio MLflow usa: MLFLOW_TRACKING_TOKEN (Bearer) ou
 * MLFLOW_TRACKING_USERNAME e MLFLOW_TRACKING_PASSWORD (Basic).
 */
import type { LabStore, Run } from '../lab/store';

export interface MetricPoint {
  step: number;
  value: number;
  timestamp: number;
}

export class MlflowClient {
  private readonly base: string;

  constructor(uri: string) {
    this.base = `${uri.replace(/\/+$/, '')}/api/2.0/mlflow`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (process.env.MLFLOW_TRACKING_TOKEN) {
      h.Authorization = `Bearer ${process.env.MLFLOW_TRACKING_TOKEN}`;
    } else if (process.env.MLFLOW_TRACKING_USERNAME) {
      h.Authorization = `Basic ${Buffer.from(`${process.env.MLFLOW_TRACKING_USERNAME}:${process.env.MLFLOW_TRACKING_PASSWORD ?? ''}`).toString('base64')}`;
    }
    return h;
  }

  private async call<T>(method: 'GET' | 'POST', endpoint: string, body?: unknown): Promise<T> {
    const url = method === 'GET' && body ? `${this.base}/${endpoint}?${new URLSearchParams(body as Record<string, string>)}` : `${this.base}/${endpoint}`;
    const res = await fetch(url, {
      method,
      headers: this.headers(),
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`MLflow ${endpoint}: HTTP ${res.status} ${text.slice(0, 200)}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Id do experimento pelo nome; cria quando não existe. */
  async experimentId(name: string): Promise<string> {
    try {
      const r = await this.call<{ experiment: { experiment_id: string } }>('GET', 'experiments/get-by-name', { experiment_name: name });
      return r.experiment.experiment_id;
    } catch (err) {
      if ((err as { status?: number }).status !== 404) {
        throw err;
      }
    }
    const r = await this.call<{ experiment_id: string }>('POST', 'experiments/create', { name });
    return r.experiment_id;
  }

  async createRun(experimentId: string, runName: string, tags: Record<string, string>, startTime = Date.now()): Promise<string> {
    const r = await this.call<{ run: { info: { run_id: string } } }>('POST', 'runs/create', {
      experiment_id: experimentId,
      run_name: runName,
      start_time: startTime,
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    });
    return r.run.info.run_id;
  }

  async logBatch(runId: string, metrics: Record<string, number>, params: Record<string, string>, tags: Record<string, string> = {}, step = 0): Promise<void> {
    const timestamp = Date.now();
    await this.call('POST', 'runs/log-batch', {
      run_id: runId,
      metrics: Object.entries(metrics)
        .filter(([, v]) => Number.isFinite(v))
        .slice(0, 900)
        .map(([key, value]) => ({ key: key.slice(0, 250), value, timestamp, step })),
      params: Object.entries(params)
        .slice(0, 100)
        .map(([key, value]) => ({ key: key.slice(0, 250), value: value.slice(0, 500) })),
      tags: Object.entries(tags)
        .slice(0, 100)
        .map(([key, value]) => ({ key: key.slice(0, 250), value: value.slice(0, 5000) })),
    });
  }

  async finish(runId: string, status: 'FINISHED' | 'FAILED' | 'KILLED' = 'FINISHED'): Promise<void> {
    await this.call('POST', 'runs/update', { run_id: runId, status, end_time: Date.now() });
  }

  async metricHistory(runId: string, key: string): Promise<MetricPoint[]> {
    const r = await this.call<{ metrics?: { value: number; step?: number; timestamp?: number }[] }>('GET', 'metrics/get-history', { run_id: runId, metric_key: key, max_results: '25000' });
    return (r.metrics ?? []).map((m, i) => ({ step: Number(m.step ?? i), value: Number(m.value), timestamp: Number(m.timestamp ?? 0) })).sort((a, b) => a.step - b.step);
  }

  async runStatus(runId: string): Promise<string | undefined> {
    const r = await this.call<{ run?: { info?: { status?: string } } }>('GET', 'runs/get', { run_id: runId });
    return r.run?.info?.status;
  }
}

export interface MirrorConfig {
  uri: string;
  experiment: string;
}

/**
 * Espelha cada run novo do laboratório no MLflow: métricas, o comando como param e as tags node_id,
 * hypothesis_id, arm, seed e git_sha. Envolve o `addRun` do quadro, então vale para log_run e para os runs que
 * os jobs criam. Falha de rede não impede o registro local; vira um aviso.
 */
export function mirrorLabRuns(store: LabStore, config: () => MirrorConfig | undefined, onResult: (text: string, ok: boolean) => void): void {
  const add = store.addRun.bind(store);
  const experiments = new Map<string, Promise<string>>();
  store.addRun = (r) => {
    const run = add(r);
    const cfg = config();
    if (cfg) {
      void mirrorRun(cfg, run, experiments).then(
        (id) => onResult(`Run ${run.id} espelhado no MLflow (${cfg.uri}, run ${id}).`, true),
        (err) => onResult(`Não consegui espelhar o run ${run.id} no MLflow (${cfg.uri}): ${err instanceof Error ? err.message : String(err)}`, false),
      );
    }
    return run;
  };
}

async function mirrorRun(cfg: MirrorConfig, run: Run, experiments: Map<string, Promise<string>>): Promise<string> {
  const client = new MlflowClient(cfg.uri);
  const key = `${cfg.uri}|${cfg.experiment}`;
  let exp = experiments.get(key);
  if (!exp) {
    exp = client.experimentId(cfg.experiment);
    experiments.set(key, exp);
    exp.catch(() => experiments.delete(key));
  }
  const tags: Record<string, string> = {
    node_id: run.agent,
    hypothesis_id: run.hypothesisId,
    arm: run.arm,
    seed: String(run.seed),
    lab_run_id: run.id,
    source: run.source,
    'mlflow.source.name': 'agent-graph-master',
  };
  if (run.commit) {
    tags.git_sha = run.commit;
    tags['mlflow.source.git.commit'] = run.commit;
  }
  if (run.dirty !== undefined) {
    tags.git_dirty = String(run.dirty);
  }
  const runId = await client.createRun(await exp, `${run.hypothesisId}-${run.arm}-s${run.seed}`, tags, Date.parse(run.at) || Date.now());
  await client.logBatch(runId, run.metrics, run.command ? { command: run.command } : {}, run.artifact ? { artifact: run.artifact } : {});
  await client.finish(runId);
  return runId;
}
