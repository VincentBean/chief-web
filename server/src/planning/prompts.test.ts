import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { voicePlanningPrompt } from '../voice/session-agent/prompt.js';
import {
  DEFAULT_CONTEXT,
  FEEDBACK_BLOCK_HEADING,
  FEEDBACK_CONTEXT,
  MAX_CONTEXT_LENGTH,
  planningPrompt,
} from './prompts.js';

const INPUT = {
  sessionName: 'fix-billing',
  featureBranch: 'chief/fix-billing',
  repositoryName: 'demo',
};

/** Deliberately awkward: a fence, a story heading and a quote must all come through as typed. */
const FEEDBACK =
  'The billing page shows €0,00 after I change the plan.\n```\n### US-009: not a story\n```\nSee "Invoices" too.';

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('feedback planning prompt', () => {
  for (const mode of ['create', 'edit'] as const) {
    it(`quotes the feedback verbatim, exactly once, in ${mode} mode`, () => {
      const prompt = planningPrompt(mode, { ...INPUT, feedback: FEEDBACK });

      assert.equal(occurrences(prompt, FEEDBACK_BLOCK_HEADING), 1);
      assert.equal(occurrences(prompt, `<feedback>\n${FEEDBACK}\n</feedback>`), 1);
      assert.equal(occurrences(prompt, FEEDBACK), 1);
    });
  }

  it('asks for reproduction and a ## Feedback section before the stories', () => {
    const prompt = planningPrompt('create', { ...INPUT, feedback: FEEDBACK });

    assert.match(prompt, /Find where the feedback lives in the code/);
    assert.match(prompt, /When a browser is available to you, reproduce the problem before writing any story/);
    assert.match(prompt, /`## Feedback` section after the introduction and before the first story/);
    assert.match(prompt, /the feedback above, verbatim/);
    assert.match(prompt, /the pages visited, as paths only/);
    assert.match(prompt, /never write credentials into the PRD/);
    assert.match(prompt, /the reproduction steps/);
    assert.match(prompt, /what was observed/);
  });

  it('replaces chief’s "what do you want to build" default in the context slot', () => {
    const prompt = planningPrompt('create', { ...INPUT, feedback: FEEDBACK });

    assert.equal(prompt.includes(DEFAULT_CONTEXT), false);
    assert.equal(occurrences(prompt, FEEDBACK_CONTEXT), 1);
  });

  it('keeps operator-typed context next to the feedback', () => {
    const prompt = planningPrompt('create', { ...INPUT, context: 'Only the plan switcher.', feedback: FEEDBACK });

    assert.match(prompt, /Only the plan switcher\./);
    assert.equal(prompt.includes(FEEDBACK_CONTEXT), false);
    assert.equal(occurrences(prompt, FEEDBACK), 1);
  });

  it('trims the feedback and cuts it at MAX_CONTEXT_LENGTH', () => {
    const long = 'a'.repeat(MAX_CONTEXT_LENGTH) + 'TAIL';
    const prompt = planningPrompt('create', { ...INPUT, feedback: `  ${long}  ` });

    assert.equal(occurrences(prompt, `<feedback>\n${'a'.repeat(MAX_CONTEXT_LENGTH)}\n</feedback>`), 1);
    assert.equal(prompt.includes('TAIL'), false);
  });

  for (const feedback of [undefined, null, '', '   ']) {
    it(`is the plain planning prompt without feedback (${JSON.stringify(feedback)})`, () => {
      const prompt = planningPrompt('create', { ...INPUT, feedback });

      assert.equal(prompt, planningPrompt('create', INPUT));
      assert.equal(prompt.includes(FEEDBACK_BLOCK_HEADING), false);
      assert.equal(prompt.includes(DEFAULT_CONTEXT), true);
    });
  }
});

describe('voice feedback planning prompt', () => {
  it('opens a feedback session with one question about the feedback', () => {
    const prompt = voicePlanningPrompt('create', { ...INPUT, feedback: FEEDBACK });

    assert.equal(occurrences(prompt, FEEDBACK), 1);
    assert.match(prompt, /asking one question about the feedback quoted above; do not ask what they want to build\.$/);
  });

  it('does so in edit mode too', () => {
    const prompt = voicePlanningPrompt('edit', { ...INPUT, feedback: FEEDBACK });

    assert.match(prompt, /asking one question about the feedback quoted above/);
    assert.doesNotMatch(prompt, /asking what they want to change in the PRD/);
  });

  it('still asks what to build without feedback', () => {
    const prompt = voicePlanningPrompt('create', INPUT);

    assert.match(prompt, /asking what they want to build\.$/);
    assert.equal(prompt.includes(FEEDBACK_BLOCK_HEADING), false);
  });
});
