import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  closeDatabase,
  type Database,
  IN_MEMORY,
  openDatabase,
  setSetting,
} from '../db/index.js';
import { type AgentRunOutcome, isUsageLimitRefusal, USAGE_LIMIT_PATTERNS } from './detect.js';
import { USAGE_LIMIT_HOLD_MS, UsageLimitHold } from './hold.js';

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

describe('the global usage-limit hold', () => {
  let db: Database;

  /** A fixed clock; every test moves it explicitly rather than sleeping. */
  const start = new Date('2026-08-31T12:00:00.000Z');

  /** `start` plus `minutes`, as the clock a call should see. */
  function at(minutes: number): Date {
    return new Date(start.getTime() + minutes * 60 * 1000);
  }

  beforeEach(() => {
    db = openDatabase(IN_MEMORY);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('holds work for an hour and returns the expiry', () => {
    const hold = new UsageLimitHold(db);

    const expiry = hold.arm(start);

    assert.equal(expiry, new Date(start.getTime() + USAGE_LIMIT_HOLD_MS).toISOString());
    assert.equal(hold.until(start), expiry);
    assert.equal(hold.active(start), true);
    assert.equal(hold.active(at(59)), true);
  });

  it('reads as no hold once the expiry has passed', () => {
    const hold = new UsageLimitHold(db);
    hold.arm(start);

    assert.equal(hold.active(at(60)), false);
    assert.equal(hold.until(at(60)), null);
    assert.equal(hold.active(at(61)), false);
  });

  it('reads as no hold before anything armed one', () => {
    const hold = new UsageLimitHold(db);

    assert.equal(hold.until(start), null);
    assert.equal(hold.active(start), false);
  });

  it('re-arming during a hold moves the expiry out, never in', () => {
    const hold = new UsageLimitHold(db);
    const first = hold.arm(start);

    const second = hold.arm(at(10));

    assert.equal(second, new Date(at(10).getTime() + USAGE_LIMIT_HOLD_MS).toISOString());
    assert.ok(second > first);
    assert.equal(hold.until(at(10)), second);
    assert.equal(hold.active(at(69)), true);
  });

  it('keeps the later expiry when the one in force outlasts a fresh hour', () => {
    // A hold armed by a process whose clock ran ahead, or a longer hold some
    // future story stores: arming again must not walk it back to an hour.
    const far = new Date(start.getTime() + 3 * USAGE_LIMIT_HOLD_MS).toISOString();
    setSetting(db, 'claude_limit_until', far);
    const hold = new UsageLimitHold(db);

    assert.equal(hold.arm(start), far);
    assert.equal(hold.until(at(120)), far);
  });

  it('clears a hold in force, and clearing nothing is harmless', () => {
    const hold = new UsageLimitHold(db);
    hold.arm(start);

    hold.clear();

    assert.equal(hold.active(start), false);
    assert.equal(hold.until(start), null);
    hold.clear();
    assert.equal(hold.active(start), false);
  });

  it('survives a restart mid-hold, reading the row the earlier process wrote', () => {
    const expiry = new UsageLimitHold(db).arm(start);

    const afterRestart = new UsageLimitHold(db);

    assert.equal(afterRestart.until(at(30)), expiry);
    assert.equal(afterRestart.active(at(30)), true);
  });

  it('ignores a stale row left behind by an earlier process', () => {
    setSetting(db, 'claude_limit_until', new Date(start.getTime() - 1).toISOString());
    const hold = new UsageLimitHold(db);

    assert.equal(hold.active(start), false);
    assert.equal(hold.until(start), null);
    // Arming after a stale row measures the hour from now, not from the row.
    assert.equal(hold.arm(start), new Date(start.getTime() + USAGE_LIMIT_HOLD_MS).toISOString());
  });

  it('ignores a row that is not a timestamp at all', () => {
    setSetting(db, 'claude_limit_until', 'soon');
    const hold = new UsageLimitHold(db);

    assert.equal(hold.active(start), false);
    assert.equal(hold.until(start), null);
  });
});
