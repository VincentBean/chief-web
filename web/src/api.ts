/** Thrown when the server rejects a request; carries the HTTP status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** Human-readable explanation from the server, when it sent one. */
    readonly detail: string | null = null,
  ) {
    super(detail ?? `${code} (HTTP ${status})`);
    this.name = 'ApiError';
  }
}

/**
 * `fetch` wrapper that speaks the server's JSON error shape and turns an
 * expired session into a redirect back to the login page.
 */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
  });

  if (response.ok) return (await response.json()) as T;

  let code = `http_${response.status}`;
  let detail: string | null = null;
  try {
    const body = (await response.json()) as { error?: unknown; message?: unknown };
    if (typeof body.error === 'string') code = body.error;
    if (typeof body.message === 'string') detail = body.message;
  } catch {
    // Non-JSON error body; keep the status-derived code.
  }
  throw new ApiError(response.status, code, detail);
}

export async function login(password: string): Promise<void> {
  await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) });
}

export async function logout(): Promise<void> {
  await api('/api/auth/logout', { method: 'POST' });
}

/** Mirrors the server's `AppSettings`: the token is masked to its last 4 chars. */
export interface Settings {
  githubToken: { configured: boolean; last4: string | null };
  maxConcurrentSessions: number;
}

export interface SettingsUpdate {
  /** Omit to leave the stored token untouched; `null` removes it. */
  githubToken?: string | null;
  maxConcurrentSessions?: number;
}

export async function fetchSettings(signal?: AbortSignal): Promise<Settings> {
  return api<Settings>('/api/settings', signal ? { signal } : {});
}

export async function saveSettings(update: SettingsUpdate): Promise<Settings> {
  return api<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(update) });
}

/**
 * Checks a token against `GET /user`. Pass the freshly typed token to validate
 * before saving; omit it to validate the one already stored.
 */
export async function validateGithubToken(token?: string): Promise<{ login: string }> {
  return api<{ login: string }>('/api/settings/github/validate', {
    method: 'POST',
    body: JSON.stringify(token === undefined ? {} : { token }),
  });
}
