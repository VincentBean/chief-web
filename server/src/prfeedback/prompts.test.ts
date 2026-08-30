import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkoutScript } from './checkout.js';
import {
  CONTAINER_OUTCOME_PATH,
  feedbackCommitMessage,
  feedbackContext,
  type FeedbackItem,
  prFeedbackPrompt,
} from './prompts.js';

const ITEMS: FeedbackItem[] = [
  {
    key: 'T1',
    kind: 'thread',
    path: 'packages/leo/src/Livewire/BookingProposalReview.php',
    line: 1024,
    author: 'copilot-pull-request-reviewer',
    body: 'Using float casting for money comparisons can produce incorrect results.',
    url: 'https://github.com/VincentBean/leo/pull/61#discussion_r1',
    outdated: false,
  },
  {
    key: 'R1',
    kind: 'review',
    path: null,
    line: null,
    author: 'copilot-pull-request-reviewer',
    body: '## Pull request overview',
    url: 'https://github.com/VincentBean/leo/pull/61#pullrequestreview-1',
    outdated: false,
  },
];

const PROMPT = prFeedbackPrompt({
  slug: 'VincentBean/leo',
  number: 61,
  title: 'booking-proposal-fields',
  headBranch: 'chief/booking-proposal-fields',
  items: ITEMS,
});

describe('the feedback prompt', () => {
  it('inlines every comment with the context needed to act on it', () => {
    const context = feedbackContext(ITEMS);

    assert.match(context, /"key": "T1"/);
    assert.match(context, /"file": "packages\/leo\/src\/Livewire\/BookingProposalReview\.php"/);
    assert.match(context, /"line": 1024/);
    assert.match(context, /"outdated": false/);
    // A review summary has no file to anchor to, and says so rather than lying.
    assert.match(context, /"kind": "review"/);
    assert.match(context, /"file": null/);
  });

  it('names the branch, the commit message and the report path', () => {
    assert.match(PROMPT, /chief\/booking-proposal-fields/);
    assert.match(PROMPT, /fix: address review feedback on #61/);
    assert.ok(PROMPT.includes(CONTAINER_OUTCOME_PATH));
  });

  it('forbids the two things that would make the contract unverifiable', () => {
    // The agent pushing would let a reply quote a commit chief-web never
    // verified; the agent replying would put claims on the pull request that
    // nothing checked.
    assert.match(PROMPT, /do not push/i);
    assert.match(PROMPT, /Do not reply on GitHub and do not use `gh`/);
  });

  it('tells the agent that skipping is a real answer', () => {
    // Without this an agent invents a change rather than report nothing, which
    // is the worst outcome available on someone else's pull request.
    assert.match(PROMPT, /Skipping is a good outcome/);
    assert.match(PROMPT, /Do not invent a change/);
  });

  it('carries a comment body through intact, whatever is in it', () => {
    // Bodies are written by reviewers and can hold backticks, quotes and shell
    // syntax. The prompt is one argv element and is never shell-parsed, so the
    // only requirement is that it arrives unmangled.
    const nasty = 'Use `$(rm -rf /)` — "quoted", \\backslashed\\ and ```fenced```';
    const prompt = prFeedbackPrompt({
      slug: 'a/b',
      number: 1,
      title: 't',
      headBranch: 'b',
      items: [{ ...ITEMS[0]!, body: nasty }],
    });

    assert.ok(prompt.includes(JSON.stringify(nasty).slice(1, -1)));
  });

  it('numbers the commit message after the pull request', () => {
    assert.equal(feedbackCommitMessage(60), 'fix: address review feedback on #60');
  });
});

describe('the checkout scripts', () => {
  it('requires the head branch to exist, which is the inverse of session setup', () => {
    // Session setup refuses when the branch is already on the remote; here it
    // must be, because the pull request points at it.
    assert.match(checkoutScript('check-head'), /ls-remote --exit-code --heads/);
    assert.match(checkoutScript('check-head'), /refs\/heads\/\$CHIEF_HEAD_BRANCH/);
  });

  it('starts from what origin has, and says so destructively', () => {
    const script = checkoutScript('checkout');

    assert.match(script, /checkout -B "\$CHIEF_HEAD_BRANCH" "origin\/\$CHIEF_HEAD_BRANCH"/);
    assert.match(script, /reset --hard "origin\/\$CHIEF_HEAD_BRANCH"/);
    assert.match(script, /git clean -fd/);
    // `-x` would delete ignored build output — node_modules and friends — which
    // the next run on this pull request would then have to rebuild.
    assert.ok(!/clean -[a-z]*x/.test(script));
  });

  it('never pushes; chief-web does that after it has checked the work', () => {
    for (const step of ['check-head', 'clone', 'checkout'] as const) {
      assert.ok(!checkoutScript(step).includes('git push'), `${step} must not push`);
    }
  });

  it('passes every value through the environment, never into the script', () => {
    // A branch name comes from GitHub and must not be able to become a command.
    for (const step of ['check-head', 'clone', 'checkout'] as const) {
      const script = checkoutScript(step);
      assert.ok(!script.includes('${'), `${step} must not interpolate`);
      assert.ok(
        !/rm -rf \/(?!\$)/.test(script.replace('rm -rf "$CHIEF_REPO_DIR"', '')),
        `${step} must not contain a bare destructive path`,
      );
    }
  });
});
