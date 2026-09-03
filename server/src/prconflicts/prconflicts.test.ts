import assert from 'node:assert/strict';
import { after, describe, it, type TestContext } from 'node:test';

import { type Config, loadConfig } from '../config.js';
import {
  closeDatabase,
  createPrConflictFix,
  createPrReview,
  createPrRun,
  createRepository,
  type Database,
  findPrConflictFix,
  IN_MEMORY,
  openDatabase,
  updatePrConflictFix,
  updatePrReview,
  updatePrRun,
} from '../db/index.js';
import { setSetting } from '../db/settings.js';
import { GithubApiError, type PullRequestMergeability } from '../lib/github.js';
import type { OpenPullRequest, RepositoryPullRequests } from '../lib/github-review.js';
import {
  type ConflictedPullRequest,
  type ConflictFixStarter,
  type ConflictScanGateway,
  PrConflictService,
} from './service.js';

const databases: Database[] = [];

after(() => {
  for (const db of databases) closeDatabase(db);
});

/**
 * Stands in for the two GitHub calls a tick can make. Every one is recorded, so
 * a test can assert what the tick spent on GitHub — the filters are only worth
 * anything if they run *before* the detail request.
 */
class FakeGithub implements ConflictScanGateway {
  readonly listCalls: string[][] = [];
  readonly mergeabilityCalls: { slug: string; number: number }[] = [];
  /** Listings by slug; a slug with no entry comes back empty. */
  readonly listings = new Map<string, RepositoryPullRequests>();
  /** Thrown by `list` instead of answering: GitHub itself being unreachable. */
  listFailure: Error | null = null;
  /** Mergeability by `slug#number`; anything unlisted is clean. */
  readonly answers = new Map<string, PullRequestMergeability>();
  /** Failures by `slug#number`, thrown instead of answering. */
  readonly failures = new Map<string, Error>();

  list(_token: string, slugs: readonly string[]): Promise<RepositoryPullRequests[]> {
    this.listCalls.push([...slugs]);
    if (this.listFailure !== null) return Promise.reject(this.listFailure);
    return Promise.resolve(
      slugs.map(
        (slug) =>
          this.listings.get(slug) ?? {
            slug,
            pullRequests: [],
            error: null,
            message: null,
            truncated: false,
          },
      ),
    );
  }

  mergeability(_token: string, slug: string, number: number): Promise<PullRequestMergeability> {
    this.mergeabilityCalls.push({ slug, number });
    const key = `${slug}#${String(number)}`;
    const failure = this.failures.get(key);
    if (failure !== undefined) return Promise.reject(failure);
    return Promise.resolve(this.answers.get(key) ?? mergeability({ number }));
  }

  /** Puts one repository's listing in place, filling in the boring fields. */
  open(slug: string, pullRequests: Partial<OpenPullRequest>[], truncated = false): void {
    this.listings.set(slug, {
      slug,
      pullRequests: pullRequests.map((pull) => openPullRequest(pull)),
      error: null,
      message: null,
      truncated,
    });
  }

  /** Puts a per-repository listing failure in place; the others still answer. */
  broken(slug: string, error: RepositoryPullRequests['error'], message: string): void {
    this.listings.set(slug, {
      slug,
      pullRequests: [],
      error,
      message,
      truncated: false,
    });
  }

  says(slug: string, number: number, answer: Partial<PullRequestMergeability>): void {
    this.answers.set(`${slug}#${String(number)}`, mergeability({ number, ...answer }));
  }
}

/** Stands in for the fix pipeline US-005 plugs in. */
class FakeStarter implements ConflictFixStarter {
  readonly started: ConflictedPullRequest[] = [];
  /** Thrown instead of starting: no free build slot, a usage-limit hold. */
  failure: Error | null = null;

  start(pull: ConflictedPullRequest): Promise<void> {
    this.started.push(pull);
    return this.failure === null ? Promise.resolve() : Promise.reject(this.failure);
  }
}

function openPullRequest(overrides: Partial<OpenPullRequest> = {}): OpenPullRequest {
  const number = overrides.number ?? 1;
  return {
    number,
    title: `Pull request #${String(number)}`,
    url: `https://github.com/acme/demo/pull/${String(number)}`,
    headRef: 'chief/feature',
    headSha: 'head000',
    headSlug: 'acme/demo',
    baseRef: 'main',
    fromFork: false,
    draft: false,
    authorLogin: 'chief-web',
    updatedAt: '2026-09-03T10:00:00.000Z',
    ...overrides,
  };
}

function mergeability(overrides: Partial<PullRequestMergeability> = {}): PullRequestMergeability {
  return {
    number: 1,
    mergeable: 'clean',
    mergeableState: 'clean',
    headSha: 'head000',
    baseSha: 'base000',
    headRef: 'chief/feature',
    baseRef: 'main',
    body: 'Why this pull request exists.',
    ...overrides,
  };
}

interface World {
  readonly config: Config;
  readonly db: Database;
  readonly github: FakeGithub;
  readonly starter: FakeStarter;
  readonly scan: PrConflictService;
  readonly repositoryId: string;
  /** A second connected repository, for the per-repository failure tests. */
  repository(name: string, slug: string): string;
}

function world(options: { token?: string | null; repositories?: boolean } = {}): World {
  const config = loadConfig({});
  const db = openDatabase(IN_MEMORY);
  databases.push(db);

  const repository =
    options.repositories === false
      ? null
      : createRepository(db, {
          name: 'demo',
          sshUrl: 'git@github.com:acme/demo.git',
          githubSlug: 'acme/demo',
        });
  if (options.token !== null) setSetting(db, 'github_token', options.token ?? 'ghp_token');

  const github = new FakeGithub();
  const starter = new FakeStarter();
  return {
    config,
    db,
    github,
    starter,
    scan: new PrConflictService(config, db, github, starter),
    repositoryId: repository?.id ?? '',
    repository: (name, slug) =>
      createRepository(db, { name, sshUrl: `git@github.com:${slug}.git`, githubSlug: slug }).id,
  };
}

describe('pull request conflict scan', () => {
  it('reports a conflicted chief branch with the commits it was seen at', async () => {
    const { github, scan, starter, repositoryId } = world();
    github.open('acme/demo', [{ number: 7, headRef: 'chief/fix-login', title: 'Fix login' }]);
    github.says('acme/demo', 7, {
      mergeable: 'conflicted',
      mergeableState: 'dirty',
      headSha: 'aaa111',
      baseSha: 'bbb222',
      headRef: 'chief/fix-login',
      baseRef: 'main',
      body: 'Login broke when the session cookie moved.',
    });

    assert.equal(await scan.tick(), 1);

    assert.deepEqual(github.mergeabilityCalls, [{ slug: 'acme/demo', number: 7 }]);
    assert.deepEqual(starter.started, [
      {
        repositoryId,
        repositoryName: 'demo',
        slug: 'acme/demo',
        prNumber: 7,
        prUrl: 'https://github.com/acme/demo/pull/7',
        prTitle: 'Fix login',
        // Carried for the agent's prompt: what the pull request is for is
        // most of what deciding between two conflicting hunks needs (US-005).
        prBody: 'Login broke when the session cookie moved.',
        headBranch: 'chief/fix-login',
        baseBranch: 'main',
        headSha: 'aaa111',
        baseSha: 'bbb222',
      },
    ]);
  });

  it('fixes a draft pull request like any other', async () => {
    const { github, scan, starter } = world();
    github.open('acme/demo', [{ number: 4, draft: true }]);
    github.says('acme/demo', 4, { mergeable: 'conflicted' });

    assert.equal(await scan.tick(), 1);
    assert.equal(starter.started.length, 1);
  });

  it('leaves a mergeable pull request alone and clears its stale failure', async () => {
    const { db, github, scan, starter, repositoryId } = world();
    github.open('acme/demo', [{ number: 3 }]);
    github.says('acme/demo', 3, { mergeable: 'clean', headSha: 'head000', baseSha: 'base000' });
    const stale = createPrConflictFix(db, {
      repositoryId,
      prNumber: 3,
      prUrl: 'https://github.com/acme/demo/pull/3',
      prTitle: 'Pull request #3',
      headBranch: 'chief/feature',
      baseBranch: 'main',
      headSha: 'head000',
      baseSha: 'base000',
    });
    updatePrConflictFix(db, stale.id, { status: 'failed', failureStage: 'agent' });

    assert.equal(await scan.tick(), 0);

    assert.deepEqual(starter.started, []);
    assert.equal(findPrConflictFix(db, repositoryId, 3), null);
  });

  it('skips a pull request whose head branch is not a chief branch, without asking GitHub', async () => {
    const { github, scan, starter } = world();
    github.open('acme/demo', [
      { number: 11, headRef: 'feature/theirs' },
      { number: 12, headRef: 'chiefly-mine' },
    ]);

    assert.equal(await scan.tick(), 0);

    assert.deepEqual(github.mergeabilityCalls, []);
    assert.deepEqual(starter.started, []);
  });

  it('skips a pull request from a fork, without asking GitHub', async () => {
    const { github, scan, starter } = world();
    github.open('acme/demo', [
      { number: 21, headRef: 'chief/from-a-fork', fromFork: true, headSlug: 'someone/demo' },
    ]);

    assert.equal(await scan.tick(), 0);

    assert.deepEqual(github.mergeabilityCalls, []);
    assert.deepEqual(starter.started, []);
  });

  it('skips a pull request GitHub has not computed the mergeability of yet', async () => {
    const { db, github, scan, starter, repositoryId } = world();
    github.open('acme/demo', [{ number: 5 }]);
    github.says('acme/demo', 5, { mergeable: 'unknown', mergeableState: 'unknown' });

    assert.equal(await scan.tick(), 0);

    // Asked once and only once: the answer comes on the next tick.
    assert.deepEqual(github.mergeabilityCalls, [{ slug: 'acme/demo', number: 5 }]);
    assert.deepEqual(starter.started, []);
    assert.equal(findPrConflictFix(db, repositoryId, 5), null);
  });

  it('skips a pull request that already has a feedback run, a review or a fix on it', async () => {
    const { db, github, scan, starter, repositoryId } = world();
    github.open('acme/demo', [{ number: 31 }, { number: 32 }, { number: 33 }, { number: 34 }]);
    for (const number of [31, 32, 33, 34]) {
      github.says('acme/demo', number, { mergeable: 'conflicted' });
    }

    const run = createPrRun(db, {
      repositoryId,
      prNumber: 31,
      prUrl: 'https://github.com/acme/demo/pull/31',
      prTitle: 'Pull request #31',
      headBranch: 'chief/feature',
      baseBranch: 'main',
    });
    updatePrRun(db, run.id, { status: 'running' });
    const review = createPrReview(db, {
      repositoryId,
      prNumber: 32,
      prUrl: 'https://github.com/acme/demo/pull/32',
      prTitle: 'Pull request #32',
      headBranch: 'chief/feature',
      baseBranch: 'main',
    });
    updatePrReview(db, review.id, { status: 'running' });
    createPrConflictFix(db, {
      repositoryId,
      prNumber: 33,
      prUrl: 'https://github.com/acme/demo/pull/33',
      prTitle: 'Pull request #33',
      headBranch: 'chief/feature',
      baseBranch: 'main',
      headSha: 'head000',
      baseSha: 'base000',
    });

    // Only #34, the one with nothing on it, is worth a request at all.
    assert.equal(await scan.tick(), 1);
    assert.deepEqual(github.mergeabilityCalls, [{ slug: 'acme/demo', number: 34 }]);
    assert.deepEqual(
      starter.started.map((pull) => pull.prNumber),
      [34],
    );
  });

  it('does not retry a fix that already failed on these very commits', async () => {
    const { db, github, scan, starter, repositoryId } = world();
    github.open('acme/demo', [{ number: 41 }]);
    github.says('acme/demo', 41, { mergeable: 'conflicted', headSha: 'aaa', baseSha: 'bbb' });
    const failed = createPrConflictFix(db, {
      repositoryId,
      prNumber: 41,
      prUrl: 'https://github.com/acme/demo/pull/41',
      prTitle: 'Pull request #41',
      headBranch: 'chief/feature',
      baseBranch: 'main',
      headSha: 'aaa',
      baseSha: 'bbb',
    });
    updatePrConflictFix(db, failed.id, { status: 'failed', failureStage: 'verify' });

    assert.equal(await scan.tick(), 0);
    assert.deepEqual(starter.started, []);

    // The base branch moves: the conflict is a different one, so it is fair game.
    github.says('acme/demo', 41, { mergeable: 'conflicted', headSha: 'aaa', baseSha: 'ccc' });
    assert.equal(await scan.tick(), 1);
    assert.equal(starter.started.length, 1);
  });

  it('starts a fresh fix once the head branch has moved past a failure (US-006)', async () => {
    const { db, github, scan, starter, repositoryId } = world();
    github.open('acme/demo', [{ number: 42 }]);
    github.says('acme/demo', 42, { mergeable: 'conflicted', headSha: 'aaa', baseSha: 'bbb' });
    const failed = createPrConflictFix(db, {
      repositoryId,
      prNumber: 42,
      prUrl: 'https://github.com/acme/demo/pull/42',
      prTitle: 'Pull request #42',
      headBranch: 'chief/feature',
      baseBranch: 'main',
      headSha: 'aaa',
      baseSha: 'bbb',
    });
    updatePrConflictFix(db, failed.id, {
      status: 'failed',
      failureStage: 'verify',
      attempts: 3,
      lastError: 'The merge conflicts could not be resolved after 3 attempts.',
    });

    // The three attempts are spent, so nothing is tried while the pull request
    // stands where it failed: this is the state the operator is looking at.
    assert.equal(await scan.tick(), 0);
    assert.deepEqual(starter.started, []);
    assert.deepEqual(github.mergeabilityCalls, [{ slug: 'acme/demo', number: 42 }]);

    // Somebody pushed to the branch — quite possibly the manual resolution the
    // failure asked for. The failure is about a commit that is no longer the
    // head, so it is stale and a fresh run may start.
    github.says('acme/demo', 42, { mergeable: 'conflicted', headSha: 'ddd', baseSha: 'bbb' });
    assert.equal(await scan.tick(), 1);
    assert.deepEqual(
      starter.started.map((pull) => pull.headSha),
      ['ddd'],
    );
  });

  it('makes no GitHub call at all when no repository is connected', async () => {
    const { github, scan } = world({ repositories: false });

    assert.equal(await scan.tick(), 0);
    assert.deepEqual(github.listCalls, []);
  });

  it('asks for no mergeability when a repository has no open pull requests', async () => {
    const { github, scan } = world();

    assert.equal(await scan.tick(), 0);
    assert.deepEqual(github.listCalls, [['acme/demo']]);
    assert.deepEqual(github.mergeabilityCalls, []);
  });

  it('makes no GitHub call when no token is configured', async () => {
    const { github, scan } = world({ token: null });

    assert.equal(await scan.tick(), 0);
    assert.deepEqual(github.listCalls, []);
  });

  it('lets one repository’s listing error cost only that repository', async () => {
    const { github, scan, starter, repository } = world();
    repository('other', 'acme/other');
    github.broken('acme/demo', 'github_forbidden', 'Bad credentials.');
    github.open('acme/other', [{ number: 51, url: 'https://github.com/acme/other/pull/51' }]);
    github.says('acme/other', 51, { mergeable: 'conflicted' });

    assert.equal(await scan.tick(), 1);

    assert.deepEqual(github.mergeabilityCalls, [{ slug: 'acme/other', number: 51 }]);
    assert.deepEqual(
      starter.started.map((pull) => pull.slug),
      ['acme/other'],
    );
  });

  it('still scans what a truncated listing did return', async () => {
    const { github, scan, starter } = world();
    github.open('acme/demo', [{ number: 61 }], true);
    github.says('acme/demo', 61, { mergeable: 'conflicted' });

    assert.equal(await scan.tick(), 1);
    assert.equal(starter.started.length, 1);
  });

  it('ends the tick without marking anything when GitHub is unreachable', async () => {
    const { db, github, scan, starter, repositoryId } = world();
    github.open('acme/demo', [{ number: 71 }]);
    github.listFailure = new GithubApiError('github_unreachable', 'Could not reach GitHub.');

    assert.equal(await scan.tick(), 0);

    assert.deepEqual(github.mergeabilityCalls, []);
    assert.deepEqual(starter.started, []);
    assert.equal(findPrConflictFix(db, repositoryId, 71), null);
  });

  it('skips only the pull request GitHub failed on', async () => {
    const { github, scan, starter } = world();
    github.open('acme/demo', [{ number: 81 }, { number: 82 }]);
    github.failures.set(
      'acme/demo#81',
      new GithubApiError('github_not_found', 'That pull request does not exist.'),
    );
    github.says('acme/demo', 82, { mergeable: 'conflicted' });

    assert.equal(await scan.tick(), 1);
    assert.deepEqual(
      starter.started.map((pull) => pull.prNumber),
      [82],
    );
  });

  it('does not count a conflict the fix pipeline refused to take', async () => {
    const { github, scan, starter } = world();
    github.open('acme/demo', [{ number: 91 }]);
    github.says('acme/demo', 91, { mergeable: 'conflicted' });
    starter.failure = new Error('Every build slot is in use.');

    assert.equal(await scan.tick(), 0);
    assert.equal(starter.started.length, 1);
  });

  it('joins a tick that is already running rather than starting a second one', async () => {
    const { github, scan } = world();
    github.open('acme/demo', [{ number: 95 }]);
    github.says('acme/demo', 95, { mergeable: 'conflicted' });

    const [first, second] = await Promise.all([scan.tick(), scan.tick()]);

    assert.equal(first, 1);
    assert.equal(second, 1);
    assert.equal(github.listCalls.length, 1);
  });
});

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function advance(t: TestContext, ms: number): Promise<void> {
  t.mock.timers.tick(ms);
  await settle();
}

describe('the configurable scan interval and on/off switch (US-004)', () => {
  it('defaults to thirty minutes and prefers a saved setting', () => {
    const { db, scan } = world();

    assert.equal(scan.intervalMs(), 30 * 60_000);

    setSetting(db, 'pr_conflict_interval_minutes', '5');
    assert.equal(scan.intervalMs(), 5 * 60_000);

    // A row written by hand cannot scan faster than the floor the settings
    // route enforces, nor slower than a day.
    setSetting(db, 'pr_conflict_interval_minutes', '0');
    assert.equal(scan.intervalMs(), 30 * 60_000, 'a non-positive row falls back to the default');
    setSetting(db, 'pr_conflict_interval_minutes', '9999');
    assert.equal(scan.intervalMs(), 1440 * 60_000);
    setSetting(db, 'pr_conflict_interval_minutes', 'not a number');
    assert.equal(scan.intervalMs(), 30 * 60_000);
  });

  it('is enabled until a row says otherwise', () => {
    const { db, scan } = world();

    assert.equal(scan.enabled(), true);

    setSetting(db, 'conflict_fix_enabled', '0');
    assert.equal(scan.enabled(), false);

    setSetting(db, 'conflict_fix_enabled', '1');
    assert.equal(scan.enabled(), true);
  });

  it('does nothing at all, and calls no GitHub, while it is switched off', async () => {
    const { db, github, scan, starter } = world();
    github.open('acme/demo', [{ number: 12 }]);
    github.says('acme/demo', 12, { mergeable: 'conflicted' });
    setSetting(db, 'conflict_fix_enabled', '0');

    assert.equal(await scan.tick(), 0);

    assert.equal(github.listCalls.length, 0, 'no listing was fetched');
    assert.equal(github.mergeabilityCalls.length, 0, 'no mergeability was fetched');
    assert.equal(starter.started.length, 0);
  });

  it('picks the switch back up on the next tick, with no restart', async () => {
    const { db, github, scan, starter } = world();
    github.open('acme/demo', [{ number: 13 }]);
    github.says('acme/demo', 13, { mergeable: 'conflicted' });
    setSetting(db, 'conflict_fix_enabled', '0');
    assert.equal(await scan.tick(), 0);

    setSetting(db, 'conflict_fix_enabled', '1');

    assert.equal(await scan.tick(), 1);
    assert.deepEqual(
      starter.started.map((pull) => pull.prNumber),
      [13],
    );
  });

  it('scans at the configured interval and picks a change up without a restart', async (t) => {
    const { db, github, scan } = world();
    github.open('acme/demo', [{ number: 14 }]);
    setSetting(db, 'pr_conflict_interval_minutes', '1');
    t.mock.timers.enable({ apis: ['setTimeout'] });

    // The catch-up tick, then one a minute later: the saved interval, not the
    // thirty minutes the environment defaults to.
    scan.start();
    await settle();
    assert.equal(github.listCalls.length, 1);

    await advance(t, 60_000);
    assert.equal(github.listCalls.length, 2);

    // Saving five minutes mid-flight: the wait already armed runs out on the
    // old value, and every wait after it uses the new one.
    setSetting(db, 'pr_conflict_interval_minutes', '5');
    await advance(t, 60_000);
    assert.equal(github.listCalls.length, 3);

    await advance(t, 5 * 60_000 - 1);
    assert.equal(github.listCalls.length, 3, 'the next tick is five minutes out now');
    await advance(t, 1);
    assert.equal(github.listCalls.length, 4);

    // Switching the fixer off leaves the timer armed but the ticks empty…
    setSetting(db, 'conflict_fix_enabled', '0');
    await advance(t, 5 * 60_000);
    assert.equal(github.listCalls.length, 4, 'a disabled tick spends nothing on GitHub');

    // …and switching it back on needs no restart either.
    setSetting(db, 'conflict_fix_enabled', '1');
    await advance(t, 5 * 60_000);
    assert.equal(github.listCalls.length, 5);

    // And stopping leaves nothing armed.
    scan.stop();
    await advance(t, 60_000 * 10);
    assert.equal(github.listCalls.length, 5);
  });
});
