import fs from 'node:fs';
import path from 'node:path';

import type { Config } from '../config.js';
import {
  type ClaudeAccount,
  createClaudeAccount,
  type CreateClaudeAccountInput,
  type Database,
  deleteClaudeAccount,
  deleteClaudeAccountAndReferences,
  listClaudeAccounts,
  setSetting,
} from '../db/index.js';
import { logger } from '../lib/logger.js';
import {
  chownToRunner,
  claudeAccountDir,
  createClaudeAccountDir,
  removeClaudeAccountDir,
} from '../runner/index.js';
import { getDefaultClaudeAccount } from '../settings/index.js';

/** The file whose presence means a directory holds a Claude Code login. */
export const CLAUDE_CREDENTIALS_FILE = '.credentials.json';

/**
 * Creates an account row together with its credentials directory (mode 0700).
 * A directory that cannot be created takes the row with it, so no account
 * ever exists without somewhere to keep its login.
 */
export function addClaudeAccount(
  config: Pick<Config, 'dataDir'>,
  db: Database,
  input: CreateClaudeAccountInput = {},
): ClaudeAccount {
  const account = createClaudeAccount(db, input);
  try {
    createClaudeAccountDir(config, account.id);
  } catch (error) {
    deleteClaudeAccount(db, account.id);
    throw error;
  }
  return account;
}

/**
 * The account a launch runs on when nothing more specific was chosen; see
 * {@link getDefaultClaudeAccount} for how it resolves (US-007).
 */
export function defaultClaudeAccountId(db: Database): string | null {
  return getDefaultClaudeAccount(db)?.id ?? null;
}

/** Makes an existing account the default ("Make default", US-006). */
export function setDefaultClaudeAccount(db: Database, id: string): void {
  setSetting(db, 'default_claude_account_id', id);
}

/**
 * Deletes an account row and its credentials directory, and clears every
 * reference to it (sessions, recurring tasks, account settings) so those fall
 * back to the default. A directory that cannot be removed is logged and left
 * behind; the delete still succeeds.
 */
export function removeClaudeAccount(
  config: Pick<Config, 'dataDir'>,
  db: Database,
  id: string,
): boolean {
  const deleted = deleteClaudeAccountAndReferences(db, id);
  if (deleted) removeClaudeAccountDir(config, id);
  return deleted;
}

/**
 * Turns the single-account `claude-auth` directory of an existing install
 * into the first account, on server start (multiple accounts US-001).
 *
 * Runs only while there are no accounts and the legacy directory holds a
 * login. The **whole** directory is copied — not just the credentials, but
 * `.claude.json` with its onboarding and trust flags too — so the operator is
 * neither asked to sign in again nor sent through the first-run wizard. The
 * legacy directory itself is left untouched.
 *
 * A copy that fails half-way removes the account again: a row left behind
 * would make the next start skip the import, and the operator would have to
 * sign in after all. The imported account becomes the explicit default
 * (US-007): it is the login every launch used until now. Returns the imported
 * account, or null when nothing ran.
 */
export function importLegacyClaudeAuth(
  config: Pick<Config, 'dataDir' | 'claudeAuthDir'>,
  db: Database,
): ClaudeAccount | null {
  if (listClaudeAccounts(db).length > 0) return null;
  if (!fs.existsSync(path.join(config.claudeAuthDir, CLAUDE_CREDENTIALS_FILE))) return null;

  let account: ClaudeAccount | null = null;
  try {
    account = addClaudeAccount(config, db, { nickname: null, position: 1 });
    const dir = claudeAccountDir(config, account.id);
    fs.cpSync(config.claudeAuthDir, dir, { recursive: true, preserveTimestamps: true });
    chownToRunner(dir);
    setDefaultClaudeAccount(db, account.id);
  } catch (error) {
    if (account !== null) removeClaudeAccount(config, db, account.id);
    logger.error('could not import the existing Claude login as an account', {
      from: config.claudeAuthDir,
      error: String(error),
    });
    return null;
  }

  logger.info('imported the existing Claude login as the first account', {
    accountId: account.id,
    from: config.claudeAuthDir,
    to: claudeAccountDir(config, account.id),
  });
  return account;
}
