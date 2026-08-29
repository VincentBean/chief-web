import type { GitIdentity } from '../settings/index.js';

/**
 * The contract of the runner image (`runner/Dockerfile`, US-006).
 *
 * Everything the orchestrator (US-009) needs to know about the inside of a
 * session container lives here, so a change to the image is a change to one
 * module rather than a grep across the server.
 */

/** Unprivileged user the image runs as. */
export const RUNNER_USER = 'node';
/** Its uid/gid — mounted files must be readable by this user, not by root. */
export const RUNNER_UID = 1000;
export const RUNNER_GID = 1000;
export const RUNNER_HOME = '/home/node';

/** Mount point of the shared `claude-auth` volume (`~/.claude`). */
export const RUNNER_CLAUDE_DIR = `${RUNNER_HOME}/.claude`;
/** Where the per-session workspace is mounted; also the image's WORKDIR. */
export const RUNNER_WORKSPACE_DIR = '/workspace';
/** Default path the entrypoint reads the repository's private key from. */
export const RUNNER_SSH_KEY_PATH = '/keys/id_ed25519';

/**
 * Environment the entrypoint reads. The image defaults to the same values, so
 * passing none of these still produces a container that can commit.
 */
export function runnerEnvironment(identity: GitIdentity): Record<string, string> {
  return {
    CHIEF_GIT_AUTHOR_NAME: identity.name,
    CHIEF_GIT_AUTHOR_EMAIL: identity.email,
    CHIEF_SSH_KEY_PATH: RUNNER_SSH_KEY_PATH,
  };
}

/** The same environment as `docker run` arguments. */
export function runnerEnvArgs(identity: GitIdentity): string[] {
  return Object.entries(runnerEnvironment(identity)).flatMap(([key, value]) => [
    '--env',
    `${key}=${value}`,
  ]);
}

export interface RunnerMounts {
  /** Host path of the `claude-auth` volume, mounted read-write at `~/.claude`. */
  readonly claudeAuthDir: string;
  /** Host path of this session's workspace, mounted at `/workspace`. */
  readonly workspaceDir: string;
  /**
   * Host path of the repository's private key, mounted read-only. It must be
   * readable by uid {@link RUNNER_UID}: the container is not root, and the
   * entrypoint reports a clear error rather than silently failing to clone.
   */
  readonly sshKeyPath?: string;
}

/** `docker run`/`docker create` bind-mount arguments for a session container. */
export function runnerMountArgs(mounts: RunnerMounts): string[] {
  const args = [
    '--volume',
    `${mounts.claudeAuthDir}:${RUNNER_CLAUDE_DIR}`,
    '--volume',
    `${mounts.workspaceDir}:${RUNNER_WORKSPACE_DIR}`,
  ];
  if (mounts.sshKeyPath !== undefined) {
    args.push('--volume', `${mounts.sshKeyPath}:${RUNNER_SSH_KEY_PATH}:ro`);
  }
  return args;
}
