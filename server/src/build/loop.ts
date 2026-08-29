import type { Story, StoryStatus } from '../db/index.js';

/**
 * The decisions the Ralph loop makes, as pure functions (US-013).
 *
 * Which story is next, whether an iteration achieved anything, and how many
 * iterations a session is allowed are the three things that decide whether a
 * build finishes, stalls or runs away. They are kept out of the service so they
 * can be tested exhaustively without a container, a database or a clock —
 * the same reason `planReconciliation` (US-009) is a pure function.
 */

/** Consecutive fruitless iterations a story gets before the session fails. */
export const MAX_RETRIES = 2;

/** No build gets fewer than this many iterations, however short the PRD. */
export const MIN_ITERATIONS = 10;

/** Head-room over the remaining stories, for the ones that need a second pass. */
export const ITERATION_BUFFER = 0.5;

/**
 * The next story to run: the lowest priority number that is not `done`, with
 * the story id breaking ties so the order never depends on row insertion.
 * `null` means the PRD is finished.
 */
export function selectNextStory(stories: readonly Story[]): Story | null {
  let next: Story | null = null;
  for (const story of stories) {
    if (story.status === 'done') continue;
    if (next === null || story.priority < next.priority || (story.priority === next.priority && story.storyId < next.storyId)) {
      next = story;
    }
  }
  return next;
}

export function remainingStories(stories: readonly Story[]): number {
  return stories.filter((story) => story.status !== 'done').length;
}

/**
 * How many iterations a build may spend: the outstanding stories plus a 50%
 * buffer, never fewer than {@link MIN_ITERATIONS}. It is a runaway guard, not a
 * budget — a loop that needs more than one and a half passes over its own PRD
 * is not converging, and stopping it is cheaper than letting it churn.
 */
export function iterationCap(remaining: number): number {
  return Math.max(MIN_ITERATIONS, Math.ceil(Math.max(remaining, 0) * (1 + ITERATION_BUFFER)));
}

/** What an iteration changed in the world chief-web can observe. */
export interface IterationChange {
  /** The story's `**Status:**` is not what the loop left it at. */
  readonly statusChanged: boolean;
  /** A commit that was not there before the iteration ran. */
  readonly committed: boolean;
  /** The new HEAD, when there is one; `null` otherwise. */
  readonly commitSha: string | null;
  /** Neither of the above: the iteration produced nothing at all. */
  readonly stalled: boolean;
}

/**
 * Did anything happen?
 *
 * `before` is the status the loop itself wrote before starting the agent (it
 * marks the story `in-progress`, as chief does), not the status the story had
 * when it was picked — otherwise the loop would read its own write as progress.
 * A story that vanished from the PRD counts as a change: the file was edited,
 * which is something, and the next iteration will pick whatever is left.
 */
export function classifyIteration(
  before: StoryStatus,
  after: StoryStatus | null,
  headBefore: string | null,
  headAfter: string | null,
): IterationChange {
  const statusChanged = after === null || after !== before;
  const committed = headAfter !== null && headAfter !== headBefore;
  return {
    statusChanged,
    committed,
    commitSha: committed ? headAfter : null,
    stalled: !statusChanged && !committed,
  };
}
