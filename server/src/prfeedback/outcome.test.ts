import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseOutcome, planPrRerun } from './outcome.js';

const ISSUED = ['T1', 'T2', 'R1'];

const outcomeOf = (raw: string | null, key: string): string | undefined =>
  parseOutcome(raw, ISSUED).items.find((item) => item.key === key)?.outcome;

describe('reading the agent’s report', () => {
  it('records what the agent said about each key', () => {
    const raw = JSON.stringify({
      addressed: [{ key: 'T1', summary: 'Compared minor units instead of floats.' }],
      skipped: [{ key: 'T2', reason: 'The code this points at is no longer on the branch.' }],
    });

    const parsed = parseOutcome(raw, ISSUED);

    assert.equal(parsed.ok, true);
    assert.equal(outcomeOf(raw, 'T1'), 'addressed');
    assert.equal(outcomeOf(raw, 'T2'), 'skipped');
    assert.equal(
      parsed.items.find((item) => item.key === 'T1')?.note,
      'Compared minor units instead of floats.',
    );
  });

  it('treats a key the agent never mentioned as unreported, never addressed', () => {
    // The failure this guards against is answering a comment nobody looked at.
    // Silence is not consent.
    const raw = JSON.stringify({ addressed: [{ key: 'T1', summary: 'done' }], skipped: [] });

    assert.equal(outcomeOf(raw, 'R1'), 'unreported');
    assert.equal(outcomeOf(raw, 'T2'), 'unreported');
  });

  it('refuses a report that says a key was both addressed and skipped', () => {
    const raw = JSON.stringify({
      addressed: [{ key: 'T1', summary: 'done' }],
      skipped: [{ key: 'T1', reason: 'actually not' }],
    });

    const parsed = parseOutcome(raw, ISSUED);

    assert.equal(parsed.ok, false);
    assert.match(parsed.error ?? '', /both addressed and skipped/);
    // Nothing survives a contradiction — every key falls back to unreported.
    assert.ok(parsed.items.every((item) => item.outcome === 'unreported'));
  });

  it('drops keys the agent invented instead of failing on them', () => {
    const raw = JSON.stringify({
      addressed: [
        { key: 'T1', summary: 'done' },
        { key: 'T99', summary: 'a comment that does not exist' },
      ],
      skipped: [],
    });

    const parsed = parseOutcome(raw, ISSUED);

    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.unknownKeys, ['T99']);
    assert.equal(outcomeOf(raw, 'T1'), 'addressed');
  });

  it('never throws on a missing, empty or malformed file', () => {
    for (const raw of [null, '', 'not json at all', '[]', '"a string"', '{']) {
      const parsed = parseOutcome(raw, ISSUED);
      assert.equal(parsed.ok, false, `expected ${JSON.stringify(raw)} to be refused`);
      assert.ok((parsed.error ?? '') !== '');
      assert.equal(parsed.items.length, ISSUED.length);
      assert.ok(parsed.items.every((item) => item.outcome === 'unreported'));
    }
  });

  it('tolerates entries that are the wrong shape', () => {
    const raw = JSON.stringify({
      addressed: [null, 'T1', { summary: 'no key' }, { key: '', summary: 'empty key' }, { key: 'T1' }],
      skipped: 'not an array',
    });

    const parsed = parseOutcome(raw, ISSUED);

    assert.equal(parsed.ok, true);
    // The one usable entry is kept, with no note.
    assert.equal(outcomeOf(raw, 'T1'), 'addressed');
    assert.equal(parsed.items.find((item) => item.key === 'T1')?.note, null);
  });
});

describe('planning a re-run', () => {
  it('re-runs only the replies when the fix is already pushed', () => {
    const plan = planPrRerun(
      { status: 'failed', failureStage: 'reply', headSha: 'abc1234def' },
      [{ outcome: 'addressed', repliedAt: null }],
    );

    assert.equal(plan.mode, 'replies-only');
    assert.match(plan.reason, /abc1234/);
  });

  it('runs the agent again for every other stage', () => {
    for (const stage of ['feedback', 'checkout', 'agent', 'outcome', 'push', 'container_lost']) {
      const plan = planPrRerun(
        { status: 'failed', failureStage: stage, headSha: 'abc1234def' },
        [{ outcome: 'addressed', repliedAt: null }],
      );
      assert.equal(plan.mode, 'full', `stage ${stage} should re-run in full`);
    }
  });

  it('runs the agent again when the reply failure left no commit behind', () => {
    const plan = planPrRerun(
      { status: 'failed', failureStage: 'reply', headSha: null },
      [{ outcome: 'addressed', repliedAt: null }],
    );

    assert.equal(plan.mode, 'full');
  });

  it('runs the agent again when every thread was already answered', () => {
    const plan = planPrRerun(
      { status: 'failed', failureStage: 'reply', headSha: 'abc1234def' },
      [{ outcome: 'addressed', repliedAt: '2026-08-29T10:00:00Z' }],
    );

    assert.equal(plan.mode, 'full');
  });
});
