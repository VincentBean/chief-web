import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  closeDatabase,
  createRepository,
  createSentryIssue,
  createSession,
  type Database,
  deleteSession,
  findSentryIssue,
  findSentryIssueBySession,
  IN_MEMORY,
  listSentryIssues,
  listSentryIssuesAwaitingResolve,
  listSentryIssuesByStatus,
  listSentryIssuesForRepository,
  openDatabase,
  type Repository,
  updateRepository,
  updateSentryIssue,
} from './index.js';

describe('sentry issues', () => {
  let db: Database;
  let repository: Repository;
  let seq = 0;

  before(() => {
    db = openDatabase(IN_MEMORY);
  });

  after(() => {
    closeDatabase(db);
  });

  beforeEach(() => {
    seq += 1;
    repository = createRepository(db, {
      name: `leo-${String(seq)}`,
      sshUrl: 'git@github.com:VincentBean/leo.git',
      githubSlug: 'VincentBean/leo',
      defaultBaseBranch: 'develop',
      sentryOrg: 'boeq',
      sentryProject: 'leo-backend',
    });
  });

  const issueFor = (sentryIssueId: string, overrides: Record<string, unknown> = {}) =>
    createSentryIssue(db, {
      repositoryId: repository.id,
      sentryIssueId,
      shortId: `LEO-BACKEND-${sentryIssueId}`,
      title: 'TypeError: Cannot read properties of undefined',
      culprit: 'app/Http/Controllers/BookingController.php in store',
      permalink: `https://boeq.sentry.io/issues/${sentryIssueId}/`,
      level: 'error',
      eventCount: 12,
      firstSeen: '2026-09-01T08:00:00.000Z',
      lastSeen: '2026-09-04T18:30:00.000Z',
      ...overrides,
    });

  it('carries the repository link on the repository row', () => {
    assert.equal(repository.sentryOrg, 'boeq');
    assert.equal(repository.sentryProject, 'leo-backend');

    // Unlinking is clearing both slugs, which is the shape the DB stores too.
    const unlinked = updateRepository(db, repository.id, {
      sentryOrg: null,
      sentryProject: null,
    });
    assert.equal(unlinked?.sentryOrg, null);
    assert.equal(unlinked?.sentryProject, null);
  });

  it('inserts a freshly fetched issue as pending, with nothing attempted', () => {
    const issue = issueFor('4001');

    assert.equal(issue.status, 'pending');
    assert.equal(issue.attempts, 0);
    assert.equal(issue.explanation, null);
    assert.equal(issue.sessionId, null);
    assert.equal(issue.resolvedInSentry, false);
    assert.equal(issue.eventCount, 12);
    assert.equal(issue.shortId, 'LEO-BACKEND-4001');
    assert.deepEqual(findSentryIssue(db, '4001'), issue);
    assert.equal(listSentryIssuesForRepository(db, repository.id).length, 1);
  });

  it('keeps a nullable culprit and level', () => {
    // Sentry omits both for plenty of issue types; the poller must not choke.
    const issue = issueFor('4002', { culprit: null, level: null });

    assert.equal(issue.culprit, null);
    assert.equal(issue.level, null);
  });

  it('adopts the row an issue already has instead of duplicating it', () => {
    const first = issueFor('4003');
    const again = issueFor('4003', {
      title: 'TypeError: Cannot read properties of undefined (reading "id")',
      eventCount: 47,
      lastSeen: '2026-09-05T09:15:00.000Z',
    });

    assert.equal(again.id, first.id);
    assert.equal(listSentryIssuesForRepository(db, repository.id).length, 1);
    // A re-poll picks up whatever moved on Sentry's side.
    assert.equal(again.eventCount, 47);
    assert.equal(again.lastSeen, '2026-09-05T09:15:00.000Z');
    assert.equal(again.title, 'TypeError: Cannot read properties of undefined (reading "id")');
    // …but never the first sighting, which is what "new to us" was judged on.
    assert.equal(again.firstSeen, first.firstSeen);
  });

  it('leaves the pipeline state alone when an issue is seen again', () => {
    // An issue already being fixed must not fall back to `pending` because it
    // fired one more event between two ticks.
    const issue = issueFor('4004');
    updateSentryIssue(db, issue.id, { status: 'queued', attempts: 1 });

    const again = issueFor('4004', { eventCount: 900, lastSeen: '2026-09-05T10:00:00.000Z' });

    assert.equal(again.status, 'queued');
    assert.equal(again.attempts, 1);
    assert.equal(again.eventCount, 900);
  });

  it('walks an issue from pending through to fixed', () => {
    const issue = issueFor('4005');
    const session = createSession(db, {
      repositoryId: repository.id,
      name: 'sentry-leo-backend-4005',
      baseBranch: 'develop',
      prTargetBranch: 'develop',
      codeReview: true,
    });

    const queued = updateSentryIssue(db, issue.id, { status: 'queued', attempts: 0 });
    assert.equal(queued?.status, 'queued');

    const working = updateSentryIssue(db, issue.id, {
      status: 'working',
      sessionId: session.id,
    });
    assert.equal(working?.status, 'working');
    assert.equal(working?.sessionId, session.id);
    assert.equal(findSentryIssueBySession(db, session.id)?.id, issue.id);

    const fixed = updateSentryIssue(db, issue.id, { status: 'fixed' });
    assert.equal(fixed?.status, 'fixed');
    // Resolving upstream is a separate flag: a failed call retries later and
    // must never revert the status.
    assert.equal(fixed?.resolvedInSentry, false);

    const resolved = updateSentryIssue(db, issue.id, { resolvedInSentry: true });
    assert.equal(resolved?.resolvedInSentry, true);
    assert.equal(resolved?.status, 'fixed');
  });

  it('records why an issue cannot be fixed', () => {
    const issue = issueFor('4006');
    const verdict = updateSentryIssue(db, issue.id, {
      status: 'cannot_fix',
      explanation: 'The error comes from a third-party outage, not from our code.',
    });

    assert.equal(verdict?.status, 'cannot_fix');
    assert.equal(
      verdict?.explanation,
      'The error comes from a third-party outage, not from our code.',
    );
  });

  it('refuses a status the pipeline does not have', () => {
    const issue = issueFor('4007');

    assert.throws(
      () => updateSentryIssue(db, issue.id, { status: 'resolved' as never }),
      /CHECK constraint failed/,
    );
  });

  it('keeps the issue when its session is deleted', () => {
    // ON DELETE SET NULL, not CASCADE: erasing the row would let the poller
    // ingest the same issue all over again.
    const issue = issueFor('4008');
    const session = createSession(db, {
      repositoryId: repository.id,
      name: 'sentry-leo-backend-4008',
      baseBranch: 'develop',
      prTargetBranch: 'develop',
    });
    updateSentryIssue(db, issue.id, { status: 'working', sessionId: session.id });

    deleteSession(db, session.id);

    const orphan = findSentryIssue(db, '4008');
    assert.equal(orphan?.sessionId, null);
    assert.equal(orphan?.status, 'working');
  });

  it('hands the classifier its queue oldest first, and the tab newest first', () => {
    const older = issueFor('4009', { lastSeen: '2026-09-02T00:00:00.000Z' });
    const newer = issueFor('4010', { lastSeen: '2026-09-05T00:00:00.000Z' });

    const pending = listSentryIssuesByStatus(db, 'pending').filter(
      (issue) => issue.repositoryId === repository.id,
    );
    assert.deepEqual(
      pending.map((issue) => issue.sentryIssueId),
      [older.sentryIssueId, newer.sentryIssueId],
    );

    const listed = listSentryIssues(db).filter(
      (issue) => issue.repositoryId === repository.id,
    );
    assert.deepEqual(
      listed.map((issue) => issue.sentryIssueId),
      [newer.sentryIssueId, older.sentryIssueId],
    );
  });

  it('queues the fixed issues Sentry has not been told about, oldest first', () => {
    const older = issueFor('4021');
    const newer = issueFor('4022');
    const reported = issueFor('4023');
    updateSentryIssue(db, newer.id, { status: 'fixed' });
    updateSentryIssue(db, older.id, { status: 'fixed' });
    updateSentryIssue(db, reported.id, { status: 'fixed', resolvedInSentry: true });

    const awaiting = listSentryIssuesAwaitingResolve(db).filter(
      (issue) => issue.repositoryId === repository.id,
    );

    assert.deepEqual(
      awaiting.map((issue) => issue.sentryIssueId),
      [older.sentryIssueId, newer.sentryIssueId],
    );
  });

  it('takes the issues with the repository they belong to', () => {
    const issue = issueFor('4011');
    // No sessions on this repository, so the RESTRICT on sessions does not bite.
    db.prepare('DELETE FROM repositories WHERE id = ?').run(repository.id);

    assert.equal(findSentryIssue(db, issue.sentryIssueId), null);
  });
});
