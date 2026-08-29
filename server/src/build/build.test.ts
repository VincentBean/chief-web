import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { type Config, loadConfig } from '../config.js';
import {
  createRepository,
  createSession,
  type Database,
  getSession,
  IN_MEMORY,
  listStories,
  openDatabase,
  type Session,
  type Story,
  syncStories,
  updateSession,
} from '../db/index.js';
import { DockerApi } from '../docker/index.js';
import { FakeDockerDaemon } from '../docker/fake-daemon.js';
import type { SessionContainerView } from '../orchestrator/index.js';
import { parsePrd, prdPathFor, type PrdStory, setStoryStatus } from '../prd/index.js';
import { CONTAINER_REPO_DIR, type SessionContainers, storyInputOf } from '../sessions/index.js';
import { agentPidFile, agentSignalSpec, wrapAgentCommand } from './agent.js';
import {
  classifyIteration,
  iterationCap,
  MAX_RETRIES,
  MIN_ITERATIONS,
  remainingStories,
  selectNextStory,
} from './loop.js';
import { createBuildLogStore } from './log.js';
import { agentCommand, agentPrompt, storyContext } from './prompts.js';
import { type AgentInvocation, type AgentResult, type AgentRunner, createAgentRunner } from './runner.js';
import { type BuildCompletion, BuildError, createBuildService } from './service.js';

const PRD = `# PRD: Demo

## Introduction

A small feature used by the build loop tests.

### US-001: Second story
**Status:** todo
**Priority:** 2
**Description:** As a user, I want the second thing.

**Acceptance Criteria:**
- [ ] It works
- [ ] Typecheck passes

### US-002: First story
**Status:** todo
**Priority:** 1
**Description:** As a user, I want the first thing.

**Acceptance Criteria:**
- [ ] It also works
`;

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function story(input: Partial<Story> & Pick<Story, 'storyId' | 'priority' | 'status'>): Story {
  return {
    id: 0,
    sessionId: 's',
    title: input.storyId,
    commitSha: null,
    createdAt: '',
    updatedAt: '',
    ...input,
  };
}

describe('story selection', () => {
  it('picks the lowest priority number that is not done', () => {
    const next = selectNextStory([
      story({ storyId: 'US-001', priority: 3, status: 'todo' }),
      story({ storyId: 'US-002', priority: 1, status: 'done' }),
      story({ storyId: 'US-003', priority: 2, status: 'in-progress' }),
    ]);
    assert.equal(next?.storyId, 'US-003');
  });

  it('breaks a priority tie on the story id, never on row order', () => {
    const stories = [
      story({ storyId: 'US-009', priority: 1, status: 'todo' }),
      story({ storyId: 'US-004', priority: 1, status: 'todo' }),
    ];
    assert.equal(selectNextStory(stories)?.storyId, 'US-004');
    assert.equal(selectNextStory([...stories].reverse())?.storyId, 'US-004');
  });

  it('returns null when everything is done, and for an empty PRD', () => {
    assert.equal(selectNextStory([story({ storyId: 'US-001', priority: 1, status: 'done' })]), null);
    assert.equal(selectNextStory([]), null);
  });

  it('counts the outstanding stories', () => {
    assert.equal(
      remainingStories([
        story({ storyId: 'US-001', priority: 1, status: 'done' }),
        story({ storyId: 'US-002', priority: 2, status: 'in-progress' }),
        story({ storyId: 'US-003', priority: 3, status: 'todo' }),
      ]),
      2,
    );
  });
});

describe('iteration cap', () => {
  it('is the remaining stories plus 50%, rounded up', () => {
    assert.equal(iterationCap(20), 30);
    assert.equal(iterationCap(9), 14);
  });

  it('never drops below the minimum', () => {
    assert.equal(iterationCap(0), MIN_ITERATIONS);
    assert.equal(iterationCap(1), MIN_ITERATIONS);
    assert.equal(iterationCap(6), MIN_ITERATIONS);
    assert.equal(iterationCap(-3), MIN_ITERATIONS);
  });
});

describe('iteration classification', () => {
  it('is progress when the status moved on from what the loop wrote', () => {
    const change = classifyIteration('in-progress', 'done', 'sha1', 'sha1');
    assert.equal(change.statusChanged, true);
    assert.equal(change.committed, false);
    assert.equal(change.stalled, false);
  });

  it('is progress when a commit landed, even with no status change', () => {
    const change = classifyIteration('in-progress', 'in-progress', 'sha1', 'sha2');
    assert.equal(change.committed, true);
    assert.equal(change.commitSha, 'sha2');
    assert.equal(change.stalled, false);
  });

  it('is stalled when the loop only sees back its own write', () => {
    const change = classifyIteration('in-progress', 'in-progress', 'sha1', 'sha1');
    assert.equal(change.stalled, true);
    assert.equal(change.commitSha, null);
  });

  it('treats a story that vanished from the PRD as a change', () => {
    assert.equal(classifyIteration('in-progress', null, 'sha1', 'sha1').stalled, false);
  });
});

describe('the agent command', () => {
  it('runs claude headless with the prompt as a single argument', () => {
    const command = agentCommand('two words');
    assert.deepEqual(command, [
      'claude',
      '--dangerously-skip-permissions',
      // What makes the live log possible: the default format prints nothing
      // until the agent exits (US-016).
      '--output-format',
      'stream-json',
      '--verbose',
      '-p',
      'two words',
    ]);
  });

  it('records the agent pid before exec-ing it, so "stop" can signal it', () => {
    const wrapped = wrapAgentCommand('abc', ['claude', '-p', 'hi']);
    assert.deepEqual(wrapped.slice(0, 2), ['/bin/sh', '-c']);
    assert.match(wrapped[2] ?? '', /echo \$\$ > \/tmp\/\.chief-build\/abc\.pid/);
    assert.match(wrapped[2] ?? '', /exec "\$@"$/);
    // The prompt is positional, so the shell never re-parses it.
    assert.deepEqual(wrapped.slice(3), ['chief-build', 'claude', '-p', 'hi']);
  });

  it('signals the recorded pid, its group and its children, and always exits 0', () => {
    const spec = agentSignalSpec('abc', 'TERM');
    const script = spec.cmd[2] ?? '';
    assert.match(script, /kill -TERM -"\$pid"/);
    assert.match(script, /kill -TERM "\$pid"/);
    assert.match(script, /pkill -TERM -P "\$pid"/);
    assert.ok(script.includes(agentPidFile('abc')));
    assert.match(script, /exit 0$/);
  });
});

describe('the iteration prompt', () => {
  const parsed = parsePrd(PRD);
  const first = parsed.stories.find((candidate) => candidate.id === 'US-002') as PrdStory;

  it('inlines the story as chief does, with its criteria', () => {
    const context = JSON.parse(storyContext(first)) as Record<string, unknown>;
    assert.equal(context['id'], 'US-002');
    assert.equal(context['title'], 'First story');
    assert.equal(context['priority'], 1);
    assert.equal(context['passes'], false);
    assert.deepEqual(context['acceptanceCriteria'], ['It also works']);
  });

  it('carries the story, the PRD context and progress.md', () => {
    const prompt = agentPrompt({
      sessionName: 'add-login',
      story: first,
      prd: parsed,
      progress: '## Codebase Patterns\n- Use the logger.',
    });

    assert.ok(prompt.includes('# Chief Agent Instructions'));
    assert.ok(prompt.includes('"id": "US-002"'));
    assert.ok(prompt.includes('As a user, I want the first thing.'));
    assert.ok(prompt.includes('**Project:** Demo'));
    assert.ok(prompt.includes('A small feature used by the build loop tests.'));
    assert.ok(prompt.includes('- Use the logger.'));
    // The four things chief-web verifies afterwards.
    assert.ok(prompt.includes('feat: US-002 - First story'));
    assert.ok(prompt.includes('`done`'));
    assert.ok(prompt.includes('- [x]'));
    assert.ok(prompt.includes(`${CONTAINER_REPO_DIR}/.chief/prds/add-login/progress.md`));
    // No placeholder survives substitution.
    assert.ok(!prompt.includes('{{'));
  });

  it('tells the first iteration that there is no progress file yet', () => {
    const prompt = agentPrompt({ sessionName: 'add-login', story: first, prd: null, progress: null });
    assert.ok(prompt.includes('This file does not exist yet'));
  });
});

/**
 * A fake world: the session's clone on disk, a container that is always there,
 * and an agent that does whatever the test tells it to.
 */
class World {
  readonly config: Config;
  readonly db: Database;
  readonly session: Session;
  readonly containers: SessionContainers;
  readonly runner: MockRunner;

  constructor(prd: string = PRD) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-build-'));
    tempDirs.push(dir);
    this.config = loadConfig({ DATA_DIR: dir });
    this.db = openDatabase(IN_MEMORY);

    const repository = createRepository(this.db, {
      name: 'demo',
      sshUrl: 'git@github.com:acme/demo.git',
      githubSlug: 'acme/demo',
    });
    this.session =
      updateSession(
        this.db,
        createSession(this.db, {
          repositoryId: repository.id,
          name: 'add-login',
          baseBranch: 'main',
          prTargetBranch: 'main',
        }).id,
        { status: 'ready' },
      ) ?? (undefined as never);

    fs.mkdirSync(path.join(this.repoDir, '.git'), { recursive: true });
    fs.mkdirSync(path.dirname(this.prdFile), { recursive: true });
    fs.writeFileSync(this.prdFile, prd);
    this.sync();

    this.containers = {
      start: (): Promise<SessionContainerView> =>
        Promise.resolve({ id: 'container-1', name: 'chief-web-add-login', running: true, state: 'running' }),
      remove: (): Promise<void> => Promise.resolve(),
    };
    this.runner = new MockRunner();
  }

  get repoDir(): string {
    return path.join(this.config.workspacesDir, this.session.id, 'repo');
  }

  get prdFile(): string {
    return path.join(this.repoDir, prdPathFor(this.session.name));
  }

  /** Brings the `stories` table in line with the file, as "Mark ready" does. */
  sync(): Story[] {
    const parsed = parsePrd(fs.readFileSync(this.prdFile, 'utf8'));
    return syncStories(this.db, this.session.id, parsed.stories.map(storyInputOf));
  }

  /** What the agent does when it finishes a story. */
  markDone(storyId: string): void {
    const written = setStoryStatus(fs.readFileSync(this.prdFile, 'utf8'), storyId, 'done');
    fs.writeFileSync(this.prdFile, written.content);
  }

  status(): string {
    return getSession(this.db, this.session.id)?.status ?? 'gone';
  }

  error(): string | null {
    return getSession(this.db, this.session.id)?.lastError ?? null;
  }

  stories(): Story[] {
    return listStories(this.db, this.session.id);
  }
}

/** An {@link AgentRunner} whose behaviour each test scripts. */
class MockRunner implements AgentRunner {
  readonly invocations: AgentInvocation[] = [];
  readonly stops: string[] = [];
  head: string | null = 'sha-0';
  /** Called for each iteration; whatever it does *is* what the agent did. */
  behaviour: (invocation: AgentInvocation, index: number) => void | Promise<void> = () => {};
  result: AgentResult = { exitCode: 0, output: '', timedOut: false };

  async run(invocation: AgentInvocation): Promise<AgentResult> {
    this.invocations.push(invocation);
    await this.behaviour(invocation, this.invocations.length - 1);
    return this.result;
  }

  stop(sessionId: string): Promise<void> {
    this.stops.push(sessionId);
    return Promise.resolve();
  }

  headSha(): Promise<string | null> {
    return Promise.resolve(this.head);
  }

  /** A commit, as far as the loop can tell. */
  commit(): void {
    this.head = `sha-${String(this.invocations.length)}`;
  }
}

function serviceFor(world: World, completion?: BuildCompletion) {
  return createBuildService(
    world.config,
    world.db,
    world.containers,
    world.runner,
    completion,
    createBuildLogStore(world.config, world.db),
  );
}

describe('the build loop', () => {
  it('runs the stories in priority order and finishes', async () => {
    const world = new World();
    world.runner.behaviour = (invocation): void => {
      const id = /"id": "(US-\d+)"/.exec(invocation.prompt)?.[1] ?? '';
      world.markDone(id);
      world.runner.commit();
    };

    const builds = serviceFor(world);
    const started = await builds.start(world.session.id);
    assert.equal(started.status, 'building');
    assert.equal(started.maxIterations, MIN_ITERATIONS);
    await builds.whenIdle(world.session.id);

    assert.equal(world.status(), 'finished');
    assert.deepEqual(
      world.runner.invocations.map((invocation) => /"id": "(US-\d+)"/.exec(invocation.prompt)?.[1]),
      ['US-002', 'US-001'],
    );
    assert.deepEqual(
      world.stories().map((s) => [s.storyId, s.status, s.commitSha]),
      [
        ['US-002', 'done', 'sha-1'],
        ['US-001', 'done', 'sha-2'],
      ],
    );
  });

  it('spends the session schedule the moment the build starts (US-017)', async () => {
    const world = new World();
    updateSession(world.db, world.session.id, { scheduledStartAt: '2026-08-29T02:00:00.000Z' });

    const builds = serviceFor(world);
    await builds.start(world.session.id);

    // One-shot: whether the scheduler fired it or someone pressed the button
    // early, nothing is left to restart the session from later on.
    assert.equal(getSession(world.db, world.session.id)?.scheduledStartAt, null);
    await builds.whenIdle(world.session.id);
    assert.equal(getSession(world.db, world.session.id)?.scheduledStartAt, null);
  });

  it('marks the story in progress in prd.md before the agent runs', async () => {
    const world = new World();
    const seen: string[] = [];
    world.runner.behaviour = (): void => {
      seen.push(fs.readFileSync(world.prdFile, 'utf8'));
      world.markDone('US-002');
      world.markDone('US-001');
      world.runner.commit();
    };

    await serviceFor(world).start(world.session.id);
    await serviceFor(world).whenIdle(world.session.id);
    assert.match(seen[0] ?? '', /### US-002: First story\n\*\*Status:\*\* in-progress/);
    // Only the selected story is touched.
    assert.match(seen[0] ?? '', /### US-001: Second story\n\*\*Status:\*\* todo/);
  });

  it('records the commit SHA only when a new commit exists', async () => {
    const world = new World();
    world.runner.behaviour = (invocation, index): void => {
      const id = /"id": "(US-\d+)"/.exec(invocation.prompt)?.[1] ?? '';
      world.markDone(id);
      // The first story is finished without committing anything.
      if (index > 0) world.runner.commit();
    };

    const builds = serviceFor(world);
    await builds.start(world.session.id);
    await builds.whenIdle(world.session.id);

    const byId = new Map(world.stories().map((s) => [s.storyId, s.commitSha]));
    assert.equal(byId.get('US-002'), null);
    assert.equal(byId.get('US-001'), 'sha-2');
  });

  it('retries a fruitless iteration twice, then fails with the reason', async () => {
    const world = new World();
    world.runner.result = { exitCode: 1, output: 'claude: something went wrong', timedOut: false };

    const builds = serviceFor(world);
    await builds.start(world.session.id);
    await builds.whenIdle(world.session.id);

    assert.equal(world.runner.invocations.length, MAX_RETRIES + 1);
    assert.equal(world.status(), 'failed');
    const error = world.error() ?? '';
    assert.match(error, /US-002/);
    assert.match(error, /no commit was made/);
    assert.match(error, /exited with code 1/);
    assert.match(error, /something went wrong/);
  });

  it('forgets the retries as soon as an iteration achieves something', async () => {
    const world = new World();
    world.runner.behaviour = (invocation, index): void => {
      // Stall twice on the first story, then finish both.
      if (index < 2) return;
      world.markDone(/"id": "(US-\d+)"/.exec(invocation.prompt)?.[1] ?? '');
      world.runner.commit();
    };

    const builds = serviceFor(world);
    await builds.start(world.session.id);
    await builds.whenIdle(world.session.id);

    assert.equal(world.status(), 'finished');
    assert.equal(world.runner.invocations.length, 4);
  });

  it('aborts a loop that keeps working but never finishes anything', async () => {
    const world = new World();
    // A commit every time: never stalled, so only the cap can stop it.
    world.runner.behaviour = (): void => world.runner.commit();

    const builds = serviceFor(world);
    const started = await builds.start(world.session.id);
    await builds.whenIdle(world.session.id);

    assert.equal(world.runner.invocations.length, started.maxIterations);
    assert.equal(world.status(), 'failed');
    assert.match(world.error() ?? '', /after 10 iterations/);
    assert.match(world.error() ?? '', /not converging/);
  });

  it('scales the cap with the number of stories', () => {
    const many = ['# PRD: Many\n'];
    for (let index = 1; index <= 20; index += 1) {
      many.push(
        `### US-${String(index).padStart(3, '0')}: Story ${String(index)}\n` +
          `**Status:** todo\n**Priority:** ${String(index)}\n\n**Acceptance Criteria:**\n- [ ] Works\n`,
      );
    }
    const world = new World(many.join('\n'));
    assert.equal(world.stories().length, 20);
    assert.equal(serviceFor(world).status(world.session.id).maxIterations, 30);
  });

  it('stops the running agent and returns the session to ready', async () => {
    const world = new World();
    let release = (): void => {};
    const running = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = (): void => {};
    const inIteration = new Promise<void>((resolve) => {
      started = resolve;
    });
    world.runner.behaviour = async (): Promise<void> => {
      // The first story is "committed" before the agent is signalled, so the
      // test can assert that the work already done survives the stop.
      world.markDone('US-002');
      world.runner.commit();
      started();
      await running;
    };

    const builds = serviceFor(world);
    await builds.start(world.session.id);
    await inIteration;
    // A real SIGTERM ends the process; the mock's is releasing the promise.
    world.runner.stop = (sessionId: string): Promise<void> => {
      world.runner.stops.push(sessionId);
      release();
      return Promise.resolve();
    };

    const stopped = await builds.stop(world.session.id);
    assert.equal(stopped.status, 'ready');
    assert.equal(stopped.running, false);
    assert.deepEqual(world.runner.stops, [world.session.id]);
    assert.equal(world.status(), 'ready');
    assert.equal(world.runner.invocations.length, 1);
    // Progress already made is kept, commit SHA and all.
    const finished = world.stories().find((s) => s.storyId === 'US-002');
    assert.equal(finished?.status, 'done');
    assert.equal(finished?.commitSha, 'sha-1');
  });

  it('hands off to the completion step once every story is done', async () => {
    const world = new World();
    const handed: string[][] = [];
    world.runner.behaviour = (invocation): void => {
      world.markDone(/"id": "(US-\d+)"/.exec(invocation.prompt)?.[1] ?? '');
      world.runner.commit();
    };

    const builds = serviceFor(world, {
      push: (): Promise<void> => Promise.resolve(),
      complete: (_session, stories): Promise<void> => {
        handed.push(stories.map((s) => s.storyId));
        return Promise.resolve();
      },
    });
    await builds.start(world.session.id);
    await builds.whenIdle(world.session.id);

    assert.deepEqual(handed, [['US-002', 'US-001']]);
    // The default hand-off is what marks a session finished; a custom one owns
    // the transition itself, so the session is still building here.
    assert.equal(world.status(), 'building');
  });

  it('pushes after every completed story, and once more on completion', async () => {
    const world = new World();
    const events: string[] = [];
    world.runner.behaviour = (invocation): void => {
      world.markDone(/"id": "(US-\d+)"/.exec(invocation.prompt)?.[1] ?? '');
      world.runner.commit();
    };

    const builds = serviceFor(world, {
      push: (): Promise<void> => {
        events.push('push');
        return Promise.resolve();
      },
      complete: (): Promise<void> => {
        events.push('complete');
        return Promise.resolve();
      },
    });
    await builds.start(world.session.id);
    await builds.whenIdle(world.session.id);

    // Two stories, so two pushes — the remote is never more than one story
    // behind — and then the hand-off that pushes again and opens the PR.
    assert.deepEqual(events, ['push', 'push', 'complete']);
  });

  it('does not push an iteration that finished nothing', async () => {
    const world = new World();
    const events: string[] = [];
    // The agent commits but never marks the story done: a story is only pushed
    // when prd.md says it is finished.
    world.runner.behaviour = (): void => world.runner.commit();

    const builds = serviceFor(world, {
      push: (): Promise<void> => {
        events.push('push');
        return Promise.resolve();
      },
      complete: (): Promise<void> => Promise.resolve(),
    });
    await builds.start(world.session.id);
    await builds.whenIdle(world.session.id);

    assert.deepEqual(events, []);
  });

  it('fails when the agent leaves prd.md unparseable', async () => {
    const world = new World();
    world.runner.behaviour = (): void => {
      fs.writeFileSync(world.prdFile, '### US-002: First story\n**Status:** nonsense\n- [ ] x\n');
    };

    const builds = serviceFor(world);
    await builds.start(world.session.id);
    await builds.whenIdle(world.session.id);

    assert.equal(world.status(), 'failed');
    assert.match(world.error() ?? '', /can no longer be read/);
    assert.match(world.error() ?? '', /unknown status "nonsense"/);
  });

  it('refuses to start a session that is not ready', async () => {
    const world = new World();
    updateSession(world.db, world.session.id, { status: 'pending' });
    await assert.rejects(
      () => serviceFor(world).start(world.session.id),
      (error: unknown) =>
        error instanceof BuildError && error.status === 409 && error.code === 'session_not_ready',
    );
  });

  it('refuses to start a session whose stories are all done', async () => {
    const world = new World();
    world.markDone('US-001');
    world.markDone('US-002');
    world.sync();
    await assert.rejects(
      () => serviceFor(world).start(world.session.id),
      (error: unknown) => error instanceof BuildError && error.code === 'session_already_complete',
    );
  });

  it('refuses to stop a session that is not building', async () => {
    const world = new World();
    await assert.rejects(
      () => serviceFor(world).stop(world.session.id),
      (error: unknown) => error instanceof BuildError && error.code === 'session_not_building',
    );
  });

  it('returns a session left building by a restart to ready', async () => {
    const world = new World();
    updateSession(world.db, world.session.id, { status: 'building' });
    const view = await serviceFor(world).stop(world.session.id);
    assert.equal(view.status, 'ready');
  });

  it('starts a failed session again, resuming from the PRD', async () => {
    const world = new World();
    world.markDone('US-002');
    world.sync();
    updateSession(world.db, world.session.id, { status: 'failed', lastError: 'the agent stalled' });
    world.runner.behaviour = (invocation): void => {
      const id = /"id": "(US-\d+)"/.exec(invocation.prompt)?.[1] ?? '';
      world.markDone(id);
      world.runner.commit();
    };

    const service = serviceFor(world);
    await service.start(world.session.id);
    await service.whenIdle(world.session.id);

    // Only the outstanding story is run, and the recorded failure is cleared.
    assert.deepEqual(
      world.runner.invocations.map((invocation) => /"id": "(US-\d+)"/.exec(invocation.prompt)?.[1]),
      ['US-001'],
    );
    assert.equal(world.status(), 'finished');
    assert.equal(world.error(), null);
  });

  it('writes each iteration to the log file in the workspace', async () => {
    const world = new World();
    world.runner.behaviour = (invocation): void => {
      const id = /"id": "(US-\d+)"/.exec(invocation.prompt)?.[1] ?? '';
      invocation.onOutput?.(`working on ${id}\n`);
      world.markDone(id);
      world.runner.commit();
    };

    const service = serviceFor(world);
    await service.start(world.session.id);
    await service.whenIdle(world.session.id);

    const log = fs.readFileSync(
      path.join(world.repoDir, '.chief/prds/add-login/agent.log'),
      'utf8',
    );
    assert.match(log, /=== chief-web iteration 1 \| US-002 \| \S+ ===/);
    assert.ok(log.includes('working on US-002\n'));
    assert.match(log, /=== chief-web iteration 1 ended \| exit 0 \| \S+ ===/);
    assert.match(log, /=== chief-web iteration 2 \| US-001 \| \S+ ===/);
    assert.ok(log.includes('working on US-001\n'));
  });

  it('answers 404 for a session that does not exist', () => {
    const world = new World();
    assert.throws(
      () => serviceFor(world).status('nope'),
      (error: unknown) => error instanceof BuildError && error.status === 404,
    );
  });
});

describe('the container agent runner', () => {
  let daemon: FakeDockerDaemon;
  let docker: DockerApi;

  before(async () => {
    daemon = await FakeDockerDaemon.start();
    daemon.addContainer({ id: 'container-1', name: 'chief-web-add-login' });
    docker = new DockerApi(daemon.socketPath);
  });

  after(async () => {
    await daemon.close();
  });

  it("renders the agent's stream-json into the log as it arrives", async () => {
    daemon.onExec = () => ({
      stdout:
        `${JSON.stringify({ type: 'system', subtype: 'init', model: 'opus', cwd: CONTAINER_REPO_DIR })}\n` +
        `${JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] },
        })}\n` +
        `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 3 })}\n`,
      stderr: 'a warning from the image\n',
      exitCode: 0,
    });
    const streamed: string[] = [];

    const result = await createAgentRunner(docker).run({
      sessionId: 'session-1',
      containerId: 'container-1',
      prompt: 'do the thing',
      timeoutMs: 5000,
      onOutput: (text) => streamed.push(text),
    });

    const log = streamed.join('');
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    // stderr is passed through untouched; stdout is the rendered events.
    assert.ok(log.includes('a warning from the image\n'));
    assert.ok(log.includes(`[claude] started with opus in ${CONTAINER_REPO_DIR}\n`));
    assert.ok(log.includes('[tool] Bash: npm test\n'));
    assert.ok(log.includes('[claude] finished (3 turns)\n'));
    // What the session's error message would quote is what the log showed.
    assert.equal(result.output, log);

    const exec = daemon.execs().at(-1);
    assert.ok(exec);
    assert.equal(exec.cmd[3], 'chief-build');
    assert.ok(exec.cmd.includes('stream-json'));
    daemon.onExec = null;
  });
});
