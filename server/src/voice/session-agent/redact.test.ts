import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toolCardSummary } from './agent.js';
import { voiceRulesPrompt } from './prompt.js';
import { REDACTED, redactCredentials } from './redact.js';

describe('redactCredentials (voice feedback US-009)', () => {
  it('replaces credential keys at any depth and scrubs their values out of other strings', () => {
    const input = {
      command: 'curl -u ann@example.com:hunter22 https://app.test',
      login: { userName: 'ann@example.com', user_password: 'hunter22' },
      list: [{ passwd: 'hunter22' }, 'hunter22 again'],
      count: 3,
      flag: null,
    };
    assert.deepEqual(redactCredentials(input), {
      command: `curl -u ${REDACTED}:${REDACTED} https://app.test`,
      login: { userName: REDACTED, user_password: REDACTED },
      list: [{ passwd: REDACTED }, `${REDACTED} again`],
      count: 3,
      flag: null,
    });
  });

  it('redacts the value of a form field that is labelled as a login field', () => {
    const input = {
      fields: [
        { name: 'Email', type: 'textbox', ref: 'e1', value: 'ann@example.com' },
        { name: 'Password', type: 'textbox', ref: 'e2', value: 'hunter22' },
        { name: 'User name', type: 'textbox', ref: 'e3', value: 'ann' },
      ],
    };
    assert.deepEqual(redactCredentials(input), {
      fields: [
        { name: 'Email', type: 'textbox', ref: 'e1', value: 'ann@example.com' },
        { name: 'Password', type: 'textbox', ref: 'e2', value: REDACTED },
        { name: 'User name', type: 'textbox', ref: 'e3', value: REDACTED },
      ],
    });
    assert.deepEqual(redactCredentials({ element: 'Password field', ref: 'e2', text: 'hunter22' }), {
      element: 'Password field',
      ref: 'e2',
      text: REDACTED,
    });
  });

  it('does not scrub a value too short to be told apart from ordinary words', () => {
    assert.deepEqual(redactCredentials({ username: 'ann', description: 'Planning the banner' }), {
      username: REDACTED,
      description: 'Planning the banner',
    });
  });

  it('leaves input without a login alone', () => {
    const input = { file_path: '/workspace/repo/a.ts', nested: [{ pattern: 'x' }] };
    assert.deepEqual(redactCredentials(input), input);
    assert.equal(redactCredentials('text'), 'text');
    assert.equal(redactCredentials(undefined), undefined);
  });

  it('keeps a password in a Bash description off the card', () => {
    const input = redactCredentials({ description: 'Log in as ann@example.com with hunter22', command: 'x', password: 'hunter22', username: 'ann@example.com' });
    assert.equal(toolCardSummary('Bash', input), `Log in as ${REDACTED} with ${REDACTED}`);
  });
});

describe('the voice rules on logins (voice feedback US-009)', () => {
  it('tell the agent never to say or write a username or password, the PRD included, and to read the outcome out', () => {
    const rules = voiceRulesPrompt('en').replace(/\s+/g, ' ');
    assert.match(rules, /Never say or write a username or a password: not in a reply, not in a file, not in the PRD/);
    assert.match(rules, /tell the operator how that went in one sentence/);
  });
});
