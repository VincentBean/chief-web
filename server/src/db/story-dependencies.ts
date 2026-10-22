import { type Database, nullableText, text, withTransaction } from './sqlite.js';

/**
 * A session's dependency plan (async stories US-003): which stories each story
 * waits for. The scheduler starts a story once everything it depends on is
 * `done`, so it never has to ask an agent again after the plan is stored.
 */

export const DEPENDENCY_PLAN_SOURCES = ['agent', 'fallback'] as const;
/** `agent`: the analysis agent's plan; `fallback`: the sequential chain. */
export type DependencyPlanSource = (typeof DEPENDENCY_PLAN_SOURCES)[number];

/** Story id → the story ids it depends on. */
export type DependencyPlan = ReadonlyMap<string, readonly string[]>;

/** Where a session's stored plan came from, and why a fallback was used. */
export interface DependencyPlanOrigin {
  /** NULL while the session has no plan. */
  readonly source: DependencyPlanSource | null;
  readonly reason: string | null;
}

/**
 * Replaces a session's whole plan, edges and origin together, in one
 * transaction: a reader sees the old plan or the new one, never a mix.
 */
export function replaceDependencyPlan(
  db: Database,
  sessionId: string,
  plan: DependencyPlan,
  source: DependencyPlanSource,
  reason: string | null = null,
): void {
  withTransaction(db, () => {
    db.prepare('DELETE FROM story_dependencies WHERE session_id = ?').run(sessionId);
    const insert = db.prepare(
      'INSERT OR IGNORE INTO story_dependencies (session_id, story_id, depends_on) VALUES (?, ?, ?)',
    );
    for (const [storyId, dependsOn] of plan) {
      for (const dependency of dependsOn) insert.run(sessionId, storyId, dependency);
    }
    db.prepare('UPDATE sessions SET dependency_plan_source = ?, dependency_plan_reason = ? WHERE id = ?').run(
      source,
      reason,
      sessionId,
    );
  });
}

/**
 * A session's stored plan. Only stories with at least one dependency appear:
 * a story that is not a key depends on nothing.
 */
export function getDependencyPlan(db: Database, sessionId: string): Map<string, string[]> {
  const plan = new Map<string, string[]>();
  const rows = db
    .prepare(
      `SELECT story_id, depends_on FROM story_dependencies
        WHERE session_id = ?
        ORDER BY story_id ASC, depends_on ASC`,
    )
    .all(sessionId);
  for (const row of rows) {
    const storyId = text(row, 'story_id');
    const dependsOn = plan.get(storyId) ?? [];
    dependsOn.push(text(row, 'depends_on'));
    plan.set(storyId, dependsOn);
  }
  return plan;
}

/** Where the session's plan came from; both NULL without a plan or a session. */
export function getDependencyPlanOrigin(db: Database, sessionId: string): DependencyPlanOrigin {
  const row = db
    .prepare('SELECT dependency_plan_source, dependency_plan_reason FROM sessions WHERE id = ?')
    .get(sessionId);
  if (!row) return { source: null, reason: null };
  const source = nullableText(row, 'dependency_plan_source');
  return {
    source: DEPENDENCY_PLAN_SOURCES.find((known) => known === source) ?? null,
    reason: nullableText(row, 'dependency_plan_reason'),
  };
}

/** Forgets a session's plan, edges and origin alike. */
export function clearDependencyPlan(db: Database, sessionId: string): void {
  withTransaction(db, () => {
    db.prepare('DELETE FROM story_dependencies WHERE session_id = ?').run(sessionId);
    db.prepare(
      'UPDATE sessions SET dependency_plan_source = NULL, dependency_plan_reason = NULL WHERE id = ?',
    ).run(sessionId);
  });
}
