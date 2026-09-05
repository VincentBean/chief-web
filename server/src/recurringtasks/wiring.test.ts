import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../app.js';
import { createAuthService } from '../auth/index.js';
import {
  type AgentInvocation,
  type AgentResult,
  type AgentRunner,
  createBuildLogStore,
  createBuildService,
} from '../build/index.js';
import { type Config, loadConfig } from '../config.js';
import {
  closeDatabase,
  createRecurringTask,
  createRepository,
  type Database,
  getRecurringTask,
  getSession,
  IN_MEMORY,
  latestRecurringTaskOccurrence,
  listSessions,
  openDatabase,
  type RecurringTask,
} from '../db/index.js';
import type { ExecOutput, ExecSpec } from '../docker/index.js';
import type { SessionContainerView } from '../orchestrator/index.js';
import { sessionRepoDir } from '../orchestrator/index.js';
import { parsePrd, prdPathFor, setStoryStatus } from '../prd/index.js';
import { writePrivateKey } from '../ssh/index.js';
import { GENERATED_STORY_ID } from './prd.js';

const PASSWORD = 'correct horse battery staple';
const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----';

/**
 * A recurring task, from due to settled, through `createApp` (US-004).
 *
 * Everything here is the real thing — the scheduler, the session service, the
 * generated PRD, the build loop and the occurrence history — except the
 * container, the git commands and the agent. What it proves is the part no
 * unit test can: that a row with a `next_run_at` in the past turns into a
 * finished session with nobody asking it to, over a wiring in which the
 * scheduler and the session service each need the other.
 */
describe('recurring tasks, end to end', () => {
  let config: Config;
  let dataDir: string;
  let db: Database;
  let server: http.Server;
  let task: RecurringTask;

  /** The clone a session container would leave behind. */
  const exec = {
    runExec(_container: string, spec: ExecSpec): Promise<ExecOutput> {
      const script = spec.cmd[2] ?? '';
      if (script.includes('ls-remote')) return answer({ exitCode: 2 });
      if (script.includes('git clone')) {
        for (const session of listSessions(db, {})) {
          fs.mkdirSync(path.join(sessionRepoDir(config, session.id), '.git'), { recursive: true });
        }
        return answer({ stderr: "Cloning into '/workspace/repo'...\n" });
      }
      return answer({ stdout: 'chief/rector\n' });
    },
  };

  /** An agent that does what the generated PRD's third criterion allows. */
  const agent: AgentRunner = {
    run: (invocation: AgentInvocation): Promise<AgentResult> => {
      const session = getSession(db, invocation.sessionId);
      assert.ok(session);
      const file = path.join(sessionRepoDir(config, session.id), prdPathFor(session.name));
      const prd = fs.readFileSync(file, 'utf8');
      // The prompt reached the agent through the PRD, quoted and intact.
      assert.match(prd, /> Run rector and fix what it reports\./);
      assert.match(invocation.prompt, /Run rector and fix what it reports\./);
      // Nothing to change: the story is marked done and no commit is made.
      fs.writeFileSync(file, setStoryStatus(prd, GENERATED_STORY_ID, 'done').content);
      return Promise.resolve({ exitCode: 0, output: '', timedOut: false });
    },
    stop: (): Promise<void> => Promise.resolve(),
    reap: (): Promise<void> => Promise.resolve(),
    headSha: (): Promise<string | null> => Promise.resolve(null),
  };

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-web-recurring-'));
    config = loadConfig({
      CHIEF_WEB_PASSWORD: PASSWORD,
      DATA_DIR: dataDir,
      SCHEDULER_INTERVAL_MS: '1000',
    });
    fs.mkdirSync(config.workspacesDir, { recursive: true });
    fs.mkdirSync(config.sshKeysDir, { recursive: true });

    db = openDatabase(IN_MEMORY);
    const repository = createRepository(db, {
      name: 'demo',
      sshUrl: 'git@github.com:acme/demo.git',
      githubSlug: 'acme/demo',
    });
    writePrivateKey(config, repository.id, PRIVATE_KEY);
    task = createRecurringTask(db, {
      repositoryId: repository.id,
      name: 'rector',
      prompt: 'Run rector and fix what it reports.',
      cronExpression: '0 3 * * *',
      baseBranch: 'main',
      prTarget: 'main',
      // Its moment passed while the stack was down; the catch-up owns it.
      nextRunAt: '2020-01-01T00:00:00.000Z',
    });

    const containers = {
      start: (): Promise<SessionContainerView> =>
        Promise.resolve({ id: 'container-1', name: 'chief-web-rector', running: true, state: 'running' }),
      remove: (): Promise<void> => Promise.resolve(),
    };
    const app = createApp(config, createAuthService(config, db), db, {
      orchestrator: containers,
      exec,
      builds: createBuildService(
        config,
        db,
        containers,
        agent,
        undefined,
        createBuildLogStore(config, db),
      ),
    });

    server = await new Promise<http.Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase(db);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('fires a task that came due while the stack was down, and runs it to the end', async () => {
    const run = await until(() => listSessions(db, {})[0] ?? null);

    assert.match(run.name, /^rector-\d{8}-\d{4}$/);
    assert.equal(run.featureBranch, `chief/${run.name}`);
    assert.equal(run.recurringTaskId, task.id);

    // The build loop took the generated PRD from `ready` to done on its own.
    const finished = await until(() => {
      const current = getSession(db, run.id);
      return current?.status === 'finished' ? current : null;
    });
    assert.equal(finished.prUrl, null);

    const prd = parsePrd(
      fs.readFileSync(path.join(sessionRepoDir(config, run.id), prdPathFor(run.name)), 'utf8'),
    );
    assert.equal(prd.stories.length, 1);
    assert.equal(prd.stories[0]?.status, 'done');
  });

  it('settles the occurrence, and the task, on the next tick', async () => {
    const settled = await until(() => {
      const occurrence = latestRecurringTaskOccurrence(db, task.id);
      return occurrence !== null && occurrence.outcome !== 'started' ? occurrence : null;
    });

    // Nothing was committed and no pull request was opened: a clean run.
    assert.equal(settled.outcome, 'clean');
    assert.equal(settled.sessionId, listSessions(db, {})[0]?.id);
    assert.equal(getRecurringTask(db, task.id)?.lastOutcome, 'clean');
  });

  it('spends the occurrence, so the task does not fire again', async () => {
    const next = getRecurringTask(db, task.id)?.nextRunAt;
    assert.ok(next);
    assert.ok(next > new Date().toISOString());

    // Two intervals is plenty: one occurrence, one run.
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    assert.equal(listSessions(db, {}).length, 1);
  });
});

function answer(output: Partial<ExecOutput>): Promise<ExecOutput> {
  return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false, ...output });
}

/** Polls `read` until it answers, which is how a tick is waited for. */
async function until<T>(read: () => T | null): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the scheduler never got there');
}
