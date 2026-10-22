import type { Story } from '../db/index.js';

/**
 * Turning the dependency-analysis agent's answer into a plan the scheduler can
 * trust (async stories US-003). Pure: no database, no agent.
 */

/** What a plan needs to know about a story: its id and where it sits. */
export type PlanStory = Pick<Story, 'storyId' | 'priority'>;

/** The analysis agent's `dependencies` object, before any checking. */
export type RawPlan = Readonly<Record<string, readonly string[]>>;

export interface NormalizedPlan {
  /** Every story is a key; a story with no dependencies maps to `[]`. */
  readonly plan: Map<string, string[]>;
  /** Why the raw plan was discarded for {@link sequentialPlan}; null when kept. */
  readonly fallbackReason: string | null;
}

/** The stories in the order the build loop runs them: priority, then id. */
function inPriorityOrder(stories: readonly PlanStory[]): PlanStory[] {
  return [...stories].sort(
    (a, b) => a.priority - b.priority || (a.storyId < b.storyId ? -1 : a.storyId > b.storyId ? 1 : 0),
  );
}

/** The fallback: each story depends on the one just before it in priority order. */
export function sequentialPlan(stories: readonly PlanStory[]): Map<string, string[]> {
  const plan = new Map<string, string[]>();
  let previous: string | null = null;
  for (const story of inPriorityOrder(stories)) {
    plan.set(story.storyId, previous === null ? [] : [previous]);
    previous = story.storyId;
  }
  return plan;
}

/**
 * Cleans `rawPlan` up against the PRD's stories: unknown ids, self-dependencies
 * and duplicates are dropped, and a story the raw plan leaves out depends on
 * nothing. A cycle cannot be repaired by dropping an edge without guessing, so
 * it discards the whole raw plan for {@link sequentialPlan} and says why.
 */
export function normalizePlan(stories: readonly PlanStory[], rawPlan: RawPlan): NormalizedPlan {
  const ordered = inPriorityOrder(stories);
  const rank = new Map(ordered.map((story, index) => [story.storyId, index]));

  const plan = new Map<string, string[]>();
  for (const { storyId } of ordered) {
    const raw = Object.hasOwn(rawPlan, storyId) ? rawPlan[storyId] : undefined;
    const dependsOn = new Set((raw ?? []).filter((id) => id !== storyId && rank.has(id)));
    plan.set(
      storyId,
      [...dependsOn].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0)),
    );
  }

  const cycle = findCycle(ordered, plan);
  if (cycle !== null) {
    const members = cycle.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
    return { plan: sequentialPlan(stories), fallbackReason: `cycle: ${members.join(', ')}` };
  }
  return { plan, fallbackReason: null };
}

/** The story ids of one cycle in `plan`, or null when it has none. */
function findCycle(ordered: readonly PlanStory[], plan: ReadonlyMap<string, readonly string[]>): string[] | null {
  const finished = new Set<string>();
  const path: string[] = [];
  const onPath = new Set<string>();

  const visit = (storyId: string): string[] | null => {
    path.push(storyId);
    onPath.add(storyId);
    for (const dependency of plan.get(storyId) ?? []) {
      if (onPath.has(dependency)) return path.slice(path.indexOf(dependency));
      if (finished.has(dependency)) continue;
      const cycle = visit(dependency);
      if (cycle !== null) return cycle;
    }
    path.pop();
    onPath.delete(storyId);
    finished.add(storyId);
    return null;
  };

  for (const { storyId } of ordered) {
    if (finished.has(storyId)) continue;
    const cycle = visit(storyId);
    if (cycle !== null) return cycle;
  }
  return null;
}
