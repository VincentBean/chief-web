import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  closeDatabase,
  closeOpenVoiceCalls,
  createRepository,
  createSession,
  createVoiceCall,
  type Database,
  deleteSession,
  deleteVoiceCall,
  deleteVoiceCallsEndedBefore,
  deleteVoiceSessionAgent,
  deleteVoiceTurn,
  getVoiceCall,
  getVoiceSessionAgent,
  getVoiceTurn,
  IN_MEMORY,
  insertVoiceTurn,
  listVoiceCalls,
  listVoiceSessionAgents,
  listVoiceTurns,
  openDatabase,
  updateVoiceCall,
  updateVoiceTurn,
  upsertVoiceSessionAgent,
} from './index.js';

describe('voice persistence', () => {
  let db: Database;

  before(() => {
    db = openDatabase(IN_MEMORY);
  });

  after(() => {
    closeDatabase(db);
  });

  const call = (startedAt?: string) =>
    createVoiceCall(db, {
      sttProvider: 'openrouter',
      ttsProvider: 'elevenlabs',
      ...(startedAt === undefined ? {} : { startedAt }),
    });

  describe('calls', () => {
    it('starts open with every counter at zero', () => {
      const created = call();

      assert.deepEqual(getVoiceCall(db, created.id), created);
      assert.equal(created.endedAt, null);
      assert.equal(created.endReason, null);
      assert.equal(created.elChars, 0);
      assert.equal(created.sttSeconds, 0);
      assert.equal(created.orCostUsd, 0);
      assert.equal(created.claudeTurns, 0);
    });

    it('keeps an id the caller already minted', () => {
      const created = createVoiceCall(db, {
        id: 'call-fixed',
        sttProvider: 'browser',
        ttsProvider: 'openrouter',
      });

      assert.equal(created.id, 'call-fixed');
      assert.equal(getVoiceCall(db, 'call-fixed')?.sttProvider, 'browser');
    });

    it('updates only the fields it is given, fractions included', () => {
      const created = call();
      const updated = updateVoiceCall(db, created.id, {
        ttsProvider: 'openrouter',
        elChars: 1234,
        sttSeconds: 12.5,
        orCostUsd: 0.0042,
        claudeTurns: 3,
      });

      assert.equal(updated?.ttsProvider, 'openrouter');
      assert.equal(updated?.sttProvider, 'openrouter');
      assert.equal(updated?.elChars, 1234);
      assert.equal(updated?.sttSeconds, 12.5);
      assert.equal(updated?.orCostUsd, 0.0042);
      assert.equal(updated?.claudeTurns, 3);
      assert.equal(updated?.endedAt, null);

      const ended = updateVoiceCall(db, created.id, {
        endedAt: '2026-09-25T10:00:00.000Z',
        endReason: 'hangup',
      });
      assert.equal(ended?.endReason, 'hangup');
      assert.equal(ended?.elChars, 1234);
    });

    it('returns null when updating a call that does not exist', () => {
      assert.equal(updateVoiceCall(db, 'missing', { elChars: 1 }), null);
      assert.equal(updateVoiceCall(db, 'missing', {}), null);
    });

    it('lists the newest call first', () => {
      const older = call('2000-01-01T00:00:00.000Z');
      const newer = call('2999-01-01T00:00:00.000Z');
      const ids = listVoiceCalls(db).map((c) => c.id);

      assert.equal(ids[0], newer.id);
      assert.equal(ids.at(-1), older.id);
    });

    it('rejects an end reason outside the schema', () => {
      const created = call();
      db.prepare("UPDATE voice_calls SET end_reason = 'crashed' WHERE id = ?").run(created.id);

      assert.throws(() => getVoiceCall(db, created.id), /end_reason/);
      deleteVoiceCall(db, created.id);
    });

    it('deletes a call together with its turns', () => {
      const created = call();
      const turn = insertVoiceTurn(db, {
        callId: created.id,
        turn: 1,
        speaker: 'user',
        text: 'hello',
      });

      assert.equal(deleteVoiceCall(db, created.id), true);
      assert.equal(getVoiceCall(db, created.id), null);
      assert.equal(getVoiceTurn(db, turn.id), null);
      assert.deepEqual(listVoiceTurns(db, created.id), []);
      assert.equal(deleteVoiceCall(db, created.id), false);
    });

    it('closes only the calls still open, as the given reason', () => {
      const open = call();
      const ended = call();
      updateVoiceCall(db, ended.id, { endedAt: '2026-09-01T00:00:00.000Z', endReason: 'idle' });

      const closed = closeOpenVoiceCalls(db, 'error', '2026-09-25T12:00:00.000Z');

      assert.ok(closed >= 1);
      assert.equal(getVoiceCall(db, open.id)?.endReason, 'error');
      assert.equal(getVoiceCall(db, open.id)?.endedAt, '2026-09-25T12:00:00.000Z');
      assert.equal(getVoiceCall(db, ended.id)?.endReason, 'idle');
      assert.equal(getVoiceCall(db, ended.id)?.endedAt, '2026-09-01T00:00:00.000Z');
      assert.equal(closeOpenVoiceCalls(db), 0);
    });

    it('prunes by end time, falling back to the start of a call never closed', () => {
      const cutoff = '2010-06-01T00:00:00.000Z';
      // Started long ago but ended after the cutoff: kept.
      const endedLate = call('2010-01-01T00:00:00.000Z');
      updateVoiceCall(db, endedLate.id, { endedAt: '2010-07-01T00:00:00.000Z' });
      // Ended before the cutoff: pruned.
      const endedEarly = call('2010-01-01T00:00:00.000Z');
      updateVoiceCall(db, endedEarly.id, { endedAt: '2010-02-01T00:00:00.000Z' });
      // Never closed, started before the cutoff: pruned.
      const neverClosed = call('2010-03-01T00:00:00.000Z');
      // Never closed, started after the cutoff: kept.
      const recent = call('2010-07-01T00:00:00.000Z');
      const turn = insertVoiceTurn(db, {
        callId: endedEarly.id,
        turn: 1,
        speaker: 'chief',
        text: 'bye',
      });

      assert.equal(deleteVoiceCallsEndedBefore(db, cutoff), 2);
      assert.notEqual(getVoiceCall(db, endedLate.id), null);
      assert.equal(getVoiceCall(db, endedEarly.id), null);
      assert.equal(getVoiceCall(db, neverClosed.id), null);
      assert.notEqual(getVoiceCall(db, recent.id), null);
      assert.equal(getVoiceTurn(db, turn.id), null);
    });
  });

  describe('turns', () => {
    it('stores a turn with its defaults and lists them in spoken order', () => {
      const created = call();
      const second = insertVoiceTurn(db, {
        callId: created.id,
        turn: 2,
        speaker: 'chief',
        text: 'Sure.',
        toolsJson: JSON.stringify([{ name: 'list_sessions', status: 'ok', summary: '3' }]),
        tFirstToken: '2026-09-25T10:00:01.000Z',
      });
      const first = insertVoiceTurn(db, {
        callId: created.id,
        turn: 1,
        speaker: 'user',
        text: 'What is running?',
        tSpeechEnd: '2026-09-25T10:00:00.000Z',
      });

      assert.equal(first.interrupted, false);
      assert.equal(first.sessionId, null);
      assert.equal(first.toolsJson, null);
      assert.equal(first.tSpeechEnd, '2026-09-25T10:00:00.000Z');
      assert.equal(second.tFirstToken, '2026-09-25T10:00:01.000Z');
      assert.deepEqual(
        listVoiceTurns(db, created.id).map((t) => t.id),
        [first.id, second.id],
      );
    });

    it('updates a turn, including the interrupted flag', () => {
      const created = call();
      const turn = insertVoiceTurn(db, {
        callId: created.id,
        turn: 1,
        speaker: 'session',
        sessionId: 'some-session',
        text: 'Let me',
      });

      const updated = updateVoiceTurn(db, turn.id, {
        text: 'Let me think',
        interrupted: true,
        tFirstAudioPlayed: '2026-09-25T10:00:02.000Z',
      });

      assert.equal(updated?.text, 'Let me think');
      assert.equal(updated?.interrupted, true);
      assert.equal(updated?.sessionId, 'some-session');
      assert.equal(updated?.tFirstAudioPlayed, '2026-09-25T10:00:02.000Z');
      assert.equal(updateVoiceTurn(db, turn.id, { interrupted: false })?.interrupted, false);
      assert.equal(updateVoiceTurn(db, 999_999, { text: 'x' }), null);
    });

    it('deletes a single turn', () => {
      const created = call();
      const turn = insertVoiceTurn(db, { callId: created.id, turn: 1, speaker: 'event', text: 'x' });

      assert.equal(deleteVoiceTurn(db, turn.id), true);
      assert.equal(deleteVoiceTurn(db, turn.id), false);
      assert.deepEqual(listVoiceTurns(db, created.id), []);
    });

    it('refuses a turn for a call that does not exist', () => {
      assert.throws(() =>
        insertVoiceTurn(db, { callId: 'missing', turn: 1, speaker: 'user', text: 'x' }),
      );
    });
  });

  describe('session agents', () => {
    const session = (name: string) => {
      const repository = createRepository(db, {
        name,
        sshUrl: 'git@github.com:VincentBean/leo.git',
        githubSlug: 'VincentBean/leo',
        defaultBaseBranch: 'main',
      });
      return createSession(db, {
        repositoryId: repository.id,
        name,
        baseBranch: 'main',
        prTargetBranch: 'main',
      });
    };

    it('records, replaces, lists and deletes the conversation to resume', () => {
      const s = session('voice-agent-1');

      const first = upsertVoiceSessionAgent(db, {
        sessionId: s.id,
        claudeSessionId: 'claude-1',
        mode: 'plan',
      });
      assert.deepEqual(getVoiceSessionAgent(db, s.id), first);

      const replaced = upsertVoiceSessionAgent(db, {
        sessionId: s.id,
        claudeSessionId: 'claude-2',
        mode: 'qa',
      });
      assert.equal(getVoiceSessionAgent(db, s.id)?.claudeSessionId, 'claude-2');
      assert.equal(getVoiceSessionAgent(db, s.id)?.mode, 'qa');
      assert.deepEqual(
        listVoiceSessionAgents(db).filter((a) => a.sessionId === s.id),
        [replaced],
      );

      assert.equal(deleteVoiceSessionAgent(db, s.id), true);
      assert.equal(getVoiceSessionAgent(db, s.id), null);
      assert.equal(deleteVoiceSessionAgent(db, s.id), false);
    });

    it('goes with its session', () => {
      const s = session('voice-agent-2');
      upsertVoiceSessionAgent(db, { sessionId: s.id, claudeSessionId: 'c', mode: 'plan' });

      deleteSession(db, s.id);

      assert.equal(getVoiceSessionAgent(db, s.id), null);
    });

    it('refuses a session that does not exist', () => {
      assert.throws(() =>
        upsertVoiceSessionAgent(db, { sessionId: 'missing', claudeSessionId: 'c', mode: 'plan' }),
      );
    });
  });
});
