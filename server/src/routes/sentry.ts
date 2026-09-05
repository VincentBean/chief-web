import { Router } from 'express';

import {
  type Database,
  getSession,
  listRepositories,
  listSentryIssues,
  type SentryIssueStatus,
} from '../db/index.js';
import { getSentryToken } from '../settings/index.js';

/** One tracked Sentry issue, decorated with the names the tab renders (US-009). */
export interface SentryIssueView {
  readonly id: string;
  readonly repositoryId: string;
  /** The repository's name in chief-web, not its Sentry project slug. */
  readonly repositoryName: string;
  readonly sentryIssueId: string;
  readonly shortId: string;
  readonly title: string;
  readonly culprit: string | null;
  readonly permalink: string;
  readonly level: string | null;
  readonly eventCount: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly status: SentryIssueStatus;
  /** Why the issue cannot be fixed; shown inline on every `cannot_fix` row. */
  readonly explanation: string | null;
  readonly sessionId: string | null;
  /** Null when the issue has no session, or that session has been deleted. */
  readonly sessionName: string | null;
  readonly resolvedInSentry: boolean;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Everything the Sentry tab shows in one answer. */
export interface SentryIssueList {
  readonly issues: SentryIssueView[];
  /**
   * Whether a Sentry token is saved at all. Without one nothing is ever
   * polled, so an empty list means "not set up" rather than "nothing broke" —
   * the page says which, and links to the settings page.
   */
  readonly tokenConfigured: boolean;
  readonly generatedAt: string;
}

/**
 * `GET /sentry/issues`: every issue chief-web is tracking (US-009).
 *
 * Reads the database only — the poller is what talks to Sentry, on its own
 * timer — so this is as cheap as the session list. It is still not polled: the
 * page loads it once, refreshes on demand and revalidates when the tab becomes
 * visible again, because an issue's state moves on a fifteen-minute tick and a
 * three-second poll would learn nothing new.
 */
export function createSentryRouter(db: Database): Router {
  const router = Router();

  router.get('/sentry/issues', (_req, res) => {
    const names = new Map(listRepositories(db).map((repository) => [repository.id, repository.name]));
    const view: SentryIssueList = {
      issues: listSentryIssues(db).map((issue) => ({
        ...issue,
        // A repository deleted since the issue was recorded cascades the row
        // away, so the lookup all but always hits; the fallback only keeps a
        // race from blanking the page.
        repositoryName: names.get(issue.repositoryId) ?? 'unknown repository',
        sessionName: issue.sessionId === null ? null : (getSession(db, issue.sessionId)?.name ?? null),
      })),
      tokenConfigured: getSentryToken(db) !== null,
      generatedAt: new Date().toISOString(),
    };
    res.status(200).json(view);
  });

  return router;
}
