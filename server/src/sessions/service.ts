import fs from 'node:fs';
import path from 'node:path';

import type { Config } from '../config.js';
import {
  countStories,
  createSession,
  type Database,
  deleteSession,
  type FailureStage,
  featureBranchFor,
  getRepository,
  getSession,
  isScheduleMissed,
  isValidSessionName,
  listSessions,
  listStories,
  nowIso,
  type PrTargetBranch,
  queuePosition,
  type Session,
  type SessionStatus,
  type Story,
  type StoryCounts,
  type StoryInput,
  syncStories,
  updateSession,
} from '../db/index.js';
import { logger } from '../lib/logger.js';
import type { SessionContainerView } from '../orchestrator/index.js';
import { removeSessionWorkspace, sessionRepoDir } from '../orchestrator/index.js';
import {
  agentLogPathFor,
  type PrdStatus,
  type PrdStory,
  prdPathFor,
  progressPathFor,
  readPrdDocument,
} from '../prd/index.js';
import { getCodeReviewDefault } from '../settings/index.js';
import { hasPrivateKey } from '../ssh/index.js';
import { runSessionSetup, type SessionExecutor, type SetupResult } from './setup.js';

/**
 * Session creation and repository setup (US-010).
 *
 * Creating a session is two things that can fail independently: a row, and a
 * container with a clone in it. The row is written first and always survives —
 * a failed clone leaves the session `pending` with the reason stored on it and
 * a "Retry setup" action, never a half-created session the user has to clean up
 * by hand.
 */

/** A failure with the HTTP status and error code the route should answer with. */
export class SessionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

/** The slice of the orchestrator (US-009) session setup drives. */
export interface SessionContainers {
  start(session: Session): Promise<SessionContainerView>;
  remove(sessionId: string): Promise<void>;
}

/**
 * The processes a deletion has to unwind before the container and the
 * workspace can go (US-015).
 *
 * They are declared here as one-method seams rather than imported, because
 * both services are built *after* this one — and because a `SessionService`
 * without them (every test that never builds or plans) then simply has nothing
 * to stop.
 */
export interface SessionLifecycle {
  /** The Ralph loop (US-013): signalled, and awaited, before anything is removed. */
  readonly builds?: { stop(sessionId: string): Promise<unknown> };
  /** The planning terminal (US-011): closed so no exec is left attached. */
  readonly planning?: { stop(sessionId: string): Promise<unknown> };
  /**
   * The scheduler (US-017), so a schedule missed while the session was still
   * pending is honoured the instant "Mark ready" makes it startable, instead
   * of waiting for the next poll.
   */
  readonly scheduler?: { fire(sessionId: string): Promise<boolean> };
}

/** A session as the API returns it. */
export interface SessionView {
  readonly id: string;
  readonly repositoryId: string;
  /** Denormalised for the UI, which lists sessions across repositories. */
  readonly repositoryName: string;
  readonly name: string;
  readonly status: SessionStatus;
  readonly baseBranch: string;
  readonly featureBranch: string;
  readonly prTargetBranch: PrTargetBranch;
  readonly scheduledStartAt: string | null;
  /**
   * True when the scheduled moment passed while the session was still
   * `pending`, so nothing started it. The UI says so, and marking the session
   * ready starts it there and then.
   */
  readonly scheduleMissed: boolean;
  readonly queuedAt: string | null;
  /**
   * 1-based place in the FIFO build queue (US-018), or `null` when the session
   * is not waiting for a slot. The dashboard shows it as "Queued (#2)".
   */
  readonly queuePosition: number | null;
  readonly containerId: string | null;
  readonly prUrl: string | null;
  readonly lastError: string | null;
  /**
   * Which step a `failed` session failed at (US-019), so the UI can name it and
   * offer the retry that resumes from there. `null` for every session that is
   * not failed — and for one that failed before chief-web recorded stages.
   */
  readonly failureStage: FailureStage | null;
  /**
   * When a `waiting` session may resume: the expiry of the global hold Claude's
   * usage limit armed (US-003), or `null` for every session that is not held.
   * The UI counts down to it, and "Resume now" (US-008) is what ends it early.
   */
  readonly waitingUntil: string | null;
  /**
   * Whether the pull request this session opens should be reviewed
   * automatically (US-003). Editable up to the moment the session finishes,
   * which is when the review would have been requested.
   */
  readonly codeReview: boolean;
  /**
   * Story progress for the dashboard's `4/9 done`. Both are 0 until the
   * session has been marked ready and its PRD parsed into stories.
   */
  readonly stories: StoryCounts;
  /**
   * Whether `/workspace/repo` is a git clone. Read from the data volume rather
   * than remembered in memory, so a restart still knows which sessions never
   * finished their setup.
   */
  readonly cloned: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * What "Mark ready" and "Back to planning" answer with (US-012).
 *
 * A PRD that does not parse is a *successful* request whose result the operator
 * has to read — the line-numbered errors are in `prd.errors` — exactly like a
 * failed clone. `ok` says whether the transition happened.
 */
export interface ReadyResult {
  readonly ok: boolean;
  /**
   * Whether the build was started as part of this call, which happens when the
   * session had a schedule it missed while it was still pending (US-017).
   */
  readonly started: boolean;
  readonly session: SessionView;
  readonly prd: PrdStatus;
  /** The session's stories as the database now holds them. */
  readonly stories: readonly Story[];
}

/** What creating a session, or retrying its setup, answers with. */
export interface SessionSetupView {
  readonly session: SessionView;
  readonly setup: SetupResult;
}

export interface CreateSessionRequest {
  readonly repositoryId: string;
  readonly name: string;
  /** Defaults to the repository's default base branch. */
  readonly baseBranch?: string;
  readonly prTargetBranch: PrTargetBranch;
  /** UTC ISO-8601, already converted from the browser's timezone. */
  readonly scheduledStartAt?: string | null;
  /** Defaults to false. */
  readonly codeReview?: boolean;
}

export class SessionService {
  /** Setups in flight, so two clicks cannot clone the same session twice. */
  private readonly running = new Map<string, Promise<SessionSetupView>>();

  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly containers: SessionContainers,
    private readonly exec: SessionExecutor,
    private readonly lifecycle: SessionLifecycle = {},
  ) {}

  list(repositoryId?: string): SessionView[] {
    const sessions = listSessions(
      this.db,
      repositoryId === undefined ? {} : { repositoryId },
    );
    return sessions.map((session) => this.toView(session));
  }

  get(id: string): SessionView | null {
    const session = getSession(this.db, id);
    return session === null ? null : this.toView(session);
  }

  /**
   * Writes the session row, then clones into a fresh container. The clone's
   * outcome is part of the answer, not an exception: a rejected remote is
   * something the operator has to read, not a 500.
   */
  async create(request: CreateSessionRequest): Promise<SessionSetupView> {
    const repository = getRepository(this.db, request.repositoryId);
    if (repository === null) {
      throw new SessionError(400, 'repository_not_found', 'No such repository.');
    }
    if (!isValidSessionName(request.name)) {
      throw new SessionError(
        400,
        'invalid_session_name',
        'Use letters, numbers, hyphens and underscores only.',
      );
    }
    if (!hasPrivateKey(this.config, repository.id)) {
      throw new SessionError(
        400,
        'repository_key_missing',
        `"${repository.name}" has no private key on the data volume, so nothing can be cloned. Edit the repository and add one.`,
      );
    }
    if (
      listSessions(this.db, { repositoryId: repository.id }).some(
        (existing) => existing.name === request.name,
      )
    ) {
      throw new SessionError(
        409,
        'session_name_taken',
        `"${repository.name}" already has a session named "${request.name}". Pick another name.`,
      );
    }

    let session: Session;
    try {
      session = createSession(this.db, {
        repositoryId: repository.id,
        name: request.name,
        baseBranch: request.baseBranch ?? repository.defaultBaseBranch,
        prTargetBranch: request.prTargetBranch,
        featureBranch: featureBranchFor(request.name),
        status: 'pending',
        scheduledStartAt: request.scheduledStartAt ?? null,
        codeReview: request.codeReview ?? getCodeReviewDefault(this.db),
      });
    } catch (cause) {
      // The check above loses a race between two submissions; the unique index
      // is what actually decides, so translate its complaint too.
      if (!isDuplicateName(cause)) throw cause;
      throw new SessionError(
        409,
        'session_name_taken',
        `"${repository.name}" already has a session named "${request.name}". Pick another name.`,
      );
    }

    logger.info('session created', {
      session: session.id,
      repository: repository.id,
      name: session.name,
      featureBranch: session.featureBranch,
    });

    return this.setup(session.id);
  }

  /**
   * Spawns the container and runs the clone. Safe to call again after a
   * failure — that is the "Retry setup" action — and concurrent calls for the
   * same session share one run.
   */
  setup(id: string): Promise<SessionSetupView> {
    const inFlight = this.running.get(id);
    if (inFlight !== undefined) return inFlight;

    const run = this.performSetup(id).finally(() => this.running.delete(id));
    this.running.set(id, run);
    return run;
  }

  /** The parsed story list of a session, empty until it has been marked ready. */
  stories(id: string): Story[] {
    this.requireSession(id);
    return listStories(this.db, id);
  }

  /**
   * "Mark ready": the gate between planning and building.
   *
   * chief-web guarantees the PRD is usable before anything is built, so the
   * file is parsed first and the session only becomes `ready` when it parses
   * cleanly. On success the stories are synced into the `stories` table, which
   * is what the build loop reads; on failure nothing changes and the errors
   * come back with their line numbers.
   */
  async markReady(id: string): Promise<ReadyResult> {
    const session = this.requireSession(id);
    if (session.status !== 'pending') {
      throw new SessionError(
        409,
        'session_not_pending',
        `Only a pending session can be marked ready; "${session.name}" is ${session.status}.`,
      );
    }

    const document = readPrdDocument(this.prdFile(session), prdPathFor(session.name));
    if (!document.status.exists) {
      return this.refusal(session, {
        ...document.status,
        errors: [
          {
            line: 0,
            message: `${document.status.path} does not exist yet. Plan the feature first — Claude writes the PRD.`,
          },
        ],
      });
    }
    if (document.parsed === null || !document.status.parses) {
      return this.refusal(session, document.status);
    }

    const stories = syncStories(this.db, session.id, document.parsed.stories.map(storyInputOf));
    const updated =
      updateSession(this.db, session.id, {
        status: 'ready',
        lastError: null,
        failureStage: null,
      }) ?? session;

    logger.info('session marked ready', {
      session: session.id,
      name: session.name,
      stories: stories.length,
    });

    // A schedule the session slept through while it was still pending is
    // honoured now rather than at the next poll: "mark ready to start" is the
    // whole of what the UI promises, and the operator has just confirmed it
    // (US-017). A schedule still in the future is left to the scheduler.
    const started =
      this.lifecycle.scheduler !== undefined &&
      updated.scheduledStartAt !== null &&
      updated.scheduledStartAt <= nowIso()
        ? await this.lifecycle.scheduler.fire(updated.id)
        : false;
    const current = started ? (getSession(this.db, updated.id) ?? updated) : updated;

    return { ok: true, started, session: this.toView(current), prd: document.status, stories };
  }

  /**
   * "Back to planning": returns a ready session to `pending` so its PRD can be
   * edited again. The stories stay in the database — the next "Mark ready"
   * reconciles them with the file, and until then they are the last good list.
   */
  backToPlanning(id: string): ReadyResult {
    const session = this.requireSession(id);
    if (session.status !== 'ready') {
      throw new SessionError(
        409,
        'session_not_ready',
        `Only a ready session can go back to planning; "${session.name}" is ${session.status}.`,
      );
    }

    const updated = updateSession(this.db, session.id, { status: 'pending' }) ?? session;
    logger.info('session returned to planning', { session: session.id, name: session.name });

    return {
      ok: true,
      started: false,
      session: this.toView(updated),
      prd: this.prdStatus(updated),
      stories: listStories(this.db, session.id),
    };
  }

  /**
   * Sets, changes or clears the scheduled start (US-017).
   *
   * Only while the session is `pending` or `ready`: once it is building there
   * is nothing left to schedule, and once it is finished or failed a timestamp
   * would only be a trap the next time the loop is started by hand.
   */
  setSchedule(id: string, scheduledStartAt: string | null): SessionView {
    const session = this.requireSession(id);
    if (session.status !== 'pending' && session.status !== 'ready') {
      throw new SessionError(
        409,
        'session_not_schedulable',
        `Only a pending or ready session can be scheduled; "${session.name}" is ${session.status}.`,
      );
    }

    const updated = updateSession(this.db, session.id, { scheduledStartAt }) ?? session;
    logger.info(scheduledStartAt === null ? 'session schedule cleared' : 'session scheduled', {
      session: session.id,
      name: session.name,
      scheduledStartAt,
    });
    return this.toView(updated);
  }

  /**
   * Turns the automatic code review on or off (US-003).
   *
   * Allowed for every status but `finished`: that is the one that means the
   * pull request has already been opened and delivered, so the moment the flag
   * decides anything has passed and flipping it would only mislead.
   */
  setCodeReview(id: string, codeReview: boolean): SessionView {
    const session = this.requireSession(id);
    if (session.status === 'finished') {
      throw new SessionError(
        409,
        'session_finished',
        `"${session.name}" has finished, so its code review can no longer be changed.`,
      );
    }

    const updated = updateSession(this.db, session.id, { codeReview }) ?? session;
    logger.info('session code review updated', {
      session: session.id,
      name: session.name,
      codeReview,
    });
    return this.toView(updated);
  }

  /**
   * Deletes the session, its container and its workspace (US-015).
   *
   * Everything chief-web created *here* goes; nothing on the remote does. The
   * branch that was pushed and the pull request that was opened are the whole
   * point of the session and stay exactly as they are — deleting a session is
   * cleaning up this server, not undoing the work.
   *
   * A `building` session is stopped first, so the agent process is signalled
   * and the loop unwound before its container is pulled out from under it.
   * Docker is asked before anything local is removed: if the daemon cannot be
   * reached, the container's fate is unknown, and the honest answer is to
   * refuse rather than to orphan a running container next to a deleted
   * workspace.
   */
  async delete(id: string): Promise<void> {
    const session = this.requireSession(id);

    if (session.status === 'building' && this.lifecycle.builds !== undefined) {
      try {
        await this.lifecycle.builds.stop(session.id);
      } catch (cause) {
        // The loop loses its container in a moment either way; a refused stop
        // must not leave the session undeletable.
        logger.warn('could not stop the build of a session being deleted', {
          session: session.id,
          error: describe(cause),
        });
      }
    }

    if (this.lifecycle.planning !== undefined) {
      try {
        await this.lifecycle.planning.stop(session.id);
      } catch (cause) {
        logger.warn('could not close the planning terminal of a session being deleted', {
          session: session.id,
          error: describe(cause),
        });
      }
    }

    try {
      await this.containers.remove(session.id);
    } catch (cause) {
      throw new SessionError(
        502,
        'session_container_unavailable',
        `The container of "${session.name}" could not be removed, so nothing was deleted: ${describe(cause)}`,
      );
    }

    removeSessionWorkspace(this.config, session.id);
    // The stories go with it, by cascade.
    deleteSession(this.db, session.id);

    logger.info('session deleted', {
      session: session.id,
      name: session.name,
      featureBranch: session.featureBranch,
    });
  }

  private refusal(session: Session, prd: PrdStatus): ReadyResult {
    logger.info('session not marked ready: the PRD does not parse', {
      session: session.id,
      errors: prd.errors.length,
    });
    return {
      ok: false,
      started: false,
      session: this.toView(session),
      prd,
      stories: listStories(this.db, session.id),
    };
  }

  private requireSession(id: string): Session {
    const session = getSession(this.db, id);
    if (session === null) {
      throw new SessionError(404, 'session_not_found', 'This session no longer exists.');
    }
    return session;
  }

  private prdFile(session: Session): string {
    return sessionPrdFile(this.config, session);
  }

  private prdStatus(session: Session): PrdStatus {
    return readPrdDocument(this.prdFile(session), prdPathFor(session.name)).status;
  }

  private async performSetup(id: string): Promise<SessionSetupView> {
    const session = this.requireSession(id);
    if (session.status !== 'pending') {
      throw new SessionError(
        409,
        'session_not_pending',
        `Only a pending session can be set up; "${session.name}" is ${session.status}.`,
      );
    }
    const repository = getRepository(this.db, session.repositoryId);
    if (repository === null) {
      throw new SessionError(400, 'repository_not_found', 'No such repository.');
    }

    const result = await this.cloneInContainer(session, repository.sshUrl);

    if (result.ok) {
      updateSession(this.db, session.id, { lastError: null });
      logger.info('session repository ready', {
        session: session.id,
        featureBranch: session.featureBranch,
      });
    } else {
      // The session stays `pending` with its reason attached; the container is
      // not worth keeping, and a retry recreates it around the same workspace.
      updateSession(this.db, session.id, { lastError: result.message });
      await this.discardContainer(session.id);
      logger.warn('session setup failed', {
        session: session.id,
        code: result.code,
        message: result.message,
      });
    }

    const updated = getSession(this.db, session.id) ?? session;
    return { session: this.toView(updated), setup: result };
  }

  /** Never throws: an unreachable daemon is reported the same way git is. */
  private async cloneInContainer(session: Session, repoUrl: string): Promise<SetupResult> {
    let container: SessionContainerView;
    try {
      container = await this.containers.start(session);
    } catch (cause) {
      return {
        ok: false,
        code: 'clone_failed',
        message: `The session container could not be started: ${describe(cause)}`,
        stderr: '',
      };
    }

    try {
      return await runSessionSetup(this.exec, container.id, {
        repoUrl,
        baseBranch: session.baseBranch,
        featureBranch: session.featureBranch,
        timeoutMs: this.config.sessionSetupTimeoutMs,
      });
    } catch (cause) {
      return {
        ok: false,
        code: 'clone_failed',
        message: `The repository setup could not be run in the session container: ${describe(cause)}`,
        stderr: '',
      };
    }
  }

  private async discardContainer(sessionId: string): Promise<void> {
    try {
      await this.containers.remove(sessionId);
    } catch (cause) {
      logger.warn('could not remove the container of a failed setup', {
        session: sessionId,
        error: describe(cause),
      });
    }
  }

  private toView(session: Session): SessionView {
    const repository = getRepository(this.db, session.repositoryId);
    return {
      id: session.id,
      repositoryId: session.repositoryId,
      repositoryName: repository?.name ?? 'unknown repository',
      name: session.name,
      status: session.status,
      baseBranch: session.baseBranch,
      featureBranch: session.featureBranch,
      prTargetBranch: session.prTargetBranch,
      scheduledStartAt: session.scheduledStartAt,
      scheduleMissed: isScheduleMissed(session),
      queuedAt: session.queuedAt,
      queuePosition: queuePosition(this.db, session),
      containerId: session.containerId,
      prUrl: session.prUrl,
      lastError: session.lastError,
      failureStage: session.failureStage,
      waitingUntil: session.waitingUntil,
      codeReview: session.codeReview,
      stories: countStories(this.db, session.id),
      cloned: isCloned(this.config, session.id),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }
}

/** Absolute path of a session's `prd.md` on the data volume. */
export function sessionPrdFile(
  config: Pick<Config, 'workspacesDir'>,
  session: Pick<Session, 'id' | 'name'>,
): string {
  return path.join(sessionRepoDir(config, session.id), prdPathFor(session.name));
}

/** Absolute path of the build loop's `progress.md`, next to the PRD (US-013). */
export function sessionProgressFile(
  config: Pick<Config, 'workspacesDir'>,
  session: Pick<Session, 'id' | 'name'>,
): string {
  return path.join(sessionRepoDir(config, session.id), progressPathFor(session.name));
}

/** Absolute path of the build loop's `agent.log`, next to the PRD (US-016). */
export function sessionAgentLogFile(
  config: Pick<Config, 'workspacesDir'>,
  session: Pick<Session, 'id' | 'name'>,
): string {
  return path.join(sessionRepoDir(config, session.id), agentLogPathFor(session.name));
}

/** True once `/workspace/repo` on the data volume is a git working copy. */
export function isCloned(config: Pick<Config, 'workspacesDir'>, sessionId: string): boolean {
  return fs.existsSync(path.join(sessionRepoDir(config, sessionId), '.git'));
}

export function createSessionService(
  config: Config,
  db: Database,
  containers: SessionContainers,
  exec: SessionExecutor,
  lifecycle: SessionLifecycle = {},
): SessionService {
  return new SessionService(config, db, containers, exec, lifecycle);
}

/**
 * The parsed PRD's story as the `stories` table takes it. Exported because
 * every re-read of `prd.md` — "Mark ready" here, and each iteration of the
 * build loop (US-013) — has to sync the table the same way.
 */
export function storyInputOf(story: PrdStory): StoryInput {
  return {
    storyId: story.id,
    title: story.title,
    priority: story.priority,
    status: story.status,
  };
}

function isDuplicateName(cause: unknown): boolean {
  return cause instanceof Error && /UNIQUE constraint failed: sessions\./.test(cause.message);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
