import fs from 'node:fs';
import path from 'node:path';

import type { Config } from '../config.js';
import { logger } from '../lib/logger.js';
import { RUNNER_GID, RUNNER_UID } from '../runner/index.js';

/**
 * Per-session state on the data volume (US-009).
 *
 *   workspaces/<session-id>/            → mounted at `/workspace`
 *   workspaces/<session-id>/repo/       → the clone (US-010)
 *   ssh-keys/sessions/<session-id>.key  → runner-readable copy of the
 *                                         repository's deploy key
 *
 * The workspace deliberately outlives its container: it holds the clone and the
 * `.chief/` state a retry resumes from, so stopping or removing a container
 * never touches it. Only deleting the session itself (US-012) does, through
 * {@link removeSessionWorkspace}.
 */

const WORKSPACE_MODE = 0o755;
/** Widened only when the server cannot chown — see {@link giveToRunner}. */
const WORKSPACE_FALLBACK_MODE = 0o777;
const SESSION_KEY_MODE = 0o400;
const SESSION_KEY_FALLBACK_MODE = 0o444;
const SESSION_KEYS_DIR_MODE = 0o700;
/** Widened only when the server cannot chown a file it wrote into a clone. */
const FILE_FALLBACK_MODE = 0o666;

export function sessionWorkspaceDir(config: Pick<Config, 'workspacesDir'>, sessionId: string): string {
  return path.join(config.workspacesDir, sessionId);
}

/** Where US-010 clones into; `/workspace/repo` inside the container. */
export function sessionRepoDir(config: Pick<Config, 'workspacesDir'>, sessionId: string): string {
  return path.join(sessionWorkspaceDir(config, sessionId), 'repo');
}

export function sessionKeysDir(config: Pick<Config, 'sshKeysDir'>): string {
  return path.join(config.sshKeysDir, 'sessions');
}

export function sessionKeyPath(config: Pick<Config, 'sshKeysDir'>, sessionId: string): string {
  return path.join(sessionKeysDir(config), `${sessionId}.key`);
}

/** Creates the workspace if it is missing; returns its path either way. */
export function ensureSessionWorkspace(
  config: Pick<Config, 'workspacesDir'>,
  sessionId: string,
): string {
  const dir = sessionWorkspaceDir(config, sessionId);
  fs.mkdirSync(dir, { recursive: true, mode: WORKSPACE_MODE });
  giveToRunner(dir, WORKSPACE_FALLBACK_MODE);
  return dir;
}

/**
 * Writes the repository's private key where a session container can read it.
 *
 * The registered key (`ssh-keys/<repository-id>.key`) is `0600` and owned by
 * the server, which runs as root; the runner is uid {@link RUNNER_UID} and
 * could not open it. Mounting a copy owned by that uid keeps the original
 * untouched and keeps the key off the command line and out of the environment,
 * where `docker inspect` would expose it.
 */
export function stageSessionKey(
  config: Pick<Config, 'sshKeysDir'>,
  sessionId: string,
  privateKey: string,
): string {
  const dir = sessionKeysDir(config);
  fs.mkdirSync(dir, { recursive: true, mode: SESSION_KEYS_DIR_MODE });
  fs.chmodSync(dir, SESSION_KEYS_DIR_MODE);

  const file = sessionKeyPath(config, sessionId);
  // Rewriting in place would leave the old contents readable through the mode
  // of the existing file; start from a file we create ourselves.
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`, {
    mode: SESSION_KEY_MODE,
  });
  fs.chmodSync(file, SESSION_KEY_MODE);
  giveToRunner(file, SESSION_KEY_FALLBACK_MODE);
  return file;
}

/** Best effort; a key that was never staged is not an error. */
export function removeSessionKey(config: Pick<Config, 'sshKeysDir'>, sessionId: string): void {
  fs.rmSync(sessionKeyPath(config, sessionId), { force: true });
}

/**
 * Writes a file into a session's clone, on a path relative to its root, and
 * hands it — and every directory created along the way — to the runner user.
 *
 * The server is root inside Docker while the agent is uid {@link RUNNER_UID},
 * so a file created here would otherwise be one the agent can read and not
 * write. That matters for the generated PRD of a recurring-task run (US-004):
 * the agent ticks its acceptance criteria and writes its `**Status:**` line
 * into that very file, and a run whose PRD it cannot edit could never finish
 * its story.
 */
export function writeSessionFile(
  config: Pick<Config, 'workspacesDir'>,
  sessionId: string,
  relativePath: string,
  content: string,
): string {
  const segments = relativePath.split('/').filter((segment) => segment !== '');
  const file = path.join(sessionRepoDir(config, sessionId), ...segments);

  let dir = sessionRepoDir(config, sessionId);
  for (const segment of segments.slice(0, -1)) {
    dir = path.join(dir, segment);
    if (fs.existsSync(dir)) continue;
    fs.mkdirSync(dir, { mode: WORKSPACE_MODE });
    giveToRunner(dir, WORKSPACE_FALLBACK_MODE);
  }

  fs.writeFileSync(file, content);
  giveToRunner(file, FILE_FALLBACK_MODE);
  return file;
}

/**
 * Deletes the workspace, clone and all. Only session deletion may call this —
 * container teardown must leave it alone so a retry can reuse the clone.
 */
export function removeSessionWorkspace(
  config: Pick<Config, 'workspacesDir'>,
  sessionId: string,
): void {
  fs.rmSync(sessionWorkspaceDir(config, sessionId), { recursive: true, force: true });
}

/**
 * Hands ownership to the runner user. Exported because anything the server
 * writes into a session workspace — the generated PRD of a fix session (US-007)
 * among them — has to be readable by the uid the agent runs as.
 *
 * Only root can chown; when the server runs
 * unprivileged (local development) the permissions are widened instead, which
 * is the only way uid 1000 inside the container can still use the file.
 */
export function giveToRunner(target: string, fallbackMode: number): void {
  try {
    fs.chownSync(target, RUNNER_UID, RUNNER_GID);
  } catch {
    fs.chmodSync(target, fallbackMode);
    logger.debug('could not chown to the runner user; widened permissions instead', {
      target,
      mode: fallbackMode.toString(8),
    });
  }
}
