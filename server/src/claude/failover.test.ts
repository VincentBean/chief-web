import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';

import {
  createClaudeAccount,
  type Database,
  deleteClaudeAccountAndReferences,
  IN_MEMORY,
  openDatabase,
} from '../db/index.js';
import { UsageLimitHold } from '../limits/index.js';
import { logger } from '../lib/logger.js';
import {
  compareDrainOrder,
  FAILOVER_MAX_FIVE_HOUR_UTILIZATION,
  type FailoverCandidate,
  type FailoverHold,
  type FailoverUsage,
  pickAutomaticAccount,
  pickFailoverAccount,
} from './failover.js';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const LATER = '2026-10-01T13:00:00.000Z';
const EARLIER = '2026-10-01T11:00:00.000Z';

function account(
  id: string,
  fiveHour: number | null,
  sevenDay: number | null = null,
  extra: Partial<FailoverCandidate> = {},
): FailoverCandidate {
  return {
    id,
    position: Number.parseInt(id.replace(/\D/g, '') || '0', 10),
    authenticated: true,
    usage: {
      fiveHour: fiveHour === null ? null : { utilization: fiveHour },
      sevenDay: sevenDay === null ? null : { utilization: sevenDay },
    },
    ...extra,
  };
}

function held(...ids: string[]): FailoverHold[] {
  return ids.map((accountId) => ({ accountId, until: LATER }));
}

describe('pickFailoverAccount', () => {
  it('picks the account with the lowest 5-hour utilization', () => {
    const accounts = [account('a1', 70), account('a2', 30), account('a3', 50)];
    assert.equal(pickFailoverAccount(accounts, [], NOW), 'a2');
  });

  it('skips held and signed-out accounts', () => {
    const accounts = [
      account('a1', 10),
      account('a2', 5, null, { authenticated: false }),
      account('a3', 40),
    ];
    assert.equal(pickFailoverAccount(accounts, held('a1'), NOW), 'a3');
  });

  it('treats an expired hold as no hold', () => {
    const accounts = [account('a1', 10), account('a2', 40)];
    assert.equal(pickFailoverAccount(accounts, [{ accountId: 'a1', until: EARLIER }], NOW), 'a1');
    assert.equal(pickFailoverAccount(accounts, [{ accountId: 'a1', until: null }], NOW), 'a1');
  });

  it('breaks a 5-hour tie on the lower 7-day utilization, then on position', () => {
    assert.equal(
      pickFailoverAccount([account('a1', 20, 80), account('a2', 20, 30)], [], NOW),
      'a2',
    );
    assert.equal(
      pickFailoverAccount([account('a3', 20, 30), account('a2', 20, 30)], [], NOW),
      'a2',
    );
  });

  it('puts accounts whose usage is unknown after the measured ones', () => {
    // No usage fetched at all, and an answer that carried an error.
    const unmeasured: FailoverCandidate = { ...account('a3', 0), usage: null };
    const failed: FailoverCandidate = {
      ...account('a4', 0),
      usage: { fiveHour: null, sevenDay: null, error: 'The usage endpoint answered 500' },
    };
    assert.equal(pickFailoverAccount([account('a1', 90, 90), unmeasured, failed], [], NOW), 'a1');
    // …but they are still candidates when nothing measured is.
    assert.equal(pickFailoverAccount([unmeasured, failed], [], NOW), 'a3');
    // An unreported 5-hour window counts as 0 against the ceiling.
    assert.equal(pickFailoverAccount([account('a1', 96), account('a2', null, 90)], [], NOW), 'a2');
  });

  it('stays on the account it already fails over to while that one qualifies', () => {
    const accounts = [account('a1', 0), account('a2', 60), account('a3', 10)];
    assert.equal(pickFailoverAccount(accounts, held('a1'), NOW, 'a2'), 'a2');
    assert.equal(pickFailoverAccount([account('a2', 96), account('a3', 10)], [], NOW, 'a2'), 'a3');
    assert.equal(pickFailoverAccount(accounts, held('a1', 'a2'), NOW, 'a2'), 'a3');
  });

  it('prefers an account with no 7-day window, then the lowest 7-day usage', () => {
    assert.equal(pickFailoverAccount([account('a1', 5, 0), account('a2', 60)], [], NOW), 'a2');
    assert.equal(pickFailoverAccount([account('a1', 5, 40), account('a2', 60, 20)], [], NOW), 'a2');
  });

  it(`never picks an account above ${String(FAILOVER_MAX_FIVE_HOUR_UTILIZATION)}% of its 5-hour window`, () => {
    assert.equal(pickFailoverAccount([account('a1', 96), account('a2', 99)], [], NOW), null);
    // Exactly at the ceiling still qualifies.
    assert.equal(pickFailoverAccount([account('a1', 96), account('a2', 95)], [], NOW), 'a2');
  });

  it('returns null when there is no candidate at all', () => {
    assert.equal(pickFailoverAccount([], [], NOW), null);
    assert.equal(pickFailoverAccount([account('a1', 0)], held('a1'), NOW), null);
    assert.equal(
      pickFailoverAccount([account('a1', 0, 0, { authenticated: false })], [], NOW),
      null,
    );
  });
});

describe('routing held work through the hold (US-015)', () => {
  let db: Database;
  const usage = new Map<string, FailoverUsage>();
  let hold: UsageLimitHold;

  before(() => {
    db = openDatabase(IN_MEMORY);
    hold = new UsageLimitHold(db, null, { usage: (id) => usage.get(id) ?? null });
  });

  after(() => {
    db.close();
  });

  it('launches on the own account while it is not held', () => {
    const own = createClaudeAccount(db, { authMethod: 'claude.ai' }).id;
    assert.deepEqual(hold.route(own, NOW), {
      accountId: own,
      failover: false,
      automatic: false,
      waitingUntil: null,
    });
    deleteClaudeAccountAndReferences(db, own);
  });

  it('fails over to the least-used account, and waits with a log line when all are too busy', () => {
    const own = createClaudeAccount(db, { authMethod: 'claude.ai' }).id;
    const busy = createClaudeAccount(db, { authMethod: 'claude.ai' }).id;
    const quiet = createClaudeAccount(db, { authMethod: 'claude.ai' }).id;
    usage.set(busy, { fiveHour: { utilization: 80 }, sevenDay: null });
    usage.set(quiet, { fiveHour: { utilization: 20 }, sevenDay: null });
    const until = hold.arm(own, NOW);

    assert.deepEqual(hold.route(own, NOW), {
      accountId: quiet,
      failover: true,
      automatic: false,
      waitingUntil: null,
    });
    assert.equal(hold.launchAccount(own, NOW), quiet);
    assert.equal(hold.waitingUntil(own, NOW), null);

    usage.set(busy, { fiveHour: { utilization: 97 }, sevenDay: null });
    usage.set(quiet, { fiveHour: { utilization: 96 }, sevenDay: null });
    const info = mock.method(logger, 'info', () => {});
    try {
      assert.deepEqual(hold.route(own, NOW), {
        accountId: own,
        failover: false,
        automatic: false,
        waitingUntil: until,
      });
      // Said once, not on every tick that asks again.
      assert.equal(hold.waitingUntil(own, NOW), until);
      assert.equal(info.mock.callCount(), 1);
      const [message, fields] = info.mock.calls[0]?.arguments ?? [];
      assert.match(String(message), /no failover/);
      assert.match(String((fields as { reason?: string } | undefined)?.reason), /above 95%/);
    } finally {
      info.mock.restore();
    }

    // Another account becoming eligible ends the wait on the next question.
    usage.set(busy, { fiveHour: { utilization: 50 }, sevenDay: null });
    assert.equal(hold.launchAccount(own, NOW), busy);

    for (const id of [own, busy, quiet]) deleteClaudeAccountAndReferences(db, id);
  });

  it('waits when no other signed-in account is free', () => {
    const own = createClaudeAccount(db, { authMethod: 'claude.ai' }).id;
    const signedOut = createClaudeAccount(db, {}).id;
    const until = hold.arm(own, NOW);
    assert.equal(hold.waitingUntil(own, NOW), until);
    assert.equal(hold.launchAccount(own, NOW), own);
    for (const id of [own, signedOut]) deleteClaudeAccountAndReferences(db, id);
  });
});

describe('compareDrainOrder', () => {
  it('orders no 7-day window, then 7-day usage, then unknown usage, then 5-hour usage and position', () => {
    const accounts = [
      { ...account('a1', 0), usage: null },
      account('a2', 30, 50),
      account('a3', 80),
      account('a4', 10, 50),
      account('a5', 90, 10),
      account('a6', 20),
    ];
    assert.deepEqual(
      [...accounts].sort(compareDrainOrder).map((candidate) => candidate.id),
      ['a6', 'a3', 'a5', 'a4', 'a2', 'a1'],
    );
  });
});

describe('pickAutomaticAccount', () => {
  it('drains accounts with no 7-day window first, then the least-used 7-day one', () => {
    assert.equal(pickAutomaticAccount([account('a1', 10, 0), account('a2', 70)], [], NOW), 'a2');
    assert.equal(
      pickAutomaticAccount([account('a1', 10, 60), account('a2', 70, 20), account('a3', 0, 45)], [], NOW),
      'a2',
    );
  });

  it('keeps the current account while it has 5-hour room, even when another ranks first', () => {
    const accounts = [account('a1', 10, 80), account('a2', 0, 10)];
    assert.equal(pickAutomaticAccount(accounts, [], NOW, 'a1'), 'a1');
    assert.equal(pickAutomaticAccount([account('a1', 95, 80), account('a2', 0, 10)], [], NOW, 'a1'), 'a1');
  });

  it(`leaves the current account once it passes ${String(FAILOVER_MAX_FIVE_HOUR_UTILIZATION)}%, or is held or signed out`, () => {
    const others = [account('a2', 50, 30), account('a3', 0, 60)];
    assert.equal(pickAutomaticAccount([account('a1', 96, 10), ...others], [], NOW, 'a1'), 'a2');
    assert.equal(pickAutomaticAccount([account('a1', 10, 10), ...others], held('a1'), NOW, 'a1'), 'a2');
    assert.equal(
      pickAutomaticAccount([account('a1', 10, 10, { authenticated: false }), ...others], [], NOW, 'a1'),
      'a2',
    );
  });

  it('still runs when every usable account is above the ceiling: on the current one, else the least 5-hour usage', () => {
    const accounts = [account('a1', 99, 10), account('a2', 97, 90), account('a3', 98)];
    assert.equal(pickAutomaticAccount(accounts, [], NOW, 'a1'), 'a1');
    assert.equal(pickAutomaticAccount(accounts, [], NOW), 'a2');
    assert.equal(pickAutomaticAccount(accounts, held('a2'), NOW), 'a3');
  });

  it('returns null only when no signed-in account is free of a hold', () => {
    assert.equal(pickAutomaticAccount([], [], NOW), null);
    assert.equal(pickAutomaticAccount([account('a1', 0), account('a2', 0)], held('a1', 'a2'), NOW), null);
    assert.equal(pickAutomaticAccount([account('a1', 0, 0, { authenticated: false })], [], NOW), null);
  });
});

describe('routing automatic work through the hold', () => {
  let db: Database;
  const usage = new Map<string, FailoverUsage>();
  let hold: UsageLimitHold;

  before(() => {
    db = openDatabase(IN_MEMORY);
    hold = new UsageLimitHold(db, null, { usage: (id) => usage.get(id) ?? null });
  });

  after(() => {
    db.close();
  });

  it('launches nowhere, and waits for nothing, while there are no accounts', () => {
    assert.deepEqual(hold.route(null, NOW), {
      accountId: null,
      failover: false,
      automatic: true,
      waitingUntil: null,
    });
  });

  it('chooses an account, stays on the current one, and waits only while every account is held', () => {
    const weekly = createClaudeAccount(db, { authMethod: 'claude.ai' }).id;
    const unlimited = createClaudeAccount(db, { authMethod: 'claude.ai' }).id;
    const signedOut = createClaudeAccount(db, {}).id;
    usage.set(weekly, { fiveHour: { utilization: 10 }, sevenDay: { utilization: 20 }, error: null });
    usage.set(unlimited, { fiveHour: { utilization: 60 }, sevenDay: null, error: null });

    assert.deepEqual(hold.route(null, NOW), {
      accountId: unlimited,
      failover: false,
      automatic: true,
      waitingUntil: null,
    });
    assert.equal(hold.launchAccount(null, NOW, weekly), weekly);
    assert.equal(hold.waitingUntil(null, NOW), null);

    const first = hold.arm(unlimited, NOW, new Date(LATER));
    assert.equal(hold.launchAccount(null, NOW), weekly);
    hold.arm(weekly, NOW, new Date('2026-10-01T14:00:00.000Z'));
    // Every signed-in account is held: wait for the first hold to lift.
    assert.deepEqual(hold.route(null, NOW), {
      accountId: null,
      failover: false,
      automatic: true,
      waitingUntil: first,
    });

    for (const id of [weekly, unlimited, signedOut]) deleteClaudeAccountAndReferences(db, id);
  });
});
