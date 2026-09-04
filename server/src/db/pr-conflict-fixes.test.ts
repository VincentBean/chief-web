import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  clearInterruptedPrConflictFixes,
  closeDatabase,
  countActivePrConflictFixes,
  createPrConflictFix,
  createRepository,
  type Database,
  deletePrConflictFix,
  findPrConflictFix,
  getPrConflictFix,
  hasStandingFailure,
  IN_MEMORY,
  listPrConflictFixes,
  MIGRATIONS,
  openDatabase,
  prConflictFixFailureStageLabel,
  type Repository,
  runMigrations,
  updatePrConflictFix,
} from './index.js';

const CONFLICT_FIXES_MIGRATION = '0010_pr_conflict_fixes';

describe('pull request conflict fixes', () => {
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
    });
  });

  const fixFor = (prNumber: number, headSha = 'head1111', baseSha = 'base1111') =>
    createPrConflictFix(db, {
      repositoryId: repository.id,
      prNumber,
      prUrl: `https://github.com/VincentBean/leo/pull/${String(prNumber)}`,
      prTitle: `PR ${String(prNumber)}`,
      headBranch: 'chief/booking-proposal-fields',
      baseBranch: 'develop',
      headSha,
      baseSha,
    });

  it('starts running, with no attempt spent, for the two SHAs it was seen at', () => {
    const fix = fixFor(61);

    assert.equal(fix.status, 'running');
    assert.equal(fix.attempts, 0);
    assert.equal(fix.headSha, 'head1111');
    assert.equal(fix.baseSha, 'base1111');
    assert.equal(fix.failureStage, null);
    assert.equal(fix.lastError, null);
    assert.equal(fix.mergeSha, null);
    assert.deepEqual(getPrConflictFix(db, fix.id), fix);
  });

  it('accepts a base branch that is neither develop nor main', () => {
    // A real pull request targets whatever its author chose; nothing here
    // narrows the branch the way `sessions.pr_target_branch` does.
    const fix = createPrConflictFix(db, {
      repositoryId: repository.id,
      prNumber: 60,
      prUrl: 'https://github.com/VincentBean/leo/pull/60',
      prTitle: 'PR 60',
      headBranch: 'chief/booking-proposal-fields',
      baseBranch: 'release/2026-09',
      headSha: 'head1111',
      baseSha: 'base1111',
    });

    assert.equal(fix.baseBranch, 'release/2026-09');
  });

  it('reuses the row a pull request already has instead of duplicating it', () => {
    const first = fixFor(61);
    const again = fixFor(61, 'head2222', 'base2222');

    assert.equal(again.id, first.id);
    assert.equal(again.createdAt, first.createdAt);
    assert.equal(findPrConflictFix(db, repository.id, 61)?.id, first.id);
    assert.equal(
      listPrConflictFixes(db).filter((row) => row.repositoryId === repository.id).length,
      1,
    );
    // The new run is for the commits the poller just saw.
    assert.equal(again.headSha, 'head2222');
    assert.equal(again.baseSha, 'base2222');
  });

  it('winds the row back to the start of a run when a fix is started again', () => {
    // What the last run spent and left behind must not eat into the new run's
    // retry budget, nor make a fresh run look like it already pushed something.
    const first = fixFor(61);
    updatePrConflictFix(db, first.id, {
      status: 'failed',
      attempts: 3,
      failureStage: 'verify',
      lastError: 'conflict markers left in src/app.ts',
      containerId: 'container-1',
      mergeSha: 'merge111',
      startedAt: '2026-09-03T10:00:00.000Z',
      finishedAt: '2026-09-03T10:05:00.000Z',
    });

    const again = fixFor(61, 'head2222', 'base2222');

    assert.equal(again.status, 'running');
    assert.equal(again.attempts, 0);
    assert.equal(again.failureStage, null);
    assert.equal(again.lastError, null);
    assert.equal(again.containerId, null);
    assert.equal(again.mergeSha, null);
    assert.equal(again.startedAt, null);
    assert.equal(again.finishedAt, null);
    // And the same is true of what was actually stored, not just what create returned.
    assert.deepEqual(getPrConflictFix(db, first.id), again);
  });

  it('keeps one live row per pull request, separately per repository', () => {
    const other = createRepository(db, {
      name: `chief-web-${String(seq)}`,
      sshUrl: 'git@github.com:minicodemonkey/chief-web.git',
      githubSlug: 'minicodemonkey/chief-web',
      defaultBaseBranch: 'develop',
    });

    const mine = fixFor(61);
    const theirs = createPrConflictFix(db, {
      repositoryId: other.id,
      prNumber: 61,
      prUrl: 'https://github.com/minicodemonkey/chief-web/pull/61',
      prTitle: 'PR 61',
      headBranch: 'chief/other',
      baseBranch: 'develop',
      headSha: 'head3333',
      baseSha: 'base3333',
    });

    assert.notEqual(theirs.id, mine.id);
    assert.equal(findPrConflictFix(db, repository.id, 61)?.id, mine.id);
    assert.equal(findPrConflictFix(db, other.id, 61)?.id, theirs.id);
  });

  it('finds nothing for a pull request that was never fixed', () => {
    assert.equal(findPrConflictFix(db, repository.id, 999), null);
    assert.equal(getPrConflictFix(db, 'nope'), null);
  });

  it('lists the most recently touched fix first', () => {
    const older = fixFor(61);
    const newer = fixFor(62);
    updatePrConflictFix(db, older.id, { status: 'succeeded' });

    const listed = listPrConflictFixes(db).filter((row) =>
      [older.id, newer.id].includes(row.id),
    );
    assert.deepEqual(
      listed.map((row) => row.id),
      [older.id, newer.id],
    );
  });

  it('records attempts, the failing stage and the message', () => {
    const fix = fixFor(61);

    const retried = updatePrConflictFix(db, fix.id, { attempts: 1, startedAt: '2026-09-03T10:00:00.000Z' });
    assert.equal(retried?.attempts, 1);
    assert.equal(retried?.status, 'running');

    const failed = updatePrConflictFix(db, fix.id, {
      status: 'failed',
      attempts: 3,
      failureStage: 'push',
      lastError: 'remote rejected the push',
      finishedAt: '2026-09-03T10:05:00.000Z',
    });
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.attempts, 3);
    assert.equal(failed?.failureStage, 'push');
    assert.equal(failed?.lastError, 'remote rejected the push');
    assert.equal(failed?.finishedAt, '2026-09-03T10:05:00.000Z');
    assert.ok(failed !== null && failed.updatedAt >= fix.updatedAt);
  });

  it('clears the failure when a later attempt succeeds', () => {
    const fix = fixFor(61);
    updatePrConflictFix(db, fix.id, { status: 'failed', failureStage: 'agent', lastError: 'stalled' });

    const succeeded = updatePrConflictFix(db, fix.id, {
      status: 'succeeded',
      failureStage: null,
      lastError: null,
      mergeSha: 'merge222',
    });

    assert.equal(succeeded?.status, 'succeeded');
    assert.equal(succeeded?.failureStage, null);
    assert.equal(succeeded?.lastError, null);
    assert.equal(succeeded?.mergeSha, 'merge222');
  });

  it('leaves the row alone when there is nothing to update, and reports a missing row', () => {
    const fix = fixFor(61);

    assert.deepEqual(updatePrConflictFix(db, fix.id, {}), fix);
    assert.equal(updatePrConflictFix(db, 'nope', { status: 'failed' }), null);
  });

  it('refuses a status or a stage the schema does not know', () => {
    const fix = fixFor(61);

    assert.throws(
      () => db.prepare('UPDATE pr_conflict_fixes SET status = ? WHERE id = ?').run('bogus', fix.id),
      /CHECK/i,
    );
    assert.throws(
      () =>
        db
          .prepare('UPDATE pr_conflict_fixes SET failure_stage = ? WHERE id = ?')
          .run('bogus', fix.id),
      /CHECK/i,
    );
  });

  it('counts only running fixes against the build cap', () => {
    // Counted as a delta: the suite shares one database, and earlier tests
    // have left fixes of their own running.
    const running = countActivePrConflictFixes(db);
    const fix = fixFor(61);
    assert.equal(countActivePrConflictFixes(db), running + 1);

    updatePrConflictFix(db, fix.id, { status: 'succeeded' });
    assert.equal(countActivePrConflictFixes(db), running);

    updatePrConflictFix(db, fix.id, { status: 'failed' });
    assert.equal(countActivePrConflictFixes(db), running);
  });

  it('drops the fixes a dead process left running, and keeps the rest', () => {
    // The suite shares one database, so what earlier tests left running counts
    // too: this one adds exactly one to it.
    const running = countActivePrConflictFixes(db);
    const interrupted = fixFor(71);
    const finished = fixFor(72);
    updatePrConflictFix(db, finished.id, { status: 'succeeded' });
    const failed = fixFor(73);
    updatePrConflictFix(db, failed.id, { status: 'failed', failureStage: 'verify' });

    const cleared = clearInterruptedPrConflictFixes(db);

    // Only what was in flight: a `running` row outlived the memory driving it,
    // and unlike a failure it can never go stale, so it would hide its pull
    // request from the scan and hold a build slot forever.
    assert.equal(cleared, running + 1);
    assert.equal(getPrConflictFix(db, interrupted.id), null);
    assert.equal(getPrConflictFix(db, finished.id)?.status, 'succeeded');
    assert.equal(getPrConflictFix(db, failed.id)?.status, 'failed');
    // Nothing left running means nothing left holding a slot.
    assert.equal(countActivePrConflictFixes(db), 0);
    assert.equal(clearInterruptedPrConflictFixes(db), 0);
  });

  it('holds a failure only while the pull request has not moved', () => {
    const fix = fixFor(61);
    const failed = updatePrConflictFix(db, fix.id, { status: 'failed', attempts: 3 });
    assert.ok(failed !== null);

    assert.equal(hasStandingFailure(failed, 'head1111', 'base1111'), true);
    // Either side moving makes it a different conflict.
    assert.equal(hasStandingFailure(failed, 'head2222', 'base1111'), false);
    assert.equal(hasStandingFailure(failed, 'head1111', 'base2222'), false);
    // A fix that did not fail never stands in the way.
    assert.equal(hasStandingFailure(fix, 'head1111', 'base1111'), false);
  });

  it('deletes a fix, and says so when there was none', () => {
    const fix = fixFor(61);

    assert.equal(deletePrConflictFix(db, fix.id), true);
    assert.equal(findPrConflictFix(db, repository.id, 61), null);
    assert.equal(deletePrConflictFix(db, fix.id), false);
  });

  it('names every failure stage for the operator', () => {
    assert.equal(prConflictFixFailureStageLabel('checkout'), 'the checkout');
    assert.equal(prConflictFixFailureStageLabel('verify'), 'verifying the resolution');
    assert.equal(prConflictFixFailureStageLabel('container_lost'), 'the container');
  });
});

describe('the pr_conflict_fixes migration', () => {
  it('applies cleanly to a database that predates it, rows intact', () => {
    // Walked the way the other migration tests walk one: every migration up to
    // it applied by hand, a repository and a review in, then the new one.
    const db = new DatabaseSync(IN_MEMORY) as Database;
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);');

    const index = MIGRATIONS.findIndex((migration) => migration.id === CONFLICT_FIXES_MIGRATION);
    assert.ok(index > 0, `${CONFLICT_FIXES_MIGRATION} is missing`);
    for (const migration of MIGRATIONS.slice(0, index)) {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
        migration.id,
        '2026-09-03T00:00:00.000Z',
      );
    }

    const repository = createRepository(db, {
      name: 'chief-web',
      sshUrl: 'git@github.com:minicodemonkey/chief-web.git',
      githubSlug: 'minicodemonkey/chief-web',
      defaultBaseBranch: 'develop',
    });
    const at = '2026-09-03T00:00:00.000Z';
    db.prepare(
      `INSERT INTO pr_reviews
         (id, repository_id, pr_number, pr_url, pr_title, head_branch, base_branch, status,
          attempt, created_at, updated_at)
       VALUES ('r1', ?, 61, 'https://github.com/acme/app/pull/61', 'A review', 'chief/x',
               'develop', 'finished', 1, ?, ?)`,
    ).run(repository.id, at, at);

    const applied = runMigrations(db);

    assert.ok(applied.includes(CONFLICT_FIXES_MIGRATION));
    // Nothing that was already there moved.
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM pr_reviews').get()?.['count'],
      1,
    );

    // The new table takes a fix and hangs it off the repository.
    const fix = createPrConflictFix(db, {
      repositoryId: repository.id,
      prNumber: 61,
      prUrl: 'https://github.com/acme/app/pull/61',
      prTitle: 'A conflicted pull request',
      headBranch: 'chief/x',
      baseBranch: 'develop',
      headSha: 'head1111',
      baseSha: 'base1111',
    });
    assert.equal(findPrConflictFix(db, repository.id, 61)?.id, fix.id);

    // Re-running the migrations is a no-op, and the row survives it.
    assert.deepEqual(runMigrations(db), []);
    assert.equal(findPrConflictFix(db, repository.id, 61)?.id, fix.id);

    // Deleting the repository takes its fixes with it.
    db.prepare('DELETE FROM repositories WHERE id = ?').run(repository.id);
    assert.equal(findPrConflictFix(db, repository.id, 61), null);

    closeDatabase(db);
  });
});
