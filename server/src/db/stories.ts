import {
  changeCount,
  type Database,
  enumeration,
  integer,
  nowIso,
  nullableText,
  type Row,
  text,
  withTransaction,
} from './sqlite.js';

export const STORY_STATUSES = ['todo', 'in-progress', 'done'] as const;
export type StoryStatus = (typeof STORY_STATUSES)[number];

/** One user story of a session's parsed `prd.md`. */
export interface Story {
  /** Surrogate row id; the PRD identifier is `storyId`. */
  readonly id: number;
  readonly sessionId: string;
  /** Identifier from the PRD, e.g. `US-001`. */
  readonly storyId: string;
  readonly title: string;
  readonly priority: number;
  readonly status: StoryStatus;
  /** SHA of the commit that completed the story, when known. */
  readonly commitSha: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Shape produced by the PRD parser (US-011) and fed into {@link syncStories}. */
export interface StoryInput {
  readonly storyId: string;
  readonly title: string;
  readonly priority: number;
  readonly status: StoryStatus;
  readonly commitSha?: string | null;
}

export interface UpdateStoryInput {
  readonly title?: string;
  readonly priority?: number;
  readonly status?: StoryStatus;
  readonly commitSha?: string | null;
}

const COLUMNS: Record<keyof UpdateStoryInput, string> = {
  title: 'title',
  priority: 'priority',
  status: 'status',
  commitSha: 'commit_sha',
};

export function mapStory(row: Row): Story {
  return {
    id: integer(row, 'id'),
    sessionId: text(row, 'session_id'),
    storyId: text(row, 'story_id'),
    title: text(row, 'title'),
    priority: integer(row, 'priority'),
    status: enumeration(row, 'status', STORY_STATUSES),
    commitSha: nullableText(row, 'commit_sha'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
}

export function listStories(db: Database, sessionId: string): Story[] {
  return db
    .prepare('SELECT * FROM stories WHERE session_id = ? ORDER BY priority ASC, story_id ASC')
    .all(sessionId)
    .map(mapStory);
}

/** A session's story progress: `done` of `total` are complete (US-015). */
export interface StoryCounts {
  readonly total: number;
  readonly done: number;
}

/**
 * Counts a session's stories in one aggregate, so the dashboard can show
 * `4/9 done` for every session without loading each story list.
 */
export function countStories(db: Database, sessionId: string): StoryCounts {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) AS done
         FROM stories WHERE session_id = ?`,
    )
    .get(sessionId);
  return row === undefined
    ? { total: 0, done: 0 }
    : { total: integer(row, 'total'), done: integer(row, 'done') };
}

export function getStory(db: Database, sessionId: string, storyId: string): Story | null {
  const row = db
    .prepare('SELECT * FROM stories WHERE session_id = ? AND story_id = ?')
    .get(sessionId, storyId);
  return row ? mapStory(row) : null;
}

/** The next story the build loop should run: lowest priority number, not done. */
export function nextIncompleteStory(db: Database, sessionId: string): Story | null {
  const row = db
    .prepare(
      `SELECT * FROM stories
        WHERE session_id = ? AND status <> 'done'
        ORDER BY priority ASC, story_id ASC
        LIMIT 1`,
    )
    .get(sessionId);
  return row ? mapStory(row) : null;
}

/**
 * Replaces a session's story list with the freshly parsed one: new stories are
 * inserted, existing ones updated in place (keeping their commit SHA unless the
 * caller supplies a new one), and stories no longer in the PRD are removed.
 */
export function syncStories(db: Database, sessionId: string, stories: readonly StoryInput[]): Story[] {
  const now = nowIso();

  withTransaction(db, () => {
    const upsert = db.prepare(
      `INSERT INTO stories
         (session_id, story_id, title, priority, status, commit_sha, created_at, updated_at)
       VALUES (:session_id, :story_id, :title, :priority, :status, :commit_sha, :now, :now)
       ON CONFLICT (session_id, story_id) DO UPDATE SET
         title      = excluded.title,
         priority   = excluded.priority,
         status     = excluded.status,
         commit_sha = COALESCE(excluded.commit_sha, stories.commit_sha),
         updated_at = excluded.updated_at`,
    );

    for (const story of stories) {
      upsert.run({
        ':session_id': sessionId,
        ':story_id': story.storyId,
        ':title': story.title,
        ':priority': story.priority,
        ':status': story.status,
        ':commit_sha': story.commitSha ?? null,
        ':now': now,
      });
    }

    const keep = stories.map((story) => story.storyId);
    const placeholders = keep.map(() => '?').join(', ');
    db.prepare(
      keep.length > 0
        ? `DELETE FROM stories WHERE session_id = ? AND story_id NOT IN (${placeholders})`
        : 'DELETE FROM stories WHERE session_id = ?',
    ).run(sessionId, ...keep);
  });

  return listStories(db, sessionId);
}

/** Applies the provided fields only; returns the updated row, or null if absent. */
export function updateStory(
  db: Database,
  sessionId: string,
  storyId: string,
  patch: UpdateStoryInput,
): Story | null {
  const assignments: string[] = [];
  const params: Record<string, string | number | null> = {
    ':session_id': sessionId,
    ':story_id': storyId,
    ':updated_at': nowIso(),
  };

  for (const [field, column] of Object.entries(COLUMNS)) {
    const value = patch[field as keyof UpdateStoryInput];
    if (value === undefined) continue;
    assignments.push(`${column} = :${column}`);
    params[`:${column}`] = value;
  }

  if (assignments.length > 0) {
    assignments.push('updated_at = :updated_at');
    db.prepare(
      `UPDATE stories SET ${assignments.join(', ')}
        WHERE session_id = :session_id AND story_id = :story_id`,
    ).run(params);
  }

  return getStory(db, sessionId, storyId);
}

export function deleteStories(db: Database, sessionId: string): number {
  return changeCount(db.prepare('DELETE FROM stories WHERE session_id = ?').run(sessionId));
}
