import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createApp } from '../app.js';
import { createAuthService } from '../auth/index.js';
import { loadConfig } from '../config.js';
import {
  closeDatabase,
  type Database,
  deleteSetting,
  IN_MEMORY,
  openDatabase,
  setSetting,
} from '../db/index.js';
import { getMaxConcurrentSessions, getPrSyncIntervalMs } from '../settings/index.js';

const PASSWORD = 'correct horse battery staple';
const TOKEN = 'ghp_exampleTokenValue1234';

/** What the stub GitHub API answers with on the next `GET /user`. */
let githubReply: { status: number; body: unknown } = { status: 200, body: { login: 'octocat' } };
let githubAuthHeader: string | undefined;

describe('settings api', () => {
  let baseUrl: string;
  let cookie: string;
  let db: Database;
  let server: http.Server;
  let github: http.Server;

  before(async () => {
    github = http.createServer((req, res) => {
      githubAuthHeader = req.headers.authorization;
      res.writeHead(githubReply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(githubReply.body));
    });
    github.listen(0, '127.0.0.1');
    await new Promise((resolve) => github.once('listening', resolve));
    const githubPort = (github.address() as AddressInfo).port;

    const config = loadConfig({
      CHIEF_WEB_PASSWORD: PASSWORD,
      GITHUB_API_URL: `http://127.0.0.1:${githubPort}`,
    });
    db = openDatabase(IN_MEMORY);
    const app = createApp(config, createAuthService(config, db), db);
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
    await new Promise((resolve) => github.close(resolve));
    closeDatabase(db);
  });

  beforeEach(() => {
    deleteSetting(db, 'github_token');
    deleteSetting(db, 'max_concurrent_sessions');
    deleteSetting(db, 'pr_sync_interval_minutes');
    deleteSetting(db, 'git_author_name');
    deleteSetting(db, 'git_author_email');
    deleteSetting(db, 'review_model');
    deleteSetting(db, 'code_review_default');
    githubReply = { status: 200, body: { login: 'octocat' } };
    githubAuthHeader = undefined;
  });

  const get = async (): Promise<Response> =>
    fetch(`${baseUrl}/api/settings`, { headers: { cookie } });

  const put = async (body: unknown): Promise<Response> =>
    fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const validate = async (body: unknown = {}): Promise<Response> =>
    fetch(`${baseUrl}/api/settings/github/validate`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('reports the default commit identity when none is stored', async () => {
    const response = await get();
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(body['gitAuthorName'], 'chief-web');
    assert.equal(body['gitAuthorEmail'], 'chief-web@localhost');
  });

  it('saves a custom commit identity and restores the default with null', async () => {
    const saved = (await (
      await put({ gitAuthorName: '  Release Bot  ', gitAuthorEmail: 'bot@example.com' })
    ).json()) as Record<string, unknown>;
    assert.equal(saved['gitAuthorName'], 'Release Bot');
    assert.equal(saved['gitAuthorEmail'], 'bot@example.com');

    // A PUT without the fields leaves them alone …
    const untouched = (await (await put({ maxConcurrentSessions: 5 })).json()) as Record<
      string,
      unknown
    >;
    assert.equal(untouched['gitAuthorName'], 'Release Bot');

    // … and an explicit null puts the built-in defaults back.
    const cleared = (await (
      await put({ gitAuthorName: null, gitAuthorEmail: null })
    ).json()) as Record<string, unknown>;
    assert.equal(cleared['gitAuthorName'], 'chief-web');
    assert.equal(cleared['gitAuthorEmail'], 'chief-web@localhost');
  });

  it('rejects a commit identity git would refuse', async () => {
    const badName = await put({ gitAuthorName: 'Bot <bot@example.com>' });
    assert.equal(badName.status, 400);
    assert.equal(((await badName.json()) as Record<string, unknown>)['error'], 'invalid_git_author_name');

    const emptyName = await put({ gitAuthorName: '   ' });
    assert.equal(emptyName.status, 400);

    const badEmail = await put({ gitAuthorEmail: 'not-an-address' });
    assert.equal(badEmail.status, 400);
    assert.equal(
      ((await badEmail.json()) as Record<string, unknown>)['error'],
      'invalid_git_author_email',
    );

    // Nothing was stored by the rejected requests.
    const current = (await (await get()).json()) as Record<string, unknown>;
    assert.equal(current['gitAuthorName'], 'chief-web');
  });

  it('requires authentication', async () => {
    const response = await fetch(`${baseUrl}/api/settings`);

    assert.equal(response.status, 401);
  });

  it('reports no token and the default concurrency on a fresh install', async () => {
    const response = await get();

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      githubToken: { configured: false, last4: null },
      maxConcurrentSessions: 3,
      agentTimeoutMinutes: 30,
      prSyncIntervalMinutes: 15,
      planningModel: null,
      buildModel: null,
      reviewModel: null,
      codeReviewDefault: false,
      gitAuthorName: 'chief-web',
      gitAuthorEmail: 'chief-web@localhost',
    });
  });

  it('stores the token and returns only its last four characters', async () => {
    const saved = await put({ githubToken: TOKEN });

    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), {
      githubToken: { configured: true, last4: '1234' },
      maxConcurrentSessions: 3,
      agentTimeoutMinutes: 30,
      prSyncIntervalMinutes: 15,
      planningModel: null,
      buildModel: null,
      reviewModel: null,
      codeReviewDefault: false,
      gitAuthorName: 'chief-web',
      gitAuthorEmail: 'chief-web@localhost',
    });
  });

  it('never returns the token in full from any response', async () => {
    await put({ githubToken: TOKEN, maxConcurrentSessions: 5 });

    for (const response of [await get(), await put({ maxConcurrentSessions: 6 }), await validate()]) {
      const raw = await response.text();
      assert.ok(!raw.includes(TOKEN), `token leaked in: ${raw}`);
    }
  });

  it('trims the saved token', async () => {
    await put({ githubToken: `  ${TOKEN}  ` });
    await validate();

    assert.equal(githubAuthHeader, `Bearer ${TOKEN}`);
  });

  it('leaves the stored token alone when the field is omitted', async () => {
    await put({ githubToken: TOKEN });

    const response = await put({ maxConcurrentSessions: 7 });

    assert.deepEqual(await response.json(), {
      githubToken: { configured: true, last4: '1234' },
      maxConcurrentSessions: 7,
      agentTimeoutMinutes: 30,
      prSyncIntervalMinutes: 15,
      planningModel: null,
      buildModel: null,
      reviewModel: null,
      codeReviewDefault: false,
      gitAuthorName: 'chief-web',
      gitAuthorEmail: 'chief-web@localhost',
    });
  });

  it('removes the stored token when null is sent', async () => {
    await put({ githubToken: TOKEN });

    const response = await put({ githubToken: null });

    assert.deepEqual((await response.json()) as { githubToken: unknown }, {
      githubToken: { configured: false, last4: null },
      maxConcurrentSessions: 3,
      agentTimeoutMinutes: 30,
      prSyncIntervalMinutes: 15,
      planningModel: null,
      buildModel: null,
      reviewModel: null,
      codeReviewDefault: false,
      gitAuthorName: 'chief-web',
      gitAuthorEmail: 'chief-web@localhost',
    });
  });

  it('rejects an empty token rather than silently clearing it', async () => {
    await put({ githubToken: TOKEN });

    const response = await put({ githubToken: '   ' });

    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: string }).error, 'invalid_github_token');
    assert.equal(
      ((await (await get()).json()) as { githubToken: { configured: boolean } }).githubToken
        .configured,
      true,
    );
  });

  it('persists max concurrent sessions and rejects out-of-range values', async () => {
    assert.equal((await put({ maxConcurrentSessions: 8 })).status, 200);
    assert.equal(
      ((await (await get()).json()) as { maxConcurrentSessions: number }).maxConcurrentSessions,
      8,
    );

    for (const value of [0, -1, 51, 2.5, '4', null]) {
      const response = await put({ maxConcurrentSessions: value });
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(value)}`);
      assert.equal(
        ((await response.json()) as { error: string }).error,
        'invalid_max_concurrent_sessions',
      );
    }
  });

  it('persists the planning and build models and rejects unknown ones', async () => {
    assert.equal((await put({ planningModel: 'opus', buildModel: 'sonnet' })).status, 200);
    const saved = (await (await get()).json()) as {
      planningModel: string | null;
      buildModel: string | null;
    };
    assert.equal(saved.planningModel, 'opus');
    assert.equal(saved.buildModel, 'sonnet');

    // `--model` accepts anything and only warns on a name it does not know, so
    // an unchecked value would run a whole build on the wrong model rather
    // than failing here.
    for (const value of ['claude-opus-5', 'Opus', 'gpt-5', '', 3, true]) {
      const response = await put({ buildModel: value });
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(value)}`);
      assert.equal(((await response.json()) as { error: string }).error, 'invalid_build_model');
    }

    // The models survive an unrelated update, and null hands the choice back.
    await put({ maxConcurrentSessions: 2 });
    assert.equal(
      ((await (await get()).json()) as { planningModel: string | null }).planningModel,
      'opus',
    );

    assert.equal((await put({ planningModel: null })).status, 200);
    const cleared = (await (await get()).json()) as {
      planningModel: string | null;
      buildModel: string | null;
    };
    assert.equal(cleared.planningModel, null);
    // Clearing one must not disturb the other.
    assert.equal(cleared.buildModel, 'sonnet');
  });

  it('persists the review model and rejects unknown ones (US-001)', async () => {
    assert.equal((await put({ reviewModel: 'haiku' })).status, 200);
    assert.equal(
      ((await (await get()).json()) as { reviewModel: string | null }).reviewModel,
      'haiku',
    );

    for (const value of ['claude-opus-5', 'Haiku', 'gpt-5', '', 3, true]) {
      const response = await put({ reviewModel: value });
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(value)}`);
      assert.equal(((await response.json()) as { error: string }).error, 'invalid_review_model');
    }

    // Setting the build model leaves the review model alone, and null hands
    // the choice back to the CLI without disturbing the other two.
    await put({ planningModel: 'opus', buildModel: 'sonnet' });
    assert.equal(
      ((await (await get()).json()) as { reviewModel: string | null }).reviewModel,
      'haiku',
    );

    assert.equal((await put({ reviewModel: null })).status, 200);
    const cleared = (await (await get()).json()) as {
      planningModel: string | null;
      buildModel: string | null;
      reviewModel: string | null;
    };
    assert.equal(cleared.reviewModel, null);
    assert.equal(cleared.planningModel, 'opus');
    assert.equal(cleared.buildModel, 'sonnet');
  });

  it('persists the agent timeout and rejects out-of-range values (US-019)', async () => {
    assert.equal((await put({ agentTimeoutMinutes: 45 })).status, 200);
    assert.equal(
      ((await (await get()).json()) as { agentTimeoutMinutes: number }).agentTimeoutMinutes,
      45,
    );

    for (const value of [0, -5, 721, 1.5, '30', null]) {
      const response = await put({ agentTimeoutMinutes: value });
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(value)}`);
      assert.equal(
        ((await response.json()) as { error: string }).error,
        'invalid_agent_timeout_minutes',
      );
    }

    // The saved value survives an unrelated update.
    await put({ maxConcurrentSessions: 2 });
    assert.equal(
      ((await (await get()).json()) as { agentTimeoutMinutes: number }).agentTimeoutMinutes,
      45,
    );
  });

  it('persists the pull request sync interval and rejects out-of-range values (US-004)', async () => {
    // The default is the 15 minutes the sync has always polled at.
    assert.equal(
      ((await (await get()).json()) as { prSyncIntervalMinutes: number }).prSyncIntervalMinutes,
      15,
    );

    assert.equal((await put({ prSyncIntervalMinutes: 5 })).status, 200);
    assert.equal(
      ((await (await get()).json()) as { prSyncIntervalMinutes: number }).prSyncIntervalMinutes,
      5,
    );
    assert.equal(getPrSyncIntervalMs(db, loadConfig({})), 5 * 60_000);

    // Anything under a minute is refused, with something the operator can act on.
    const tooShort = await put({ prSyncIntervalMinutes: 0 });
    assert.equal(tooShort.status, 400);
    const body = (await tooShort.json()) as { error: string; message: string };
    assert.equal(body.error, 'invalid_pr_sync_interval_minutes');
    assert.match(body.message, /whole number of minutes between 1 and 1440/);

    for (const value of [-5, 1441, 1.5, '5', null]) {
      const response = await put({ prSyncIntervalMinutes: value });
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(value)}`);
      assert.equal(
        ((await response.json()) as { error: string }).error,
        'invalid_pr_sync_interval_minutes',
      );
    }

    // Nothing the rejected requests carried was stored, and an unrelated
    // update leaves the saved interval alone.
    await put({ maxConcurrentSessions: 2 });
    assert.equal(
      ((await (await get()).json()) as { prSyncIntervalMinutes: number }).prSyncIntervalMinutes,
      5,
    );
  });

  it('validates the stored token and returns the login', async () => {
    await put({ githubToken: TOKEN });

    const response = await validate();

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { login: 'octocat' });
    assert.equal(githubAuthHeader, `Bearer ${TOKEN}`);
  });

  it('validates a token supplied in the body before it is saved', async () => {
    const response = await validate({ token: 'ghp_unsavedToken' });

    assert.equal(response.status, 200);
    assert.equal(githubAuthHeader, 'Bearer ghp_unsavedToken');
    assert.equal(
      ((await (await get()).json()) as { githubToken: { configured: boolean } }).githubToken
        .configured,
      false,
    );
  });

  it('explains that there is nothing to validate when no token is set', async () => {
    const response = await validate();

    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: string }).error, 'github_token_missing');
  });

  it('surfaces a rejected token as 400, not 401', async () => {
    githubReply = { status: 401, body: { message: 'Bad credentials' } };

    const response = await validate({ token: 'ghp_bad' });

    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string; message: string };
    assert.equal(body.error, 'github_unauthorized');
    assert.match(body.message, /Bad credentials/);
  });

  it('surfaces a forbidden token with GitHub’s explanation', async () => {
    githubReply = { status: 403, body: { message: 'Resource not accessible' } };

    const response = await validate({ token: 'ghp_scopeless' });

    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string; message: string };
    assert.equal(body.error, 'github_forbidden');
    assert.match(body.message, /Resource not accessible/);
  });

  it('reports an unexpected GitHub status', async () => {
    githubReply = { status: 500, body: { message: 'boom' } };

    const response = await validate({ token: 'ghp_whatever' });

    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: string }).error, 'github_error');
  });

  it('resolves the concurrency cap the build queue enforces (US-018)', async () => {
    const config = loadConfig({ MAX_CONCURRENT_SESSIONS: '4' });

    // The environment is only the default; the saved row wins.
    assert.equal(getMaxConcurrentSessions(db, config), 4);
    await put({ maxConcurrentSessions: 2 });
    assert.equal(getMaxConcurrentSessions(db, config), 2);

    // A value written straight into the database cannot wedge the queue with a
    // cap no build could ever fit under.
    setSetting(db, 'max_concurrent_sessions', '0');
    assert.equal(getMaxConcurrentSessions(db, config), 1);
    setSetting(db, 'max_concurrent_sessions', '9999');
    assert.equal(getMaxConcurrentSessions(db, config), 50);
  });
});
