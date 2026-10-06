import { Router } from 'express';

import { type Database, getClaudeAccount } from '../db/index.js';
import type { UsageLimitHold } from '../limits/index.js';

/**
 * Claude's usage-limit hold (US-002) as the operator sees it: what it is, and
 * the way to end it early (US-008).
 *
 * The hold is a guess. chief-web waits an hour because the CLI's refusal says
 * nothing about where in the rolling window the account is, so the wait is
 * often longer than it needs to be — and a refusal misread from an agent's
 * output would cost an hour for nothing at all. "Resume now" is the operator's
 * answer to both: it lifts the hold and puts every held session back to work
 * there and then.
 *
 * Holds are per Claude account (multiple accounts US-014): the list names each
 * account's, and a clear lifts one account's or, with none named, all of them.
 *
 * Read and clear are one resource on purpose. Anything offering the button has
 * to know whether there is a hold to clear, and both answers come from the same
 * row.
 */

/** The slice of the build loop this router drives. */
export interface HeldBuilds {
  /**
   * Lifts one account's hold — every account's when `accountId` is omitted —
   * and resumes every session no longer waiting on one, as far as the
   * concurrency cap allows; the rest go on the build queue. Returns how many
   * were actually started.
   */
  resumeAllHeld(accountId?: string): Promise<number>;
}

export function createLimitsRouter(
  db: Database,
  hold: UsageLimitHold,
  builds: HeldBuilds,
): Router {
  const router = Router();

  // `until` keeps its meaning from before accounts (the earliest expiry while
  // every signed-in account is held); `accounts` lists each account's own hold
  // (multiple accounts US-014).
  router.get('/limits/hold', (_req, res) => {
    res.status(200).json({ until: hold.allHeldUntil(), accounts: hold.list() });
  });

  router.post('/limits/hold/clear', (req, res) => {
    const body: unknown = req.body;
    const raw =
      typeof body === 'object' && body !== null && 'accountId' in body
        ? (body as { accountId: unknown }).accountId
        : undefined;
    if (raw !== undefined && raw !== null && (typeof raw !== 'string' || raw === '')) {
      res.status(400).json({
        error: 'invalid_account_id',
        message: '`accountId` must be a Claude account id, or omitted to clear every hold.',
      });
      return;
    }
    const accountId = typeof raw === 'string' ? raw : undefined;
    if (accountId !== undefined && getClaudeAccount(db, accountId) === null) {
      res.status(404).json({
        error: 'claude_account_not_found',
        message: 'There is no Claude account with that id.',
      });
      return;
    }

    // Nothing to clear is a conflict rather than a silent success: the button
    // is offered because a hold was on screen, and being told the hold had
    // already lifted is the useful answer.
    const held =
      accountId === undefined
        ? hold.list().some((entry) => entry.until !== null)
        : hold.active(accountId);
    if (!held) {
      res.status(409).json({
        error: 'no_usage_limit_hold',
        message:
          accountId === undefined
            ? 'Claude’s usage limit is not holding any work right now.'
            : 'Claude’s usage limit is not holding that account right now.',
      });
      return;
    }

    builds
      .resumeAllHeld(accountId)
      .then((resumed) => {
        res.status(200).json({ ok: true, resumed });
      })
      .catch((cause: unknown) => {
        // The hold is lifted either way — resuming a session is best-effort and
        // the scheduler's next tick tries the stragglers again.
        res.status(500).json({ error: 'resume_failed', message: String(cause) });
      });
  });

  return router;
}
