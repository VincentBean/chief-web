import {
  changeCount,
  type Database,
  enumeration,
  nowIso,
  nullableInteger,
  nullableText,
  type Row,
  text,
} from './sqlite.js';

/**
 * One question a build agent asked the operator (decisions US-001).
 *
 * The build loop's five stop conditions all assume the agent can finish what
 * it started. A decision only the operator can make is the one thing it cannot
 * work around: left to itself an agent either guesses — and a guess that turns
 * out wrong is a story's worth of work thrown away — or stalls, which the loop
 * reads as a failed attempt and spends the story's retries on. So the agent
 * asks, and the row below is the question, standing on its own so the session
 * page can show it, the "Discuss this" terminal can read it, and the answer
 * survives as a record of why the work went the way it did.
 */
export const DECISION_STATUSES = [
  /** Asked, with the agent still waiting on it. */
  'open',
  'answered',
  /**
   * Nobody answered in time: the agent's own wait ran out, so it was told to
   * take the most conservative reading and carry on.
   */
  'expired',
  /**
   * The question outlived the agent that asked it — the build was stopped, the
   * iteration ended, or the server was restarted — so there is nothing left
   * waiting for an answer.
   */
  'abandoned',
] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export interface Decision {
  /** The MCP request id: it names the request and answer files in the container. */
  readonly id: string;
  readonly sessionId: string;
  /** The story the iteration was on; `null` when the loop had not picked one. */
  readonly storyId: string | null;
  readonly iteration: number | null;
  readonly question: string;
  /** The choices the agent offered, in its order; empty when it offered none. */
  readonly options: readonly string[];
  /** What the agent had established and why it matters; `null` when it said nothing. */
  readonly context: string | null;
  /** Which option the agent would take unasked; `null` when it had no preference. */
  readonly recommendation: string | null;
  readonly status: DecisionStatus;
  /** The operator's answer, verbatim, once there is one. */
  readonly answer: string | null;
  readonly askedAt: string;
  readonly closedAt: string | null;
}

export interface AskDecisionInput {
  readonly id: string;
  readonly sessionId: string;
  readonly storyId?: string | null;
  readonly iteration?: number | null;
  readonly question: string;
  readonly options?: readonly string[];
  readonly context?: string | null;
  readonly recommendation?: string | null;
}

export function mapDecision(row: Row): Decision {
  return {
    id: text(row, 'id'),
    sessionId: text(row, 'session_id'),
    storyId: nullableText(row, 'story_id'),
    iteration: nullableInteger(row, 'iteration'),
    question: text(row, 'question'),
    options: parseOptions(nullableText(row, 'options')),
    context: nullableText(row, 'context'),
    recommendation: nullableText(row, 'recommendation'),
    status: enumeration(row, 'status', DECISION_STATUSES),
    answer: nullableText(row, 'answer'),
    askedAt: text(row, 'asked_at'),
    closedAt: nullableText(row, 'closed_at'),
  };
}

/**
 * Records the question. The id comes from the MCP server, so inserting the
 * same request twice — a relay that found a file it had already read — is the
 * row that is already there rather than a second question.
 */
export function askDecision(db: Database, input: AskDecisionInput): Decision {
  const existing = getDecision(db, input.id);
  if (existing !== null) return existing;
  db.prepare(
    `INSERT INTO decisions (
       id, session_id, story_id, iteration, question, options, context, recommendation,
       status, answer, asked_at, closed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, NULL)`,
  ).run(
    input.id,
    input.sessionId,
    input.storyId ?? null,
    input.iteration ?? null,
    input.question,
    input.options === undefined || input.options.length === 0 ? null : JSON.stringify(input.options),
    input.context ?? null,
    input.recommendation ?? null,
    nowIso(),
  );
  return getDecision(db, input.id) as Decision;
}

export function getDecision(db: Database, id: string): Decision | null {
  const row = db.prepare('SELECT * FROM decisions WHERE id = ?').get(id);
  return row === undefined ? null : mapDecision(row);
}

/**
 * The question this session is waiting on, or `null`. A session has at most
 * one: its agent is blocked on the one it asked, so there is nobody left to
 * ask a second.
 */
export function getOpenDecision(db: Database, sessionId: string): Decision | null {
  const row = db
    .prepare("SELECT * FROM decisions WHERE session_id = ? AND status = 'open' ORDER BY asked_at DESC LIMIT 1")
    .get(sessionId);
  return row === undefined ? null : mapDecision(row);
}

/** Every question this session has asked, newest first. */
export function listDecisions(db: Database, sessionId: string): Decision[] {
  return db
    .prepare('SELECT * FROM decisions WHERE session_id = ? ORDER BY asked_at DESC')
    .all(sessionId)
    .map(mapDecision);
}

/**
 * Closes an open question. Returns the row as it now stands, or `null` when it
 * was not open any more — two operators pressing *Answer* at once, or an
 * answer that arrives just after the agent's wait ran out, so the caller can
 * tell that its answer is not the one that counted.
 */
export function closeDecision(
  db: Database,
  id: string,
  status: Exclude<DecisionStatus, 'open'>,
  answer: string | null = null,
): Decision | null {
  const changed = db
    .prepare("UPDATE decisions SET status = ?, answer = ?, closed_at = ? WHERE id = ? AND status = 'open'")
    .run(status, answer, nowIso(), id);
  return changeCount(changed) === 0 ? null : getDecision(db, id);
}

/**
 * Closes every open question of a session; returns how many. The sweep for a
 * run that is over, whatever ended it.
 */
export function abandonDecisions(db: Database, sessionId: string): number {
  const changed = db
    .prepare("UPDATE decisions SET status = 'abandoned', closed_at = ? WHERE session_id = ? AND status = 'open'")
    .run(nowIso(), sessionId);
  return changeCount(changed);
}

/** Open questions across every session: what reconciliation sweeps at startup. */
export function listOpenDecisions(db: Database): Decision[] {
  return db.prepare("SELECT * FROM decisions WHERE status = 'open' ORDER BY asked_at ASC").all().map(mapDecision);
}

/** Stored as a JSON array; anything else is read as no options at all. */
function parseOptions(raw: string | null): readonly string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((option): option is string => typeof option === 'string') : [];
  } catch {
    return [];
  }
}
