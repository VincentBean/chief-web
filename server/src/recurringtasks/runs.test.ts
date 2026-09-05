import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { type Config, loadConfig } from '../config.js';
import {
  type CreateRecurringTaskInput,
  createRecurringTask,
  createRepository,
  type Database,
  getRecurringTask,
  getSession,
  IN_MEMORY,
  latestRecurringTaskOccurrence,
  listRecurringTaskOccurrences,
  listSessions,
  nowIso,
  openDatabase,
  type RecurringTask,
  type Session,
  type Repository,
  updateRecurringTask,
  updateSession,
} from '../db/index.js';
import { type ExecScript, FakeDockerDaemon, type FakeExec } from '../docker/fake-daemon.js';
import { DockerApi } from '../docker/index.js';
import { SessionOrchestrator, sessionRepoDir } from '../orchestrator/index.js';
import { parsePrd, prdParses, prdPathFor } from '../prd/index.js';
import { SessionService } from '../sessions/index.js';
import { writePrivateKey } from '../ssh/index.js';
import { GENERATED_STORY_ID } from './prd.js';
import {
  type RecurringTaskBuilds,
  RecurringTaskRunner,
  settlementOf,
  skipReasonFor,
} from './runs.js';

const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----';

/** A moment long past, so a task built with it is due at every tick. */
const PAST = '2020-01-01T00:00:00.000Z';

/** Stands in for `BuildService.start`: it records, and marks the run building. */
class FakeBuilds implements RecurringTaskBuilds {
  readonly started: string[] = [];
  /** How the build refuses every start, when it does. */
  refusal: Error | null = null;
  /** Whether a refused start leaves the session in the queue (US-018). */
  queuesWhenRefused = false;

  constructor(private readonly db: Database) {}

  start(sessionId: string): Promise<unknown> {
    if (this.refusal !== null) {
      if (this.queuesWhenRefused) updateSession(this.db, sessionId, { queuedAt: nowIso() });
      return Promise.reject(this.refusal);
    }
    this.started.push(sessionId);
    updateSession(this.db, sessionId, { status: 'building', queuedAt: null });
    return Promise.resolve({});
  }
}

interface Fixture {
  readonly config: Config;
  readonly daemon: FakeDockerDaemon;
  readonly db: Database;
  readonly repository: Repository;
  readonly sessions: SessionService;
  readonly builds: FakeBuilds;
  readonly runner: RecurringTaskRunner;
  task(overrides?: Partial<CreateRecurringTaskInput>): RecurringTask;
  script(handler: (exec: FakeExec) => ExecScript): void;
}

const fixtures: { db: Database; daemon: FakeDockerDaemon; dataDir: string }[] = [];

after(async () => {
  for (const created of fixtures) {
    created.db.close();
    await created.daemon.close();
    fs.rmSync(created.dataDir, { recursive: true, force: true });
  }
});

/** The real session service and orchestrator; only git and the clock are fake. */
async function fixture(): Promise<Fixture> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-recurring-'));
  const daemon = await FakeDockerDaemon.start();
  const config = loadConfig({ DATA_DIR: dataDir, DOCKER_SOCKET: daemon.socketPath });
  fs.mkdirSync(config.workspacesDir, { recursive: true });
  fs.mkdirSync(config.sshKeysDir, { recursive: true });

  const db = openDatabase(IN_MEMORY);
  const repository = createRepository(db, {
    name: 'demo',
    sshUrl: 'git@github.com:acme/demo.git',
    githubSlug: 'acme/demo',
    defaultBaseBranch: 'develop',
  });
  writePrivateKey(config, repository.id, PRIVATE_KEY);

  const docker = new DockerApi(daemon.socketPath);
  const sessions = new SessionService(
    config,
    db,
    new SessionOrchestrator(config, db, docker),
    docker,
  );
  const builds = new FakeBuilds(db);
  const runner = new RecurringTaskRunner(config, db, () => sessions, builds);

  fixtures.push({ db, daemon, dataDir });
  // Every git command the session container would run succeeds, and the clone
  // leaves the working copy the server looks for behind.
  daemon.onExec = clonesInto(config, db);

  return {
    config,
    daemon,
    db,
    repository,
    sessions,
    builds,
    runner,
    task(overrides = {}) {
      return createRecurringTask(db, {
        repositoryId: repository.id,
        name: 'rector',
        prompt: 'Run rector and fix everything it reports.',
        cronExpression: '0 3 * * *',
        baseBranch: 'develop',
        prTarget: 'develop',
        nextRunAt: PAST,
        ...overrides,
      });
    },
    script(handler) {
      daemon.onExec = handler;
    },
  };
}

/**
 * A container that clones: the session it is cloning for is whichever one is
 * pending right now, which is enough because a firing creates one at a time.
 */
function clonesInto(config: Config, db: Database): (exec: FakeExec) => ExecScript {
  return (exec) => {
    const script = exec.cmd[2] ?? '';
    if (script.includes('ls-remote')) return { exitCode: 2 };
    if (script.includes('git clone')) {
      for (const session of listSessions(db, {})) {
        if (session.status !== 'pending') continue;
        fs.mkdirSync(path.join(sessionRepoDir(config, session.id), '.git'), { recursive: true });
      }
      return { stderr: "Cloning into '/workspace/repo'...\n" };
    }
    return { stdout: 'chief/rector\n' };
  };
}

describe('firing a recurring task', () => {
  it('turns a due task into a queued session with a generated PRD', async () => {
    const f = await fixture();
    const task = f.task({ runCodeReview: true, prTarget: 'main' });

    // A fixed "now" so the run's name is the one this test can name too.
    const now = new Date(2026, 8, 5, 3, 0).toISOString();
    assert.equal(await f.runner.fireDue(now), 1);

    const [session] = listSessions(f.db, {});
    assert.ok(session);
    assert.equal(session.name, 'rector-20260905-0300');
    assert.equal(session.featureBranch, 'chief/rector-20260905-0300');
    assert.equal(session.repositoryId, f.repository.id);
    assert.equal(session.baseBranch, 'develop');
    assert.equal(session.prTargetBranch, 'main');
    assert.equal(session.codeReview, true);
    assert.equal(session.recurringTaskId, task.id);
    // The normal setup ran: a container and a clone.
    assert.equal(f.daemon.listContainers().length, 1);
    assert.ok(fs.existsSync(path.join(sessionRepoDir(f.config, session.id), '.git')));

    // The PRD was written into the workspace and parsed on the way to `ready`.
    const prd = fs.readFileSync(
      path.join(sessionRepoDir(f.config, session.id), prdPathFor(session.name)),
      'utf8',
    );
    const parsed = parsePrd(prd);
    assert.equal(prdParses(parsed), true, JSON.stringify(parsed.errors));
    assert.equal(parsed.stories.length, 1);
    assert.match(prd, /> Run rector and fix everything it reports\./);

    // The story reached the table "Mark ready" fills, and the build was asked
    // for through the normal queue path.
    assert.deepEqual(
      f.sessions.stories(session.id).map((story) => story.storyId),
      [GENERATED_STORY_ID],
    );
    assert.deepEqual(f.builds.started, [session.id]);
    assert.equal(getSession(f.db, session.id)?.status, 'building');
  });

  it('records the run as started, with the session on the occurrence', async () => {
    const f = await fixture();
    const task = f.task();

    await f.runner.fireDue();

    const occurrence = latestRecurringTaskOccurrence(f.db, task.id);
    assert.ok(occurrence);
    assert.equal(occurrence.outcome, 'started');
    assert.equal(occurrence.sessionId, listSessions(f.db, {})[0]?.id);
    assert.equal(getRecurringTask(f.db, task.id)?.lastOutcome, 'started');
  });

  it('spends the occurrence at fire time, so a task fires once per tick and once after downtime', async () => {
    const f = await fixture();
    const task = f.task();
    const now = new Date(2026, 8, 5, 3, 0).toISOString();

    assert.equal(await f.runner.fireDue(now), 1);

    // `next_run_at` moved on to the next occurrence *after now* — not to the
    // one that was missed while the stack was down.
    const next = getRecurringTask(f.db, task.id)?.nextRunAt;
    assert.ok(next);
    assert.ok(next > now, `${next} should be after ${now}`);
    assert.equal(new Date(next).getHours(), 3);
    assert.equal(new Date(next).getDate(), 6);

    // So a second tick, at the same moment, finds nothing due.
    assert.equal(await f.runner.fireDue(now), 0);
    assert.equal(listSessions(f.db, {}).length, 1);
    assert.equal(listRecurringTaskOccurrences(f.db, task.id).length, 1);
  });

  it('leaves a paused task alone', async () => {
    const f = await fixture();
    const task = f.task({ paused: true });

    assert.equal(await f.runner.fireDue(), 0);
    assert.equal(listSessions(f.db, {}).length, 0);
    assert.equal(latestRecurringTaskOccurrence(f.db, task.id), null);
  });

  it('records a fire failure when the clone does not land, and does not retry it', async () => {
    const f = await fixture();
    const task = f.task();
    f.script((exec) =>
      (exec.cmd[2] ?? '').includes('ls-remote')
        ? { exitCode: 0, stdout: 'abc123\trefs/heads/chief/rector-20260905-0300\n' }
        : { exitCode: 1, stderr: 'should not run' },
    );

    const now = new Date(2026, 8, 5, 3, 0).toISOString();
    assert.equal(await f.runner.fireDue(now), 0);

    const occurrence = latestRecurringTaskOccurrence(f.db, task.id);
    assert.ok(occurrence);
    assert.equal(occurrence.outcome, 'fire-failed');
    assert.match(occurrence.detail ?? '', /already exists on origin/);
    assert.equal(getRecurringTask(f.db, task.id)?.lastOutcome, 'fire-failed');

    // The session it got as far as creating is left exactly as a hand-made one
    // would be: pending, with its reason, and the usual "Retry setup".
    const [session] = listSessions(f.db, {});
    assert.ok(session);
    assert.equal(occurrence.sessionId, session.id);
    assert.equal(session.status, 'pending');
    assert.match(session.lastError ?? '', /already exists on origin/);
    assert.deepEqual(f.builds.started, []);

    // And the failure costs the task exactly this occurrence: the next tick,
    // at the same moment, tries nothing.
    assert.equal(await f.runner.fireDue(now), 0);
    assert.equal(listRecurringTaskOccurrences(f.db, task.id).length, 1);
  });

  it('records a fire failure when the build itself is refused', async () => {
    const f = await fixture();
    const task = f.task();
    f.builds.refusal = new Error('the container is gone');

    assert.equal(await f.runner.fireDue(), 0);

    const occurrence = latestRecurringTaskOccurrence(f.db, task.id);
    assert.ok(occurrence);
    assert.equal(occurrence.outcome, 'fire-failed');
    assert.match(occurrence.detail ?? '', /the container is gone/);
    // One row, not two: the `started` row is the one that was settled.
    assert.equal(listRecurringTaskOccurrences(f.db, task.id).length, 1);
  });

  it('keeps a run that was only queued behind the cap', async () => {
    const f = await fixture();
    const task = f.task();
    // What `BuildService.start` does under the usage-limit hold: the session is
    // queued, and the refusal is only about who starts it (US-018).
    f.builds.refusal = new Error('Claude’s usage limit');
    f.builds.queuesWhenRefused = true;

    assert.equal(await f.runner.fireDue(), 1);
    assert.equal(latestRecurringTaskOccurrence(f.db, task.id)?.outcome, 'started');
  });
});

describe('skipping an occurrence the previous run is in the way of', () => {
  it('holds the occurrence back while the previous run is still going', () => {
    assert.match(skipReasonFor(session({ status: 'pending' })) ?? '', /is still being set up\.$/);
    assert.match(skipReasonFor(session({ status: 'ready' })) ?? '', /still waiting to be built/);
    assert.match(
      skipReasonFor(session({ status: 'ready', queuedAt: '2026-09-05T03:00:00.000Z' })) ?? '',
      /still queued for a slot/,
    );
    assert.equal(
      skipReasonFor(session({ status: 'building' })),
      'The previous run “rector-20260905-0300” is still building.',
    );
    assert.match(skipReasonFor(session({ status: 'waiting' })) ?? '', /usage limit/);
  });

  it('holds it back while the previous run’s pull request is still open', () => {
    const prUrl = 'https://github.com/acme/demo/pull/12';
    assert.equal(
      skipReasonFor(session({ status: 'pr-open', prUrl })),
      'PR #12 from the previous run “rector-20260905-0300” is still open.',
    );
    // The draft opened before the review is as open as the one after it.
    assert.match(skipReasonFor(session({ status: 'reviewing', prUrl })) ?? '', /PR #12/);
    assert.match(skipReasonFor(session({ status: 'fixing', prUrl })) ?? '', /PR #12/);
    // A URL no number can be read out of still names something to look at.
    assert.match(
      skipReasonFor(session({ status: 'pr-open', prUrl: 'https://example.invalid/x' })) ?? '',
      /^The pull request from the previous run/,
    );
  });

  it('lets it through once the previous run is out of the way', () => {
    const prUrl = 'https://github.com/acme/demo/pull/12';
    // No previous run at all.
    assert.equal(skipReasonFor(null), null);
    // Merged, and closed unmerged — which the sync writes back as `finished`.
    assert.equal(skipReasonFor(session({ status: 'merged', prUrl })), null);
    assert.equal(skipReasonFor(session({ status: 'finished', prUrl })), null);
    // Finished without a pull request, and failed outright.
    assert.equal(skipReasonFor(session({ status: 'finished' })), null);
    assert.equal(skipReasonFor(session({ status: 'failed', lastError: 'boom' })), null);
  });

  it('lets it through when the previous firing failed halfway', () => {
    // Nothing will ever move these two on: the scheduler does not retry setup,
    // and settling only follows runs that started. Read as unfinished runs they
    // would skip every occurrence from now on.
    assert.equal(
      skipReasonFor(session({ status: 'pending', lastError: 'clone refused' }), 'fire-failed'),
      null,
    );
    assert.equal(skipReasonFor(session({ status: 'ready' }), 'fire-failed'), null);

    // But the session still has the last word: a run somebody retried by hand
    // is a run like any other, whatever the occurrence that fired it says.
    assert.match(skipReasonFor(session({ status: 'building' }), 'fire-failed') ?? '', /building/);
    assert.match(
      skipReasonFor(session({ status: 'ready', queuedAt: '2026-09-05T03:00:00.000Z' }), 'fire-failed') ??
        '',
      /queued for a slot/,
    );
    // And a run that started is held back exactly as before.
    assert.match(skipReasonFor(session({ status: 'pending' }), 'started') ?? '', /being set up/);
  });

  it('writes a skipped occurrence, and moves the schedule on, while a run is building', async () => {
    const f = await fixture();
    const task = f.task();
    const first = new Date(2026, 8, 5, 3, 0).toISOString();
    assert.equal(await f.runner.fireDue(first), 1);
    assert.equal(getSession(f.db, listSessions(f.db, {})[0]?.id ?? '')?.status, 'building');

    // Due again an hour later, with that run still going.
    updateRecurringTask(f.db, task.id, { nextRunAt: PAST });
    const second = new Date(2026, 8, 5, 4, 0).toISOString();
    assert.equal(await f.runner.fireDue(second), 0);

    // No second session, no second container: nothing was started.
    assert.equal(listSessions(f.db, {}).length, 1);
    assert.equal(f.daemon.listContainers().length, 1);

    const occurrence = latestRecurringTaskOccurrence(f.db, task.id);
    assert.equal(occurrence?.outcome, 'skipped');
    assert.match(occurrence?.detail ?? '', /is still building\.$/);
    assert.equal(occurrence?.sessionId, null);
    assert.equal(getRecurringTask(f.db, task.id)?.lastOutcome, 'skipped');

    // The occurrence was spent: the schedule points at the next one, not at
    // the moment that was just skipped.
    assert.equal(
      getRecurringTask(f.db, task.id)?.nextRunAt,
      new Date(2026, 8, 6, 3, 0).toISOString(),
    );

    // Both moments are in the history, newest first.
    assert.deepEqual(
      listRecurringTaskOccurrences(f.db, task.id).map((row) => row.outcome),
      ['skipped', 'started'],
    );
  });

  it('skips while the previous run’s pull request is still open', async () => {
    const f = await fixture();
    const task = f.task();
    assert.equal(await f.runner.fireDue(new Date(2026, 8, 5, 3, 0).toISOString()), 1);
    const run = listSessions(f.db, {})[0];
    assert.ok(run);

    updateSession(f.db, run.id, {
      status: 'pr-open',
      prUrl: 'https://github.com/acme/demo/pull/12',
    });
    assert.equal(f.runner.settle(), 1);

    updateRecurringTask(f.db, task.id, { nextRunAt: PAST });
    assert.equal(await f.runner.fireDue(new Date(2026, 8, 6, 3, 0).toISOString()), 0);

    assert.equal(listSessions(f.db, {}).length, 1);
    const occurrence = latestRecurringTaskOccurrence(f.db, task.id);
    assert.equal(occurrence?.outcome, 'skipped');
    assert.match(occurrence?.detail ?? '', /^PR #12 from the previous run/);
  });

  it('fires again once that pull request has been merged', async () => {
    const f = await fixture();
    const task = f.task();
    assert.equal(await f.runner.fireDue(new Date(2026, 8, 5, 3, 0).toISOString()), 1);
    const run = listSessions(f.db, {})[0];
    assert.ok(run);
    updateSession(f.db, run.id, {
      status: 'merged',
      prUrl: 'https://github.com/acme/demo/pull/12',
    });

    updateRecurringTask(f.db, task.id, { nextRunAt: PAST });
    assert.equal(await f.runner.fireDue(new Date(2026, 8, 6, 3, 0).toISOString()), 1);
    assert.equal(listSessions(f.db, {}).length, 2);
    assert.equal(latestRecurringTaskOccurrence(f.db, task.id)?.outcome, 'started');
  });

  it('fires again after a firing that failed before the run began', async () => {
    const f = await fixture();
    const task = f.task();
    // The clone is refused, which leaves a pending session with the reason on
    // it and nothing that will ever pick it up again.
    f.script((exec) =>
      (exec.cmd[2] ?? '').includes('ls-remote')
        ? { exitCode: 0, stdout: 'abc123\trefs/heads/chief/rector-20260905-0300\n' }
        : { exitCode: 1, stderr: 'should not run' },
    );
    assert.equal(await f.runner.fireDue(new Date(2026, 8, 5, 3, 0).toISOString()), 0);
    assert.equal(latestRecurringTaskOccurrence(f.db, task.id)?.outcome, 'fire-failed');
    assert.equal(listSessions(f.db, {})[0]?.status, 'pending');

    // Tomorrow's occurrence is not skipped by that wreckage: one 3am network
    // blip costs the task an occurrence, not the schedule.
    f.script(clonesInto(f.config, f.db));
    assert.equal(await f.runner.fireDue(new Date(2026, 8, 6, 3, 0).toISOString()), 1);
    assert.equal(listSessions(f.db, {}).length, 2);
    assert.equal(latestRecurringTaskOccurrence(f.db, task.id)?.outcome, 'started');
  });

  it('fires again after a firing whose build was refused outright', async () => {
    const f = await fixture();
    const task = f.task();
    // Refused for a reason that is not the queue: the session is left `ready`
    // and never queued, so nothing starts it either.
    f.builds.refusal = new Error('the container is gone');
    assert.equal(await f.runner.fireDue(new Date(2026, 8, 5, 3, 0).toISOString()), 0);
    const [stranded] = listSessions(f.db, {});
    assert.ok(stranded);
    assert.equal(stranded.status, 'ready');
    assert.equal(stranded.queuedAt, null);

    f.builds.refusal = null;
    assert.equal(await f.runner.fireDue(new Date(2026, 8, 6, 3, 0).toISOString()), 1);
    assert.equal(listSessions(f.db, {}).length, 2);
    assert.equal(latestRecurringTaskOccurrence(f.db, task.id)?.outcome, 'started');
  });

  it('fires again after a run that failed', async () => {
    const f = await fixture();
    const task = f.task();
    assert.equal(await f.runner.fireDue(new Date(2026, 8, 5, 3, 0).toISOString()), 1);
    const run = listSessions(f.db, {})[0];
    assert.ok(run);
    updateSession(f.db, run.id, { status: 'failed', lastError: 'The agent stalled.' });

    updateRecurringTask(f.db, task.id, { nextRunAt: PAST });
    assert.equal(await f.runner.fireDue(new Date(2026, 8, 6, 3, 0).toISOString()), 1);
    assert.equal(listSessions(f.db, {}).length, 2);
  });
});

describe('settling a recurring task run', () => {
  it('reads the outcome of each finished run off its session', () => {
    assert.deepEqual(settlementOf(session({ status: 'building' })), null);
    assert.deepEqual(settlementOf(session({ status: 'reviewing', prUrl: 'https://x/1' })), null);
    assert.deepEqual(settlementOf(session({ status: 'pr-open', prUrl: 'https://x/1' })), {
      outcome: 'pr-opened',
      detail: 'https://x/1',
    });
    assert.equal(settlementOf(session({ status: 'merged', prUrl: 'https://x/1' }))?.outcome, 'pr-opened');
    assert.equal(settlementOf(session({ status: 'finished' }))?.outcome, 'clean');
    assert.deepEqual(settlementOf(session({ status: 'failed', lastError: 'boom' })), {
      outcome: 'failed',
      detail: 'boom',
    });
    assert.equal(settlementOf(null)?.outcome, 'failed');
  });

  it('updates the started row, and the task, when the run opens a pull request', async () => {
    const f = await fixture();
    const task = f.task();
    await f.runner.fireDue();
    const run = listSessions(f.db, {})[0];
    assert.ok(run);

    // Still building: there is nothing to settle yet.
    assert.equal(f.runner.settle(), 0);
    assert.equal(latestRecurringTaskOccurrence(f.db, task.id)?.outcome, 'started');

    updateSession(f.db, run.id, { status: 'pr-open', prUrl: 'https://github.com/acme/demo/pull/12' });
    assert.equal(f.runner.settle(), 1);

    const occurrence = latestRecurringTaskOccurrence(f.db, task.id);
    assert.equal(occurrence?.outcome, 'pr-opened');
    assert.equal(occurrence?.detail, 'https://github.com/acme/demo/pull/12');
    assert.equal(getRecurringTask(f.db, task.id)?.lastOutcome, 'pr-opened');
    // Settled once and for all: a second pass has nothing left to do.
    assert.equal(f.runner.settle(), 0);
  });

  it('records a run that finished without a pull request as clean', async () => {
    const f = await fixture();
    const task = f.task();
    await f.runner.fireDue();
    const run = listSessions(f.db, {})[0];
    assert.ok(run);

    updateSession(f.db, run.id, { status: 'finished' });
    assert.equal(f.runner.settle(), 1);

    assert.equal(latestRecurringTaskOccurrence(f.db, task.id)?.outcome, 'clean');
    assert.equal(getRecurringTask(f.db, task.id)?.lastOutcome, 'clean');
  });

  it('records a failed run with the reason the session carries', async () => {
    const f = await fixture();
    const task = f.task();
    await f.runner.fireDue();
    const run = listSessions(f.db, {})[0];
    assert.ok(run);

    updateSession(f.db, run.id, {
      status: 'failed',
      lastError: 'The agent stalled three times on US-001.',
      failureStage: 'agent',
    });
    assert.equal(f.runner.settle(), 1);

    const occurrence = latestRecurringTaskOccurrence(f.db, task.id);
    assert.equal(occurrence?.outcome, 'failed');
    assert.equal(occurrence?.detail, 'The agent stalled three times on US-001.');
    assert.equal(getRecurringTask(f.db, task.id)?.lastOutcome, 'failed');
  });
});

/** A session row, for the settlement decision the tests make directly. */
function session(overrides: Partial<Session>): Session {
  return {
    id: 'session-1',
    repositoryId: 'repo-1',
    name: 'rector-20260905-0300',
    status: 'building',
    baseBranch: 'develop',
    featureBranch: 'chief/rector-20260905-0300',
    prTargetBranch: 'develop',
    scheduledStartAt: null,
    queuedAt: null,
    containerId: null,
    prUrl: null,
    lastError: null,
    failureStage: null,
    waitingUntil: null,
    codeReview: false,
    recurringTaskId: 'task-1',
    createdAt: '2026-09-05T03:00:00.000Z',
    updatedAt: '2026-09-05T03:00:00.000Z',
    ...overrides,
  };
}
