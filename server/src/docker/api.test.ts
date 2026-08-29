import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { demultiplex, DockerApi } from './index.js';
import { FakeDockerDaemon } from './fake-daemon.js';

/** `[stream, 0, 0, 0, size:uint32be]` followed by the payload. */
function frame(stream: number, payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt8(stream, 0);
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

describe('exec stream demultiplexing', () => {
  it('splits stdout and stderr frames', () => {
    const raw = Buffer.concat([frame(1, 'refs/heads/main\n'), frame(2, 'fatal: nope\n')]);

    assert.deepEqual(demultiplex(raw), { stdout: 'refs/heads/main\n', stderr: 'fatal: nope\n' });
  });

  it('joins consecutive frames of the same stream', () => {
    const raw = Buffer.concat([frame(2, 'Cloning'), frame(2, ' into…'), frame(1, 'ok')]);

    assert.deepEqual(demultiplex(raw), { stdout: 'ok', stderr: 'Cloning into…' });
  });

  it('keeps a truncated frame instead of dropping it', () => {
    const raw = Buffer.concat([frame(1, 'kept\n'), Buffer.from([1, 0, 0])]);

    assert.ok(demultiplex(raw).stdout.startsWith('kept\n'));
  });

  it('treats an unframed (TTY) stream as stdout', () => {
    assert.deepEqual(demultiplex(Buffer.from('plain output', 'utf8')), {
      stdout: 'plain output',
      stderr: '',
    });
  });

  it('reads an empty stream as empty output', () => {
    assert.deepEqual(demultiplex(Buffer.alloc(0)), { stdout: '', stderr: '' });
  });
});

describe('runExec', () => {
  let daemon: FakeDockerDaemon;
  let docker: DockerApi;

  before(async () => {
    daemon = await FakeDockerDaemon.start();
    daemon.addContainer({ id: 'c1', name: 'chief-web-demo' });
    docker = new DockerApi(daemon.socketPath);
  });

  after(async () => {
    await daemon.close();
  });

  it('collects stdout, stderr and the exit code of a command', async () => {
    daemon.onExec = () => ({ stdout: 'on stdout\n', stderr: 'on stderr\n', exitCode: 2 });

    const result = await docker.runExec('c1', { cmd: ['/bin/sh', '-c', 'true'] });

    assert.deepEqual(result, {
      exitCode: 2,
      stdout: 'on stdout\n',
      stderr: 'on stderr\n',
      timedOut: false,
    });
  });

  it('runs without a PTY and without stdin, and passes the environment through', async () => {
    daemon.onExec = () => ({ stdout: '' });

    await docker.runExec('c1', {
      cmd: ['/bin/sh', '-c', 'echo "$CHIEF_REPO_URL"'],
      env: ['CHIEF_REPO_URL=git@github.com:acme/demo.git'],
      workingDir: '/workspace',
    });

    const exec = daemon.execs().at(-1);
    assert.ok(exec);
    assert.equal(exec.tty, false);
    assert.equal(exec.workingDir, '/workspace');
    assert.deepEqual(exec.env, ['CHIEF_REPO_URL=git@github.com:acme/demo.git']);
    assert.equal(exec.input.length, 0);
  });

  it('reports a timeout instead of waiting on a command that never ends', async () => {
    // The fake process never exits, so only the deadline can end this call.
    daemon.onExec = () => ({ hang: true });

    const result = await docker.runExec('c1', { cmd: ['/bin/sh', '-c', 'sleep 60'] }, 50);

    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
    daemon.onExec = null;
  });
});
