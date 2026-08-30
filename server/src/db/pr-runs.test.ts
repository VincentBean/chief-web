import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  closeDatabase,
  countActivePrRuns,
  createPrRun,
  createRepository,
  type Database,
  findPrRun,
  IN_MEMORY,
  listThreads,
  openDatabase,
  prFailureStageLabel,
  type Repository,
  updatePrRun,
  updateThread,
  upsertThread,
} from './index.js';

describe('pull request feedback runs', () => {
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

  const runFor = (prNumber: number, baseBranch = 'develop') =>
    createPrRun(db, {
      repositoryId: repository.id,
      prNumber,
      prUrl: `https://github.com/VincentBean/leo/pull/${String(prNumber)}`,
      prTitle: `PR ${String(prNumber)}`,
      headBranch: 'chief/booking-proposal-fields',
      baseBranch,
    });

  it('starts pending, with no attempt made', () => {
    const run = runFor(61);

    assert.equal(run.status, 'pending');
    assert.equal(run.attempt, 0);
    assert.equal(run.headSha, null);
    assert.equal(run.failureStage, null);
  });

  it('accepts a base branch that is neither develop nor main', () => {
    // The reason these are not `sessions` rows: that table CHECKs
    // `pr_target_branch` to develop/main, and a real pull request targets
    // whatever its author chose.
    const run = runFor(60, 'release/2026-09');

    assert.equal(run.baseBranch, 'release/2026-09');
  });

  it('adopts the row a pull request already has instead of duplicating it', () => {
    const first = runFor(61);
    const again = createPrRun(db, {
      repositoryId: repository.id,
      prNumber: 61,
      prUrl: first.prUrl,
      prTitle: 'a retitled pull request',
      headBranch: first.headBranch,
      baseBranch: first.baseBranch,
    });

    assert.equal(again.id, first.id);
    // Re-running picks up whatever changed on GitHub meanwhile.
    assert.equal(again.prTitle, 'a retitled pull request');
    assert.equal(findPrRun(db, repository.id, 61)?.id, first.id);
  });

  it('counts only running rows against the build cap', () => {
    const run = runFor(61);
    assert.equal(countActivePrRuns(db), 0);

    updatePrRun(db, run.id, { status: 'running' });
    assert.equal(countActivePrRuns(db), 1);

    updatePrRun(db, run.id, { status: 'finished' });
    assert.equal(countActivePrRuns(db), 0);
  });

  it('keeps what an earlier run learned about a thread when it is seen again', () => {
    // The reply history is what makes a re-run idempotent, so re-fetching the
    // thread from GitHub must not wipe it.
    const run = runFor(61);
    const thread = upsertThread(db, {
      runId: run.id,
      threadId: 'PRRT_kw1',
      kind: 'thread',
      firstCommentId: 3_887_174_693,
      feedbackKey: 'T1',
    });
    updateThread(db, thread.id, {
      outcome: 'addressed',
      repliedAt: '2026-08-29T10:00:00Z',
      repliedHeadSha: 'abc1234',
    });

    const again = upsertThread(db, {
      runId: run.id,
      threadId: 'PRRT_kw1',
      kind: 'thread',
      firstCommentId: 3_887_174_693,
      feedbackKey: 'T2',
    });

    assert.equal(listThreads(db, run.id).length, 1, 'the thread must not be duplicated');
    assert.equal(again.outcome, 'addressed');
    assert.equal(again.repliedHeadSha, 'abc1234');
    // The key is re-issued per run, so it does move.
    assert.equal(again.feedbackKey, 'T2');
  });

  it('lets a review summary carry no comment to reply to', () => {
    // A review body has no thread and no comment id — GitHub gives nothing to
    // reply to — so the column has to be nullable.
    const run = runFor(61);
    const review = upsertThread(db, {
      runId: run.id,
      threadId: 'PRR_kw1',
      kind: 'review',
      firstCommentId: null,
      feedbackKey: 'R1',
    });

    assert.equal(review.kind, 'review');
    assert.equal(review.firstCommentId, null);
  });

  it('names every failure stage', () => {
    assert.equal(prFailureStageLabel('push'), 'the push');
    assert.equal(prFailureStageLabel('reply'), 'answering on GitHub');
    assert.equal(prFailureStageLabel('feedback'), 'reading the comments');
  });
});
