import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describePlan, normalizePlan, parseDependencyAnswer, type PlanStory, sequentialPlan } from './plan.js';

/** Deliberately out of order: plans follow priority, not array position. */
const STORIES: PlanStory[] = [
  { storyId: 'US-003', priority: 3 },
  { storyId: 'US-001', priority: 1 },
  { storyId: 'US-002', priority: 2 },
  { storyId: 'US-004', priority: 4 },
];

const entries = (plan: Map<string, string[]>): [string, string[]][] => [...plan];

const SEQUENTIAL: [string, string[]][] = [
  ['US-001', []],
  ['US-002', ['US-001']],
  ['US-003', ['US-002']],
  ['US-004', ['US-003']],
];

describe('sequentialPlan (async stories US-003)', () => {
  it('chains every story to the one just before it in priority order', () => {
    assert.deepEqual(entries(sequentialPlan(STORIES)), SEQUENTIAL);
  });

  it('is empty for a PRD without stories', () => {
    assert.equal(sequentialPlan([]).size, 0);
  });
});

describe('normalizePlan (async stories US-003)', () => {
  it('keeps a valid plan as it is', () => {
    const result = normalizePlan(STORIES, {
      'US-001': [],
      'US-002': ['US-001'],
      'US-003': [],
      'US-004': ['US-003', 'US-001'],
    });

    assert.equal(result.fallbackReason, null);
    assert.deepEqual(entries(result.plan), [
      ['US-001', []],
      ['US-002', ['US-001']],
      ['US-003', []],
      ['US-004', ['US-001', 'US-003']],
    ]);
  });

  it('gives every story no dependencies for an empty plan', () => {
    const result = normalizePlan(STORIES, {});

    assert.equal(result.fallbackReason, null);
    assert.deepEqual(entries(result.plan), [
      ['US-001', []],
      ['US-002', []],
      ['US-003', []],
      ['US-004', []],
    ]);
  });

  it('drops unknown story ids, as keys and as dependencies', () => {
    const result = normalizePlan(STORIES, {
      'US-002': ['US-001', 'US-099'],
      'US-099': ['US-001'],
    });

    assert.equal(result.fallbackReason, null);
    assert.deepEqual(result.plan.get('US-002'), ['US-001']);
    assert.equal(result.plan.has('US-099'), false);
    assert.deepEqual(result.plan.get('US-003'), [], 'a story missing from the raw plan depends on nothing');
  });

  it('drops a self-dependency and duplicates', () => {
    const result = normalizePlan(STORIES, { 'US-003': ['US-003', 'US-001', 'US-001'] });

    assert.equal(result.fallbackReason, null);
    assert.deepEqual(result.plan.get('US-003'), ['US-001']);
  });

  it('falls back to the sequential chain on a cycle, and says which stories form it', () => {
    const result = normalizePlan(STORIES, {
      'US-002': ['US-003'],
      'US-003': ['US-002'],
      'US-004': ['US-001'],
    });

    assert.equal(result.fallbackReason, 'cycle: US-002, US-003');
    assert.deepEqual(entries(result.plan), SEQUENTIAL, 'the whole raw plan is thrown away');
  });

  it('finds a longer cycle behind an acyclic prefix', () => {
    const result = normalizePlan(STORIES, {
      'US-001': ['US-004'],
      'US-004': ['US-003'],
      'US-003': ['US-002'],
      'US-002': ['US-004'],
    });

    assert.equal(result.fallbackReason, 'cycle: US-002, US-003, US-004');
    assert.deepEqual(entries(result.plan), SEQUENTIAL);
  });

  it('is not fooled by a key inherited from Object.prototype', () => {
    const result = normalizePlan([{ storyId: 'constructor', priority: 1 }], {});
    assert.deepEqual(entries(result.plan), [['constructor', []]]);
  });
});

describe('the analysis agent’s answer (async stories US-005)', () => {
  it('finds the document after tool lines with JSON of their own', () => {
    const output = [
      '[claude] started with opus in /workspace/repo',
      '[tool] Read: {"file_path": "/workspace/repo/a.ts"}',
      '{"dependencies": {"US-002": ["US-001"], "US-003": []}}',
      '[claude] finished (3.0s, 4 turns)',
    ].join('\n');
    const answer = parseDependencyAnswer(output);
    assert.equal(answer.error, null);
    // Spread: the parsed object has no prototype, so a `__proto__` key is inert.
    assert.deepEqual({ ...answer.raw }, { 'US-002': ['US-001'], 'US-003': [] });
  });

  it('reads a fenced answer', () => {
    const answer = parseDependencyAnswer('Here it is:\n```json\n{"dependencies": {"US-001": []}}\n```\n');
    assert.deepEqual({ ...answer.raw }, { 'US-001': [] });
  });

  it('rejects prose, an empty answer and the wrong shape', () => {
    assert.equal(parseDependencyAnswer('No JSON here.').error, 'the answer was not valid JSON');
    assert.equal(parseDependencyAnswer('  ').error, 'the agent printed nothing');
    assert.equal(
      parseDependencyAnswer('{"dependencies": {"US-002": "US-001"}}').error,
      'the answer had no "dependencies" object of story id lists',
    );
    assert.equal(parseDependencyAnswer('{"plan": {}}').raw, null);
  });

  it('describes the plan one line per story, in priority order', () => {
    const plan = new Map([['US-003', ['US-001', 'US-002']]]);
    assert.deepEqual(describePlan(STORIES, plan), [
      'US-001 (no dependencies)',
      'US-002 (no dependencies)',
      'US-003 ← US-001, US-002',
      'US-004 (no dependencies)',
    ]);
  });
});
