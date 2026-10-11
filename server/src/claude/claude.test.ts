import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type Config, loadConfig } from '../config.js';
import { HostPaths } from '../orchestrator/index.js';
import { RUNNER_CLAUDE_DIR } from '../runner/index.js';
import { CONTAINER_REPO_DIR } from '../sessions/index.js';
import type { CommandResult, CommandRunner } from '../ssh/index.js';
import {
  claudeLoginContainerArgs,
  claudeLoginContainerName,
  CLAUDE_LOGIN_COMMAND,
} from './login.js';
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

const ACCOUNT = '0123456789abcdef';
const VOLUME_MOUNTPOINT = '/var/lib/docker/volumes/chief-web-data/_data';
/** Inside Docker: the data volume, whose host mountpoint the daemon reports. */
const IN_DOCKER = { DATA_DIR: '/data', CHIEF_DATA_VOLUME: 'chief-web-data' };

function hostPaths(config: Config): HostPaths {
  return new HostPaths(config, {
    inspectVolume: (name) => Promise.resolve({ name, mountpoint: VOLUME_MOUNTPOINT }),
  });
}

/** `probeClaudeAuth` for the one account, with the fake command runner. */
function probe(config: Config, run: CommandRunner): ReturnType<typeof probeClaudeAuth> {
  return probeClaudeAuth(config, run, hostPaths(config), ACCOUNT);
}

describe('claude auth probe', () => {
  it('mounts the account directory at its host path inside Docker', async () => {
    const config = configWith(IN_DOCKER);
    const args = await claudeProbeArgs(config, hostPaths(config), ACCOUNT);

    const volume = args.indexOf('--volume');
    assert.deepEqual(args.slice(volume, volume + 2), [
      '--volume',
      `${VOLUME_MOUNTPOINT}/claude-accounts/${ACCOUNT}:${RUNNER_CLAUDE_DIR}`,
    ]);
    assert.equal(args.filter((arg) => arg === '--volume').length, 1);
    assert.deepEqual(args.slice(-3), ['auth', 'status', '--json']);
  });

  it('bind-mounts the account directory as-is when there is no volume (local development)', async () => {
    const config = configWith({ DATA_DIR: '/tmp/chief' });
    const args = await claudeProbeArgs(config, hostPaths(config), ACCOUNT);

    assert.ok(args.includes(`/tmp/chief/claude-accounts/${ACCOUNT}:${RUNNER_CLAUDE_DIR}`));
  });

  it('reads the CLI verdict even though it exits non-zero when logged out', async () => {
    const status = await probe(configWith({}), runner({ code: 1, stdout: LOGGED_OUT }));

    assert.equal(status.authenticated, false);
    assert.equal(status.authMethod, 'none');
    assert.equal(status.error, null);
  });

  it('reports the signed-in account', async () => {
    const status = await probe(configWith({}), runner({ stdout: LOGGED_IN }));

    assert.equal(status.authenticated, true);
    assert.equal(status.account, 'someone@example.com');
    assert.equal(status.organization, 'Example Inc');
    assert.equal(status.subscription, 'max');
    assert.equal(status.error, null);
  });

  it('fails closed when the probe cannot run', async () => {
    const status = await probe(
      configWith({}),
      runner({ code: 125, stderr: 'Unable to find image' }),
    );

    assert.equal(status.authenticated, false);
    assert.match(status.error ?? '', /Unable to find image/);
  });

  it('fails closed when the probe times out', async () => {
    const status = await probe(configWith({}), runner({ timedOut: true }));

    assert.equal(status.authenticated, false);
    assert.match(status.error ?? '', /timed out/);
  });

  it('names each probe container, and removes one that timed out', async () => {
    const calls: string[][] = [];
    let removed!: () => void;
    const removal = new Promise<void>((resolve) => (removed = resolve));
    const run: CommandRunner = (_command, args) => {
      calls.push([...args]);
      if (args[0] === 'rm') removed();
      return Promise.resolve({ code: null, stdout: '', stderr: '', timedOut: args[0] === 'run' });
    };

    await probe(configWith({}), run);
    await removal;

    const runArgs = calls[0] ?? [];
    const name = runArgs[runArgs.indexOf('--name') + 1] ?? '';
    assert.match(name, new RegExp(`^chief-web-claude-probe-${ACCOUNT}-[0-9a-f]{8}$`));
    assert.deepEqual(calls[1], ['rm', '--force', name]);
  });

  it('leaves a probe that answered to --rm', async () => {
    const calls: string[][] = [];
    const run: CommandRunner = (_command, args) => {
      calls.push([...args]);
      return Promise.resolve({ code: 0, stdout: LOGGED_IN, stderr: '', timedOut: false });
    };

    await probe(configWith({}), run);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(calls.length, 1);
  });

  it('fails closed when the command itself throws', async () => {
    const status = await probe(configWith({}), () =>
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
  it('runs detached under the account\'s own name with only its directory', async () => {
    const config = configWith(IN_DOCKER);
    const args = await claudeLoginContainerArgs(config, hostPaths(config), ACCOUNT);

    assert.ok(args.includes('--detach'));
    assert.deepEqual(args.slice(2, 4), ['--name', `chief-web-claude-login-${ACCOUNT}`]);
    assert.equal(claudeLoginContainerName(ACCOUNT), `chief-web-claude-login-${ACCOUNT}`);
    const volume = args.indexOf('--volume');
    assert.deepEqual(args.slice(volume, volume + 2), [
      '--volume',
      `${VOLUME_MOUNTPOINT}/claude-accounts/${ACCOUNT}:${RUNNER_CLAUDE_DIR}`,
    ]);
    // No workspace and no repository key: signing in needs neither.
    assert.equal(args.filter((arg) => arg === '--volume').length, 1);
    assert.equal(args.at(-1), 'chief-web-runner:latest');
  });

  it('marks the first-run wizard complete, so planning does not ask to sign in again', () => {
    const script = CLAUDE_LOGIN_COMMAND[2] ?? '';

    // `claude auth login` authenticates without setting the flags the
    // interactive wizard owns; leaving them unset sends an already signed-in
    // operator back to "Select login method" in the planning terminal.
    assert.match(script, /hasCompletedOnboarding = true/);
    assert.match(script, /projects\[\$repo\]\.hasTrustDialogAccepted = true/);
    assert.match(script, new RegExp(`--arg repo "${CONTAINER_REPO_DIR}"`));
    // Only on success: a failed login must not leave the wizard marked done.
    assert.ok(script.indexOf('if [ "$code" -eq 0 ]') < script.indexOf('hasCompletedOnboarding'));
    // Written through a temporary file rather than in place.
    assert.match(script, /jq [^\n]*> "\$tmp"/);
  });
});
