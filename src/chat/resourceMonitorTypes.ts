/**
 * Tipos JSON do monitor de recursos, sem dependência de Node: o host (resourceMonitor.ts) e o webview (resourcePill.ts)
 * importam daqui. Também são o formato das mensagens propostas para protocol.ts (veja ResourceMsgToWebview e ResourceMsgFromWebview).
 */

export type ResourceLevel = 'ok' | 'alto' | 'critico';

export type ProcKind = 'cli' | 'mcp' | 'shell' | 'media' | 'runtime' | 'console' | 'other';

export type SuspectReason = 'ocioso' | 'duplicado' | 'shell-parado';

export interface ProcView {
  pid: number;
  name: string;
  /** Comando curto e legível. */
  short: string;
  kind: ProcKind;
  /** Memória do processo. */
  rssBytes: number;
  /** CPU média desde a amostra anterior (0 a 100 por núcleo, pode passar de 100); undefined na primeira amostra. */
  cpuPct?: number;
  startedMs?: number;
  /** Há quanto tempo está sem CPU, em ms. */
  idleMs: number;
  depth: number;
}

export interface SuspectView extends ProcView {
  reason: SuspectReason;
  /** Memória do processo mais a de tudo que ele sobe (é o que o "Encerrar" libera). */
  treeBytes: number;
  /** Texto curto para a UI: "servidor MCP ocioso há 2 h". */
  label: string;
  /** Encerrar derruba ferramentas da sessão (servidor MCP ocioso que não é duplicado). */
  risky: boolean;
}

export interface ChatResources {
  chatId: string;
  cliPid?: number;
  /** false se o CLI já morreu ou a leitura falhou. */
  alive: boolean;
  level: ResourceLevel;
  /** CLI mais descendentes. */
  totalBytes: number;
  cliBytes: number;
  childrenBytes: number;
  /** Maiores processos (CLI incluído), do maior para o menor. */
  top: ProcView[];
  suspects: SuspectView[];
  at: number;
  error?: string;
}

export interface ResourceReport {
  at: number;
  host: { rssBytes: number; heapUsedBytes: number };
  /** Soma do host e de todos os chats. */
  grandTotalBytes: number;
  level: ResourceLevel;
  chats: ChatResources[];
  /** Texto curto por chat, o mesmo que se injeta para o modelo. */
  summaries: Record<string, string>;
}

/** Host para webview: relatório novo (a cada amostra e quando o webview pede). */
export interface ResourceMsgToWebview {
  type: 'resources';
  report: ResourceReport;
}

/** Host para webview: resultado de um "Encerrar". */
export interface ResourceKillResultMsg {
  type: 'resourceKillResult';
  chatId: string;
  pid: number;
  ok: boolean;
  message: string;
}

/** Webview para host. */
export type ResourceMsgFromWebview =
  | { type: 'resourcesRefresh' }
  | { type: 'resourceKill'; chatId: string; pid: number; name: string; startedMs?: number };
