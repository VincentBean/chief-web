import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BuildView } from '../build/index.js';
import {
  closeDatabase,
  createRepository,
  createSession,
  type Database,
  failSession,
  getSession,
  IN_MEMORY,
  openDatabase,
  type Session,
  type Story,
  syncStories,
  updateSession,
} from '../db/index.js';
import type { DeliveryResult } from '../delivery/index.js';
import { planRetry, RetryError, RetryService } from './service.js';

function story(storyId: string, status: Story['status']): Story {
  return {
    id: 0,
    sessionId: 's',
    storyId,
    title: storyId,
    priority: 1,
    status,
    commitSha: null,
    createdAt: '',
    updatedAt: '',
  };
}

describe('where a retry resumes', () => {
  it('re-runs only the delivery when the push, the pull request or the review failed', () => {
    for (const stage of ['push', 'pull_request', 'review'] as const) {
      const plan = planRetry({ failureStage: stage }, [story('US-001', 'done')]);
      assert.equal(plan.action, 'delivery');
      assert.equal(plan.stage, stage);
      assert.match(plan.reason, /no story is built again/);
    }
  });

  it('restarts the loop for an agent, PRD or lost-container failure', () => {
    for (const stage of ['agent', 'prd', 'container_lost'] as const) {
      const plan = planRetry({ failureStage: stage }, [
        story('US-001', 'done'),
        story('US-002', 'todo'),
      ]);
      assert.equal(plan.action, 'build');
      assert.equal(plan.stage, stage);
      assert.match(plan.reason, /1 of 2 left/);
    }
  });

  it('falls back to the story list for a session that failed before stages existed', () => {
    assert.equal(planRetry({ failureStage: null }, [story('US-001', 'done')]).action, 'delivery');
    assert.equal(planRetry({ failureStage: null }, [story('US-001', 'todo')]).action, 'build');
    // Nothing parsed at all: there is nothing to deliver, so the loop is the
    // only thing that can make progress.
    assert.equal(planRetry({ failureStage: null }, []).action, 'build');
  });
});

describe('retrying a failed session', () => {
  const started: string[] = [];
  const delivered: string[] = [];

  function world(): { db: Database; session: Session; retries: RetryService } {
    const db = openDatabase(IN_MEMORY);
    const repository = createRepository(db, {
      name: 'demo',
      sshUrl: 'git@github.com:acme/demo.git',
      githubSlug: 'acme/demo',
    });
    const session = createSession(db, {
      repositoryId: repository.id,
      name: 'add-login',
      baseBranch: 'main',
      prTargetBranch: 'main',
    });

    const builds = {
      start: (sessionId: string): Promise<BuildView> => {
        started.push(sessionId);
        updateSession(db, sessionId, { status: 'building', failureStage: null, lastError: null });
        return Promise.resolve({ status: 'building', queued: false } as BuildView);
      },
    };
    const delivery = {
      retry: (sessionId: string): Promise<DeliveryResult> => {
        delivered.push(sessionId);
        updateSession(db, sessionId, {
          status: 'finished',
          prUrl: 'https://github.com/acme/demo/pull/1',
          failureStage: null,
          lastError: null,
        });
        return Promise.resolve({
          ok: true,
          sessionId,
          status: 'finished',
          prUrl: 'https://github.com/acme/demo/pull/1',
          adopted: false,
          code: 'ok',
          message: 'Pushed and opened pull request #1.',
          stderr: '',
        });
      },
    };

    return { db, session, retries: new RetryService(db, builds, delivery) };
  }

  it('restarts the loop, and nothing else, after an agent failure', async () => {
    const { db, session, retries } = world();
    syncStories(db, session.id, [
      { storyId: 'US-001', title: 'One', priority: 1, status: 'done' },
      { storyId: 'US-002', title: 'Two', priority: 2, status: 'todo' },
    ]);
    failSession(db, session.id, 'agent', 'US-002 made no progress in 3 attempts.');

    const result = await retries.retry(session.id);

    assert.equal(result.action, 'build');
    assert.equal(result.stage, 'agent');
    assert.equal(result.status, 'building');
    assert.deepEqual(started, [session.id]);
    assert.deepEqual(delivered, []);
    // The done story stays done: a retry resumes, it never restarts.
    assert.equal(getSession(db, session.id)?.failureStage, null);
    closeDatabase(db);
    started.length = 0;
  });

  it('re-runs only push and pull request after a delivery failure', async () => {
    const { db, session, retries } = world();
    syncStories(db, session.id, [
      { storyId: 'US-001', title: 'One', priority: 1, status: 'done' },
    ]);
    failSession(db, session.id, 'push', 'Permission denied (publickey).');

    const result = await retries.retry(session.id);

    assert.equal(result.action, 'delivery');
    assert.equal(result.stage, 'push');
    assert.equal(result.ok, true);
    assert.equal(result.prUrl, 'https://github.com/acme/demo/pull/1');
    assert.deepEqual(delivered, [session.id]);
    assert.deepEqual(started, []);
    closeDatabase(db);
    delivered.length = 0;
  });

  it('says what it would do before it does it', () => {
    const { db, session, retries } = world();
    syncStories(db, session.id, [
      { storyId: 'US-001', title: 'One', priority: 1, status: 'done' },
    ]);
    failSession(db, session.id, 'pull_request', 'GitHub rejected the pull request.');

    assert.equal(retries.plan(session.id).action, 'delivery');
    assert.deepEqual(started, []);
    assert.deepEqual(delivered, []);
    closeDatabase(db);
  });

  it('refuses a session that is not failed, and one that is gone', async () => {
    const { db, session, retries } = world();

    await assert.rejects(
      () => retries.retry(session.id),
      (error: unknown) =>
        error instanceof RetryError && error.status === 409 && error.code === 'session_not_failed',
    );
    await assert.rejects(
      () => retries.retry('nope'),
      (error: unknown) =>
        error instanceof RetryError && error.status === 404 && error.code === 'session_not_found',
    );
    closeDatabase(db);
  });
});
