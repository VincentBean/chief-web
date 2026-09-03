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

/**
 * Models an agent can be run on, mirroring the server's `AGENT_MODELS`.
 *
 * Claude Code's own `--model` aliases, so each keeps meaning the latest model
 * of its family. The empty string is the form the `<select>` uses for "no
 * choice" and is sent as `null`.
 */
export const AGENT_MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const;

export type AgentModel = (typeof AGENT_MODELS)[number];

/** Mirrors the server's `AppSettings`: the token is masked to its last 4 chars. */
export interface Settings {
  githubToken: { configured: boolean; last4: string | null };
  maxConcurrentSessions: number;
  /** Cap on one headless agent iteration, in minutes (US-019). */
  agentTimeoutMinutes: number;
  /** How often open pull requests are re-checked against GitHub (US-004). */
  prSyncIntervalMinutes: number;
  /** How often open pull requests are scanned for merge conflicts (US-004). */
  prConflictIntervalMinutes: number;
  /** Whether the merge conflict fixer may scan and push at all (US-004). */
  conflictFixEnabled: boolean;
  /** Model the planning terminal runs on; `null` lets Claude Code choose. */
  planningModel: AgentModel | null;
  /** Model each build iteration runs on; `null` lets Claude Code choose. */
  buildModel: AgentModel | null;
  /** Model the pull request review runs on; `null` lets Claude Code choose. */
  reviewModel: AgentModel | null;
  /** Whether new sessions start with their code-review flag on (US-004). */
  codeReviewDefault: boolean;
  /** Commit identity used by agents inside session containers (US-006). */
  gitAuthorName: string;
  gitAuthorEmail: string;
}

export interface SettingsUpdate {
  /** Omit to leave the stored token untouched; `null` removes it. */
  githubToken?: string | null;
  maxConcurrentSessions?: number;
  agentTimeoutMinutes?: number;
  prSyncIntervalMinutes?: number;
  prConflictIntervalMinutes?: number;
  conflictFixEnabled?: boolean;
  /** `null` hands the choice back to Claude Code's own default. */
  planningModel?: AgentModel | null;
  buildModel?: AgentModel | null;
  reviewModel?: AgentModel | null;
  codeReviewDefault?: boolean;
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

/**
 * Mirrors `SESSION_STATUSES` on the server, which this tuple has to be kept
 * in step with by hand. `finished` means the build ended without a pull
 * request; a delivered session is `pr-open` until the sync sees its PR
 * merged, and `merged` after that.
 *
 * A tuple rather than a bare union because the session list enumerates it to
 * offer one filter option per status (US-007); the order is the lifecycle.
 */
export const SESSION_STATUSES = [
  'pending',
  'ready',
  'building',
  'waiting',
  'failed',
  'finished',
  'pr-open',
  'merged',
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Mirrors the server's `SessionView` (US-010). */
export interface Session {
  id: string;
  repositoryId: string;
  repositoryName: string;
  name: string;
  status: SessionStatus;
  baseBranch: string;
  featureBranch: string;
  prTargetBranch: PrTargetBranch;
  /** UTC ISO-8601, or null when the session is unscheduled. */
  scheduledStartAt: string | null;
  /**
   * The scheduled moment passed while the session was still pending, so
   * nothing started it. Marking it ready starts it there and then.
   */
  scheduleMissed: boolean;
  queuedAt: string | null;
  /** 1-based place in the FIFO build queue (US-018); null when not waiting. */
  queuePosition: number | null;
  containerId: string | null;
  prUrl: string | null;
  lastError: string | null;
  /** Which step a failed session failed at (US-019); null when it has not. */
  failureStage: FailureStage | null;
  /**
   * When a session held by Claude's usage limit may resume (US-003); null when
   * it is not held.
   */
  waitingUntil: string | null;
  /** Story progress for the dashboard; both 0 until the PRD has been parsed. */
  stories: { total: number; done: number };
  /** Whether `/workspace/repo` is a clone — i.e. whether setup finished. */
  cloned: boolean;
  /** Whether the pull request this session opens is reviewed automatically. */
  codeReview: boolean;
  createdAt: string;
  updatedAt: string;
}

export type PrTargetBranch = 'develop' | 'main';

/** Mirrors the server's `FailureStage` (US-019): where a session failed. */
export type FailureStage = 'agent' | 'prd' | 'push' | 'pull_request' | 'review' | 'container_lost';

/** What each stage is called on screen. */
export function failureStageLabel(stage: FailureStage): string {
  switch (stage) {
    case 'agent':
      return 'the agent';
    case 'prd':
      return 'the PRD';
    case 'push':
      return 'the push';
    case 'pull_request':
      return 'the pull request';
    case 'review':
      return 'the code review';
    case 'container_lost':
      return 'the container';
  }
}

/**
 * Mirrors the server's `isDeliveryStage`: the stages after the build, whose
 * retry re-runs delivery from the step that failed and never a story.
 */
export function isDeliveryStage(stage: FailureStage | null): boolean {
  return stage === 'push' || stage === 'pull_request' || stage === 'review';
}

export interface SessionInput {
  repositoryId: string;
  name: string;
  /** Omit to use the repository's default base branch. */
  baseBranch?: string;
  prTargetBranch: PrTargetBranch;
  /** UTC ISO-8601; omit or null for "start it by hand". */
  scheduledStartAt?: string | null;
  /** Omit to fall back to the global "code review by default" setting. */
  codeReview?: boolean;
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

/**
 * Deletes the session, its container and its workspace (US-015). The feature
 * branch on the remote and its pull request are deliberately left alone.
 */
export async function deleteSession(id: string): Promise<void> {
  await api<void>(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
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

/** A problem the PRD parser found; `line` is 1-based, or 0 for the whole file. */
export interface PrdParseError {
  line: number;
  message: string;
}

/** Mirrors the server's `PrdStatus` (US-011): the state of `prd.md` on disk. */
export interface PrdStatus {
  /** Path relative to the repository root. */
  path: string;
  exists: boolean;
  /** True only when the file exists and has no parse errors. */
  parses: boolean;
  storyCount: number;
  errors: PrdParseError[];
  updatedAt: string | null;
  bytes: number;
}

export type PlanningMode = 'create' | 'edit';

/** Mirrors the server's `PlanningView` (US-011). */
export interface Planning {
  sessionId: string;
  sessionName: string;
  status: Session['status'];
  /** Terminal to attach to, or null when planning has never been started. */
  terminalId: string | null;
  running: boolean;
  exitCode: number | null;
  /** Which prompt the current (or last) terminal was started with. */
  mode: PlanningMode | null;
  /** Which prompt starting one now would use: `edit` once a PRD exists. */
  nextMode: PlanningMode;
  cwd: string;
  prd: PrdStatus;
}

export async function fetchSession(id: string, signal?: AbortSignal): Promise<Session> {
  return api<Session>(`/api/sessions/${encodeURIComponent(id)}`, signal ? { signal } : {});
}

/** Polled by the session page: it is a file stat plus a parse, never a Docker call. */
export async function fetchPlanning(id: string, signal?: AbortSignal): Promise<Planning> {
  return api<Planning>(`/api/sessions/${encodeURIComponent(id)}/planning`, signal ? { signal } : {});
}

/**
 * Starts the interactive `claude` that writes the PRD. `context` fills chief's
 * `{{CONTEXT}}` slot and is only used when no `prd.md` exists yet — otherwise
 * the server starts chief's edit prompt instead.
 */
export async function startPlanning(id: string, context?: string): Promise<Planning> {
  return api<Planning>(`/api/sessions/${encodeURIComponent(id)}/planning`, {
    method: 'POST',
    body: JSON.stringify(context === undefined || context === '' ? {} : { context }),
  });
}

/** Ends the conversation and kills the process. */
export async function stopPlanning(id: string): Promise<Planning> {
  return api<Planning>(`/api/sessions/${encodeURIComponent(id)}/planning`, { method: 'DELETE' });
}

/** One row of the `stories` table: a story from the PRD, as parsed (US-012). */
export interface Story {
  /** Surrogate row id; the PRD identifier is `storyId`. */
  id: number;
  sessionId: string;
  /** Identifier from the PRD, e.g. `US-001`. */
  storyId: string;
  title: string;
  priority: number;
  status: 'todo' | 'in-progress' | 'done';
  commitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Mirrors the server's `ReadyResult` (US-012). A PRD that does not parse comes
 * back with `ok: false` and the line-numbered errors in `prd.errors` — a result
 * to show, not a failed request.
 */
export interface Readiness {
  ok: boolean;
  /** True when a missed schedule was honoured as part of this call (US-017). */
  started: boolean;
  session: Session;
  prd: PrdStatus;
  stories: Story[];
}

export async function fetchStories(id: string, signal?: AbortSignal): Promise<Story[]> {
  const body = await api<{ stories: Story[] }>(
    `/api/sessions/${encodeURIComponent(id)}/stories`,
    signal ? { signal } : {},
  );
  return body.stories;
}

/** "Mark ready": parses `prd.md` and, if it is usable, syncs and promotes. */
export async function markSessionReady(id: string): Promise<Readiness> {
  return api<Readiness>(`/api/sessions/${encodeURIComponent(id)}/ready`, { method: 'POST' });
}

/**
 * Sets, changes or clears the scheduled start (US-017). Allowed while the
 * session is pending or ready; `null` removes the schedule.
 */
export async function setSessionSchedule(
  id: string,
  scheduledStartAt: string | null,
): Promise<Session> {
  return api<Session>(`/api/sessions/${encodeURIComponent(id)}/schedule`, {
    method: 'PUT',
    body: JSON.stringify({ scheduledStartAt }),
  });
}

/**
 * Turns the automatic code review of this session's pull request on or off
 * (US-005). Allowed until the session is finished, after which the review has
 * either run or missed its chance.
 */
export async function setSessionCodeReview(id: string, codeReview: boolean): Promise<Session> {
  return api<Session>(`/api/sessions/${encodeURIComponent(id)}/code-review`, {
    method: 'PUT',
    body: JSON.stringify({ codeReview }),
  });
}

/** "Back to planning": returns a ready session to pending so the PRD can change. */
export async function backToPlanning(id: string): Promise<Readiness> {
  return api<Readiness>(`/api/sessions/${encodeURIComponent(id)}/ready`, { method: 'DELETE' });
}

/** Mirrors the server's `BuildView` (US-013): the state of the Ralph loop. */
export interface Build {
  sessionId: string;
  sessionName: string;
  status: Session['status'];
  /** True while the server is driving a loop for this session. */
  running: boolean;
  /** Iterations started in the current run; 0 when none is running. */
  iteration: number;
  /** The dynamic cap the run aborts at: remaining stories + 50%, min 10. */
  maxIterations: number;
  /** The story the current iteration is implementing. */
  currentStoryId: string | null;
  /** Consecutive fruitless iterations on that story; 2 retries are allowed. */
  attempts: number;
  stories: Story[];
  prd: PrdStatus;
  lastError: string | null;
  /** Which step a failed session failed at (US-019). */
  failureStage: FailureStage | null;
  /** The per-iteration agent timeout in force, in milliseconds (US-019). */
  agentTimeoutMs: number;
  startedAt: string | null;
  /** Waiting for a build slot: ready, in the queue, nothing spawned yet. */
  queued: boolean;
  /** Its 1-based place in that queue — shown as "Queued (#2)" — or null. */
  queuePosition: number | null;
  /** Sessions building right now, across the whole server. */
  activeBuilds: number;
  /** The cap they are counted against, from the settings page. */
  maxConcurrentBuilds: number;
}

/** Polled by the session page while a build runs; a file read plus a map lookup. */
export async function fetchBuild(id: string, signal?: AbortSignal): Promise<Build> {
  return api<Build>(`/api/sessions/${encodeURIComponent(id)}/build`, signal ? { signal } : {});
}

/** "Start build": promotes a ready session to `building` and starts the loop. */
export async function startBuild(id: string): Promise<Build> {
  return api<Build>(`/api/sessions/${encodeURIComponent(id)}/build`, { method: 'POST' });
}

/** "Stop build": signals the agent and returns the session to `ready`. */
export async function stopBuild(id: string): Promise<Build> {
  return api<Build>(`/api/sessions/${encodeURIComponent(id)}/build`, { method: 'DELETE' });
}

/**
 * "Resume now": lifts Claude's usage-limit hold before its hour is up and puts
 * every held session back to work (US-008), not only the one being looked at —
 * the hold is on the account, so there is nothing narrower to lift. Answers
 * with how many sessions were actually started; the rest are on the queue.
 */
export async function clearUsageLimitHold(): Promise<{ resumed: number }> {
  return api<{ ok: true; resumed: number }>('/api/limits/hold/clear', { method: 'POST' });
}

/** The global usage-limit hold, if one is in force (US-002). */
export async function fetchHold(signal?: AbortSignal): Promise<{ until: string | null }> {
  return api<{ until: string | null }>('/api/limits/hold', signal ? { signal } : {});
}

/* -------------------------------------------------------------------- stats */

/** One calendar day (UTC) of activity, from the server's `DayActivity`. */
export interface DayActivity {
  /** `YYYY-MM-DD`. */
  day: string;
  storiesDone: number;
  sessionsFinished: number;
  sessionsCreated: number;
}

export interface RepositoryStats {
  repositoryId: string;
  name: string;
  sessions: number;
  storiesDone: number;
  storiesTotal: number;
  finished: number;
  failed: number;
  active: number;
}

/** Mirrors the server's `StatsView`: everything the overview page shows. */
export interface Stats {
  generatedAt: string;
  sessions: { total: number; byStatus: Record<Session['status'], number> };
  stories: { total: number; done: number; inProgress: number; todo: number };
  prRuns: { total: number; running: number; finished: number; failed: number };
  pullRequestsOpened: number;
  builds: { active: number; queued: number; max: number };
  hold: { until: string | null };
  /** Oldest first. */
  activity: DayActivity[];
  repositories: RepositoryStats[];
}

/** Polled by the overview and the app shell; aggregates over the database only. */
export async function fetchStats(signal?: AbortSignal, days = 14): Promise<Stats> {
  return api<Stats>(`/api/stats?days=${String(days)}`, signal ? { signal } : {});
}

/**
 * "Leave queue": takes a waiting session back to plain `ready` (US-018).
 * Nothing was spawned for it, so there is nothing to unwind.
 */
export async function leaveQueue(id: string): Promise<Build> {
  return api<Build>(`/api/sessions/${encodeURIComponent(id)}/queue`, { method: 'DELETE' });
}

/** One iteration's section of the build log (US-016). */
export interface BuildLogIteration {
  iteration: number;
  storyId: string | null;
  startedAt: string;
  /** `null` while the iteration is still running. */
  endedAt: string | null;
  exitCode: number | null;
  text: string;
}

/** Everything the server had when the socket attached. */
export interface BuildLogHistory {
  /** Where the file lives in the clone, as the UI names it. */
  path: string;
  iterations: BuildLogIteration[];
  /** True when older output was dropped because the file is long. */
  truncated: boolean;
}

/** What the server reports as the log grows. */
export type BuildLogEvent =
  | { type: 'begin'; iteration: number; storyId: string | null; startedAt: string }
  | { type: 'append'; text: string }
  | { type: 'end'; exitCode: number | null; endedAt: string };

/** Mirrors the server's `BuildLogMessage`: replay first, then live events. */
export type BuildLogMessage = { type: 'attached'; history: BuildLogHistory } | BuildLogEvent;

/**
 * WebSocket URL for a session's build log. Same origin as the page, so the
 * session cookie rides along with the handshake (see {@link terminalSocketUrl}).
 */
export function buildLogSocketUrl(id: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/api/sessions/${encodeURIComponent(id)}/build/log`;
}

/**
 * Mirrors the server's `DeliveryResult` (US-014): the outcome of pushing the
 * feature branch and opening the pull request.
 */
export interface Delivery {
  ok: boolean;
  sessionId: string;
  status: Session['status'];
  prUrl: string | null;
  /** True when an open pull request already existed and was adopted. */
  adopted: boolean;
  code: string;
  message: string;
  /** git's output when the push is what failed; empty otherwise. */
  stderr: string;
}

/**
 * "Retry push & PR": re-attempts only the delivery of a session whose stories
 * are all done. Nothing is rebuilt, and no story is run again.
 */
export async function retryDelivery(id: string): Promise<Delivery> {
  return api<Delivery>(`/api/sessions/${encodeURIComponent(id)}/delivery`, { method: 'POST' });
}

/**
 * Mirrors the server's `RetryPlan` (US-019): what "Retry" would do to a failed
 * session, so the button can say so before it is pressed.
 */
export interface RetryPlan {
  action: 'build' | 'delivery';
  stage: FailureStage | null;
  reason: string;
}

/** Mirrors the server's `RetryResult`: the plan, plus whichever view it ran. */
export interface Retry extends RetryPlan {
  ok: boolean;
  sessionId: string;
  status: Session['status'];
  prUrl: string | null;
  message: string;
  build: Build | null;
  delivery: Delivery | null;
}

/**
 * "Retry" on a failed session. The server picks the resumption point from the
 * stage the session failed at: the loop starts again at the first story that is
 * not done, or the push and pull request re-run on their own. Neither redoes
 * work that is already committed.
 */
export async function retrySession(id: string): Promise<Retry> {
  return api<Retry>(`/api/sessions/${encodeURIComponent(id)}/retry`, { method: 'POST' });
}

/** The session detail page, which is where planning happens. */
export function sessionPath(id: string): string {
  return `/sessions/${encodeURIComponent(id)}`;
}

/* ------------------------------------------------------------ pull requests */

/** Mirrors the server's `PullRequestView`: one open pull request. */
export interface PullRequest {
  number: number;
  title: string;
  /** The `html_url`, for the "GitHub" link. */
  url: string;
  headRef: string;
  baseRef: string;
  draft: boolean;
  /**
   * The head branch lives on another repository. chief-web pushes with this
   * repository's deploy key, which cannot write there, so a fork cannot be
   * processed (US-021).
   */
  fromFork: boolean;
  authorLogin: string | null;
  updatedAt: string;
  /** The session that opened it, when chief-web did; null otherwise. */
  sessionId: string | null;
  /** The last feedback run against it, when there has been one. */
  run: PrRun | null;
  /** The last code review started on it by hand, when there has been one. */
  review: PrReview | null;
}

/**
 * One repository's answer. Grouped rather than flat because each group is one
 * GitHub call: a repository whose call failed carries its own error and the
 * rest of the page still renders.
 */
export interface RepositoryPullRequests {
  repositoryId: string;
  repositoryName: string;
  githubSlug: string;
  pullRequests: PullRequest[];
  error: string | null;
  message: string | null;
  /** More pages existed than were read; this is not all of them. */
  truncated: boolean;
}

export interface PullRequestList {
  repositories: RepositoryPullRequests[];
  /** When GitHub was actually asked; a cached answer keeps its original time. */
  fetchedAt: string;
}

/**
 * Every open pull request across the configured repositories.
 *
 * Slow and rate limited — one GitHub call per repository — so this is never
 * polled: the page loads it once, refreshes on demand, and revalidates when the
 * tab becomes visible again.
 */
export async function fetchPullRequests(
  options: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<PullRequestList> {
  const path = options.refresh === true ? '/api/pull-requests?refresh=1' : '/api/pull-requests';
  return api<PullRequestList>(path, options.signal ? { signal: options.signal } : {});
}

/** One comment on a review thread. */
export interface ReviewComment {
  /** REST id; the only comment a reply may target is the thread's first. */
  databaseId: number | null;
  authorLogin: string | null;
  /** `User`, `Bot`… Shown, never filtered on — bot reviews are the point. */
  authorType: string | null;
  body: string;
  url: string;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  /** Its lines have changed since it was written. */
  isOutdated: boolean;
  viewerCanReply: boolean;
  viewerCanResolve: boolean;
  path: string | null;
  line: number | null;
  comments: ReviewComment[];
}

/** The body of an approve / request-changes / comment review. */
export interface ReviewSummary {
  id: string;
  authorLogin: string | null;
  authorType: string | null;
  state: string;
  body: string;
  url: string;
  submittedAt: string | null;
}

/** Mirrors the server's `PullRequestFeedback`: what a run would be sent. */
export interface PullRequestFeedback {
  slug: string;
  number: number;
  title: string;
  url: string;
  state: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  fromFork: boolean;
  threads: ReviewThread[];
  reviews: ReviewSummary[];
  truncated: boolean;
}

/** Read only when a row is expanded: one GraphQL call per pull request. */
export async function fetchPullRequestFeedback(
  repositoryId: string,
  number: number,
  signal?: AbortSignal,
): Promise<PullRequestFeedback> {
  return api<PullRequestFeedback>(
    `/api/pull-requests/${encodeURIComponent(repositoryId)}/${String(number)}/feedback`,
    signal ? { signal } : {},
  );
}

/** Stable key for a pull request in React lists and per-row state. */
export function pullRequestKey(repositoryId: string, number: number): string {
  return `${repositoryId}#${String(number)}`;
}

/** Where a live feedback run is; null once it is over. */
export type PrRunPhase =
  | 'starting'
  | 'fetching-feedback'
  | 'checking-out'
  | 'running-agent'
  | 'pushing'
  | 'replying';

export type PrRunStatus = 'pending' | 'running' | 'finished' | 'failed';

export type PrFailureStage =
  | 'feedback'
  | 'checkout'
  | 'agent'
  | 'outcome'
  | 'push'
  | 'reply'
  | 'container_lost';

export interface PrThread {
  threadId: string;
  key: string;
  kind: 'thread' | 'review';
  outcome: 'addressed' | 'skipped' | 'unreported' | null;
  summary: string | null;
  replied: boolean;
  replyUrl: string | null;
  resolved: boolean;
  error: string | null;
}

/** Mirrors the server's `PrRunView`: one pass over a pull request's feedback. */
export interface PrRun {
  id: string;
  repositoryId: string;
  prNumber: number;
  prUrl: string;
  prTitle: string;
  headBranch: string;
  status: PrRunStatus;
  /** True while the server is driving it right now. */
  running: boolean;
  phase: PrRunPhase | null;
  /** Passes made so far; quoted in the reply footer. */
  attempt: number;
  failureStage: PrFailureStage | null;
  lastError: string | null;
  /** The commit the last successful push delivered. */
  headSha: string | null;
  threads: PrThread[];
  startedAt: string | null;
  finishedAt: string | null;
}

/** What the operator is told each phase means, while it is happening. */
export function prPhaseLabel(phase: PrRunPhase): string {
  switch (phase) {
    case 'starting':
      return 'starting';
    case 'fetching-feedback':
      return 'reading comments';
    case 'checking-out':
      return 'checking out';
    case 'running-agent':
      return 'agent running';
    case 'pushing':
      return 'pushing';
    case 'replying':
      return 'answering on GitHub';
  }
}

/** What the UI calls a failure stage. */
export function prFailureStageLabel(stage: PrFailureStage): string {
  switch (stage) {
    case 'feedback':
      return 'reading the comments';
    case 'checkout':
      return 'the checkout';
    case 'agent':
      return 'the agent';
    case 'outcome':
      return 'the agent’s report';
    case 'push':
      return 'the push';
    case 'reply':
      return 'answering on GitHub';
    case 'container_lost':
      return 'the container';
  }
}

/**
 * "Process feedback comments".
 *
 * Pushes to the pull request's own branch and writes replies on GitHub under
 * the token's account, so this is only ever called from the confirmation.
 */
export async function startPrRun(repositoryId: string, number: number): Promise<PrRun> {
  return api<PrRun>(
    `/api/pull-requests/${encodeURIComponent(repositoryId)}/${String(number)}/run`,
    { method: 'POST' },
  );
}

export async function fetchPrRun(runId: string, signal?: AbortSignal): Promise<PrRun> {
  return api<PrRun>(`/api/pull-requests/runs/${encodeURIComponent(runId)}`, signal ? { signal } : {});
}

/** Signals the agent; anything already committed and pushed is kept. */
export async function stopPrRun(runId: string): Promise<PrRun> {
  return api<PrRun>(`/api/pull-requests/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' });
}

/* ------------------------------------------------------------ pr reviews */

/** Where a live review is; null once it is over. */
export type PrReviewPhase = 'starting' | 'checking-out' | 'reviewing' | 'publishing';

export type PrReviewFailureStage = 'checkout' | 'agent' | 'findings' | 'publish' | 'container_lost';

/** Mirrors the server's `PrReviewView`: one code review of a pull request. */
export interface PrReview {
  id: string;
  repositoryId: string;
  prNumber: number;
  prUrl: string;
  prTitle: string;
  headBranch: string;
  baseBranch: string;
  status: PrRunStatus;
  /** True while the server is driving it right now. */
  running: boolean;
  phase: PrReviewPhase | null;
  /** How many times the review has been started by hand. */
  attempt: number;
  /** Which of the three passes of this start is running; null once over. */
  pass: number | null;
  failureStage: PrReviewFailureStage | null;
  lastError: string | null;
  /** The commit the review was read at. */
  headSha: string | null;
  /** The posted review on GitHub; null until a pass has posted one. */
  reviewUrl: string | null;
  inlineComments: number | null;
  foldedFindings: number | null;
  /** What became of the hand-off to the feedback run, when there was one. */
  solverMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export function prReviewPhaseLabel(phase: PrReviewPhase): string {
  switch (phase) {
    case 'starting':
      return 'starting';
    case 'checking-out':
      return 'checking out';
    case 'reviewing':
      return 'reviewing';
    case 'publishing':
      return 'posting review';
  }
}

export function prReviewFailureStageLabel(stage: PrReviewFailureStage): string {
  switch (stage) {
    case 'checkout':
      return 'the checkout';
    case 'agent':
      return 'the agent';
    case 'findings':
      return 'the agent’s findings';
    case 'publish':
      return 'posting to GitHub';
    case 'container_lost':
      return 'the container';
  }
}

/**
 * "Review": posts one review on the pull request under the token's account,
 * so this is only ever called from the confirmation.
 */
export async function startPrReview(repositoryId: string, number: number): Promise<PrReview> {
  return api<PrReview>(
    `/api/pull-requests/${encodeURIComponent(repositoryId)}/${String(number)}/review`,
    { method: 'POST' },
  );
}

export async function fetchPrReview(reviewId: string, signal?: AbortSignal): Promise<PrReview> {
  return api<PrReview>(
    `/api/pull-requests/reviews/${encodeURIComponent(reviewId)}`,
    signal ? { signal } : {},
  );
}

/** Signals the review agent; nothing is posted for a stopped review. */
export async function stopPrReview(reviewId: string): Promise<PrReview> {
  return api<PrReview>(`/api/pull-requests/reviews/${encodeURIComponent(reviewId)}`, {
    method: 'DELETE',
  });
}
