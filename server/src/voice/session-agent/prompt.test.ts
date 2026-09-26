import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { answerPrompt, detachPrompt, resumePrompt, voiceModeOverrides } from './prompt.js';

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

describe('answerPrompt', () => {
  it('quotes one answered question and the answer', () => {
    assert.equal(
      answerPrompt(PRD, ['CSV or Excel?'], 'CSV only'),
      `[detached] The operator is not on the call with you, but answered your open question through chief. Nobody is listening, so do not ask anything.

"CSV or Excel?"

Answer: "CSV only"

Update the PRD at ${PRD} with this answer, and remove that question from the \`## Open Questions\` list; keep any question the answer does not settle. End your reply with one sentence stating the number of stories and the number of open questions.`,
    );
  });

  it('numbers several questions', () => {
    const text = answerPrompt(PRD, ['CSV or Excel?', 'Which columns?'], 'CSV, all columns');
    assert.ok(text.includes('answered your open questions through chief'));
    assert.ok(text.includes('1. "CSV or Excel?"\n2. "Which columns?"'));
    assert.ok(text.includes('remove the questions it settles from'));
  });
});

describe('resumePrompt', () => {
  it('quotes the open questions of a waiting session numbered', () => {
    assert.equal(
      resumePrompt(['Should archived sessions count?', 'What is the badge called?']),
      `The operator is back on the call. These are the open questions in the PRD:
1. Should archived sessions count?
2. What is the badge called?

Greet the operator in one sentence and ask the first question. As soon as a question is answered, remove it from \`## Open Questions\` in the PRD and update the affected stories. When the last one is answered, say the PRD is complete in one sentence and suggest saying "back to chief" to mark it ready and build it.`,
    );
  });

  it('says a done PRD is complete and suggests back to chief', () => {
    assert.equal(
      resumePrompt([]),
      'The operator is back on the call. The PRD is complete and has no open questions. Say so in one sentence and suggest saying "back to chief" to mark it ready and build it.',
    );
  });

  it('does not call a waiting PRD with no questions complete', () => {
    assert.equal(
      resumePrompt([], { state: 'waiting' }),
      'The operator is back on the call. The PRD has no open questions, but it is not finished: it is missing or does not parse in the story format. Greet the operator in one sentence, say what is left to do, and ask the first question you need answered.',
    );
  });

  it('quotes the failure reason of a failed session before its questions', () => {
    assert.equal(
      resumePrompt(['What is the badge called?'], { state: 'failed', failure: 'it ran out of time before it finished' }),
      `The operator is back on the call. Your last turn alone did not finish: it ran out of time before it finished. Pick up from what exists on disk: read the PRD if there is one, and finish it with the operator. These are the open questions in the PRD:
1. What is the badge called?

Greet the operator in one sentence and ask the first question. As soon as a question is answered, remove it from \`## Open Questions\` in the PRD and update the affected stories. When the last one is answered, say the PRD is complete in one sentence and suggest saying "back to chief" to mark it ready and build it.`,
    );
  });
});
