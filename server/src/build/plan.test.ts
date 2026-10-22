import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizePlan, type PlanStory, sequentialPlan } from './plan.js';

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
