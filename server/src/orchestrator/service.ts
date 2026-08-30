import type { Config } from '../config.js';
import {
  type Database,
  listSessions,
  type Session,
  updateSession,
} from '../db/index.js';
import {
  type ContainerDetails,
  type ContainerSpec,
  type ContainerSummary,
  DockerApi,
  DockerApiError,
  type ListContainersOptions,
  type VolumeDetails,
} from '../docker/index.js';
import { logger } from '../lib/logger.js';
import { claudeAuthSource } from '../runner/index.js';
import { readPrivateKey } from '../ssh/index.js';
import { getGitIdentity } from '../settings/index.js';
import {
  type PrRunIdentity,
  prRunContainerName,
  prRunContainerSpec,
  prRunLabelFilter,
  sessionContainerName,
  sessionContainerSpec,
  sessionLabelFilter,
} from './container.js';
import { HostPaths } from './host-paths.js';
import { planReconciliation, type ReconciliationPlan } from './reconcile.js';
import {
  ensureSessionWorkspace,
  removeSessionKey,
  sessionWorkspaceDir,
  stageSessionKey,
} from './workspace.js';

/**
 * The slice of the Docker client the orchestrator uses. Declaring it here is
 * what lets the reconciliation tests drive the whole service with a mock;
 * {@link DockerApi} satisfies it structurally.
 */
export interface SessionDocker {
  listContainers(options?: ListContainersOptions): Promise<ContainerSummary[]>;
  inspectContainer(id: string): Promise<ContainerDetails>;
  createContainer(name: string, spec: ContainerSpec): Promise<string>;
  startContainer(id: string): Promise<void>;
  stopContainer(id: string, timeoutSeconds?: number): Promise<void>;
  removeContainer(id: string, options?: { force?: boolean }): Promise<void>;
  inspectVolume(name: string): Promise<VolumeDetails>;
}

/** A failure with an HTTP status the route can hand straight back. */
export class OrchestratorError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OrchestratorError';
  }
}

/** What the API and the UI need to know about a session's container. */
export interface SessionContainerView {
  readonly id: string;
  readonly name: string;
  readonly running: boolean;
  /** `running`, `exited`, … as the daemon names it. */
  readonly state: string;
}

/**
 * Per-session containers (US-009).
 *
 * One container per session, created from the runner image, labelled with the
 * session id and left idling so the agent, git and shell processes can be
 * exec'd into it. Everything that must survive — the clone and the `.chief/`
 * state — lives in the workspace on the data volume, never inside the
 * container, so a container can be thrown away and recreated at any time.
 */
export class SessionOrchestrator {
  private readonly hostPaths: HostPaths;

  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly docker: SessionDocker,
  ) {
    this.hostPaths = new HostPaths(config, docker);
  }

  /**
   * Ensures `session` has a running container and returns it. An existing
   * running container is reused; a stopped or duplicate one is replaced.
   */
  async start(session: Session): Promise<SessionContainerView> {
    const existing = await this.containersFor(session.id);
    const running = existing.find((container) => container.state === 'running');
    if (running !== undefined) {
      this.recordContainer(session, running.id);
      return toView(running);
    }

    // The workspace is created before the container so the bind mount does not
    // materialise a root-owned directory the runner cannot write to.
    const workspaceDir = ensureSessionWorkspace(this.config, session.id);
    const privateKey = readPrivateKey(this.config, session.repositoryId);
    const keyPath =
      privateKey === null ? undefined : stageSessionKey(this.config, session.id, privateKey);

    const spec = sessionContainerSpec({
      session,
      image: this.config.runnerImage,
      identity: getGitIdentity(this.db),
      mounts: {
        claudeAuth: claudeAuthSource(this.config),
        workspaceDir: await this.hostPaths.translate(workspaceDir),
        ...(keyPath === undefined ? {} : { sshKeyPath: await this.hostPaths.translate(keyPath) }),
      },
    });

    // Anything left over — a stopped container, or one under the same name from
    // a previous run — is cleared first so `create` cannot fail on a conflict.
    for (const stale of existing) await this.discard(stale.id, true);
    const name = sessionContainerName(session);
    await this.discard(name, true);

    let containerId: string;
    try {
      containerId = await this.docker.createContainer(name, spec);
      await this.docker.startContainer(containerId);
    } catch (cause) {
      throw dockerFailure('start the session container', cause);
    }

    this.recordContainer(session, containerId);
    logger.info('session container started', {
      session: session.id,
      container: containerId,
      name,
      workspace: workspaceDir,
    });
    return { id: containerId, name, running: true, state: 'running' };
  }

  /** The session's container as the daemon sees it, or `null` if it has none. */
  async inspect(sessionId: string): Promise<SessionContainerView | null> {
    let containers: ContainerSummary[];
    try {
      containers = await this.containersFor(sessionId);
    } catch (cause) {
      throw dockerFailure('inspect the session container', cause);
    }
    const container = containers.find((c) => c.state === 'running') ?? containers[0];
    return container === undefined ? null : toView(container);
  }

  /**
   * Stops the container without removing it. The workspace is untouched — a
   * stopped session can be started again on the very same clone.
   */
  async stop(sessionId: string): Promise<void> {
    const containers = await this.containersFor(sessionId);
    for (const container of containers) {
      if (container.state !== 'running') continue;
      try {
        await this.docker.stopContainer(container.id, this.config.sessionStopTimeoutSeconds);
        logger.info('session container stopped', { session: sessionId, container: container.id });
      } catch (cause) {
        throw dockerFailure('stop the session container', cause);
      }
    }
  }

  /**
   * Removes the container and the staged key copy. The workspace survives:
   * the clone and `.chief/` state are what a retry resumes from, and deleting
   * them is only ever the session-deletion path (US-012).
   */
  async remove(sessionId: string): Promise<void> {
    const containers = await this.containersFor(sessionId);
    for (const container of containers) await this.discard(container.id, true);
    removeSessionKey(this.config, sessionId);
    updateSession(this.db, sessionId, { containerId: null });
    logger.info('session container removed', {
      session: sessionId,
      removed: containers.length,
      workspace: sessionWorkspaceDir(this.config, sessionId),
    });
  }

  /**
   * Ensures a pull-request feedback run has a running container (US-021).
   *
   * The same image, mounts and git identity a session gets — the work is the
   * same, only the branch and the brief differ — under its own label namespace
   * so session reconciliation never sees it. The workspace is keyed by the run
   * id and outlives the container, so a second pass on the same pull request
   * reuses the clone.
   */
  async startPrRun(run: PrRunIdentity): Promise<SessionContainerView> {
    const existing = await this.prRunContainersFor(run.id);
    const running = existing.find((container) => container.state === 'running');
    if (running !== undefined) return toView(running);

    const workspaceDir = ensureSessionWorkspace(this.config, run.id);
    const privateKey = readPrivateKey(this.config, run.repositoryId);
    const keyPath =
      privateKey === null ? undefined : stageSessionKey(this.config, run.id, privateKey);

    const spec = prRunContainerSpec({
      run,
      image: this.config.runnerImage,
      identity: getGitIdentity(this.db),
      mounts: {
        claudeAuth: claudeAuthSource(this.config),
        workspaceDir: await this.hostPaths.translate(workspaceDir),
        ...(keyPath === undefined ? {} : { sshKeyPath: await this.hostPaths.translate(keyPath) }),
      },
    });

    for (const stale of existing) await this.discard(stale.id, true);
    const name = prRunContainerName(run);
    await this.discard(name, true);

    let containerId: string;
    try {
      containerId = await this.docker.createContainer(name, spec);
      await this.docker.startContainer(containerId);
    } catch (cause) {
      throw dockerFailure('start the pull request container', cause);
    }

    logger.info('pull request container started', {
      run: run.id,
      pullRequest: run.prNumber,
      container: containerId,
      name,
      workspace: workspaceDir,
    });
    return { id: containerId, name, running: true, state: 'running' };
  }

  /**
   * Removes a feedback run's containers and its staged key. The workspace is
   * deliberately left behind so the next pass reuses the clone.
   */
  async removePrRun(runId: string): Promise<void> {
    const containers = await this.prRunContainersFor(runId);
    for (const container of containers) await this.discard(container.id, true);
    removeSessionKey(this.config, runId);
    logger.info('pull request container removed', { run: runId, removed: containers.length });
  }

  /**
   * Clears out feedback containers left by a previous process, run once at
   * startup.
   *
   * Simpler than session reconciliation and needs no plan: a feedback run is
   * one pass driven from memory, so no container of one can still be doing
   * anything useful after a restart.
   */
  async reconcilePrRuns(): Promise<number> {
    const containers = await this.docker.listContainers({
      all: true,
      labels: [prRunLabelFilter()],
    });
    for (const container of containers) await this.discard(container.id, true);
    if (containers.length > 0) {
      logger.info('removed pull request containers left by a previous run', {
        containers: containers.length,
      });
    }
    return containers.length;
  }

  private prRunContainersFor(runId: string): Promise<ContainerSummary[]> {
    return this.docker.listContainers({ all: true, labels: [prRunLabelFilter(runId)] });
  }

  /**
   * Brings the daemon and the database back into agreement; run once at
   * startup. Throws when Docker cannot be reached — an unanswerable daemon is
   * not evidence that anything is gone.
   */
  async reconcile(): Promise<ReconciliationPlan> {
    const containers = await this.docker.listContainers({
      all: true,
      labels: [sessionLabelFilter()],
    });
    const plan = planReconciliation(listSessions(this.db), containers);

    for (const removal of plan.remove) {
      logger.info('reconcile: removing session container', {
        container: removal.containerId,
        name: removal.containerName,
        session: removal.sessionId,
        reason: removal.reason,
      });
      await this.discard(removal.containerId, true);
      if (removal.sessionId !== null) removeSessionKey(this.config, removal.sessionId);
    }

    for (const correction of plan.correct) {
      updateSession(this.db, correction.sessionId, correction.patch);
      logger.info('reconcile: corrected session', {
        session: correction.sessionId,
        reason: correction.reason,
        status: correction.patch.status,
      });
    }

    logger.info('reconciled session containers', {
      containers: containers.length,
      removed: plan.remove.length,
      corrected: plan.correct.length,
    });
    return plan;
  }

  private containersFor(sessionId: string): Promise<ContainerSummary[]> {
    return this.docker.listContainers({ all: true, labels: [sessionLabelFilter(sessionId)] });
  }

  private recordContainer(session: Session, containerId: string): void {
    if (session.containerId === containerId) return;
    updateSession(this.db, session.id, { containerId });
  }

  /** Best effort removal: a container that is already gone is not an error. */
  private async discard(nameOrId: string, force: boolean): Promise<void> {
    try {
      await this.docker.removeContainer(nameOrId, { force });
    } catch (cause) {
      if (cause instanceof DockerApiError && cause.status === 404) return;
      logger.warn('could not remove a session container', {
        container: nameOrId,
        error: String(cause),
      });
    }
  }
}

export function createSessionOrchestrator(
  config: Config,
  db: Database,
  docker: SessionDocker = new DockerApi(config.dockerSocket),
): SessionOrchestrator {
  return new SessionOrchestrator(config, db, docker);
}

function toView(container: ContainerSummary): SessionContainerView {
  return {
    id: container.id,
    name: container.name,
    running: container.state === 'running',
    state: container.state,
  };
}

function dockerFailure(action: string, cause: unknown): OrchestratorError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new OrchestratorError(502, 'docker_unavailable', `Could not ${action}: ${detail}`);
}
