import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { AgentInvocation, AgentResult, AgentRunner } from '../build/index.js';
import { type Config, loadConfig } from '../config.js';
import {
  closeDatabase,
  createRepository,
  createSession,
  type Database,
  IN_MEMORY,
  openDatabase,
  type Session,
  type Story,
  syncStories,
  listStories,
} from '../db/index.js';
import type { ExecOutput, ExecSpec } from '../docker/index.js';
import { sessionWorkspaceDir } from '../orchestrator/index.js';
import type { SessionContainers, SessionExecutor } from '../sessions/index.js';
import { CONTAINER_DESCRIPTION_PATH } from './prompts.js';
import {
  DESCRIPTION_ITERATION,
  DescriptionService,
  doneStoryTitles,
  MAX_DESCRIPTION_TIMEOUT_MS,
} from './service.js';

const DIFF = `server/src/app.ts | 4 ++--

diff --git a/server/src/app.ts b/server/src/app.ts
+const answer = 42;
`;

const DESCRIPTION = '### What was made\n\nA thing.\n\n### How it works\n\n- One step.';

class MockRunner implements AgentRunner {
  readonly invocations: AgentInvocation[] = [];
  readonly reaps: string[] = [];
  result: AgentResult = { exitCode: 0, output: '', timedOut: false };
  behaviour: () => void = () => {};

  run(invocation: AgentInvocation): Promise<AgentResult> {
    this.invocations.push(invocation);
    this.behaviour();
    return Promise.resolve(this.result);
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  reap(sessionId: string): Promise<void> {
    this.reaps.push(sessionId);
    return Promise.resolve();
  }

  headSha(): Promise<string | null> {
    return Promise.resolve('sha');
  }
}

/** Answers the one `git diff` the pass runs; records what it was asked. */
class MockExec implements SessionExecutor {
  readonly specs: ExecSpec[] = [];
  output: ExecOutput = { exitCode: 0, stdout: DIFF, stderr: '', timedOut: false };
  failure: Error | null = null;

  runExec(_container: string, spec: ExecSpec): Promise<ExecOutput> {
    this.specs.push(spec);
    if (this.failure !== null) return Promise.reject(this.failure);
    return Promise.resolve(this.output);
  }
}

describe('the description pass', () => {
  let config: Config;
  let dataDir: string;
  let db: Database;
  let session: Session;
  let stories: Story[];
  let runner: MockRunner;
  let exec: MockExec;
  let started: string[];
  let seq = 0;

  const containers: SessionContainers = {
    start: (target) => {
      started.push(target.id);
      return Promise.resolve({
        id: `container-${target.id.slice(0, 8)}`,
        name: 'chief-web-session',
        running: true,
        state: 'running',
      });
    },
    remove: () => Promise.resolve(),
  };

  const service = (): DescriptionService =>
    new DescriptionService(config, db, containers, exec, runner);

  const descriptionFile = (): string =>
    path.join(sessionWorkspaceDir(config, session.id), path.basename(CONTAINER_DESCRIPTION_PATH));

  /** Leaves the markdown where the container's volume would leave it. */
  const writeDescription = (raw: string): void => {
    fs.mkdirSync(path.dirname(descriptionFile()), { recursive: true });
    fs.writeFileSync(descriptionFile(), raw);
  };

  /** What the agent writes while it runs; the file appears mid-pass. */
  const agentWrites = (raw: string): void => {
    runner.behaviour = () => { writeDescription(raw); };
  };

  before(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-web-description-'));
    config = loadConfig({ DATA_DIR: dataDir });
    db = openDatabase(IN_MEMORY);
  });

  after(() => {
    closeDatabase(db);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    seq += 1;
    const repository = createRepository(db, {
      name: `leo-${String(seq)}`,
      sshUrl: 'git@github.com:VincentBean/leo.git',
      githubSlug: 'VincentBean/leo',
      defaultBaseBranch: 'develop',
    });
    session = createSession(db, {
      repositoryId: repository.id,
      name: `descriptions-${String(seq)}`,
      baseBranch: 'develop',
      prTargetBranch: 'develop',
      status: 'finished',
    });
    syncStories(db, session.id, [
      { storyId: 'US-001', title: 'Description generator module', priority: 1, status: 'done' },
      { storyId: 'US-002', title: 'Insert it into the body', priority: 2, status: 'todo' },
    ]);
    stories = listStories(db, session.id);
    runner = new MockRunner();
    exec = new MockExec();
    started = [];
  });

  it('runs one agent in the session\'s container and returns its markdown', async () => {
    agentWrites(DESCRIPTION);

    const result = await service().describe(session, stories);

    assert.equal(result.ok, true);
    assert.equal(result.code, 'ok');
    assert.equal(result.description, DESCRIPTION);
    assert.deepEqual(started, [session.id]);
    assert.equal(runner.invocations.length, 1);
    assert.equal(runner.invocations[0]?.containerId, `container-${session.id.slice(0, 8)}`);
    // Its own pid-file slot, so it never overwrites a build's or the review's.
    assert.equal(runner.invocations[0]?.iteration, DESCRIPTION_ITERATION);
  });

  it('builds the prompt from the diff, the session name and the finished stories', async () => {
    agentWrites(DESCRIPTION);

    await service().describe(session, stories);
    const prompt = runner.invocations[0]?.prompt ?? '';

    assert.ok(prompt.includes('+const answer = 42;'), 'the diff is in the prompt');
    assert.ok(prompt.includes(session.name), 'the session name is in the prompt');
    assert.ok(prompt.includes('- Description generator module'), 'the done story is context');
    // An outstanding story was not built, so it is not described as if it was.
    assert.ok(!prompt.includes('Insert it into the body'));
    assert.ok(prompt.includes('BEGIN UNTRUSTED BRANCH DIFF'), 'the diff is fenced');
  });

  it('takes the diff from the branch against its pull request target', async () => {
    agentWrites(DESCRIPTION);

    await service().describe(session, stories);

    assert.equal(exec.specs.length, 1);
    assert.ok(exec.specs[0]?.env?.includes('CHIEF_TARGET_BRANCH=develop'));
    assert.ok(exec.specs[0]?.env?.includes(`CHIEF_FEATURE_BRANCH=${session.featureBranch}`));
  });

  it('gives the agent no more than the description timeout, whatever the build gets', async () => {
    agentWrites(DESCRIPTION);

    await service().describe(session, stories);

    const timeoutMs = runner.invocations[0]?.timeoutMs ?? 0;
    assert.ok(timeoutMs > 0 && timeoutMs <= MAX_DESCRIPTION_TIMEOUT_MS);
  });

  it('fails when the agent wrote nothing at all', async () => {
    const result = await service().describe(session, stories);

    assert.equal(result.ok, false);
    assert.equal(result.code, 'empty_description');
    assert.equal(result.description, null);
  });

  it('fails when the agent wrote only whitespace', async () => {
    agentWrites('   \n\n\t\n');

    const result = await service().describe(session, stories);

    assert.equal(result.ok, false);
    assert.equal(result.code, 'empty_description');
    assert.equal(result.description, null);
  });

  it('falls back to what the agent printed when it wrote no file', async () => {
    runner.result = {
      exitCode: 0,
      output: `[claude] started with sonnet in /workspace\n${DESCRIPTION}\n[claude] finished (2s)\n`,
      timedOut: false,
    };

    const result = await service().describe(session, stories);

    assert.equal(result.ok, true);
    assert.equal(result.description, DESCRIPTION);
  });

  it('never reuses the description of an earlier delivery', async () => {
    writeDescription('### What was made\n\nThe branch as it was three commits ago.');
    runner.result = { exitCode: 1, output: 'boom', timedOut: false };

    const result = await service().describe(session, stories);

    assert.equal(result.ok, false);
    assert.equal(result.code, 'agent_failed');
    assert.equal(result.description, null);
    assert.ok(!fs.existsSync(descriptionFile()));
  });

  it('reaps the agent it cut short, and says it ran out of time', async () => {
    runner.result = { exitCode: null, output: 'half a sentence', timedOut: true };

    const result = await service().describe(session, stories);

    assert.equal(result.code, 'agent_timed_out');
    assert.deepEqual(runner.reaps, [session.id]);
  });

  it('reports a usage limit as its own reason, so a caller can hold instead of retry', async () => {
    runner.result = {
      exitCode: 1,
      output: 'Claude AI usage limit reached|1758790800',
      timedOut: false,
    };

    const result = await service().describe(session, stories);

    assert.equal(result.code, 'usage_limit');
    assert.deepEqual(runner.reaps, [session.id]);
  });

  it('skips the agent entirely when git could not produce a diff', async () => {
    exec.output = { exitCode: 128, stdout: '', stderr: 'unknown revision', timedOut: false };

    const result = await service().describe(session, stories);

    assert.equal(result.ok, false);
    assert.equal(result.code, 'diff_unavailable');
    assert.match(result.message, /unknown revision/);
    assert.equal(runner.invocations.length, 0);
  });

  it('skips the agent when the branch changed nothing', async () => {
    exec.output = { exitCode: 0, stdout: '\n', stderr: '', timedOut: false };

    const result = await service().describe(session, stories);

    assert.equal(result.code, 'diff_unavailable');
    assert.equal(runner.invocations.length, 0);
  });

  it('never throws when the container cannot be reached', async () => {
    exec.failure = new Error('connect ENOENT /var/run/docker.sock');

    const result = await service().describe(session, stories);

    assert.equal(result.ok, false);
    assert.equal(result.code, 'diff_unavailable');
    assert.match(result.message, /ENOENT/);
  });
});

describe('the story titles handed to the agent', () => {
  const story = (storyId: string, title: string, priority: number, status: 'done' | 'todo'): Story =>
    ({
      id: priority,
      sessionId: 's',
      storyId,
      title,
      priority,
      status,
      commitSha: null,
      createdAt: '',
      updatedAt: '',
    }) as Story;

  it('are the finished ones, in priority order', () => {
    assert.deepEqual(
      doneStoryTitles([
        story('US-002', 'Second', 2, 'done'),
        story('US-003', 'Unfinished', 3, 'todo'),
        story('US-001', 'First', 1, 'done'),
      ]),
      ['First', 'Second'],
    );
  });
});
