import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from './config.js';

describe('voice config (voice US-001)', () => {
  it('uses the plan §14.2 defaults', () => {
    const config = loadConfig({});

    assert.equal(config.voiceIdleTimeoutMs, 600_000);
    assert.equal(config.voiceKeepAgentsMs, 900_000);
    assert.equal(config.voiceMaxSessionAgents, 3);
    assert.equal(config.voiceSttTimeoutMs, 8_000);
    assert.equal(config.voiceMaxUtteranceMs, 60_000);
    assert.equal(config.voiceChiefMaxToolHops, 6);
    assert.equal(config.voiceScribeIdleCloseMs, 20_000);
    assert.equal(config.openrouterApiUrl, 'https://openrouter.ai/api/v1');
    assert.equal(config.elevenlabsApiUrl, 'https://api.elevenlabs.io');
  });

  it('reads values inside the bounds, edges included', () => {
    const config = loadConfig({
      VOICE_IDLE_TIMEOUT_MS: '60000',
      VOICE_KEEP_AGENTS_MS: '0',
      VOICE_MAX_SESSION_AGENTS: '20',
      VOICE_STT_TIMEOUT_MS: '1000',
      VOICE_MAX_UTTERANCE_MS: '60000',
      VOICE_CHIEF_MAX_TOOL_HOPS: '1',
      VOICE_SCRIBE_IDLE_CLOSE_MS: '600000',
      OPENROUTER_API_URL: 'http://127.0.0.1:9/api/v1/',
    });

    assert.equal(config.voiceIdleTimeoutMs, 60_000);
    assert.equal(config.voiceKeepAgentsMs, 0);
    assert.equal(config.voiceMaxSessionAgents, 20);
    assert.equal(config.voiceSttTimeoutMs, 1_000);
    assert.equal(config.voiceMaxUtteranceMs, 60_000);
    assert.equal(config.voiceChiefMaxToolHops, 1);
    assert.equal(config.voiceScribeIdleCloseMs, 600_000);
    assert.equal(config.openrouterApiUrl, 'http://127.0.0.1:9/api/v1');
  });

  for (const [name, value] of [
    ['VOICE_IDLE_TIMEOUT_MS', '59999'],
    ['VOICE_KEEP_AGENTS_MS', '-1'],
    ['VOICE_MAX_SESSION_AGENTS', '0'],
    ['VOICE_MAX_SESSION_AGENTS', '21'],
    ['VOICE_STT_TIMEOUT_MS', '999'],
    ['VOICE_MAX_UTTERANCE_MS', '60001'],
    ['VOICE_CHIEF_MAX_TOOL_HOPS', '0'],
    ['VOICE_SCRIBE_IDLE_CLOSE_MS', '600001'],
  ] as const) {
    it(`rejects ${name}=${value}`, () => {
      assert.throws(() => loadConfig({ [name]: value }), new RegExp(`${name} must be between`));
    });
  }

  it('rejects a value that is not an integer', () => {
    assert.throws(() => loadConfig({ VOICE_STT_TIMEOUT_MS: 'soon' }), /must be an integer/);
  });
});
