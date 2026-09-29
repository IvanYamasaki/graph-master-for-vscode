/**
 * Claude in Chrome: ferramentas `mcp__claude-in-chrome__*` que o CLI sobe com `--chrome`.
 * Sem dependência do vscode, para o webview também poder usar as descrições.
 */

export const BROWSER_SERVER = 'claude-in-chrome';
export const BROWSER_TOOL_PREFIX = `mcp__${BROWSER_SERVER}__`;

/** Estado do navegador numa sessão, para o host mostrar na interface. */
export interface BrowserStatus {
  /** A sessão subiu com `--chrome`. */
  enabled: boolean;
  /**
   * `connected` diz só que a ponte MCP do CLI subiu; se o Chrome está aberto e com a extensão só se sabe na
   * primeira chamada. Quando uma chamada volta dizendo que o navegador não responde, vira `disconnected`.
   */
  status: 'off' | 'pending' | 'connected' | 'disconnected' | 'failed' | 'disabled' | 'needs-auth';
  /** Nomes completos das ferramentas que a sessão recebeu (`mcp__claude-in-chrome__navigate`, ...). */
  tools: string[];
  error?: string;
}

export function isBrowserTool(name: string): boolean {
  return name.startsWith(BROWSER_TOOL_PREFIX);
}

function shortName(name: string): string {
  return name.startsWith(BROWSER_TOOL_PREFIX) ? name.slice(BROWSER_TOOL_PREFIX.length) : name;
}

/** Só olham ou esperam; não mudam nada na página nem na conta do usuário. */
const READ_TOOLS = new Set([
  'tabs_context_mcp',
  'list_connected_browsers',
  'read_page',
  'get_page_text',
  'find',
  'read_console_messages',
  'read_network_requests',
  'shortcuts_list',
  'resize_window',
]);
const READ_COMPUTER_ACTIONS = new Set(['screenshot', 'zoom', 'wait', 'scroll', 'scroll_to', 'hover']);

/** Chamadas de um `browser_batch`: a primeira lista de objetos `{ name, input }` que aparecer na entrada. */
function batchCalls(input: Record<string, unknown>): { name: string; input: Record<string, unknown> }[] | undefined {
  for (const value of Object.values(input)) {
    if (Array.isArray(value) && value.every((v) => v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string')) {
      return value.map((v) => ({ name: String(v.name), input: (v.input ?? {}) as Record<string, unknown> }));
    }
  }
  return undefined;
}

/**
 * A ação escreve (clica, digita, navega, envia, roda script, troca de navegador)? Na dúvida, sim:
 * ferramenta nova ou entrada que não reconheço pede aprovação.
 */
export function browserActionWrites(name: string, input: unknown): boolean {
  const tool = shortName(name);
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (READ_TOOLS.has(tool)) {
    return false;
  }
  switch (tool) {
    case 'computer':
      return !READ_COMPUTER_ACTIONS.has(String(args.action));
    case 'tabs_create_mcp':
      // Aba em branco no grupo da sessão; com endereço, é navegação.
      return !!args.url;
    case 'gif_creator':
      return !/^(start|stop|clear)/.test(String(args.action ?? ''));
    case 'browser_batch': {
      const calls = batchCalls(args);
      return !calls || calls.some((c) => browserActionWrites(c.name, c.input));
    }
    default:
      return true;
  }
}

function quote(value: unknown, max = 60): string {
  const text = String(value ?? '').replace(/\s+/g, ' ');
  return `"${text.length > max ? text.slice(0, max - 1) + '…' : text}"`;
}

function target(args: Record<string, unknown>): string {
  if (args.ref) {
    return ` em ${args.ref}`;
  }
  const c = args.coordinate;
  return Array.isArray(c) && c.length === 2 ? ` em (${c[0]}, ${c[1]})` : '';
}

/** Linha legível para o log e para o pedido de aprovação: "Abrir https://...", "Clicar em ref_12", "Digitar "oi"". */
export function describeBrowserAction(name: string, input: unknown): string {
  const tool = shortName(name);
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  switch (tool) {
    case 'navigate': {
      const url = String(args.url ?? '');
      return url === 'back' ? 'Voltar à página anterior' : url === 'forward' ? 'Avançar para a próxima página' : `Abrir ${url}`;
    }
    case 'computer':
      switch (args.action) {
        case 'left_click':
          return `Clicar${target(args)}`;
        case 'double_click':
          return `Clicar duas vezes${target(args)}`;
        case 'triple_click':
          return `Clicar três vezes${target(args)}`;
        case 'right_click':
          return `Clicar com o botão direito${target(args)}`;
        case 'left_click_drag':
          return `Arrastar até${target(args).replace(/^ em/, '')}`;
        case 'hover':
          return `Passar o mouse${target(args)}`;
        case 'type':
          return `Digitar ${quote(args.text)}`;
        case 'key':
          return `Apertar ${String(args.text ?? '')}`.trim();
        case 'screenshot':
          return 'Capturar a tela';
        case 'zoom':
          return 'Ampliar uma região da tela';
        case 'scroll':
          return `Rolar a página${args.scroll_direction ? ` para ${args.scroll_direction}` : ''}`;
        case 'scroll_to':
          return `Rolar até ${args.ref ?? 'o elemento'}`;
        case 'wait':
          return `Esperar ${args.duration ?? ''}s`.replace(' s', '');
        default:
          return `Ação no navegador: ${String(args.action ?? 'computer')}`;
      }
    case 'form_input':
      return `Preencher ${args.ref ?? 'campo'} com ${quote(args.value)}`;
    case 'find':
      return `Procurar ${quote(args.query)} na página`;
    case 'read_page':
      return 'Ler a estrutura da página';
    case 'get_page_text':
      return 'Ler o texto da página';
    case 'tabs_context_mcp':
      return 'Ver as abas da sessão';
    case 'tabs_create_mcp':
      return args.url ? `Abrir nova aba em ${args.url}` : 'Abrir nova aba';
    case 'tabs_close_mcp':
      return 'Fechar aba';
    case 'javascript_tool':
      return 'Executar JavaScript na página';
    case 'read_console_messages':
      return 'Ler o console da página';
    case 'read_network_requests':
      return 'Ler as requisições de rede';
    case 'file_upload':
      return 'Enviar arquivo para a página';
    case 'upload_image':
      return 'Enviar imagem para a página';
    case 'shortcuts_list':
      return 'Listar atalhos';
    case 'shortcuts_execute':
      return 'Executar atalho';
    case 'gif_creator':
      return `Gravação em GIF: ${String(args.action ?? '')}`.trim();
    case 'resize_window':
      return args.width && args.height ? `Redimensionar a janela para ${args.width}x${args.height}` : 'Redimensionar a janela';
    case 'list_connected_browsers':
      return 'Listar navegadores conectados';
    case 'select_browser':
    case 'switch_browser':
      return 'Trocar de navegador';
    case 'browser_batch': {
      const calls = batchCalls(args);
      if (!calls) {
        return 'Sequência de ações no navegador';
      }
      const parts = calls.map((c) => describeBrowserAction(c.name, c.input));
      return `${calls.length} ações: ${parts.join('; ')}`;
    }
    default:
      return `Navegador: ${tool}`;
  }
}

/** Resposta de ferramenta que indica navegador fora do ar (Chrome fechado, extensão ausente, máquina dormindo). */
export function browserUnreachable(text: string): boolean {
  return /not connected|not set up|No browser responded|offline or asleep|extension disconnected|never delivered to the Chrome extension/i.test(text);
}
