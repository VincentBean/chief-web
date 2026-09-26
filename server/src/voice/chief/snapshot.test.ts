import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { loadConfig } from '../../config.js';
import { createSession, getSession, setSetting, upsertVoiceSessionAgent } from '../../db/index.js';
import { sessionPrdFile } from '../../sessions/index.js';
import { type PlanningState, type PlanningStateName, PlanningStates } from '../session-agent/planning-state.js';
import { chiefWorld, NOW } from './__fixtures__/world.js';
import { chiefSystemPrompt, DEFAULT_OPERATOR_NAME, languageName } from './prompt.js';
import { buildSnapshot, formatLocal, SNAPSHOT_MAX_SESSIONS } from './snapshot.js';
import type { ChiefServices } from './tools.js';

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

describe('planning sessions in the snapshot (voice multi-planning US-010)', () => {
  const planning = (name: string, state: PlanningStateName, openQuestions: number, repositoryName = 'chief-web'): PlanningState => ({
    sessionId: `id-${name}`,
    sessionName: name,
    repositoryName,
    state,
    openQuestions: Array.from({ length: openQuestions }, (_, i) => `Question ${String(i + 1)}?`),
    stories: 3,
    updatedAt: '2026-09-25T12:00:00.000Z',
  });
  const withStates = (w: ReturnType<typeof chiefWorld>, states: PlanningState[]): ChiefServices => ({
    ...w.services,
    planningStates: { listPlanningSessions: () => states, planningState: (id) => states.find((s) => s.sessionId === id) ?? null },
  });
  const block = (snapshot: string): string[] => {
    const lines = snapshot.split('\n');
    const start = lines.findIndex((line) => line.startsWith('PLANNING SESSIONS'));
    if (start === -1) return [];
    const end = lines.findIndex((line, i) => i > start && !line.startsWith('- '));
    return lines.slice(start, end);
  };

  it('lists each planning session with its repository, state and open-question count, in the order given', () => {
    const w = chiefWorld();
    const services = withStates(w, [
      planning('csv-export', 'waiting', 3, 'shop-api'),
      planning('onboarding-copy', 'drafting', 0),
      planning('dark-mode', 'waiting', 1),
      planning('search', 'done', 0, 'shop-api'),
      planning('billing', 'failed', 2, 'shop-api'),
    ]);
    const snapshot = buildSnapshot(services, { focus: { kind: 'chief' }, now: NOW });
    assert.deepEqual(block(snapshot), [
      `PLANNING SESSIONS (latest first, max ${SNAPSHOT_MAX_SESSIONS}):`,
      '- csv-export [shop-api] waiting, 3 open questions',
      '- onboarding-copy [chief-web] drafting, 0 open questions',
      '- dark-mode [chief-web] waiting, 1 open question',
      '- search [shop-api] done, 0 open questions',
      '- billing [shop-api] failed, 2 open questions',
    ]);
    const lines = snapshot.split('\n');
    assert.ok(lines.indexOf(block(snapshot)[0] ?? '') < lines.findIndex((line) => line.startsWith('QUEUE:')), 'right after the sessions');
    assert.doesNotMatch(snapshot, /Question 1\?/, 'the questions themselves stay out of the prompt');
  });

  it(`says none when there are none, keeps to ${SNAPSHOT_MAX_SESSIONS} and counts the rest, and is absent without planning states`, () => {
    const w = chiefWorld();
    assert.doesNotMatch(buildSnapshot(w.services, { focus: { kind: 'chief' }, now: NOW }), /PLANNING SESSIONS/);
    assert.match(buildSnapshot(withStates(w, []), { focus: { kind: 'chief' }, now: NOW }), /^PLANNING SESSIONS: none$/m);

    const many = Array.from({ length: SNAPSHOT_MAX_SESSIONS + 4 }, (_, i) => planning(`plan-${String(i)}`, 'waiting', 1));
    const lines = block(buildSnapshot(withStates(w, many), { focus: { kind: 'chief' }, now: NOW }));
    assert.equal(lines.length, 1 + SNAPSHOT_MAX_SESSIONS + 1);
    assert.equal(lines[1], '- plan-0 [chief-web] waiting, 1 open question');
    assert.equal(lines.at(-1), '- and 4 older');
  });

  it('already holds a session left waiting before the previous call ended, read off disk and the registry', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-web-snapshot-planning-'));
    try {
      const w = chiefWorld();
      const config = loadConfig({ DATA_DIR: dataDir });
      const onboarding = getSession(w.db, w.ids['onboarding'] ?? '');
      assert.ok(onboarding !== null);
      upsertVoiceSessionAgent(w.db, { sessionId: onboarding.id, claudeSessionId: 'claude-onboarding', mode: 'plan' });
      const file = sessionPrdFile(config, onboarding);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        [
          '# PRD: Onboarding copy',
          '',
          '## User Stories',
          '',
          '### US-001: Welcome text',
          '**Status:** todo',
          '**Priority:** 1',
          '**Description:** As a user, I want a welcome.',
          '',
          '**Acceptance Criteria:**',
          '- [ ] It is shown',
          '',
          '## Open Questions',
          '',
          '- Formal or informal tone?',
          '- Which screens?',
          '',
        ].join('\n'),
      );
      // A fresh registry: no call is running and no detached turn is remembered.
      const registry = { detachedState: () => ({ running: false, lastOutcome: null }) };
      const services: ChiefServices = { ...w.services, planningStates: new PlanningStates({ db: w.db, config, registry }) };
      const snapshot = buildSnapshot(services, { focus: { kind: 'chief' }, now: NOW });
      assert.deepEqual(block(snapshot), [
        `PLANNING SESSIONS (latest first, max ${SNAPSHOT_MAX_SESSIONS}):`,
        '- onboarding-copy [chief-web] waiting, 2 open questions',
      ]);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('chief system prompt on planning sessions (voice multi-planning US-010)', () => {
  it('answers from the PLANNING SESSIONS block with names and counts, and reads questions only when asked', () => {
    const prompt = chiefSystemPrompt({ language: 'en', snapshot: '' }).replace(/\s+/g, ' ');
    assert.match(prompt, /PLANNING SESSIONS in the STATE block says where each planning session stands/);
    assert.match(prompt, /name the sessions and their counts, and do not read the questions themselves unless asked/);
    assert.match(prompt, /"anything for me\?"/);
    assert.match(prompt, /get_session returns its open questions/);
  });
});
