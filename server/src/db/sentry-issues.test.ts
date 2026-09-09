import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  closeDatabase,
  createRepository,
  createSentryIssue,
  createSession,
  type Database,
  deleteSession,
  DUPLICATE_LOOKBACK_DAYS,
  findSentryIssue,
  findSentryIssueBySession,
  IN_MEMORY,
  listSentryDuplicateCandidates,
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
    const original = issueFor('4098');
    const issue = issueFor('4004');
    updateSentryIssue(db, issue.id, {
      status: 'queued',
      attempts: 1,
      // A classification is about the defect, so it outlives every later poll.
      duplicateOf: original.id,
      signature: 'TypeError|BookingController::store',
    });

    const again = issueFor('4004', { eventCount: 900, lastSeen: '2026-09-05T10:00:00.000Z' });

    assert.equal(again.status, 'queued');
    assert.equal(again.attempts, 1);
    assert.equal(again.eventCount, 900);
    assert.equal(again.duplicateOf, original.id);
    assert.equal(again.signature, 'TypeError|BookingController::store');
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

  /** Ages a row the way the passing of days would, so the window is testable. */
  const ageBy = (id: string, days: number) => {
    const at = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE sentry_issues SET updated_at = ? WHERE id = ?').run(at, id);
  };

  it('offers as duplicate candidates only the work that is in flight, newest first', () => {
    const subject = issueFor('4030');
    const queued = issueFor('4031');
    const working = issueFor('4032');
    const fixed = issueFor('4033');
    const pending = issueFor('4034');
    const cannotFix = issueFor('4035');
    const duplicate = issueFor('4036');

    updateSentryIssue(db, queued.id, { status: 'queued' });
    updateSentryIssue(db, working.id, { status: 'working' });
    updateSentryIssue(db, fixed.id, { status: 'fixed' });
    updateSentryIssue(db, cannotFix.id, { status: 'cannot_fix', explanation: 'upstream' });
    updateSentryIssue(db, duplicate.id, { status: 'duplicate', duplicateOf: working.id });
    ageBy(queued.id, 1);
    ageBy(working.id, 2);
    ageBy(fixed.id, DUPLICATE_LOOKBACK_DAYS - 1);

    const candidates = listSentryDuplicateCandidates(db, repository.id, {
      excludeId: subject.id,
    });

    assert.deepEqual(
      candidates.map((issue) => issue.sentryIssueId),
      [queued.sentryIssueId, working.sentryIssueId, fixed.sentryIssueId],
    );
    for (const excluded of [pending, cannotFix, duplicate]) {
      assert.ok(!candidates.some((issue) => issue.id === excluded.id));
    }
  });

  it('drops a fixed issue out of the candidates once the lookback window passes', () => {
    const subject = issueFor('4040');
    const stale = issueFor('4041');
    updateSentryIssue(db, stale.id, { status: 'fixed' });
    ageBy(stale.id, DUPLICATE_LOOKBACK_DAYS + 1);

    const candidates = listSentryDuplicateCandidates(db, repository.id, {
      excludeId: subject.id,
    });

    assert.deepEqual(candidates, []);
  });

  it('keeps duplicate candidates inside their own repository', () => {
    const other = createRepository(db, {
      name: `leo-other-${String(seq)}`,
      sshUrl: 'git@github.com:VincentBean/leo.git',
      githubSlug: 'VincentBean/leo',
      defaultBaseBranch: 'develop',
      sentryOrg: 'boeq',
      sentryProject: 'leo-frontend',
    });
    const subject = issueFor('4050');
    const elsewhere = issueFor('4051', { repositoryId: other.id });
    updateSentryIssue(db, elsewhere.id, { status: 'working' });

    const candidates = listSentryDuplicateCandidates(db, repository.id, {
      excludeId: subject.id,
    });

    assert.deepEqual(candidates, []);
  });

  it('never offers the issue being classified as its own duplicate', () => {
    const subject = issueFor('4060');
    updateSentryIssue(db, subject.id, { status: 'working' });

    const candidates = listSentryDuplicateCandidates(db, repository.id, {
      excludeId: subject.id,
    });

    assert.deepEqual(candidates, []);
    // Any other issue's classification still sees it.
    const other = issueFor('4061');
    assert.deepEqual(
      listSentryDuplicateCandidates(db, repository.id, { excludeId: other.id }).map(
        (issue) => issue.id,
      ),
      [subject.id],
    );
  });

  it('stores the duplicate link and the signature the classifier wrote', () => {
    const original = issueFor('4070');
    const copy = issueFor('4071');

    const linked = updateSentryIssue(db, copy.id, {
      status: 'duplicate',
      duplicateOf: original.id,
      signature: 'TypeError|BookingController::store',
      explanation: 'Same defect as LEO-BACKEND-4070.',
    });

    assert.equal(linked?.status, 'duplicate');
    assert.equal(linked?.duplicateOf, original.id);
    assert.equal(linked?.signature, 'TypeError|BookingController::store');
    assert.equal(findSentryIssue(db, '4071')?.duplicateOf, original.id);
    // A fresh row carries neither until something classifies it.
    assert.equal(original.duplicateOf, null);
    assert.equal(original.signature, null);
  });

  it('takes the issues with the repository they belong to', () => {
    const issue = issueFor('4011');
    // No sessions on this repository, so the RESTRICT on sessions does not bite.
    db.prepare('DELETE FROM repositories WHERE id = ?').run(repository.id);

    assert.equal(findSentryIssue(db, issue.sentryIssueId), null);
  });
});
