import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { type Config, loadConfig } from '../config.js';
import {
  countSessionsByStatus,
  createRepository,
  createSession,
  type Database,
  failSession,
  getSession,
  IN_MEMORY,
  listQueuedSessions,
  listSessions,
  listStories,
  openDatabase,
  type Session,
  setSetting,
  setSettingNumber,
  type Story,
  syncStories,
  updateSession,
} from '../db/index.js';
import { DockerApi } from '../docker/index.js';
import { FakeDockerDaemon } from '../docker/fake-daemon.js';
import type { SessionContainerView } from '../orchestrator/index.js';
import { parsePrd, prdPathFor, type PrdStory, setStoryStatus } from '../prd/index.js';
import { planRetry } from '../recovery/index.js';
import { CONTAINER_REPO_DIR, type SessionContainers, storyInputOf } from '../sessions/index.js';
import {
  AGENT_SIGNALLED,
  agentPidFile,
  agentPidGlob,
  agentSignalSpec,
  wrapAgentCommand,
} from './agent.js';
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

  it('counts an iteration that ran out of time as a failed attempt (US-019)', () => {
    // Even a commit does not save it: the agent was cut off mid-story, so the
    // story is not finished and the attempt has to count against the limit.
    const change = classifyIteration('in-progress', 'in-progress', 'sha1', 'sha2', true);
    assert.equal(change.timedOut, true);
    assert.equal(change.stalled, true);
    assert.equal(change.commitSha, 'sha2');
  });

  it('does not punish a timed-out agent that had already finished its story', () => {
    assert.equal(classifyIteration('in-progress', 'done', 'sha1', 'sha2', true).stalled, false);
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

  it('passes the configured model, and no --model flag when there is none', () => {
    assert.deepEqual(agentCommand('p', 'sonnet').slice(0, 3), ['claude', '--model', 'sonnet']);
    // An absent flag is how the CLI's own default is selected — there is no
    // model name that means "default".
    assert.equal(agentCommand('p', null).includes('--model'), false);
    assert.equal(agentCommand('p').includes('--model'), false);
    // The prompt stays the single trailing argument either way.
    assert.equal(agentCommand('p', 'opus').at(-1), 'p');
  });

  it('records the agent pid before exec-ing it, under a file of its own', () => {
    const wrapped = wrapAgentCommand('abc', 3, ['claude', '-p', 'hi']);
    assert.deepEqual(wrapped.slice(0, 2), ['/bin/sh', '-c']);
    assert.match(wrapped[2] ?? '', /echo \$\$ > \/tmp\/\.chief-build\/abc-3\.pid/);
    assert.match(wrapped[2] ?? '', /exec "\$@"$/);
    // The prompt is positional, so the shell never re-parses it.
    assert.deepEqual(wrapped.slice(3), ['chief-build', 'claude', '-p', 'hi']);
    // One file per iteration: an agent that outlives its iteration stays
    // addressable instead of being overwritten by its successor's pid.
    assert.notEqual(agentPidFile('abc', 3), agentPidFile('abc', 4));
    assert.ok(agentPidGlob('abc').endsWith('/abc-*.pid'));
  });

  it('signals every recorded pid, its group and its children, and always exits 0', () => {
    const spec = agentSignalSpec('abc', 'TERM');
    const script = spec.cmd[2] ?? '';
    assert.ok(script.includes(`for file in ${agentPidGlob('abc')}; do`));
    assert.match(script, /kill -TERM -"\$pid"/);
    assert.match(script, /kill -TERM "\$pid"/);
    assert.match(script, /pkill -TERM -P "\$pid"/);
    assert.match(script, /exit 0$/);
  });

  it('only signals a pid /proc still shows running the agent', () => {
    const script = agentSignalSpec('abc', 'TERM').cmd[2] ?? '';
    // Pids are recycled: a leftover file whose number now belongs to something
    // else is deleted rather than shot at.
    assert.match(script, /grep -qa claude \/proc\/"\$pid"\/cmdline/);
    assert.match(script, /else rm -f "\$file"; fi/);
  });

  it('keeps the pid records until the pass that kills, then removes them', () => {
    // TERM leaves the file: the KILL pass after it has to have something left
    // to aim at.
    assert.equal((agentSignalSpec('abc', 'TERM').cmd[2] ?? '').includes('rm -f "$file"; else'), false);
    assert.ok((agentSignalSpec('abc', 'KILL', { remove: true }).cmd[2] ?? '').includes('rm -f "$file"; else'));
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
 * A fake world: the session's clone on disk, a container per session, and an
 * agent that does whatever the test tells it to.
 *
 * One repository with as many sessions as a test needs — US-018 is about
 * several of them at once, and two sessions of the *same* repository is the
 * case that has to keep its workspaces and branches apart.
 */
class World {
  readonly config: Config;
  readonly db: Database;
  readonly repositoryId: string;
  readonly session: Session;
  readonly containers: SessionContainers;
  readonly runner: MockRunner;
  /** Every container start, in order: `docker` as the loop used it. */
  readonly containerStarts: string[] = [];

  constructor(prd: string = PRD) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-build-'));
    tempDirs.push(dir);
    this.config = loadConfig({ DATA_DIR: dir });
    this.db = openDatabase(IN_MEMORY);

    this.repositoryId = createRepository(this.db, {
      name: 'demo',
      sshUrl: 'git@github.com:acme/demo.git',
      githubSlug: 'acme/demo',
    }).id;

    this.containers = {
      // A container of its own per session, named after it: what the tests
      // assert on when they check that two builds never share one.
      start: (session): Promise<SessionContainerView> => {
        this.containerStarts.push(session.id);
        return Promise.resolve({
          id: `container-${session.name}`,
          name: `chief-web-${session.name}`,
          running: true,
          state: 'running',
        });
      },
      remove: (): Promise<void> => Promise.resolve(),
    };
    this.runner = new MockRunner();
    this.session = this.addSession('add-login', prd);
  }

  /** Another ready session on the same repository, with its own clone. */
  addSession(name: string, prd: string = PRD): Session {
    const session =
      updateSession(
        this.db,
        createSession(this.db, {
          repositoryId: this.repositoryId,
          name,
          baseBranch: 'main',
          prTargetBranch: 'main',
        }).id,
        { status: 'ready' },
      ) ?? (undefined as never);

    const file = this.prdFileOf(session);
    fs.mkdirSync(path.join(this.repoDirOf(session), '.git'), { recursive: true });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, prd);
    this.sync(session);
    return session;
  }

  repoDirOf(session: Session = this.session): string {
    return path.join(this.config.workspacesDir, session.id, 'repo');
  }

  prdFileOf(session: Session = this.session): string {
    return path.join(this.repoDirOf(session), prdPathFor(session.name));
  }

  get repoDir(): string {
    return this.repoDirOf();
  }

  get prdFile(): string {
    return this.prdFileOf();
  }

  /** Brings the `stories` table in line with the file, as "Mark ready" does. */
  sync(session: Session = this.session): Story[] {
    const parsed = parsePrd(fs.readFileSync(this.prdFileOf(session), 'utf8'));
    return syncStories(this.db, session.id, parsed.stories.map(storyInputOf));
  }

  /** What the agent does when it finishes a story. */
  markDone(storyId: string, session: Session = this.session): void {
    const file = this.prdFileOf(session);
    const written = setStoryStatus(fs.readFileSync(file, 'utf8'), storyId, 'done');
    fs.writeFileSync(file, written.content);
  }

  status(session: Session = this.session): string {
    return getSession(this.db, session.id)?.status ?? 'gone';
  }

  error(session: Session = this.session): string | null {
    return getSession(this.db, session.id)?.lastError ?? null;
  }

  stories(session: Session = this.session): Story[] {
    return listStories(this.db, session.id);
  }
}

/** An {@link AgentRunner} whose behaviour each test scripts. */
class MockRunner implements AgentRunner {
  readonly invocations: AgentInvocation[] = [];
  readonly stops: string[] = [];
  readonly reaps: string[] = [];
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

  reap(sessionId: string): Promise<void> {
    this.reaps.push(sessionId);
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

  it('spends a retry on every iteration that runs out of time (US-019)', async () => {
    const world = new World();
    // The agent commits something every time and is then cut short: real work,
    // but never a finished story. Without the timeout counting as a failed
    // attempt this would run until the iteration cap instead of failing fast.
    world.runner.result = { exitCode: null, output: 'still thinking…', timedOut: true };
    world.runner.behaviour = (): void => world.runner.commit();

    const builds = serviceFor(world);
    await builds.start(world.session.id);
    await builds.whenIdle(world.session.id);

    assert.equal(world.runner.invocations.length, MAX_RETRIES + 1);
    assert.equal(world.status(), 'failed');
    assert.equal(getSession(world.db, world.session.id)?.failureStage, 'agent');
    assert.match(world.error() ?? '', /still running after its time limit/);
    assert.match(world.error() ?? '', /settings page/);
  });

  it('kills a timed-out agent before the next attempt starts (US-019)', async () => {
    const world = new World();
    world.runner.result = { exitCode: null, output: 'still thinking…', timedOut: true };
    // How many agents had been reaped by the time each iteration started. A
    // timeout only closes chief-web's end of the exec: the agent it gave up on
    // is still in the container, still holding the clone, and an attempt that
    // started next to it would be editing the same working tree as the agent
    // it was meant to replace.
    const reapedBefore: number[] = [];
    world.runner.behaviour = (): void => {
      reapedBefore.push(world.runner.reaps.length);
    };

    const builds = serviceFor(world);
    await builds.start(world.session.id);
    await builds.whenIdle(world.session.id);

    // One sweep before the run, then one for every abandoned iteration.
    assert.deepEqual(reapedBefore, [1, 2, 3]);
    assert.equal(world.runner.reaps.length, MAX_RETRIES + 2);
    assert.ok(world.runner.reaps.every((id) => id === world.session.id));
  });

  it('sweeps the container before the first iteration, and not after a clean one', async () => {
    const world = new World();
    world.runner.behaviour = (invocation): void => {
      const id = /"id": "(US-\d+)"/.exec(invocation.prompt)?.[1] ?? '';
      world.markDone(id);
      world.runner.commit();
    };

    const builds = serviceFor(world);
    await builds.start(world.session.id);
    await builds.whenIdle(world.session.id);

    assert.equal(world.status(), 'finished');
    // The sweep at the start is for an agent a restarted server left running;
    // an iteration that came back on its own is not reaped at all.
    assert.deepEqual(world.runner.reaps, [world.session.id]);
  });

  it('takes the agent timeout from the settings, not from the environment (US-019)', async () => {
    const world = new World();
    world.runner.result = { exitCode: 1, output: '', timedOut: false };

    // Nothing saved: the environment's default is what the iteration gets.
    await serviceFor(world).start(world.session.id);
    await serviceFor(world).whenIdle(world.session.id);
    assert.equal(world.runner.invocations[0]?.timeoutMs, world.config.buildIterationTimeoutMs);
    assert.equal(world.config.buildIterationTimeoutMs, 1_800_000);

    setSettingNumber(world.db, 'agent_timeout_minutes', 7);
    updateSession(world.db, world.session.id, { status: 'ready' });
    const builds = serviceFor(world);
    await builds.start(world.session.id);
    await builds.whenIdle(world.session.id);

    assert.equal(builds.status(world.session.id).agentTimeoutMs, 420_000);
    assert.equal(world.runner.invocations.at(-1)?.timeoutMs, 420_000);
  });

  it('takes the build model from the settings, and passes none when unset', async () => {
    const world = new World();
    world.runner.result = { exitCode: 1, output: '', timedOut: false };

    // Nothing saved: no `--model` reaches the CLI, which is how its own
    // default is selected.
    await serviceFor(world).start(world.session.id);
    await serviceFor(world).whenIdle(world.session.id);
    assert.equal(world.runner.invocations[0]?.model, null);

    setSetting(world.db, 'build_model', 'haiku');
    updateSession(world.db, world.session.id, { status: 'ready' });
    const builds = serviceFor(world);
    await builds.start(world.session.id);
    await builds.whenIdle(world.session.id);

    assert.equal(builds.status(world.session.id).buildModel, 'haiku');
    assert.equal(world.runner.invocations.at(-1)?.model, 'haiku');

    // A value the allowlist no longer knows must not be handed to the CLI:
    // the default always runs, an unrecognised name might not.
    setSetting(world.db, 'build_model', 'no-such-model');
    updateSession(world.db, world.session.id, { status: 'ready' });
    const after = serviceFor(world);
    await after.start(world.session.id);
    await after.whenIdle(world.session.id);
    assert.equal(world.runner.invocations.at(-1)?.model, null);
  });

  it('records the stage a failure happened at, and clears it on the retry (US-019)', async () => {
    const world = new World();
    fs.writeFileSync(world.prdFile, '# PRD: Demo\n\n### Not a story at all\n');

    const builds = serviceFor(world);
    await builds.start(world.session.id);
    await builds.whenIdle(world.session.id);

    const failed = getSession(world.db, world.session.id);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.failureStage, 'prd');
    assert.match(failed?.lastError ?? '', /can no longer be read/);
    assert.equal(builds.status(world.session.id).failureStage, 'prd');

    // A readable PRD again, and the retry starts the loop from the first story
    // that is not done — with the stage of the previous failure gone.
    fs.writeFileSync(world.prdFile, PRD);
    world.runner.behaviour = (invocation): void => {
      world.markDone(/"id": "(US-\d+)"/.exec(invocation.prompt)?.[1] ?? '');
      world.runner.commit();
    };
    await builds.start(world.session.id);
    await builds.whenIdle(world.session.id);

    const finished = getSession(world.db, world.session.id);
    assert.equal(finished?.failureStage, null);
    assert.equal(finished?.status, 'finished');
  });

  it('retries a lost container on a fresh one over the same workspace (US-019)', async () => {
    const world = new World();
    // The first story was built before the container died; reconciliation
    // (US-009) is what left the session in this state.
    world.markDone('US-002');
    world.sync();
    updateSession(world.db, world.session.id, { status: 'building', containerId: 'container-old' });
    failSession(world.db, world.session.id, 'container_lost', 'The session container was lost.');

    const failed = getSession(world.db, world.session.id) ?? (undefined as never);
    assert.equal(planRetry(failed, world.stories()).action, 'build');

    world.runner.behaviour = (invocation): void => {
      world.markDone(/"id": "(US-\d+)"/.exec(invocation.prompt)?.[1] ?? '');
      world.runner.commit();
    };
    const builds = serviceFor(world);
    await builds.start(world.session.id);
    await builds.whenIdle(world.session.id);

    // A container was started again — the workspace, and the clone in it, is
    // the same one the lost container had.
    assert.ok(world.containerStarts.length > 0);
    assert.ok(fs.existsSync(path.join(world.repoDir, '.git')));
    // Only the outstanding story was run: the one that was done stays done.
    assert.equal(world.runner.invocations.length, 1);
    assert.match(world.runner.invocations[0]?.prompt ?? '', /"id": "US-001"/);
    assert.equal(world.status(), 'finished');
    assert.equal(getSession(world.db, world.session.id)?.failureStage, null);
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

/** A promise a test resolves when it wants the agent to return. */
interface Gate {
  readonly promise: Promise<void>;
  release(): void;
}

function gate(): Gate {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = (): void => {
      resolve();
    };
  });
  return { promise, release: () => {release();} };
}

/** Waits for something another task has to do first; fails rather than hangs. */
async function until(what: string, condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting until ${what}`);
}

describe('concurrency and the build queue', () => {
  /**
   * Several sessions building at the same time, and a queue for the rest
   * (US-018).
   *
   * The cap is read from the settings row on every decision rather than
   * captured at construction, so raising it on the settings page while a build
   * runs is honoured by the next slot that frees.
   */
  class Fleet {
    readonly world: World;
    readonly builds: ReturnType<typeof serviceFor>;
    /** The sessions an iteration has been entered for, in order. */
    readonly entered: string[] = [];
    /** Which container each session's agent was run in. */
    readonly containers = new Map<string, string>();
    private readonly gates = new Map<string, Gate>();

    constructor(cap: number, names: readonly string[]) {
      this.world = new World();
      for (const name of names) this.world.addSession(name);
      setSettingNumber(this.world.db, 'max_concurrent_sessions', cap);

      this.world.runner.behaviour = async (invocation): Promise<void> => {
        this.entered.push(invocation.sessionId);
        this.containers.set(invocation.sessionId, invocation.containerId);
        await this.gate(invocation.sessionId).promise;
        // Whatever it was asked to do, the agent finished the whole PRD.
        const session = this.session(invocation.sessionId);
        this.world.markDone('US-002', session);
        this.world.markDone('US-001', session);
        this.world.runner.commit();
      };
      this.builds = serviceFor(this.world);
    }

    session(id: string): Session {
      const found = listSessions(this.world.db).find((candidate) => candidate.id === id);
      if (found === undefined) throw new Error(`no session ${id}`);
      return found;
    }

    named(name: string): Session {
      const found = listSessions(this.world.db).find((candidate) => candidate.name === name);
      if (found === undefined) throw new Error(`no session named ${name}`);
      return found;
    }

    /** The gate the agent of this session waits on; created on first use. */
    gate(sessionId: string): Gate {
      const existing = this.gates.get(sessionId);
      if (existing !== undefined) return existing;
      const created = gate();
      this.gates.set(sessionId, created);
      return created;
    }

    /** Lets a session's agent return, and waits for its loop to unwind. */
    async finish(session: Session): Promise<void> {
      this.gate(session.id).release();
      await this.builds.whenIdle(session.id);
    }

    building(): string[] {
      return listSessions(this.world.db, { status: 'building' }).map((s) => s.name);
    }

    queue(): string[] {
      return listQueuedSessions(this.world.db).map((s) => s.name);
    }
  }

  it('builds several sessions at once, each in its own container', async () => {
    const fleet = new Fleet(2, ['add-billing']);
    const login = fleet.named('add-login');
    const billing = fleet.named('add-billing');

    const first = await fleet.builds.start(login.id);
    const second = await fleet.builds.start(billing.id);

    assert.equal(first.status, 'building');
    assert.equal(second.status, 'building');
    assert.equal(second.activeBuilds, 2);
    assert.equal(second.maxConcurrentBuilds, 2);
    assert.deepEqual(fleet.building().sort(), ['add-billing', 'add-login']);

    // Both agents are inside an iteration at the same moment, in containers of
    // their own — the whole point of the story.
    await until('both agents are running', () => fleet.entered.length === 2);
    assert.equal(fleet.containers.get(login.id), 'container-add-login');
    assert.equal(fleet.containers.get(billing.id), 'container-add-billing');
    assert.equal(countSessionsByStatus(fleet.world.db, 'building'), 2);

    await fleet.finish(login);
    await fleet.finish(billing);
    assert.equal(fleet.world.status(login), 'finished');
    assert.equal(fleet.world.status(billing), 'finished');
  });

  it('queues a start beyond the cap instead of refusing it', async () => {
    const fleet = new Fleet(1, ['add-billing']);
    const login = fleet.named('add-login');
    const billing = fleet.named('add-billing');

    await fleet.builds.start(login.id);
    const queued = await fleet.builds.start(billing.id);

    // The cap comes from the settings row, not from the environment default.
    assert.equal(fleet.world.config.maxConcurrentSessions, 3);
    assert.equal(queued.maxConcurrentBuilds, 1);
    // Queued is a sub-state of ready, persisted as a timestamp.
    assert.equal(queued.status, 'ready');
    assert.equal(queued.queued, true);
    assert.equal(queued.queuePosition, 1);
    assert.notEqual(getSession(fleet.world.db, billing.id)?.queuedAt, null);
    // Nothing at all was spawned for it.
    assert.deepEqual(
      fleet.world.containerStarts.filter((id) => id === billing.id),
      [],
    );
    assert.equal(fleet.entered.includes(billing.id), false);

    await fleet.finish(login);
    await fleet.finish(billing);
  });

  it('starts the queue in FIFO order as slots free', async () => {
    const fleet = new Fleet(1, ['add-billing', 'add-search']);
    const login = fleet.named('add-login');
    const billing = fleet.named('add-billing');
    const search = fleet.named('add-search');

    await fleet.builds.start(login.id);
    await fleet.builds.start(billing.id);
    const third = await fleet.builds.start(search.id);
    assert.equal(third.queuePosition, 2);
    assert.deepEqual(fleet.queue(), ['add-billing', 'add-search']);

    // Finishing the running build hands its slot to the head of the queue,
    // with nobody having to ask.
    await fleet.finish(login);
    await until('the queued session started', () => fleet.building().length === 1);
    assert.deepEqual(fleet.building(), ['add-billing']);
    assert.deepEqual(fleet.queue(), ['add-search']);
    assert.equal(fleet.builds.status(search.id).queuePosition, 1);

    await fleet.finish(billing);
    await until('the last session started', () => fleet.building().length === 1);
    assert.deepEqual(fleet.building(), ['add-search']);

    await fleet.finish(search);
    assert.deepEqual(fleet.queue(), []);
    assert.deepEqual(fleet.entered, [login.id, billing.id, search.id]);
  });

  it('keeps a queued session in its place when start is pressed again', async () => {
    const fleet = new Fleet(1, ['add-billing', 'add-search']);
    const login = fleet.named('add-login');
    const billing = fleet.named('add-billing');
    const search = fleet.named('add-search');

    await fleet.builds.start(login.id);
    await fleet.builds.start(billing.id);
    await fleet.builds.start(search.id);
    const queuedAt = getSession(fleet.world.db, billing.id)?.queuedAt;

    const again = await fleet.builds.start(billing.id);
    assert.equal(again.queuePosition, 1);
    assert.equal(getSession(fleet.world.db, billing.id)?.queuedAt, queuedAt);
    assert.deepEqual(fleet.queue(), ['add-billing', 'add-search']);

    await fleet.finish(login);
    await fleet.finish(billing);
    await fleet.finish(search);
  });

  it('spends a schedule the queue absorbed, so it cannot fire twice (US-017)', async () => {
    const fleet = new Fleet(1, ['add-billing']);
    const login = fleet.named('add-login');
    const billing = fleet.named('add-billing');
    updateSession(fleet.world.db, billing.id, { scheduledStartAt: '2026-08-29T02:00:00.000Z' });

    await fleet.builds.start(login.id);
    const queued = await fleet.builds.start(billing.id);

    assert.equal(queued.queued, true);
    assert.equal(getSession(fleet.world.db, billing.id)?.scheduledStartAt, null);

    await fleet.finish(login);
    await fleet.finish(billing);
  });

  it('takes a session out of the queue on request', async () => {
    const fleet = new Fleet(1, ['add-billing']);
    const login = fleet.named('add-login');
    const billing = fleet.named('add-billing');

    await fleet.builds.start(login.id);
    await fleet.builds.start(billing.id);

    const left = fleet.builds.dequeue(billing.id);
    assert.equal(left.queued, false);
    assert.equal(left.queuePosition, null);
    assert.equal(left.status, 'ready');
    assert.deepEqual(fleet.queue(), []);

    // A session that is not waiting has nothing to give back.
    assert.throws(
      () => fleet.builds.dequeue(billing.id),
      (error: unknown) =>
        error instanceof BuildError &&
        error.status === 409 &&
        error.code === 'session_not_queued',
    );

    // And the slot goes to nobody: it was never its turn.
    await fleet.finish(login);
    await until('the finished build released its slot', () => fleet.building().length === 0);
    assert.equal(fleet.world.status(billing), 'ready');
    assert.equal(fleet.entered.includes(billing.id), false);
  });

  it('picks the queue up again after a restart, from queued_at alone', async () => {
    const fleet = new Fleet(1, ['add-billing']);
    const billing = fleet.named('add-billing');
    // What a restart leaves behind: a row waiting for a slot, and no loop
    // anywhere that could ever free one.
    updateSession(fleet.world.db, billing.id, { queuedAt: '2026-08-29T09:00:00.000Z' });

    await fleet.builds.pump();

    assert.deepEqual(fleet.building(), ['add-billing']);
    assert.equal(getSession(fleet.world.db, billing.id)?.queuedAt, null);
    await fleet.finish(billing);
    assert.equal(fleet.world.status(billing), 'finished');
  });

  it('drops a session that can no longer be built, and moves on to the next', async () => {
    const fleet = new Fleet(1, ['add-billing', 'add-search']);
    const login = fleet.named('add-login');
    const billing = fleet.named('add-billing');
    const search = fleet.named('add-search');

    await fleet.builds.start(login.id);
    await fleet.builds.start(billing.id);
    await fleet.builds.start(search.id);

    // It went back to planning while it waited: its turn comes, and it cannot
    // take it.
    updateSession(fleet.world.db, billing.id, { status: 'pending' });
    await fleet.finish(login);
    await until('the next session started', () => fleet.building().length === 1);

    assert.deepEqual(fleet.building(), ['add-search']);
    assert.equal(getSession(fleet.world.db, billing.id)?.queuedAt, null);
    assert.match(fleet.world.error(billing) ?? '', /Only a ready or failed session/);

    await fleet.finish(search);
  });

  it('never lets two sessions of one repository share a workspace or a branch', () => {
    const world = new World();
    const second = world.addSession('add-billing');

    assert.equal(world.session.repositoryId, second.repositoryId);
    assert.notEqual(world.repoDirOf(), world.repoDirOf(second));
    assert.ok(world.repoDirOf(second).includes(second.id));
    assert.notEqual(world.session.featureBranch, second.featureBranch);
    assert.equal(world.session.featureBranch, 'chief/add-login');
    assert.equal(second.featureBranch, 'chief/add-billing');
    // Two sessions of one repository cannot even be given the same name.
    assert.throws(
      () =>
        createSession(world.db, {
          repositoryId: world.repositoryId,
          name: 'add-login',
          baseBranch: 'main',
          prTargetBranch: 'main',
        }),
      /UNIQUE constraint failed/,
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
      iteration: 1,
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

  it('reaps with SIGTERM, a grace period, and then SIGKILL', async () => {
    // An agent was there and answered the sweep.
    daemon.onExec = () => ({ stdout: `${AGENT_SIGNALLED}\n`, exitCode: 0 });
    const before = daemon.execs().length;
    // The grace is a constructor argument so this does not wait ten seconds
    // for what it is asserting about.
    await createAgentRunner(docker, 5).reap('session-1', 'container-1');
    daemon.onExec = null;

    const sent = daemon.execs().slice(before).map((exec) => exec.cmd[2] ?? '');
    assert.equal(sent.length, 2);
    assert.match(sent[0] ?? '', /kill -TERM/);
    assert.match(sent[1] ?? '', /kill -KILL/);
    // Only the pass that kills forgets the pid; the one before it has to leave
    // the record behind or the kill has nothing to aim at.
    assert.equal((sent[0] ?? '').includes('rm -f "$file"; else'), false);
    assert.ok((sent[1] ?? '').includes('rm -f "$file"; else'));
  });

  it('stops at the sweep when there was no agent to signal', async () => {
    const before = daemon.execs().length;
    // The sweep printed nothing, so there is nothing to come back and kill —
    // and no reason to make "Stop build" sit through the grace period.
    await createAgentRunner(docker, 60_000).reap('session-1', 'container-1');

    const sent = daemon.execs().slice(before);
    assert.equal(sent.length, 1);
    assert.match(sent[0]?.cmd[2] ?? '', /kill -TERM/);
  });

  it('never lets a failing daemon throw out of a reap', async () => {
    // The loop calls this on a path that has already given up on the agent;
    // a container that has gone away has no agent left in it either.
    await createAgentRunner(docker, 5).reap('session-1', 'no-such-container');
  });
});
