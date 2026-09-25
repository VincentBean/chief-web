import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

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
import {
  DEFAULT_VOICE_CHIEF_MODEL,
  DEFAULT_VOICE_OR_STT_MODEL,
  DEFAULT_VOICE_OR_TTS_MODEL,
  DEFAULT_VOICE_OR_TTS_VOICE,
  DEFAULT_VOICE_PRONUNCIATIONS,
  getElevenLabsApiKey,
  getOpenRouterApiKey,
  getVoiceElExhaustedUntil,
  getVoiceSettings,
  isValidOpenRouterSlug,
  isValidVoiceLanguage,
  isValidVoiceTimezone,
  parseVoiceSettingsUpdate,
  readAppSettings,
  setVoiceElExhaustedUntil,
  updateAppSettings,
  VOICE_FIELDS,
} from './index.js';

describe('voice settings (voice US-001)', () => {
  const config = loadConfig({ CHIEF_WEB_PASSWORD: 'correct horse battery staple' });
  const db: Database = openDatabase(IN_MEMORY);

  after(() => {
    closeDatabase(db);
  });

  beforeEach(() => {
    for (const { key } of Object.values(VOICE_FIELDS)) deleteSetting(db, key);
    deleteSetting(db, 'openrouter_api_key');
    deleteSetting(db, 'elevenlabs_api_key');
    deleteSetting(db, 'voice_el_exhausted_until');
  });

  it('reads every default of plan §14.1 when nothing is stored', () => {
    assert.deepEqual(getVoiceSettings(db), {
      enabled: false,
      sttProvider: 'openrouter',
      orSttModel: DEFAULT_VOICE_OR_STT_MODEL,
      language: 'nl',
      secondaryLanguage: 'en',
      keytermsEnabled: false,
      ttsModel: 'eleven_flash_v2_5',
      voiceId: null,
      orTtsModel: DEFAULT_VOICE_OR_TTS_MODEL,
      orTtsVoice: DEFAULT_VOICE_OR_TTS_VOICE,
      orTtsSampleRate: 24000,
      chiefModel: DEFAULT_VOICE_CHIEF_MODEL,
      sessionModel: 'sonnet',
      vadSilenceMs: 800,
      bargeIn: 'careful',
      eventVerbosity: 'important',
      timezone: 'Europe/Amsterdam',
      pronunciations: {
        PRD: 'P R D',
        PR: 'P R',
        'US-': 'user story ',
        CSV: 'C S V',
        API: 'A P I',
      },
      transcriptRetentionDays: 30,
      pttGlobal: false,
      liveCaptions: 'off',
    });
  });

  it('stores one voice for every agent under voice_voice_id', () => {
    const keys = Object.values(VOICE_FIELDS).map(({ key }) => key);

    assert.ok(keys.includes('voice_voice_id'));
    assert.ok(!keys.includes('voice_session_voice_id' as never));
    assert.ok(!keys.includes('voice_chief_voice_id' as never));
  });

  it('writes each field and reads it back', () => {
    const saved = updateAppSettings(db, config, {
      voice: {
        enabled: true,
        sttProvider: 'browser',
        language: 'de',
        secondaryLanguage: null,
        voiceId: 'JBFqnCBsd6RMkjVDRZzb',
        vadSilenceMs: 400,
        bargeIn: 'off',
        timezone: 'America/New_York',
        pronunciations: {},
        transcriptRetentionDays: 365,
        pttGlobal: true,
        liveCaptions: 'browser',
      },
    }).voice;

    assert.equal(saved.enabled, true);
    assert.equal(saved.sttProvider, 'browser');
    assert.equal(saved.language, 'de');
    assert.equal(saved.secondaryLanguage, null);
    assert.equal(saved.voiceId, 'JBFqnCBsd6RMkjVDRZzb');
    assert.equal(saved.vadSilenceMs, 400);
    assert.equal(saved.bargeIn, 'off');
    assert.equal(saved.timezone, 'America/New_York');
    // A cleared map stays cleared: the starter map only fills a missing row.
    assert.deepEqual(saved.pronunciations, {});
    assert.equal(getSetting(db, 'voice_pronunciations'), '{}');
    assert.equal(saved.transcriptRetentionDays, 365);
    assert.equal(saved.pttGlobal, true);
    assert.equal(saved.liveCaptions, 'browser');
    // Fields left out of the update keep their defaults.
    assert.equal(saved.ttsModel, 'eleven_flash_v2_5');
  });

  it('leaves the voice settings alone when an update does not mention them', () => {
    updateAppSettings(db, config, { voice: { language: 'fr' } });

    assert.equal(updateAppSettings(db, config, { maxConcurrentSessions: 4 }).voice.language, 'fr');
  });

  it('reads a hand-edited row that no longer validates as the default', () => {
    setSetting(db, 'voice_barge_in', 'sometimes');
    setSetting(db, 'voice_vad_silence_ms', '10');
    setSetting(db, 'voice_pronunciations', 'not json');
    setSetting(db, 'voice_language', 'dutch');

    const voice = getVoiceSettings(db);
    assert.equal(voice.bargeIn, 'careful');
    assert.equal(voice.vadSilenceMs, 800);
    assert.deepEqual(voice.pronunciations, DEFAULT_VOICE_PRONUNCIATIONS);
    assert.equal(voice.language, 'nl');
  });

  it('masks both provider keys like the GitHub token, and null deletes them', () => {
    assert.deepEqual(readAppSettings(db, config).openrouterApiKey, { configured: false, last4: null });

    const saved = updateAppSettings(db, config, {
      openrouterApiKey: 'sk-or-v1-abcdef123456',
      elevenlabsApiKey: 'sk_elevenlabs_9876',
    });

    assert.deepEqual(saved.openrouterApiKey, { configured: true, last4: '3456' });
    assert.deepEqual(saved.elevenlabsApiKey, { configured: true, last4: '9876' });
    assert.ok(!JSON.stringify(saved).includes('abcdef'));
    assert.equal(getOpenRouterApiKey(db), 'sk-or-v1-abcdef123456');

    const cleared = updateAppSettings(db, config, { openrouterApiKey: null, elevenlabsApiKey: null });
    assert.deepEqual(cleared.openrouterApiKey, { configured: false, last4: null });
    assert.equal(getElevenLabsApiKey(db), null);
  });

  it('keeps voice_el_exhausted_until out of the settings view', () => {
    setVoiceElExhaustedUntil(db, '2026-10-01T00:00:00.000Z');

    assert.equal(getVoiceElExhaustedUntil(db), '2026-10-01T00:00:00.000Z');
    assert.ok(!JSON.stringify(readAppSettings(db, config)).includes('2026-10-01'));

    setVoiceElExhaustedUntil(db, null);
    assert.equal(getVoiceElExhaustedUntil(db), null);
  });
});

describe('parseVoiceSettingsUpdate (voice US-001)', () => {
  const rejects = (input: unknown, error: string): void => {
    const parsed = parseVoiceSettingsUpdate(input);
    assert.ok('error' in parsed, `expected ${JSON.stringify(input)} to be rejected`);
    assert.equal(parsed.error, error);
  };

  it('accepts a valid update and trims text fields', () => {
    assert.deepEqual(
      parseVoiceSettingsUpdate({
        chiefModel: '  openai/gpt-5-nano ',
        language: 'en',
        secondaryLanguage: '',
        voiceId: null,
        sessionModel: 'haiku',
      }),
      {
        chiefModel: 'openai/gpt-5-nano',
        language: 'en',
        secondaryLanguage: null,
        voiceId: null,
        sessionModel: 'haiku',
      },
    );
  });

  it('rejects unknown enum values', () => {
    rejects({ sttProvider: 'whisper' }, 'invalid_voice_stt_provider');
    rejects({ bargeIn: 'maybe' }, 'invalid_voice_barge_in');
    rejects({ eventVerbosity: 'loud' }, 'invalid_voice_event_verbosity');
    rejects({ liveCaptions: 'scribe' }, 'invalid_voice_live_captions');
    rejects({ ttsModel: 'eleven_v3' }, 'invalid_voice_tts_model');
    rejects({ sessionModel: 'gpt-5' }, 'invalid_voice_session_model');
  });

  it('rejects numbers out of range', () => {
    rejects({ vadSilenceMs: 399 }, 'invalid_voice_vad_silence_ms');
    rejects({ vadSilenceMs: 2001 }, 'invalid_voice_vad_silence_ms');
    rejects({ vadSilenceMs: 800.5 }, 'invalid_voice_vad_silence_ms');
    rejects({ transcriptRetentionDays: 0 }, 'invalid_voice_transcript_retention_days');
    rejects({ transcriptRetentionDays: 366 }, 'invalid_voice_transcript_retention_days');
    rejects({ transcriptRetentionDays: '30' }, 'invalid_voice_transcript_retention_days');
    assert.deepEqual(parseVoiceSettingsUpdate({ transcriptRetentionDays: 1 }), {
      transcriptRetentionDays: 1,
    });
  });

  it('rejects a primary language of null but allows no secondary language', () => {
    rejects({ language: null }, 'invalid_voice_language');
    assert.deepEqual(parseVoiceSettingsUpdate({ secondaryLanguage: null }), {
      secondaryLanguage: null,
    });
  });

  it('checks ISO 639-1 codes, IANA zones and slugs', () => {
    assert.ok(isValidVoiceLanguage('nl'));
    assert.ok(!isValidVoiceLanguage('NL'));
    assert.ok(!isValidVoiceLanguage('nld'));
    assert.ok(!isValidVoiceLanguage('qq'));
    assert.ok(isValidVoiceTimezone('Europe/Amsterdam'));
    assert.ok(isValidVoiceTimezone('UTC'));
    assert.ok(!isValidVoiceTimezone('Europe/Atlantis'));
    assert.ok(isValidOpenRouterSlug('~z-ai/glm-flash-latest'));
    assert.ok(isValidOpenRouterSlug('deepgram/flux-tts:free'));
    assert.ok(!isValidOpenRouterSlug('gpt-5'));
    assert.ok(!isValidOpenRouterSlug('openai/ gpt'));
    rejects({ timezone: 'Mars/Olympus' }, 'invalid_voice_timezone');
    rejects({ language: 'xx' }, 'invalid_voice_language');
    rejects({ orSttModel: 'whisper' }, 'invalid_voice_or_stt_model');
  });

  it('checks the pronunciation map', () => {
    rejects({ pronunciations: ['PRD'] }, 'invalid_voice_pronunciations');
    rejects({ pronunciations: { PRD: 1 } }, 'invalid_voice_pronunciations');
    rejects({ pronunciations: { ' ': 'blank' } }, 'invalid_voice_pronunciations');
    rejects({ pronunciations: null }, 'invalid_voice_pronunciations');
    assert.deepEqual(parseVoiceSettingsUpdate({ pronunciations: { SQL: 'sequel' } }), {
      pronunciations: { SQL: 'sequel' },
    });
  });

  it('refuses the internal credit hold and any other unknown field', () => {
    rejects({ elExhaustedUntil: '2026-10-01T00:00:00Z' }, 'invalid_voice');
    rejects({ voice_el_exhausted_until: '2026-10-01T00:00:00Z' }, 'invalid_voice');
    rejects({ sessionVoiceId: 'abc' }, 'invalid_voice');
    rejects('on', 'invalid_voice');
  });
});
