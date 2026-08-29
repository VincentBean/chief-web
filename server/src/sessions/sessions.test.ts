import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { type Config, loadConfig } from '../config.js';
import {
  createRepository,
  createSession,
  type Database,
  getSession,
  IN_MEMORY,
  openDatabase,
  type Repository,
} from '../db/index.js';
import { type ExecScript, FakeDockerDaemon, type FakeExec } from '../docker/fake-daemon.js';
import { DockerApi, type ExecOutput, type ExecSpec } from '../docker/index.js';
import { sessionContainerName, SessionOrchestrator, sessionRepoDir } from '../orchestrator/index.js';
import { writePrivateKey } from '../ssh/index.js';
import {
  CONTAINER_REPO_DIR,
  runSessionSetup,
  type SessionExecutor,
  SessionError,
  sessionPrdFile,
  SessionService,
  setupExecSpec,
  setupScript,
  type SetupStep,
} from './index.js';

const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----';

const INPUT = {
  repoUrl: 'git@github.com:acme/demo.git',
  baseBranch: 'develop',
  featureBranch: 'chief/add-login',
  timeoutMs: 1000,
};

/** Records what each step was asked to run and answers with a canned result. */
class StubExecutor implements SessionExecutor {
  readonly calls: ExecSpec[] = [];

  constructor(private readonly answers: Partial<ExecOutput>[]) {}

  runExec(_container: string, spec: ExecSpec): Promise<ExecOutput> {
    this.calls.push(spec);
    const answer = this.answers[this.calls.length - 1] ?? {};
    return Promise.resolve({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      ...answer,
    });
  }

  /** Which of the three setup steps produced call `index`. */
  step(index: number): SetupStep | null {
    const script = this.calls[index]?.cmd[2];
    const steps: SetupStep[] = ['check-branch', 'clone', 'branch'];
    return steps.find((candidate) => setupScript(candidate) === script) ?? null;
  }
}

/** `git ls-remote --exit-code` reports "no such ref" with exit code 2. */
const NO_REMOTE_BRANCH = { exitCode: 2 };

describe('session setup commands', () => {
  it('passes every value through the environment, never into the script', () => {
    const spec = setupExecSpec(setupScript('clone'), {
      ...INPUT,
      // A URL that would be catastrophic if the shell ever expanded it.
      repoUrl: 'git@github.com:acme/demo.git; rm -rf /',
    });

    assert.deepEqual(spec.cmd.slice(0, 2), ['/bin/sh', '-c']);
    assert.equal(spec.cmd[2], setupScript('clone'));
    assert.ok(spec.env?.includes('CHIEF_REPO_URL=git@github.com:acme/demo.git; rm -rf /'));
    assert.ok(spec.env?.includes('CHIEF_FEATURE_BRANCH=chief/add-login'));
    assert.ok(spec.env?.includes(`CHIEF_REPO_DIR=${CONTAINER_REPO_DIR}`));
    // The script only ever references the variables.
    assert.ok(!setupScript('clone').includes('acme'));
  });

  it('clones the base branch and creates the feature branch', async () => {
    const exec = new StubExecutor([NO_REMOTE_BRANCH, {}, { stdout: 'chief/add-login\n' }]);

    const result = await runSessionSetup(exec, 'container-1', INPUT);

    assert.equal(result.ok, true);
    assert.equal(result.code, 'ok');
    assert.deepEqual([exec.step(0), exec.step(1), exec.step(2)], [
      'check-branch',
      'clone',
      'branch',
    ]);
  });

  it('refuses to reuse a feature branch that already exists on origin', async () => {
    const exec = new StubExecutor([{ exitCode: 0, stdout: 'abc123\trefs/heads/chief/add-login\n' }]);

    const result = await runSessionSetup(exec, 'container-1', INPUT);

    assert.equal(result.ok, false);
    assert.equal(result.code, 'feature_branch_exists');
    assert.match(result.message, /already exists on origin/);
    assert.match(result.message, /never reuses or force-pushes/);
    // Nothing was cloned: the check is the first thing that runs.
    assert.equal(exec.calls.length, 1);
  });

  it('surfaces git stderr when the clone fails', async () => {
    const stderr = "fatal: Remote branch nope not found in upstream origin\n";
    const exec = new StubExecutor([NO_REMOTE_BRANCH, { exitCode: 128, stderr }]);

    const result = await runSessionSetup(exec, 'container-1', INPUT);

    assert.equal(result.ok, false);
    assert.equal(result.code, 'clone_failed');
    assert.equal(result.stderr, stderr.trim());
    assert.equal(exec.calls.length, 2);
  });

  it('reports an unreachable remote from the branch check', async () => {
    const exec = new StubExecutor([
      { exitCode: 128, stderr: 'git@github.com: Permission denied (publickey).' },
    ]);

    const result = await runSessionSetup(exec, 'container-1', INPUT);

    assert.equal(result.code, 'remote_unreachable');
    assert.match(result.stderr, /Permission denied/);
  });

  it('reports which step ran out of time', async () => {
    const exec = new StubExecutor([NO_REMOTE_BRANCH, { timedOut: true, exitCode: null }]);

    const result = await runSessionSetup(exec, 'container-1', INPUT);

    assert.equal(result.code, 'setup_timed_out');
    assert.match(result.message, /"clone" step/);
  });
});

interface Fixture {
  readonly config: Config;
  readonly daemon: FakeDockerDaemon;
  readonly db: Database;
  readonly repository: Repository;
  readonly service: SessionService;
  /** Replaces the git commands the session container would run. */
  script(handler: (exec: FakeExec) => ExecScript): void;
}

const fixtures: { db: Database; daemon: FakeDockerDaemon; dataDir: string }[] = [];

after(async () => {
  for (const created of fixtures) {
    created.db.close();
    await created.daemon.close();
    fs.rmSync(created.dataDir, { recursive: true, force: true });
  }
});

/**
 * The real service, orchestrator and Docker client, talking to a fake daemon
 * over a real socket — only the git commands themselves are scripted.
 */
async function fixture(options: { withKey?: boolean } = {}): Promise<Fixture> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-sessions-'));
  const daemon = await FakeDockerDaemon.start();
  const config = loadConfig({ DATA_DIR: dataDir, DOCKER_SOCKET: daemon.socketPath });
  fs.mkdirSync(config.workspacesDir, { recursive: true });
  fs.mkdirSync(config.sshKeysDir, { recursive: true });

  const db = openDatabase(IN_MEMORY);
  const repository = createRepository(db, {
    name: 'demo',
    sshUrl: 'git@github.com:acme/demo.git',
    githubSlug: 'acme/demo',
    defaultBaseBranch: 'develop',
  });
  if (options.withKey !== false) writePrivateKey(config, repository.id, PRIVATE_KEY);

  const docker = new DockerApi(daemon.socketPath);
  const service = new SessionService(
    config,
    db,
    new SessionOrchestrator(config, db, docker),
    docker,
  );

  fixtures.push({ db, daemon, dataDir });
  return {
    config,
    daemon,
    db,
    repository,
    service,
    script(handler) {
      daemon.onExec = handler;
    },
  };
}

/** A container that clones: it creates the working copy the server looks for. */
function successfulGit(config: Config, sessionId: string): (exec: FakeExec) => ExecScript {
  return (exec) => {
    const script = exec.cmd[2] ?? '';
    if (script === setupScript('check-branch')) return { exitCode: 2 };
    if (script === setupScript('clone')) {
      fs.mkdirSync(path.join(sessionRepoDir(config, sessionId), '.git'), { recursive: true });
      return { stderr: "Cloning into '/workspace/repo'...\n" };
    }
    return { stdout: 'chief/add-login\n' };
  };
}

describe('session service', () => {
  it('creates a pending session, spawns its container and clones the repository', async () => {
    const f = await fixture();
    const created = createSessionRow(f);
    f.script(successfulGit(f.config, created));

    const { session, setup } = await f.service.setup(created);

    assert.equal(setup.ok, true);
    assert.equal(session.status, 'pending');
    assert.equal(session.featureBranch, 'chief/add-login');
    assert.equal(session.baseBranch, 'develop');
    assert.equal(session.lastError, null);
    assert.equal(session.cloned, true);

    // The container is labelled for this session and still running.
    const container = f.daemon
      .listContainers()
      .find((candidate) => candidate.name === sessionContainerName({ id: created, name: 'add-login' }));
    assert.ok(container, 'the session container should exist');
    assert.equal(container.running, true);
    assert.equal(session.containerId, container.id);
  });

  it('defaults the base branch to the repository and derives the feature branch', async () => {
    const f = await fixture();
    f.script(() => ({ exitCode: 2 }));

    const { session } = await f.service.create({
      repositoryId: f.repository.id,
      name: 'add_search',
      prTargetBranch: 'develop',
      scheduledStartAt: '2026-09-01T08:30:00.000Z',
    });

    assert.equal(session.baseBranch, 'develop');
    assert.equal(session.featureBranch, 'chief/add_search');
    assert.equal(session.prTargetBranch, 'develop');
    assert.equal(session.scheduledStartAt, '2026-09-01T08:30:00.000Z');
  });

  it('keeps the session pending with git stderr when the branch is taken', async () => {
    const f = await fixture();
    const created = createSessionRow(f);
    f.script((exec) =>
      (exec.cmd[2] ?? '') === setupScript('check-branch')
        ? { exitCode: 0, stdout: 'abc123\trefs/heads/chief/add-login\n' }
        : { exitCode: 1, stderr: 'should not run' },
    );

    const { session, setup } = await f.service.setup(created);

    assert.equal(setup.ok, false);
    assert.equal(setup.code, 'feature_branch_exists');
    assert.equal(session.status, 'pending');
    assert.equal(session.cloned, false);
    assert.match(session.lastError ?? '', /already exists on origin/);
    // The container of a failed setup is not left behind.
    assert.equal(f.daemon.listContainers().length, 0);
    assert.equal(getSession(f.db, created)?.containerId, null);
  });

  it('retries setup on the same session and succeeds the second time', async () => {
    const f = await fixture();
    const created = createSessionRow(f);
    f.script(() => ({ exitCode: 128, stderr: 'ssh: connect to host github.com port 22: timed out' }));

    const first = await f.service.setup(created);
    assert.equal(first.setup.ok, false);
    assert.match(first.session.lastError ?? '', /Could not read the branches/);

    f.script(successfulGit(f.config, created));
    const second = await f.service.setup(created);

    assert.equal(second.setup.ok, true);
    assert.equal(second.session.lastError, null);
    assert.equal(second.session.cloned, true);
  });

  it('runs one setup at a time for a session', async () => {
    const f = await fixture();
    const created = createSessionRow(f);
    f.script(successfulGit(f.config, created));

    const [a, b] = await Promise.all([f.service.setup(created), f.service.setup(created)]);

    assert.equal(a.setup.ok, true);
    assert.equal(b.setup.ok, true);
    // Three git commands, not six.
    assert.equal(f.daemon.execs().length, 3);
  });

  it('refuses a duplicate session name in the same repository', async () => {
    const f = await fixture();
    f.script(() => ({ exitCode: 2 }));
    await f.service.create({
      repositoryId: f.repository.id,
      name: 'add-login',
      prTargetBranch: 'main',
    });

    await assert.rejects(
      () =>
        f.service.create({
          repositoryId: f.repository.id,
          name: 'add-login',
          prTargetBranch: 'main',
        }),
      (error: unknown) =>
        error instanceof SessionError && error.status === 409 && error.code === 'session_name_taken',
    );
  });

  it('refuses a repository with no private key on the data volume', async () => {
    const f = await fixture({ withKey: false });

    await assert.rejects(
      () =>
        f.service.create({
          repositoryId: f.repository.id,
          name: 'add-login',
          prTargetBranch: 'main',
        }),
      (error: unknown) =>
        error instanceof SessionError && error.code === 'repository_key_missing',
    );
    assert.equal(f.service.list().length, 0);
  });

  it('refuses to set up a session that is no longer pending', async () => {
    const f = await fixture();
    const created = createSession(f.db, {
      repositoryId: f.repository.id,
      name: 'building-one',
      baseBranch: 'develop',
      prTargetBranch: 'main',
      status: 'building',
    }).id;

    await assert.rejects(
      () => f.service.setup(created),
      (error: unknown) =>
        error instanceof SessionError && error.status === 409 && error.code === 'session_not_pending',
    );
  });
});

const READY_PRD = `# PRD: Login

### US-001: Add the form
**Status:** todo
**Priority:** 1
**Description:** As a user, I want a login form.

- [ ] The form has an email and a password field

### US-002: Rate limit it
**Status:** done
**Priority:** 2

- [x] Five attempts per minute
`;

/** Writes a PRD where the session's clone keeps it, creating the directory. */
function writePrd(f: Fixture, sessionId: string, name: string, content: string): void {
  const file = sessionPrdFile(f.config, { id: sessionId, name });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('session readiness', () => {
  it('marks a pending session ready and syncs its stories', async () => {
    const f = await fixture();
    const created = createSessionRow(f);
    writePrd(f, created, 'add-login', READY_PRD);

    const result = f.service.markReady(created);

    assert.equal(result.ok, true);
    assert.equal(result.session.status, 'ready');
    assert.equal(getSession(f.db, created)?.status, 'ready');
    assert.deepEqual(
      result.stories.map((story) => [story.storyId, story.title, story.priority, story.status]),
      [
        ['US-001', 'Add the form', 1, 'todo'],
        ['US-002', 'Rate limit it', 2, 'done'],
      ],
    );
    assert.deepEqual(f.service.stories(created), [...result.stories]);
  });

  it('keeps a session pending and reports where the PRD is broken', async () => {
    const f = await fixture();
    const created = createSessionRow(f);
    writePrd(f, created, 'add-login', '### US-001: First\n**Status:** nearly\n\n- [ ] Ships\n');

    const result = f.service.markReady(created);

    assert.equal(result.ok, false);
    assert.equal(result.session.status, 'pending');
    assert.equal(getSession(f.db, created)?.status, 'pending');
    assert.equal(result.stories.length, 0);
    assert.equal(result.prd.errors.length, 1);
    assert.equal(result.prd.errors[0]?.line, 2);
    assert.match(result.prd.errors[0]?.message ?? '', /unknown status "nearly"/);
  });

  it('explains that there is no PRD to read yet', async () => {
    const f = await fixture();
    const created = createSessionRow(f);

    const result = f.service.markReady(created);

    assert.equal(result.ok, false);
    assert.equal(result.prd.exists, false);
    assert.equal(result.prd.path, '.chief/prds/add-login/prd.md');
    assert.match(result.prd.errors[0]?.message ?? '', /does not exist yet/);
  });

  it('refuses to mark a session that is not pending', async () => {
    const f = await fixture();
    const created = createSessionRow(f);
    writePrd(f, created, 'add-login', READY_PRD);
    f.service.markReady(created);

    assert.throws(
      () => f.service.markReady(created),
      (error: unknown) =>
        error instanceof SessionError && error.status === 409 && error.code === 'session_not_pending',
    );
  });

  it('goes back to planning and re-syncs the stories on the way in again', async () => {
    const f = await fixture();
    const created = createSessionRow(f);
    writePrd(f, created, 'add-login', READY_PRD);
    f.service.markReady(created);

    const back = f.service.backToPlanning(created);
    assert.equal(back.session.status, 'pending');
    // The last good list survives the trip; nothing is lost by re-planning.
    assert.equal(back.stories.length, 2);

    // The agent drops a story and renames another, then it is marked ready again.
    writePrd(
      f,
      created,
      'add-login',
      '### US-001: Add the login form\n**Status:** in-progress\n**Priority:** 1\n\n- [ ] Ships\n',
    );
    const again = f.service.markReady(created);

    assert.equal(again.ok, true);
    assert.deepEqual(
      again.stories.map((story) => [story.storyId, story.title, story.status]),
      [['US-001', 'Add the login form', 'in-progress']],
    );
  });

  it('refuses to send a pending session back to planning', async () => {
    const f = await fixture();
    const created = createSessionRow(f);

    assert.throws(
      () => f.service.backToPlanning(created),
      (error: unknown) =>
        error instanceof SessionError && error.status === 409 && error.code === 'session_not_ready',
    );
  });

  it('reports an unknown session as a 404', async () => {
    const f = await fixture();

    assert.throws(
      () => f.service.markReady('nope'),
      (error: unknown) => error instanceof SessionError && error.status === 404,
    );
    assert.throws(
      () => f.service.stories('nope'),
      (error: unknown) => error instanceof SessionError && error.status === 404,
    );
  });
});

function createSessionRow(f: Fixture, name = 'add-login'): string {
  return createSession(f.db, {
    repositoryId: f.repository.id,
    name,
    baseBranch: 'develop',
    prTargetBranch: 'main',
  }).id;
}
