// Mensagens trocadas entre o painel (extensão) e a página do chat (webview).

import type { BrowserStatus } from './browser';
import type { CompanionInit } from './companion/types';

/** Primeira linha do texto que o "Enviar ao principal" do chat lateral manda à conversa principal. */
export const COMPANION_MARK = '[Da consulta lateral, enviado pelo usuário]';

/** Quem roda a conversa ou o agente. Ausente = Claude (tudo que foi gravado antes do Codex existir). */
export type Provider = 'claude' | 'codex';

export interface ModelOption {
  value: string;
  /** Níveis de raciocínio que o modelo aceita (o Codex informa por modelo). Ausente: os do Claude. */
  efforts?: string[];
  /** Id concreto que a sessão reporta em `session.model` (ex.: claude-opus-5-5). Liga o modelo escolhido ao nome bonito. */
  resolvedModel?: string;
  displayName: string;
  description: string;
}

/**
 * Anexo de uma mensagem. Imagem colada ou arrastada vira bloco de imagem para o modelo.
 * Arquivo arrastado do explorer do VS Code vira menção `@caminho` (o Claude lê quando precisar);
 * arquivo vindo de fora do VS Code, que não tem caminho, vai com o texto embutido.
 */
export interface Attachment {
  id: string;
  kind: 'image' | 'path' | 'text';
  name: string;
  /** Imagem: data URL (`data:image/png;base64,...`), usada no preview e convertida em bloco de imagem. */
  dataUrl?: string;
  /** path: caminho do arquivo, relativo ao cwd quando dá. */
  path?: string;
  /** text: conteúdo do arquivo lido no webview. */
  text?: string;
  /** Bytes do original, para mostrar no preview. */
  size?: number;
  /** Preenchido pelo host quando o anexo é grande demais ou não pôde ser lido. */
  error?: string;
}

export type HistoryItem =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; input: unknown }
  | { kind: 'toolResult'; id: string; text: string; isError: boolean; images?: string[] };

export interface ProfileOption {
  id: string;
  name: string;
  account: string;
  provider?: Provider;
}

/** Uma janela de limite do plano (5 horas, semana, semana por modelo). */
export interface UsageWindow {
  key: string;
  label: string;
  /** 0 a 100. */
  utilization: number;
  /** ISO de quando a janela zera. */
  resetsAt?: string;
}

/** Uma conversa salva da conta, para o dropdown de histórico. */
export interface SessionOption {
  id: string;
  title: string;
  /** ISO da última alteração. */
  lastModified: number;
  current: boolean;
}

export interface UsageInfo {
  available: boolean;
  subscription?: string;
  windows: UsageWindow[];
  /** ISO da leitura, para o rodapé mostrar há quanto tempo o dado é. */
  fetchedAt: string;
  error?: string;
}

export type AgentStatus = 'running' | 'completed' | 'failed' | 'stopped';

/**
 * Worktree git de um agente isolado. A extensão cria (git worktree add) e sabe o caminho e a branch,
 * então mesclar e descartar ficam com o usuário, pelos botões do popup do nó.
 */
export interface WorktreeInfo {
  /** Raiz do worktree: <raiz do repositório>/.agm/worktrees/<nome>. */
  path: string;
  /** Branch do agente, agm/<id>-<slug>. */
  branch: string;
  /** Branch de onde o agente saiu; é nela que o Mesclar entra. Commit, se o HEAD estava solto. */
  base: string;
  /** Commit de partida. Depois de mesclar, a ponta mesclada: o diff e a contagem partem daqui. */
  baseCommit: string;
  /** Raiz do repositório principal. */
  repo: string;
  /** Diretório de trabalho da sessão: o worktree mais o subcaminho do projeto dentro do repositório. */
  cwd: string;
  /** active: em uso. merged: mesclado ao menos uma vez (continua existindo). discarded: removido pelo usuário. missing: sumiu do disco. */
  status: 'active' | 'merged' | 'discarded' | 'missing';
  /** Arquivos diferentes do ponto de partida, contando o que ainda não foi commitado. */
  changed?: number;
  /** Commits da branch do agente à frente do ponto de partida. */
  ahead?: number;
}

/** Botões do popup de um agente isolado. */
export type WorktreeAction = 'diff' | 'merge' | 'discard';

/**
 * Cor de identidade do agente, escolhida pelo orquestrador ao criar. Serve para o olho separar frentes
 * de trabalho no mapa e no grafo. Cores fixas, não texto livre: o modelo escolhe um nome desta lista.
 */
export const AGENT_COLORS = {
  ambar: '#d99b3f',
  azul: '#4d8fd6',
  violeta: '#9a7fd1',
  turquesa: '#3fb5a8',
  rosa: '#d66f9a',
  lima: '#8fbf47',
  ciano: '#4fb0c6',
  terracota: '#d97757',
  indigo: '#6f7fd6',
  oliva: '#9aa84a',
} as const;

export type AgentColor = keyof typeof AGENT_COLORS;

export const AGENT_COLOR_NAMES = Object.keys(AGENT_COLORS) as AgentColor[];

/** Anel de estado, desenhado por cima da cor própria do agente. */
export const STATUS_RING = {
  /** Verde do Claude: o agente está trabalhando agora. */
  running: '#3fb950',
  /** Parado ou falhou. */
  halted: '#f85149',
} as const;

export function agentColor(name: string | undefined, fallbackSeed: string): string {
  if (name && name in AGENT_COLORS) {
    return AGENT_COLORS[name as AgentColor];
  }
  // Ids sequenciais (a1, a2, ...) percorrem a paleta em ordem: é o caso comum e não colide.
  const seq = /^a(\d+)$/.exec(fallbackSeed);
  if (seq) {
    return AGENT_COLORS[AGENT_COLOR_NAMES[(Number(seq[1]) - 1) % AGENT_COLOR_NAMES.length]];
  }
  // Para os demais, FNV-1a: mistura melhor que o hash de multiplicar por 31, que agrupava ids parecidos.
  let hash = 0x811c9dc5;
  for (let i = 0; i < fallbackSeed.length; i++) {
    hash ^= fallbackSeed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return AGENT_COLORS[AGENT_COLOR_NAMES[hash % AGENT_COLOR_NAMES.length]];
}

/** Um subagente da conversa (ferramenta Agent/Task) ou uma continuação dele aberta em outro chat. */
export interface AgentInfo {
  id: string;
  taskId?: string;
  /** subagent: ferramenta Agent embutida. routed: criado por spawn_agent, controlável. fork: continuação em outro chat. */
  kind: 'subagent' | 'routed' | 'fork';
  /** Quem criou (main ou id de agente) e para onde vai o relatório final (routed). */
  creator?: string;
  reportTo?: string;
  effort?: string;
  description: string;
  subagentType?: string;
  prompt?: string;
  status: AgentStatus;
  totalTokens: number;
  durationMs: number;
  toolUses: number;
  lastTool?: string;
  summary?: string;
  /** Texto do relatório final que o agente entregou. É o que o mapa mostra de cara. */
  report?: string;
  /** Para quem o relatório foi de fato entregue (pode diferir de reportTo se o destino sumiu). */
  reportedTo?: string;
  reportedAt?: string;
  /** Quantas mensagens o agente recebeu depois da tarefa inicial (respostas, pedidos de outros agentes). */
  exchanges?: number;
  /** Nome da cor escolhida pelo orquestrador (chave de AGENT_COLORS). */
  color?: string;
  /** Só para continuações: conta e modelo em que o chat roda. */
  profileName?: string;
  model?: string;
  /** Sessão própria do agente no Claude Code. É o que permite retomar a conversa dele depois de fechar a janela. */
  sessionId?: string;
  /** Veio do disco ao reabrir a conversa: o processo dele não está de pé até você retomar. */
  restored?: boolean;
  /** Agente vigia: o hub o acorda a cada tantos minutos. Continua definido depois de parado, para o mapa saber o que ele é. */
  repeatEveryMinutes?: number;
  /** ISO do fim da última verificação. */
  lastCheckAt?: string;
  /** ISO da próxima verificação agendada. Ausente quando a recorrência está parada. */
  nextCheckAt?: string;
  /** Quantas verificações o vigia já fez. */
  checks?: number;
  /** Agente roteado ou continuação que roda no Codex; ausente = Claude. */
  provider?: Provider;
  /** Id da conta (perfil) em que o agente roda, quando não é a conta do chat. É o que o Retomar usa. */
  accountId?: string;
  /** Foi criado para usar o navegador (spawn_agent com browser). Salvo em disco; ao retomar, pede o navegador de novo. */
  browser?: boolean;
  /** É o dono do navegador agora. Não vai para o disco: agente restaurado volta sem o navegador. */
  browserActive?: boolean;
  /** Agente isolado (spawn_agent com isolation "worktree"): roda numa cópia git própria. Ausente = diretório compartilhado. */
  worktree?: WorktreeInfo;
  /** Limites de consumo do agente (spawn_agent com budget ou agentGraphMaster.defaultAgentBudget). */
  budget?: AgentBudget;
  /** Consumo acumulado desde a criação, somado entre retomadas. */
  spent?: AgentSpent;
  /** Caminhos que este agente não lê nem grava (além dos do projeto em .agm/protected.json). */
  protectedPaths?: string[];
  /** Marcado pelo detector de agente preso. Some quando o agente volta a progredir ou o turno acaba. */
  stuck?: { reason: string; since: string };
  /** Tentativa de um grupo Best-of-N (spawn_attempts). Todas do grupo têm a mesma cor e o mesmo `group`. */
  attempt?: AttemptInfo;
  /** Verificador independente de uma hipótese do laboratório: só lê e reexecuta com seed nova. */
  verifier?: { hypothesisId: string; verdictId: string };
  /** Nó de torneio de hipóteses ou de varredura de hiperparâmetros: não é agente, é o hub rodando a busca. */
  search?: SearchNodeInfo;
  /** Nó que não é agente: job de GPU (submit_job) ou vigia de treino (watch_training), acompanhados pelo hub sem LLM. */
  infra?: InfraNodeInfo;
  /** Caixa (grupo de trabalho) em que o agente está no mapa: id de um BoxInfo. Ausente = avulso. */
  box?: string;
  /**
   * Última entrega de novidades do cérebro compartilhado: quantas, quando e como (dobradas no turno em andamento
   * ou na frente de uma mensagem). `total` soma todas as entregas.
   */
  brainNews?: { count: number; at: string; how: 'turno' | 'mensagem'; total: number };
}

/**
 * Caixa do mapa: agrupa os agentes de um mesmo projeto ou etapa (create_box, spawn_agent com box, assign_box).
 * No grafo vira um retângulo recolhível com uma aresta só até a raiz. Uma caixa pode ficar dentro de outra
 * (`parent`), um nível só.
 */
export interface BoxInfo {
  /** "b1", "b2"... */
  id: string;
  name: string;
  description?: string;
  /** Nome de AGENT_COLORS. Ausente: derivada do id. */
  color?: string;
  /** Caixa-mãe (sem mãe ela mesma). */
  parent?: string;
  /** ISO. */
  createdAt: string;
}

/**
 * Posição de um agente num grupo Best-of-N. Até o grupo fechar só `group`, `index`, `of`, métrica e direção
 * existem; ao fechar, o hub lê a métrica de cada tentativa e preenche valor, posição e a vencedora.
 */
export interface AttemptInfo {
  /** "g1", "g2"... */
  group: string;
  /** 1 a `of`. */
  index: number;
  of: number;
  metric: string;
  direction: 'higher' | 'lower';
  /** Grupo fechado: ranking calculado e relatório consolidado entregue. */
  closed?: boolean;
  value?: number;
  /** De onde veio o valor: `result.json` do worktree (com sha256) ou o último log_run do agente. */
  source?: 'result.json' | 'log_run';
  hash?: string;
  /** 1 = melhor. Ausente quando a tentativa não gravou a métrica. */
  rank?: number;
  winner?: boolean;
}

/** Limites de um agente. Ausente = sem limite naquela medida. */
export interface AgentBudget {
  /** Tokens processados: entrada (com cache) mais saída, somados em todas as chamadas ao modelo. */
  maxTokens?: number;
  /** Minutos de trabalho (tempo com turno em andamento, não tempo de relógio desde a criação). */
  maxMinutes?: number;
  /** Custo estimado em dólares, como o SDK do Claude calcula. Não existe para agentes Codex. */
  maxUsd?: number;
}

export interface AgentSpent {
  tokens: number;
  minutes: number;
  /** Ausente em agentes Codex: o app-server do Codex não informa custo. */
  usd?: number;
}

/**
 * Cartão do guarda no chat: orçamento esgotado (Dar mais / Parar de vez) ou agente possivelmente preso
 * (Mandar mensagem / Parar / Ignorar). O mesmo id volta com o status novo depois do clique.
 */
export interface GuardAlert {
  id: string;
  agentId: string;
  kind: 'budget' | 'stuck' | 'training';
  text: string;
  /** ISO de quando apareceu. */
  at: string;
  status: 'pending' | 'extended' | 'stopped' | 'ignored' | 'messaged' | 'resolved';
  /** Orçamento: quanto "Dar mais" acrescenta, em % do limite atual. */
  extendPercent?: number;
  /** Explicação do status final (ex.: "voltou a progredir"). */
  note?: string;
  /** Vigia de treino: job ligado ao alerta; sem ele, o cartão não mostra "Parar o job". */
  jobId?: string;
  /** Vigia de treino: resumo curto feito por um modelo pequeno depois da detecção (chega numa atualização do cartão). */
  summary?: string;
}

/** Tarefa que um vigia encontrou fora daqui (Slack, arquivo...) e que espera o usuário aprovar. */
export interface TaskProposal {
  id: string;
  /** Agente que propôs. */
  agentId: string;
  source: string;
  from: string;
  summary: string;
  instructions: string;
  link?: string;
  /** ISO de quando chegou. */
  at: string;
  status: 'pending' | 'approved' | 'edited' | 'ignored';
}

/** Tempo até um instante, curto: "40s", "3m", "1h 5m". */
function fmtLeft(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Agente Claude roteado numa conta diferente da do chat: o hub só grava accountId de Claude nesse caso. */
export function onOtherAccount(a: AgentInfo): boolean {
  return a.kind === 'routed' && a.provider !== 'codex' && !!a.accountId;
}

/** Nome da conta para a etiqueta do mapa: "fulano-gmail-com" vira "fulano". */
export function shortAccountName(name: string): string {
  const first = name.split(/[-@\s]/)[0] || name;
  return first.length > 14 ? `${first.slice(0, 13)}…` : first;
}

/** "a cada 5 min", ou em segundos quando o intervalo é menor que um minuto (só acontece em teste). */
export function repeatLabel(minutes: number): string {
  return minutes < 1 ? `a cada ${Math.round(minutes * 60)}s` : `a cada ${Math.round(minutes)} min`;
}

/**
 * Estado de um vigia numa linha: "a cada 5 min · próxima em 3m", "a cada 5 min · verificando" ou
 * "a cada 5 min · parado". Vazio para agente comum. `now` vem de fora para o tique de 1s reescrever.
 */
export function watchLabel(a: AgentInfo, now: number): string {
  if (!a.repeatEveryMinutes) {
    return '';
  }
  const base = repeatLabel(a.repeatEveryMinutes);
  if (a.status === 'running') {
    return `${base} · verificando`;
  }
  if (a.nextCheckAt) {
    return `${base} · próxima em ${fmtLeft(Date.parse(a.nextCheckAt) - now)}`;
  }
  return `${base} · parado`;
}

/** "última verificação às 14:32 · 7 verificações", ou vazio antes da primeira. */
export function lastCheckLabel(a: AgentInfo): string {
  if (!a.lastCheckAt) {
    return '';
  }
  const at = new Date(a.lastCheckAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const n = a.checks ?? 0;
  return `última verificação às ${at}${n ? ` · ${n} ${n === 1 ? 'verificação' : 'verificações'}` : ''}`;
}

export const EFFORT_LEVELS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type HostMessage =
  | {
      type: 'init';
      profileId: string;
      profileName: string;
      account: string;
      cwd: string;
      permissionMode: string;
      model: string;
      effort: string;
      /** Preenchido quando este chat é a continuação de um subagente. */
      forkOf?: string;
      /** Codex muda o cabeçalho, os níveis de raciocínio e os comandos de barra. */
      provider?: Provider;
      /** URI do diretório de trabalho servida ao webview (asWebviewUri): base das miniaturas de imagens geradas. */
      cwdUri?: string;
      /** Provedores padrão de pesquisa e imagem e a pasta de imagens, para os itens do menu "+". */
      external?: { research: ExternalProviderName; image: ExternalProviderName; imageFolder: string };
      /** Nome da sessão (o /rename ou o título que o Claude Code gera). Vazio: conversa ainda sem nome. */
      sessionTitle?: string;
      /** Preenchido quando este é o chat lateral de consulta de uma conversa principal. */
      companion?: CompanionInit;
    }
  | { type: 'profiles'; list: ProfileOption[] }
  | { type: 'agent'; agent: AgentInfo }
  /** Lista inteira das caixas da conversa, a cada mudança (vazia ao trocar de conversa). */
  | { type: 'boxes'; list: BoxInfo[] }
  | { type: 'agentItem'; id: string; item: HistoryItem }
  | { type: 'contextTokens'; value: number }
  | { type: 'models'; list: ModelOption[] }
  /** Modelos das contas Codex, para o seletor de quem continua um agente numa conta Codex a partir de um chat Claude. */
  | { type: 'codexModels'; list: ModelOption[] }
  | {
      type: 'session';
      sessionId: string;
      model: string;
      permissionMode: string;
      /** Servidores MCP que o CLI carregou nesta sessão (mcp_servers do init), para diagnóstico. */
      mcpServers?: { name: string; status: string }[];
    }
  | { type: 'busy'; value: boolean }
  | { type: 'thinking'; value: boolean }
  | { type: 'textDelta'; msgId: string; index: number; text: string }
  | { type: 'toolStart'; id: string; name: string }
  | { type: 'assistantText'; msgId: string; text: string }
  | { type: 'toolUse'; id: string; name: string; input: unknown }
  /** `images`: data URLs das imagens do resultado (capturas do navegador), já limitadas em tamanho pelo host. */
  | { type: 'toolResult'; id: string; text: string; isError: boolean; images?: string[] }
  | {
      type: 'permission';
      requestId: string;
      toolName: string;
      input: Record<string, unknown>;
      canAlways: boolean;
      reason?: string;
      /** Preenchido quando o pedido vem de um agente e não do chat principal. */
      agentLabel?: string;
      /** Id do agente que pediu, para o cartão usar a cor dele. */
      agentId?: string;
    }
  | { type: 'permissionClosed'; requestId: string }
  | {
      type: 'result';
      isError: boolean;
      text: string;
      durationMs: number;
      inputTokens: number;
      outputTokens: number;
    }
  | { type: 'notice'; text: string; level: 'info' | 'error'; action?: NoticeAction }
  | { type: 'history'; items: HistoryItem[]; title: string }
  | { type: 'clear' }
  /** Quadro do laboratório mudou (ou é o estado inicial, `initial`): hipóteses, vereditos e runs resumidos. */
  | { type: 'lab'; state: LabState; initial?: boolean }
  /** O cérebro compartilhado (.agm/brain/) existe: o mapa mostra o botão "Cérebro" e o popup, "Nota no cérebro". */
  | { type: 'brain'; exists: boolean }
  /** `fromId`: agente que entregou o relatório, para a linha usar a cor e o título dele. */
  /** `origin: 'companion'`: o usuário mandou pelo botão "Enviar ao principal" do chat lateral. */
  | { type: 'userEcho'; text: string; from?: string; fromId?: string; origin?: 'companion' }
  /** Nome da sessão mudou (gerado pelo Claude Code ou /rename): o cabeçalho acompanha. */
  | { type: 'sessionTitle'; title: string }
  /** Chat lateral: troca o texto da caixa (pergunta pré-preenchida, sem enviar). */
  | { type: 'companionPrefill'; text: string }
  /** Chat lateral: perguntas de exemplo atualizadas (o último agente ativo muda). */
  | { type: 'companionExamples'; examples: string[] }
  | { type: 'insertText'; text: string }
  /** Resposta a `resolveUris`: anexos prontos (com caminho relativo) para o webview mostrar no preview. */
  | { type: 'attachments'; list: Attachment[] }
  | { type: 'usage'; usage: UsageInfo }
  | { type: 'sessions'; list: SessionOption[]; error?: string }
  /** Comandos de barra que funcionam fora do terminal, para o autocompletar do composer. */
  | { type: 'commands'; list: SlashCommandOption[] }
  /** Saída de um comando local (/rename, /usage, /context...): o CLI responde sem chamar o modelo. */
  | { type: 'commandOutput'; text: string }
  /** Resposta a `searchFiles`. `notice` explica listas limitadas (sem pasta aberta, por exemplo). */
  | { type: 'fileResults'; requestId: number; list: FileResult[]; notice?: string }
  /** Nome do arquivo aberto no editor (o que "Mencionar arquivo aberto" usaria), ou nada. */
  | { type: 'activeFile'; name?: string }
  /** Tarefa proposta por um vigia, nova ou com status mudado: o webview mostra ou atualiza o cartão de aprovação. */
  | { type: 'taskProposal'; proposal: TaskProposal }
  /** Cartão do guarda (orçamento esgotado ou agente preso), novo ou com status mudado. */
  | { type: 'guardAlert'; alert: GuardAlert }
  /**
   * Claude in Chrome neste chat. `on`: interruptor do chat principal. `browser`: estado da sessão principal.
   * `owner`: quem tem o navegador agora (este chat, um agente, ou outra aba). `browsers`: navegadores conectados à
   * conta, lidos direto da ponte do CLI (nome, sistema, se roda nesta máquina).
   */
  | {
      type: 'browserStatus';
      on: boolean;
      browser: BrowserStatus;
      owner?: { id: string; label: string };
      browsers?: ConnectedBrowser[];
      browsersError?: string;
    };

/** Um navegador com a extensão Claude in Chrome conectado à conta (resposta de list_connected_browsers). */
export interface ConnectedBrowser {
  name: string;
  osPlatform?: string;
  isLocal?: boolean;
  inUse?: boolean;
}

/** Provedor externo de pesquisa e imagem. */
export type ExternalProviderName = 'gemini' | 'openai';

/** Botão dentro de um aviso. Hoje só abre a configuração de chave de um provedor externo. */
export type NoticeAction = { kind: 'configureKey'; provider: ExternalProviderName; label: string };

/** Item do autocompletar de "@". `path` é relativo ao cwd, com "/". */
export interface FileResult {
  path: string;
  name: string;
  kind: 'file' | 'folder';
}

export interface SlashCommandOption {
  /** Sem a barra. */
  name: string;
  description: string;
  argumentHint?: string;
}

export type PermissionDecision =
  | { decision: 'allow' | 'always' }
  | { decision: 'deny'; feedback?: string }
  | { decision: 'answer'; updatedInput: Record<string, unknown> };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'send'; text: string; attachments?: Attachment[] }
  /** Arquivos arrastados do explorer do VS Code; o host resolve as URIs em caminhos. */
  | { type: 'resolveUris'; uris: string[] }
  | { type: 'interrupt' }
  | ({ type: 'permission'; requestId: string } & PermissionDecision)
  | { type: 'setModel'; value: string }
  | { type: 'setMode'; value: string }
  | { type: 'setEffort'; value: string }
  | { type: 'stopAgent'; id: string }
  | { type: 'forkAgent'; id: string; profileId: string; model: string; effort: string; text: string; stopOriginal: boolean }
  | { type: 'sendToParent' }
  | { type: 'agentSend'; id: string; text: string }
  | { type: 'agentSetModel'; id: string; value: string }
  | { type: 'agentSetEffort'; id: string; value: string }
  | { type: 'revealAgent'; id: string }
  /** Sobe de novo o processo de um agente restaurado, retomando a sessão dele. */
  | { type: 'resumeAgent'; id: string; text?: string }
  /** Pede uma leitura dos limites agora (clique no rodapé). */
  | { type: 'refreshUsage' }
  | { type: 'newChat' }
  /** Pede a lista de conversas para o dropdown; o host responde com `sessions`. */
  | { type: 'listSessions' }
  | { type: 'resumeSession'; id: string }
  | { type: 'mentionFile' }
  /** Pede de novo a lista de comandos de barra; o host responde com `commands`. */
  | { type: 'listCommands' }
  /** Pede os modelos do Codex; o host responde com `codexModels`. */
  | { type: 'listCodexModels' }
  /** Autocompletar de "@": o host responde com `fileResults` e o mesmo requestId. */
  | { type: 'searchFiles'; query: string; requestId: number }
  /**
   * Resposta ao cartão de aprovação. `approve` entrega ao agente principal; `edit` só marca (o texto foi
   * para o composer e o usuário manda quando quiser); `ignore` descarta.
   */
  | { type: 'resolveTask'; id: string; action: 'approve' | 'edit' | 'ignore' }
  /** Clique num cartão do guarda. `message` leva o texto digitado no próprio cartão. */
  | { type: 'resolveGuard'; id: string; action: 'extend' | 'stop' | 'ignore' | 'message'; text?: string }
  /** Botão "Configurar chave" de um aviso: roda o comando de chave do provedor. */
  | { type: 'configureKey'; provider: ExternalProviderName }
  /** Clique numa miniatura de imagem gerada: abre o arquivo (relativo ao cwd) no editor. */
  | { type: 'openFile'; path: string }
  /** Interruptor "Usar o navegador (Claude in Chrome)" do chat principal. */
  | { type: 'setChrome'; value: boolean }
  /** Relê a lista de navegadores conectados (clique no indicador). */
  | { type: 'refreshBrowsers' }
  /** Botões do popup de um agente isolado: abrir o diff no editor, mesclar ou descartar (os dois últimos com confirmação modal). */
  /** Botão "Podar"/"Restaurar" do popup de uma hipótese na árvore do laboratório. Só marca; nada é apagado. */
  | { type: 'labAction'; kind: 'prune' | 'unprune'; hypothesis_id: string }
  | { type: 'worktreeAction'; id: string; action: WorktreeAction }
  /** Abre (ou revela) o chat lateral de consulta desta conversa, com a pergunta opcional já na caixa. */
  | { type: 'openCompanion'; prefill?: string }
  /** Botão "Cérebro" do mapa (sem agentId: o index.md) ou "Nota no cérebro" do popup de um agente. Abre no preview de Markdown. */
  | { type: 'openBrain'; agentId?: string }
  /** Chat lateral: clique em "Enviar ao principal" numa resposta. Só o clique do usuário gera esta mensagem. */
  | { type: 'companionToMain'; text: string };

// ---------- Laboratório (quadro de experimentos em .agm/lab/) ----------

/** Veredito de declare_result. Só a estatística decide; nenhum texto do modelo muda isto. */
export type LabVerdictKind = 'suportada' | 'inconclusiva' | 'refutada';

/** Estado da hipótese, derivado dos runs e do último veredito. */
export type LabHypothesisStatus = 'registrada' | 'rodando' | 'concluída' | 'inconclusiva' | 'refutada';

export interface LabArmInfo {
  arm: string;
  /** Seeds com a métrica primária (a última execução de cada seed vale). */
  n: number;
  mean: number;
  sd: number;
}

export interface LabVerdictInfo {
  verdict: LabVerdictKind;
  at: string;
  /** Quem chamou declare_result. */
  by: string;
  /** Quantas vezes declare_result rodou nesta hipótese; mais de uma é parada opcional e fica à vista. */
  attempt: number;
  /** `paired-samples`: bootstrap sobre diferenças por amostra alinhadas; `seeds`: cada braço reamostrado por seed. */
  mode: 'paired-samples' | 'seeds';
  /** Variante menos baseline, com o sinal da direção: positivo é melhora. */
  diff: number;
  /** `diff` relativo à média do baseline, quando ela não é zero. */
  relDiff?: number;
  ci: [number, number];
  ciLevel: number;
  /** d de Cohen (seeds) ou d_z (pareado), com o sinal de `diff`. */
  effect: number;
  p: number;
  pAdjusted: number;
  family: string;
  familySize: number;
  /** Melhora mínima exigida, na unidade da métrica. */
  threshold: number;
  arms: LabArmInfo[];
  /** Estimativa de seeds por braço que faltam (análise de poder). Ausente quando mais seeds não ajudariam. */
  seedsMissing?: number;
  /** Por que o veredito é este, uma condição por linha. */
  reasons: string[];
  /** Sinais de resultado bom demais (efeito enorme, variância zero). */
  warnings: string[];
}

export interface LabRunInfo {
  id: string;
  arm: string;
  seed: number;
  /** Valor da métrica primária da hipótese. */
  value?: number;
  command?: string;
  commit?: string;
  dirty?: boolean;
  artifact?: string;
  agent: string;
  at: string;
  /** `arquivo`: métricas lidas pelo host de um JSON gravado pelo experimento; `declarado`: passadas pelo agente. */
  source: 'arquivo' | 'declarado';
  /** sha256 (16 hex) do arquivo de métricas lido pelo host, quando o número veio de arquivo. */
  metricsFileHash?: string;
}

export interface LabHypothesisInfo {
  id: string;
  title: string;
  statement: string;
  metric: string;
  direction: 'higher' | 'lower';
  minImprovement: number;
  improvementKind: 'absolute' | 'relative';
  arms: [string, string];
  minSeeds: number;
  alpha: number;
  status: LabHypothesisStatus;
  createdBy: string;
  createdAt: string;
  derivedFrom?: string;
  family: string;
  runCounts: Record<string, number>;
  verdict?: LabVerdictInfo;
  /** Verificação independente do último veredito (ou a que está rodando). */
  verification?: LabVerificationInfo;
  /** Runs da hipótese, os mais recentes por último (no máximo 60). */
  runs: LabRunInfo[];
  /** Podada pelo usuário na árvore de hipóteses: o ramo fica esmaecido, sem sumir. */
  pruned?: { at: string; by: string };
}

export interface LabState {
  hypotheses: LabHypothesisInfo[];
  runs: number;
  findings: number;
}

// ---------- Verificação independente (src/chat/parallel/verify.ts) ----------

/** Parecer do verificador: o que ele concluiu, antes das checagens do host. */
export type VerificationVerdict = 'confirmado' | 'divergente' | 'inconclusivo';

/** Selo mostrado no cartão da hipótese. `verificando` enquanto o agente verificador trabalha. */
export type VerificationSeal = 'verificado' | 'divergente' | 'inconclusivo' | 'verificando';

export interface LabVerificationInfo {
  seal: VerificationSeal;
  /** Veredito (v1, v2...) que foi verificado. Veredito novo na hipótese deixa a verificação antiga para trás. */
  verdictId: string;
  /** Agente verificador. */
  agent: string;
  at: string;
  /** Parecer do verificador; ausente enquanto ele trabalha. */
  verdict?: VerificationVerdict;
  notes?: string;
  /** Checagens feitas pelo host (hash dos arquivos, caminhos protegidos, recálculo, reexecuções no intervalo). */
  checks?: string[];
  /** Reexecuções com seed nova, lidas pelo host do arquivo de métricas que o verificador gravou. */
  reruns?: { arm: string; seed: number; value?: number; interval?: [number, number]; inside?: boolean; command: string }[];
}

// ---------- Infraestrutura de pesquisa (jobs de GPU e vigia de treino, src/chat/infra) ----------

/** Estado de um job ou de um vigia de treino, levado no AgentInfo do nó sintético que o grafo desenha. */
export interface InfraNodeInfo {
  kind: 'job' | 'trainingWatch';
  /** Job: backend, estado no backend e id lá (job do Slurm, app do Modal, pod do RunPod). */
  backend?: 'slurm' | 'modal' | 'runpod' | 'local';
  state?: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'lost';
  externalId?: string;
  gpus?: number;
  gpuType?: string;
  hours?: number;
  /** Custo acumulado até agora; ausente quando o preço da GPU é desconhecido. */
  costUsd?: number;
  startedAt?: string;
  endedAt?: string;
  /** Vigia: de onde lê, qual métrica, a última leitura e quantos alertas já deu. */
  source?: string;
  metric?: string;
  last?: { step: number; value: number; at: string };
  alerts?: number;
  /** Vigia ligado a um job. */
  jobId?: string;
}

// ---------- Busca (torneio de hipóteses e varredura de hiperparâmetros, src/chat/search) ----------

/** O que o nó de um torneio ou de uma varredura mostra no mapa e no popup. */
export interface SearchNodeInfo {
  kind: 'tournament' | 'sweep';
  /** Linha de baixo do nó: "3/4 partidas · líder c2 1216" ou "6/10 trials · melhor 0.013". */
  progress: string;
  /** Conteúdo ao vivo do popup, em markdown: ranking Elo ou os melhores trials. */
  markdown: string;
  /** Título da seção do popup. */
  label: string;
  /** Torneio: o líder atual, para o botão "Promover líder". */
  leader?: { id: string; title: string };
}
