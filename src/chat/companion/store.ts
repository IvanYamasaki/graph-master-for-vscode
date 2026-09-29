import type { Memento } from 'vscode';

/** conversa principal (sessionId) → sessão do chat lateral dela. */
const KEY = 'agentGraphMaster.companionSessions';
/** Passando disso, o par mais antigo sai: o workspaceState é compartilhado com o resto da extensão. */
const MAX_PAIRS = 40;

interface Pair {
  companion: string;
  savedAt: number;
}

/** Guarda a sessão do chat lateral junto da conversa principal: reabrir o lateral traz a mesma conversa. */
export class CompanionStore {
  constructor(private readonly memento: Memento) {}

  sessionFor(mainSessionId: string): string | undefined {
    return this.all()[mainSessionId]?.companion;
  }

  /** Conversa principal de uma sessão lateral; é o que o serializer usa ao recarregar a janela. */
  mainFor(companionSessionId: string): string | undefined {
    return Object.entries(this.all()).find(([, p]) => p.companion === companionSessionId)?.[0];
  }

  save(mainSessionId: string, companionSessionId: string): void {
    if (!mainSessionId || !companionSessionId || this.sessionFor(mainSessionId) === companionSessionId) {
      return;
    }
    const map = { ...this.all(), [mainSessionId]: { companion: companionSessionId, savedAt: Date.now() } };
    const kept = Object.entries(map)
      .sort(([, a], [, b]) => b.savedAt - a.savedAt)
      .slice(0, MAX_PAIRS);
    void this.memento.update(KEY, Object.fromEntries(kept));
  }

  private all(): Record<string, Pair> {
    return this.memento.get<Record<string, Pair>>(KEY) ?? {};
  }
}
