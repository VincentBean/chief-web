import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chiefSystemPrompt } from './prompt.js';

describe('chief system prompt on acting (chief acts at once, US-006)', () => {
  const prompt = chiefSystemPrompt({ language: 'en', snapshot: '' }).replace(/\s+/g, ' ');

  it('acts at once and reports in one sentence, without asking first', () => {
    assert.match(prompt, /Run the tool the operator asked for at once, never ask first/);
    assert.match(prompt, /the session, the state it is now in, or the service's refusal/);
  });

  it('builds a pending session in one reply: mark_ready, then start_build unless the PRD does not parse', () => {
    assert.match(prompt, /Starting the build of a pending session means calling mark_ready and, when it succeeds, start_build in the same reply/);
    assert.match(prompt, /When mark_ready reports parse errors, read them out and do not call start_build/);
  });

  it('takes "build it" without a name as the session named last', () => {
    assert.match(prompt, /"Build it", "bouw maar" or the like without a session name means the session named last in the conversation/);
    assert.match(prompt, /Ask which one only when no session was named/);
  });
});
