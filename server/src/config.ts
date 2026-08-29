import path from 'node:path';

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
  /** Default max number of sessions building at the same time (see US-018). */
  readonly maxConcurrentSessions: number;
  /** Base URL of the GitHub REST API; overridable for self-hosted GitHub. */
  readonly githubApiUrl: string;
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

  return {
    port,
    host: str('HOST', '0.0.0.0'),
    dataDir,
    databasePath: path.resolve(str('DATABASE_PATH', path.join(dataDir, 'chief-web.db'))),
    sshKeysDir: path.resolve(str('SSH_KEYS_DIR', path.join(dataDir, 'ssh-keys'))),
    workspacesDir: path.resolve(str('WORKSPACES_DIR', path.join(dataDir, 'workspaces'))),
    claudeAuthDir: path.resolve(str('CLAUDE_AUTH_DIR', path.join(dataDir, 'claude-auth'))),
    claudeAuthVolume: str('CLAUDE_AUTH_VOLUME', ''),
    claudeProbeTimeoutMs: int('CLAUDE_PROBE_TIMEOUT_MS', 30_000),
    claudeStatusCacheMs: int('CLAUDE_STATUS_CACHE_MS', 15_000),
    dockerSocket: str('DOCKER_SOCKET', '/var/run/docker.sock'),
    dockerBin: str('DOCKER_BIN', 'docker'),
    runnerImage: str('RUNNER_IMAGE', 'chief-web-runner:latest'),
    connectionTestTimeoutMs: int('CONNECTION_TEST_TIMEOUT_MS', 60_000),
    terminalScrollbackLines: int('TERMINAL_SCROLLBACK_LINES', 2000),
    terminalScrollbackBytes: int('TERMINAL_SCROLLBACK_BYTES', 1_048_576),
    maxTerminals: int('MAX_TERMINALS', 20),
    password: str('CHIEF_WEB_PASSWORD', ''),
    maxConcurrentSessions: int('MAX_CONCURRENT_SESSIONS', 3),
    githubApiUrl: str('GITHUB_API_URL', 'https://api.github.com'),
    webRoot: path.resolve(str('WEB_ROOT', path.join(REPO_ROOT, 'web', 'dist'))),
    nodeEnv: env['NODE_ENV'] ?? 'development',
  };
}
