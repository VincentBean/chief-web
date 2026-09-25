import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

import { loadConfig } from '../../config.js';
import { closeDatabase, type Database, deleteSetting, IN_MEMORY, openDatabase, setSetting } from '../../db/index.js';
import { VOICE_FIELDS } from '../../settings/index.js';
import {
  checkWav,
  isHallucination,
  OPENROUTER_REFERER,
  OPENROUTER_TITLE,
  SttError,
  SttService,
  transcribeWithOpenRouter,
} from './index.js';

/** A 16 kHz mono PCM16 WAV of `ms` milliseconds, with a recognisable ramp. */
function makeWav(ms: number, { sampleRate = 16_000, channels = 1, bits = 16 } = {}): Buffer {
  const dataBytes = Math.round((sampleRate * ms) / 1000) * channels * (bits / 8);
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * (bits / 8), 28);
  wav.writeUInt16LE(channels * (bits / 8), 32);
  wav.writeUInt16LE(bits, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);
  for (let i = 44; i < wav.length; i++) wav[i] = i % 251;
  return wav;
}

interface Seen {
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Record<string, unknown>;
}

/** What the fake OpenRouter answers next; `delayMs` holds the answer back. */
let reply: { status: number; body: unknown; delayMs?: number } = { status: 200, body: { text: 'hallo' } };
let seen: Seen[] = [];

describe('speech-to-text (voice US-004)', () => {
  let provider: http.Server;
  let baseUrl: string;
  let db: Database;

  before(async () => {
    provider = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        seen.push({
          url: req.url ?? '',
          headers: req.headers,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        });
        const answer = (): void => {
          if (res.destroyed) return;
          res.writeHead(reply.status, { 'content-type': 'application/json' });
          res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
        };
        if (reply.delayMs === undefined) answer();
        else setTimeout(answer, reply.delayMs);
      });
    });
    provider.listen(0, '127.0.0.1');
    await new Promise((resolve) => provider.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/api/v1`;
    db = openDatabase(IN_MEMORY);
  });

  after(async () => {
    // The client's keep-alive agent holds idle sockets open.
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    closeDatabase(db);
  });

  beforeEach(() => {
    for (const { key } of Object.values(VOICE_FIELDS)) deleteSetting(db, key);
    setSetting(db, 'openrouter_api_key', 'sk-or-v1-test');
    reply = { status: 200, body: { text: '  Hallo chief.  ', usage: { cost: 0.00012, seconds: 2 } } };
    seen = [];
  });

  const service = (env: Record<string, string> = {}): SttService =>
    new SttService(db, loadConfig({ CHIEF_WEB_PASSWORD: 'x', OPENROUTER_API_URL: baseUrl, ...env }));

  describe('transcribeWithOpenRouter', () => {
    const options = { apiKey: 'sk-or-v1-test', model: 'openai/whisper-large-v3-turbo', timeoutMs: 5_000 };

    it('posts base64 WAV with the attribution headers and surfaces usage', async () => {
      const wav = makeWav(2_000);

      const result = await transcribeWithOpenRouter(wav, { ...options, baseUrl, language: 'nl' });

      assert.deepEqual(result, { text: 'Hallo chief.', costUsd: 0.00012, seconds: 2 });
      assert.equal(seen.length, 1);
      const [request] = seen;
      assert.equal(request?.url, '/api/v1/audio/transcriptions');
      assert.equal(request?.headers['authorization'], 'Bearer sk-or-v1-test');
      assert.equal(request?.headers['content-type'], 'application/json');
      assert.equal(request?.headers['http-referer'], OPENROUTER_REFERER);
      assert.equal(request?.headers['x-title'], OPENROUTER_TITLE);
      assert.equal(request?.headers['connection'], 'keep-alive');
      assert.equal(request?.body['model'], 'openai/whisper-large-v3-turbo');
      assert.equal(request?.body['language'], 'nl');
      const audio = request?.body['input_audio'] as { data: string; format: string };
      assert.equal(audio.format, 'wav');
      assert.ok(Buffer.from(audio.data, 'base64').equals(wav));
    });

    it('reports zero cost when OpenRouter sends no usage', async () => {
      reply = { status: 200, body: { text: 'ok' } };

      const result = await transcribeWithOpenRouter(makeWav(500), { ...options, baseUrl });

      assert.deepEqual(result, { text: 'ok', costUsd: 0, seconds: 0 });
      assert.ok(!('language' in (seen[0]?.body ?? {})));
    });

    for (const status of [401, 429, 500]) {
      it(`throws an SttError carrying ${String(status)} and the body`, async () => {
        const body = JSON.stringify({ error: { message: `nope ${String(status)}` } });
        reply = { status, body };

        await assert.rejects(transcribeWithOpenRouter(makeWav(500), { ...options, baseUrl }), (error: unknown) => {
          assert.ok(error instanceof SttError);
          assert.equal(error.kind, 'http');
          assert.equal(error.status, status);
          assert.equal(error.body, body);
          return true;
        });
      });
    }

    it('throws a timeout SttError when OpenRouter is too slow', async () => {
      reply = { status: 200, body: { text: 'late' }, delayMs: 1_000 };

      await assert.rejects(
        transcribeWithOpenRouter(makeWav(500), { ...options, baseUrl, timeoutMs: 100 }),
        (error: unknown) => error instanceof SttError && error.kind === 'timeout' && error.status === 0,
      );
    });

    it("rethrows the caller's abort as-is", async () => {
      reply = { status: 200, body: { text: 'late' }, delayMs: 1_000 };
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);

      await assert.rejects(
        transcribeWithOpenRouter(makeWav(500), { ...options, baseUrl, signal: controller.signal }),
        (error: unknown) => !(error instanceof SttError) && error instanceof Error && error.name === 'AbortError',
      );
    });

    it('throws a network SttError when OpenRouter is unreachable', async () => {
      await assert.rejects(
        transcribeWithOpenRouter(makeWav(500), { ...options, baseUrl: 'http://127.0.0.1:1/api/v1' }),
        (error: unknown) => error instanceof SttError && error.kind === 'network',
      );
    });
  });

  describe('checkWav', () => {
    it('computes the duration of a 16 kHz mono PCM16 WAV', () => {
      assert.deepEqual(checkWav(makeWav(1_500), 60_000), { ok: true, durationMs: 1_500 });
    });

    it('rejects too short, too long, other formats and non-WAV', () => {
      const reason = (wav: Buffer, max = 60_000): string | null => {
        const check = checkWav(wav, max);
        return check.ok ? null : check.reason;
      };
      assert.equal(reason(makeWav(200)), 'too_short');
      assert.equal(reason(makeWav(250)), null);
      assert.equal(reason(makeWav(2_000), 1_000), 'too_long');
      assert.equal(reason(makeWav(1_000, { sampleRate: 48_000 })), 'unsupported_format');
      assert.equal(reason(makeWav(1_000, { channels: 2 })), 'unsupported_format');
      assert.equal(reason(makeWav(1_000, { bits: 8 })), 'unsupported_format');
      assert.equal(reason(Buffer.from('not a wav at all, clearly')), 'not_wav');
    });

    it('finds the data chunk after an extra chunk', () => {
      const plain = makeWav(1_000);
      const list = Buffer.alloc(8 + 4);
      list.write('LIST', 0, 'ascii');
      list.writeUInt32LE(4, 4);
      list.write('INFO', 8, 'ascii');
      const wav = Buffer.concat([plain.subarray(0, 36), list, plain.subarray(36)]);
      assert.deepEqual(checkWav(wav, 60_000), { ok: true, durationMs: 1_000 });
    });
  });

  describe('isHallucination', () => {
    it('drops known silence phrases only on a short utterance', () => {
      assert.equal(isHallucination('Thank you.', 800), true);
      assert.equal(isHallucination(' bedankt voor het kijken ', 900), true);
      assert.equal(isHallucination('you', 400), true);
      assert.equal(isHallucination('.', 300), true);
      assert.equal(isHallucination('Thank you.', 1_500), false);
      assert.equal(isHallucination('Start de build', 800), false);
    });

    it('always drops an empty transcript', () => {
      assert.equal(isHallucination('   ', 5_000), true);
    });
  });

  describe('SttService', () => {
    it('transcribes with the configured model and omits language when a secondary is set', async () => {
      setSetting(db, 'voice_or_stt_model', 'openai/whisper-1');

      const result = await service().transcribe(makeWav(2_000));

      assert.deepEqual(result, { kind: 'text', text: 'Hallo chief.', costUsd: 0.00012, seconds: 2, durationMs: 2_000 });
      assert.equal(seen[0]?.body['model'], 'openai/whisper-1');
      assert.ok(!('language' in (seen[0]?.body ?? {})));
    });

    it('pins the primary language when there is no secondary language', async () => {
      setSetting(db, 'voice_secondary_language', '');
      setSetting(db, 'voice_language', 'nl');

      await service().transcribe(makeWav(2_000));

      assert.equal(seen[0]?.body['language'], 'nl');
    });

    it('rejects a too-short utterance without calling OpenRouter', async () => {
      const result = await service().transcribe(makeWav(100));

      assert.equal(result.kind, 'rejected');
      assert.equal(result.kind === 'rejected' ? result.reason : null, 'too_short');
      assert.equal(seen.length, 0);
    });

    it('rejects an utterance over VOICE_MAX_UTTERANCE_MS', async () => {
      const result = await service({ VOICE_MAX_UTTERANCE_MS: '1000' }).transcribe(makeWav(1_500));

      assert.equal(result.kind === 'rejected' ? result.reason : null, 'too_long');
      assert.equal(seen.length, 0);
    });

    it('drops a hallucination on a short utterance but keeps it on a long one', async () => {
      reply = { status: 200, body: { text: 'Thank you.', usage: { cost: 0.0001, seconds: 1 } } };

      const short = await service().transcribe(makeWav(800));
      const long = await service().transcribe(makeWav(1_500));

      assert.equal(short.kind, 'dropped');
      assert.equal(long.kind, 'text');
    });

    it('times out after VOICE_STT_TIMEOUT_MS', async () => {
      reply = { status: 200, body: { text: 'late' }, delayMs: 1_500 };

      await assert.rejects(
        service({ VOICE_STT_TIMEOUT_MS: '1000' }).transcribe(makeWav(500)),
        (error: unknown) => error instanceof SttError && error.kind === 'timeout',
      );
    });

    it('surfaces a 429 as an SttError', async () => {
      reply = { status: 429, body: { error: { message: 'Rate limit exceeded' } } };

      await assert.rejects(
        service().transcribe(makeWav(500)),
        (error: unknown) => error instanceof SttError && error.status === 429 && error.body.includes('Rate limit'),
      );
    });

    it('refuses without a key, and for browser-side providers', async () => {
      deleteSetting(db, 'openrouter_api_key');
      await assert.rejects(service().transcribe(makeWav(500)), (error: unknown) => error instanceof SttError && error.kind === 'unconfigured');

      setSetting(db, 'openrouter_api_key', 'sk-or-v1-test');
      setSetting(db, 'voice_stt_provider', 'browser');
      const stt = service();
      assert.equal(stt.provider, 'browser');
      await assert.rejects(stt.transcribe(makeWav(500)), (error: unknown) => error instanceof SttError && error.kind === 'unconfigured');
      assert.equal((await stt.transcribe(makeWav(500), undefined, { provider: 'openrouter' })).kind, 'text');
    });
  });
});
