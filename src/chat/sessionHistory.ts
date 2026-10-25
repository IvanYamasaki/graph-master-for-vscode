/**
 * Histórico do botão no topo do chat: junta as conversas de todas as contas Claude cadastradas e tira as sessões de
 * agente. Puro, sem VS Code nem disco, para testar com node.
 *
 * Por que existe: a lista pedia listSessions({ includeProgrammatic: false }), que esconde as sessões do SDK
 * (entrypoint sdk-ts). Todo chat desta extensão é sessão do SDK, então o histórico só mostrava conversas abertas
 * fora dela, e só da conta do painel, e no máximo 40. Com as do SDK incluídas, entram também as sessões dos agentes
 * roteados (também sdk-ts), que saem pela lista de sessionId gravada em .agm/sessions/<id>/agents.json.
 */

/** O que importa de SDKSessionInfo. */
export interface RawSession {
  sessionId: string;
  summary?: string;
  customTitle?: string;
  firstPrompt?: string;
  lastModified: number;
}

export interface AccountSessions {
  profileId: string;
  profileName: string;
  sessions: RawSession[];
}

export interface HistoryEntry {
  id: string;
  title: string;
  lastModified: number;
  profileId: string;
  profileName: string;
  /** A mesma conversa está em outras contas (cópia de uma troca de conta). */
  alsoIn?: string[];
}

/** Quantas conversas a lista mostra no máximo. */
export const HISTORY_MAX = 300;

function shorten(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Junta as contas, tira as sessões de agente e ordena da mais recente para a mais antiga. A mesma conversa em duas
 * contas (troca de conta copia o arquivo) aparece uma vez só, na conta em que foi mexida por último.
 */
export function mergeHistory(accounts: AccountSessions[], agentSessionIds: ReadonlySet<string>, max = HISTORY_MAX): HistoryEntry[] {
  const byId = new Map<string, HistoryEntry>();
  for (const acc of accounts) {
    for (const s of acc.sessions) {
      if (!s?.sessionId || agentSessionIds.has(s.sessionId)) {
        continue;
      }
      const entry: HistoryEntry = {
        id: s.sessionId,
        title: shorten(s.customTitle || s.summary || s.firstPrompt || s.sessionId, 80),
        lastModified: s.lastModified || 0,
        profileId: acc.profileId,
        profileName: acc.profileName,
      };
      const prev = byId.get(s.sessionId);
      if (!prev) {
        byId.set(s.sessionId, entry);
        continue;
      }
      const [winner, loser] = entry.lastModified > prev.lastModified ? [entry, prev] : [prev, entry];
      byId.set(s.sessionId, { ...winner, alsoIn: [...new Set([...(prev.alsoIn ?? []), ...(entry.alsoIn ?? []), loser.profileName])] });
    }
  }
  return [...byId.values()].sort((a, b) => b.lastModified - a.lastModified).slice(0, max);
}

/** sessionId dos agentes num agents.json (formato do AgentStore: { agents: [...] } ou lista). */
export function agentIdsFromStore(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? (raw as { agents?: unknown }).agents : undefined;
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .map((a) => (a && typeof a === 'object' ? ((a as { sessionId?: unknown }).sessionId ?? (a as { info?: { sessionId?: unknown } }).info?.sessionId) : undefined))
    .filter((id): id is string => typeof id === 'string' && !!id);
}

/** Texto que o botão "Continuar de onde parou" manda ao chat principal. */
export const CONTINUE_MAIN_TEXT = 'A aba fechou no meio do seu último turno e o trabalho parou ali. Confira o que já foi feito e continue de onde parou.';

/**
 * A conversa terminou no meio de um turno: a última coisa no transcrito é a mensagem do usuário, uma chamada de
 * ferramenta ou o resultado dela, sem a resposta final do modelo. É o que sobra quando a aba fecha com o turno rodando.
 */
export function endedMidTurn(items: { kind: string }[]): boolean {
  const last = items[items.length - 1];
  return !!last && last.kind !== 'text';
}
