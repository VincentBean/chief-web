import assert from 'node:assert/strict';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createApp } from '../app.js';
import { createAuthService } from '../auth/index.js';
import { loadConfig } from '../config.js';
import {
  closeDatabase,
  createRepository,
  createSession,
  createVoiceCall,
  type Database,
  getVoiceCall,
  IN_MEMORY,
  insertVoiceTurn,
  listVoiceTurns,
  openDatabase,
  updateVoiceCall,
} from '../db/index.js';

const PASSWORD = 'correct horse battery staple';

describe('call history api (voice US-024)', () => {
  let baseUrl: string;
  let cookie: string;
  let db: Database;
  let server: http.Server;

  before(async () => {
    const config = loadConfig({ CHIEF_WEB_PASSWORD: PASSWORD });
    db = openDatabase(IN_MEMORY);
    const app = createApp(config, createAuthService(config, db), db);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase(db);
  });

  beforeEach(() => {
    db.prepare('DELETE FROM voice_calls').run();
  });

  const request = async (method: string, path: string): Promise<Response> =>
    fetch(`${baseUrl}${path}`, { method, headers: { cookie } });

  const seedCall = (id: string, startedAt: string, endedAt: string | null) => {
    createVoiceCall(db, { id, sttProvider: 'openrouter', ttsProvider: 'elevenlabs', startedAt });
    if (endedAt !== null) {
      updateVoiceCall(db, id, { endedAt, endReason: 'hangup', elChars: 420, orCostUsd: 0.0123, claudeTurns: 2 });
    }
  };

  describe('GET /api/voice/calls', () => {
    it('lists calls newest first with duration, end reason, providers and cost', async () => {
      seedCall('old', '2026-09-20T10:00:00.000Z', '2026-09-20T10:03:30.000Z');
      seedCall('new', '2026-09-24T09:00:00.000Z', '2026-09-24T09:00:45.000Z');
      seedCall('mid', '2026-09-22T12:00:00.000Z', '2026-09-22T12:10:00.000Z');

      const response = await request('GET', '/api/voice/calls');
      assert.equal(response.status, 200);
      const { calls } = (await response.json()) as { calls: Record<string, unknown>[] };

      assert.deepEqual(
        calls.map((call) => call['id']),
        ['new', 'mid', 'old'],
      );
      assert.deepEqual(calls[2], {
        id: 'old',
        startedAt: '2026-09-20T10:00:00.000Z',
        endedAt: '2026-09-20T10:03:30.000Z',
        durationSeconds: 210,
        endReason: 'hangup',
        active: false,
        providers: { stt: 'openrouter', tts: 'elevenlabs' },
        cost: { elChars: 420, sttSeconds: 0, scribeSeconds: 0, orCostUsd: 0.0123, claudeTurns: 2 },
      });
    });

    it('honours ?limit= and rejects a bad one', async () => {
      seedCall('a', '2026-09-20T10:00:00.000Z', '2026-09-20T10:01:00.000Z');
      seedCall('b', '2026-09-21T10:00:00.000Z', '2026-09-21T10:01:00.000Z');
      seedCall('c', '2026-09-22T10:00:00.000Z', '2026-09-22T10:01:00.000Z');

      const { calls } = (await (await request('GET', '/api/voice/calls?limit=2')).json()) as {
        calls: { id: string }[];
      };
      assert.deepEqual(
        calls.map((call) => call.id),
        ['c', 'b'],
      );
      assert.equal((await request('GET', '/api/voice/calls?limit=0')).status, 400);
      assert.equal((await request('GET', '/api/voice/calls?limit=abc')).status, 400);
    });
  });

  describe('GET /api/voice/calls/:id', () => {
    it('returns the turns with speaker, session name, tools, interrupted flag and latency', async () => {
      const repository = createRepository(db, {
        name: 'leo',
        sshUrl: 'git@github.com:VincentBean/leo.git',
        githubSlug: 'VincentBean/leo',
        defaultBaseBranch: 'main',
      });
      const session = createSession(db, {
        repositoryId: repository.id,
        name: 'csv-export',
        baseBranch: 'main',
        prTargetBranch: 'main',
      });
      seedCall('call-1', '2026-09-24T09:00:00.000Z', '2026-09-24T09:05:00.000Z');
      insertVoiceTurn(db, {
        callId: 'call-1',
        turn: 1,
        speaker: 'user',
        text: 'Start a build',
        tSpeechEnd: '2026-09-24T09:00:10.000Z',
        tTranscript: '2026-09-24T09:00:10.400Z',
      });
      insertVoiceTurn(db, {
        callId: 'call-1',
        turn: 1,
        speaker: 'chief',
        text: 'Starting the build now',
        interrupted: true,
        toolsJson: JSON.stringify([{ name: 'start_build', status: 'ok', summary: 'Build queued' }]),
        tFirstToken: '2026-09-24T09:00:11.000Z',
        tFirstAudioPlayed: '2026-09-24T09:00:11.600Z',
      });
      insertVoiceTurn(db, {
        callId: 'call-1',
        turn: 2,
        speaker: 'event',
        sessionId: session.id,
        text: '[focus] csv-export',
      });

      const response = await request('GET', '/api/voice/calls/call-1');
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        call: { id: string; durationSeconds: number };
        turns: Record<string, unknown>[];
      };

      assert.equal(body.call.id, 'call-1');
      assert.equal(body.call.durationSeconds, 300);
      assert.deepEqual(
        body.turns.map((turn) => [turn['speaker'], turn['sessionName'], turn['text']]),
        [
          ['user', null, 'Start a build'],
          ['chief', null, 'Starting the build now'],
          ['event', 'csv-export', '[focus] csv-export'],
        ],
      );
      const chief = body.turns[1] ?? {};
      assert.equal(chief['interrupted'], true);
      assert.deepEqual(chief['tools'], [{ name: 'start_build', status: 'ok', summary: 'Build queued' }]);
      assert.deepEqual(chief['latency'], {
        speechEnd: null,
        transcript: null,
        firstToken: '2026-09-24T09:00:11.000Z',
        firstChunk: null,
        firstAudioSent: null,
        firstAudioPlayed: '2026-09-24T09:00:11.600Z',
      });
      assert.equal((body.turns[0]?.['latency'] as Record<string, unknown>)['transcript'], '2026-09-24T09:00:10.400Z');
      assert.equal(body.turns[2]?.['sessionId'], session.id);
    });

    it('answers 404 for an unknown call', async () => {
      assert.equal((await request('GET', '/api/voice/calls/nope')).status, 404);
    });
  });

  describe('DELETE /api/voice/calls/:id', () => {
    it('deletes one call and, by cascade, its turns', async () => {
      seedCall('gone', '2026-09-24T09:00:00.000Z', '2026-09-24T09:01:00.000Z');
      seedCall('kept', '2026-09-24T10:00:00.000Z', '2026-09-24T10:01:00.000Z');
      for (const callId of ['gone', 'kept']) {
        insertVoiceTurn(db, { callId, turn: 1, speaker: 'user', text: 'hello' });
        insertVoiceTurn(db, { callId, turn: 1, speaker: 'chief', text: 'hi' });
      }

      const response = await request('DELETE', '/api/voice/calls/gone');
      assert.equal(response.status, 204);

      assert.equal(getVoiceCall(db, 'gone'), null);
      assert.equal(listVoiceTurns(db, 'gone').length, 0);
      assert.equal(
        (db.prepare("SELECT COUNT(*) AS n FROM voice_turns WHERE call_id = 'gone'").get() as { n: number }).n,
        0,
      );
      assert.notEqual(getVoiceCall(db, 'kept'), null);
      assert.equal(listVoiceTurns(db, 'kept').length, 2);
      assert.equal((await request('GET', '/api/voice/calls/gone')).status, 404);
    });

    it('answers 404 for an unknown call', async () => {
      assert.equal((await request('DELETE', '/api/voice/calls/nope')).status, 404);
    });
  });
});
