import path from 'node:path';

import { graphqlUrlFor } from './lib/github-review.js';

/**
 * Runtime configuration, resolved once from the environment.
 *
 * Every value has a default that works both inside the Docker image (where the
 * data volume is mounted at `/data`) and for local development (where the paths
 * fall back to `./.data` next to the repo).
 */
export interface Config {
  /** Port the HTTP server listens on inside the container. */
  readonly port: number;
  /** Interface the HTTP server binds to. */
  readonly host: string;
  /** Root of the application data volume (SQLite DB, SSH keys, workspaces). */
  readonly dataDir: string;
  /** Directory holding the SQLite database file. */
  readonly databasePath: string;
  /** Directory holding generated SSH deploy keys. */
  readonly sshKeysDir: string;
  /** Directory holding per-session repository clones. */
  readonly workspacesDir: string;
  /**
   * Name of the Docker volume backing {@link dataDir}. Empty outside Docker,
   * where the data directory is already a host path. Inside Docker it is the
   * only way to hand a session container a subdirectory of the data volume:
   * bind sources are resolved on the host, so the path must be translated to
   * the volume's host mountpoint first.
   */
  readonly dataVolume: string;
  /** Mount point of the shared `claude-auth` volume with agent credentials. */
  readonly claudeAuthDir: string;
  /**
   * Name of the Docker volume holding those credentials, mounted into every
   * container the server spawns. Empty outside Docker, where
   * {@link claudeAuthDir} is a real host path and can be bind-mounted instead.
   */
  readonly claudeAuthVolume: string;
  /** Cap on how long the `claude auth status` probe container may take. */
  readonly claudeProbeTimeoutMs: number;
  /** How long a probe result is reused before another container is spawned. */
  readonly claudeStatusCacheMs: number;
  /** Docker socket used to spawn session containers. */
  readonly dockerSocket: string;
  /** Docker CLI binary used to spawn short-lived helper containers. */
  readonly dockerBin: string;
  /** Image sessions and one-off helper containers run (built by US-006). */
  readonly runnerImage: string;
  /** Grace period a session container gets to exit before it is killed. */
  readonly sessionStopTimeoutSeconds: number;
  /** Cap on each git command of a session's clone/branch setup (US-010). */
  readonly sessionSetupTimeoutMs: number;
  /**
   * Default cap on one headless agent iteration of the build loop (US-013).
   * Only the default: the settings page stores the value the loop actually
   * uses, in minutes (US-019).
   */
  readonly buildIterationTimeoutMs: number;
  /** How long "Stop build" waits for the loop to unwind before answering. */
  readonly buildStopTimeoutMs: number;
  /** Cap on one `git push` of the session's feature branch (US-014). */
  readonly pushTimeoutMs: number;
  /**
   * How often the scheduler looks for a `ready` session whose scheduled start
   * has passed (US-017). Capped at 30 s, which is the promise the UI makes.
   */
  readonly schedulerIntervalMs: number;
  /**
   * How often the pull request sync asks GitHub what became of each
   * `pr-open` session's pull request (US-003). One request per `pr-open`
   * session per tick, so the default of 15 minutes costs 4 requests per hour
   * per open pull request — under 1% of the 5000/hour token budget even with
   * 10 of them, which is why polling this at all is affordable.
   */
  readonly prSyncIntervalMs: number;
  /**
   * How often the conflict fixer scans every connected repository's open pull
   * requests for merge conflicts (US-003). One list request per repository per
   * tick plus one detail request per `chief/` candidate, so the default of 30
   * minutes costs ~22 requests/hour with ten candidates — the same order as the
   * pull request sync. US-004 turns this into a settings-page dial; until then
   * the environment variable is the only override.
   */
  readonly prConflictIntervalMs: number;
  /** Cap on how long a repository "test connection" run may take. */
  readonly connectionTestTimeoutMs: number;
  /** Lines of terminal output replayed to a browser that (re)attaches. */
  readonly terminalScrollbackLines: number;
  /** Hard byte ceiling on that per-terminal replay buffer. */
  readonly terminalScrollbackBytes: number;
  /** Cap on simultaneously open browser terminals. */
  readonly maxTerminals: number;
  /** Shared password protecting the UI (see US-003); empty when unset. */
  readonly password: string;
  /** Failed sign-in attempts one client may make within the window below. */
  readonly loginAttemptLimit: number;
  /** Sliding window those failed sign-in attempts are counted over. */
  readonly loginAttemptWindowMs: number;
  /** Default max number of sessions building at the same time (see US-018). */
  readonly maxConcurrentSessions: number;
  /** Base URL of the GitHub REST API; overridable for self-hosted GitHub. */
  readonly githubApiUrl: string;
  /**
   * Base URL of the GitHub GraphQL API (US-021). Derived from
   * {@link githubApiUrl} unless set, which is only needed for an install whose
   * GraphQL endpoint is not where the REST base implies.
   */
  readonly githubGraphqlUrl: string;
  /**
   * How long a listing of open pull requests is reused before GitHub is asked
   * again. Listing is one request per repository against a 5000/hour budget,
   * so a page left open — or reloaded a few times — must not spend it.
   */
  readonly pullRequestCacheMs: number;
  /**
   * Where this chief-web is reachable, e.g. `https://chief.example.com`. Only
   * used to link a generated pull request back to its session; empty when the
   * operator has not said, in which case the link-back is plain text.
   */
  readonly publicUrl: string;
  /** Directory containing the built frontend assets. */
  readonly webRoot: string;
  readonly nodeEnv: string;
}

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const str = (name: string, fallback: string): string => {
    const value = env[name];
    return value === undefined || value === '' ? fallback : value;
  };

  const int = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number.parseInt(raw, 10);
    if (!Number.isInteger(value)) {
      throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
    }
    return value;
  };

  const dataDir = path.resolve(str('DATA_DIR', path.join(REPO_ROOT, '.data')));
  const port = int('PORT', 8080);
  if (port < 1 || port > 65535) {
    throw new Error(`Environment variable PORT must be between 1 and 65535, got "${port}"`);
  }

  // The upper bound is the story's own guarantee ("at least every 30 seconds"),
  // so an operator cannot configure the scheduler into breaking it.
  const schedulerIntervalMs = int('SCHEDULER_INTERVAL_MS', 30_000);
  if (schedulerIntervalMs < 1_000 || schedulerIntervalMs > 30_000) {
    throw new Error(
      `Environment variable SCHEDULER_INTERVAL_MS must be between 1000 and 30000, got "${schedulerIntervalMs}"`,
    );
  }

  // A minute is the floor the settings field will offer (US-004): below that
  // the sync stops being a background job and starts being a way to spend the
  // hour's rate limit on a handful of sessions.
  const prSyncIntervalMs = int('PR_SYNC_INTERVAL_MS', 900_000);
  if (prSyncIntervalMs < 60_000) {
    throw new Error(
      `Environment variable PR_SYNC_INTERVAL_MS must be at least 60000, got "${String(prSyncIntervalMs)}"`,
    );
  }

  // The same floor, for the same reason: below a minute the scan stops being a
  // background job and starts being a way to spend the hour's rate limit on a
  // handful of pull requests.
  const prConflictIntervalMs = int('PR_CONFLICT_INTERVAL_MS', 1_800_000);
  if (prConflictIntervalMs < 60_000) {
    throw new Error(
      `Environment variable PR_CONFLICT_INTERVAL_MS must be at least 60000, got "${String(prConflictIntervalMs)}"`,
    );
  }

  // The login throttle is the only thing standing between an unauthenticated
  // caller and unlimited password guessing, so it cannot be configured away:
  // zero attempts would lock the operator out, and a zero-length window would
  // be no limit at all.
  const loginAttemptLimit = int('LOGIN_ATTEMPT_LIMIT', 5);
  if (loginAttemptLimit < 1) {
    throw new Error(
      `Environment variable LOGIN_ATTEMPT_LIMIT must be at least 1, got "${loginAttemptLimit}"`,
    );
  }

  const loginAttemptWindowMs = int('LOGIN_ATTEMPT_WINDOW_MS', 900_000);
  if (loginAttemptWindowMs < 1_000) {
    throw new Error(
      `Environment variable LOGIN_ATTEMPT_WINDOW_MS must be at least 1000, got "${loginAttemptWindowMs}"`,
    );
  }

  return {
    port,
    host: str('HOST', '0.0.0.0'),
    dataDir,
    databasePath: path.resolve(str('DATABASE_PATH', path.join(dataDir, 'chief-web.db'))),
    sshKeysDir: path.resolve(str('SSH_KEYS_DIR', path.join(dataDir, 'ssh-keys'))),
    workspacesDir: path.resolve(str('WORKSPACES_DIR', path.join(dataDir, 'workspaces'))),
    dataVolume: str('CHIEF_DATA_VOLUME', ''),
    claudeAuthDir: path.resolve(str('CLAUDE_AUTH_DIR', path.join(dataDir, 'claude-auth'))),
    claudeAuthVolume: str('CLAUDE_AUTH_VOLUME', ''),
    claudeProbeTimeoutMs: int('CLAUDE_PROBE_TIMEOUT_MS', 30_000),
    claudeStatusCacheMs: int('CLAUDE_STATUS_CACHE_MS', 15_000),
    dockerSocket: str('DOCKER_SOCKET', '/var/run/docker.sock'),
    dockerBin: str('DOCKER_BIN', 'docker'),
    runnerImage: str('RUNNER_IMAGE', 'chief-web-runner:latest'),
    sessionStopTimeoutSeconds: int('SESSION_STOP_TIMEOUT_SECONDS', 10),
    sessionSetupTimeoutMs: int('SESSION_SETUP_TIMEOUT_MS', 600_000),
    buildIterationTimeoutMs: int('BUILD_ITERATION_TIMEOUT_MS', 1_800_000),
    buildStopTimeoutMs: int('BUILD_STOP_TIMEOUT_MS', 60_000),
    pushTimeoutMs: int('PUSH_TIMEOUT_MS', 300_000),
    schedulerIntervalMs,
    prSyncIntervalMs,
    prConflictIntervalMs,
    connectionTestTimeoutMs: int('CONNECTION_TEST_TIMEOUT_MS', 60_000),
    terminalScrollbackLines: int('TERMINAL_SCROLLBACK_LINES', 2000),
    terminalScrollbackBytes: int('TERMINAL_SCROLLBACK_BYTES', 1_048_576),
    maxTerminals: int('MAX_TERMINALS', 20),
    password: str('CHIEF_WEB_PASSWORD', ''),
    loginAttemptLimit,
    loginAttemptWindowMs,
    maxConcurrentSessions: int('MAX_CONCURRENT_SESSIONS', 3),
    githubApiUrl: str('GITHUB_API_URL', 'https://api.github.com'),
    githubGraphqlUrl: str(
      'GITHUB_GRAPHQL_URL',
      graphqlUrlFor(str('GITHUB_API_URL', 'https://api.github.com')),
    ),
    pullRequestCacheMs: int('PULL_REQUEST_CACHE_MS', 30_000),
    publicUrl: str('PUBLIC_URL', '').replace(/\/+$/, ''),
    webRoot: path.resolve(str('WEB_ROOT', path.join(REPO_ROOT, 'web', 'dist'))),
    nodeEnv: env['NODE_ENV'] ?? 'development',
  };
}
