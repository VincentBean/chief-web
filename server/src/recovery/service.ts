import type { BuildService, BuildView } from '../build/index.js';
import {
  type Database,
  type FailureStage,
  failureStageLabel,
  getSession,
  listStories,
  type Session,
  type SessionStatus,
  type Story,
} from '../db/index.js';
import type { DeliveryResult, DeliveryService } from '../delivery/index.js';
import { logger } from '../lib/logger.js';

/**
 * "Retry" on a failed session (US-019).
 *
 * A failed session has two possible ways back, and picking the wrong one is
 * expensive: rerunning the loop on a session whose *push* failed would spend
 * agent iterations on stories that are already done, and re-pushing a session
 * whose *agent* stalled would open a pull request for half a feature. So the
 * server decides, from the stage stored when the session failed, and the UI
 * only has to offer one button.
 *
 * Neither path redoes work. The build resumes at the first story `prd.md` does
 * not call done — everything committed stays committed — and the delivery
 * re-runs the push and the pull request against commits that already exist.
 */

/** A failure with the HTTP status and code the route should answer with. */
export class RetryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RetryError';
  }
}

/** Which of the two recoveries a session needs. */
export type RetryAction = 'build' | 'delivery';

export interface RetryPlan {
  readonly action: RetryAction;
  /** The stage the session failed at; `null` for a row that predates them. */
  readonly stage: FailureStage | null;
  /** Why this is the right resumption point, in the operator's words. */
  readonly reason: string;
}

/** What a retry answers with: the plan, plus whichever view it produced. */
export interface RetryResult {
  readonly ok: boolean;
  readonly sessionId: string;
  readonly action: RetryAction;
  readonly stage: FailureStage | null;
  readonly status: SessionStatus;
  readonly prUrl: string | null;
  readonly message: string;
  /** The build state, when the retry restarted the loop; `null` otherwise. */
  readonly build: BuildView | null;
  /** The delivery outcome, when the retry re-ran push and PR; else `null`. */
  readonly delivery: DeliveryResult | null;
}

/**
 * Where to resume, from the stage the session failed at (US-019).
 *
 * Pure, so every branch is testable without a container: `push` and
 * `pull_request` mean the work is committed and only the delivery has to run
 * again; anything else means the loop has stories left. A session that failed
 * before chief-web recorded stages has only its story list as evidence, so it
 * is read the same way the UI used to guess: all stories done means delivery.
 */
export function planRetry(
  session: Pick<Session, 'failureStage'>,
  stories: readonly Story[],
): RetryPlan {
  const outstanding = stories.filter((story) => story.status !== 'done').length;
  const stage = session.failureStage;

  if (stage === 'push' || stage === 'pull_request') {
    return {
      action: 'delivery',
      stage,
      reason:
        `The build finished; ${failureStageLabel(stage)} is what failed. Retrying re-runs the ` +
        'push and the pull request only — no story is built again.',
    };
  }

  if (stage !== null) {
    return {
      action: 'build',
      stage,
      reason:
        `${capitalise(failureStageLabel(stage))} is what failed, so the loop starts again at the ` +
        `first story that is not done (${String(outstanding)} of ${String(stories.length)} left).`,
    };
  }

  // No stage recorded: this session failed before US-019, so all that is left
  // to go on is whether there is anything still to build.
  if (stories.length > 0 && outstanding === 0) {
    return {
      action: 'delivery',
      stage: null,
      reason:
        'No stage was recorded, but every story is done, so the only thing left that can have ' +
        'failed is the push or the pull request.',
    };
  }
  return {
    action: 'build',
    stage: null,
    reason:
      'No stage was recorded, so the loop starts again at the first story that is not done ' +
      `(${String(outstanding)} of ${String(stories.length)} left).`,
  };
}

/** The slice of the build loop a retry drives. */
export interface RetryableBuilds {
  start(sessionId: string): Promise<BuildView>;
}

/** The slice of the delivery service a retry drives. */
export interface RetryableDelivery {
  retry(sessionId: string): Promise<DeliveryResult>;
}

export class RetryService {
  constructor(
    private readonly db: Database,
    private readonly builds: RetryableBuilds,
    private readonly delivery: RetryableDelivery,
  ) {}

  /** What "Retry" would do, without doing it — the UI labels its button with it. */
  plan(sessionId: string): RetryPlan {
    const session = this.requireFailed(sessionId);
    return planRetry(session, listStories(this.db, session.id));
  }

  async retry(sessionId: string): Promise<RetryResult> {
    const session = this.requireFailed(sessionId);
    const plan = planRetry(session, listStories(this.db, session.id));

    logger.info('retrying a failed session', {
      session: session.id,
      name: session.name,
      stage: plan.stage,
      action: plan.action,
    });

    if (plan.action === 'delivery') {
      const delivery = await this.delivery.retry(session.id);
      return {
        ok: delivery.ok,
        sessionId: session.id,
        action: 'delivery',
        stage: plan.stage,
        status: delivery.status,
        prUrl: delivery.prUrl,
        message: delivery.message,
        build: null,
        delivery,
      };
    }

    const build = await this.builds.start(session.id);
    const current = getSession(this.db, session.id) ?? session;
    return {
      ok: true,
      sessionId: session.id,
      action: 'build',
      stage: plan.stage,
      status: build.status,
      prUrl: current.prUrl,
      message: build.queued
        ? `Every build slot is taken, so "${session.name}" is queued at #${String(build.queuePosition ?? 1)}. ` +
          'It resumes on its own as soon as one frees.'
        : `Build restarted at the first story that is not done — ${plan.reason}`,
      build,
      delivery: null,
    };
  }

  /**
   * Only a `failed` session is retried here. A `finished` one whose pull
   * request was closed by hand is still delivered through
   * `POST /sessions/:id/delivery`, and everything else is a state, not a
   * failure — saying so is more use than quietly starting something.
   */
  private requireFailed(sessionId: string): Session {
    const session = getSession(this.db, sessionId);
    if (session === null) {
      throw new RetryError(404, 'session_not_found', 'This session no longer exists.');
    }
    if (session.status !== 'failed') {
      throw new RetryError(
        409,
        'session_not_failed',
        `Only a failed session can be retried; "${session.name}" is ${session.status}.`,
      );
    }
    return session;
  }
}

export function createRetryService(
  db: Database,
  builds: BuildService,
  delivery: DeliveryService,
): RetryService {
  return new RetryService(db, builds, delivery);
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
