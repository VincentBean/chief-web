import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../config.js';
import { IN_MEMORY, openDatabase, setSetting } from '../db/index.js';
import { HostPaths } from '../orchestrator/index.js';
import {
  DEFAULT_GIT_AUTHOR_EMAIL,
  DEFAULT_GIT_AUTHOR_NAME,
  getGitIdentity,
  isValidGitAuthorEmail,
  isValidGitAuthorName,
} from '../settings/index.js';
import {
  claudeAccountBind,
  claudeAccountDir,
  RUNNER_CLAUDE_DIR,
  RUNNER_SSH_KEY_PATH,
  RUNNER_WORKSPACE_DIR,
  runnerEnvArgs,
  runnerEnvironment,
  runnerMountArgs,
} from './index.js';

describe('runner image contract', () => {
  it('matches the paths baked into runner/Dockerfile', () => {
    assert.equal(RUNNER_CLAUDE_DIR, '/home/node/.claude');
    assert.equal(RUNNER_WORKSPACE_DIR, '/workspace');
    assert.equal(RUNNER_SSH_KEY_PATH, '/keys/id_ed25519');
  });

  it('passes the commit identity in as environment variables', () => {
    const env = runnerEnvironment({ name: 'someone', email: 'someone@example.com' });
    assert.deepEqual(env, {
      CHIEF_GIT_AUTHOR_NAME: 'someone',
      CHIEF_GIT_AUTHOR_EMAIL: 'someone@example.com',
      CHIEF_SSH_KEY_PATH: RUNNER_SSH_KEY_PATH,
    });
    assert.deepEqual(runnerEnvArgs({ name: 'a', email: 'b@c' }).slice(0, 2), [
      '--env',
      'CHIEF_GIT_AUTHOR_NAME=a',
    ]);
  });

  it('mounts the account directory read-write and the key read-only', async () => {
    // Inside Docker the account directory is on the data volume, so the daemon
    // is given the volume's host mountpoint plus the relative path.
    const config = loadConfig({ DATA_DIR: '/data', CHIEF_DATA_VOLUME: 'chief-web-data' });
    const paths = new HostPaths(config, {
      inspectVolume: (name) => Promise.resolve({ name, mountpoint: '/var/lib/docker/volumes/x/_data' }),
    });
    const accountId = '0123456789abcdef';
    assert.equal(claudeAccountDir(config, accountId), `/data/claude-accounts/${accountId}`);
    const hostDir = `/var/lib/docker/volumes/x/_data/claude-accounts/${accountId}`;
    assert.equal(await claudeAccountBind(config, paths, accountId), `${hostDir}:${RUNNER_CLAUDE_DIR}`);

    const args = runnerMountArgs({
      claudeAuth: await paths.translate(claudeAccountDir(config, accountId)),
      workspaceDir: '/data/workspaces/s1',
      sshKeyPath: '/data/ssh-keys/r1.key',
    });
    assert.deepEqual(args, [
      '--volume',
      `${hostDir}:${RUNNER_CLAUDE_DIR}`,
      '--volume',
      `/data/workspaces/s1:${RUNNER_WORKSPACE_DIR}`,
      '--volume',
      `/data/ssh-keys/r1.key:${RUNNER_SSH_KEY_PATH}:ro`,
    ]);
  });

  it('omits the key mount when the session has no repository key', () => {
    const args = runnerMountArgs({ claudeAuth: '/data/claude-accounts/a', workspaceDir: '/w' });
    assert.equal(args.length, 4);
    assert.ok(!args.some((arg) => arg.includes(RUNNER_SSH_KEY_PATH)));
  });
});

describe('git identity settings', () => {
  it('falls back to the image defaults when nothing is stored', () => {
    const db = openDatabase(IN_MEMORY);
    assert.deepEqual(getGitIdentity(db), {
      name: DEFAULT_GIT_AUTHOR_NAME,
      email: DEFAULT_GIT_AUTHOR_EMAIL,
    });
    db.close();
  });

  it('prefers the stored values', () => {
    const db = openDatabase(IN_MEMORY);
    setSetting(db, 'git_author_name', 'Release Bot');
    setSetting(db, 'git_author_email', 'bot@example.com');
    assert.deepEqual(getGitIdentity(db), { name: 'Release Bot', email: 'bot@example.com' });
    db.close();
  });

  it('rejects identities git would refuse', () => {
    assert.ok(isValidGitAuthorName('chief-web'));
    assert.ok(!isValidGitAuthorName(''));
    assert.ok(!isValidGitAuthorName('  '));
    assert.ok(!isValidGitAuthorName('a <b>'));
    assert.ok(!isValidGitAuthorName('a\nb'));
    assert.ok(!isValidGitAuthorName('x'.repeat(201)));

    assert.ok(isValidGitAuthorEmail('chief-web@localhost'));
    assert.ok(!isValidGitAuthorEmail('nope'));
    assert.ok(!isValidGitAuthorEmail('a b@c'));
    assert.ok(!isValidGitAuthorEmail('a@b@c'));
    assert.ok(!isValidGitAuthorEmail(''));
  });
});
