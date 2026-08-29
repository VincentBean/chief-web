import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { IN_MEMORY, openDatabase, setSetting } from '../db/index.js';
import {
  DEFAULT_GIT_AUTHOR_EMAIL,
  DEFAULT_GIT_AUTHOR_NAME,
  getGitIdentity,
  isValidGitAuthorEmail,
  isValidGitAuthorName,
} from '../settings/index.js';
import {
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

  it('mounts the auth volume read-write and the key read-only', () => {
    const args = runnerMountArgs({
      claudeAuthDir: '/claude-auth',
      workspaceDir: '/data/workspaces/s1',
      sshKeyPath: '/data/ssh-keys/r1.key',
    });
    assert.deepEqual(args, [
      '--volume',
      `/claude-auth:${RUNNER_CLAUDE_DIR}`,
      '--volume',
      `/data/workspaces/s1:${RUNNER_WORKSPACE_DIR}`,
      '--volume',
      `/data/ssh-keys/r1.key:${RUNNER_SSH_KEY_PATH}:ro`,
    ]);
  });

  it('omits the key mount when the session has no repository key', () => {
    const args = runnerMountArgs({ claudeAuthDir: '/claude-auth', workspaceDir: '/w' });
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
