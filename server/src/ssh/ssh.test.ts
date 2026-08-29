import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { loadConfig } from '../config.js';
import { deriveGithubSlug, isValidGithubSlug, isValidGitUrl, parseGitUrl } from '../lib/git-url.js';
import { type CommandResult, testGitConnection } from './connection.js';
import {
  deletePrivateKey,
  hasPrivateKey,
  readPrivateKey,
  repositoryKeyPath,
  writePrivateKey,
} from './key-store.js';
import { generateEd25519KeyPair, inspectPrivateKey, SshKeyError } from './openssh-key.js';

const tempDirs: string[] = [];

function tempConfig(): ReturnType<typeof loadConfig> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-web-ssh-'));
  tempDirs.push(dir);
  return loadConfig({ DATA_DIR: dir });
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('git url parsing', () => {
  it('parses the scp-like form git uses for SSH remotes', () => {
    assert.deepEqual(parseGitUrl('git@github.com:owner/repo.git'), {
      host: 'github.com',
      path: 'owner/repo',
    });
  });

  it('parses ssh:// and https:// URLs', () => {
    assert.deepEqual(parseGitUrl('ssh://git@github.com/owner/repo.git'), {
      host: 'github.com',
      path: 'owner/repo',
    });
    assert.deepEqual(parseGitUrl('https://github.com/owner/repo'), {
      host: 'github.com',
      path: 'owner/repo',
    });
  });

  it('rejects strings that are not remotes', () => {
    for (const value of ['', '   ', 'github.com', 'git@github.com:', 'not a url']) {
      assert.equal(isValidGitUrl(value), false, value);
    }
  });

  it('derives the GitHub slug from every accepted shape', () => {
    assert.equal(deriveGithubSlug('git@github.com:owner/repo.git'), 'owner/repo');
    assert.equal(deriveGithubSlug('ssh://git@github.com/owner/repo.git'), 'owner/repo');
    assert.equal(deriveGithubSlug('https://github.com/Owner/Repo-Name'), 'Owner/Repo-Name');
    // Self-hosted hosts derive a slug too; the operator can override it.
    assert.equal(deriveGithubSlug('git@git.example.com:team/app.git'), 'team/app');
  });

  it('returns null when the path is not exactly owner/repo', () => {
    assert.equal(deriveGithubSlug('git@gitlab.com:group/sub/repo.git'), null);
    assert.equal(deriveGithubSlug('git@github.com:repo.git'), null);
  });

  it('validates slugs', () => {
    assert.equal(isValidGithubSlug('owner/repo'), true);
    assert.equal(isValidGithubSlug('owner/repo/extra'), false);
    assert.equal(isValidGithubSlug('owner'), false);
  });
});

describe('ed25519 key generation', () => {
  it('produces an OpenSSH private key and a matching public key line', () => {
    const pair = generateEd25519KeyPair('chief-web:demo');

    assert.match(pair.privateKey, /^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
    assert.match(pair.privateKey, /-----END OPENSSH PRIVATE KEY-----\n$/);
    assert.match(pair.publicKey, /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[\w+/]+ chief-web:demo$/);
    assert.match(pair.fingerprint, /^SHA256:[\w+/]{43}$/);
    assert.equal(pair.type, 'ssh-ed25519');
  });

  it('generates a different key every time', () => {
    assert.notEqual(
      generateEd25519KeyPair('a').fingerprint,
      generateEd25519KeyPair('a').fingerprint,
    );
  });

  it('round-trips through the parser it will be re-read with', () => {
    const pair = generateEd25519KeyPair('chief-web:demo');
    const inspected = inspectPrivateKey(pair.privateKey);

    assert.equal(inspected.type, 'ssh-ed25519');
    assert.equal(inspected.fingerprint, pair.fingerprint);
    // The re-read line has no comment, so compare only the key material.
    assert.equal(inspected.publicKey, pair.publicKey.split(' ').slice(0, 2).join(' '));
  });
});

describe('inspecting a pasted private key', () => {
  it('derives the ssh-rsa public key from a PKCS#8 PEM', () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });

    const inspected = inspectPrivateKey(privateKey);
    assert.equal(inspected.type, 'ssh-rsa');
    assert.match(inspected.publicKey ?? '', /^ssh-rsa AAAAB3NzaC1yc2E/);
    assert.match(inspected.fingerprint ?? '', /^SHA256:/);
  });

  it('accepts a key whose public half cannot be re-encoded', () => {
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });

    const inspected = inspectPrivateKey(privateKey);
    assert.equal(inspected.publicKey, null);
    assert.equal(inspected.fingerprint, null);
  });

  it('rejects a passphrase-protected key, which a container could never unlock', () => {
    const { privateKey } = generateKeyPairSync('ed25519', {
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem',
        cipher: 'aes-256-cbc',
        passphrase: 'secret',
      },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });

    assert.throws(
      () => inspectPrivateKey(privateKey),
      (error: unknown) =>
        error instanceof SshKeyError && error.code === 'encrypted_private_key',
    );
  });

  it('rejects junk and empty input', () => {
    for (const value of ['', 'not a key', '-----BEGIN OPENSSH PRIVATE KEY-----\n!!!\n']) {
      assert.throws(
        () => inspectPrivateKey(value),
        (error: unknown) => error instanceof SshKeyError,
        value,
      );
    }
  });
});

describe('key store', () => {
  it('writes the private key with 0600 permissions', () => {
    const config = tempConfig();
    const pair = generateEd25519KeyPair('chief-web:demo');

    const file = writePrivateKey(config, 'repo-1', pair.privateKey);

    assert.equal(file, repositoryKeyPath(config, 'repo-1'));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(readPrivateKey(config, 'repo-1'), pair.privateKey);
    assert.equal(hasPrivateKey(config, 'repo-1'), true);
  });

  it('re-applies 0600 when overwriting a key that was left too permissive', () => {
    const config = tempConfig();
    writePrivateKey(config, 'repo-1', 'first');
    fs.chmodSync(repositoryKeyPath(config, 'repo-1'), 0o644);

    writePrivateKey(config, 'repo-1', 'second');

    assert.equal(fs.statSync(repositoryKeyPath(config, 'repo-1')).mode & 0o777, 0o600);
    assert.equal(readPrivateKey(config, 'repo-1'), 'second\n');
  });

  it('reports and deletes missing keys without throwing', () => {
    const config = tempConfig();
    assert.equal(hasPrivateKey(config, 'nope'), false);
    assert.equal(readPrivateKey(config, 'nope'), null);
    assert.doesNotThrow(() => deletePrivateKey(config, 'nope'));
  });
});

describe('git connection test', () => {
  const config = loadConfig({ RUNNER_IMAGE: 'test-runner:latest' });

  function runnerReturning(result: Partial<CommandResult>) {
    const calls: { command: string; args: readonly string[]; stdin: string }[] = [];
    const run = (
      command: string,
      args: readonly string[],
      stdin: string,
    ): Promise<CommandResult> => {
      calls.push({ command, args, stdin });
      return Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false, ...result });
    };
    return { calls, run };
  }

  it('runs the private key through stdin, never through argv or the environment', async () => {
    const { calls, run } = runnerReturning({ code: 0 });

    await testGitConnection(config, { sshUrl: 'git@github.com:o/r.git', privateKey: 'KEY' }, run);

    const call = calls[0];
    assert.ok(call);
    assert.equal(call.command, 'docker');
    assert.equal(call.stdin, 'KEY');
    assert.ok(call.args.includes('test-runner:latest'));
    assert.ok(call.args.includes('--rm'));
    assert.ok(call.args.includes('CHIEF_REPO_URL=git@github.com:o/r.git'));
    assert.equal(
      call.args.some((arg) => arg.includes('KEY')),
      false,
    );
  });

  it('reports success', async () => {
    const { run } = runnerReturning({ code: 0 });
    const result = await testGitConnection(config, { sshUrl: 'git@x:o/r.git', privateKey: 'K' }, run);
    assert.equal(result.ok, true);
    assert.equal(result.stderr, '');
  });

  it('reports the underlying stderr on failure', async () => {
    const { run } = runnerReturning({ code: 128, stderr: 'ERROR: Repository not found.\n' });

    const result = await testGitConnection(config, { sshUrl: 'git@x:o/r.git', privateKey: 'K' }, run);

    assert.equal(result.ok, false);
    assert.match(result.message, /exit code 128/);
    assert.equal(result.stderr, 'ERROR: Repository not found.');
  });

  it('reports a timeout distinctly', async () => {
    const { run } = runnerReturning({ code: null, timedOut: true });
    const result = await testGitConnection(config, { sshUrl: 'git@x:o/r.git', privateKey: 'K' }, run);
    assert.equal(result.ok, false);
    assert.match(result.message, /timed out/);
  });

  it('explains a runner that never started', async () => {
    const { run } = runnerReturning({ code: null, stderr: 'Error: spawn docker ENOENT' });
    const result = await testGitConnection(config, { sshUrl: 'git@x:o/r.git', privateKey: 'K' }, run);
    assert.equal(result.ok, false);
    assert.match(result.message, /could not be started/);
    assert.match(result.stderr, /ENOENT/);
  });
});
