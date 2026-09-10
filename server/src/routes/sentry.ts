import { type Response, Router } from 'express';

import {
  type Database,
  getSentryIssue,
  getSession,
  listRepositories,
  listSentryIssues,
  nowIso,
  type SentryIssue,
  type SentryIssueStatus,
  updateSentryIssue,
} from '../db/index.js';
import { MAX_PLAN_CHARS, type SentryFixer } from '../sentry/index.js';
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
  /** The proposed fix plan the operator judges; null until one is written. */
  readonly plan: string | null;
  /** When the classifier proposed {@link plan}; null while there is none. */
  readonly planProposedAt: string | null;
  /** When the operator approved or rejected it; null while undecided. */
  readonly planDecidedAt: string | null;
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

/** What `POST /sentry/fix-sessions` answers with: the one session the batch became. */
export interface FixSessionCreatedView {
  readonly id: string;
  readonly name: string;
}

/** Most issues one fix session may be asked to cover; a batch is one review. */
export const MAX_FIX_BATCH = 10;

/** A rejected request body: an error code plus something to show the operator. */
interface Invalid {
  readonly error: string;
  readonly message: string;
}

/**
 * `GET /sentry/issues`: every issue chief-web is tracking (US-009), and the
 * operator's verdict on the plan proposed for it (US-004).
 *
 * The read talks to the database only — the poller is what talks to Sentry, on
 * its own timer — so it is as cheap as the session list. It is still not
 * polled: the page loads it once, refreshes on demand and revalidates when the
 * tab becomes visible again, because an issue's state moves on a
 * fifteen-minute tick and a three-second poll would learn nothing new.
 *
 * The two decisions are POSTs beside it. Nothing here creates a session: an
 * approval only records that one may be created, which is US-006's button.
 */
export function createSentryRouter(db: Database, fixer: SentryFixer): Router {
  const router = Router();

  router.get('/sentry/issues', (_req, res) => {
    const names = repositoryNames(db);
    const view: SentryIssueList = {
      issues: listSentryIssues(db).map((issue) => toView(db, issue, names)),
      tokenConfigured: getSentryToken(db) !== null,
      generatedAt: new Date().toISOString(),
    };
    res.status(200).json(view);
  });

  /**
   * Approves the proposed plan, optionally replacing its text first.
   *
   * The operator's edit is the plan from then on: US-006 hands whatever is
   * stored here to the fix session, so correcting a plan and approving it are
   * deliberately one request rather than two.
   */
  router.post('/sentry/issues/:id/approve', (req, res) => {
    const plan = parsePlan(req.body);
    if (plan !== undefined && typeof plan !== 'string') {
      res.status(400).json(plan);
      return;
    }

    const issue = decidable(db, req.params.id, res);
    if (issue === null) return;

    const updated = updateSentryIssue(db, issue.id, {
      status: 'approved',
      planDecidedAt: nowIso(),
      // Absent leaves the classifier's proposal exactly as it was.
      ...(plan === undefined ? {} : { plan }),
    });
    respondWith(db, res, updated);
  });

  /**
   * Rejects the proposed plan, with the reason kept as the explanation.
   *
   * A rejection is the end of the issue here, so Sentry is owed a resolve call
   * — otherwise the poller would fetch the same issue back on the next tick
   * and the classifier would propose a plan for it all over again. The flag is
   * all this writes: making the call is the resolve pass's job, and a Sentry
   * that refuses it must never undo the operator's decision (US-008).
   */
  router.post('/sentry/issues/:id/reject', (req, res) => {
    const reason = parseReason(req.body);
    if (typeof reason !== 'string') {
      res.status(400).json(reason);
      return;
    }

    const issue = decidable(db, req.params.id, res);
    if (issue === null) return;

    const updated = updateSentryIssue(db, issue.id, {
      status: 'cannot_fix',
      explanation: `plan rejected: ${reason}`,
      planDecidedAt: nowIso(),
      resolveUpstream: true,
    });
    respondWith(db, res, updated);
  });

  /**
   * `POST /sentry/fix-sessions`: one session for a batch of approved issues.
   *
   * The whole rule about *which* issues may be batched lives here rather than
   * in the service: 1–10 known ids, every one of them `approved`, and all of
   * them in one repository, because one session is one branch and one pull
   * request. A request that breaks any of those is a 400 naming what is wrong
   * with it — nothing is created and no attempt is spent.
   *
   * Past that point the service does the work, and a failure part-way is a 500
   * with the reason: the half-created session is gone, the issues are back on
   * `approved` with one more attempt against them, and the operator can press
   * the button again until `MAX_FIX_ATTEMPTS` runs out.
   */
  router.post('/sentry/fix-sessions', (req, res) => {
    const issueIds = parseIssueIds(req.body);
    if (!Array.isArray(issueIds)) {
      res.status(400).json(issueIds);
      return;
    }

    const refusal = batchRefusal(db, issueIds);
    if (refusal !== null) {
      res.status(400).json(refusal);
      return;
    }

    fixer
      .createFixSession(issueIds)
      .then((result) => {
        if (result.ok) {
          const view: FixSessionCreatedView = { id: result.session.id, name: result.session.name };
          res.status(201).json(view);
          return;
        }
        res.status(500).json({ error: 'fix_session_failed', message: result.reason });
      })
      .catch((cause: unknown) => {
        res.status(500).json({
          error: 'fix_session_failed',
          message: cause instanceof Error ? cause.message : String(cause),
        });
      });
  });

  return router;
}

/**
 * The batch's ids: 1–{@link MAX_FIX_BATCH} non-empty strings, de-duplicated.
 *
 * The same id ticked twice is one issue, so the cap is counted after the
 * duplicates are gone — eleven ids naming ten issues is a batch of ten.
 */
function parseIssueIds(body: unknown): string[] | Invalid {
  const field = readField(body, 'issueIds');
  if ('error' in field) return field;
  if (!Array.isArray(field.value)) {
    return { error: 'invalid_issue_ids', message: 'issueIds must be an array of issue ids.' };
  }
  if (field.value.some((id) => typeof id !== 'string' || id.trim() === '')) {
    return { error: 'invalid_issue_ids', message: 'Every issue id must be a non-empty string.' };
  }

  const issueIds = [...new Set(field.value as string[])];
  if (issueIds.length === 0) {
    return { error: 'invalid_issue_ids', message: 'Name at least one issue to fix.' };
  }
  if (issueIds.length > MAX_FIX_BATCH) {
    return {
      error: 'invalid_issue_ids',
      message: `A fix session can cover at most ${String(MAX_FIX_BATCH)} issues.`,
    };
  }
  return issueIds;
}

/**
 * Why this batch may not become a session, or `null` when it may.
 *
 * Unknown before not-approved before spanning repositories, so the message
 * names the first thing that is actually wrong rather than a consequence of it.
 */
function batchRefusal(db: Database, issueIds: readonly string[]): Invalid | null {
  const issues: SentryIssue[] = [];
  for (const id of issueIds) {
    const issue = getSentryIssue(db, id);
    if (issue === null) {
      return { error: 'sentry_issue_not_found', message: `No such Sentry issue: ${id}.` };
    }
    issues.push(issue);
  }

  const undecided = issues.find((issue) => issue.status !== 'approved');
  if (undecided !== undefined) {
    return {
      error: 'sentry_issue_not_approved',
      message: `${undecided.shortId} is ${undecided.status}, not an approved issue awaiting a fix session.`,
    };
  }

  // One session is one branch and one pull request, so it is one repository.
  const repositories = new Set(issues.map((issue) => issue.repositoryId));
  if (repositories.size > 1) {
    return {
      error: 'sentry_issues_span_repositories',
      message: 'A fix session covers one repository; these issues are spread over several.',
    };
  }
  return null;
}

/**
 * The issue both decisions may be made on, or `null` once the answer has been
 * written: 404 for an id nobody knows, 409 for an issue that is past — or not
 * yet at — the point where there is a plan to judge.
 */
function decidable(db: Database, id: string, res: Response): SentryIssue | null {
  const issue = getSentryIssue(db, id);
  if (issue === null) {
    res.status(404).json({ error: 'sentry_issue_not_found', message: 'No such Sentry issue.' });
    return null;
  }
  if (issue.status !== 'planned') {
    res.status(409).json({
      error: 'sentry_issue_not_planned',
      message: `This issue is ${issue.status}, not awaiting a decision on a proposed plan.`,
    });
    return null;
  }
  return issue;
}

/** Answers with the decided issue, in the shape the list already speaks. */
function respondWith(db: Database, res: Response, issue: SentryIssue | null): void {
  if (issue === null) {
    // The row was deleted between the lookup and the write; vanishingly rare,
    // and "it is gone" is the same answer as an unknown id.
    res.status(404).json({ error: 'sentry_issue_not_found', message: 'No such Sentry issue.' });
    return;
  }
  res.status(200).json(toView(db, issue, repositoryNames(db)));
}

function repositoryNames(db: Database): Map<string, string> {
  return new Map(listRepositories(db).map((repository) => [repository.id, repository.name]));
}

function toView(db: Database, issue: SentryIssue, names: Map<string, string>): SentryIssueView {
  return {
    ...issue,
    // A repository deleted since the issue was recorded cascades the row away,
    // so the lookup all but always hits; the fallback only keeps a race from
    // blanking the page.
    repositoryName: names.get(issue.repositoryId) ?? 'unknown repository',
    sessionName: issue.sessionId === null ? null : (getSession(db, issue.sessionId)?.name ?? null),
  };
}

/**
 * The optional replacement plan: `undefined` when the body carries none.
 *
 * Bounded by the same {@link MAX_PLAN_CHARS} the classifier writes within, so
 * an unedited proposal is always approvable and an edit can never grow past
 * what the fix prompt is built to carry.
 */
function parsePlan(body: unknown): string | undefined | Invalid {
  const field = readField(body, 'plan');
  if ('error' in field) return field;
  if (field.value === undefined || field.value === null) return undefined;
  if (typeof field.value !== 'string') {
    return { error: 'invalid_plan', message: 'The plan must be a string.' };
  }

  const plan = normalise(field.value);
  if (plan.length === 0) {
    return { error: 'invalid_plan', message: 'The plan cannot be empty.' };
  }
  if (plan.length > MAX_PLAN_CHARS) {
    return {
      error: 'invalid_plan',
      message: `The plan cannot be longer than ${MAX_PLAN_CHARS} characters.`,
    };
  }
  return plan;
}

/** The required rejection reason; it becomes the issue's explanation. */
function parseReason(body: unknown): string | Invalid {
  const field = readField(body, 'reason');
  if ('error' in field) return field;
  if (typeof field.value !== 'string') {
    return { error: 'invalid_reason', message: 'A reason for the rejection is required.' };
  }

  const reason = normalise(field.value);
  if (reason.length === 0) {
    return { error: 'invalid_reason', message: 'A reason for the rejection is required.' };
  }
  if (reason.length > MAX_PLAN_CHARS) {
    return {
      error: 'invalid_reason',
      message: `The reason cannot be longer than ${MAX_PLAN_CHARS} characters.`,
    };
  }
  return reason;
}

/** One field out of a body that has to be a JSON object to have fields at all. */
function readField(body: unknown, field: string): { value: unknown } | Invalid {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'invalid_body', message: 'Expected a JSON object.' };
  }
  return { value: (body as Record<string, unknown>)[field] };
}

/** Textarea line endings differ by platform; the stored text never carries them. */
function normalise(value: string): string {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
}
