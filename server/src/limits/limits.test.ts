import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  closeDatabase,
  createClaudeAccount,
  type Database,
  deleteClaudeAccountAndReferences,
  getSetting,
  IN_MEMORY,
  openDatabase,
  runMigrations,
  setSetting,
} from '../db/index.js';
import { type AgentRunOutcome, isUsageLimitRefusal, USAGE_LIMIT_PATTERNS } from './detect.js';
import type { VoiceBusEvent } from '../voice/events.js';
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

describe('the per-account usage-limit hold', () => {
  let db: Database;
  /** Two signed-in accounts and one that never signed in. */
  let a: string;
  let b: string;
  let signedOut: string;

  /** A fixed clock; every test moves it explicitly rather than sleeping. */
  const start = new Date('2026-08-31T12:00:00.000Z');

  /** `start` plus `minutes`, as the clock a call should see. */
  function at(minutes: number): Date {
    return new Date(start.getTime() + minutes * 60 * 1000);
  }

  beforeEach(() => {
    db = openDatabase(IN_MEMORY);
    a = createClaudeAccount(db, { authMethod: 'claude.ai' }).id;
    b = createClaudeAccount(db, { authMethod: 'claude.ai' }).id;
    signedOut = createClaudeAccount(db).id;
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('holds one account for an hour and returns the expiry, stored under its own key', () => {
    const hold = new UsageLimitHold(db);

    const expiry = hold.arm(a, start);

    assert.equal(expiry, new Date(start.getTime() + USAGE_LIMIT_HOLD_MS).toISOString());
    assert.equal(getSetting(db, `claude_limit_until:${a}`), expiry);
    assert.equal(hold.until(a, start), expiry);
    assert.equal(hold.active(a, start), true);
    assert.equal(hold.active(a, at(59)), true);
    // The other account keeps working.
    assert.equal(hold.active(b, start), false);
    assert.equal(hold.until(b, start), null);
  });

  it('never holds a null account (an install with no accounts)', () => {
    const hold = new UsageLimitHold(db);
    hold.arm(a, start);

    assert.equal(hold.active(null, start), false);
    assert.equal(hold.until(null, start), null);
  });

  it('arms to a given expiry — a capped window’s reset time — rather than the fixed hour', () => {
    const hold = new UsageLimitHold(db);
    const resetsAt = at(17);

    assert.equal(hold.arm(a, start, resetsAt), resetsAt.toISOString());
    assert.equal(hold.active(a, at(16)), true);
    assert.equal(hold.active(a, at(17)), false);
  });

  it('a capped usage window arms the hold to the window’s reset time', () => {
    const hold = new UsageLimitHold(db);
    const window = (utilization: number, resetsAt: Date | null) => ({
      utilization,
      resetsAt: resetsAt === null ? null : resetsAt.toISOString(),
    });

    // Below 100%, or no reset named, or a reset already past: nothing held.
    assert.equal(hold.armForUsage(a, { fiveHour: window(99, at(30)), sevenDay: null }, start), null);
    assert.equal(hold.armForUsage(a, { fiveHour: window(100, null), sevenDay: null }, start), null);
    assert.equal(hold.armForUsage(a, { fiveHour: window(100, at(-1)), sevenDay: null }, start), null);
    assert.equal(hold.active(a, start), false);

    // Capped: held exactly until the reset, not for the fixed hour.
    assert.equal(
      hold.armForUsage(a, { fiveHour: window(100, at(25)), sevenDay: window(40, at(900)) }, start),
      at(25).toISOString(),
    );
    assert.equal(hold.active(a, at(24)), true);
    assert.equal(hold.active(a, at(25)), false);
    assert.equal(hold.active(b, start), false);

    // Both windows capped: the later reset, because both have to lift.
    assert.equal(
      hold.armForUsage(b, { fiveHour: window(100, at(25)), sevenDay: window(100, at(900)) }, start),
      at(900).toISOString(),
    );
  });

  it('a reset time never shortens a longer hold already in force', () => {
    const hold = new UsageLimitHold(db);
    const hour = hold.arm(a, start);

    assert.equal(hold.arm(a, start, at(17)), hour);
    // ...but a later reset time moves it out.
    assert.equal(hold.arm(a, start, at(300)), at(300).toISOString());
  });

  it('tells the voice bus when every signed-in account is held, not when one is (voice US-015)', () => {
    const seen: VoiceBusEvent[] = [];
    const hold = new UsageLimitHold(db, { publish: (event) => seen.push(event) });

    const first = hold.arm(a, start);
    assert.deepEqual(seen, []);

    hold.arm(b, at(10));
    assert.deepEqual(seen, [{ kind: 'limits.hold', until: first }]);

    // An extension is not a new hold.
    hold.arm(a, at(20));
    assert.equal(seen.length, 1);
  });

  it('allHeld: every signed-in account held, ignoring signed-out ones', () => {
    const hold = new UsageLimitHold(db);
    assert.equal(hold.allHeld(start), false);

    hold.arm(a, start);
    assert.equal(hold.allHeld(start), false);

    hold.arm(b, at(10));
    assert.equal(hold.allHeld(at(10)), true);
    assert.equal(hold.active(signedOut, at(10)), false);

    // a's hold lifts at minute 60: work can start again on it.
    assert.equal(hold.allHeld(at(60)), false);
  });

  it('allHeld is false with no signed-in account at all', () => {
    const empty = openDatabase(IN_MEMORY);
    try {
      const hold = new UsageLimitHold(empty);
      assert.equal(hold.allHeld(start), false);
      assert.equal(hold.allHeldUntil(start), null);

      const only = createClaudeAccount(empty).id;
      hold.arm(only, start);
      assert.equal(hold.allHeld(start), false);
    } finally {
      closeDatabase(empty);
    }
  });

  it('earliestExpiry: when the first hold on a signed-in account lifts', () => {
    const hold = new UsageLimitHold(db);
    assert.equal(hold.earliestExpiry(start), null);

    hold.arm(a, start, at(90));
    hold.arm(b, start, at(30));
    // A signed-out account's earlier hold frees nothing, so it does not count.
    hold.arm(signedOut, start, at(5));

    assert.equal(hold.earliestExpiry(start), at(30).toISOString());
    assert.equal(hold.allHeldUntil(start), at(30).toISOString());
    assert.equal(hold.earliestExpiry(at(30)), at(90).toISOString());
    assert.equal(hold.allHeldUntil(at(30)), null);
  });

  it('lists every account with its expiry', () => {
    const hold = new UsageLimitHold(db);
    const until = hold.arm(b, start);

    assert.deepEqual(hold.list(start), [
      { accountId: a, until: null },
      { accountId: b, until },
      { accountId: signedOut, until: null },
    ]);
  });

  it('reads as no hold once the expiry has passed', () => {
    const hold = new UsageLimitHold(db);
    hold.arm(a, start);

    assert.equal(hold.active(a, at(60)), false);
    assert.equal(hold.until(a, at(60)), null);
    assert.equal(hold.active(a, at(61)), false);
  });

  it('re-arming during a hold moves the expiry out, never in', () => {
    const hold = new UsageLimitHold(db);
    const first = hold.arm(a, start);

    const second = hold.arm(a, at(10));

    assert.equal(second, new Date(at(10).getTime() + USAGE_LIMIT_HOLD_MS).toISOString());
    assert.ok(second > first);
    assert.equal(hold.until(a, at(10)), second);
    assert.equal(hold.active(a, at(69)), true);
  });

  it('keeps the later expiry when the one in force outlasts a fresh hour', () => {
    const far = new Date(start.getTime() + 3 * USAGE_LIMIT_HOLD_MS).toISOString();
    setSetting(db, `claude_limit_until:${a}`, far);
    const hold = new UsageLimitHold(db);

    assert.equal(hold.arm(a, start), far);
    assert.equal(hold.until(a, at(120)), far);
  });

  it('clears one account’s hold, leaving the others; clearAll lifts every one', () => {
    const hold = new UsageLimitHold(db);
    hold.arm(a, start);
    hold.arm(b, start);

    hold.clear(a);
    assert.equal(hold.active(a, start), false);
    assert.equal(hold.active(b, start), true);
    hold.clear(a);
    assert.equal(hold.active(a, start), false);

    hold.arm(a, start);
    hold.clearAll();
    assert.equal(hold.active(a, start), false);
    assert.equal(hold.active(b, start), false);
  });

  it('survives a restart mid-hold, reading the row the earlier process wrote', () => {
    const expiry = new UsageLimitHold(db).arm(a, start);

    const afterRestart = new UsageLimitHold(db);

    assert.equal(afterRestart.until(a, at(30)), expiry);
    assert.equal(afterRestart.active(a, at(30)), true);
  });

  it('ignores a stale row left behind by an earlier process', () => {
    setSetting(db, `claude_limit_until:${a}`, new Date(start.getTime() - 1).toISOString());
    const hold = new UsageLimitHold(db);

    assert.equal(hold.active(a, start), false);
    assert.equal(hold.until(a, start), null);
    assert.equal(hold.arm(a, start), new Date(start.getTime() + USAGE_LIMIT_HOLD_MS).toISOString());
  });

  it('ignores a row that is not a timestamp at all', () => {
    setSetting(db, `claude_limit_until:${a}`, 'soon');
    const hold = new UsageLimitHold(db);

    assert.equal(hold.active(a, start), false);
    assert.equal(hold.until(a, start), null);
  });

  it('migration 0027 deletes the old global row, which no account reads', () => {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('claude_limit_until', ?, ?)`,
    ).run(at(60).toISOString(), start.toISOString());
    db.prepare(`DELETE FROM schema_migrations WHERE id = '0027_claude_limit_per_account'`).run();

    // Ignored even before the migration runs: no account's key names it.
    const hold = new UsageLimitHold(db);
    assert.equal(hold.active(a, start), false);
    assert.equal(hold.allHeld(start), false);

    assert.deepEqual(runMigrations(db), ['0027_claude_limit_per_account']);
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'claude_limit_until'`).get();
    assert.equal(row, undefined);
  });

  it('removing an account deletes its hold row', () => {
    const hold = new UsageLimitHold(db);
    hold.arm(a, start);

    deleteClaudeAccountAndReferences(db, a);

    assert.equal(getSetting(db, `claude_limit_until:${a}`), null);
  });
});
