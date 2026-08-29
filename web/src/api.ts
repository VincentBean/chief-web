/** Thrown when the server rejects a request; carries the HTTP status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${code} (HTTP ${status})`);
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
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string') code = body.error;
  } catch {
    // Non-JSON error body; keep the status-derived code.
  }
  throw new ApiError(response.status, code);
}

export async function login(password: string): Promise<void> {
  await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) });
}

export async function logout(): Promise<void> {
  await api('/api/auth/logout', { method: 'POST' });
}
