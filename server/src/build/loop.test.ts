import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Story } from '../db/index.js';
import { selectRunnableStories } from './loop.js';

function story(storyId: string, priority: number, status: Story['status'] = 'todo'): Story {
  return { id: 0, sessionId: 's', storyId, title: storyId, priority, status, commitSha: null, mergeSha: null, createdAt: '', updatedAt: '' };
}

function ids(stories: readonly Story[]): string[] {
  return stories.map((s) => s.storyId);
}

const NO_PLAN = new Map<string, string[]>();

describe('selectRunnableStories', () => {
  it('returns qualifying stories in priority order, the story id breaking ties', () => {
    const stories = [story('US-009', 2), story('US-003', 3), story('US-004', 2), story('US-001', 1)];
    assert.deepEqual(ids(selectRunnableStories(stories, NO_PLAN, [], [], 10)), ['US-001', 'US-004', 'US-009', 'US-003']);
    assert.deepEqual(ids(selectRunnableStories([...stories].reverse(), NO_PLAN, [], [], 10)), ['US-001', 'US-004', 'US-009', 'US-003']);
  });

  it('skips done, active and waiting stories', () => {
    const stories = [story('US-001', 1, 'done'), story('US-002', 2, 'in-progress'), story('US-003', 3), story('US-004', 4)];
    assert.deepEqual(ids(selectRunnableStories(stories, NO_PLAN, ['US-002'], ['US-003'], 10)), ['US-004']);
  });

  it('returns no more than the free places under the limit', () => {
    const stories = [story('US-001', 1), story('US-002', 2), story('US-003', 3), story('US-004', 4)];
    assert.deepEqual(ids(selectRunnableStories(stories, NO_PLAN, [], [], 2)), ['US-001', 'US-002']);
    assert.deepEqual(ids(selectRunnableStories(stories, NO_PLAN, ['US-001'], [], 3)), ['US-002', 'US-003']);
  });

  it('returns nothing when the limit is reached', () => {
    const stories = [story('US-001', 1, 'in-progress'), story('US-002', 2, 'in-progress'), story('US-003', 3)];
    assert.deepEqual(selectRunnableStories(stories, NO_PLAN, ['US-001', 'US-002'], [], 2), []);
  });

  it('returns nothing, and stops no one, when the limit is lowered below the number running', () => {
    const stories = [story('US-001', 1, 'in-progress'), story('US-002', 2, 'in-progress'), story('US-003', 3, 'in-progress'), story('US-004', 4)];
    const active = ['US-001', 'US-002', 'US-003'];
    assert.deepEqual(selectRunnableStories(stories, NO_PLAN, active, [], 1), []);
    assert.deepEqual(active, ['US-001', 'US-002', 'US-003']);
  });

  it('lets a waiting story free its place', () => {
    const stories = [story('US-001', 1, 'in-progress'), story('US-002', 2, 'in-progress'), story('US-003', 3), story('US-004', 4)];
    assert.deepEqual(ids(selectRunnableStories(stories, NO_PLAN, ['US-001'], ['US-002'], 2)), ['US-003']);
  });

  it('holds back a story until every dependency is done', () => {
    const plan = new Map([
      ['US-003', ['US-001', 'US-002']],
      ['US-004', ['US-001']],
    ]);
    const running = [story('US-001', 1, 'done'), story('US-002', 2, 'in-progress'), story('US-003', 3), story('US-004', 4)];
    assert.deepEqual(ids(selectRunnableStories(running, plan, ['US-002'], [], 10)), ['US-004']);

    const finished = [story('US-001', 1, 'done'), story('US-002', 2, 'done'), story('US-003', 3), story('US-004', 4)];
    assert.deepEqual(ids(selectRunnableStories(finished, plan, [], [], 10)), ['US-003', 'US-004']);
  });

  it('treats a dependency on a story that was removed from the PRD as satisfied', () => {
    const plan = new Map([['US-002', ['US-001', 'US-099']]]);
    const stories = [story('US-001', 1, 'done'), story('US-002', 2)];
    assert.deepEqual(ids(selectRunnableStories(stories, plan, [], [], 10)), ['US-002']);
  });

  it('never starts a blocked story or a story that depends on one', () => {
    const plan = new Map([['US-002', ['US-001']]]);
    const stories = [story('US-001', 1), story('US-002', 2), story('US-003', 3)];
    assert.deepEqual(ids(selectRunnableStories(stories, plan, [], [], 10, ['US-001'])), ['US-003']);
  });
});
