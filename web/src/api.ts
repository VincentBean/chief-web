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

  // 204 (e.g. DELETE) has no body to parse.
  if (response.ok) return response.status === 204 ? (undefined as T) : ((await response.json()) as T);

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
  /** Commit identity used by agents inside session containers (US-006). */
  gitAuthorName: string;
  gitAuthorEmail: string;
}

export interface SettingsUpdate {
  /** Omit to leave the stored token untouched; `null` removes it. */
  githubToken?: string | null;
  maxConcurrentSessions?: number;
  /** `null` restores the built-in default (`chief-web`/`chief-web@localhost`). */
  gitAuthorName?: string | null;
  gitAuthorEmail?: string | null;
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

/** Mirrors the server's `ClaudeAuthStatus` (US-008). */
export interface ClaudeAuthStatus {
  authenticated: boolean;
  authMethod: string | null;
  account: string | null;
  organization: string | null;
  subscription: string | null;
  checkedAt: string;
  /** Why the check could not run; `authenticated` is then always false. */
  error: string | null;
}

/** The temporary `claude auth login` container and its terminal, if running. */
export interface ClaudeLogin {
  active: boolean;
  terminalId: string | null;
  containerId: string | null;
  containerName: string;
}

export interface ClaudeState {
  status: ClaudeAuthStatus;
  login: ClaudeLogin;
}

/**
 * `refresh` skips the server's cached probe result — worth paying the extra
 * container start for right after a login, not on every page load.
 */
export async function fetchClaudeState(
  options: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<ClaudeState> {
  const path = options.refresh === true ? '/api/claude?refresh=1' : '/api/claude';
  return api<ClaudeState>(path, options.signal ? { signal: options.signal } : {});
}

/** Spawns the login container and opens the terminal running the login flow. */
export async function startClaudeLogin(): Promise<ClaudeState> {
  return api<ClaudeState>('/api/claude/login', { method: 'POST' });
}

/** Closes the login terminal, removes the container, and re-checks the status. */
export async function stopClaudeLogin(): Promise<ClaudeState> {
  return api<ClaudeState>('/api/claude/login', { method: 'DELETE' });
}

/** Mirrors the server's `RepositoryView`: the private key is never included. */
export interface Repository {
  id: string;
  name: string;
  sshUrl: string;
  githubSlug: string;
  defaultBaseBranch: string;
  /** The deploy key line to paste into GitHub; null for imported PEM keys. */
  publicKey: string | null;
  keyFingerprint: string | null;
  keySource: 'generated' | 'imported' | null;
  keyConfigured: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RepositoryInput {
  name?: string;
  sshUrl?: string;
  /** Omit to let the server derive it from the SSH URL. */
  githubSlug?: string;
  defaultBaseBranch?: string;
  /** Omit on create to have the server generate an ed25519 keypair. */
  privateKey?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  stderr: string;
}

export async function fetchRepositories(signal?: AbortSignal): Promise<Repository[]> {
  const body = await api<{ repositories: Repository[] }>(
    '/api/repositories',
    signal ? { signal } : {},
  );
  return body.repositories;
}

export async function createRepository(input: RepositoryInput): Promise<Repository> {
  return api<Repository>('/api/repositories', { method: 'POST', body: JSON.stringify(input) });
}

export async function updateRepository(id: string, input: RepositoryInput): Promise<Repository> {
  return api<Repository>(`/api/repositories/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export async function deleteRepository(id: string): Promise<void> {
  await api<void>(`/api/repositories/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Runs `git ls-remote` in a runner container; a failed remote still resolves. */
export async function testRepositoryConnection(id: string): Promise<ConnectionTestResult> {
  return api<ConnectionTestResult>(
    `/api/repositories/${encodeURIComponent(id)}/test-connection`,
    { method: 'POST' },
  );
}

/** Mirrors the server's `SessionView` (US-010). */
export interface Session {
  id: string;
  repositoryId: string;
  repositoryName: string;
  name: string;
  status: 'pending' | 'ready' | 'building' | 'failed' | 'finished';
  baseBranch: string;
  featureBranch: string;
  prTargetBranch: PrTargetBranch;
  /** UTC ISO-8601, or null when the session is unscheduled. */
  scheduledStartAt: string | null;
  queuedAt: string | null;
  containerId: string | null;
  prUrl: string | null;
  lastError: string | null;
  /** Whether `/workspace/repo` is a clone — i.e. whether setup finished. */
  cloned: boolean;
  createdAt: string;
  updatedAt: string;
}

export type PrTargetBranch = 'develop' | 'main';

export interface SessionInput {
  repositoryId: string;
  name: string;
  /** Omit to use the repository's default base branch. */
  baseBranch?: string;
  prTargetBranch: PrTargetBranch;
  /** UTC ISO-8601; omit or null for "start it by hand". */
  scheduledStartAt?: string | null;
}

/** The clone's outcome; `ok: false` is an answer, not a failed request. */
export interface SessionSetup {
  ok: boolean;
  code: string;
  message: string;
  /** git's own output, worth showing verbatim when something went wrong. */
  stderr: string;
}

export interface SessionWithSetup {
  session: Session;
  setup: SessionSetup;
}

/** The feature branch a session name will produce; mirrors the server. */
export function featureBranchFor(name: string): string {
  return `chief/${name}`;
}

export async function fetchSessions(signal?: AbortSignal): Promise<Session[]> {
  const body = await api<{ sessions: Session[] }>('/api/sessions', signal ? { signal } : {});
  return body.sessions;
}

/**
 * Creates the session and clones the repository into its container. Resolves
 * even when the clone failed — read `setup.ok`.
 */
export async function createSession(input: SessionInput): Promise<SessionWithSetup> {
  return api<SessionWithSetup>('/api/sessions', { method: 'POST', body: JSON.stringify(input) });
}

/** "Retry setup" on a pending session whose clone did not finish. */
export async function retrySessionSetup(id: string): Promise<SessionWithSetup> {
  return api<SessionWithSetup>(`/api/sessions/${encodeURIComponent(id)}/setup`, { method: 'POST' });
}

/** A container the operator can open a terminal in (US-007). */
export interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
}

/** Mirrors the server's `TerminalView`. */
export interface Terminal {
  id: string;
  container: string;
  containerName: string;
  command: string[];
  status: 'running' | 'exited';
  exitCode: number | null;
  cols: number;
  rows: number;
  clients: number;
  scrollbackBytes: number;
  createdAt: string;
  lastActivityAt: string;
}

export interface TerminalInput {
  container: string;
  /** Omit to let the server start a login shell (bash, falling back to sh). */
  command?: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
}

export async function fetchContainers(signal?: AbortSignal): Promise<Container[]> {
  const body = await api<{ containers: Container[] }>('/api/containers', signal ? { signal } : {});
  return body.containers;
}

export async function fetchTerminals(signal?: AbortSignal): Promise<Terminal[]> {
  const body = await api<{ terminals: Terminal[] }>('/api/terminals', signal ? { signal } : {});
  return body.terminals;
}

export async function createTerminal(input: TerminalInput): Promise<Terminal> {
  return api<Terminal>('/api/terminals', { method: 'POST', body: JSON.stringify(input) });
}

/** Kills the process inside the container and forgets the terminal. */
export async function closeTerminal(id: string): Promise<void> {
  await api<void>(`/api/terminals/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * WebSocket URL for a terminal's PTY. Same origin as the page, so the session
 * cookie is sent with the handshake and the gateway can authenticate it.
 */
export function terminalSocketUrl(id: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/api/terminals/${encodeURIComponent(id)}/stream`;
}
