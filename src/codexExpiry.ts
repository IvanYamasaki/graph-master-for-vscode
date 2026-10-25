/** Leitura do auth.json do Codex sem dependência do vscode, para poder testar. */

export interface AuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: { id_token?: string; access_token?: string } | null;
  last_refresh?: string;
}

/** O Codex renova o login sozinho quando o último refresh passa de 8 dias; sem uso, o refresh token também vence. */
const REFRESH_MAX_AGE_MS = 8 * 24 * 3600 * 1000;

/**
 * Login ChatGPT vencido: id_token e access_token passaram da validade e o último refresh é antigo demais.
 * Nesse caso o e-mail do id_token é de uma sessão morta e não deve aparecer como conta conectada.
 */
export function codexSessionExpired(auth: AuthFile, now = Date.now()): boolean {
  const exp = [auth.tokens?.id_token, auth.tokens?.access_token].map((t) => jwtClaims(t)?.exp);
  if (exp.some((e) => typeof e !== 'number' || e * 1000 > now)) {
    return false;
  }
  const refreshed = auth.last_refresh ? Date.parse(auth.last_refresh) : NaN;
  return Number.isNaN(refreshed) || now - refreshed > REFRESH_MAX_AGE_MS;
}

export function jwtClaims(token: string | undefined): Record<string, unknown> | undefined {
  const payload = token?.split('.')[1];
  if (!payload) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
