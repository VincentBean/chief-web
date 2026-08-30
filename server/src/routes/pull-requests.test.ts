import assert from 'node:assert/strict';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createApp } from '../app.js';
import { createAuthService } from '../auth/index.js';
import { type Config, loadConfig } from '../config.js';
import {
  closeDatabase,
  createRepository,
  type Database,
  deleteSetting,
  IN_MEMORY,
  openDatabase,
  setSetting,
} from '../db/index.js';
import { GithubApiError } from '../lib/github.js';
import type { PullRequestFeedback, RepositoryPullRequests } from '../lib/github-review.js';
import { createPullRequestService, type PullRequestGateway } from '../pullrequests/index.js';

const PASSWORD = 'correct horse battery staple';

/** A gateway whose answers each test scripts; nothing reaches the network. */
class StubGateway implements PullRequestGateway {
  listResult: RepositoryPullRequests[] = [];
  listError: unknown = null;
  feedbackResult: PullRequestFeedback | null = null;
  feedbackError: unknown = null;
  listCalls = 0;

  list(_token: string, _slugs: readonly string[]): Promise<RepositoryPullRequests[]> {
    this.listCalls += 1;
    if (this.listError !== null) return Promise.reject(this.listError);
    return Promise.resolve(this.listResult);
  }

  feedback(_token: string, _slug: string, _number: number): Promise<PullRequestFeedback> {
    if (this.feedbackError !== null) return Promise.reject(this.feedbackError);
    if (this.feedbackResult === null) return Promise.reject(new Error('no feedback scripted'));
    return Promise.resolve(this.feedbackResult);
  }
}

const pull = (number: number, slug: string) => ({
  number,
  title: `PR ${String(number)}`,
  url: `https://github.com/${slug}/pull/${String(number)}`,
  headRef: 'feature/x',
  headSha: 'abc',
  headSlug: slug,
  baseRef: 'develop',
  fromFork: false,
  draft: false,
  authorLogin: 'vincentbean',
  updatedAt: '2026-08-29T10:00:00Z',
});

describe('pull requests api', () => {
  let baseUrl: string;
  let cookie: string;
  let config: Config;
  let db: Database;
  let server: http.Server;
  let gateway: StubGateway;
  let repositoryId: string;

  before(async () => {
    config = loadConfig({ CHIEF_WEB_PASSWORD: PASSWORD });
    db = openDatabase(IN_MEMORY);
    gateway = new StubGateway();

    const repository = createRepository(db, {
      name: 'leo',
      sshUrl: 'git@github.com:VincentBean/leo.git',
      githubSlug: 'VincentBean/leo',
      defaultBaseBranch: 'develop',
    });
    repositoryId = repository.id;

    const app = createApp(config, createAuthService(config, db), db, {
      pullRequests: createPullRequestService(config, db, gateway),
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
    closeDatabase(db);
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    gateway.listResult = [];
    gateway.listError = null;
    gateway.feedbackError = null;
    gateway.listCalls = 0;
    setSetting(db, 'github_token', 'ghp_token');
  });

  const get = (path: string): Promise<Response> =>
    fetch(`${baseUrl}${path}`, { headers: { cookie } });

  it('requires the session cookie', async () => {
    const response = await fetch(`${baseUrl}/api/pull-requests`);
    assert.equal(response.status, 401);
  });

  it('groups pull requests by repository', async () => {
    gateway.listResult = [
      {
        slug: 'VincentBean/leo',
        pullRequests: [pull(61, 'VincentBean/leo'), pull(60, 'VincentBean/leo')],
        error: null,
        message: null,
        truncated: false,
      },
    ];

    const body = (await (await get('/api/pull-requests?refresh=1')).json()) as {
      repositories: { repositoryName: string; pullRequests: { number: number }[] }[];
    };

    assert.equal(body.repositories.length, 1);
    assert.equal(body.repositories[0]?.repositoryName, 'leo');
    assert.deepEqual(
      body.repositories[0]?.pullRequests.map((entry) => entry.number),
      [61, 60],
    );
  });

  it('reports one repository’s failure inside a 200, not as a page failure', async () => {
    // The page is a list: half a list plus a named reason beats a single 502.
    gateway.listResult = [
      {
        slug: 'VincentBean/leo',
        pullRequests: [],
        error: 'github_forbidden',
        message: 'GitHub refused the request.',
        truncated: false,
      },
    ];

    const response = await get('/api/pull-requests?refresh=1');
    const body = (await response.json()) as {
      repositories: { error: string | null; message: string | null }[];
    };

    assert.equal(response.status, 200);
    assert.equal(body.repositories[0]?.error, 'github_forbidden');
    assert.match(body.repositories[0]?.message ?? '', /refused/);
  });

  it('serves a cached answer until refresh is asked for', async () => {
    gateway.listResult = [
      { slug: 'VincentBean/leo', pullRequests: [], error: null, message: null, truncated: false },
    ];

    await get('/api/pull-requests?refresh=1');
    await get('/api/pull-requests');
    await get('/api/pull-requests');
    assert.equal(gateway.listCalls, 1, 'the cache should have answered');

    await get('/api/pull-requests?refresh=1');
    assert.equal(gateway.listCalls, 2);
  });

  it('says so when no token is configured, and never answers 401', async () => {
    deleteSetting(db, 'github_token');

    const response = await get('/api/pull-requests?refresh=1');

    // 401 is reserved for our own expired cookie; the SPA redirects on it.
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: string }).error, 'github_token_missing');
  });

  it('maps an unreachable GitHub to 502 and everything else to 400', async () => {
    gateway.listError = new GithubApiError('github_unreachable', 'Could not reach GitHub.');
    assert.equal((await get('/api/pull-requests?refresh=1')).status, 502);

    gateway.listError = new GithubApiError('github_forbidden', 'Nope.', 403);
    assert.equal((await get('/api/pull-requests?refresh=1')).status, 400);
  });

  it('rejects a pull request number that is not one', async () => {
    const response = await get(`/api/pull-requests/${repositoryId}/nonsense/feedback`);

    assert.equal(response.status, 400);
    assert.equal(
      ((await response.json()) as { error: string }).error,
      'invalid_pull_request_number',
    );
  });

  it('404s feedback for a repository that is not registered', async () => {
    const response = await get('/api/pull-requests/no-such-repo/61/feedback');

    assert.equal(response.status, 404);
    assert.equal(((await response.json()) as { error: string }).error, 'repository_not_found');
  });

  it('is not behind the Claude guard — listing runs no agent', async () => {
    gateway.listResult = [];
    const response = await get('/api/pull-requests?refresh=1');

    assert.notEqual(response.status, 409);
    assert.equal(response.status, 200);
  });
});
