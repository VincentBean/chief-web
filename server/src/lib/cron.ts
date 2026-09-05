/**
 * Cron expressions, in one place (US-002).
 *
 * The scheduler, the API and the UI all have to agree on what an expression
 * means: when it next fires, and what it says in English. So parsing lives here
 * and nowhere else — `cron-parser` computes occurrences, `cronstrue` renders the
 * description, and callers only ever see the three functions below:
 *
 * - `validateCron(expr)`      — ok, or a specific error message (the AC's `validate`)
 * - `nextCronRun(expr, from)` — the next occurrence strictly after `from` (`nextRun`)
 * - `describeCron(expr)`      — "At 03:00, only on Monday" (`describe`)
 *
 * Nothing here throws: an unusable expression comes back as `ok: false` or
 * `null`, because every caller (a route validating user input, the scheduler
 * reading a stored expression) has a sensible thing to do with that and none of
 * them should die on a typo.
 *
 * Expressions are five-field (`minute hour day-of-month month day-of-week`) and
 * evaluated in the server's timezone, exactly as crontab would.
 */

import { type CronExpression, CronExpressionParser } from 'cron-parser';
import cronstrue from 'cronstrue';

/** The five-field crontab form; seconds and `@daily` aliases are not accepted. */
export const CRON_FIELD_COUNT = 5;

/** What the fields are called, for the wrong-field-count message. */
const FIELD_NAMES = 'minute hour day-of-month month day-of-week';

export interface CronValidationOk {
  readonly ok: true;
  /** The human-readable description, so a validating caller need not ask twice. */
  readonly description: string;
}

export interface CronValidationError {
  readonly ok: false;
  /** Why it was rejected, phrased for the person who typed the expression. */
  readonly message: string;
}

export type CronValidation = CronValidationOk | CronValidationError;

/** `validateCron`'s answer plus the iterator, for the callers that need dates. */
interface ParsedCron extends CronValidationOk {
  readonly iterator: CronExpression;
}

/** Library errors arrive as `Error`, but a bad expression can throw anything. */
function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const trimmed = raw.trim();
  return trimmed === '' ? 'The cron expression could not be parsed.' : trimmed;
}

/**
 * Parses an expression against both libraries, positioning the iterator at
 * `from`.
 *
 * Both have to accept it. They disagree at the edges — `cronstrue` will happily
 * describe a zero step as "every 0 minutes" and `0 0 30 2 *` as a day that
 * never comes, neither of which `cron-parser` will run — and an expression the
 * scheduler cannot fire but the UI describes anyway is exactly the drift this
 * module exists to prevent.
 *
 * The field count is checked here rather than left to the library on purpose:
 * `cron-parser` pads a short expression out with defaults (`0 3 * *` silently
 * becomes "at 03:00 on the 3rd of every month") and accepts a sixth seconds
 * field, both of which mean something other than what the user typed.
 */
function parseCron(expression: string, from?: Date): ParsedCron | CronValidationError {
  const trimmed = expression.trim();
  if (trimmed === '') return { ok: false, message: 'A cron expression is required.' };

  const fields = trimmed.split(/\s+/);
  if (fields.length !== CRON_FIELD_COUNT) {
    return {
      ok: false,
      message: `A cron expression needs ${String(CRON_FIELD_COUNT)} fields (${FIELD_NAMES}); got ${String(fields.length)}.`,
    };
  }

  try {
    const iterator = CronExpressionParser.parse(
      trimmed,
      from === undefined ? {} : { currentDate: from },
    );
    const description = cronstrue.toString(trimmed, {
      use24HourTimeFormat: true,
      throwExceptionOnParseError: true,
      verbose: false,
    });
    return { ok: true, description, iterator };
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
}

/**
 * Validates an expression, returning either its description or the specific
 * reason it was rejected.
 */
export function validateCron(expression: string): CronValidation {
  const parsed = parseCron(expression);
  return parsed.ok ? { ok: true, description: parsed.description } : parsed;
}

/** True when the expression is usable; the message is discarded. */
export function isValidCron(expression: string): boolean {
  return validateCron(expression).ok;
}

/**
 * The next occurrence strictly after `from` — an expression due exactly at
 * `from` returns the occurrence after that one, so a task that has just fired
 * can recompute its own `next_run_at` without firing again immediately.
 *
 * Returns `null` when the expression is invalid or has no further occurrence.
 */
export function nextCronRun(expression: string, from: Date = new Date()): Date | null {
  if (Number.isNaN(from.getTime())) return null;
  const parsed = parseCron(expression, from);
  if (!parsed.ok) return null;
  try {
    return parsed.iterator.next().toDate();
  } catch {
    return null;
  }
}

/**
 * A human-readable description ("At 03:00, only on Monday"), or `null` when the
 * expression is not one this module accepts.
 */
export function describeCron(expression: string): string | null {
  const parsed = parseCron(expression);
  return parsed.ok ? parsed.description : null;
}
