import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import {
  closeDatabase,
  createRepository,
  createSentryIssue,
  createSession,
  type Database,
  deleteSession,
  featureBranchFor,
  getSentryIssue,
  IN_MEMORY,
  openDatabase,
  type Repository,
  type SentryIssue,
  type Session,
  type SessionStatus,
  setSetting,
  updateRepository,
  updateSentryIssue,
  updateSession,
} from '../db/index.js';

import { SentryApiError } from './client.js';
import { SentryCompletionService, type SentryResolveGateway } from './complete.js';

const databases: Database[] = [];

after(() => {
  for (const db of databases) closeDatabase(db);
});

/**
 * Stands in for `PUT /organizations/{org}/issues/{id}/`. Every call is
 * recorded, so a test can assert both what was reported and — for the retry —
 * how many times it was tried.
 */
class FakeSentry implements SentryResolveGateway {
  readonly calls: { org: string; issueId: string }[] = [];
  /** Thrown instead of answering, until {@link recover} clears it. */
  private failure: Error | null = null;

  resolveIssue(org: string, issueId: string): Promise<void> {
    this.calls.push({ org, issueId });
    if (this.failure !== null) return Promise.reject(this.failure);
    return Promise.resolve();
  }

  fail(error: Error): void {
    this.failure = error;
  }

  recover(): void {
    this.failure = null;
  }
}

interface World {
  readonly db: Database;
  readonly sentry: FakeSentry;
  readonly completer: SentryCompletionService;
  readonly repository: Repository;
  /** A `working` issue with a session behind it, in whatever state is asked. */
  working(options?: {
    status?: SessionStatus;
    prUrl?: string | null;
    lastError?: string | null;
    failureStage?: Session['failureStage'];
  }): { issue: SentryIssue; session: Session };
  issue(fields?: Partial<SentryIssue>): SentryIssue;
  reload(issue: SentryIssue): SentryIssue;
}

let names = 0;

function world(options: { token?: string | null } = {}): World {
  const db = openDatabase(IN_MEMORY);
  databases.push(db);
  if (options.token !== null) setSetting(db, 'sentry_token', options.token ?? 'sntrys_token');

  const repository = createRepository(db, {
    name: 'demo',
    sshUrl: 'git@github.com:acme/demo.git',
    githubSlug: 'acme/demo',
    sentryOrg: 'acme',
    sentryProject: 'web',
  });

  const sentry = new FakeSentry();
  // Mirrors the real factory: no token configured means no client at all.
  const completer = new SentryCompletionService(db, (database) =>
    hasToken(database) ? sentry : null,
  );

  function issue(fields: Partial<SentryIssue> = {}): SentryIssue {
    const created = createSentryIssue(db, {
      repositoryId: repository.id,
      sentryIssueId: fields.sentryIssueId ?? `450${(names += 1)}`,
      shortId: fields.shortId ?? `PROJ-${names}`,
      title: 'TypeError: cannot read property x of undefined',
      permalink: 'https://sentry.io/organizations/acme/issues/4507/',
      firstSeen: '2026-08-01T10:00:00.000Z',
      lastSeen: '2026-09-04T22:15:00.000Z',
    });
    const { id: _id, ...rest } = fields;
    return updateSentryIssue(db, created.id, rest) ?? created;
  }

  return {
    db,
    sentry,
    completer,
    repository,
    issue,
    working(session = {}) {
      const name = `sentry-fix-${(names += 1)}`;
      const row = createSession(db, {
        repositoryId: repository.id,
        name,
        baseBranch: 'main',
        prTargetBranch: 'main',
        featureBranch: featureBranchFor(name),
        status: 'pr-open',
        scheduledStartAt: null,
        codeReview: true,
      });
      const updated =
        updateSession(db, row.id, {
          status: session.status ?? 'pr-open',
          prUrl: session.prUrl === undefined ? 'https://github.com/acme/demo/pull/42' : session.prUrl,
          lastError: session.lastError ?? null,
          failureStage: session.failureStage ?? null,
        }) ?? row;
      return {
        issue: issue({ status: 'working', sessionId: updated.id }),
        session: updated,
      };
    },
    reload(row) {
      const found = getSentryIssue(db, row.id);
      assert.ok(found, 'the issue should still exist');
      return found;
    },
  };
}

function hasToken(db: Database): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'sentry_token'").get();
  return row !== undefined && row !== null;
}

describe('the Sentry completion watcher', () => {
  beforeEach(() => {
    names = 0;
  });

  describe('a merged session', () => {
    it('marks the issue fixed and resolves it in Sentry', async () => {
      const w = world();
      const { issue } = w.working({ status: 'merged' });

      assert.equal(await w.completer.trackCompletions(), 1);

      const after = w.reload(issue);
      assert.equal(after.status, 'fixed');
      assert.equal(after.explanation, null);
      assert.equal(after.resolvedInSentry, true);
      assert.deepEqual(w.sentry.calls, [{ org: 'acme', issueId: issue.sentryIssueId }]);
    });

    it('keeps the link to the session that did it', async () => {
      const w = world();
      const { issue, session } = w.working({ status: 'merged' });

      await w.completer.trackCompletions();

      assert.equal(w.reload(issue).sessionId, session.id);
    });

    it('does nothing to an issue whose session is still open', async () => {
      const w = world();
      const { issue } = w.working({ status: 'pr-open' });

      assert.equal(await w.completer.trackCompletions(), 0);

      assert.equal(w.reload(issue).status, 'working');
      assert.deepEqual(w.sentry.calls, []);
    });

    it('leaves the other in-flight statuses alone', async () => {
      const w = world();
      const inFlight: SessionStatus[] = [
        'pending',
        'ready',
        'building',
        'waiting',
        'reviewing',
        'fixing',
        'pr-open',
      ];
      const issues = inFlight.map((status) => w.working({ status }).issue);

      assert.equal(await w.completer.trackCompletions(), 0);

      for (const issue of issues) assert.equal(w.reload(issue).status, 'working');
    });

    it('reports it only once', async () => {
      const w = world();
      w.working({ status: 'merged' });

      assert.equal(await w.completer.trackCompletions(), 1);
      assert.equal(await w.completer.trackCompletions(), 0);

      assert.equal(w.sentry.calls.length, 1);
    });
  });

  describe('resolving in Sentry', () => {
    it('retries on the next tick when the call failed, without reverting the fix', async () => {
      const w = world();
      const { issue } = w.working({ status: 'merged' });
      w.sentry.fail(new SentryApiError('sentry_unreachable', 'Sentry is unreachable'));

      await w.completer.trackCompletions();

      // The pull request is merged whatever Sentry's API did.
      const failed = w.reload(issue);
      assert.equal(failed.status, 'fixed');
      assert.equal(failed.resolvedInSentry, false);
      assert.equal(w.sentry.calls.length, 1);

      // Nothing changed status this tick, but the call is owed and made again.
      assert.equal(await w.completer.trackCompletions(), 0);
      assert.equal(w.sentry.calls.length, 2);
      assert.equal(w.reload(issue).resolvedInSentry, false);

      w.sentry.recover();
      await w.completer.trackCompletions();

      assert.equal(w.sentry.calls.length, 3);
      const resolved = w.reload(issue);
      assert.equal(resolved.status, 'fixed');
      assert.equal(resolved.resolvedInSentry, true);

      // And once it is through, no further calls are made.
      await w.completer.trackCompletions();
      assert.equal(w.sentry.calls.length, 3);
    });

    it('picks up a fix that was marked before this feature could report it', async () => {
      const w = world();
      const issue = w.issue({ status: 'fixed', resolvedInSentry: false });

      assert.equal(await w.completer.trackCompletions(), 0);

      assert.deepEqual(w.sentry.calls, [{ org: 'acme', issueId: issue.sentryIssueId }]);
      assert.equal(w.reload(issue).resolvedInSentry, true);
    });

    it('still marks a merge fixed when no Sentry token is configured', async () => {
      const w = world({ token: null });
      const { issue } = w.working({ status: 'merged' });

      assert.equal(await w.completer.trackCompletions(), 1);

      const after = w.reload(issue);
      assert.equal(after.status, 'fixed');
      assert.equal(after.resolvedInSentry, false);
      assert.deepEqual(w.sentry.calls, []);
    });

    it('skips an issue whose repository was unlinked, and reports it once relinked', async () => {
      const w = world();
      const { issue } = w.working({ status: 'merged' });
      updateRepository(w.db, w.repository.id, { sentryOrg: null, sentryProject: null });

      await w.completer.trackCompletions();

      assert.deepEqual(w.sentry.calls, []);
      assert.equal(w.reload(issue).status, 'fixed');

      updateRepository(w.db, w.repository.id, { sentryOrg: 'acme', sentryProject: 'web' });
      await w.completer.trackCompletions();

      assert.deepEqual(w.sentry.calls, [{ org: 'acme', issueId: issue.sentryIssueId }]);
      assert.equal(w.reload(issue).resolvedInSentry, true);
    });

    it('carries on to the next issue when one resolve call fails', async () => {
      const w = world();
      const first = w.issue({ status: 'fixed' });
      const second = w.issue({ status: 'fixed' });
      let calls = 0;
      const flaky: SentryResolveGateway = {
        resolveIssue(_org, issueId) {
          calls += 1;
          return issueId === first.sentryIssueId
            ? Promise.reject(new SentryApiError('sentry_error', 'boom'))
            : Promise.resolve();
        },
      };
      const completer = new SentryCompletionService(w.db, () => flaky);

      await completer.trackCompletions();

      assert.equal(calls, 2);
      assert.equal(w.reload(first).resolvedInSentry, false);
      assert.equal(w.reload(second).resolvedInSentry, true);
    });
  });

  describe('a session that ended without a merge', () => {
    it('gives up on the issue when the session failed, naming the stage', async () => {
      const w = world();
      const { issue } = w.working({
        status: 'failed',
        failureStage: 'review',
        lastError: 'the review agent stalled',
      });

      assert.equal(await w.completer.trackCompletions(), 1);

      const after = w.reload(issue);
      assert.equal(after.status, 'cannot_fix');
      assert.equal(
        after.explanation,
        'build session failed at the code review stage: the review agent stalled',
      );
      assert.equal(after.resolvedInSentry, false);
      assert.deepEqual(w.sentry.calls, []);
    });

    it('says what it can when the failure recorded no stage or error', async () => {
      const w = world();
      const { issue } = w.working({ status: 'failed' });

      await w.completer.trackCompletions();

      assert.equal(w.reload(issue).explanation, 'build session failed');
    });

    it('names the pull request that was closed without merging', async () => {
      const w = world();
      const { issue } = w.working({
        status: 'finished',
        prUrl: 'https://github.com/acme/demo/pull/42',
      });

      assert.equal(await w.completer.trackCompletions(), 1);

      const after = w.reload(issue);
      assert.equal(after.status, 'cannot_fix');
      assert.equal(after.explanation, 'PR #42 closed without merging');
    });

    it('says so when the session never opened a pull request at all', async () => {
      const w = world();
      const { issue } = w.working({ status: 'finished', prUrl: null });

      await w.completer.trackCompletions();

      const after = w.reload(issue);
      assert.equal(after.status, 'cannot_fix');
      assert.equal(after.explanation, 'build session ended without opening a pull request');
    });
  });

  describe('a session that was deleted', () => {
    it('keeps the issue and gives up on it', async () => {
      const w = world();
      const { issue, session } = w.working({ status: 'building' });

      // `ON DELETE SET NULL`: the row outlives the session, minus the link.
      deleteSession(w.db, session.id);
      const orphaned = w.reload(issue);
      assert.equal(orphaned.sessionId, null);
      assert.equal(orphaned.status, 'working');

      assert.equal(await w.completer.trackCompletions(), 1);

      const after = w.reload(issue);
      assert.equal(after.status, 'cannot_fix');
      assert.equal(after.explanation, 'session was deleted');
      assert.deepEqual(w.sentry.calls, []);
    });

    it('leaves an already fixed issue alone when its session is deleted', async () => {
      const w = world();
      const { issue, session } = w.working({ status: 'merged' });
      await w.completer.trackCompletions();

      deleteSession(w.db, session.id);
      assert.equal(await w.completer.trackCompletions(), 0);

      const after = w.reload(issue);
      assert.equal(after.status, 'fixed');
      assert.equal(after.resolvedInSentry, true);
    });
  });

  it('does nothing at all when no issue is working or awaiting a resolve', async () => {
    const w = world();
    w.issue({ status: 'pending' });
    w.issue({ status: 'queued' });
    w.issue({ status: 'cannot_fix', explanation: 'not a code problem' });
    w.issue({ status: 'fixed', resolvedInSentry: true });

    assert.equal(await w.completer.trackCompletions(), 0);

    assert.deepEqual(w.sentry.calls, []);
  });
});
