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

/** What {@link parseDependencyAnswer} made of the analysis agent's output. */
export type ParsedDependencyAnswer =
  | { readonly raw: RawPlan; readonly error: null }
  | { readonly raw: null; readonly error: string };

/**
 * Finds the `{"dependencies": {...}}` document in the analysis agent's output
 * (async stories US-005).
 *
 * The output is the rendered log, not the bare answer: tool lines with JSON of
 * their own come before it and a `[claude] finished` line after it. So every
 * fenced block is tried, last first, and then every `{` from the end of the
 * text backwards up to the last `}`; the first candidate that is a document of
 * the right shape wins. A document of the wrong shape is never salvaged.
 */
export function parseDependencyAnswer(output: string): ParsedDependencyAnswer {
  const text = output.trim();
  if (text === '') return { raw: null, error: 'the agent printed nothing' };

  let error = 'the answer was not valid JSON';
  for (const candidate of answerCandidates(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const raw = readRawPlan(parsed);
    if (raw !== null) return { raw, error: null };
    error = 'the answer had no "dependencies" object of story id lists';
  }
  return { raw: null, error };
}

function answerCandidates(text: string): string[] {
  const found: string[] = [];
  for (const fence of [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].reverse()) {
    const block = fence[1]?.trim();
    if (block !== undefined && block !== '') found.push(block);
  }
  const last = text.lastIndexOf('}');
  for (let open = text.lastIndexOf('{', last); open !== -1; open = text.lastIndexOf('{', open - 1)) {
    found.push(text.slice(open, last + 1));
    if (open === 0) break;
  }
  return found;
}

function readRawPlan(parsed: unknown): RawPlan | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const dependencies = (parsed as Record<string, unknown>)['dependencies'];
  if (typeof dependencies !== 'object' || dependencies === null || Array.isArray(dependencies)) return null;
  // No prototype, so a `__proto__` key is just a (bogus) story id.
  const raw = Object.create(null) as Record<string, string[]>;
  for (const [storyId, dependsOn] of Object.entries(dependencies)) {
    if (!Array.isArray(dependsOn) || !dependsOn.every((id) => typeof id === 'string')) return null;
    raw[storyId] = dependsOn;
  }
  return raw;
}

/**
 * The plan as the build log shows it: one line per story, in priority order —
 * `US-003 ← US-001, US-002`, or `US-002 (no dependencies)`.
 */
export function describePlan(stories: readonly PlanStory[], plan: ReadonlyMap<string, readonly string[]>): string[] {
  return inPriorityOrder(stories).map(({ storyId }) => {
    const dependsOn = plan.get(storyId) ?? [];
    return dependsOn.length === 0 ? `${storyId} (no dependencies)` : `${storyId} ← ${dependsOn.join(', ')}`;
  });
}
