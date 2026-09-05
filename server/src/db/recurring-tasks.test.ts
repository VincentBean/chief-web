import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  closeDatabase,
  countRecurringTasksForRepository,
  createRecurringTask,
  createRepository,
  createSession,
  type Database,
  deleteRecurringTask,
  deleteSession,
  getRecurringTask,
  getRecurringTaskByName,
  getSession,
  IN_MEMORY,
  isValidRecurringTaskName,
  latestRecurringTaskOccurrence,
  listDueRecurringTasks,
  listRecurringTaskOccurrences,
  listRecurringTasks,
  listUnsettledRecurringTaskOccurrences,
  openDatabase,
  recordRecurringTaskOccurrence,
  RECURRING_TASK_OUTCOMES,
  recurringTaskOutcomeLabel,
  type Repository,
  updateRecurringTask,
  updateRecurringTaskOccurrence,
} from './index.js';

describe('recurring tasks', () => {
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

  const taskFor = (name: string, overrides: Record<string, unknown> = {}) =>
    createRecurringTask(db, {
      repositoryId: repository.id,
      name,
      prompt: 'run rector and fix what it reports',
      cronExpression: '0 3 * * *',
      baseBranch: 'develop',
      prTarget: 'develop',
      ...overrides,
    });

  it('creates every recurring-task table and the session link column', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row['name']);
    for (const table of ['recurring_tasks', 'recurring_task_occurrences']) {
      assert.ok(tables.includes(table), `missing table ${table}`);
    }

    const columns = db
      .prepare('PRAGMA table_info(sessions)')
      .all()
      .map((row) => row['name']);
    assert.ok(columns.includes('recurring_task_id'));
  });

  it('round-trips a task through create, read and update', () => {
    const created = taskFor('rector', { runCodeReview: true, nextRunAt: '2026-01-01T03:00:00.000Z' });

    assert.equal(created.prompt, 'run rector and fix what it reports');
    assert.equal(created.runCodeReview, true);
    assert.equal(created.paused, false);
    assert.equal(created.lastOutcome, null);

    const read = getRecurringTask(db, created.id);
    assert.deepEqual(read, created);
    assert.deepEqual(getRecurringTaskByName(db, repository.id, 'rector'), created);
    assert.equal(getRecurringTaskByName(db, repository.id, 'nope'), null);

    const updated = updateRecurringTask(db, created.id, {
      cronExpression: '0 4 * * 1',
      paused: true,
      nextRunAt: null,
    });
    assert.equal(updated?.cronExpression, '0 4 * * 1');
    assert.equal(updated?.paused, true);
    assert.equal(updated?.nextRunAt, null);
    // Untouched fields survive a partial patch.
    assert.equal(updated?.prompt, created.prompt);
    assert.equal(updated?.runCodeReview, true);
  });

  it('refuses a name that is not a legal session name', () => {
    assert.equal(isValidRecurringTaskName('nightly-rector'), true);
    assert.equal(isValidRecurringTaskName('nightly rector'), false);
    assert.throws(() => taskFor('nightly rector'), /Invalid recurring task name/);
  });

  it('keeps names unique per repository', () => {
    taskFor('rector');
    assert.throws(() => taskFor('rector'), /UNIQUE|constraint/i);

    const other = createRepository(db, {
      name: `other-${String(seq)}`,
      sshUrl: 'git@github.com:VincentBean/other.git',
      githubSlug: 'VincentBean/other',
      defaultBaseBranch: 'main',
    });
    // The same name under another repository is a different task.
    createRecurringTask(db, {
      repositoryId: other.id,
      name: 'rector',
      prompt: 'run rector',
      cronExpression: '0 3 * * *',
      baseBranch: 'main',
      prTarget: 'main',
    });
    assert.equal(countRecurringTasksForRepository(db, other.id), 1);
  });

  it('lists tasks by repository and paused state', () => {
    taskFor('style', { paused: true });
    taskFor('rector');

    const all = listRecurringTasks(db, { repositoryId: repository.id });
    assert.deepEqual(
      all.map((task) => task.name),
      ['rector', 'style'],
    );
    assert.deepEqual(
      listRecurringTasks(db, { repositoryId: repository.id, paused: true }).map((t) => t.name),
      ['style'],
    );
  });

  it('returns only unpaused tasks whose next run has passed', () => {
    const now = '2026-01-01T03:00:00.000Z';
    const due = taskFor('due', { nextRunAt: '2026-01-01T02:00:00.000Z' });
    const exactlyNow = taskFor('exactly-now', { nextRunAt: now });
    taskFor('later', { nextRunAt: '2026-01-01T04:00:00.000Z' });
    taskFor('paused', { nextRunAt: '2026-01-01T01:00:00.000Z', paused: true });
    taskFor('unscheduled');

    const ids = listDueRecurringTasks(db, now).map((task) => task.id);
    assert.deepEqual(ids, [due.id, exactlyNow.id]);
  });

  it('mirrors the newest occurrence onto last_outcome', () => {
    const task = taskFor('rector', { nextRunAt: '2026-01-01T03:00:00.000Z' });
    const session = createSession(db, {
      repositoryId: repository.id,
      name: 'rector-20260101-0300',
      baseBranch: 'develop',
      prTargetBranch: 'develop',
      recurringTaskId: task.id,
    });

    const started = recordRecurringTaskOccurrence(db, {
      recurringTaskId: task.id,
      outcome: 'started',
      sessionId: session.id,
      occurredAt: '2026-01-01T03:00:00.000Z',
    });
    assert.equal(started.outcome, 'started');
    assert.equal(started.sessionId, session.id);
    assert.equal(getRecurringTask(db, task.id)?.lastOutcome, 'started');

    const settled = updateRecurringTaskOccurrence(db, started.id, {
      outcome: 'pr-opened',
      detail: 'https://github.com/VincentBean/leo/pull/12',
    });
    assert.equal(settled?.outcome, 'pr-opened');
    assert.equal(settled?.detail, 'https://github.com/VincentBean/leo/pull/12');
    assert.equal(getRecurringTask(db, task.id)?.lastOutcome, 'pr-opened');

    // A skip creates no session, and still lands in the history and the mirror.
    recordRecurringTaskOccurrence(db, {
      recurringTaskId: task.id,
      outcome: 'skipped',
      detail: 'PR #12 still open',
      occurredAt: '2026-01-02T03:00:00.000Z',
    });
    assert.equal(getRecurringTask(db, task.id)?.lastOutcome, 'skipped');

    const history = listRecurringTaskOccurrences(db, task.id);
    assert.deepEqual(
      history.map((row) => row.outcome),
      ['skipped', 'pr-opened'],
    );
    assert.equal(history[0]?.sessionId, null);
    assert.equal(latestRecurringTaskOccurrence(db, task.id)?.outcome, 'skipped');
    assert.deepEqual(
      listRecurringTaskOccurrences(db, task.id, 1).map((row) => row.outcome),
      ['skipped'],
    );
  });

  it('re-reads the newest row when an older occurrence is updated', () => {
    const task = taskFor('rector');
    const older = recordRecurringTaskOccurrence(db, {
      recurringTaskId: task.id,
      outcome: 'started',
      occurredAt: '2026-01-01T03:00:00.000Z',
    });
    recordRecurringTaskOccurrence(db, {
      recurringTaskId: task.id,
      outcome: 'skipped',
      occurredAt: '2026-01-02T03:00:00.000Z',
    });

    updateRecurringTaskOccurrence(db, older.id, { outcome: 'failed', detail: 'the agent stalled' });

    // The mirror follows the newest row, not the one that was just written.
    assert.equal(getRecurringTask(db, task.id)?.lastOutcome, 'skipped');
  });

  it('lists the occurrences whose runs are still going, oldest first', () => {
    const task = taskFor('rector');
    const other = taskFor('code-style');
    const first = recordRecurringTaskOccurrence(db, {
      recurringTaskId: task.id,
      outcome: 'started',
      occurredAt: '2026-01-01T03:00:00.000Z',
    });
    const second = recordRecurringTaskOccurrence(db, {
      recurringTaskId: other.id,
      outcome: 'started',
      occurredAt: '2026-01-02T03:00:00.000Z',
    });
    // Neither of these is a run in flight: one never started, one is over.
    recordRecurringTaskOccurrence(db, { recurringTaskId: task.id, outcome: 'fire-failed' });
    recordRecurringTaskOccurrence(db, { recurringTaskId: task.id, outcome: 'pr-opened' });

    assert.deepEqual(
      listUnsettledRecurringTaskOccurrences(db).map((row) => row.id),
      [first.id, second.id],
    );

    // Settling one takes it out of the list, whichever task it belongs to.
    updateRecurringTaskOccurrence(db, first.id, { outcome: 'clean' });
    assert.deepEqual(
      listUnsettledRecurringTaskOccurrences(db).map((row) => row.id),
      [second.id],
    );
  });

  it('has a label for every outcome', () => {
    for (const outcome of RECURRING_TASK_OUTCOMES) {
      assert.ok(recurringTaskOutcomeLabel(outcome).length > 0);
    }
  });

  it('leaves already-created run sessions behind when the task is deleted', () => {
    const task = taskFor('rector');
    const session = createSession(db, {
      repositoryId: repository.id,
      name: 'rector-20260101-0300',
      baseBranch: 'develop',
      prTargetBranch: 'develop',
      recurringTaskId: task.id,
    });
    recordRecurringTaskOccurrence(db, {
      recurringTaskId: task.id,
      outcome: 'started',
      sessionId: session.id,
    });

    assert.equal(deleteRecurringTask(db, task.id), true);
    assert.equal(getRecurringTask(db, task.id), null);

    const survivor = getSession(db, session.id);
    assert.equal(survivor?.name, 'rector-20260101-0300');
    assert.equal(survivor?.recurringTaskId, null);
    // The history went with the task.
    assert.deepEqual(listRecurringTaskOccurrences(db, task.id), []);
  });

  it('keeps an occurrence when its session is deleted by hand', () => {
    const task = taskFor('rector');
    const session = createSession(db, {
      repositoryId: repository.id,
      name: 'rector-20260101-0300',
      baseBranch: 'develop',
      prTargetBranch: 'develop',
      recurringTaskId: task.id,
    });
    recordRecurringTaskOccurrence(db, {
      recurringTaskId: task.id,
      outcome: 'clean',
      sessionId: session.id,
    });

    assert.equal(deleteSession(db, session.id), true);

    const history = listRecurringTaskOccurrences(db, task.id);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.outcome, 'clean');
    assert.equal(history[0]?.sessionId, null);
  });
});
