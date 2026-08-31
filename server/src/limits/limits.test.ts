import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type AgentRunOutcome, isUsageLimitRefusal, USAGE_LIMIT_PATTERNS } from './detect.js';

/** A refused run: non-zero exit, no timeout, whatever the CLI printed. */
function refused(output: string): AgentRunOutcome {
  return { exitCode: 1, output, timedOut: false };
}

describe('recognising a usage-limit refusal', () => {
  it('matches the CLI refusal with its reset time', () => {
    assert.equal(
      isUsageLimitRefusal(refused('Claude AI usage limit reached|1735689600')),
      true,
    );
  });

  it('matches the reworded message without the product name', () => {
    assert.equal(isUsageLimitRefusal(refused('Your usage limit reached for now.')), true);
  });

  it('matches the five hour window, hyphenated or spaced', () => {
    assert.equal(isUsageLimitRefusal(refused('You have hit your 5-hour limit.')), true);
    assert.equal(isUsageLimitRefusal(refused('You have hit your 5 hour limit.')), true);
  });

  it('matches a rate limit that says when it lets up', () => {
    assert.equal(
      isUsageLimitRefusal(refused('rate limit exceeded; resets at 4pm')),
      true,
    );
    assert.equal(
      isUsageLimitRefusal(refused('You have hit the rate limit for this account.\nTry again later.')),
      true,
    );
  });

  it('does not match a rate limit mentioned with no reset in sight', () => {
    assert.equal(
      isUsageLimitRefusal(refused('Error: the GitHub API rate limit header was malformed')),
      false,
    );
  });

  it('matches whatever the casing', () => {
    assert.equal(isUsageLimitRefusal(refused('CLAUDE AI USAGE LIMIT REACHED')), true);
    assert.equal(isUsageLimitRefusal(refused('claude ai usage limit reached')), true);
    assert.equal(isUsageLimitRefusal(refused('UsAgE LiMiT ReAcHeD')), true);
  });

  it('every pattern is exercised by a matching output', () => {
    const samples = [
      'Claude AI usage limit reached|1735689600',
      'Your usage limit reached for now.',
      'You have hit your 5-hour limit.',
      'rate limit exceeded; resets at 4pm',
    ];
    for (const pattern of USAGE_LIMIT_PATTERNS) {
      assert.ok(
        samples.some((sample) => pattern.test(sample)),
        `no sample matches ${String(pattern)}`,
      );
    }
  });

  it('treats a genuine stall as a stall', () => {
    assert.equal(isUsageLimitRefusal({ exitCode: 1, output: '', timedOut: false }), false);
    assert.equal(
      isUsageLimitRefusal({ exitCode: 2, output: 'error: could not read prd.md', timedOut: false }),
      false,
    );
  });

  it('leaves a timeout a timeout, however the truncated output reads', () => {
    assert.equal(
      isUsageLimitRefusal({
        exitCode: null,
        output: 'Claude AI usage limit reached',
        timedOut: true,
      }),
      false,
    );
  });

  it('never calls a clean exit a limit hit', () => {
    assert.equal(
      isUsageLimitRefusal({
        exitCode: 0,
        output: 'Read prd.md: "Claude AI usage limit reached" ... story done',
        timedOut: false,
      }),
      false,
    );
  });

  it('counts a killed agent that printed the refusal', () => {
    assert.equal(
      isUsageLimitRefusal({
        exitCode: null,
        output: 'Claude AI usage limit reached',
        timedOut: false,
      }),
      true,
    );
  });
});
