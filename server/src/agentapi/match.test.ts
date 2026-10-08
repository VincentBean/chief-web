import assert from 'node:assert/strict';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createApp } from '../app.js';
import { createAuthService } from '../auth/index.js';
import { loadConfig } from '../config.js';
import { closeDatabase, createRepository, type Database, IN_MEMORY, openDatabase, runMigrations } from '../db/index.js';
import { generateToken } from './index.js';

describe('GET /api/agent/repositories/match', () => {
  let baseUrl: string;
  let db: Database;
  let server: http.Server;
  let token: string;

  beforeEach(async () => {
    const config = loadConfig({ CHIEF_WEB_PASSWORD: 'correct horse battery staple' });
    db = openDatabase(IN_MEMORY);
    runMigrations(db);
    const app = createApp(config, createAuthService(config, db), db);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    token = generateToken(db);
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase(db);
  });

  const match = (remote?: string): Promise<Response> => {
    const query = remote === undefined ? '' : `?remote=${encodeURIComponent(remote)}`;
    return fetch(`${baseUrl}/api/agent/repositories/match${query}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  };

  const demo = (): ReturnType<typeof createRepository> =>
    createRepository(db, {
      name: 'demo',
      sshUrl: 'git@github.com:Acme/Demo.git',
      githubSlug: 'acme/demo',
      defaultBaseBranch: 'trunk',
      publicKey: 'ssh-ed25519 AAAA demo',
      sentryOrg: 'acme',
      sentryProject: 'web',
      reviewContext: 'be nice',
      openPullRequestDefault: false,
    });

  it('answers the one matching repository for every remote form, without keys or Sentry fields', async () => {
    const repository = demo();
    createRepository(db, { name: 'other', sshUrl: 'git@github.com:acme/other.git', githubSlug: 'acme/other' });
    for (const remote of [
      'git@github.com:Acme/Demo.git',
      'ssh://git@github.com/acme/demo.git',
      'ssh://git@github.com:22/ACME/DEMO',
      'https://github.com/Acme/Demo.git',
      'https://user:pass@github.com/Acme/Demo/',
    ]) {
      const res = await match(remote);
      assert.equal(res.status, 200, remote);
      assert.deepEqual(await res.json(), {
        repository: {
          id: repository.id,
          name: 'demo',
          githubSlug: 'acme/demo',
          defaultBaseBranch: 'trunk',
          openPullRequestDefault: false,
        },
      });
    }
  });

  it('matches a github.com remote on githubSlug when the sshUrl differs', async () => {
    const repository = createRepository(db, {
      name: 'mirror',
      sshUrl: 'git@git.internal:mirrors/demo.git',
      githubSlug: 'Acme/Demo',
    });
    const res = await match('https://github.com/acme/demo');
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { repository: { id: string } }).repository.id, repository.id);
  });

  it('does not match a slug for a remote on another host', async () => {
    createRepository(db, { name: 'mirror', sshUrl: 'git@git.internal:mirrors/demo.git', githubSlug: 'acme/demo' });
    const res = await match('git@gitlab.com:acme/demo.git');
    assert.equal(res.status, 404);
  });

  it('answers 404 when nothing matches', async () => {
    demo();
    const remote = 'git@github.com:acme/unknown.git';
    const res = await match(remote);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), {
      error: 'repository_not_found',
      message: `No chief-web repository matches ${remote}. Add it in chief-web first.`,
    });
  });

  it('answers 400 for a missing or unparsable remote', async () => {
    demo();
    for (const remote of [undefined, '', 'not a remote', 'file:///srv/acme/demo.git']) {
      const res = await match(remote);
      assert.equal(res.status, 400, String(remote));
      assert.equal(((await res.json()) as { error: string }).error, 'invalid_remote');
    }
  });

  it('answers 409 with every candidate when more than one repository matches', async () => {
    const first = demo();
    const second = createRepository(db, {
      name: 'demo-mirror',
      sshUrl: 'git@git.internal:mirrors/demo.git',
      githubSlug: 'acme/demo',
    });
    const res = await match('git@github.com:acme/demo.git');
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string; repositories: { id: string; name: string }[] };
    assert.equal(body.error, 'ambiguous_repository');
    assert.deepEqual(
      [...body.repositories].sort((a, b) => a.name.localeCompare(b.name)),
      [
        { id: first.id, name: 'demo' },
        { id: second.id, name: 'demo-mirror' },
      ],
    );
  });

  it('requires the bearer token', async () => {
    const res = await fetch(`${baseUrl}/api/agent/repositories/match?remote=git@github.com:acme/demo.git`);
    assert.equal(res.status, 401);
  });
});
