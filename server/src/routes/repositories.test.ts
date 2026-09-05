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
import { closeDatabase, createSession, type Database, IN_MEMORY, openDatabase } from '../db/index.js';
import { type CommandResult, generateEd25519KeyPair } from '../ssh/index.js';

const PASSWORD = 'correct horse battery staple';
const SSH_URL = 'git@github.com:owner/repo.git';

/** What the stubbed `docker run` answers with on the next connection test. */
let commandResult: CommandResult = { code: 0, stdout: '', stderr: '', timedOut: false };
let lastCommand: { args: readonly string[]; stdin: string } | null = null;

interface RepositoryBody {
  id: string;
  name: string;
  sshUrl: string;
  githubSlug: string;
  defaultBaseBranch: string;
  publicKey: string | null;
  keyFingerprint: string | null;
  keySource: string | null;
  keyConfigured: boolean;
  sentryOrg: string | null;
  sentryProject: string | null;
}

describe('repositories api', () => {
  let baseUrl: string;
  let cookie: string;
  let config: Config;
  let dataDir: string;
  let db: Database;
  let server: http.Server;

  const call = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const create = async (
    overrides: Record<string, unknown> = {},
  ): Promise<{ status: number; body: RepositoryBody; raw: string }> => {
    const response = await call('POST', '/api/repositories', {
      name: 'chief-web',
      sshUrl: SSH_URL,
      ...overrides,
    });
    const raw = await response.text();
    return { status: response.status, body: JSON.parse(raw) as RepositoryBody, raw };
  };

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-web-repos-'));
    config = loadConfig({ CHIEF_WEB_PASSWORD: PASSWORD, DATA_DIR: dataDir });
    db = openDatabase(IN_MEMORY);
    const app = createApp(config, createAuthService(config, db), db, {
      runCommand: (_command, args, stdin) => {
        lastCommand = { args, stdin };
        return Promise.resolve(commandResult);
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
    db.exec('DELETE FROM sessions; DELETE FROM repositories;');
    fs.rmSync(config.sshKeysDir, { recursive: true, force: true });
    commandResult = { code: 0, stdout: '', stderr: '', timedOut: false };
    lastCommand = null;
  });

  it('requires a session', async () => {
    const response = await fetch(`${baseUrl}/api/repositories`);
    assert.equal(response.status, 401);
  });

  it('generates an ed25519 deploy key on add', async () => {
    const { status, body } = await create();

    assert.equal(status, 201);
    assert.equal(body.keySource, 'generated');
    assert.equal(body.keyConfigured, true);
    assert.match(body.publicKey ?? '', /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5/);
    assert.match(body.keyFingerprint ?? '', /^SHA256:/);
  });

  it('stores the private key on the data volume with 0600 and never returns it', async () => {
    const { body, raw } = await create();

    const keyFile = path.join(config.sshKeysDir, `${body.id}.key`);
    const privateKey = fs.readFileSync(keyFile, 'utf8');
    assert.match(privateKey, /^-----BEGIN OPENSSH PRIVATE KEY-----/);
    assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(config.sshKeysDir).mode & 0o777, 0o700);

    // Neither the create response nor any later read exposes the key.
    assert.equal(raw.includes('PRIVATE KEY'), false);
    const list = await (await call('GET', '/api/repositories')).text();
    assert.equal(list.includes('PRIVATE KEY'), false);
    const one = await (await call('GET', `/api/repositories/${body.id}`)).text();
    assert.equal(one.includes('PRIVATE KEY'), false);
  });

  it('derives the GitHub slug from the SSH URL and accepts an override', async () => {
    const derived = await create();
    assert.equal(derived.body.githubSlug, 'owner/repo');

    const overridden = await create({ name: 'other', githubSlug: 'someone/else' });
    assert.equal(overridden.body.githubSlug, 'someone/else');
  });

  it('defaults the base branch to main', async () => {
    assert.equal((await create()).body.defaultBaseBranch, 'main');
    assert.equal((await create({ name: 'b', defaultBaseBranch: 'develop' })).body.defaultBaseBranch, 'develop');
  });

  it('rejects bad input', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ name: '' }, 'invalid_name'],
      [{ sshUrl: 'not a url' }, 'invalid_ssh_url'],
      [{ githubSlug: 'nope' }, 'invalid_github_slug'],
      [{ defaultBaseBranch: 'bad branch' }, 'invalid_base_branch'],
      [{ privateKey: 'garbage' }, 'invalid_private_key'],
      [{ sentryOrg: 'Not A Slug', sentryProject: 'web' }, 'invalid_sentry_org'],
      [{ sentryOrg: 'acme', sentryProject: 'Web_App' }, 'invalid_sentry_project'],
      [{ sentryOrg: 'acme' }, 'sentry_link_incomplete'],
      [{ sentryProject: 'web' }, 'sentry_link_incomplete'],
    ];

    for (const [overrides, code] of cases) {
      const response = await call('POST', '/api/repositories', {
        name: 'chief-web',
        sshUrl: SSH_URL,
        ...overrides,
      });
      const body = (await response.json()) as { error: string; message: string };
      assert.equal(response.status, 400, code);
      assert.equal(body.error, code);
      assert.ok(body.message.length > 0);
    }
  });

  it('leaves a repository unlinked from Sentry by default', async () => {
    const { body } = await create();

    assert.equal(body.sentryOrg, null);
    assert.equal(body.sentryProject, null);
  });

  it('links a Sentry project on add', async () => {
    const { status, body } = await create({ sentryOrg: 'acme', sentryProject: 'acme-web-2' });

    assert.equal(status, 201);
    assert.equal(body.sentryOrg, 'acme');
    assert.equal(body.sentryProject, 'acme-web-2');

    const listed = (await (await call('GET', '/api/repositories')).json()) as {
      repositories: RepositoryBody[];
    };
    assert.equal(listed.repositories[0]?.sentryOrg, 'acme');
    assert.equal(listed.repositories[0]?.sentryProject, 'acme-web-2');
  });

  it('links, relinks and unlinks a Sentry project from the edit form', async () => {
    const { body: created } = await create();

    const linked = (await (
      await call('PUT', `/api/repositories/${created.id}`, {
        sentryOrg: 'acme',
        sentryProject: 'web',
      })
    ).json()) as RepositoryBody;
    assert.equal(linked.sentryOrg, 'acme');
    assert.equal(linked.sentryProject, 'web');

    const moved = (await (
      await call('PUT', `/api/repositories/${created.id}`, { sentryProject: 'api' })
    ).json()) as RepositoryBody;
    assert.equal(moved.sentryOrg, 'acme');
    assert.equal(moved.sentryProject, 'api');

    // The form sends the emptied fields, which is what unlinks.
    const unlinked = (await (
      await call('PUT', `/api/repositories/${created.id}`, { sentryOrg: '', sentryProject: '' })
    ).json()) as RepositoryBody;
    assert.equal(unlinked.sentryOrg, null);
    assert.equal(unlinked.sentryProject, null);
  });

  it('refuses to leave half a Sentry link behind on edit', async () => {
    const { body: created } = await create({ sentryOrg: 'acme', sentryProject: 'web' });

    const response = await call('PUT', `/api/repositories/${created.id}`, { sentryProject: '' });
    const error = (await response.json()) as { error: string; message: string };

    assert.equal(response.status, 400);
    assert.equal(error.error, 'sentry_link_incomplete');
    assert.match(error.message, /org slug and a project slug/);

    // The stored link is untouched by the rejected edit.
    const current = (await (await call('GET', `/api/repositories/${created.id}`)).json()) as RepositoryBody;
    assert.equal(current.sentryProject, 'web');
  });

  it('keeps the Sentry link when an edit does not mention it', async () => {
    const { body: created } = await create({ sentryOrg: 'acme', sentryProject: 'web' });

    const updated = (await (
      await call('PUT', `/api/repositories/${created.id}`, { name: 'renamed' })
    ).json()) as RepositoryBody;

    assert.equal(updated.sentryOrg, 'acme');
    assert.equal(updated.sentryProject, 'web');
  });

  it('asks for the slug when it cannot be derived', async () => {
    const response = await call('POST', '/api/repositories', {
      name: 'deep',
      sshUrl: 'git@gitlab.com:group/sub/repo.git',
    });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: string }).error, 'github_slug_required');
  });

  it('refuses a duplicate name', async () => {
    await create();
    const response = await call('POST', '/api/repositories', { name: 'chief-web', sshUrl: SSH_URL });
    assert.equal(response.status, 409);
    assert.equal(((await response.json()) as { error: string }).error, 'repository_name_taken');
  });

  it('imports a pasted private key instead of generating one', async () => {
    const pair = generateEd25519KeyPair('laptop');

    const { status, body } = await create({ privateKey: pair.privateKey });

    assert.equal(status, 201);
    assert.equal(body.keySource, 'imported');
    assert.equal(body.keyFingerprint, pair.fingerprint);
    assert.equal(
      fs.readFileSync(path.join(config.sshKeysDir, `${body.id}.key`), 'utf8'),
      pair.privateKey,
    );
  });

  it('lists repositories by name', async () => {
    await create({ name: 'zulu' });
    await create({ name: 'alpha' });

    const body = (await (await call('GET', '/api/repositories')).json()) as {
      repositories: RepositoryBody[];
    };
    assert.deepEqual(
      body.repositories.map((repository) => repository.name),
      ['alpha', 'zulu'],
    );
  });

  it('edits a repository without touching its key', async () => {
    const { body: created } = await create();

    const response = await call('PUT', `/api/repositories/${created.id}`, {
      name: 'renamed',
      sshUrl: 'git@github.com:other/thing.git',
      githubSlug: 'other/thing',
      defaultBaseBranch: 'develop',
    });
    const updated = (await response.json()) as RepositoryBody;

    assert.equal(response.status, 200);
    assert.equal(updated.name, 'renamed');
    assert.equal(updated.sshUrl, 'git@github.com:other/thing.git');
    assert.equal(updated.defaultBaseBranch, 'develop');
    assert.equal(updated.keyFingerprint, created.keyFingerprint);
  });

  it('replaces the key when a new one is pasted into the edit form', async () => {
    const { body: created } = await create();
    const replacement = generateEd25519KeyPair('replacement');

    const response = await call('PUT', `/api/repositories/${created.id}`, {
      privateKey: replacement.privateKey,
    });
    const updated = (await response.json()) as RepositoryBody;

    assert.equal(updated.keySource, 'imported');
    assert.equal(updated.keyFingerprint, replacement.fingerprint);
    assert.notEqual(updated.keyFingerprint, created.keyFingerprint);
  });

  it('404s for an unknown repository', async () => {
    assert.equal((await call('GET', '/api/repositories/missing')).status, 404);
    assert.equal((await call('PUT', '/api/repositories/missing', { name: 'x' })).status, 404);
    assert.equal((await call('DELETE', '/api/repositories/missing')).status, 404);
  });

  it('blocks deletion while sessions reference the repository', async () => {
    const { body } = await create();
    createSession(db, {
      repositoryId: body.id,
      name: 'demo',
      baseBranch: 'main',
      prTargetBranch: 'main',
    });

    const response = await call('DELETE', `/api/repositories/${body.id}`);
    const error = (await response.json()) as { error: string; message: string };

    assert.equal(response.status, 409);
    assert.equal(error.error, 'repository_in_use');
    assert.match(error.message, /1 session/);
    assert.equal(fs.existsSync(path.join(config.sshKeysDir, `${body.id}.key`)), true);
  });

  it('deletes the repository and its key once no session references it', async () => {
    const { body } = await create();

    const response = await call('DELETE', `/api/repositories/${body.id}`);

    assert.equal(response.status, 204);
    assert.equal(fs.existsSync(path.join(config.sshKeysDir, `${body.id}.key`)), false);
    assert.equal((await call('GET', `/api/repositories/${body.id}`)).status, 404);
  });

  it('reports a successful connection test', async () => {
    const { body } = await create();

    const response = await call('POST', `/api/repositories/${body.id}/test-connection`);
    const result = (await response.json()) as { ok: boolean; message: string; stderr: string };

    assert.equal(response.status, 200);
    assert.equal(result.ok, true);
    assert.match(lastCommand?.stdin ?? '', /BEGIN OPENSSH PRIVATE KEY/);
    assert.ok(lastCommand?.args.includes(`CHIEF_REPO_URL=${SSH_URL}`));
  });

  it('reports git stderr when the remote rejects the key', async () => {
    const { body } = await create();
    commandResult = {
      code: 128,
      stdout: '',
      stderr: 'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.',
      timedOut: false,
    };

    const response = await call('POST', `/api/repositories/${body.id}/test-connection`);
    const result = (await response.json()) as { ok: boolean; stderr: string };

    assert.equal(response.status, 200);
    assert.equal(result.ok, false);
    assert.match(result.stderr, /Permission denied \(publickey\)/);
  });

  it('explains a missing key rather than running the test', async () => {
    const { body } = await create();
    fs.rmSync(path.join(config.sshKeysDir, `${body.id}.key`));

    const response = await call('POST', `/api/repositories/${body.id}/test-connection`);

    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: string }).error, 'repository_key_missing');
    assert.equal(lastCommand, null);
  });
});
