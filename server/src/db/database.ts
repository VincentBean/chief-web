import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { logger } from '../lib/logger.js';
import { runMigrations } from './migrations.js';
import type { Database } from './sqlite.js';

/** Pass this instead of a file path to get a throwaway in-memory database. */
export const IN_MEMORY = ':memory:';

/**
 * Opens the SQLite database at `databasePath` (creating its directory and the
 * file if needed) and brings the schema up to date. Safe to call on every boot:
 * migrations already applied are skipped, so existing data is never touched.
 */
export function openDatabase(databasePath: string): Database {
  if (databasePath !== IN_MEMORY) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  const db = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });

  // WAL keeps readers from blocking the writer; the busy timeout absorbs the
  // short lock contention between the HTTP handlers and the build loop.
  if (databasePath !== IN_MEMORY) db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');

  const applied = runMigrations(db);
  if (applied.length > 0) {
    logger.info('applied database migrations', { path: databasePath, migrations: applied });
  }

  return db;
}

export function closeDatabase(db: Database): void {
  db.close();
}
