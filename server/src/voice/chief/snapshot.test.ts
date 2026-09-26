import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSession, setSetting } from '../../db/index.js';
import { chiefWorld, NOW } from './__fixtures__/world.js';
import { chiefSystemPrompt, DEFAULT_OPERATOR_NAME, languageName } from './prompt.js';
import { buildSnapshot, formatLocal, SNAPSHOT_MAX_SESSIONS } from './snapshot.js';

describe('chief state snapshot (voice US-008)', () => {
  it('writes the STATE block of docs/voice-plan.md §9.3 from the seeded database', () => {
    const w = chiefWorld();
    const snapshot = buildSnapshot(w.services, { focus: { kind: 'chief' }, now: NOW });
    assert.equal(
      snapshot,
      [
        'NOW 2026-09-25 14:02 Europe/Amsterdam',
        'REPOS: chief-web (base main), shop-api (base develop)',
        `SESSIONS (active first, max ${SNAPSHOT_MAX_SESSIONS}):`,
        // Only the part of the building line that does not depend on the wall clock is pinned below.
        snapshot.split('\n')[3],
        '- sentry-fix-4821 [shop-api] waiting (usage limit) until 15:10, 0/0 stories done',
        '- onboarding-copy [chief-web] pending, planning',
        '- dark-mode [chief-web] ready to build, 0 stories',
        '- billing-exports [shop-api] failed at the agent: Story US-002 failed three times.',
        '- nightly-rector-20260925-0200 [shop-api] finished, PR #212 open',
        '- old-merged-thing [chief-web] merged',
        'QUEUE: 1 queued (dark-mode)  SLOTS: 2/3 busy (billing-export, sentry-fix-4821)',
        'NEEDS YOU: onboarding-copy (pending), billing-exports (failed), PR #209 review failed',
        'PULL REQUESTS (open, as of 11:58 UTC):',
        '- #212 [shop-api] "Nightly rector run"',
        '- #209 [shop-api] "Speed up search" review failed',
        'RECURRING TASKS (due within 24h or failing):',
        '- nightly-rector [shop-api] next run 2026-09-26 02:00',
        '- weekly-deps [chief-web] last run failed',
        'FOCUS: chief',
      ].join('\n'),
    );
    assert.match(
      snapshot.split('\n')[3] ?? '',
      /^- billing-export \[shop-api\] building story 3\/7 \(US-003 "CSV writer"\), updated \d+[mhd] ago$/,
    );
  });

  it('follows voice_timezone, the usage-limit hold, an unfetched PR list and a session focus', () => {
    const w = chiefWorld();
    setSetting(w.db, 'voice_timezone', 'America/New_York');
    w.state.hold = '2026-09-25T13:10:00.000Z';
    w.state.pullRequests = null;
    const snapshot = buildSnapshot(w.services, { focus: { kind: 'session', sessionId: w.ids['dark'] ?? '' }, now: NOW });
    assert.match(snapshot, /^NOW 2026-09-25 08:02 America\/New_York$/m);
    assert.match(snapshot, /^USAGE LIMIT: Claude is on hold, builds resume at 09:10$/m);
    assert.match(snapshot, /^PULL REQUESTS: not loaded yet$/m);
    assert.match(snapshot, /^FOCUS: dark-mode$/m);
  });

  it(`lists at most ${SNAPSHOT_MAX_SESSIONS} sessions, active ones first`, () => {
    const w = chiefWorld();
    for (let i = 0; i < 20; i++) {
      createSession(w.db, { repositoryId: w.ids['shop'] ?? '', name: `old-${i}`, baseBranch: 'develop', prTargetBranch: 'develop', status: 'finished' });
    }
    const lines = buildSnapshot(w.services, { focus: { kind: 'chief' }, now: NOW }).split('\n');
    const sessions = lines.filter((line) => line.startsWith('- ') && / \[(shop-api|chief-web)\] /.test(line) && !line.startsWith('- #'));
    // 15 sessions plus the recurring-task lines that also carry a repository.
    assert.equal(sessions.filter((line) => !/next run|last run/.test(line)).length, SNAPSHOT_MAX_SESSIONS);
    assert.match(lines[3] ?? '', /^- billing-export /);
    assert.ok(lines.includes('- and 12 older'));
  });

  it('formats a moment in a timezone', () => {
    assert.equal(formatLocal(new Date('2026-01-15T23:30:00Z'), 'Europe/Amsterdam'), '2026-01-16 00:30');
  });
});

describe('chief system prompt (voice US-008)', () => {
  it('fills in the operator, the language and the snapshot', () => {
    const prompt = chiefSystemPrompt({ operatorName: 'Vincent', language: 'nl', snapshot: 'NOW x {{language}}' });
    assert.match(prompt, /^You are Chief, the voice of chief-web/);
    assert.match(prompt, /with the operator, Vincent\. Everything you write is spoken aloud\./);
    assert.match(prompt, /Speak Dutch unless the operator switches language; then follow them\./);
    assert.ok(prompt.endsWith('STATE\nNOW x {{language}}'), 'the snapshot is inserted as it is');
    assert.doesNotMatch(prompt.slice(0, prompt.indexOf('STATE')), /\{\{/);
  });

  it('falls back to "the operator" and names the language', () => {
    assert.match(chiefSystemPrompt({ language: 'en', snapshot: '' }), new RegExp(`with the operator, ${DEFAULT_OPERATOR_NAME}\\.`));
    assert.equal(languageName('en'), 'English');
    assert.equal(languageName('nl'), 'Dutch');
  });
});
