import fs from 'node:fs';

import type { Config } from '../config.js';
import {
  type Database,
  getSession,
  listStories,
  nowIso,
  type Session,
  type SessionStatus,
  type Story,
  type StoryStatus,
  syncStories,
  updateSession,
  updateStory,
} from '../db/index.js';
import { logger } from '../lib/logger.js';
import {
  type ParsedPrd,
  type PrdStatus,
  type PrdStory,
  prdPathFor,
  readPrdDocument,
  setStoryStatus,
} from '../prd/index.js';
import {
  isCloned,
  type SessionContainers,
  sessionPrdFile,
  sessionProgressFile,
  storyInputOf,
} from '../sessions/index.js';
import {
  classifyIteration,
  iterationCap,
  MAX_RETRIES,
  remainingStories,
  selectNextStory,
} from './loop.js';
import { agentPrompt } from './prompts.js';
import type { AgentResult, AgentRunner } from './runner.js';

/**
 * The Ralph loop (US-013).
 *
 * "Start build" turns a `ready` session into a `building` one and hands it to a
 * loop that, over and over: picks the lowest-priority story that is not `done`,
 * runs one headless `claude -p` inside the session container, and then looks at
 * the world to decide what happened — `prd.md` as the agent left it, and the
 * git history. Nothing about an iteration is taken on the agent's word.
 *
 * Everything that must survive lives outside this class: the statuses are in
 * `prd.md` on the data volume, the work is in commits, and the learnings are in
 * `progress.md`. So a build that is stopped, or a server that is restarted,
 * loses at most the iteration that was in flight — which is exactly why the
 * loop can afford to be this simple.
 */

/** A failure with the HTTP status and code the route should answer with. */
export class BuildError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BuildError';
  }
}

/** What the session page needs to render the build state. */
export interface BuildView {
  readonly sessionId: string;
  readonly sessionName: string;
  readonly status: SessionStatus;
  /** True while this server is driving a loop for the session. */
  readonly running: boolean;
  /** Iterations started so far in the current run; 0 when none is running. */
  readonly iteration: number;
  /** The dynamic cap this run aborts at. */
  readonly maxIterations: number;
  /** The story the current iteration is implementing. */
  readonly currentStoryId: string | null;
  /** Consecutive fruitless iterations on that story; a retry counter. */
  readonly attempts: number;
  readonly stories: readonly Story[];
  readonly prd: PrdStatus;
  readonly lastError: string | null;
  readonly startedAt: string | null;
}

/**
 * What happens when every story is `done`.
 *
 * US-014 pushes the feature branch and opens a pull request; until it lands the
 * default simply marks the session `finished`, so the loop already has the
 * hand-off seam it will need and nothing here changes when the real one
 * arrives.
 */
export interface BuildCompletion {
  complete(session: Session, stories: readonly Story[]): Promise<void>;
}

/** The default hand-off: the session is finished, with nothing pushed. */
export class MarkSessionFinished implements BuildCompletion {
  constructor(private readonly db: Database) {}

  complete(session: Session): Promise<void> {
    updateSession(this.db, session.id, { status: 'finished', lastError: null });
    return Promise.resolve();
  }
}

/** One live loop. Mutable on purpose: it is the run's own scratch space. */
interface RunState {
  containerId: string;
  iteration: number;
  attempts: number;
  storyId: string | null;
  readonly maxIterations: number;
  readonly startedAt: string;
  stopping: boolean;
  /** Resolves when the loop has finished; awaited by "Stop build". */
  finished: Promise<void>;
}

/** What one re-read of `prd.md` produced. */
interface PrdSnapshot {
  readonly stories: readonly Story[];
  readonly parsed: ParsedPrd | null;
  readonly status: PrdStatus;
  /** False when the file could not be parsed, so nothing was synced. */
  readonly synced: boolean;
}

export class BuildService {
  private readonly runs = new Map<string, RunState>();

  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly containers: SessionContainers,
    private readonly runner: AgentRunner,
    private readonly completion: BuildCompletion,
  ) {}

  status(sessionId: string): BuildView {
    return this.toView(this.requireSession(sessionId));
  }

  /**
   * Starts the loop. The container is brought up first so a broken environment
   * is a failed *request* rather than a session that flickers into `building`
   * and straight back out to `failed`.
   */
  async start(sessionId: string): Promise<BuildView> {
    const session = this.requireSession(sessionId);
    if (this.runs.has(sessionId)) return this.toView(session);

    if (session.status !== 'ready') {
      throw new BuildError(
        409,
        'session_not_ready',
        `Only a ready session can be built; "${session.name}" is ${session.status}.`,
      );
    }
    if (!isCloned(this.config, session.id)) {
      throw new BuildError(
        409,
        'session_not_cloned',
        `"${session.name}" has no clone yet, so there is nothing to build in. Run setup first.`,
      );
    }

    const stories = listStories(this.db, session.id);
    if (selectNextStory(stories) === null) {
      throw new BuildError(
        409,
        stories.length === 0 ? 'session_has_no_stories' : 'session_already_complete',
        stories.length === 0
          ? `"${session.name}" has no stories. Mark it ready again to re-read its PRD.`
          : `Every story of "${session.name}" is already done.`,
      );
    }

    let containerId: string;
    try {
      containerId = (await this.containers.start(session)).id;
    } catch (cause) {
      throw new BuildError(
        502,
        'session_container_unavailable',
        `The session container could not be started: ${describe(cause)}`,
      );
    }

    const building = updateSession(this.db, session.id, { status: 'building', lastError: null }) ?? session;
    const state: RunState = {
      containerId,
      iteration: 0,
      attempts: 0,
      storyId: null,
      maxIterations: iterationCap(remainingStories(stories)),
      startedAt: nowIso(),
      stopping: false,
      finished: Promise.resolve(),
    };
    this.runs.set(sessionId, state);
    state.finished = this.runLoop(sessionId, state).finally(() => {
      // Only ever forget *this* run: a session started again in the meantime
      // has its own state in the map.
      if (this.runs.get(sessionId) === state) this.runs.delete(sessionId);
    });

    logger.info('build started', {
      session: session.id,
      name: session.name,
      container: containerId,
      stories: stories.length,
      maxIterations: state.maxIterations,
    });
    return this.toView(building);
  }

  /**
   * "Stop build": signals the running agent and waits for the loop to unwind,
   * leaving the session `ready`. Everything already committed stays committed,
   * and the statuses in `prd.md` are whatever the last finished iteration
   * wrote — a stopped build resumes rather than restarts.
   */
  async stop(sessionId: string): Promise<BuildView> {
    const session = this.requireSession(sessionId);
    const state = this.runs.get(sessionId);

    if (state === undefined) {
      if (session.status !== 'building') {
        throw new BuildError(
          409,
          'session_not_building',
          `Only a building session can be stopped; "${session.name}" is ${session.status}.`,
        );
      }
      // `building` with no loop behind it: this server was restarted while the
      // session was running. Returning it to `ready` is the whole of "stop".
      return this.toView(this.returnToReady(session));
    }

    state.stopping = true;
    try {
      await this.runner.stop(sessionId, state.containerId);
    } catch (cause) {
      logger.warn('could not signal the build agent', {
        session: sessionId,
        error: describe(cause),
      });
    }
    await settle(state.finished, this.config.buildStopTimeoutMs);

    const stopped = getSession(this.db, sessionId) ?? session;
    logger.info('build stopped', { session: sessionId, iterations: state.iteration });
    return this.toView(stopped.status === 'building' ? this.returnToReady(stopped) : stopped);
  }

  /** Resolves when the session's loop has unwound; immediately if none runs. */
  whenIdle(sessionId: string): Promise<void> {
    return this.runs.get(sessionId)?.finished ?? Promise.resolve();
  }

  private async runLoop(sessionId: string, state: RunState): Promise<void> {
    for (;;) {
      const session = getSession(this.db, sessionId);
      // A session that was deleted, or moved out of `building` by something
      // else, is not this loop's business any more.
      if (session === null) return;
      if (state.stopping) {
        this.returnToReady(session);
        return;
      }
      if (session.status !== 'building') return;

      let snapshot: PrdSnapshot;
      try {
        snapshot = this.readPrd(session);
      } catch (cause) {
        this.fail(session, `The PRD could not be read: ${describe(cause)}`);
        return;
      }
      if (!snapshot.synced) {
        this.fail(session, prdBrokenMessage(snapshot));
        return;
      }

      const story = selectNextStory(snapshot.stories);
      if (story === null) {
        await this.handOff(session, snapshot.stories);
        return;
      }

      if (state.iteration >= state.maxIterations) {
        this.fail(
          session,
          `The build was stopped after ${String(state.maxIterations)} iterations with ` +
            `${String(remainingStories(snapshot.stories))} of ${String(snapshot.stories.length)} ` +
            `stories still outstanding (currently ${story.storyId}). That is more than one and a ` +
            'half passes over the PRD, so the loop is not converging.',
        );
        return;
      }

      if (state.storyId !== story.storyId) {
        state.storyId = story.storyId;
        state.attempts = 0;
      }
      state.iteration += 1;

      let keepGoing: boolean;
      try {
        keepGoing = await this.iterate(session, story, snapshot, state);
      } catch (cause) {
        this.fail(
          session,
          `Iteration ${String(state.iteration)} (${story.storyId}) could not be run: ${describe(cause)}`,
        );
        return;
      }
      if (!keepGoing) return;
    }
  }

  /** One iteration. Returns false when the loop must not continue. */
  private async iterate(
    session: Session,
    story: Story,
    snapshot: PrdSnapshot,
    state: RunState,
  ): Promise<boolean> {
    state.containerId = (await this.containers.start(session)).id;

    // chief marks the story in-progress before invoking the agent, and so does
    // this: the status the loop leaves behind is what the *next* read is
    // compared against, so the loop can never mistake its own write for work.
    const before = this.markInProgress(session, story);
    const headBefore = await this.runner.headSha(state.containerId);

    logger.info('build iteration started', {
      session: session.id,
      iteration: state.iteration,
      maxIterations: state.maxIterations,
      story: story.storyId,
      attempt: state.attempts + 1,
    });

    const result = await this.runner.run({
      sessionId: session.id,
      containerId: state.containerId,
      prompt: agentPrompt({
        sessionName: session.name,
        story: promptStory(story, snapshot.parsed),
        prd: snapshot.parsed,
        progress: this.readProgress(session),
      }),
      timeoutMs: this.config.buildIterationTimeoutMs,
    });

    // The bookkeeping happens even when the operator pressed "Stop build"
    // while this iteration was running: the agent may well have committed the
    // story before it was signalled, and that has to be recorded before the
    // run unwinds or the work loses its commit.
    const headAfter = await this.runner.headSha(state.containerId);
    const after = this.readPrd(session);
    const updated = after.stories.find((candidate) => candidate.storyId === story.storyId) ?? null;
    const change = classifyIteration(before, updated?.status ?? null, headBefore, headAfter);
    if (change.commitSha !== null && updated !== null) {
      updateStory(this.db, session.id, story.storyId, { commitSha: change.commitSha });
    }

    if (state.stopping) {
      this.returnToReady(session);
      return false;
    }
    // A PRD chief-web can no longer read is the end of the run: it is the only
    // record of which stories are done, so continuing would be guesswork.
    if (!after.synced) {
      this.fail(session, prdBrokenMessage(after));
      return false;
    }

    logger.info('build iteration finished', {
      session: session.id,
      iteration: state.iteration,
      story: story.storyId,
      status: updated?.status ?? 'gone',
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      commit: change.commitSha,
      stalled: change.stalled,
    });

    if (!change.stalled) {
      state.attempts = 0;
      return true;
    }

    state.attempts += 1;
    if (state.attempts > MAX_RETRIES) {
      this.fail(session, stalledMessage(story, state.attempts, result));
      return false;
    }
    logger.warn('build iteration produced nothing; retrying', {
      session: session.id,
      story: story.storyId,
      attempt: state.attempts,
      remainingRetries: MAX_RETRIES - state.attempts + 1,
    });
    return true;
  }

  private async handOff(session: Session, stories: readonly Story[]): Promise<void> {
    logger.info('build complete: every story is done', {
      session: session.id,
      name: session.name,
      stories: stories.length,
    });
    await this.completion.complete(session, stories);
  }

  /**
   * Writes `**Status:** in-progress` into `prd.md` and the row, and returns the
   * status the story now has as far as the loop is concerned. A file that
   * cannot be written leaves the story where it was — the comparison after the
   * iteration has to be against reality, not against an intention.
   */
  private markInProgress(session: Session, story: Story): StoryStatus {
    const file = sessionPrdFile(this.config, session);
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch (cause) {
      logger.warn('could not read the PRD to mark a story in progress', {
        session: session.id,
        story: story.storyId,
        error: describe(cause),
      });
      return story.status;
    }

    const result = setStoryStatus(content, story.storyId, 'in-progress');
    if (result.missing.length > 0) return story.status;
    if (result.changed) {
      try {
        // Written in place, so the file keeps the ownership the runner needs:
        // the server is root in Docker and a fresh file would be root's.
        fs.writeFileSync(file, result.content);
      } catch (cause) {
        logger.warn('could not mark a story in progress', {
          session: session.id,
          story: story.storyId,
          error: describe(cause),
        });
        return story.status;
      }
    }
    updateStory(this.db, session.id, story.storyId, { status: 'in-progress' });
    return 'in-progress';
  }

  /** Re-reads `prd.md` and syncs the `stories` table with what it now says. */
  private readPrd(session: Session): PrdSnapshot {
    const document = readPrdDocument(sessionPrdFile(this.config, session), prdPathFor(session.name));
    if (document.parsed === null || !document.status.parses) {
      return {
        stories: listStories(this.db, session.id),
        parsed: document.parsed,
        status: document.status,
        synced: false,
      };
    }
    return {
      stories: syncStories(this.db, session.id, document.parsed.stories.map(storyInputOf)),
      parsed: document.parsed,
      status: document.status,
      synced: true,
    };
  }

  /** The accumulated learnings, read from the data volume; `null` if absent. */
  private readProgress(session: Session): string | null {
    try {
      return fs.readFileSync(sessionProgressFile(this.config, session), 'utf8');
    } catch {
      return null;
    }
  }

  private fail(session: Session, message: string): Session {
    logger.warn('build failed', { session: session.id, name: session.name, error: message });
    return updateSession(this.db, session.id, { status: 'failed', lastError: message }) ?? session;
  }

  /**
   * Ends the run without failing it. The PRD is re-read first: an agent that
   * was signalled mid-story may still have finished the previous one, and the
   * file — not the row the loop wrote before starting it — is the truth about
   * what is done.
   */
  private returnToReady(session: Session): Session {
    if (session.status !== 'building') return session;
    try {
      this.readPrd(session);
    } catch (cause) {
      logger.warn('could not re-read the PRD while stopping the build', {
        session: session.id,
        error: describe(cause),
      });
    }
    return updateSession(this.db, session.id, { status: 'ready' }) ?? session;
  }

  private requireSession(sessionId: string): Session {
    const session = getSession(this.db, sessionId);
    if (session === null) {
      throw new BuildError(404, 'session_not_found', 'No such session.');
    }
    return session;
  }

  private toView(session: Session): BuildView {
    const state = this.runs.get(session.id);
    const document = readPrdDocument(
      sessionPrdFile(this.config, session),
      prdPathFor(session.name),
    );
    return {
      sessionId: session.id,
      sessionName: session.name,
      status: session.status,
      running: state !== undefined,
      iteration: state?.iteration ?? 0,
      maxIterations: state?.maxIterations ?? iterationCap(remainingStories(listStories(this.db, session.id))),
      currentStoryId: state?.storyId ?? null,
      attempts: state?.attempts ?? 0,
      stories: listStories(this.db, session.id),
      prd: document.status,
      lastError: session.lastError,
      startedAt: state?.startedAt ?? null,
    };
  }
}

export function createBuildService(
  config: Config,
  db: Database,
  containers: SessionContainers,
  runner: AgentRunner,
  completion: BuildCompletion = new MarkSessionFinished(db),
): BuildService {
  return new BuildService(config, db, containers, runner, completion);
}

/**
 * The story as the prompt needs it: the row knows its id, title and priority,
 * but only the parsed PRD has the description and the acceptance criteria the
 * agent is actually asked to satisfy.
 */
function promptStory(story: Story, parsed: ParsedPrd | null): PrdStory {
  const fromFile = parsed?.stories.find((candidate) => candidate.id === story.storyId);
  return (
    fromFile ?? {
      id: story.storyId,
      title: story.title,
      description: '',
      priority: story.priority,
      status: story.status,
      acceptanceCriteria: [],
      line: 0,
    }
  );
}

function prdBrokenMessage(snapshot: PrdSnapshot): string {
  const errors = snapshot.status.errors
    .map((error) => (error.line > 0 ? `line ${String(error.line)}: ${error.message}` : error.message))
    .join('; ');
  return (
    `${snapshot.status.path} can no longer be read, so the build cannot tell which stories are ` +
    `done. Fix the file and start the build again${errors === '' ? '.' : ` — ${errors}`}`
  );
}

function stalledMessage(story: Story, attempts: number, result: AgentResult): string {
  const how = result.timedOut
    ? `the agent was still running after its time limit`
    : `the agent exited with code ${String(result.exitCode ?? 'unknown')}`;
  const tail = result.output.trim();
  return (
    `${story.storyId} ("${story.title}") made no progress in ${String(attempts)} attempts: ` +
    `no commit was made and its status in prd.md did not change. On the last attempt ${how}.` +
    (tail === '' ? '' : `\n\n${tail}`)
  );
}

/** Waits for `promise`, but never longer than `timeoutMs`. */
async function settle(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([promise, guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
