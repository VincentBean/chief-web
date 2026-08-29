import type { Session, UpdateSessionInput } from '../db/index.js';
import type { ContainerSummary } from '../docker/index.js';
import { sessionIdOf } from './container.js';

/**
 * Reconciliation (US-009): what the daemon shows against what the database
 * believes, expressed as a plan so it can be unit-tested without Docker.
 *
 * It runs at startup because that is the moment the two can disagree: the stack
 * can be stopped mid-build, and a container can die while nobody is watching.
 */

/** Stored on a session whose container disappeared. Exact wording per US-009. */
export const CONTAINER_LOST_ERROR = 'container lost';

export interface ContainerRemoval {
  readonly containerId: string;
  readonly containerName: string;
  /** `null` when the label points at a session that no longer exists. */
  readonly sessionId: string | null;
  readonly reason: string;
}

export interface SessionCorrection {
  readonly sessionId: string;
  readonly patch: UpdateSessionInput;
  readonly reason: string;
}

export interface ReconciliationPlan {
  readonly remove: readonly ContainerRemoval[];
  readonly correct: readonly SessionCorrection[];
}

/** A session in one of these states has no business owning a container. */
const TERMINAL_STATUSES = new Set(['finished', 'failed']);

/**
 * Pure: given every session and every container labelled with a session id,
 * decide which containers to remove and which sessions to correct.
 *
 * - A container whose session is gone, `finished` or `failed` is removed.
 * - A container that is not running is removed; a stopped runner cannot be
 *   exec'd into, so it is indistinguishable from a missing one.
 * - A `building` session with no running container is `failed`, because its
 *   agent loop died with the container.
 * - Any other session's `container_id` is brought back in line with reality, so
 *   nothing later tries to exec into an id that no longer exists.
 */
export function planReconciliation(
  sessions: readonly Session[],
  containers: readonly ContainerSummary[],
): ReconciliationPlan {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const alive = new Map<string, string>();
  const remove: ContainerRemoval[] = [];

  for (const container of containers) {
    const sessionId = sessionIdOf(container);
    if (sessionId === null) continue;

    const session = byId.get(sessionId);
    const removal = (reason: string): void => {
      remove.push({
        containerId: container.id,
        containerName: container.name,
        sessionId: session === undefined ? null : sessionId,
        reason,
      });
    };

    if (session === undefined) {
      removal('its session no longer exists');
    } else if (TERMINAL_STATUSES.has(session.status)) {
      removal(`its session is ${session.status}`);
    } else if (container.state !== 'running') {
      removal(`the container is ${container.state}`);
    } else if (alive.has(sessionId)) {
      removal('the session already has a running container');
    } else {
      alive.set(sessionId, container.id);
    }
  }

  const correct: SessionCorrection[] = [];
  for (const session of sessions) {
    const containerId = alive.get(session.id);

    if (containerId !== undefined) {
      // A container that outlived the record it was written to: adopt it rather
      // than orphan a perfectly good environment.
      if (session.containerId !== containerId) {
        correct.push({
          sessionId: session.id,
          patch: { containerId },
          reason: 'adopted its running container',
        });
      }
      continue;
    }

    if (session.status === 'building') {
      correct.push({
        sessionId: session.id,
        patch: { status: 'failed', containerId: null, lastError: CONTAINER_LOST_ERROR },
        reason: CONTAINER_LOST_ERROR,
      });
    } else if (session.containerId !== null) {
      correct.push({
        sessionId: session.id,
        patch: { containerId: null },
        reason: 'its container is gone',
      });
    }
  }

  return { remove, correct };
}
