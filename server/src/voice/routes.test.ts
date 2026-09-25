import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createApp } from '../app.js';
import { createAuthService } from '../auth/index.js';
import { loadConfig } from '../config.js';
import {
  closeDatabase,
  type Database,
  deleteSetting,
  getSetting,
  IN_MEMORY,
  openDatabase,
  setSetting,
} from '../db/index.js';
import { VOICE_FIELDS } from '../settings/index.js';

const PASSWORD = 'correct horse battery staple';

/** A stub reply per path of the fake provider server. */
let replies: Record<string, { status: number; body: unknown }> = {};
/** Headers the fake provider saw, per path. */
let seen: Record<string, http.IncomingHttpHeaders> = {};

const MODELS = {
  data: [
    {
      id: 'openai/whisper-large-v3-turbo',
      architecture: { input_modalities: ['audio'], output_modalities: ['transcription'] },
      supported_parameters: [],
    },
    {
      id: 'inclusionai/ling-3.0-flash',
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: ['tools', 'temperature'],
    },
    {
      id: 'meta-llama/no-tools',
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: ['temperature'],
    },
    {
      id: 'google/gemini-3.8-flash-lite-tts',
      architecture: { input_modalities: ['text'], output_modalities: ['speech'] },
      supported_parameters: [],
      supported_voices: ['Kore', 'Puck'],
    },
  ],
};

describe('voice api (voice US-001)', () => {
  let baseUrl: string;
  let cookie: string;
  let db: Database;
  let server: http.Server;
  let provider: http.Server;

  before(async () => {
    provider = http.createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      seen[path] = req.headers;
      if (path === '/or/models') seen['/or/models?'] = { query: req.url ?? '' };
      const reply = replies[path] ?? { status: 404, body: { error: { message: 'no stub' } } };
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
    });
    provider.listen(0, '127.0.0.1');
    await new Promise((resolve) => provider.once('listening', resolve));
    const port = (provider.address() as AddressInfo).port;

    const config = loadConfig({
      CHIEF_WEB_PASSWORD: PASSWORD,
      OPENROUTER_API_URL: `http://127.0.0.1:${port}/or`,
      ELEVENLABS_API_URL: `http://127.0.0.1:${port}/el`,
    });
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
    await new Promise((resolve) => provider.close(resolve));
    closeDatabase(db);
  });

  beforeEach(() => {
    for (const { key } of Object.values(VOICE_FIELDS)) deleteSetting(db, key);
    deleteSetting(db, 'openrouter_api_key');
    deleteSetting(db, 'elevenlabs_api_key');
    deleteSetting(db, 'voice_el_exhausted_until');
    replies = {};
    seen = {};
  });

  const request = async (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const json = async (response: Response): Promise<Record<string, unknown>> =>
    (await response.json()) as Record<string, unknown>;

  describe('GET/PUT /api/settings', () => {
    it('returns the voice settings with both keys masked', async () => {
      setSetting(db, 'openrouter_api_key', 'sk-or-v1-secretvalue-abcd');

      const body = await json(await request('GET', '/api/settings'));

      assert.deepEqual(body['openrouterApiKey'], { configured: true, last4: 'abcd' });
      assert.deepEqual(body['elevenlabsApiKey'], { configured: false, last4: null });
      assert.ok(!JSON.stringify(body).includes('secretvalue'));
      const voice = body['voice'] as Record<string, unknown>;
      assert.equal(voice['enabled'], false);
      assert.equal(voice['language'], 'nl');
      assert.equal(voice['secondaryLanguage'], 'en');
      assert.equal(voice['transcriptRetentionDays'], 30);
      assert.ok(!('elExhaustedUntil' in voice));
    });

    it('accepts the keys and voice fields, and null deletes a key', async () => {
      const saved = await json(
        await request('PUT', '/api/settings', {
          elevenlabsApiKey: '  sk_el_key_wxyz  ',
          voice: { enabled: true, bargeIn: 'on', timezone: 'Europe/London' },
        }),
      );

      assert.deepEqual(saved['elevenlabsApiKey'], { configured: true, last4: 'wxyz' });
      assert.equal(getSetting(db, 'elevenlabs_api_key'), 'sk_el_key_wxyz');
      const voice = saved['voice'] as Record<string, unknown>;
      assert.equal(voice['enabled'], true);
      assert.equal(voice['bargeIn'], 'on');
      assert.equal(voice['timezone'], 'Europe/London');

      const cleared = await json(await request('PUT', '/api/settings', { elevenlabsApiKey: null }));
      assert.deepEqual(cleared['elevenlabsApiKey'], { configured: false, last4: null });
    });

    it('rejects an unknown enum value with 400 and saves nothing', async () => {
      const response = await request('PUT', '/api/settings', {
        maxConcurrentSessions: 7,
        voice: { enabled: true, sttProvider: 'siri' },
      });

      assert.equal(response.status, 400);
      assert.equal((await json(response))['error'], 'invalid_voice_stt_provider');
      assert.equal(getSetting(db, 'voice_enabled'), null);
    });

    it('refuses the internal credit hold', async () => {
      const response = await request('PUT', '/api/settings', {
        voice: { elExhaustedUntil: '2030-01-01T00:00:00Z' },
      });

      assert.equal(response.status, 400);
      assert.equal(getSetting(db, 'voice_el_exhausted_until'), null);
    });

    it('rejects an empty key rather than treating it as removal', async () => {
      const response = await request('PUT', '/api/settings', { openrouterApiKey: '   ' });

      assert.equal(response.status, 400);
      assert.equal((await json(response))['error'], 'invalid_openrouter_api_key');
    });
  });

  describe('GET /api/voice/voices', () => {
    it('needs a saved ElevenLabs key', async () => {
      const response = await request('GET', '/api/voice/voices');

      assert.equal(response.status, 400);
      assert.equal((await json(response))['error'], 'elevenlabs_key_missing');
    });

    it('proxies the voice list with the stored key', async () => {
      setSetting(db, 'elevenlabs_api_key', 'sk_el_stored');
      replies['/el/v1/voices'] = {
        status: 200,
        body: {
          voices: [
            {
              voice_id: 'JBFqnCBsd6RMkjVDRZzb',
              name: 'George',
              category: 'premade',
              preview_url: 'https://example.com/george.mp3',
              labels: { accent: 'british', age: 42 },
            },
            { name: 'no id' },
          ],
        },
      };

      const response = await request('GET', '/api/voice/voices');

      assert.equal(response.status, 200);
      assert.equal(seen['/el/v1/voices']?.['xi-api-key'], 'sk_el_stored');
      assert.deepEqual((await json(response))['voices'], [
        {
          voiceId: 'JBFqnCBsd6RMkjVDRZzb',
          name: 'George',
          category: 'premade',
          previewUrl: 'https://example.com/george.mp3',
          labels: { accent: 'british' },
        },
      ]);
    });

    it('passes the provider error text on without answering 401', async () => {
      setSetting(db, 'elevenlabs_api_key', 'sk_el_revoked');
      replies['/el/v1/voices'] = {
        status: 401,
        body: { detail: { status: 'invalid_api_key', message: 'Invalid API key' } },
      };

      const response = await request('GET', '/api/voice/voices');
      const body = await json(response);

      assert.equal(response.status, 400);
      assert.equal(body['error'], 'elevenlabs_unauthorized');
      assert.match(String(body['message']), /Invalid API key/);
    });
  });

  describe('POST /api/voice/test/openrouter-key', () => {
    beforeEach(() => {
      replies['/or/key'] = {
        status: 200,
        body: { data: { label: 'chief', usage: 1.5, limit: null, limit_remaining: null, is_free_tier: false } },
      };
      replies['/or/models'] = { status: 200, body: MODELS };
    });

    it('checks the stored key and validates the saved slugs against the whole catalog', async () => {
      setSetting(db, 'openrouter_api_key', 'sk-or-stored');

      const response = await request('POST', '/api/voice/test/openrouter-key', {});
      const body = await json(response);

      assert.equal(response.status, 200);
      assert.equal(seen['/or/key']?.authorization, 'Bearer sk-or-stored');
      assert.match(String(seen['/or/models?']?.['query']), /output_modalities=all/);
      assert.deepEqual(body['key'], {
        label: 'chief',
        usage: 1.5,
        limit: null,
        limitRemaining: null,
        isFreeTier: false,
      });
      const checks = body['models'] as { field: string; ok: boolean }[];
      assert.deepEqual(
        checks.map(({ field, ok }) => [field, ok]),
        [
          ['orSttModel', true],
          ['chiefModel', true],
          ['orTtsModel', true],
          ['orTtsVoice', true],
        ],
      );
    });

    it('checks a typed key and typed slugs before they are saved', async () => {
      const response = await request('POST', '/api/voice/test/openrouter-key', {
        key: 'sk-or-typed',
        models: {
          orSttModel: 'inclusionai/ling-3.0-flash',
          chiefModel: 'meta-llama/no-tools',
          orTtsModel: 'google/gemini-3.8-flash-lite-tts',
          orTtsVoice: 'alloy',
        },
      });
      const checks = (await json(response))['models'] as {
        field: string;
        ok: boolean;
        problem: string | null;
      }[];

      assert.equal(seen['/or/key']?.authorization, 'Bearer sk-or-typed');
      assert.deepEqual(
        checks.map(({ ok }) => ok),
        [false, false, true, false],
      );
      assert.match(checks[0]?.problem ?? '', /not a speech-to-text model/);
      assert.match(checks[1]?.problem ?? '', /tool calling/);
      assert.match(checks[3]?.problem ?? '', /Kore, Puck/);
    });

    it('reports a slug OpenRouter does not know', async () => {
      const response = await request('POST', '/api/voice/test/openrouter-key', {
        key: 'sk-or-typed',
        models: { chiefModel: 'nobody/nothing' },
      });
      const checks = (await json(response))['models'] as { field: string; problem: string | null }[];

      assert.match(checks[1]?.problem ?? '', /no model called "nobody\/nothing"/);
    });

    it('validates slugs without a key when asked for the models only', async () => {
      const response = await request('POST', '/api/voice/test/openrouter-key', {
        modelsOnly: true,
        models: { orTtsVoice: 'Puck' },
      });
      const body = await json(response);

      assert.equal(response.status, 200);
      assert.equal(seen['/or/key'], undefined);
      assert.equal(body['key'], null);
      assert.ok((body['models'] as { ok: boolean }[]).every(({ ok }) => ok));
    });

    it('needs a key', async () => {
      const response = await request('POST', '/api/voice/test/openrouter-key', {});

      assert.equal(response.status, 400);
      assert.equal((await json(response))['error'], 'openrouter_key_missing');
    });

    it('shows OpenRouter’s own error text for a refused key', async () => {
      replies['/or/key'] = { status: 401, body: { error: { message: 'User not found.', code: 401 } } };

      const response = await request('POST', '/api/voice/test/openrouter-key', { key: 'sk-or-bad' });
      const body = await json(response);

      assert.equal(response.status, 400);
      assert.equal(body['error'], 'openrouter_unauthorized');
      assert.match(String(body['message']), /User not found\./);
    });
  });

  describe('POST /api/voice/test/elevenlabs-key', () => {
    it('shows the remaining credits', async () => {
      setSetting(db, 'elevenlabs_api_key', 'sk_el_stored');
      replies['/el/v1/user/subscription'] = {
        status: 200,
        body: {
          tier: 'creator',
          character_count: 21_000,
          character_limit: 121_000,
          next_character_count_reset_unix: 1_790_000_000,
        },
      };

      const response = await request('POST', '/api/voice/test/elevenlabs-key');
      const body = await json(response);

      assert.equal(response.status, 200);
      assert.equal(seen['/el/v1/user/subscription']?.['xi-api-key'], 'sk_el_stored');
      assert.deepEqual(body, {
        tier: 'creator',
        characterCount: 21_000,
        characterLimit: 121_000,
        remaining: 100_000,
        resetsAt: new Date(1_790_000_000 * 1000).toISOString(),
      });
    });

    it('reports a provider outage as 502 with its text', async () => {
      replies['/el/v1/user/subscription'] = { status: 503, body: 'upstream overloaded' };

      const response = await request('POST', '/api/voice/test/elevenlabs-key', { key: 'sk_el_typed' });
      const body = await json(response);

      assert.equal(response.status, 502);
      assert.equal(body['error'], 'elevenlabs_error');
      assert.match(String(body['message']), /503: upstream overloaded/);
    });
  });

  it('is behind the password', async () => {
    const response = await fetch(`${baseUrl}/api/voice/voices`);

    assert.equal(response.status, 401);
  });
});
