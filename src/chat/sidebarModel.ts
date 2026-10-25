/**
 * Texto da seção "Chat" da barra lateral. Puro, sem VS Code, para testar com node.
 */

export const RECENT_MAX = 15;

/** "agora", "há 5 min", "há 2 h", "há 3 d", "há 2 sem" ou "há 4 meses". */
export function ago(at: number, now = Date.now()): string {
  const sec = Math.max(0, Math.round((now - at) / 1000));
  if (sec < 60) {
    return 'agora';
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return `há ${min} min`;
  }
  const h = Math.floor(min / 60);
  if (h < 24) {
    return `há ${h} h`;
  }
  const d = Math.floor(h / 24);
  if (d < 14) {
    return `há ${d} d`;
  }
  if (d < 60) {
    return `há ${Math.floor(d / 7)} sem`;
  }
  const m = Math.floor(d / 30);
  return `há ${m} ${m === 1 ? 'mês' : 'meses'}`;
}

export interface RecentInput {
  id: string;
  title: string;
  lastModified: number;
  profileId: string;
  profileName: string;
}

export interface RecentRow {
  id: string;
  label: string;
  description: string;
  profileId: string;
}

/** Até RECENT_MAX conversas, com a conta e o tempo na description. */
export function recentRows(entries: RecentInput[], now = Date.now(), max = RECENT_MAX): RecentRow[] {
  return entries.slice(0, max).map((e) => ({
    id: e.id,
    label: e.title,
    description: `${e.profileName} · ${ago(e.lastModified, now)}`,
    profileId: e.profileId,
  }));
}
