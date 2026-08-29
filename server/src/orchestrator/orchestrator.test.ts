import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type Config, loadConfig } from '../config.js';
import {
  createRepository,
  createSession,
  type Database,
  getSession,
  IN_MEMORY,
  openDatabase,
  type Session,
  type SessionStatus,
  updateSession,
} from '../db/index.js';
import { FakeDockerDaemon } from '../docker/fake-daemon.js';
import {
  type ContainerDetails,
  type ContainerSpec,
  type ContainerSummary,
  DockerApi,
  DockerApiError,
  type ListContainersOptions,
  type VolumeDetails,
} from '../docker/index.js';
import { RUNNER_CLAUDE_DIR, RUNNER_SSH_KEY_PATH, RUNNER_WORKSPACE_DIR } from '../runner/index.js';
import { writePrivateKey } from '../ssh/index.js';
import {
  CONTAINER_LOST_ERROR,
  HostPaths,
  planReconciliation,
  SESSION_LABEL,
  sessionContainerName,
  sessionContainerSpec,
  type SessionDocker,
  sessionKeyPath,
  sessionLabels,
  SessionOrchestrator,
  sessionWorkspaceDir,
} from './index.js';

const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----';

/**
 * An in-memory Docker daemon good enough for reconciliation: it answers label
 * filters the way the real one does and records every call.
 */
class MockDocker implements SessionDocker {
  readonly containers: ContainerSummary[] = [];
  readonly removed: string[] = [];
  readonly started: string[] = [];
  readonly stopped: string[] = [];
  readonly created: { name: string; spec: ContainerSpec }[] = [];
  readonly volumes = new Map<string, string>();
  /** Set to make every call fail, as an unreachable daemon would. */
  failure: Error | null = null;
  private next = 1;

  add(labels: Record<string, string>, state = 'running'): ContainerSummary {
    const container: ContainerSummary = {
      id: `mock-${this.next}`,
      name: `mock-container-${this.next++}`,
      image: 'chief-web-runner:latest',
      state,
      status: state === 'running' ? 'Up 1 minute' : 'Exited (137) 1 minute ago',
      labels,
    };
    this.containers.push(container);
    return container;
  }

  listContainers(options: ListContainersOptions = {}): Promise<ContainerSummary[]> {
    if (this.failure !== null) return Promise.reject(this.failure);
    const filters = options.labels ?? [];
    return Promise.resolve(
      this.containers
        .filter((container) => options.all === true || container.state === 'running')
        .filter((container) => filters.every((filter) => matchesLabel(container.labels, filter))),
    );
  }

  inspectContainer(id: string): Promise<ContainerDetails> {
    const container = this.containers.find((candidate) => candidate.id === id);
    if (container === undefined) return Promise.reject(new DockerApiError(404, 'No such container'));
    return Promise.resolve({
      id: container.id,
      name: container.name,
      image: container.image,
      running: container.state === 'running',
      state: container.state,
      exitCode: container.state === 'running' ? null : 137,
      labels: container.labels,
    });
  }

  createContainer(name: string, spec: ContainerSpec): Promise<string> {
    this.created.push({ name, spec });
    const container = this.add({ ...spec.labels }, 'created');
    this.containers[this.containers.indexOf(container)] = { ...container, name };
    return Promise.resolve(container.id);
  }

  startContainer(id: string): Promise<void> {
    this.started.push(id);
    const index = this.containers.findIndex((candidate) => candidate.id === id);
    const container = this.containers[index];
    if (container !== undefined) this.containers[index] = { ...container, state: 'running' };
    return Promise.resolve();
  }

  stopContainer(id: string): Promise<void> {
    this.stopped.push(id);
    const index = this.containers.findIndex((candidate) => candidate.id === id);
    const container = this.containers[index];
    if (container !== undefined) this.containers[index] = { ...container, state: 'exited' };
    return Promise.resolve();
  }

  removeContainer(id: string): Promise<void> {
    this.removed.push(id);
    const index = this.containers.findIndex(
      (candidate) => candidate.id === id || candidate.name === id,
    );
    if (index === -1) return Promise.reject(new DockerApiError(404, 'No such container'));
    this.containers.splice(index, 1);
    return Promise.resolve();
  }

  inspectVolume(name: string): Promise<VolumeDetails> {
    const mountpoint = this.volumes.get(name);
    if (mountpoint === undefined) return Promise.reject(new DockerApiError(404, 'No such volume'));
    return Promise.resolve({ name, mountpoint });
  }
}

function matchesLabel(labels: Readonly<Record<string, string>>, filter: string): boolean {
  const separator = filter.indexOf('=');
  if (separator === -1) return filter in labels;
  return labels[filter.slice(0, separator)] === filter.slice(separator + 1);
}

interface Fixture {
  readonly config: Config;
  readonly db: Database;
  readonly dataDir: string;
  session(status?: SessionStatus, name?: string): Session;
}

/** Everything `fixture()` created, torn down once the whole file is done. */
const fixtures: Fixture[] = [];

after(() => {
  for (const created of fixtures) {
    created.db.close();
    fs.rmSync(created.dataDir, { recursive: true, force: true });
  }
});

function fixture(env: Record<string, string> = {}): Fixture {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'chief-orch-'));
  const config = loadConfig({ DATA_DIR: dataDir, ...env });
  const db = openDatabase(IN_MEMORY);
  const repository = createRepository(db, {
    name: 'demo',
    sshUrl: 'git@github.com:acme/demo.git',
    githubSlug: 'acme/demo',
  });
  let counter = 0;
  const created: Fixture = {
    config,
    db,
    dataDir,
    session(status: SessionStatus = 'pending', name = `feature-${++counter}`): Session {
      return createSession(db, {
        repositoryId: repository.id,
        name,
        baseBranch: 'main',
        prTargetBranch: 'main',
        status,
      });
    },
  };
  fixtures.push(created);
  return created;
}

describe('session container spec', () => {
  it('labels the container with the session id and mounts the three sources', () => {
    const spec = sessionContainerSpec({
      session: { id: 'session-1', name: 'add-login', repositoryId: 'repo-1' },
      image: 'chief-web-runner:latest',
      identity: { name: 'chief-web', email: 'chief-web@localhost' },
      mounts: {
        claudeAuth: 'chief-web-claude-auth',
        workspaceDir: '/host/workspaces/session-1',
        sshKeyPath: '/host/ssh-keys/sessions/session-1.key',
      },
    });

    assert.equal(spec.labels?.[SESSION_LABEL], 'session-1');
    assert.equal(spec.workingDir, RUNNER_WORKSPACE_DIR);
    assert.deepEqual(spec.binds, [
      `chief-web-claude-auth:${RUNNER_CLAUDE_DIR}`,
      `/host/workspaces/session-1:${RUNNER_WORKSPACE_DIR}`,
      `/host/ssh-keys/sessions/session-1.key:${RUNNER_SSH_KEY_PATH}:ro`,
    ]);
    // The credentials volume is read-write; only the key is read-only.
    assert.ok(!spec.binds?.[0]?.endsWith(':ro'));
    assert.ok(!spec.binds?.[1]?.endsWith(':ro'));
    assert.ok(spec.env?.includes('CHIEF_SESSION_ID=session-1'));
    assert.ok(spec.env?.includes('CHIEF_GIT_AUTHOR_NAME=chief-web'));
  });

  it('names containers uniquely per session', () => {
    const name = sessionContainerName({ id: 'abcdef0123456789', name: 'add-login' });
    assert.equal(name, 'chief-web-add-login-abcdef01');
  });
});

describe('reconciliation plan', () => {
  const session = (over: Partial<Session>): Session =>
    ({
      id: 's1',
      repositoryId: 'r1',
      name: 'one',
      status: 'pending',
      baseBranch: 'main',
      featureBranch: 'chief/one',
      prTargetBranch: 'main',
      scheduledStartAt: null,
      queuedAt: null,
      containerId: null,
      prUrl: null,
      lastError: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...over,
    }) as Session;

  const container = (over: Partial<ContainerSummary>): ContainerSummary => ({
    id: 'c1',
    name: 'chief-web-one-s1',
    image: 'chief-web-runner:latest',
    state: 'running',
    status: 'Up 1 minute',
    labels: { [SESSION_LABEL]: 's1' },
    ...over,
  });

  it('ignores containers that are not session containers', () => {
    const plan = planReconciliation([], [container({ labels: {} })]);
    assert.deepEqual(plan.remove, []);
  });

  it('removes containers of sessions that no longer exist', () => {
    const plan = planReconciliation([], [container({})]);
    assert.equal(plan.remove.length, 1);
    assert.equal(plan.remove[0]?.containerId, 'c1');
    assert.equal(plan.remove[0]?.sessionId, null);
    assert.match(plan.remove[0]?.reason ?? '', /no longer exists/);
  });

  it('removes containers of finished and failed sessions', () => {
    for (const status of ['finished', 'failed'] as const) {
      const plan = planReconciliation([session({ status })], [container({})]);
      assert.equal(plan.remove.length, 1, status);
      assert.match(plan.remove[0]?.reason ?? '', new RegExp(status));
    }
  });

  it('marks a building session whose container is gone as failed', () => {
    const plan = planReconciliation([session({ status: 'building', containerId: 'c1' })], []);
    assert.deepEqual(plan.correct, [
      {
        sessionId: 's1',
        patch: { status: 'failed', containerId: null, lastError: CONTAINER_LOST_ERROR },
        reason: CONTAINER_LOST_ERROR,
      },
    ]);
  });

  it('treats a stopped container as gone and fails the building session', () => {
    const plan = planReconciliation(
      [session({ status: 'building', containerId: 'c1' })],
      [container({ state: 'exited' })],
    );
    assert.equal(plan.remove.length, 1);
    assert.equal(plan.correct[0]?.patch.status, 'failed');
    assert.equal(plan.correct[0]?.patch.lastError, CONTAINER_LOST_ERROR);
  });

  it('keeps a running container and adopts it onto the session', () => {
    const plan = planReconciliation([session({ status: 'building' })], [container({})]);
    assert.deepEqual(plan.remove, []);
    assert.deepEqual(plan.correct, [
      { sessionId: 's1', patch: { containerId: 'c1' }, reason: 'adopted its running container' },
    ]);
  });

  it('leaves a matching session and container completely alone', () => {
    const plan = planReconciliation([session({ status: 'building', containerId: 'c1' })], [
      container({}),
    ]);
    assert.deepEqual(plan, { remove: [], correct: [] });
  });

  it('clears a stale container id on a non-building session', () => {
    const plan = planReconciliation([session({ status: 'ready', containerId: 'c1' })], []);
    assert.deepEqual(plan.correct, [
      { sessionId: 's1', patch: { containerId: null }, reason: 'its container is gone' },
    ]);
  });

  it('removes duplicate containers, keeping the first running one', () => {
    const plan = planReconciliation(
      [session({ status: 'pending' })],
      [container({}), container({ id: 'c2', name: 'dupe' })],
    );
    assert.equal(plan.remove.length, 1);
    assert.equal(plan.remove[0]?.containerId, 'c2');
  });
});

describe('reconciliation against a mocked Docker client', () => {
  let mock: MockDocker;
  let env: Fixture;
  let orchestrator: SessionOrchestrator;

  beforeEach(() => {
    mock = new MockDocker();
    env = fixture();
    orchestrator = new SessionOrchestrator(env.config, env.db, mock);
  });

  it('removes orphans and fails building sessions that lost their container', async () => {
    const building = env.session('building');
    const finished = env.session('finished');
    const alive = env.session('pending');
    updateSession(env.db, building.id, { containerId: 'gone' });

    mock.add(sessionLabels(finished));
    mock.add({ [SESSION_LABEL]: 'deleted-session' });
    const kept = mock.add(sessionLabels(alive));

    const plan = await orchestrator.reconcile();

    assert.equal(plan.remove.length, 2);
    assert.equal(mock.removed.length, 2);
    assert.deepEqual(
      mock.containers.map((container) => container.id),
      [kept.id],
    );
    assert.equal(getSession(env.db, building.id)?.status, 'failed');
    assert.equal(getSession(env.db, building.id)?.lastError, CONTAINER_LOST_ERROR);
    assert.equal(getSession(env.db, building.id)?.containerId, null);
    assert.equal(getSession(env.db, alive.id)?.containerId, kept.id);
    assert.equal(getSession(env.db, finished.id)?.status, 'finished');
  });

  it('is a no-op when the daemon and the database already agree', async () => {
    const session = env.session('building');
    const container = mock.add(sessionLabels(session));
    updateSession(env.db, session.id, { containerId: container.id });

    const plan = await orchestrator.reconcile();

    assert.deepEqual(plan, { remove: [], correct: [] });
    assert.deepEqual(mock.removed, []);
    assert.equal(getSession(env.db, session.id)?.status, 'building');
  });

  it('never removes the workspace of a session it reconciles', async () => {
    const session = env.session('failed');
    mock.add(sessionLabels(session));
    const workspace = sessionWorkspaceDir(env.config, session.id);
    fs.mkdirSync(path.join(workspace, 'repo', '.chief'), { recursive: true });

    await orchestrator.reconcile();

    assert.ok(fs.existsSync(path.join(workspace, 'repo', '.chief')));
  });

  it('does not touch the database when Docker cannot be reached', async () => {
    const session = env.session('building');
    mock.failure = new Error('connect ENOENT /var/run/docker.sock');

    await assert.rejects(() => orchestrator.reconcile(), /ENOENT/);
    assert.equal(getSession(env.db, session.id)?.status, 'building');
  });
});

describe('session container lifecycle', () => {
  let daemon: FakeDockerDaemon;
  let env: Fixture;
  let orchestrator: SessionOrchestrator;

  before(async () => {
    daemon = await FakeDockerDaemon.start();
  });

  after(async () => {
    await daemon.close();
  });

  beforeEach(() => {
    env = fixture({ CLAUDE_AUTH_VOLUME: 'chief-web-claude-auth' });
    orchestrator = new SessionOrchestrator(env.config, env.db, new DockerApi(daemon.socketPath));
  });

  it('creates a labelled, running container with the three mounts', async () => {
    const session = env.session('pending', 'add-login');
    writePrivateKey(env.config, session.repositoryId, PRIVATE_KEY);

    const view = await orchestrator.start(session);

    assert.equal(view.running, true);
    assert.equal(view.name, sessionContainerName(session));
    assert.equal(getSession(env.db, session.id)?.containerId, view.id);

    const created = daemon.container(view.id);
    assert.equal(created?.labels[SESSION_LABEL], session.id);
    assert.equal(created?.workingDir, RUNNER_WORKSPACE_DIR);
    assert.deepEqual(created?.binds, [
      `chief-web-claude-auth:${RUNNER_CLAUDE_DIR}`,
      `${sessionWorkspaceDir(env.config, session.id)}:${RUNNER_WORKSPACE_DIR}`,
      `${sessionKeyPath(env.config, session.id)}:${RUNNER_SSH_KEY_PATH}:ro`,
    ]);
    // The workspace exists before the mount, so it is never created root-owned.
    assert.ok(fs.existsSync(sessionWorkspaceDir(env.config, session.id)));
    // The staged copy is the repository key, readable by the runner user.
    assert.equal(fs.readFileSync(sessionKeyPath(env.config, session.id), 'utf8').trim(), PRIVATE_KEY);
  });

  it('omits the key mount for a repository that has no deploy key', async () => {
    const session = env.session();
    const view = await orchestrator.start(session);
    assert.equal(daemon.container(view.id)?.binds.length, 2);
  });

  it('reuses the running container instead of starting a second one', async () => {
    const session = env.session();
    const first = await orchestrator.start(session);
    const second = await orchestrator.start(getSession(env.db, session.id) ?? session);

    assert.equal(second.id, first.id);
    assert.equal(daemon.listContainers().filter((c) => c.labels[SESSION_LABEL] === session.id).length, 1);
  });

  it('replaces a container that is no longer running', async () => {
    const session = env.session();
    const first = await orchestrator.start(session);
    await orchestrator.stop(session.id);
    assert.equal(daemon.container(first.id)?.running, false);

    const second = await orchestrator.start(getSession(env.db, session.id) ?? session);
    assert.notEqual(second.id, first.id);
    assert.equal(daemon.container(first.id), undefined);
  });

  it('inspects the container the session is running in', async () => {
    const session = env.session();
    const started = await orchestrator.start(session);
    assert.deepEqual(await orchestrator.inspect(session.id), {
      id: started.id,
      name: sessionContainerName(session),
      running: true,
      state: 'running',
    });
    assert.equal(await orchestrator.inspect('no-such-session'), null);
  });

  it('keeps the workspace when the container is stopped and removed', async () => {
    const session = env.session();
    const started = await orchestrator.start(session);

    const marker = path.join(sessionWorkspaceDir(env.config, session.id), 'repo', 'README.md');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, 'clone survives\n');

    await orchestrator.stop(session.id);
    assert.ok(fs.existsSync(marker), 'stopping must not touch the workspace');

    await orchestrator.remove(session.id);
    assert.equal(daemon.container(started.id), undefined);
    assert.equal(getSession(env.db, session.id)?.containerId, null);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'clone survives\n');
    // The mounted key copy is disposable and goes with the container.
    assert.equal(fs.existsSync(sessionKeyPath(env.config, session.id)), false);
  });

  it('removing a session with no container is not an error', async () => {
    const session = env.session();
    await orchestrator.remove(session.id);
    assert.equal(getSession(env.db, session.id)?.containerId, null);
  });
});

describe('host path translation', () => {
  it('passes paths through unchanged when there is no data volume', async () => {
    const paths = new HostPaths(
      { dataDir: '/data', dataVolume: '' },
      { inspectVolume: () => Promise.reject(new Error('must not be called')) },
    );
    assert.equal(await paths.translate('/data/workspaces/s1'), '/data/workspaces/s1');
  });

  it('rewrites a path inside the data volume onto its host mountpoint', async () => {
    let calls = 0;
    const paths = new HostPaths(
      { dataDir: '/data', dataVolume: 'chief-web-data' },
      {
        inspectVolume: (name) => {
          calls += 1;
          return Promise.resolve({ name, mountpoint: '/var/lib/docker/volumes/chief-web-data/_data' });
        },
      },
    );

    assert.equal(
      await paths.translate('/data/workspaces/s1'),
      '/var/lib/docker/volumes/chief-web-data/_data/workspaces/s1',
    );
    await paths.translate('/data/ssh-keys/sessions/s1.key');
    assert.equal(calls, 1, 'the mountpoint is looked up once');
  });

  it('refuses a path outside the data volume rather than mounting the wrong thing', async () => {
    const paths = new HostPaths(
      { dataDir: '/data', dataVolume: 'chief-web-data' },
      { inspectVolume: (name) => Promise.resolve({ name, mountpoint: '/m' }) },
    );
    await assert.rejects(() => paths.translate('/etc/passwd'), /not inside DATA_DIR/);
    await assert.rejects(() => paths.translate('/data'), /not inside DATA_DIR/);
  });
});
