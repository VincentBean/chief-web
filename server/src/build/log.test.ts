import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { WebSocket } from 'ws';

import { createAuthService } from '../auth/index.js';
import { type Config, loadConfig } from '../config.js';
import {
  createRepository,
  createSession,
  type Database,
  IN_MEMORY,
  openDatabase,
  type Session,
} from '../db/index.js';
import { agentLogPathFor } from '../prd/index.js';
import { WebSocketGateway } from '../ws/gateway.js';
import {
  type BuildLogEvent,
  type BuildLogStore,
  createBuildLogStore,
  GIT_EXCLUDE_HEADER,
  parseLog,
} from './log.js';
import { buildLogSocketPath, type BuildLogMessage, createBuildLogSocketRoute } from './socket.js';
import { AgentOutputFormatter, renderLine } from './stream.js';

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A session with a clone on disk, the least a log store needs. */
class World {
  readonly config: Config;
  readonly db: Database;
  readonly session: Session;
  readonly store: BuildLogStore;

  constructor() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-log-'));
    tempDirs.push(dir);
    this.config = loadConfig({ DATA_DIR: dir });
    this.db = openDatabase(IN_MEMORY);

    const repository = createRepository(this.db, {
      name: 'demo',
      sshUrl: 'git@github.com:acme/demo.git',
      githubSlug: 'acme/demo',
    });
    this.session = createSession(this.db, {
      repositoryId: repository.id,
      name: 'add-login',
      baseBranch: 'main',
      prTargetBranch: 'main',
    });
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
    this.store = createBuildLogStore(this.config, this.db);
  }

  get logFile(): string {
    return path.join(
      this.config.workspacesDir,
      this.session.id,
      'repo',
      agentLogPathFor(this.session.name),
    );
  }

  read(): string {
    return fs.existsSync(this.logFile) ? fs.readFileSync(this.logFile, 'utf8') : '';
  }
}

describe('the stream-json formatter', () => {
  it('renders an init event as the model and the working directory', () => {
    const line = renderLine(
      JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-5', cwd: '/workspace/repo' }),
    );

    assert.equal(line, '[claude] started with claude-opus-5 in /workspace/repo\n');
  });

  it('renders assistant text and the tool calls under it', () => {
    const line = renderLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Running the tests.' },
            { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
          ],
        },
      }),
    );

    assert.equal(line, 'Running the tests.\n[tool] Bash: npm test\n');
  });

  it('names the file a file tool touched', () => {
    const line = renderLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/workspace/repo/a.ts' } }],
        },
      }),
    );

    assert.equal(line, '[tool] Edit: /workspace/repo/a.ts\n');
  });

  it('abbreviates a tool result and marks a failed one', () => {
    const ok = renderLine(
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'one\ntwo\nthree\nfour\nfive' }] },
      }),
    );
    const failed = renderLine(
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', is_error: true, content: 'boom' }] },
      }),
    );

    assert.equal(ok, '[ok] one\ntwo\nthree\n…\n');
    assert.equal(failed, '[failed] boom\n');
  });

  it('summarises the final result, and quotes it only when it failed', () => {
    const success = renderLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 61_500,
        num_turns: 12,
        total_cost_usd: 0.4213,
        result: 'All done.',
      }),
    );
    const failure = renderLine(
      JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'gave up' }),
    );

    assert.equal(success, '[claude] finished (61.5s, 12 turns, $0.4213)\n');
    assert.equal(failure, '[claude] ended: error_max_turns\ngave up\n');
  });

  it('passes a line that is not an event through verbatim', () => {
    // stderr, a crash, a warning from the image: the log is the only place
    // these can appear.
    assert.equal(renderLine('claude: not found'), 'claude: not found\n');
    assert.equal(renderLine('{"type":'), '{"type":\n');
  });

  it('drops an envelope of a kind it does not know', () => {
    assert.equal(renderLine(JSON.stringify({ type: 'stream_event', event: {} })), '');
  });

  it('renders only whole lines, holding a half-received event back', () => {
    const formatter = new AgentOutputFormatter();
    const event = JSON.stringify({ type: 'system', subtype: 'init', model: 'opus' });

    assert.equal(formatter.push(event.slice(0, 20)), '');
    assert.equal(formatter.push(`${event.slice(20)}\n`), '[claude] started with opus\n');
    // Nothing is stranded when the stream ends without a final newline.
    assert.equal(formatter.push('trailing'), '');
    assert.equal(formatter.flush(), 'trailing\n');
  });
});

describe('the build log file', () => {
  it('appends a marked section per iteration to the workspace', () => {
    const world = new World();

    const first = world.store.begin(world.session, 1, 'US-001');
    first.write('working\n');
    first.end(0);
    const second = world.store.begin(world.session, 2, 'US-002');
    second.write('still working\n');
    second.end(null);

    const text = world.read();
    assert.match(text, /=== chief-web iteration 1 \| US-001 \| \S+ ===/);
    assert.match(text, /=== chief-web iteration 1 ended \| exit 0 \| \S+ ===/);
    assert.match(text, /=== chief-web iteration 2 ended \| exit - \| \S+ ===/);
    assert.ok(text.includes('working\n'));
  });

  it('tells the clone to ignore the log, so no agent can commit it', () => {
    const world = new World();
    fs.mkdirSync(path.join(world.config.workspacesDir, world.session.id, 'repo', '.git'), {
      recursive: true,
    });

    world.store.begin(world.session, 1, 'US-001').end(0);
    world.store.begin(world.session, 2, 'US-001').end(0);

    const exclude = fs.readFileSync(
      path.join(world.config.workspacesDir, world.session.id, 'repo', '.git/info/exclude'),
      'utf8',
    );
    // `.git/info/exclude` is local to the clone, so nothing the repository owns
    // is changed — and the entry is written once, not once per iteration.
    assert.ok(exclude.includes(GIT_EXCLUDE_HEADER));
    assert.equal(exclude.split('/.chief/prds/add-login/agent.log').length - 1, 1);
  });

  it('reads its own markers back as per-iteration sections', () => {
    const world = new World();
    const writer = world.store.begin(world.session, 1, 'US-001');
    writer.write('line one\nline two\n');
    writer.end(0);

    const history = world.store.history(world.session);

    assert.equal(history.path, '.chief/prds/add-login/agent.log');
    assert.equal(history.truncated, false);
    assert.equal(history.iterations.length, 1);
    const [only] = history.iterations;
    assert.equal(only?.iteration, 1);
    assert.equal(only?.storyId, 'US-001');
    assert.equal(only?.exitCode, 0);
    assert.equal(only?.text, 'line one\nline two\n');
    assert.ok(only?.endedAt !== null);
  });

  it('reports an iteration that is still running as unfinished', () => {
    const world = new World();
    world.store.begin(world.session, 3, null).write('half of it\n');

    const [only] = world.store.history(world.session).iterations;

    assert.equal(only?.endedAt, null);
    assert.equal(only?.exitCode, null);
    assert.equal(only?.storyId, null);
  });

  it('has no history at all before the first build', () => {
    const world = new World();

    assert.deepEqual(world.store.history(world.session), {
      path: '.chief/prds/add-login/agent.log',
      iterations: [],
      truncated: false,
    });
  });

  it('drops output whose header the read did not reach, and says so', () => {
    const parsed = parseLog(
      'the tail of an iteration nobody can name\n' +
        '=== chief-web iteration 9 | US-009 | 2026-08-29T10:00:00.000Z ===\n' +
        'readable\n',
    );

    assert.equal(parsed.truncated, true);
    assert.equal(parsed.iterations.length, 1);
    assert.equal(parsed.iterations[0]?.text, 'readable\n');
  });

  it('keeps writing to the watchers when the file cannot be written', () => {
    const world = new World();
    // A path that cannot be a file: the loop must not care either way.
    fs.rmSync(world.logFile, { force: true });
    fs.mkdirSync(world.logFile, { recursive: true });

    const seen: BuildLogEvent[] = [];
    const attachment = world.store.attach(world.session.id, (event) => seen.push(event));
    const writer = world.store.begin(world.session, 1, 'US-001');
    writer.write('still delivered\n');
    writer.end(0);
    attachment?.detach();

    assert.deepEqual(
      seen.map((event) => event.type),
      ['begin', 'append', 'end'],
    );
  });
});

describe('watching a build log', () => {
  it('hands a watcher the history and then everything written after it', () => {
    const world = new World();
    const before = world.store.begin(world.session, 1, 'US-001');
    before.write('already there\n');
    before.end(0);

    const seen: BuildLogEvent[] = [];
    const attachment = world.store.attach(world.session.id, (event) => seen.push(event));
    assert.ok(attachment !== null);
    assert.equal(attachment.history.iterations.length, 1);
    assert.equal(attachment.history.iterations[0]?.text, 'already there\n');

    const next = world.store.begin(world.session, 2, 'US-002');
    next.write('live\n');
    next.end(1);
    attachment.detach();
    // Detaching a watcher must not stop the loop writing.
    world.store.begin(world.session, 3, 'US-002').write('after the tab closed\n');

    const [begin, appended, ended] = seen;
    assert.deepEqual(begin, {
      type: 'begin',
      iteration: 2,
      storyId: 'US-002',
      startedAt: begin?.type === 'begin' ? begin.startedAt : '',
    });
    assert.deepEqual(appended, { type: 'append', text: 'live\n' });
    assert.deepEqual(ended, {
      type: 'end',
      exitCode: 1,
      endedAt: ended?.type === 'end' ? ended.endedAt : '',
    });
    assert.ok(world.read().includes('after the tab closed'));
  });

  it('refuses to attach to a session that does not exist', () => {
    const world = new World();

    assert.equal(world.store.attach('nope', () => {}), null);
  });

  it('ends a section only once, however often the loop says so', () => {
    const world = new World();
    const writer = world.store.begin(world.session, 1, 'US-001');
    writer.end(0);
    writer.end(1);
    writer.write('after the end');

    const [only] = world.store.history(world.session).iterations;
    assert.equal(only?.exitCode, 0);
    assert.equal(world.store.history(world.session).iterations.length, 1);
  });
});

describe('the build log WebSocket', () => {
  const world = new World();
  const auth = createAuthService(loadConfig({ CHIEF_WEB_PASSWORD: 'pw' }), world.db);
  const cookie = auth.sessionCookie().split(';')[0] ?? '';
  const gateway = new WebSocketGateway(auth);

  let httpServer: Server;
  let baseUrl: string;

  before(async () => {
    gateway.register(createBuildLogSocketRoute(world.store));
    httpServer = createServer((_req, res) => res.end());
    gateway.attach(httpServer);
    httpServer.listen(0, '127.0.0.1');
    await new Promise((resolve) => httpServer.once('listening', resolve));
    baseUrl = `ws://127.0.0.1:${String((httpServer.address() as AddressInfo).port)}`;
  });

  after(async () => {
    gateway.close();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  const connect = (id: string): WebSocket =>
    new WebSocket(`${baseUrl}${buildLogSocketPath(id)}`, { headers: { cookie } });

  it('replays the history and then streams what the loop writes', async () => {
    const done = world.store.begin(world.session, 1, 'US-001');
    done.write('from an earlier iteration\n');
    done.end(0);

    const socket = connect(world.session.id);
    const messages: BuildLogMessage[] = [];
    const attached = new Promise<void>((resolve) => {
      socket.on('message', (raw: Buffer) => {
        messages.push(JSON.parse(raw.toString('utf8')) as BuildLogMessage);
        if (messages.length === 1) resolve();
      });
    });
    await new Promise((resolve) => socket.once('open', resolve));
    await attached;

    const first = messages[0];
    assert.equal(first?.type, 'attached');
    assert.equal(first.history.iterations[0]?.text, 'from an earlier iteration\n');

    const live = new Promise<void>((resolve) => {
      socket.on('message', () => {
        if (messages.length >= 3) resolve();
      });
    });
    const running = world.store.begin(world.session, 2, 'US-002');
    running.write('live output\n');
    await live;
    socket.close();

    assert.deepEqual(messages[1], {
      type: 'begin',
      iteration: 2,
      storyId: 'US-002',
      startedAt: (messages[1] as { startedAt: string }).startedAt,
    });
    assert.deepEqual(messages[2], { type: 'append', text: 'live output\n' });
  });

  it('closes with 4404 for a session that does not exist', async () => {
    const socket = connect('missing');
    const code = await new Promise<number>((resolve) => socket.on('close', resolve));

    assert.equal(code, 4404);
  });
});
