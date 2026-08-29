import type { DatabaseSync } from 'node:sqlite';

/**
 * The database handle used across the data layer. `node:sqlite` is synchronous
 * and dependency-free, which keeps the runtime image free of native modules.
 */
export type Database = DatabaseSync;

/** A raw row as returned by `node:sqlite`. */
export type Row = Record<string, unknown>;

/** Timestamps are stored as UTC ISO-8601 strings so they sort lexicographically. */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Runs `fn` inside a transaction, rolling back if it throws. Not re-entrant:
 * SQLite has no nested transactions, so never call it from inside itself.
 */
export function withTransaction<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function unexpected(column: string, value: unknown): Error {
  return new Error(`Unexpected value for column "${column}": ${JSON.stringify(value) ?? typeof value}`);
}

export function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw unexpected(column, value);
  return value;
}

export function nullableText(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw unexpected(column, value);
  return value;
}

export function integer(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'number') throw unexpected(column, value);
  return value;
}

/** Narrows a stored string to one of the allowed enum values. */
export function enumeration<T extends string>(
  row: Row,
  column: string,
  allowed: readonly T[],
): T {
  const value = text(row, column);
  if (!(allowed as readonly string[]).includes(value)) throw unexpected(column, value);
  return value as T;
}

/** `run()` reports `changes` as `number | bigint`; callers always want a number. */
export function changeCount(result: { changes: number | bigint }): number {
  return Number(result.changes);
}
