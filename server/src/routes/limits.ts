import { Router } from 'express';

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
 * Read and clear are one resource on purpose. Anything offering the button has
 * to know whether there is a hold to clear, and both answers come from the same
 * row.
 */

/** The slice of the build loop this router drives. */
export interface HeldBuilds {
  /**
   * Lifts the hold and resumes every session waiting on it, as far as the
   * concurrency cap allows; the rest go on the build queue. Returns how many
   * were actually started.
   */
  resumeAllHeld(): Promise<number>;
}

export function createLimitsRouter(hold: UsageLimitHold, builds: HeldBuilds): Router {
  const router = Router();

  router.get('/limits/hold', (_req, res) => {
    res.status(200).json({ until: hold.until() });
  });

  router.post('/limits/hold/clear', (_req, res) => {
    // Nothing to clear is a conflict rather than a silent success: the button
    // is offered because a hold was on screen, and being told the hold had
    // already lifted is the useful answer.
    if (hold.until() === null) {
      res.status(409).json({
        error: 'no_usage_limit_hold',
        message: 'Claude’s usage limit is not holding any work right now.',
      });
      return;
    }

    builds
      .resumeAllHeld()
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
