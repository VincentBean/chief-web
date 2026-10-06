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
  FAILOVER_MAX_FIVE_HOUR_UTILIZATION,
  type FailoverCandidate,
  type FailoverHold,
  type FailoverUsage,
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

  it('counts an unknown window as 0', () => {
    // No usage fetched at all, and an account whose 5-hour window is unreported.
    const unmeasured: FailoverCandidate = { ...account('a3', 0), usage: null };
    assert.equal(pickFailoverAccount([account('a1', 10), unmeasured], [], NOW), 'a3');
    assert.equal(pickFailoverAccount([account('a1', 10), account('a2', null, 90)], [], NOW), 'a2');
    // Unknown 7-day counts as 0 in the tie-break too.
    assert.equal(pickFailoverAccount([account('a1', 10, 5), account('a2', 10, null)], [], NOW), 'a2');
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
    assert.deepEqual(hold.route(own, NOW), { accountId: own, failover: false, waitingUntil: null });
    assert.deepEqual(hold.route(null, NOW), { accountId: null, failover: false, waitingUntil: null });
    deleteClaudeAccountAndReferences(db, own);
  });

  it('fails over to the least-used account, and waits with a log line when all are too busy', () => {
    const own = createClaudeAccount(db, { authMethod: 'claude.ai' }).id;
    const busy = createClaudeAccount(db, { authMethod: 'claude.ai' }).id;
    const quiet = createClaudeAccount(db, { authMethod: 'claude.ai' }).id;
    usage.set(busy, { fiveHour: { utilization: 80 }, sevenDay: null });
    usage.set(quiet, { fiveHour: { utilization: 20 }, sevenDay: null });
    const until = hold.arm(own, NOW);

    assert.deepEqual(hold.route(own, NOW), { accountId: quiet, failover: true, waitingUntil: null });
    assert.equal(hold.launchAccount(own, NOW), quiet);
    assert.equal(hold.waitingUntil(own, NOW), null);

    usage.set(busy, { fiveHour: { utilization: 97 }, sevenDay: null });
    usage.set(quiet, { fiveHour: { utilization: 96 }, sevenDay: null });
    const info = mock.method(logger, 'info', () => {});
    try {
      assert.deepEqual(hold.route(own, NOW), { accountId: own, failover: false, waitingUntil: until });
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
    createClaudeAccount(db, {}); // signed out
    const until = hold.arm(own, NOW);
    assert.equal(hold.waitingUntil(own, NOW), until);
    assert.equal(hold.launchAccount(own, NOW), own);
  });
});
