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
  openDatabase,
  type Session,
  type SessionStatus,
  updateSession,
} from '../db/index.js';
import { GithubApiError, type PullRequestState } from '../lib/github.js';
import { setSetting } from '../db/settings.js';
import { PrSyncService, pullRequestNumberOf, type PullRequestStateGateway } from './service.js';

const databases: Database[] = [];

after(() => {
  for (const db of databases) closeDatabase(db);
});

/**
 * Stands in for `GET /repos/{slug}/pulls/{number}`. Every call is recorded, so
 * a test can assert what the tick spent on GitHub as well as what it did with
 * the answers.
 */
class FakeGithub implements PullRequestStateGateway {
  readonly calls: { slug: string; number: number }[] = [];
  /** Answers by `slug#number`; anything unlisted is still open. */
  readonly answers = new Map<string, PullRequestState>();
  /** Failures by `slug#number`, thrown instead of answering. */
  readonly failures = new Map<string, Error>();

  state(_token: string, slug: string, number: number): Promise<PullRequestState> {
    this.calls.push({ slug, number });
    const key = `${slug}#${String(number)}`;
    const failure = this.failures.get(key);
    if (failure !== undefined) return Promise.reject(failure);
    return Promise.resolve(
      this.answers.get(key) ?? { number, state: 'open', merged: false },
    );
  }

  merged(slug: string, number: number): void {
    this.answers.set(`${slug}#${String(number)}`, { number, state: 'closed', merged: true });
  }

  closed(slug: string, number: number): void {
    this.answers.set(`${slug}#${String(number)}`, { number, state: 'closed', merged: false });
  }
}

interface World {
  readonly config: Config;
  readonly db: Database;
  readonly github: FakeGithub;
  readonly sync: PrSyncService;
  readonly repositoryId: string;
  session(input: { name: string; status?: SessionStatus; prUrl?: string | null }): Session;
}

function world(options: { token?: string | null; slug?: string } = {}): World {
  const config = loadConfig({});
  const db = openDatabase(IN_MEMORY);
  databases.push(db);

  const repository = createRepository(db, {
    name: 'demo',
    sshUrl: 'git@github.com:acme/demo.git',
    githubSlug: options.slug ?? 'acme/demo',
  });
  if (options.token !== null) setSetting(db, 'github_token', options.token ?? 'ghp_token');

  const github = new FakeGithub();
  return {
    config,
    db,
    github,
    sync: new PrSyncService(config, db, github),
    repositoryId: repository.id,
    session: (input) => {
      const created = createSession(db, {
        repositoryId: repository.id,
        name: input.name,
        baseBranch: 'main',
        prTargetBranch: 'main',
        status: 'building',
      });
      const prUrl =
        input.prUrl === undefined
          ? `https://github.com/acme/demo/pull/${String(created.name.length)}`
          : input.prUrl;
      return (
        updateSession(db, created.id, { status: input.status ?? 'pr-open', prUrl }) ?? created
      );
    },
  };
}

describe('pull request sync', () => {
  it('moves a session whose pull request was merged to merged', async () => {
    const { db, github, sync, session } = world();
    const merged = session({ name: 'shipped', prUrl: 'https://github.com/acme/demo/pull/7' });
    github.merged('acme/demo', 7);

    assert.equal(await sync.tick(), 1);

    const row = getSession(db, merged.id);
    assert.equal(row?.status, 'merged');
    // The link is what the session page still shows; nothing clears it.
    assert.equal(row?.prUrl, 'https://github.com/acme/demo/pull/7');
    assert.deepEqual(github.calls, [{ slug: 'acme/demo', number: 7 }]);
  });

  it('puts a session whose pull request was closed unmerged back to finished, keeping the URL', async () => {
    const { db, github, sync, session } = world();
    const abandoned = session({ name: 'dropped', prUrl: 'https://github.com/acme/demo/pull/9' });
    github.closed('acme/demo', 9);

    assert.equal(await sync.tick(), 1);

    const row = getSession(db, abandoned.id);
    assert.equal(row?.status, 'finished');
    assert.equal(row?.prUrl, 'https://github.com/acme/demo/pull/9');
    assert.equal(row?.lastError, null);
  });

  it('leaves a session whose pull request is still open exactly where it is', async () => {
    const { db, sync, session } = world();
    const waiting = session({ name: 'in-review', prUrl: 'https://github.com/acme/demo/pull/3' });

    assert.equal(await sync.tick(), 0);

    const row = getSession(db, waiting.id);
    assert.equal(row?.status, 'pr-open');
    assert.equal(row?.updatedAt, waiting.updatedAt);
  });

  it('skips the session GitHub failed on and still processes the others', async () => {
    const { db, github, sync, session } = world();
    const broken = session({ name: 'gone', prUrl: 'https://github.com/acme/demo/pull/1' });
    const rateLimited = session({ name: 'throttled', prUrl: 'https://github.com/acme/demo/pull/2' });
    const fine = session({ name: 'landed', prUrl: 'https://github.com/acme/demo/pull/3' });
    github.failures.set('acme/demo#1', new GithubApiError('github_not_found', 'gone', 404));
    github.failures.set('acme/demo#2', new GithubApiError('github_forbidden', 'rate limited', 403));
    github.merged('acme/demo', 3);

    assert.equal(await sync.tick(), 1);

    // A failure is never evidence about the work, so nothing is failed by it.
    assert.equal(getSession(db, broken.id)?.status, 'pr-open');
    assert.equal(getSession(db, broken.id)?.lastError, null);
    assert.equal(getSession(db, rateLimited.id)?.status, 'pr-open');
    assert.equal(getSession(db, fine.id)?.status, 'merged');
    assert.equal(github.calls.length, 3);
  });

  it('asks GitHub once per pr-open session and about nothing else', async () => {
    const { github, sync, session } = world();
    session({ name: 'open-one', prUrl: 'https://github.com/acme/demo/pull/11' });
    session({ name: 'open-two', prUrl: 'https://github.com/acme/demo/pull/12' });
    session({ name: 'building-one', status: 'building', prUrl: null });
    session({ name: 'finished-one', status: 'finished', prUrl: null });
    session({ name: 'merged-one', status: 'merged', prUrl: 'https://github.com/acme/demo/pull/13' });
    session({ name: 'failed-one', status: 'failed', prUrl: null });

    await sync.tick();

    assert.deepEqual(
      github.calls.map((call) => call.number).sort((left, right) => left - right),
      [11, 12],
    );
  });

  it('never transitions anything but the three states it owns', async () => {
    const { db, github, sync, session } = world();
    const building = session({ name: 'busy', status: 'building', prUrl: null });
    const failed = session({ name: 'broken', status: 'failed', prUrl: null });
    const alreadyMerged = session({
      name: 'done',
      status: 'merged',
      prUrl: 'https://github.com/acme/demo/pull/13',
    });
    github.closed('acme/demo', 13);

    assert.equal(await sync.tick(), 0);

    assert.equal(getSession(db, building.id)?.status, 'building');
    assert.equal(getSession(db, failed.id)?.status, 'failed');
    // Nothing transitions a session out of `merged`, not even a reopened PR.
    assert.equal(getSession(db, alreadyMerged.id)?.status, 'merged');
  });

  it('does not touch GitHub at all when nothing has an open pull request', async () => {
    const { github, sync, session } = world();
    session({ name: 'busy', status: 'building', prUrl: null });

    assert.equal(await sync.tick(), 0);
    assert.equal(github.calls.length, 0);
  });

  it('skips the tick, without failing anything, when no token is configured', async () => {
    const { db, github, sync, session } = world({ token: null });
    const waiting = session({ name: 'in-review', prUrl: 'https://github.com/acme/demo/pull/4' });

    assert.equal(await sync.tick(), 0);
    assert.equal(github.calls.length, 0);
    assert.equal(getSession(db, waiting.id)?.status, 'pr-open');
  });

  it('skips a session whose repository has no usable slug', async () => {
    const { db, github, sync, session } = world({ slug: 'not a slug' });
    const waiting = session({ name: 'in-review', prUrl: 'https://github.com/acme/demo/pull/5' });

    assert.equal(await sync.tick(), 0);
    assert.equal(github.calls.length, 0);
    assert.equal(getSession(db, waiting.id)?.status, 'pr-open');
  });

  it('skips a pr-open session with no pull request URL', async () => {
    const { github, sync, session } = world();
    session({ name: 'urlless', prUrl: null });

    assert.equal(await sync.tick(), 0);
    assert.equal(github.calls.length, 0);
  });

  it('runs one tick at a time and catches up on start', async () => {
    const { github, sync, session } = world();
    session({ name: 'in-review', prUrl: 'https://github.com/acme/demo/pull/6' });

    // Two overlapping ticks are one tick: the second joins the first rather
    // than asking GitHub about the same pull request again.
    const [first, second] = await Promise.all([sync.tick(), sync.tick()]);
    assert.equal(first, 0);
    assert.equal(second, 0);
    assert.equal(github.calls.length, 1);

    // `start` is the catch-up after downtime; the interval is 15 minutes, so
    // the only tick this can observe is that first one.
    sync.start();
    await sync.tick();
    sync.stop();
    assert.equal(github.calls.length, 2);
  });
});

describe('reading a pull request number from its URL', () => {
  it('reads the number of a plain pull request URL', () => {
    assert.equal(pullRequestNumberOf('https://github.com/acme/demo/pull/42'), 42);
  });

  it('tolerates a suffix and an enterprise host', () => {
    assert.equal(pullRequestNumberOf('https://github.example.com/acme/demo/pull/7/files'), 7);
    assert.equal(pullRequestNumberOf('https://github.com/acme/demo/pull/7#discussion_r1'), 7);
  });

  it('refuses anything that is not a pull request URL', () => {
    assert.equal(pullRequestNumberOf('https://github.com/acme/demo/issues/42'), null);
    assert.equal(pullRequestNumberOf('https://github.com/acme/demo/pull/abc'), null);
    assert.equal(pullRequestNumberOf(''), null);
  });
});
