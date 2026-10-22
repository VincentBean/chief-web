import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  clearDependencyPlan,
  closeDatabase,
  createRepository,
  createSession,
  type Database,
  deleteSession,
  getDependencyPlan,
  getDependencyPlanOrigin,
  getDependencyPlanStoryIds,
  IN_MEMORY,
  openDatabase,
  replaceDependencyPlan,
  type Session,
} from './index.js';

const fresh = (): { db: Database; session: Session } => {
  const db = openDatabase(IN_MEMORY);
  const repositoryId = createRepository(db, {
    name: 'demo',
    sshUrl: 'git@github.com:acme/demo.git',
    githubSlug: 'acme/demo',
  }).id;
  const session = createSession(db, { repositoryId, name: 'parallel', baseBranch: 'main', prTargetBranch: 'main' });
  return { db, session };
};

const edgeCount = (db: Database, sessionId: string): number =>
  Number(
    db.prepare('SELECT COUNT(*) AS n FROM story_dependencies WHERE session_id = ?').get(sessionId)?.n ?? -1,
  );

describe('story dependencies (async stories US-003)', () => {
  it('starts with no plan', () => {
    const { db, session } = fresh();
    assert.equal(getDependencyPlan(db, session.id).size, 0);
    assert.deepEqual(getDependencyPlanOrigin(db, session.id), { source: null, reason: null });
    closeDatabase(db);
  });

  it('stores a plan and reads it back; stories without dependencies are not keys', () => {
    const { db, session } = fresh();
    replaceDependencyPlan(
      db,
      session.id,
      new Map([
        ['US-001', []],
        ['US-002', ['US-001']],
        ['US-003', ['US-002', 'US-001']],
      ]),
      'agent',
    );

    assert.deepEqual(
      [...getDependencyPlan(db, session.id)],
      [
        ['US-002', ['US-001']],
        ['US-003', ['US-001', 'US-002']],
      ],
    );
    assert.deepEqual(getDependencyPlanOrigin(db, session.id), { source: 'agent', reason: null });
    closeDatabase(db);
  });

  it('replaces the whole plan, origin included', () => {
    const { db, session } = fresh();
    replaceDependencyPlan(db, session.id, new Map([['US-003', ['US-001']]]), 'agent');
    replaceDependencyPlan(db, session.id, new Map([['US-002', ['US-001']]]), 'fallback', 'cycle: US-002, US-003');

    assert.deepEqual([...getDependencyPlan(db, session.id)], [['US-002', ['US-001']]]);
    assert.deepEqual(getDependencyPlanOrigin(db, session.id), {
      source: 'fallback',
      reason: 'cycle: US-002, US-003',
    });
    closeDatabase(db);
  });

  it('keeps the old plan when a replacement fails half way', () => {
    const { db, session } = fresh();
    replaceDependencyPlan(db, session.id, new Map([['US-002', ['US-001']]]), 'agent');
    const broken = new Map<string, string[]>([['US-003', ['US-001']]]);
    // A dependency that is not a string makes the INSERT throw after the DELETE ran.
    broken.set('US-004', [{} as unknown as string]);

    assert.throws(() => {
      replaceDependencyPlan(db, session.id, broken, 'fallback', 'nope');
    });
    assert.deepEqual([...getDependencyPlan(db, session.id)], [['US-002', ['US-001']]]);
    assert.deepEqual(getDependencyPlanOrigin(db, session.id), { source: 'agent', reason: null });
    closeDatabase(db);
  });

  it('keeps sessions apart', () => {
    const { db, session } = fresh();
    const other = createSession(db, {
      repositoryId: session.repositoryId,
      name: 'other',
      baseBranch: 'main',
      prTargetBranch: 'main',
    });
    replaceDependencyPlan(db, session.id, new Map([['US-002', ['US-001']]]), 'agent');
    replaceDependencyPlan(db, other.id, new Map([['US-003', ['US-002']]]), 'agent');
    clearDependencyPlan(db, other.id);

    assert.deepEqual([...getDependencyPlan(db, session.id)], [['US-002', ['US-001']]]);
    assert.equal(getDependencyPlan(db, other.id).size, 0);
    closeDatabase(db);
  });

  it('clears the plan and its origin', () => {
    const { db, session } = fresh();
    replaceDependencyPlan(db, session.id, new Map([['US-002', ['US-001']]]), 'fallback', 'timeout');
    clearDependencyPlan(db, session.id);

    assert.equal(getDependencyPlan(db, session.id).size, 0);
    assert.deepEqual(getDependencyPlanOrigin(db, session.id), { source: null, reason: null });
    closeDatabase(db);
  });

  it('goes with its session', () => {
    const { db, session } = fresh();
    replaceDependencyPlan(db, session.id, new Map([['US-002', ['US-001']]]), 'agent');
    deleteSession(db, session.id);

    assert.equal(edgeCount(db, session.id), 0);
    closeDatabase(db);
  });

  it('remembers the story ids a plan was made for, sorted, until it is cleared (US-005)', () => {
    const { db, session } = fresh();
    assert.equal(getDependencyPlanStoryIds(db, session.id), null);
    replaceDependencyPlan(db, session.id, new Map(), 'agent', null, ['US-002', 'US-001']);
    assert.deepEqual(getDependencyPlanStoryIds(db, session.id), ['US-001', 'US-002']);
    // A plan stored without them says nothing about which stories it covers.
    replaceDependencyPlan(db, session.id, new Map(), 'agent');
    assert.equal(getDependencyPlanStoryIds(db, session.id), null);
    replaceDependencyPlan(db, session.id, new Map(), 'agent', null, ['US-001']);
    clearDependencyPlan(db, session.id);
    assert.equal(getDependencyPlanStoryIds(db, session.id), null);
    closeDatabase(db);
  });
});
