import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { detachPrompt, resumePrompt, voiceModeOverrides } from './prompt.js';

const PRD = '/workspace/repo/.chief/prds/demo/prd.md';

describe('voiceModeOverrides', () => {
  it('explains the detached workflow before the greeting', () => {
    const text = voiceModeOverrides('create', PRD, null);
    assert.ok(
      text.includes(`- The operator may leave the call at any moment. When a message starting with [detached] says so,
  continue alone: write the draft PRD in the exact story format to ${PRD}, put every question you
  would have asked under a \`## Open Questions\` heading as a plain bullet list, most important first,
  and end your reply with one sentence stating the number of stories and the number of open questions.
  A question you can answer by reading the code is not an open question: read the code. A decision only
  the operator can make (scope, naming, priorities, behaviour the code does not settle) is never guessed:
  list it as an open question and write the affected story with the most conservative reading.
- Start now by greeting the operator in one sentence and asking what they want to build.`),
    );
  });
});

describe('detachPrompt', () => {
  it('tells the agent to write the PRD alone without asking anything', () => {
    assert.equal(
      detachPrompt(PRD),
      `[detached] The operator has left the call. Nobody is listening and nobody will answer, so do not ask anything. Continue alone: finish your research, then write the draft PRD in the exact story format to ${PRD} before this reply ends, with every question you would have asked under a \`## Open Questions\` heading as a plain bullet list, most important first. End your reply with one sentence stating the number of stories and the number of open questions.`,
    );
  });
});

describe('resumePrompt', () => {
  it('quotes the open questions of a waiting session numbered', () => {
    assert.equal(
      resumePrompt(['Should archived sessions count?', 'What is the badge called?']),
      `The operator is back on the call. These are the open questions in the PRD:
1. Should archived sessions count?
2. What is the badge called?

Greet the operator in one sentence and ask the first question. As soon as a question is answered, remove it from \`## Open Questions\` in the PRD and update the affected stories.`,
    );
  });

  it('says a done PRD is complete and suggests back to chief', () => {
    assert.equal(
      resumePrompt([]),
      'The operator is back on the call. The PRD is complete and has no open questions. Say so in one sentence and suggest saying "back to chief" to mark it ready and build it.',
    );
  });
});
