import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import {
  closeDatabase,
  createRepository,
  createSentryIssue,
  type Database,
  findSentryIssue,
  IN_MEMORY,
  listSentryIssues,
  openDatabase,
  type Repository,
  setSetting,
  updateRepository,
  updateSentryIssue,
} from '../db/index.js';

import { SentryApiError, type SentryIssueSummary } from './client.js';
import { type SentryIssueGateway, SentrySyncService } from './sync.js';

const databases: Database[] = [];

after(() => {
  for (const db of databases) closeDatabase(db);
});

/**
 * Stands in for `GET /projects/{org}/{project}/issues/`. Every call is
 * recorded, so a test can assert what the tick spent on Sentry as well as what
 * it did with the answers.
 */
class FakeSentry implements SentryIssueGateway {
  readonly calls: { org: string; project: string }[] = [];
  /** Issues by `org/project`; anything unlisted has none. */
  readonly answers = new Map<string, SentryIssueSummary[]>();
  /** Failures by `org/project`, thrown instead of answering. */
  readonly failures = new Map<string, Error>();

  listUnresolvedIssues(org: string, project: string): Promise<SentryIssueSummary[]> {
    this.calls.push({ org, project });
    const key = `${org}/${project}`;
    const failure = this.failures.get(key);
    if (failure !== undefined) return Promise.reject(failure);
    return Promise.resolve(this.answers.get(key) ?? []);
  }

  serve(org: string, project: string, issues: SentryIssueSummary[]): void {
    this.answers.set(`${org}/${project}`, issues);
  }

  fail(org: string, project: string, error: Error): void {
    this.failures.set(`${org}/${project}`, error);
  }
}

function summary(fields: Partial<SentryIssueSummary> = {}): SentryIssueSummary {
  return {
    id: '4507',
    shortId: 'PROJ-123',
    title: 'TypeError: cannot read property x of undefined',
    culprit: 'app/handlers.ts in handle',
    permalink: 'https://sentry.io/organizations/acme/issues/4507/',
    level: 'error',
    status: 'unresolved',
    count: 1043,
    firstSeen: '2026-08-01T10:00:00.000Z',
    lastSeen: '2026-09-04T22:15:00.000Z',
    ...fields,
  };
}

interface World {
  readonly db: Database;
  readonly sentry: FakeSentry;
  readonly sync: SentrySyncService;
  readonly repository: Repository;
  link(name: string, org: string | null, project: string | null): Repository;
}

function world(options: { token?: string | null; link?: boolean } = {}): World {
  const db = openDatabase(IN_MEMORY);
  databases.push(db);
  if (options.token !== null) setSetting(db, 'sentry_token', options.token ?? 'sntrys_token');

  const repository = createRepository(db, {
    name: 'demo',
    sshUrl: 'git@github.com:acme/demo.git',
    githubSlug: 'acme/demo',
    ...(options.link === false ? {} : { sentryOrg: 'acme', sentryProject: 'web' }),
  });

  const sentry = new FakeSentry();
  // Mirrors the real factory: no token configured means no client at all.
  const sync = new SentrySyncService(db, (database) => (hasToken(database) ? sentry : null));
  return {
    db,
    sentry,
    sync,
    repository,
    link(name, org, project) {
      const other = createRepository(db, {
        name,
        sshUrl: `git@github.com:acme/${name}.git`,
        githubSlug: `acme/${name}`,
        sentryOrg: org,
        sentryProject: project,
      });
      return other;
    },
  };
}

function hasToken(db: Database): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'sentry_token'").get();
  return row !== undefined && row !== null;
}

describe('the Sentry issue poller', () => {
  describe('a tick with nothing to do', () => {
    it('asks Sentry for nothing when no repository is linked', async () => {
      const { sync, sentry } = world({ link: false });

      assert.equal(await sync.tick(), 0);
      assert.equal(await sync.tick(), 0);

      assert.deepEqual(sentry.calls, []);
    });

    it('asks Sentry for nothing when no token is configured', async () => {
      const { sync, sentry, db } = world({ token: null });
      sentry.serve('acme', 'web', [summary()]);

      assert.equal(await sync.tick(), 0);

      assert.deepEqual(sentry.calls, []);
      assert.deepEqual(listSentryIssues(db), []);
    });

    it('skips a repository whose link was only half written', async () => {
      const { sync, sentry, repository, db } = world();
      // Only the service keeps the pair in step; a hand-edited row need not.
      updateRepository(db, repository.id, { sentryProject: null });

      assert.equal(await sync.tick(), 0);

      assert.deepEqual(sentry.calls, []);
    });

    it('polls again once a repository is linked', async () => {
      const { sync, sentry, link } = world({ link: false });

      await sync.tick();
      link('other', 'acme', 'api');
      sentry.serve('acme', 'api', [summary()]);

      assert.equal(await sync.tick(), 1);
      assert.deepEqual(sentry.calls, [{ org: 'acme', project: 'api' }]);
    });
  });

  describe('recording issues', () => {
    it('inserts an unseen issue as pending', async () => {
      const { sync, sentry, db, repository } = world();
      sentry.serve('acme', 'web', [summary()]);

      assert.equal(await sync.tick(), 1);

      const issue = findSentryIssue(db, '4507');
      assert.ok(issue);
      assert.equal(issue.repositoryId, repository.id);
      assert.equal(issue.shortId, 'PROJ-123');
      assert.equal(issue.title, 'TypeError: cannot read property x of undefined');
      assert.equal(issue.culprit, 'app/handlers.ts in handle');
      assert.equal(issue.permalink, 'https://sentry.io/organizations/acme/issues/4507/');
      assert.equal(issue.level, 'error');
      assert.equal(issue.eventCount, 1043);
      assert.equal(issue.firstSeen, '2026-08-01T10:00:00.000Z');
      assert.equal(issue.lastSeen, '2026-09-04T22:15:00.000Z');
      assert.equal(issue.status, 'pending');
      assert.equal(issue.sessionId, null);
      assert.equal(issue.attempts, 0);
    });

    it('keeps a nullable culprit and level', async () => {
      const { sync, sentry, db } = world();
      sentry.serve('acme', 'web', [summary({ culprit: null, level: null })]);

      assert.equal(await sync.tick(), 1);

      const issue = findSentryIssue(db, '4507');
      assert.equal(issue?.culprit, null);
      assert.equal(issue?.level, null);
    });

    it('inserts each issue once, however often it is polled', async () => {
      const { sync, sentry, db } = world();
      sentry.serve('acme', 'web', [summary(), summary({ id: '4508', shortId: 'PROJ-124' })]);

      assert.equal(await sync.tick(), 2);
      // Same page again: nothing is new the second time round.
      assert.equal(await sync.tick(), 0);
      assert.equal(await sync.tick(), 0);

      assert.equal(listSentryIssues(db).length, 2);
    });

    it('refreshes the counts of a tracked issue without touching its status', async () => {
      const { sync, sentry, db } = world();
      sentry.serve('acme', 'web', [summary()]);
      await sync.tick();

      // The pipeline has moved the issue on since the first poll.
      const first = findSentryIssue(db, '4507');
      assert.ok(first);
      updateSentryIssue(db, first.id, {
        status: 'working',
        explanation: 'in progress',
        attempts: 2,
      });

      sentry.serve('acme', 'web', [
        summary({
          count: 2000,
          lastSeen: '2026-09-05T08:00:00.000Z',
          title: 'TypeError: cannot read property y of undefined',
        }),
      ]);
      assert.equal(await sync.tick(), 0);

      const refreshed = findSentryIssue(db, '4507');
      assert.ok(refreshed);
      assert.equal(refreshed.id, first.id);
      assert.equal(refreshed.eventCount, 2000);
      assert.equal(refreshed.lastSeen, '2026-09-05T08:00:00.000Z');
      assert.equal(refreshed.title, 'TypeError: cannot read property y of undefined');
      // Nothing the pipeline owns moved.
      assert.equal(refreshed.status, 'working');
      assert.equal(refreshed.explanation, 'in progress');
      assert.equal(refreshed.attempts, 2);
      assert.equal(refreshed.firstSeen, first.firstSeen);
    });

    it('never inserts an issue Sentry says is resolved or ignored', async () => {
      const { sync, sentry, db } = world();
      sentry.serve('acme', 'web', [
        summary({ id: '1', shortId: 'PROJ-1', status: 'resolved' }),
        summary({ id: '2', shortId: 'PROJ-2', status: 'ignored' }),
        summary({ id: '3', shortId: 'PROJ-3', status: 'unresolved' }),
        // Sentry omitted the field: the `is:unresolved` query is the guarantee.
        summary({ id: '4', shortId: 'PROJ-4', status: null }),
      ]);

      assert.equal(await sync.tick(), 2);

      assert.deepEqual(
        listSentryIssues(db)
          .map((issue) => issue.sentryIssueId)
          .sort(),
        ['3', '4'],
      );
    });

    it('does not revive an issue that was resolved after it was recorded', async () => {
      const { sync, sentry, db } = world();
      sentry.serve('acme', 'web', [summary()]);
      await sync.tick();
      const first = findSentryIssue(db, '4507');
      assert.ok(first);
      updateSentryIssue(db, first.id, { status: 'fixed' });

      // Resolved upstream, so it stops arriving. The row stays as it was.
      sentry.serve('acme', 'web', []);
      assert.equal(await sync.tick(), 0);

      assert.equal(findSentryIssue(db, '4507')?.status, 'fixed');
    });

    it('files each repository’s issues against that repository', async () => {
      const { sync, sentry, db, repository, link } = world();
      const other = link('api', 'acme', 'api');
      sentry.serve('acme', 'web', [summary()]);
      sentry.serve('acme', 'api', [summary({ id: '9000', shortId: 'API-1' })]);

      assert.equal(await sync.tick(), 2);

      assert.equal(findSentryIssue(db, '4507')?.repositoryId, repository.id);
      assert.equal(findSentryIssue(db, '9000')?.repositoryId, other.id);
    });
  });

  describe('when Sentry fails', () => {
    it('leaves that repository’s rows untouched and syncs the others', async () => {
      const { sync, sentry, db, repository, link } = world();
      link('api', 'acme', 'api');

      // Something is already tracked for the repository that is about to fail.
      const tracked = createSentryIssue(db, {
        repositoryId: repository.id,
        sentryIssueId: '4507',
        shortId: 'PROJ-123',
        title: 'TypeError: cannot read property x of undefined',
        permalink: 'https://sentry.io/organizations/acme/issues/4507/',
        eventCount: 12,
        firstSeen: '2026-08-01T10:00:00.000Z',
        lastSeen: '2026-09-01T10:00:00.000Z',
      });
      updateSentryIssue(db, tracked.id, { status: 'queued' });

      sentry.fail(
        'acme',
        'web',
        new SentryApiError('sentry_unauthorized', 'Sentry rejected the token.', 401),
      );
      sentry.serve('acme', 'api', [summary({ id: '9000', shortId: 'API-1' })]);

      // The repositories are walked in name order, so `acme/api` is asked
      // first and the failure below is not the last thing the tick does.
      assert.equal(await sync.tick(), 1);

      const untouched = findSentryIssue(db, '4507');
      assert.equal(untouched?.status, 'queued');
      assert.equal(untouched?.eventCount, 12);
      assert.equal(untouched?.lastSeen, '2026-09-01T10:00:00.000Z');
      assert.ok(findSentryIssue(db, '9000'));
      assert.deepEqual(sentry.calls, [
        { org: 'acme', project: 'api' },
        { org: 'acme', project: 'web' },
      ]);
    });

    it('tries the same repository again on the next tick', async () => {
      const { sync, sentry, db } = world();
      sentry.fail('acme', 'web', new SentryApiError('sentry_unreachable', 'Could not connect.'));

      assert.equal(await sync.tick(), 0);
      assert.deepEqual(listSentryIssues(db), []);

      sentry.failures.clear();
      sentry.serve('acme', 'web', [summary()]);
      assert.equal(await sync.tick(), 1);
    });
  });

  describe('the timer', () => {
    let polling: World;

    beforeEach(() => {
      polling = world();
      polling.sentry.serve('acme', 'web', [summary()]);
    });

    it('re-reads the interval from the settings before every wait', () => {
      const { db, sync } = polling;
      // The default when nothing has been saved.
      assert.equal(sync.intervalMs(), 15 * 60_000);
      setSetting(db, 'sentry_poll_interval_minutes', '3');
      assert.equal(sync.intervalMs(), 3 * 60_000);
    });

    it('catches up immediately on start, and stopping twice is harmless', async () => {
      const { sync, db } = polling;

      sync.start();
      // The catch-up tick is in flight; joining it is what `tick()` does.
      await sync.tick();

      assert.equal(listSentryIssues(db).length, 1);
      sync.stop();
      sync.stop();
    });

    it('starts only once', async () => {
      const { sync, sentry } = polling;

      sync.start();
      sync.start();
      await sync.tick();

      assert.equal(sentry.calls.length, 1);
      sync.stop();
    });

    it('joins the tick already in flight rather than overlapping it', async () => {
      const { sync, sentry } = polling;

      const first = sync.tick();
      const second = sync.tick();
      assert.equal(first, second);

      assert.deepEqual(await Promise.all([first, second]), [1, 1]);
      // One tick, so one call: the second never started its own pass.
      assert.equal(sentry.calls.length, 1);
      // And once it has settled, a new tick really does run.
      assert.equal(await sync.tick(), 0);
      assert.equal(sentry.calls.length, 2);
    });
  });

  describe('the classification pass hung off it (US-006)', () => {
    it('runs once the poll is done', async () => {
      const { db, sentry, repository } = world();
      sentry.serve('acme', 'web', [summary()]);
      const passes: number[] = [];
      const sync = new SentrySyncService(db, () => sentry, {
        classifyPending: () => {
          // Whatever the poll inserted is already there to be judged.
          passes.push(listSentryIssues(db).length);
          return Promise.resolve(1);
        },
      });

      assert.equal(await sync.tick(), 1);

      assert.deepEqual(passes, [1]);
      assert.equal(repository.sentryOrg, 'acme');
    });

    it('is skipped when there was nothing to poll', async () => {
      const { db, sentry } = world({ link: false });
      let passes = 0;
      const sync = new SentrySyncService(db, () => sentry, {
        classifyPending: () => {
          passes += 1;
          return Promise.resolve(0);
        },
      });

      await sync.tick();

      assert.equal(passes, 0);
    });

    it('never fails the poll', async () => {
      const { db, sentry } = world();
      sentry.serve('acme', 'web', [summary()]);
      const sync = new SentrySyncService(db, () => sentry, {
        classifyPending: () => Promise.reject(new Error('the container is on fire')),
      });

      assert.equal(await sync.tick(), 1);

      assert.equal(listSentryIssues(db).length, 1);
    });
  });

  describe('the fix session pass hung off it (US-007)', () => {
    it('runs after the classification pass, in the same tick', async () => {
      const { db, sentry } = world();
      sentry.serve('acme', 'web', [summary()]);
      const order: string[] = [];
      const sync = new SentrySyncService(
        db,
        () => sentry,
        {
          classifyPending: () => {
            order.push('classify');
            return Promise.resolve(1);
          },
        },
        {
          createFixSessions: () => {
            order.push('fix');
            return Promise.resolve(1);
          },
        },
      );

      assert.equal(await sync.tick(), 1);

      assert.deepEqual(order, ['classify', 'fix']);
    });

    it('is skipped when there was nothing to poll', async () => {
      const { db, sentry } = world({ link: false });
      let passes = 0;
      const sync = new SentrySyncService(db, () => sentry, null, {
        createFixSessions: () => {
          passes += 1;
          return Promise.resolve(0);
        },
      });

      await sync.tick();

      assert.equal(passes, 0);
    });

    it('never fails the poll', async () => {
      const { db, sentry } = world();
      sentry.serve('acme', 'web', [summary()]);
      const sync = new SentrySyncService(db, () => sentry, null, {
        createFixSessions: () => Promise.reject(new Error('no deploy key')),
      });

      assert.equal(await sync.tick(), 1);

      assert.equal(listSentryIssues(db).length, 1);
    });
  });
});
