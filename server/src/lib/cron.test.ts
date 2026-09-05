import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeCron, isValidCron, nextCronRun, validateCron } from './cron.js';

/**
 * Cron expressions are evaluated in the server's timezone, so the fixtures work
 * in local time rather than UTC — `local(...)` builds the moments these tests
 * talk about the way the parser reads them, wherever the suite runs.
 */
function local(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): Date {
  return new Date(year, month - 1, day, hour, minute, second, 0);
}

/** Message for an assertion that has to name the moment it disagreed about. */
function shown(date: Date | null): string {
  return date === null ? 'null' : date.toString();
}

function assertNext(expression: string, from: Date, expected: Date): void {
  const actual = nextCronRun(expression, from);
  assert.equal(
    shown(actual),
    shown(expected),
    `${expression} from ${from.toString()} should fire at ${expected.toString()}`,
  );
}

describe('cron', () => {
  describe('a daily expression', () => {
    const daily = '0 3 * * *';

    it('validates and describes itself', () => {
      const result = validateCron(daily);
      assert.equal(result.ok, true);
      assert.equal(result.description, 'At 03:00');
      assert.equal(describeCron(daily), 'At 03:00');
    });

    it('fires at the next 03:00', () => {
      assertNext(daily, local(2026, 9, 5, 10, 0), local(2026, 9, 6, 3, 0));
      assertNext(daily, local(2026, 9, 5, 2, 59), local(2026, 9, 5, 3, 0));
    });

    it('is strictly after `from`, so a task that just fired does not re-fire', () => {
      assertNext(daily, local(2026, 9, 5, 3, 0), local(2026, 9, 6, 3, 0));
    });
  });

  describe('a weekly expression', () => {
    const weekly = '0 3 * * 1';

    it('describes the day it runs on', () => {
      const result = validateCron(weekly);
      assert.equal(result.ok, true);
      assert.equal(result.description, 'At 03:00, only on Monday');
    });

    it('skips forward to Monday', () => {
      // 2026-09-05 is a Saturday; the next Monday is the 7th.
      assertNext(weekly, local(2026, 9, 5, 10, 0), local(2026, 9, 7, 3, 0));
      assertNext(weekly, local(2026, 9, 7, 3, 0), local(2026, 9, 14, 3, 0));
    });

    it('accepts the day name as well as the number', () => {
      assert.equal(describeCron('0 3 * * MON'), 'At 03:00, only on Monday');
      assertNext('0 3 * * MON', local(2026, 9, 5, 10, 0), local(2026, 9, 7, 3, 0));
    });
  });

  describe('an every-N-minutes expression', () => {
    const everyFifteen = '*/15 * * * *';

    it('describes the interval', () => {
      const result = validateCron(everyFifteen);
      assert.equal(result.ok, true);
      assert.equal(result.description, 'Every 15 minutes');
    });

    it('fires at the next quarter hour', () => {
      assertNext(everyFifteen, local(2026, 9, 5, 10, 1), local(2026, 9, 5, 10, 15));
      assertNext(everyFifteen, local(2026, 9, 5, 10, 45), local(2026, 9, 5, 11, 0));
    });

    it('ignores the seconds of `from` rather than firing twice in a minute', () => {
      assertNext(everyFifteen, local(2026, 9, 5, 10, 15, 30), local(2026, 9, 5, 10, 30));
    });
  });

  describe('invalid expressions', () => {
    /** Each case is rejected, and the message says why rather than "invalid". */
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ['too few fields', '0 3 * *', 'needs 5 fields'],
      ['too many fields (a seconds column)', '0 0 3 * * 1', 'needs 5 fields'],
      ['empty', '   ', 'required'],
      ['garbage', 'run it nightly for me', 'invalid'],
      ['a minute out of range', '99 3 * * *', '0-59'],
      ['a day of week out of range', '0 3 * * 8', '0-7'],
      ['a step of zero', '*/0 * * * *', 'repeat at every 0'],
      ['a day that never comes', '0 0 30 2 *', 'day of month'],
      ['an alias instead of five fields', '@daily', 'needs 5 fields'],
    ];

    for (const [name, expression, fragment] of cases) {
      it(`rejects ${name} with a specific message`, () => {
        const result = validateCron(expression);
        assert.equal(result.ok, false, `${expression} should not validate`);
        if (result.ok) return;
        assert.match(result.message, new RegExp(fragment, 'i'));
        assert.equal(isValidCron(expression), false);
      });

      it(`returns null instead of throwing for ${name}`, () => {
        assert.equal(nextCronRun(expression, local(2026, 9, 5, 10, 0)), null);
        assert.equal(describeCron(expression), null);
      });
    }

    it('names the field count it got', () => {
      const result = validateCron('0 3 * *');
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.message, /got 4/);
      assert.match(result.message, /minute hour day-of-month month day-of-week/);
    });
  });

  it('tolerates surrounding whitespace', () => {
    const result = validateCron('  0 3 * * 1  ');
    assert.equal(result.ok, true);
    assert.equal(result.description, 'At 03:00, only on Monday');
    assertNext('  0 3 * * 1  ', local(2026, 9, 5, 10, 0), local(2026, 9, 7, 3, 0));
  });

  it('defaults `from` to now, and never returns a moment in the past', () => {
    const before = Date.now();
    const next = nextCronRun('* * * * *');
    assert.notEqual(next, null);
    assert.ok(next !== null && next.getTime() > before);
  });

  it('returns null for an invalid `from` rather than an invalid date', () => {
    assert.equal(nextCronRun('0 3 * * *', new Date('nonsense')), null);
  });
});
