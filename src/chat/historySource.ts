import { listSessions } from '@anthropic-ai/claude-agent-sdk';
import { Profile, configDirEnv, isCodex } from '../profiles';
import { SessionStore } from './sessionStore';
import { AccountSessions, HistoryEntry, agentIdsFromStore, mergeHistory } from './sessionHistory';

/**
 * Leitura do histórico em disco, compartilhada pelo dropdown do chat e pela seção "Recentes" da barra lateral.
 */

let configDirLock: Promise<unknown> = Promise.resolve();

/**
 * listSessions e getSessionMessages leem CLAUDE_CONFIG_DIR de process.env na hora da chamada. Trocamos a variável
 * só durante a chamada, uma de cada vez, para ler o histórico da conta certa. O lock é um só no processo.
 */
export function withConfigDir<T>(profile: Profile, fn: () => Promise<T>): Promise<T> {
  const run = async () => {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    const dir = configDirEnv(profile);
    if (dir) {
      process.env.CLAUDE_CONFIG_DIR = dir;
    } else {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
    try {
      return await fn();
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previous;
      }
    }
  };
  const result = configDirLock.then(run, run);
  configDirLock = result.catch(() => undefined);
  return result;
}

/**
 * Conversas do projeto em todas as contas Claude, sem as sessões de agente, da mais recente para a mais antiga.
 * Sem limite na leitura: agentes são a maioria das sessões, e o corte só vale depois de tirá-los (mergeHistory).
 * Lança erro só quando nenhuma conta pôde ser lida. `extraAgentIds` são sessões de agente ainda fora do disco.
 */
export async function readHistory(profiles: Profile[], cwd: string, extraAgentIds: Iterable<string> = [], max?: number): Promise<HistoryEntry[]> {
  const accounts: AccountSessions[] = [];
  const errors: string[] = [];
  for (const profile of profiles.filter((p) => !isCodex(p))) {
    try {
      const sessions = await withConfigDir(profile, () => listSessions({ dir: cwd }));
      accounts.push({ profileId: profile.id, profileName: profile.name, sessions });
    } catch (err) {
      errors.push(`${profile.name}: ${String(err)}`);
    }
  }
  if (!accounts.length && errors.length) {
    throw new Error(errors.join('; '));
  }
  const agentIds = SessionStore.for(cwd).agentSessionIds(agentIdsFromStore);
  for (const id of extraAgentIds) {
    agentIds.add(id);
  }
  return mergeHistory(accounts, agentIds, max);
}
