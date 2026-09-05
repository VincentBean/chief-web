import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { type Config, loadConfig } from '../config.js';
import {
  closeDatabase,
  createRepository,
  createSession,
  type Database,
  getSession,
  IN_MEMORY,
  listDueWaitingSessions,
  isScheduleMissed,
  openDatabase,
  type Session,
  type SessionStatus,
  updateSession,
} from '../db/index.js';
import { UsageLimitHold } from '../limits/index.js';
import {
  type ScheduledBuilds,
  type SchedulerRecurringTasks,
  SchedulerService,
} from './service.js';

const databases: Database[] = [];

after(() => {
  for (const db of databases) closeDatabase(db);
});

/**
 * Stands in for `BuildService.start` (US-013), including the part this story
 * relies on: a session that enters `building` has spent its schedule.
 */
class FakeBuilds implements ScheduledBuilds {
  readonly started: string[] = [];
  /** How often the tick asked the build queue to move (US-018). */
  pumps = 0;
  /** Session ids the build refuses to start, and why. */
  readonly refuse = new Map<string, string>();
  /** The held sessions the tick resumed, in order (US-006). */
  readonly resumed: string[] = [];

  constructor(private readonly db: Database) {}

  start(sessionId: string): Promise<unknown> {
    const reason = this.refuse.get(sessionId);
    if (reason !== undefined) return Promise.reject(new Error(reason));
    this.started.push(sessionId);
    updateSession(this.db, sessionId, {
      status: 'building',
      lastError: null,
      scheduledStartAt: null,
    });
    return Promise.resolve({});
  }

  /** Stands in for `BuildService.resumeHeld`: the hold is up, so it continues. */
  resumeHeld(now?: string): Promise<unknown> {
    for (const session of listDueWaitingSessions(this.db, now)) {
      this.resumed.push(session.id);
      updateSession(this.db, session.id, { status: 'building', waitingUntil: null });
    }
    return Promise.resolve({});
  }

  pump(): Promise<unknown> {
    this.pumps += 1;
    return Promise.resolve({});
  }
}

/** Stands in for the recurring task runner (US-004). */
class FakeRecurringTasks implements SchedulerRecurringTasks {
  /** The `now` of every tick that asked for the due tasks, in order. */
  readonly fired: string[] = [];
  /** How often the finished runs were read off their sessions. */
  settled = 0;

  fireDue(now: string = ''): Promise<number> {
    this.fired.push(now);
    return Promise.resolve(this.fired.length);
  }

  settle(): number {
    this.settled += 1;
    return 0;
  }
}

interface World {
  readonly config: Config;
  readonly db: Database;
  readonly builds: FakeBuilds;
  readonly tasks: FakeRecurringTasks;
  readonly scheduler: SchedulerService;
  session(input: { status?: SessionStatus; at?: string | null; name?: string }): Session;
}

function world(env: Record<string, string> = {}): World {
  const config = loadConfig(env);
  const db = openDatabase(IN_MEMORY);
  databases.push(db);
  const repository = createRepository(db, {
    name: 'demo',
    sshUrl: 'git@github.com:acme/demo.git',
    githubSlug: 'acme/demo',
  });
  const builds = new FakeBuilds(db);
  const tasks = new FakeRecurringTasks();
  let created = 0;

  return {
    config,
    db,
    builds,
    tasks,
    scheduler: new SchedulerService(config, db, builds, new UsageLimitHold(db), tasks),
    session({ status = 'ready', at = null, name }) {
      created += 1;
      return createSession(db, {
        repositoryId: repository.id,
        name: name ?? `session-${String(created)}`,
        baseBranch: 'main',
        prTargetBranch: 'main',
        status,
        scheduledStartAt: at,
      });
    },
  };
}

const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

describe('the session scheduler', () => {
  it('starts a ready session whose scheduled time has passed', async () => {
    const w = world();
    const due = w.session({ at: PAST });
    const later = w.session({ at: FUTURE });
    const unscheduled = w.session({});

    assert.equal(await w.scheduler.tick(), 1);

    assert.deepEqual(w.builds.started, [due.id]);
    assert.equal(getSession(w.db, due.id)?.status, 'building');
    assert.equal(getSession(w.db, later.id)?.status, 'ready');
    assert.equal(getSession(w.db, unscheduled.id)?.status, 'ready');
  });

  it('spends the schedule when the session starts building, so it never fires twice', async () => {
    const w = world();
    const due = w.session({ at: PAST });

    await w.scheduler.tick();
    assert.equal(getSession(w.db, due.id)?.scheduledStartAt, null);

    // The build is stopped and the session goes back to ready. A stale
    // timestamp would restart it here; there is none.
    updateSession(w.db, due.id, { status: 'ready' });
    assert.equal(await w.scheduler.tick(), 0);
    assert.deepEqual(w.builds.started, [due.id]);
  });

  it('keeps a due schedule for after Claude’s usage-limit hold (US-005)', async () => {
    const w = world();
    const due = w.session({ at: PAST });
    const hold = new UsageLimitHold(w.db);
    hold.arm();

    // Nothing is started, and — the point of the story — nothing is spent: a
    // start now would only be refused, and the schedule would be gone.
    assert.equal(await w.scheduler.tick(), 0);
    assert.deepEqual(w.builds.started, []);
    const held = getSession(w.db, due.id);
    assert.equal(held?.status, 'ready');
    assert.equal(held?.scheduledStartAt, PAST);
    assert.equal(held?.lastError, null);
    assert.equal(await w.scheduler.fire(due.id), false);

    // It is simply still due when the hold lifts.
    hold.clear();
    assert.equal(await w.scheduler.tick(), 1);
    assert.deepEqual(w.builds.started, [due.id]);
    assert.equal(getSession(w.db, due.id)?.status, 'building');
  });

  it('leaves a pending session alone: a missed schedule is not a start', async () => {
    const w = world();
    const missed = w.session({ status: 'pending', at: PAST });

    assert.equal(await w.scheduler.tick(), 0);

    const row = getSession(w.db, missed.id);
    assert.equal(row?.status, 'pending');
    // The timestamp stays: it is what the UI reads to say the schedule was missed.
    assert.equal(row?.scheduledStartAt, PAST);
    assert.equal(isScheduleMissed(row ?? missed), true);
  });

  it('catches up at startup on everything that came due while the stack was down', async () => {
    const w = world();
    const overnight = w.session({ at: PAST });

    w.scheduler.start();
    // `start()` fires the catch-up without waiting for the first interval.
    await w.scheduler.tick();
    w.scheduler.stop();

    assert.deepEqual(w.builds.started, [overnight.id]);
    assert.equal(getSession(w.db, overnight.id)?.status, 'building');
  });

  it('clears a schedule it could not honour, with the reason on the session', async () => {
    const w = world();
    const due = w.session({ at: PAST });
    w.builds.refuse.set(due.id, 'The session container could not be started: no such image');

    assert.equal(await w.scheduler.tick(), 0);

    const row = getSession(w.db, due.id);
    assert.equal(row?.status, 'ready');
    // One-shot means one attempt: it must not be retried every 30 seconds.
    assert.equal(row?.scheduledStartAt, null);
    assert.match(row?.lastError ?? '', /could not be started, so the schedule was cleared/);
    assert.match(row?.lastError ?? '', /no such image/);
    assert.equal(await w.scheduler.tick(), 0);
  });

  it('fires one session on demand, and only while it is ready and due', async () => {
    const w = world();
    const due = w.session({ at: PAST });
    const pending = w.session({ status: 'pending', at: PAST });
    const later = w.session({ at: FUTURE });

    assert.equal(await w.scheduler.fire(pending.id), false);
    assert.equal(await w.scheduler.fire(later.id), false);
    assert.equal(await w.scheduler.fire('no-such-session'), false);
    assert.equal(await w.scheduler.fire(due.id), true);

    assert.deepEqual(w.builds.started, [due.id]);
  });

  it('never runs two passes at once', async () => {
    const w = world();
    w.session({ at: PAST });

    const [first, second] = await Promise.all([w.scheduler.tick(), w.scheduler.tick()]);
    assert.equal(first, 1);
    // The second caller joined the pass in flight rather than firing again.
    assert.equal(second, 1);
    assert.equal(w.builds.started.length, 1);
  });

  it('drives the build queue on every tick, so a restart picks it up (US-018)', async () => {
    const w = world();
    // Nothing is due: the queue is moved along regardless, which is what makes
    // the boot tick the catch-up for sessions that were queued when the stack
    // went down.
    await w.scheduler.tick();
    assert.equal(w.builds.pumps, 1);

    w.session({ at: PAST });
    await w.scheduler.tick();
    assert.equal(w.builds.pumps, 2);
  });

  it('resumes the sessions whose usage-limit hold has run out (US-006)', async () => {
    const w = world();
    const held = w.session({ status: 'waiting' });
    const stillHeld = w.session({ status: 'waiting' });
    updateSession(w.db, held.id, { waitingUntil: '2026-08-29T09:00:00.000Z' });
    updateSession(w.db, stillHeld.id, { waitingUntil: '2026-08-29T11:00:00.000Z' });

    await w.scheduler.tick('2026-08-29T10:00:00.000Z');

    // The hour was up for one of them and not for the other; the tick is the
    // only thing looking at the clock, so it is what tells them apart.
    assert.deepEqual(w.builds.resumed, [held.id]);
    assert.equal(getSession(w.db, held.id)?.status, 'building');
    assert.equal(getSession(w.db, held.id)?.waitingUntil, null);
    assert.equal(getSession(w.db, stillHeld.id)?.status, 'waiting');
    // And the tick still did everything else it does.
    assert.equal(w.builds.pumps, 1);
  });

  it('fires the due recurring tasks after its own work (US-004)', async () => {
    const w = world();
    w.session({ at: PAST });

    await w.scheduler.tick('2026-09-05T03:00:00.000Z');

    // The tick's own work first — a scheduled start and the queue — and then
    // the recurring half, with the same moment it read everything else at.
    assert.deepEqual(w.builds.started.length, 1);
    assert.equal(w.builds.pumps, 1);
    assert.deepEqual(w.tasks.fired, ['2026-09-05T03:00:00.000Z']);
    // Exactly one pass per tick: a task can fire at most once in it.
    assert.equal(w.tasks.settled, 1);

    await w.scheduler.tick('2026-09-05T03:00:30.000Z');
    assert.deepEqual(w.tasks.fired, [
      '2026-09-05T03:00:00.000Z',
      '2026-09-05T03:00:30.000Z',
    ]);
  });

  it('leaves due recurring tasks due while the usage-limit hold is on (US-004)', async () => {
    const w = world();
    const hold = new UsageLimitHold(w.db);
    hold.arm();

    await w.scheduler.tick('2026-09-05T03:00:00.000Z');

    // Not fired — the occurrence is not spent on a refusal — but the runs that
    // ended while the hold was on are still read off their sessions.
    assert.deepEqual(w.tasks.fired, []);
    assert.equal(w.tasks.settled, 1);

    hold.clear();
    await w.scheduler.tick('2026-09-05T04:00:00.000Z');
    assert.deepEqual(w.tasks.fired, ['2026-09-05T04:00:00.000Z']);
  });

  it('refuses an interval that would break the 30 second promise', () => {
    assert.equal(loadConfig({}).schedulerIntervalMs, 30_000);
    assert.equal(loadConfig({ SCHEDULER_INTERVAL_MS: '5000' }).schedulerIntervalMs, 5_000);
    assert.throws(
      () => loadConfig({ SCHEDULER_INTERVAL_MS: '60000' }),
      /between 1000 and 30000/,
    );
  });
});
