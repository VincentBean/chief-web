import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
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
  MIGRATIONS,
  openDatabase,
  type Repository,
  runMigrations,
  type SentryIssueStatus,
  updateRepository,
  updateSentryIssue,
} from './index.js';

/** The migration under test in 'sends the old \`queued\` rows back to pending'. */
const PLANS_MIGRATION = '0015_sentry_issue_plans';

/** The one timestamp every hand-written legacy row is stamped with. */
const at = '2026-09-01T00:00:00.000Z';

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
    assert.equal(issue.plan, null);
    assert.equal(issue.planProposedAt, null);
    assert.equal(issue.planDecidedAt, null);
    assert.equal(issue.sessionId, null);
    assert.equal(issue.resolveUpstream, false);
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
    updateSentryIssue(db, issue.id, { status: 'planned', attempts: 1 });

    const again = issueFor('4004', { eventCount: 900, lastSeen: '2026-09-05T10:00:00.000Z' });

    assert.equal(again.status, 'planned');
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

    const planned = updateSentryIssue(db, issue.id, {
      status: 'planned',
      plan: 'Guard the null booking before the controller reads its id.',
      planProposedAt: '2026-09-05T08:00:00.000Z',
      attempts: 0,
    });
    assert.equal(planned?.status, 'planned');
    assert.equal(planned?.plan, 'Guard the null booking before the controller reads its id.');
    assert.equal(planned?.planProposedAt, '2026-09-05T08:00:00.000Z');
    // Proposed but undecided: nobody has said yes or no yet.
    assert.equal(planned?.planDecidedAt, null);
    assert.equal(planned?.resolveUpstream, false);

    const approved = updateSentryIssue(db, issue.id, {
      status: 'approved',
      planDecidedAt: '2026-09-05T09:00:00.000Z',
    });
    assert.equal(approved?.status, 'approved');
    assert.equal(approved?.planDecidedAt, '2026-09-05T09:00:00.000Z');

    const working = updateSentryIssue(db, issue.id, {
      status: 'working',
      sessionId: session.id,
    });
    assert.equal(working?.status, 'working');
    assert.equal(working?.sessionId, session.id);
    assert.equal(findSentryIssueBySession(db, session.id)?.id, issue.id);

    const fixed = updateSentryIssue(db, issue.id, { status: 'fixed', resolveUpstream: true });
    assert.equal(fixed?.status, 'fixed');
    // Resolving upstream is two separate flags: one says Sentry is owed the
    // call, the other says it has been made. A failed call retries later and
    // must never revert the status.
    assert.equal(fixed?.resolveUpstream, true);
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

  it('queues the issues Sentry has not been told about, oldest first', () => {
    const older = issueFor('4021');
    const newer = issueFor('4022');
    const reported = issueFor('4023');
    const untouched = issueFor('4024');
    updateSentryIssue(db, newer.id, { status: 'fixed', resolveUpstream: true });
    updateSentryIssue(db, older.id, { status: 'fixed', resolveUpstream: true });
    updateSentryIssue(db, reported.id, {
      status: 'fixed',
      resolveUpstream: true,
      resolvedInSentry: true,
    });
    // A `cannot_fix` the classifier reached on its own: nothing is owed, so
    // the flag is what keeps it off the list, not the status.
    updateSentryIssue(db, untouched.id, {
      status: 'cannot_fix',
      explanation: 'not a code problem',
    });

    const awaiting = listSentryIssuesAwaitingResolve(db).filter(
      (issue) => issue.repositoryId === repository.id,
    );

    assert.deepEqual(
      awaiting.map((issue) => issue.sentryIssueId),
      [older.sentryIssueId, newer.sentryIssueId],
    );
  });

  it('queues a rejected plan for the same resolve pass a fix goes through', () => {
    // A rejection is `cannot_fix`, but Sentry is still owed the call so the
    // issue stops arriving in the poll -- which is exactly why the flag is not
    // the status.
    const rejected = issueFor('4025');
    updateSentryIssue(db, rejected.id, {
      status: 'cannot_fix',
      explanation: 'plan rejected: the culprit is a vendor package',
      planDecidedAt: '2026-09-05T10:00:00.000Z',
      resolveUpstream: true,
    });

    const awaiting = listSentryIssuesAwaitingResolve(db).filter(
      (issue) => issue.repositoryId === repository.id,
    );
    assert.deepEqual(
      awaiting.map((issue) => issue.sentryIssueId),
      [rejected.sentryIssueId],
    );
  });

  it('lists the two decision statuses the operator moves an issue through', () => {
    // The plan pass reads `planned`, and the operator-triggered session pass
    // reads `approved`; both are oldest first, like the classifier's queue.
    const older = issueFor('4012');
    const newer = issueFor('4013');
    const approved = issueFor('4014');
    updateSentryIssue(db, older.id, { status: 'planned', plan: 'Guard the null booking.' });
    updateSentryIssue(db, newer.id, { status: 'planned', plan: 'Widen the date parser.' });
    updateSentryIssue(db, approved.id, { status: 'approved' });

    const mine = (status: SentryIssueStatus) =>
      listSentryIssuesByStatus(db, status)
        .filter((issue) => issue.repositoryId === repository.id)
        .map((issue) => issue.sentryIssueId);

    assert.deepEqual(mine('planned'), [older.sentryIssueId, newer.sentryIssueId]);
    assert.deepEqual(mine('approved'), [approved.sentryIssueId]);
  });

  it('sends the old `queued` rows back to pending and leaves the rest alone', () => {
    // `0015` rebuilds `sentry_issues` to widen the status CHECK, so this walks
    // a database up to the migration before it, puts one row of every old
    // status in, and then applies it. A `queued` row was judged fixable under
    // the old flow but has no plan and no approval, so it goes back to
    // `pending` for the triage pass to propose one; everything else, and every
    // other column, has to come out the other side untouched.
    const legacy = new DatabaseSync(IN_MEMORY) as Database;
    legacy.exec('PRAGMA foreign_keys = ON');
    legacy.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);');

    const index = MIGRATIONS.findIndex((migration) => migration.id === PLANS_MIGRATION);
    assert.ok(index > 0, `${PLANS_MIGRATION} is missing`);
    for (const migration of MIGRATIONS.slice(0, index)) {
      legacy.exec(migration.sql);
      legacy.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
        migration.id,
        at,
      );
    }

    legacy
      .prepare(
        `INSERT INTO repositories
           (id, name, ssh_url, github_slug, default_base_branch, created_at, updated_at)
         VALUES ('r1', 'leo', 'git@github.com:VincentBean/leo.git', 'VincentBean/leo',
                 'develop', ?, ?)`,
      )
      .run(at, at);
    legacy
      .prepare(
        `INSERT INTO sessions
           (id, repository_id, name, status, base_branch, feature_branch, pr_target_branch,
            created_at, updated_at)
         VALUES ('s1', 'r1', 'sentry-leo-5002', 'building', 'develop', 'chief/sentry-5002',
                 'develop', ?, ?)`,
      )
      .run(at, at);

    const legacyIssue = (
      sentryIssueId: string,
      status: string,
      columns: {
        readonly explanation?: string | null;
        readonly sessionId?: string | null;
        readonly resolvedInSentry?: number;
        readonly attempts?: number;
      } = {},
    ) => {
      legacy
        .prepare(
          `INSERT INTO sentry_issues
             (id, repository_id, sentry_issue_id, short_id, title, culprit, permalink, level,
              event_count, first_seen, last_seen, status, explanation, session_id,
              resolved_in_sentry, attempts, created_at, updated_at)
           VALUES (?, 'r1', ?, ?, 'TypeError', NULL, ?, 'error', 7, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `i-${sentryIssueId}`,
          sentryIssueId,
          `LEO-${sentryIssueId}`,
          `https://boeq.sentry.io/issues/${sentryIssueId}/`,
          at,
          at,
          status,
          columns.explanation ?? null,
          columns.sessionId ?? null,
          columns.resolvedInSentry ?? 0,
          columns.attempts ?? 0,
          at,
          at,
        );
    };

    legacyIssue('5001', 'queued', { attempts: 2 });
    legacyIssue('5002', 'working', { sessionId: 's1', attempts: 1 });
    legacyIssue('5003', 'fixed');
    legacyIssue('5004', 'fixed', { resolvedInSentry: 1 });
    legacyIssue('5005', 'cannot_fix', { explanation: 'not a code problem', attempts: 3 });
    legacyIssue('5006', 'pending');

    assert.ok(runMigrations(legacy).includes(PLANS_MIGRATION));

    // The one row the migration rewrites: fixable under the old flow, but with
    // no plan anyone ever saw, so it goes back for a proposal.
    const rewritten = findSentryIssue(legacy, '5001');
    assert.equal(rewritten?.status, 'pending');
    assert.equal(rewritten?.plan, null);
    assert.equal(rewritten?.planProposedAt, null);
    assert.equal(rewritten?.planDecidedAt, null);
    assert.equal(rewritten?.resolveUpstream, false);
    // Even the attempt count survives; only the status is touched.
    assert.equal(rewritten?.attempts, 2);

    // Everything downstream of the classifier is left exactly as it was.
    const working = findSentryIssue(legacy, '5002');
    assert.equal(working?.status, 'working');
    assert.equal(working?.sessionId, 's1');
    assert.equal(working?.attempts, 1);

    const cannotFix = findSentryIssue(legacy, '5005');
    assert.equal(cannotFix?.status, 'cannot_fix');
    assert.equal(cannotFix?.explanation, 'not a code problem');
    assert.equal(cannotFix?.attempts, 3);
    // A classifier verdict owes Sentry nothing; only a rejection would.
    assert.equal(cannotFix?.resolveUpstream, false);

    assert.equal(findSentryIssue(legacy, '5006')?.status, 'pending');

    // Every `fixed` row is backfilled, so the resolve pass -- which now reads
    // the flag rather than the status -- still owes Sentry the call it owed
    // before, and still skips the one already reported.
    assert.equal(findSentryIssue(legacy, '5003')?.resolveUpstream, true);
    assert.equal(findSentryIssue(legacy, '5003')?.resolvedInSentry, false);
    assert.equal(findSentryIssue(legacy, '5004')?.resolveUpstream, true);
    assert.deepEqual(
      listSentryIssuesAwaitingResolve(legacy).map((issue) => issue.sentryIssueId),
      ['5003'],
    );

    // The widened CHECK takes the two new statuses and still refuses the old one.
    assert.equal(updateSentryIssue(legacy, 'i-5006', { status: 'planned' })?.status, 'planned');
    assert.equal(updateSentryIssue(legacy, 'i-5006', { status: 'approved' })?.status, 'approved');
    assert.throws(
      () => legacy.prepare('UPDATE sentry_issues SET status = ? WHERE id = ?').run('queued', 'i-5006'),
      /CHECK/i,
    );

    // The indexes travelled with the rebuilt table, and so did the cascade.
    const indexes = legacy
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sentry_issues'")
      .all()
      .map((row) => row['name']);
    for (const name of [
      'idx_sentry_issues_repository',
      'idx_sentry_issues_status',
      'idx_sentry_issues_session',
    ]) {
      assert.ok(indexes.includes(name), `missing index ${name}`);
    }

    closeDatabase(legacy);
  });

  it('takes the issues with the repository they belong to', () => {
    const issue = issueFor('4011');
    // No sessions on this repository, so the RESTRICT on sessions does not bite.
    db.prepare('DELETE FROM repositories WHERE id = ?').run(repository.id);

    assert.equal(findSentryIssue(db, issue.sentryIssueId), null);
  });
});
