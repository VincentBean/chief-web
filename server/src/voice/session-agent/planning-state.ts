import type { Config } from '../../config.js';
import {
  type Database,
  getRepository,
  getSession,
  getVoiceSessionAgent,
  listVoiceSessionAgents,
  type Session,
  type VoiceSessionAgent,
} from '../../db/index.js';
import { prdPathFor, readPrdDocument } from '../../prd/index.js';
import { sessionPrdFile } from '../../sessions/index.js';
import type { DetachedTurnState } from './registry.js';

/**
 * Where a planning session (a `pending` session with a `plan` mode voice
 * conversation) stands, in the one place chief, the call and the panel read
 * it from. Derived on every read: the detached-turn half from the registry's
 * memory, the rest from `prd.md` on disk, so an edit made in the planning
 * terminal counts as much as one the agent made.
 */
export type PlanningStateName = 'briefing' | 'drafting' | 'waiting' | 'done' | 'failed';

export interface PlanningState {
  readonly sessionId: string;
  readonly sessionName: string;
  readonly repositoryName: string;
  readonly state: PlanningStateName;
  readonly openQuestions: string[];
  readonly stories: number;
  /** The latest of the session row, its voice conversation and `prd.md`, ISO-8601 UTC. */
  readonly updatedAt: string;
}

export interface PlanningStateDeps {
  readonly db: Database;
  readonly config: Pick<Config, 'workspacesDir'>;
  /** The session agent registry, as far as detached turns go. */
  readonly registry: { detachedState(sessionId: string): DetachedTurnState };
}

/** The planning states, bound to the database, the workspaces and the registry. */
export class PlanningStates {
  constructor(private readonly deps: PlanningStateDeps) {}

  /** The session's planning state; `null` when it is not a planning session. */
  planningState(sessionId: string): PlanningState | null {
    const session = getSession(this.deps.db, sessionId);
    const agent = getVoiceSessionAgent(this.deps.db, sessionId);
    if (session === null || agent === null) return null;
    return stateOf(session, agent, this.deps);
  }

  /** Every planning session, most recently updated first. */
  listPlanningSessions(): PlanningState[] {
    const states: PlanningState[] = [];
    for (const agent of listVoiceSessionAgents(this.deps.db)) {
      const session = getSession(this.deps.db, agent.sessionId);
      if (session === null) continue;
      const state = stateOf(session, agent, this.deps);
      if (state !== null) states.push(state);
    }
    return states.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

function stateOf(session: Session, agent: VoiceSessionAgent, deps: PlanningStateDeps): PlanningState | null {
  if (session.status !== 'pending' || agent.mode !== 'plan') return null;
  const { status, parsed } = readPrdDocument(sessionPrdFile(deps.config, session), prdPathFor(session.name));
  const openQuestions = parsed === null ? [] : [...parsed.openQuestions];
  const detached = deps.registry.detachedState(session.id);

  let state: PlanningStateName;
  if (detached.running) state = 'drafting';
  else if (detached.lastOutcome === 'error' || detached.lastOutcome === 'timeout') state = 'failed';
  else if (status.parses && openQuestions.length === 0) state = 'done';
  else if (status.exists) state = 'waiting';
  else state = 'briefing';

  return {
    sessionId: session.id,
    sessionName: session.name,
    repositoryName: getRepository(deps.db, session.repositoryId)?.name ?? session.repositoryId,
    state,
    openQuestions,
    stories: status.storyCount,
    updatedAt: [session.updatedAt, agent.updatedAt, status.updatedAt ?? ''].reduce((a, b) => (b > a ? b : a)),
  };
}
