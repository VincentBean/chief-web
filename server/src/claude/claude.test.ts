import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type Config, loadConfig } from '../config.js';
import { claudeAuthSource, RUNNER_CLAUDE_DIR } from '../runner/index.js';
import type { CommandResult, CommandRunner } from '../ssh/index.js';
import { claudeLoginContainerArgs, CLAUDE_LOGIN_CONTAINER_NAME } from './login.js';
import { claudeProbeArgs, parseStatusJson, probeClaudeAuth } from './status.js';

const LOGGED_OUT = JSON.stringify({ loggedIn: false, authMethod: 'none' });
const LOGGED_IN = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  email: 'someone@example.com',
  orgName: 'Example Inc',
  subscriptionType: 'max',
});

function runner(result: Partial<CommandResult>): CommandRunner {
  return () =>
    Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false, ...result });
}

function configWith(env: Record<string, string>): Config {
  return loadConfig({ ...env });
}

describe('claude auth probe', () => {
  it('mounts the shared volume by name inside Docker', () => {
    const config = configWith({ CLAUDE_AUTH_VOLUME: 'chief-web-claude-auth' });

    assert.equal(claudeAuthSource(config), 'chief-web-claude-auth');
    assert.ok(
      claudeProbeArgs(config).includes(`chief-web-claude-auth:${RUNNER_CLAUDE_DIR}`),
      'the probe container must see the same credentials as a session container',
    );
    assert.deepEqual(claudeProbeArgs(config).slice(-3), ['auth', 'status', '--json']);
  });

  it('bind-mounts the directory when there is no volume (local development)', () => {
    const config = configWith({ CLAUDE_AUTH_DIR: '/tmp/creds' });

    assert.equal(claudeAuthSource(config), '/tmp/creds');
    assert.ok(claudeProbeArgs(config).includes(`/tmp/creds:${RUNNER_CLAUDE_DIR}`));
  });

  it('reads the CLI verdict even though it exits non-zero when logged out', async () => {
    const status = await probeClaudeAuth(configWith({}), runner({ code: 1, stdout: LOGGED_OUT }));

    assert.equal(status.authenticated, false);
    assert.equal(status.authMethod, 'none');
    assert.equal(status.error, null);
  });

  it('reports the signed-in account', async () => {
    const status = await probeClaudeAuth(configWith({}), runner({ stdout: LOGGED_IN }));

    assert.equal(status.authenticated, true);
    assert.equal(status.account, 'someone@example.com');
    assert.equal(status.organization, 'Example Inc');
    assert.equal(status.subscription, 'max');
    assert.equal(status.error, null);
  });

  it('fails closed when the probe cannot run', async () => {
    const status = await probeClaudeAuth(
      configWith({}),
      runner({ code: 125, stderr: 'Unable to find image' }),
    );

    assert.equal(status.authenticated, false);
    assert.match(status.error ?? '', /Unable to find image/);
  });

  it('fails closed when the probe times out', async () => {
    const status = await probeClaudeAuth(configWith({}), runner({ timedOut: true }));

    assert.equal(status.authenticated, false);
    assert.match(status.error ?? '', /timed out/);
  });

  it('fails closed when the command itself throws', async () => {
    const status = await probeClaudeAuth(configWith({}), () =>
      Promise.reject(new Error('ENOENT docker')),
    );

    assert.equal(status.authenticated, false);
    assert.match(status.error ?? '', /ENOENT docker/);
  });

  it('tolerates output printed around the JSON', () => {
    const parsed = parseStatusJson(`update available\n${LOGGED_IN}\nbye\n`);

    assert.equal(parsed?.loggedIn, true);
  });

  it('returns null for output that is not a JSON object', () => {
    assert.equal(parseStatusJson('command not found'), null);
    assert.equal(parseStatusJson('{ nope }'), null);
    assert.equal(parseStatusJson('[1,2]'), null);
  });
});

describe('claude login container', () => {
  it('runs detached under a fixed name with only the credentials volume', () => {
    const args = claudeLoginContainerArgs(configWith({ CLAUDE_AUTH_VOLUME: 'vol' }));

    assert.ok(args.includes('--detach'));
    assert.deepEqual(args.slice(2, 4), ['--name', CLAUDE_LOGIN_CONTAINER_NAME]);
    assert.ok(args.includes(`vol:${RUNNER_CLAUDE_DIR}`));
    // No workspace and no repository key: signing in needs neither.
    assert.equal(args.filter((arg) => arg === '--volume').length, 1);
    assert.equal(args.at(-1), 'chief-web-runner:latest');
  });
});
