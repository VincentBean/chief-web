import { randomBytes } from 'node:crypto';

import { CLAUDE_ACCOUNT_SETTING_KEYS } from './settings.js';
import {
  changeCount,
  type Database,
  integer,
  nowIso,
  nullableText,
  type Row,
  text,
  withTransaction,
} from './sqlite.js';

/**
 * One Claude Code login chief-web can run on (multiple accounts US-001).
 *
 * The credentials themselves are not in the database: they live in the
 * account's own directory (`claudeAccountDir`), which is what a container
 * mounts at `~/.claude`. The profile fields are what the last status probe
 * reported, kept here so the UI can show them without spawning a probe.
 */
export interface ClaudeAccount {
  /** Lowercase hex: safe as a path segment, in a URL and in a container name. */
  readonly id: string;
  /** The operator's own name for the account; null shows the email instead. */
  readonly nickname: string | null;
  readonly email: string | null;
  readonly organization: string | null;
  readonly subscription: string | null;
  readonly authMethod: string | null;
  /** Display order, lowest first. */
  readonly position: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateClaudeAccountInput {
  readonly nickname?: string | null;
  readonly email?: string | null;
  readonly organization?: string | null;
  readonly subscription?: string | null;
  readonly authMethod?: string | null;
  /** Defaults to one past the last account, so a new account lists last. */
  readonly position?: number;
}

export interface UpdateClaudeAccountInput {
  readonly nickname?: string | null;
  readonly email?: string | null;
  readonly organization?: string | null;
  readonly subscription?: string | null;
  readonly authMethod?: string | null;
  readonly position?: number;
}

const COLUMNS: Record<keyof UpdateClaudeAccountInput, string> = {
  nickname: 'nickname',
  email: 'email',
  organization: 'organization',
  subscription: 'subscription',
  authMethod: 'auth_method',
  position: 'position',
};

function newClaudeAccountId(): string {
  return randomBytes(8).toString('hex');
}

function mapClaudeAccount(row: Row): ClaudeAccount {
  return {
    id: text(row, 'id'),
    nickname: nullableText(row, 'nickname'),
    email: nullableText(row, 'email'),
    organization: nullableText(row, 'organization'),
    subscription: nullableText(row, 'subscription'),
    authMethod: nullableText(row, 'auth_method'),
    position: integer(row, 'position'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
}

/** Every account in display order. */
export function listClaudeAccounts(db: Database): ClaudeAccount[] {
  return db
    .prepare('SELECT * FROM claude_accounts ORDER BY position ASC, created_at ASC, rowid ASC')
    .all()
    .map(mapClaudeAccount);
}

export function getClaudeAccount(db: Database, id: string): ClaudeAccount | null {
  const row = db.prepare('SELECT * FROM claude_accounts WHERE id = ?').get(id);
  return row ? mapClaudeAccount(row) : null;
}

/**
 * Inserts the row only. The account's credentials directory is created by
 * the caller (`addClaudeAccount` in `claude/accounts.ts`), which has the config.
 */
export function createClaudeAccount(
  db: Database,
  input: CreateClaudeAccountInput = {},
): ClaudeAccount {
  const now = nowIso();
  const account: ClaudeAccount = {
    id: newClaudeAccountId(),
    nickname: input.nickname ?? null,
    email: input.email ?? null,
    organization: input.organization ?? null,
    subscription: input.subscription ?? null,
    authMethod: input.authMethod ?? null,
    position: input.position ?? nextPosition(db),
    createdAt: now,
    updatedAt: now,
  };

  db.prepare(
    `INSERT INTO claude_accounts
       (id, nickname, email, organization, subscription, auth_method, position,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    account.id,
    account.nickname,
    account.email,
    account.organization,
    account.subscription,
    account.authMethod,
    account.position,
    account.createdAt,
    account.updatedAt,
  );

  return account;
}

function nextPosition(db: Database): number {
  const row = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM claude_accounts').get();
  return row ? integer(row, 'next') : 1;
}

/** Applies the provided fields only; returns the updated row, or null if absent. */
export function updateClaudeAccount(
  db: Database,
  id: string,
  patch: UpdateClaudeAccountInput,
): ClaudeAccount | null {
  const assignments: string[] = [];
  const params: Record<string, string | number | null> = { ':id': id, ':updated_at': nowIso() };

  for (const [field, column] of Object.entries(COLUMNS)) {
    const value = patch[field as keyof UpdateClaudeAccountInput];
    if (value === undefined) continue;
    assignments.push(`${column} = :${column}`);
    params[`:${column}`] = value;
  }

  if (assignments.length > 0) {
    assignments.push('updated_at = :updated_at');
    db.prepare(`UPDATE claude_accounts SET ${assignments.join(', ')} WHERE id = :id`).run(params);
  }

  return getClaudeAccount(db, id);
}

/**
 * Deletes the row only; `removeClaudeAccount` in `claude/accounts.ts` also
 * removes the credentials directory.
 */
export function deleteClaudeAccount(db: Database, id: string): boolean {
  return changeCount(db.prepare('DELETE FROM claude_accounts WHERE id = ?').run(id)) > 0;
}

/** How many sessions and recurring tasks name an account explicitly. */
export interface ClaudeAccountBindings {
  readonly sessions: number;
  readonly recurringTasks: number;
}

/** Tables whose `claude_account_id` column names the account a row runs on. */
const BOUND_TABLES = { sessions: 'sessions', recurringTasks: 'recurring_tasks' } as const;
const ACCOUNT_COLUMN = 'claude_account_id';

export function claudeAccountBindings(db: Database, id: string): ClaudeAccountBindings {
  const count = (table: string): number => {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${ACCOUNT_COLUMN} = ?`).get(id);
    return row ? integer(row, 'n') : 0;
  };
  return { sessions: count(BOUND_TABLES.sessions), recurringTasks: count(BOUND_TABLES.recurringTasks) };
}

/**
 * Deletes the row and, in the same transaction, every reference to it:
 * sessions and recurring tasks bound to it, and the account settings naming
 * it, go back to `null` — "use the default". The credentials directory is
 * the caller's (`removeClaudeAccount`).
 */
export function deleteClaudeAccountAndReferences(db: Database, id: string): boolean {
  return withTransaction(db, () => {
    for (const table of Object.values(BOUND_TABLES)) {
      db.prepare(`UPDATE ${table} SET ${ACCOUNT_COLUMN} = NULL WHERE ${ACCOUNT_COLUMN} = ?`).run(id);
    }
    for (const key of CLAUDE_ACCOUNT_SETTING_KEYS) {
      db.prepare('DELETE FROM settings WHERE key = ? AND value = ?').run(key, id);
    }
    return deleteClaudeAccount(db, id);
  });
}
