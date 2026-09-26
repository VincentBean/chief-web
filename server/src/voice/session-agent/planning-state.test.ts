import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { type Config, loadConfig } from '../../config.js';
import {
  closeDatabase,
  createRepository,
  createSession,
  type Database,
  deleteSession,
  featureBranchFor,
  IN_MEMORY,
  openDatabase,
  type Session,
  updateSession,
  upsertVoiceSessionAgent,
  type VoiceAgentMode,
} from '../../db/index.js';
import { sessionPrdFile } from '../../sessions/index.js';
import { PlanningStates } from './planning-state.js';
import type { DetachedTurnState } from './registry.js';

const PRD = (openQuestions: readonly string[]): string =>
  [
    '# PRD: Demo',
    '',
    '## Introduction',
    '',
    'A demo.',
    '',
    '## User Stories',
    '',
    '### US-001: First',
    '**Status:** todo',
    '**Priority:** 1',
    '**Description:** As a user, I want one.',
    '',
    '**Acceptance Criteria:**',
    '- [ ] It works',
    '',
    '### US-002: Second',
    '**Status:** todo',
    '**Priority:** 2',
    '**Description:** As a user, I want two.',
    '',
    '**Acceptance Criteria:**',
    '- [ ] It works too',
    '',
    ...(openQuestions.length === 0 ? [] : ['## Open Questions', '', ...openQuestions.map((q) => `- ${q}`), '']),
  ].join('\n');

class FakeRegistry {
  readonly states = new Map<string, DetachedTurnState>();
  detachedState(sessionId: string): DetachedTurnState {
    return this.states.get(sessionId) ?? { running: false, lastOutcome: null };
  }
}

describe('planning state', () => {
  let dataDir: string;
  let config: Config;
  let db: Database;
  let registry: FakeRegistry;
  let states: PlanningStates;
  let seq = 0;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-web-planning-state-'));
    config = loadConfig({ DATA_DIR: dataDir });
    db = openDatabase(IN_MEMORY);
    registry = new FakeRegistry();
    states = new PlanningStates({ db, config, registry });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const newSession = (name: string, mode: VoiceAgentMode | null = 'plan'): Session => {
    seq += 1;
    const repository = createRepository(db, {
      name: `shop-api-${String(seq)}`,
      sshUrl: 'git@github.com:acme/shop-api.git',
      githubSlug: 'acme/shop-api',
      defaultBaseBranch: 'main',
    });
    const session = createSession(db, {
      repositoryId: repository.id,
      name,
      baseBranch: 'main',
      prTargetBranch: 'main',
      featureBranch: featureBranchFor(name),
      status: 'pending',
      scheduledStartAt: null,
    });
    if (mode !== null) upsertVoiceSessionAgent(db, { sessionId: session.id, claudeSessionId: `claude-${name}`, mode });
    return session;
  };

  const writePrd = (session: Session, content: string, mtime?: Date): void => {
    const file = sessionPrdFile(config, session);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    if (mtime !== undefined) fs.utimesSync(file, mtime, mtime);
  };

  describe('planningState', () => {
    it('is briefing while there is no PRD and no detached work', () => {
      const session = newSession('csv-export');
      const state = states.planningState(session.id);
      assert.ok(state !== null);
      assert.equal(state.sessionId, session.id);
      assert.equal(state.sessionName, 'csv-export');
      assert.match(state.repositoryName, /^shop-api-\d+$/);
      assert.equal(state.state, 'briefing');
      assert.deepEqual(state.openQuestions, []);
      assert.equal(state.stories, 0);
      assert.ok(state.updatedAt >= session.updatedAt);
    });

    it('is drafting while a detached turn runs, whatever the PRD says', () => {
      const session = newSession('csv-export');
      writePrd(session, PRD([]));
      registry.states.set(session.id, { running: true, lastOutcome: 'error' });
      assert.equal(states.planningState(session.id)?.state, 'drafting');
    });

    for (const outcome of ['error', 'timeout'] as const) {
      it(`is failed after a detached turn ended in ${outcome}`, () => {
        const session = newSession('csv-export');
        writePrd(session, PRD([]));
        registry.states.set(session.id, { running: false, lastOutcome: outcome });
        assert.equal(states.planningState(session.id)?.state, 'failed');
      });
    }

    it('is done when the PRD parses with no open questions', () => {
      const session = newSession('csv-export');
      writePrd(session, PRD([]));
      registry.states.set(session.id, { running: false, lastOutcome: 'ok' });
      const state = states.planningState(session.id);
      assert.equal(state?.state, 'done');
      assert.equal(state.stories, 2);
      assert.deepEqual(state.openQuestions, []);
    });

    it('is waiting when the PRD has open questions', () => {
      const session = newSession('csv-export');
      writePrd(session, PRD(['Which delimiter?', 'Include archived orders?']));
      const state = states.planningState(session.id);
      assert.equal(state?.state, 'waiting');
      assert.deepEqual(state.openQuestions, ['Which delimiter?', 'Include archived orders?']);
      assert.equal(state.stories, 2);
    });

    it('is waiting when the PRD exists but does not parse', () => {
      const session = newSession('csv-export');
      writePrd(session, '### US-001: Broken\n**Status:** maybe\n');
      assert.equal(states.planningState(session.id)?.state, 'waiting');
    });

    it('reads the PRD from disk on every call', () => {
      const session = newSession('csv-export');
      writePrd(session, PRD(['Which delimiter?']));
      assert.equal(states.planningState(session.id)?.state, 'waiting');
      writePrd(session, PRD([]));
      const state = states.planningState(session.id);
      assert.equal(state?.state, 'done');
      assert.deepEqual(state.openQuestions, []);
    });

    it('takes the PRD modification time as updatedAt when it is the latest', () => {
      const session = newSession('csv-export');
      const later = new Date(Date.now() + 60_000);
      writePrd(session, PRD([]), later);
      assert.equal(states.planningState(session.id)?.updatedAt, later.toISOString());
    });

    it('is null for a session that is not a planning session', () => {
      assert.equal(states.planningState('nope'), null);
      assert.equal(states.planningState(newSession('no-call', null).id), null);
      assert.equal(states.planningState(newSession('qa-call', 'qa').id), null);
      const ready = newSession('ready');
      updateSession(db, ready.id, { status: 'ready' });
      assert.equal(states.planningState(ready.id), null);
    });
  });

  describe('listPlanningSessions', () => {
    it('lists pending plan-mode sessions, most recently updated first', () => {
      const older = newSession('older');
      const newer = newSession('newer');
      writePrd(older, PRD(['A?']), new Date(Date.now() + 60_000));
      writePrd(newer, PRD([]), new Date(Date.now() + 120_000));
      newSession('no-call', null);
      newSession('qa-call', 'qa');
      const ready = newSession('ready');
      updateSession(db, ready.id, { status: 'ready' });
      const failed = newSession('failed');
      updateSession(db, failed.id, { status: 'failed' });
      const deleted = newSession('deleted');
      deleteSession(db, deleted.id);

      const listed = states.listPlanningSessions();
      assert.deepEqual(
        listed.map((s) => [s.sessionName, s.state]),
        [
          ['newer', 'done'],
          ['older', 'waiting'],
        ],
      );
    });

    it('is empty when there are no planning sessions', () => {
      assert.deepEqual(states.listPlanningSessions(), []);
    });
  });
});
