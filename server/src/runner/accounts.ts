import fs from 'node:fs';
import path from 'node:path';

import type { Config } from '../config.js';
import { logger } from '../lib/logger.js';
import { RUNNER_GID, RUNNER_UID } from './image.js';

/**
 * Credentials directories of the Claude accounts (multiple accounts US-001).
 *
 *   <DATA_DIR>/claude-accounts/<account-id>/  → mounted at `~/.claude`
 *
 * One directory per account is what lets several logins coexist: a container
 * mounts the directory of the account it runs on, and nothing else.
 */

/** Credentials are secrets: only the owner (the runner user) may enter. */
export const CLAUDE_ACCOUNT_DIR_MODE = 0o700;

export function claudeAccountsDir(config: Pick<Config, 'dataDir'>): string {
  return path.join(config.dataDir, 'claude-accounts');
}

export function claudeAccountDir(config: Pick<Config, 'dataDir'>, accountId: string): string {
  return path.join(claudeAccountsDir(config), accountId);
}

/**
 * Creates the account's directory with mode 0700 and hands it to the runner
 * user, returning its path. `mkdir`'s mode is subject to the umask and ignored
 * for a directory that already exists, so the mode is set explicitly as well.
 */
export function createClaudeAccountDir(config: Pick<Config, 'dataDir'>, accountId: string): string {
  const dir = claudeAccountDir(config, accountId);
  fs.mkdirSync(dir, { recursive: true, mode: CLAUDE_ACCOUNT_DIR_MODE });
  fs.chmodSync(dir, CLAUDE_ACCOUNT_DIR_MODE);
  chownToRunner(dir);
  return dir;
}

/**
 * Removes the account's directory. Best effort: a failure is logged and
 * swallowed, because the row it belonged to is already gone and an orphaned
 * directory harms nothing.
 */
export function removeClaudeAccountDir(config: Pick<Config, 'dataDir'>, accountId: string): void {
  const dir = claudeAccountDir(config, accountId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    logger.warn('could not remove a Claude account directory', { dir, error: String(error) });
  }
}

/**
 * Hands `target` — and, when it is a directory, everything below it — to the
 * runner user, so a container running as uid {@link RUNNER_UID} can read and
 * refresh the credentials the root server wrote or copied.
 *
 * Only root can chown. Unlike `giveToRunner` in the orchestrator, there is no
 * widened-mode fallback: credentials must stay private, and an unprivileged
 * server (local development) already owns them as the user it runs as.
 */
export function chownToRunner(target: string): void {
  try {
    fs.lchownSync(target, RUNNER_UID, RUNNER_GID);
  } catch {
    return;
  }
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(target)) {
    chownToRunner(path.join(target, entry));
  }
}
