import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { afterEach, describe, it } from 'node:test';

import {
  closeDatabase,
  createRepository,
  createSession,
  type Database,
  getDecision,
  getOpenDecision,
  getSession,
  IN_MEMORY,
  listDecisions,
  openDatabase,
  type Session,
  updateSession,
} from '../db/index.js';
import { ExecDeadline, type ExecChunk, type ExecOutput, type ExecSpec } from '../docker/index.js';
import type { VoiceBusEvent } from '../voice/events.js';
import { DecisionWatcher } from './decisions.js';
import { BUILD_MCP_CONFIG_FILE, DECISION_ASK_DIR } from './mcp.js';

/**
 * The operator's half of `ask_operator` (decisions US-004, US-006, US-007).
 *
 * The container is a stub rather than the fake daemon: everything worth
 * proving here is about the three things the watcher owns — the row, the
 * session's status and the iteration's clock — and the file round trip itself
 * is covered against the real MCP server in `ask-mcp.test.ts`.
 */

/** The request files the MCP server would have written, and the answers read back. */
class FakeContainer {
  /** Request files, as `listRequestFiles` would read them. */
  requests: Record<string, unknown>[] = [];
  /** Every answer written through stdin, parsed. */
  readonly answers: Record<string, unknown>[] = [];
  /** Specs of every collected command, so the MCP config write can be checked. */
  readonly runs: ExecSpec[] = [];
  /** Exit code the next collected command reports. */
  writeExitCode = 0;
  /** Exit code the next answer write reports; non-zero is a failed write. */
  answerExitCode = 0;
  private nextExec = 0;
  private readonly exits = new Map<string, number>();

  runExec(_container: string, spec: ExecSpec): Promise<ExecOutput> {
    this.runs.push(spec);
    const command = spec.cmd.join(' ');
    if (command.includes(`${DECISION_ASK_DIR}/*.request`)) {
      return Promise.resolve({
        exitCode: 0,
        stdout: this.requests.map((request) => `${JSON.stringify(request)}\n`).join(''),
        stderr: '',
        timedOut: false,
      });
    }
    return Promise.resolve({ exitCode: this.writeExitCode, stdout: '', stderr: '', timedOut: false });
  }

  attachExec(_container: string, spec: ExecSpec): Promise<{
    execId: string;
    stdin: PassThrough;
    output: AsyncIterable<ExecChunk>;
  }> {
    const execId = `exec-${String((this.nextExec += 1))}`;
    const stdin = new PassThrough();
    let content = '';
    stdin.on('data', (chunk: Buffer) => (content += chunk.toString('utf8')));
    const finished = new Promise<void>((resolve) => {
      stdin.on('end', () => {
        if (content !== '') this.answers.push(JSON.parse(content) as Record<string, unknown>);
        this.exits.set(execId, this.answerExitCode);
        resolve();
      });
    });
    void spec;
    const output: AsyncIterable<ExecChunk> = {
      // The relay drains the output before asking for the exit code. There is
      // nothing to print, so it only has to end — once stdin has closed.
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<ExecChunk>> => {
          await finished;
          return { done: true, value: undefined };
        },
      }),
    };
    return Promise.resolve({ execId, stdin, output });
  }

  inspectExec(execId: string): Promise<{ running: boolean; exitCode: number | null; pid: number }> {
    return Promise.resolve({ running: false, exitCode: this.exits.get(execId) ?? 0, pid: 0 });
  }
}

const REQUEST_ID = '7b1c2d3e-4a5b-4c6d-8e7f-0123456789ab';

class World {
  readonly db: Database;
  readonly container = new FakeContainer();
  readonly events: VoiceBusEvent[] = [];
  readonly watcher: DecisionWatcher;
  session: Session;

  constructor(options: { timeoutMs?: number } = {}) {
    this.db = openDatabase(IN_MEMORY);
    const repositoryId = createRepository(this.db, {
      name: 'demo',
      sshUrl: 'git@github.com:acme/demo.git',
      githubSlug: 'acme/demo',
    }).id;
    this.session =
      updateSession(
        this.db,
        createSession(this.db, { repositoryId, name: 'refactor', baseBranch: 'main', prTargetBranch: 'main' }).id,
        { status: 'building' },
      ) ?? (undefined as never);
    this.watcher = new DecisionWatcher({
      db: this.db,
      docker: this.container,
      events: { publish: (event) => this.events.push(event) },
      timeoutMs: options.timeoutMs ?? 60_000,
      discoveryMs: 40,
      pollMs: 5,
    });
  }

  /** The request file an `ask_operator` call would have left behind. */
  request(fields: Record<string, unknown> = {}): void {
    this.container.requests = [
      {
        id: REQUEST_ID,
        question: 'Keep the old sync API as a deprecated shim?',
        options: ['Keep it for one release', 'Remove it now'],
        context: 'Two call sites outside this repo use it.',
        recommendation: 'Keep it.',
        createdAt: '2026-10-03T10:00:00.000Z',
        ...fields,
      },
    ];
  }

  ask(deadline: ExecDeadline | null = null) {
    return this.watcher.asked({
      session: this.session,
      containerId: 'container-refactor',
      storyId: 'US-002',
      iteration: 3,
      deadline,
    });
  }

  status(): string {
    return getSession(this.db, this.session.id)?.status ?? 'gone';
  }
}

const worlds: World[] = [];
const world = (options: { timeoutMs?: number } = {}): World => {
  const created = new World(options);
  worlds.push(created);
  return created;
};
afterEach(() => {
  for (const used of worlds.splice(0)) {
    // Clears any wait still standing, and with it the timer behind it.
    used.watcher.abandon(used.session.id);
    closeDatabase(used.db);
  }
});

describe('DecisionWatcher (decisions US-004, US-006, US-007)', () => {
  it('takes the question down, parks the session and stops the clock', async () => {
    const stage = world();
    stage.request();
    const deadline = new ExecDeadline(1_800_000);
    deadline.start(() => undefined);

    const decision = await stage.ask(deadline);

    assert.equal(decision?.id, REQUEST_ID);
    assert.equal(decision?.question, 'Keep the old sync API as a deprecated shim?');
    assert.deepEqual(decision?.options, ['Keep it for one release', 'Remove it now']);
    assert.equal(decision?.context, 'Two call sites outside this repo use it.');
    assert.equal(decision?.storyId, 'US-002');
    assert.equal(decision?.iteration, 3);
    assert.equal(decision?.status, 'open');

    assert.equal(stage.status(), 'deciding');
    assert.equal(stage.watcher.isWaiting(stage.session.id), true);
    // The agent is not working, so its budget is not being spent.
    assert.equal(deadline.isRunning, false);
    // Said on the voice bus, with the question in it (US-008).
    assert.deepEqual(stage.events, [
      {
        kind: 'build.deciding',
        sessionId: stage.session.id,
        name: 'refactor',
        question: 'Keep the old sync API as a deprecated shim?',
      },
    ]);
  });

  it('hands the answer to the waiting agent and starts the clock again', async () => {
    const stage = world();
    stage.request();
    const deadline = new ExecDeadline(1_800_000);
    deadline.start(() => undefined);
    await stage.ask(deadline);

    const answered = await stage.watcher.answer(stage.session.id, '  Keep it for one release.  ');

    // The file the blocked MCP server is waiting on, in the shape it reads.
    assert.deepEqual(stage.container.answers, [
      { id: REQUEST_ID, answered: true, answer: 'Keep it for one release.' },
    ]);
    assert.equal(answered?.status, 'answered');
    assert.equal(answered?.answer, 'Keep it for one release.', 'stored as the operator wrote it, trimmed');
    assert.equal(stage.status(), 'building');
    assert.equal(stage.watcher.isWaiting(stage.session.id), false);
    assert.equal(deadline.isRunning, true, 'the iteration is working again, so its clock runs again');
    assert.equal(getOpenDecision(stage.db, stage.session.id), null);
  });

  it('refuses a second answer to the same question', async () => {
    const stage = world();
    stage.request();
    await stage.ask();
    await stage.watcher.answer(stage.session.id, 'Keep it.');
    assert.equal(await stage.watcher.answer(stage.session.id, 'No, remove it.'), null);
    assert.equal(stage.container.answers.length, 1);
  });

  it('keeps the question open when the answer could not be written into the container', async () => {
    const stage = world();
    stage.request();
    await stage.ask();
    stage.container.answerExitCode = 1;

    await assert.rejects(
      () => stage.watcher.answer(stage.session.id, 'Keep it.'),
      /could not be written/,
    );
    // Nothing reached the agent, so nothing may look settled.
    assert.equal(getOpenDecision(stage.db, stage.session.id)?.status, 'open');
    assert.equal(stage.status(), 'deciding');
    assert.equal(stage.watcher.isWaiting(stage.session.id), true);
  });

  it('gives up when nobody answers, and puts the session back to building', async () => {
    const stage = world({ timeoutMs: 30 });
    stage.request();
    const deadline = new ExecDeadline(1_800_000);
    deadline.start(() => undefined);
    await stage.ask(deadline);

    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(getDecision(stage.db, REQUEST_ID)?.status, 'expired');
    assert.equal(stage.status(), 'building');
    assert.equal(stage.watcher.isWaiting(stage.session.id), false);
    assert.equal(deadline.isRunning, true);
    // Nothing is written into the container: the tool's own wait has run out
    // by now and it has already told the agent to carry on.
    assert.deepEqual(stage.container.answers, []);
  });

  it('drops the question with the run that asked it, without resuming a clock', async () => {
    const stage = world();
    stage.request();
    const deadline = new ExecDeadline(1_800_000);
    deadline.start(() => undefined);
    await stage.ask(deadline);

    stage.watcher.abandon(stage.session.id);

    assert.equal(getDecision(stage.db, REQUEST_ID)?.status, 'abandoned');
    assert.equal(stage.status(), 'building', 'the status is handed back for whoever is ending the run');
    assert.equal(stage.watcher.isWaiting(stage.session.id), false);
    assert.equal(deadline.isRunning, false, 'there is no iteration left to charge the clock to');
  });

  it('leaves a session that has already moved on exactly where it is', async () => {
    const stage = world();
    stage.request();
    await stage.ask();
    // "Stop build" got there first.
    updateSession(stage.db, stage.session.id, { status: 'ready' });

    stage.watcher.abandon(stage.session.id);

    assert.equal(stage.status(), 'ready');
    assert.equal(getDecision(stage.db, REQUEST_ID)?.status, 'abandoned');
  });

  it('asks nothing when no request file appears, and leaves the session building', async () => {
    const stage = world();
    assert.equal(await stage.ask(), null);
    assert.equal(stage.status(), 'building');
    assert.deepEqual(listDecisions(stage.db, stage.session.id), []);
  });

  it('ignores a request file with no question in it', async () => {
    const stage = world();
    stage.request({ question: '  ' });
    assert.equal(await stage.ask(), null);
    assert.equal(stage.status(), 'building');
  });

  it('takes one question at a time: the agent is blocked on the one it asked', async () => {
    const stage = world();
    stage.request();
    await stage.ask();
    stage.container.requests = [{ ...stage.container.requests[0], id: '0a1b2c3d-4e5f-4a6b-8c7d-9e8f7a6b5c4d' }];

    assert.equal(await stage.ask(), null);
    assert.equal(listDecisions(stage.db, stage.session.id).length, 1);
  });

  it('writes the iteration’s MCP config with the same timeout the tool waits for', async () => {
    const stage = world({ timeoutMs: 123_000 });
    assert.equal(await stage.watcher.prepare(stage.session.id, 'container-refactor'), BUILD_MCP_CONFIG_FILE);
    const spec = stage.container.runs.at(-1);
    const json = spec?.cmd.at(-1) ?? '';
    assert.match(json, /"CHIEF_MCP_ASK_OPERATOR":"1"/);
    assert.match(json, /"CHIEF_MCP_ASK_TIMEOUT_MS":"123000"/);
    assert.match(json, /"CHIEF_MCP_START_BUILD":"0"/);
    assert.equal(spec?.user, '1000', 'written as the build agent, which has to read it');
  });

  it('launches the iteration without the flag rather than failing when the config cannot be written', async () => {
    const stage = world();
    stage.container.writeExitCode = 1;
    assert.equal(await stage.watcher.prepare(stage.session.id, 'container-refactor'), null);
  });
});
