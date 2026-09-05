import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createApp } from '../app.js';
import { createAuthService } from '../auth/index.js';
import { type Config, loadConfig } from '../config.js';
import {
  closeDatabase,
  createRepository,
  createSession,
  type Database,
  deleteRecurringTask,
  deleteSession,
  getSession,
  IN_MEMORY,
  listRecurringTasks,
  listSessions,
  openDatabase,
  recordRecurringTaskOccurrence,
  type Repository,
} from '../db/index.js';
import type {
  CronPreview,
  RecurringTaskDetailView,
  RecurringTaskView,
} from '../recurringtasks/index.js';

const PASSWORD = 'correct horse battery staple';

interface ErrorBody {
  error: string;
  message?: string;
}

describe('recurring tasks api', () => {
  let baseUrl: string;
  let cookie: string;
  let config: Config;
  let dataDir: string;
  let db: Database;
  let repository: Repository;
  let server: http.Server;

  const call = (method: string, route: string, body?: unknown): Promise<Response> =>
    fetch(`${baseUrl}${route}`, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const create = async (
    overrides: Record<string, unknown> = {},
  ): Promise<{ status: number; body: RecurringTaskView & ErrorBody }> => {
    const response = await call('POST', '/api/recurring-tasks', {
      repositoryId: repository.id,
      name: 'nightly-rector',
      prompt: 'run rector and fix what it reports',
      cronExpression: '0 3 * * 1',
      ...overrides,
    });
    return {
      status: response.status,
      body: (await response.json()) as RecurringTaskView & ErrorBody,
    };
  };

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-web-recurring-'));
    config = loadConfig({ CHIEF_WEB_PASSWORD: PASSWORD, DATA_DIR: dataDir });
    fs.mkdirSync(config.workspacesDir, { recursive: true });

    db = openDatabase(IN_MEMORY);
    repository = createRepository(db, {
      name: 'demo',
      sshUrl: 'git@github.com:acme/demo.git',
      githubSlug: 'acme/demo',
      defaultBaseBranch: 'develop',
    });

    const app = createApp(config, createAuthService(config, db), db, {
      orchestrator: {
        start: () => Promise.reject(new Error('no containers in these tests')),
        remove: () => Promise.resolve(),
      },
    });

    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase(db);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    for (const task of listRecurringTasks(db)) deleteRecurringTask(db, task.id);
    for (const session of listSessions(db)) deleteSession(db, session.id);
  });

  it('requires a session cookie', async () => {
    const response = await fetch(`${baseUrl}/api/recurring-tasks`);

    assert.equal(response.status, 401);
  });

  it('creates a task, defaulting the base branch and scheduling the first run', async () => {
    const { status, body } = await create();

    assert.equal(status, 201);
    assert.equal(body.name, 'nightly-rector');
    assert.equal(body.repositoryName, 'demo');
    // Omitted: the repository's own default, so the two can never disagree.
    assert.equal(body.baseBranch, 'develop');
    assert.equal(body.prTarget, 'main');
    assert.equal(body.runCodeReview, false);
    assert.equal(body.paused, false);
    assert.equal(body.scheduleDescription, 'At 03:00, only on Monday');
    assert.ok(body.nextRunAt !== null);
    assert.ok(new Date(body.nextRunAt).getTime() > Date.now());
    assert.equal(body.lastOutcome, null);
  });

  it('rejects a name too long for the run it becomes', async () => {
    const { status, body } = await create({ name: 'a'.repeat(47) });

    assert.equal(status, 400);
    assert.equal(body.error, 'invalid_task_name');
    assert.match(body.message ?? '', /46 characters/);
  });

  it('rejects a name outside the session alphabet', async () => {
    const { status, body } = await create({ name: 'nightly rector' });

    assert.equal(status, 400);
    assert.equal(body.error, 'invalid_task_name');
  });

  it('answers a bad cron expression with the cron module’s own message', async () => {
    const { status, body } = await create({ cronExpression: '0 3 * *' });

    assert.equal(status, 400);
    assert.equal(body.error, 'invalid_cron_expression');
    assert.match(body.message ?? '', /needs 5 fields/);
  });

  it('requires a prompt, a repository that exists and a free name', async () => {
    const blank = await create({ prompt: '   ' });
    assert.equal(blank.status, 400);
    assert.equal(blank.body.error, 'invalid_prompt');

    const missing = await create({ repositoryId: 'nope' });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'repository_not_found');

    await create();
    const duplicate = await create();
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error, 'task_name_taken');
  });

  it('lists tasks with their schedule description and next run', async () => {
    await create();
    await create({ name: 'hourly-style', cronExpression: '0 * * * *' });

    const response = await call('GET', '/api/recurring-tasks');
    const body = (await response.json()) as { recurringTasks: RecurringTaskView[] };

    assert.equal(response.status, 200);
    assert.equal(body.recurringTasks.length, 2);
    const hourly = body.recurringTasks.find((task) => task.name === 'hourly-style');
    assert.equal(hourly?.repositoryName, 'demo');
    assert.equal(hourly?.scheduleDescription, 'Every hour');
    assert.ok(hourly?.nextRunAt);
    assert.equal(hourly?.lastOutcome, null);

    const filtered = await call('GET', '/api/recurring-tasks?repositoryId=other');
    assert.deepEqual(((await filtered.json()) as { recurringTasks: unknown[] }).recurringTasks, []);
  });

  it('returns one task with its occurrence history, newest first', async () => {
    const { body: task } = await create();
    const session = createSession(db, {
      repositoryId: repository.id,
      name: 'nightly-rector-20260101-0300',
      baseBranch: 'develop',
      prTargetBranch: 'main',
      recurringTaskId: task.id,
    });
    recordRecurringTaskOccurrence(db, {
      recurringTaskId: task.id,
      outcome: 'skipped',
      detail: 'PR #12 still open',
      occurredAt: '2026-01-01T03:00:00.000Z',
    });
    recordRecurringTaskOccurrence(db, {
      recurringTaskId: task.id,
      outcome: 'started',
      sessionId: session.id,
      occurredAt: '2026-01-02T03:00:00.000Z',
    });

    const response = await call('GET', `/api/recurring-tasks/${task.id}`);
    const body = (await response.json()) as RecurringTaskDetailView;

    assert.equal(response.status, 200);
    assert.equal(body.id, task.id);
    assert.equal(body.lastOutcome, 'started');
    assert.equal(body.lastOutcomeLabel, 'running');
    assert.equal(body.occurrences.length, 2);
    assert.equal(body.occurrences[0]?.outcome, 'started');
    assert.equal(body.occurrences[0]?.session?.name, 'nightly-rector-20260101-0300');
    assert.equal(body.occurrences[0]?.session?.status, 'pending');
    assert.equal(body.occurrences[1]?.outcome, 'skipped');
    assert.equal(body.occurrences[1]?.outcomeLabel, 'skipped');
    assert.equal(body.occurrences[1]?.detail, 'PR #12 still open');
    // A skip creates no session, so there is nothing to link to.
    assert.equal(body.occurrences[1]?.session, null);
  });

  it('answers an unknown task with 404', async () => {
    const response = await call('GET', '/api/recurring-tasks/nope');

    assert.equal(response.status, 404);
    assert.equal(((await response.json()) as ErrorBody).error, 'recurring_task_not_found');
  });

  it('updates the editable fields, leaving the next run alone', async () => {
    const { body: task } = await create();

    const response = await call('PUT', `/api/recurring-tasks/${task.id}`, {
      prompt: 'check code style against the guide',
      baseBranch: 'main',
      prTarget: 'develop',
      runCodeReview: true,
    });
    const body = (await response.json()) as RecurringTaskView;

    assert.equal(response.status, 200);
    assert.equal(body.prompt, 'check code style against the guide');
    assert.equal(body.baseBranch, 'main');
    assert.equal(body.prTarget, 'develop');
    assert.equal(body.runCodeReview, true);
    // The schedule did not change, so neither did the occurrence it points at.
    assert.equal(body.nextRunAt, task.nextRunAt);
  });

  it('recomputes the next run when the cron expression changes', async () => {
    const { body: task } = await create();

    const response = await call('PUT', `/api/recurring-tasks/${task.id}`, {
      cronExpression: '*/15 * * * *',
    });
    const body = (await response.json()) as RecurringTaskView;

    assert.equal(response.status, 200);
    assert.equal(body.cronExpression, '*/15 * * * *');
    assert.equal(body.scheduleDescription, 'Every 15 minutes');
    assert.notEqual(body.nextRunAt, task.nextRunAt);
    assert.ok(body.nextRunAt !== null);
    // Within the quarter hour, which the weekly expression it replaced never is.
    assert.ok(new Date(body.nextRunAt).getTime() - Date.now() <= 15 * 60 * 1000);
  });

  it('rejects an update whose cron expression or name is unusable', async () => {
    const { body: task } = await create();

    const badCron = await call('PUT', `/api/recurring-tasks/${task.id}`, {
      cronExpression: '99 * * * *',
    });
    assert.equal(badCron.status, 400);
    assert.equal(((await badCron.json()) as ErrorBody).error, 'invalid_cron_expression');

    const badName = await call('PUT', `/api/recurring-tasks/${task.id}`, { name: 'a b' });
    assert.equal(badName.status, 400);
    assert.equal(((await badName.json()) as ErrorBody).error, 'invalid_task_name');

    // Neither was applied.
    const fetched = await call('GET', `/api/recurring-tasks/${task.id}`);
    const body = (await fetched.json()) as RecurringTaskView;
    assert.equal(body.cronExpression, '0 3 * * 1');
    assert.equal(body.name, 'nightly-rector');
  });

  it('pauses and resumes, recomputing the next run from now on resume', async () => {
    const { body: task } = await create();

    const paused = await call('PUT', `/api/recurring-tasks/${task.id}`, { paused: true });
    const pausedBody = (await paused.json()) as RecurringTaskView;
    assert.equal(paused.status, 200);
    assert.equal(pausedBody.paused, true);
    // A paused task is never due, which is exactly "no next occurrence".
    assert.equal(pausedBody.nextRunAt, null);

    const resumed = await call('PUT', `/api/recurring-tasks/${task.id}`, { paused: false });
    const resumedBody = (await resumed.json()) as RecurringTaskView;
    assert.equal(resumed.status, 200);
    assert.equal(resumedBody.paused, false);
    assert.ok(resumedBody.nextRunAt !== null);
    assert.ok(new Date(resumedBody.nextRunAt).getTime() > Date.now());
  });

  it('rejects a paused flag that is not a boolean', async () => {
    const { body: task } = await create();

    const response = await call('PUT', `/api/recurring-tasks/${task.id}`, { paused: 'yes' });

    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as ErrorBody).error, 'invalid_paused');
  });

  it('deletes the task and leaves the sessions it already spawned', async () => {
    const { body: task } = await create();
    const session = createSession(db, {
      repositoryId: repository.id,
      name: 'nightly-rector-20260101-0300',
      baseBranch: 'develop',
      prTargetBranch: 'main',
      recurringTaskId: task.id,
    });

    const response = await call('DELETE', `/api/recurring-tasks/${task.id}`);
    assert.equal(response.status, 204);

    const gone = await call('GET', `/api/recurring-tasks/${task.id}`);
    assert.equal(gone.status, 404);

    const run = getSession(db, session.id);
    assert.equal(run?.name, 'nightly-rector-20260101-0300');
    // The run outlives its definition as an ordinary session.
    assert.equal(run?.recurringTaskId, null);

    const missing = await call('DELETE', `/api/recurring-tasks/${task.id}`);
    assert.equal(missing.status, 404);
  });

  it('describes a valid expression, with the next run as a UTC instant', async () => {
    const response = await call('GET', '/api/cron/preview?expression=' + encodeURIComponent('0 3 * * 1'));
    assert.equal(response.status, 200);
    const body = (await response.json()) as CronPreview;
    assert.equal(body.expression, '0 3 * * 1');
    assert.equal(body.valid, true);
    assert.equal(body.description, 'At 03:00, only on Monday');
    assert.equal(body.message, null);
    assert.ok(body.nextRunAt !== null);
    const next = new Date(body.nextRunAt);
    assert.ok(next.getTime() > Date.now());
    // Read in the server's timezone, handed over as UTC for the browser.
    assert.equal(next.getHours(), 3);
    assert.equal(next.getDay(), 1);
  });

  it('answers a half-typed expression with the reason, not an error status', async () => {
    const response = await call('GET', '/api/cron/preview?expression=' + encodeURIComponent('0 3 * *'));
    assert.equal(response.status, 200);
    const body = (await response.json()) as CronPreview;
    assert.equal(body.valid, false);
    assert.equal(body.description, null);
    assert.equal(body.nextRunAt, null);
    assert.match(body.message ?? '', /5 fields/);
  });

  it('rejects a preview with no expression at all', async () => {
    const response = await call('GET', '/api/cron/preview');
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as ErrorBody).error, 'invalid_cron_expression');
  });

  it('needs a session cookie for a preview too', async () => {
    const response = await fetch(baseUrl + '/api/cron/preview?expression=0+3+*+*+*');
    assert.equal(response.status, 401);
  });
});
