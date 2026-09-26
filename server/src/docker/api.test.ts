import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { demultiplex, type ExecChunk, DockerApi, FrameDecoder } from './index.js';
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

describe('the incremental frame decoder', () => {
  const decode = (...chunks: Buffer[]): ExecChunk[] => {
    const decoder = new FrameDecoder();
    return [...chunks.flatMap((chunk) => decoder.push(chunk)), ...decoder.flush()];
  };

  it('holds a frame back until all of it has arrived', () => {
    const whole = frame(1, 'refs/heads/main\n');
    const decoder = new FrameDecoder();

    // Split inside the 8-byte header, then inside the payload: neither read
    // completes the frame, so neither may produce anything.
    assert.deepEqual(decoder.push(whole.subarray(0, 3)), []);
    assert.deepEqual(decoder.push(whole.subarray(3, 12)), []);
    assert.deepEqual(decoder.push(whole.subarray(12)), [
      { stream: 'stdout', text: 'refs/heads/main\n' },
    ]);
  });

  it('keeps stderr apart from stdout across chunks', () => {
    assert.deepEqual(decode(Buffer.concat([frame(1, 'out'), frame(2, 'err')])), [
      { stream: 'stdout', text: 'out' },
      { stream: 'stderr', text: 'err' },
    ]);
  });

  it('never splits a UTF-8 character across two chunks', () => {
    const payload = Buffer.from('héllo', 'utf8');
    const whole = Buffer.concat([frame(1, ''), payload]);
    whole.writeUInt32BE(payload.length, 4);

    // Cut between the two bytes of "é": neither half may be decoded on its own.
    assert.equal(
      decode(whole.subarray(0, 10), whole.subarray(10))
        .map((chunk) => chunk.text)
        .join(''),
      'héllo',
    );
  });

  it('treats an unframed (TTY) stream as stdout, for good', () => {
    assert.deepEqual(decode(Buffer.from('plain output over ', 'utf8'), Buffer.from('two writes', 'utf8')), [
      { stream: 'stdout', text: 'plain output over ' },
      { stream: 'stdout', text: 'two writes' },
    ]);
  });

  it('keeps a frame the stream ended in the middle of', () => {
    const whole = frame(1, 'half of it');

    assert.deepEqual(decode(whole.subarray(0, 12)), [{ stream: 'stdout', text: 'half' }]);
  });
});

describe('streamExec', () => {
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

  it('reports output while the command is still running', async () => {
    daemon.onExec = () => ({ hang: true });
    const seen: ExecChunk[] = [];

    const running = docker.streamExec(
      'c1',
      { cmd: ['/bin/sh', '-c', 'slow'] },
      { onOutput: (chunk) => seen.push(chunk) },
    );

    // The command has printed but not exited: the caller must already have it.
    // `running` is set when the daemon hijacks the connection, which is the
    // point at which it can push anything at all.
    const exec = await waitFor(() => daemon.execs().find((candidate) => candidate.running));
    daemon.emitFramed(exec.id, 'first line\n');
    await waitFor(() => (seen.length > 0 ? seen : undefined));
    assert.deepEqual(seen, [{ stream: 'stdout', text: 'first line\n' }]);

    daemon.emitFramed(exec.id, 'oh no\n', 'stderr');
    daemon.finish(exec.id, 3);
    const result = await running;

    assert.equal(result.exitCode, 3);
    assert.equal(result.stdout, 'first line\n');
    assert.equal(result.stderr, 'oh no\n');
    daemon.onExec = null;
  });

  it('keeps only the tail of what it is asked to retain', async () => {
    daemon.onExec = () => ({ stdout: '0123456789' });
    let streamed = '';

    const result = await docker.streamExec(
      'c1',
      { cmd: ['/bin/sh', '-c', 'noisy'] },
      { maxOutputChars: 4, onOutput: (chunk) => (streamed += chunk.text) },
    );

    // Nothing is lost from the stream; only the collected copy is capped.
    assert.equal(streamed, '0123456789');
    assert.equal(result.stdout, '6789');
    daemon.onExec = null;
  });
});

describe('attachExec', () => {
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

  /** A fake `claude` in stream-json mode: one result line per user line. */
  const fakeClaude = (lines: string[]) => (exec: { id: string }) => ({
    stdout: `${JSON.stringify({ type: 'system', subtype: 'init' })}\n`,
    onLine: (line: string) => {
      lines.push(line);
      const { message } = JSON.parse(line) as { message: { content: string } };
      daemon.emitFramed(exec.id, `${JSON.stringify({ type: 'result', result: `heard ${message.content}` })}\n`);
    },
  });

  const userLine = (content: string): string =>
    `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;

  it('writes lines to stdin and reads the answers back until stdin ends', async () => {
    const received: string[] = [];
    daemon.onExec = fakeClaude(received);

    const proc = await docker.attachExec('c1', { cmd: ['claude', '-p'], workingDir: '/workspace' });
    const exec = daemon.exec(proc.execId);
    assert.ok(exec);
    assert.equal(exec.tty, false);
    assert.equal(exec.attachStdin, true);
    assert.equal(exec.workingDir, '/workspace');

    const lines = linesOf(proc.output);
    assert.deepEqual(JSON.parse(await lines.next()), { type: 'system', subtype: 'init' });

    // One line split over two writes, then two lines in one write.
    const first = userLine('plan it');
    proc.stdin.write(first.slice(0, 10));
    proc.stdin.write(first.slice(10));
    assert.deepEqual(JSON.parse(await lines.next()), { type: 'result', result: 'heard plan it' });
    proc.stdin.write(userLine('two') + userLine('three'));
    assert.equal(JSON.parse(await lines.next()).result, 'heard two');
    assert.equal(JSON.parse(await lines.next()).result, 'heard three');

    // Stdin was not mistaken for the start request's body.
    assert.equal(received.length, 3);
    assert.equal(JSON.parse(received[0] as string).type, 'user');

    proc.stdin.end();
    assert.equal(await lines.rest(), '');
    assert.deepEqual(await docker.inspectExec(proc.execId), { running: false, exitCode: 0, pid: 0 });
    daemon.onExec = null;
  });

  it('decodes frames split across writes and several frames in one write', async () => {
    daemon.onExec = () => ({ onStdinEnd: () => {} });
    const proc = await docker.attachExec('c1', { cmd: ['claude'] });
    const exec = await waitFor(() => daemon.exec(proc.execId)?.socket ?? undefined);

    // Start reading first, so the two writes reach the client as two reads.
    const iterator = proc.output[Symbol.asyncIterator]();
    const firstChunk = iterator.next();
    const one = frame(1, '{"n":1}\n');
    exec.write(one.subarray(0, 5));
    await new Promise((resolve) => setImmediate(resolve));
    exec.write(Buffer.concat([one.subarray(5), frame(2, 'warn\n'), frame(1, '{"n":2}\n')]));
    daemon.finish(proc.execId, 7);

    const chunks: ExecChunk[] = [];
    for (let step = await firstChunk; step.done !== true; step = await iterator.next()) {
      chunks.push(step.value);
    }
    assert.deepEqual(chunks, [
      { stream: 'stdout', text: '{"n":1}\n' },
      { stream: 'stderr', text: 'warn\n' },
      { stream: 'stdout', text: '{"n":2}\n' },
    ]);
    // The process exited on its own while stdin was still open.
    assert.equal((await docker.inspectExec(proc.execId)).exitCode, 7);
    daemon.onExec = null;
  });

  it('lets the process answer after stdin ended, with its own exit code', async () => {
    daemon.onExec = (exec) => ({
      onStdinEnd: () => {
        daemon.emitFramed(exec.id, 'bye\n');
        daemon.finish(exec.id, 3);
      },
    });
    const proc = await docker.attachExec('c1', { cmd: ['claude'] });

    proc.stdin.end();
    const lines = linesOf(proc.output);
    assert.equal(await lines.rest(), 'bye\n');
    assert.equal((await docker.inspectExec(proc.execId)).exitCode, 3);
    daemon.onExec = null;
  });

  it('ends the output when the daemon drops the connection', async () => {
    daemon.onExec = () => ({ stdout: 'partial\n' });
    const proc = await docker.attachExec('c1', { cmd: ['claude'] });
    const lines = linesOf(proc.output);
    assert.equal(await lines.next(), 'partial');

    daemon.sever(proc.execId);

    assert.equal(await lines.rest(), '');
    // Writing to a process that is gone is not an error.
    proc.stdin.write('into the void\n');
    assert.equal((await docker.inspectExec(proc.execId)).running, false);
    daemon.onExec = null;
  });

  it('ends the output without throwing when the socket errors', async () => {
    daemon.onExec = () => ({ stdout: 'partial\n' });
    const proc = await docker.attachExec('c1', { cmd: ['claude'] });
    const lines = linesOf(proc.output);
    assert.equal(await lines.next(), 'partial');

    // Destroying stdin with an error destroys the socket under the reader,
    // which the iterator sees as a premature close.
    proc.stdin.on('error', () => {});
    proc.stdin.destroy(new Error('boom'));

    assert.equal(await lines.rest(), '');
    await waitFor(() => (daemon.exec(proc.execId)?.running === false ? true : undefined));
    daemon.onExec = null;
  });

  it('refuses a container that does not exist', async () => {
    await assert.rejects(docker.attachExec('missing', { cmd: ['claude'] }), { status: 404 });
  });
});

/** Reads stdout line by line off an exec's output; stderr is ignored. */
function linesOf(output: AsyncIterable<ExecChunk>): { next(): Promise<string>; rest(): Promise<string> } {
  const iterator = output[Symbol.asyncIterator]();
  let buffer = '';
  return {
    async next() {
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          return line;
        }
        const step = await iterator.next();
        if (step.done === true) throw new Error(`output ended before a full line: ${buffer}`);
        if (step.value.stream === 'stdout') buffer += step.value.text;
      }
    },
    async rest() {
      for (;;) {
        const step = await iterator.next();
        if (step.done === true) return buffer;
        if (step.value.stream === 'stdout') buffer += step.value.text;
      }
    },
  };
}

/** Polls `read` until it answers, so a test never sleeps a fixed amount. */
async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for the daemon');
}
