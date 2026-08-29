import fs from 'node:fs';
import path from 'node:path';

import type { Config } from '../config.js';
import {
  createSession,
  type Database,
  featureBranchFor,
  getRepository,
  getSession,
  isValidSessionName,
  listSessions,
  listStories,
  type PrTargetBranch,
  type Session,
  type SessionStatus,
  type Story,
  type StoryInput,
  syncStories,
  updateSession,
} from '../db/index.js';
import { logger } from '../lib/logger.js';
import type { SessionContainerView } from '../orchestrator/index.js';
import { sessionRepoDir } from '../orchestrator/index.js';
import {
  type PrdStatus,
  type PrdStory,
  prdPathFor,
  progressPathFor,
  readPrdDocument,
} from '../prd/index.js';
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
  readonly queuedAt: string | null;
  readonly containerId: string | null;
  readonly prUrl: string | null;
  readonly lastError: string | null;
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
}

export class SessionService {
  /** Setups in flight, so two clicks cannot clone the same session twice. */
  private readonly running = new Map<string, Promise<SessionSetupView>>();

  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly containers: SessionContainers,
    private readonly exec: SessionExecutor,
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
  markReady(id: string): ReadyResult {
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
    const updated = updateSession(this.db, session.id, { status: 'ready', lastError: null }) ?? session;

    logger.info('session marked ready', {
      session: session.id,
      name: session.name,
      stories: stories.length,
    });

    return { ok: true, session: this.toView(updated), prd: document.status, stories };
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
      session: this.toView(updated),
      prd: this.prdStatus(updated),
      stories: listStories(this.db, session.id),
    };
  }

  private refusal(session: Session, prd: PrdStatus): ReadyResult {
    logger.info('session not marked ready: the PRD does not parse', {
      session: session.id,
      errors: prd.errors.length,
    });
    return {
      ok: false,
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
      queuedAt: session.queuedAt,
      containerId: session.containerId,
      prUrl: session.prUrl,
      lastError: session.lastError,
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

/** True once `/workspace/repo` on the data volume is a git working copy. */
export function isCloned(config: Pick<Config, 'workspacesDir'>, sessionId: string): boolean {
  return fs.existsSync(path.join(sessionRepoDir(config, sessionId), '.git'));
}

export function createSessionService(
  config: Config,
  db: Database,
  containers: SessionContainers,
  exec: SessionExecutor,
): SessionService {
  return new SessionService(config, db, containers, exec);
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
