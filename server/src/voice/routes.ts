import express, { type Response, Router } from 'express';

import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import {
  getElevenLabsApiKey,
  getOpenRouterApiKey,
  getVoiceSettings,
  isValidOpenRouterSlug,
  isValidOpenRouterVoice,
} from '../settings/index.js';
import {
  checkOpenRouterSlugs,
  fetchElevenLabsSubscription,
  fetchElevenLabsVoices,
  fetchOpenRouterKey,
  fetchOpenRouterModels,
  type OpenRouterSlugs,
  VoiceProviderError,
} from './providers.js';
import { SttError, SttService } from './stt/index.js';

/** A rejected request body: an error code plus something to show the operator. */
interface Invalid {
  readonly error: string;
  readonly message: string;
}

/**
 * The voice feature's REST routes (voice US-001; plan §14.3). Mounted behind
 * `requireApiAuth` like every other API router. This story adds the three the
 * Settings page needs; later stories add theirs here.
 *
 * Provider keys never leave the server: the voice list and both checks are
 * made from here with the stored key (or, for the checks, a key the operator
 * has typed but not saved yet), and only the provider's answer goes back.
 */
export function createVoiceRouter(db: Database, config: Config): Router {
  const router = Router();
  const stt = new SttService(db, config);

  // The ElevenLabs voice picker's options, proxied so the key stays here.
  router.get('/voice/voices', (_req, res) => {
    const key = getElevenLabsApiKey(db);
    if (key === null) {
      res.status(400).json({
        error: 'elevenlabs_key_missing',
        message: 'Save an ElevenLabs API key first.',
      });
      return;
    }
    fetchElevenLabsVoices(config.elevenlabsApiUrl, key)
      .then((voices) => res.status(200).json({ voices }))
      .catch((cause: unknown) => sendProviderError(res, cause));
  });

  // Is the key good, and does every OpenRouter slug in Settings → Voice name a
  // model of the right kind? Takes the key and the slugs from the body when the
  // operator has typed them, so they can be checked before they are saved.
  // `modelsOnly: true` skips the key: the catalog is public, and the page
  // validates changed slugs on save whether or not a key exists yet.
  router.post('/voice/test/openrouter-key', (req, res) => {
    const body = parseBody(req.body);
    if ('error' in body) {
      res.status(400).json(body);
      return;
    }
    if (body['modelsOnly'] === true) {
      const slugs = parseSlugs(body['models'], getVoiceSettings(db));
      if ('error' in slugs) {
        res.status(400).json(slugs);
        return;
      }
      fetchOpenRouterModels(config.openrouterApiUrl)
        .then((models) => res.status(200).json({ key: null, models: checkOpenRouterSlugs(slugs, models) }))
        .catch((cause: unknown) => sendProviderError(res, cause));
      return;
    }
    const key = candidateKey(body, 'invalid_openrouter_api_key') ?? getOpenRouterApiKey(db);
    if (typeof key === 'object' && key !== null) {
      res.status(400).json(key);
      return;
    }
    if (key === null) {
      res.status(400).json({
        error: 'openrouter_key_missing',
        message: 'Save an OpenRouter API key first, or enter one to check.',
      });
      return;
    }
    const slugs = parseSlugs(body['models'], getVoiceSettings(db));
    if ('error' in slugs) {
      res.status(400).json(slugs);
      return;
    }

    Promise.all([
      fetchOpenRouterKey(config.openrouterApiUrl, key),
      fetchOpenRouterModels(config.openrouterApiUrl),
    ])
      .then(([info, models]) => {
        res.status(200).json({ key: info, models: checkOpenRouterSlugs(slugs, models) });
      })
      .catch((cause: unknown) => sendProviderError(res, cause));
  });

  // Is the key good, and how many credits are left this period?
  router.post('/voice/test/elevenlabs-key', (req, res) => {
    const body = parseBody(req.body);
    if ('error' in body) {
      res.status(400).json(body);
      return;
    }
    const key = candidateKey(body, 'invalid_elevenlabs_api_key') ?? getElevenLabsApiKey(db);
    if (typeof key === 'object' && key !== null) {
      res.status(400).json(key);
      return;
    }
    if (key === null) {
      res.status(400).json({
        error: 'elevenlabs_key_missing',
        message: 'Save an ElevenLabs API key first, or enter one to check.',
      });
      return;
    }
    fetchElevenLabsSubscription(config.elevenlabsApiUrl, key)
      .then((subscription) => res.status(200).json(subscription))
      .catch((cause: unknown) => sendProviderError(res, cause));
  });

  // Settings → "Test microphone": three seconds of WAV from the browser,
  // transcribed exactly as a call's utterance would be (voice US-004). Always
  // OpenRouter, whatever `voice_stt_provider` says: the other two providers
  // transcribe in the browser and have nothing to test here.
  router.post(
    '/voice/test/stt',
    express.raw({ type: ['audio/wav', 'audio/wave', 'audio/x-wav', 'application/octet-stream'], limit: '3mb' }),
    (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ error: 'invalid_audio', message: 'Send the recording as an audio/wav body.' });
        return;
      }
      const started = performance.now();
      stt
        .transcribe(req.body, undefined, { provider: 'openrouter' })
        .then((result) => {
          const ms = Math.round(performance.now() - started);
          if (result.kind === 'rejected') {
            res.status(400).json({ error: `audio_${result.reason}`, message: result.message });
            return;
          }
          // A dropped hallucination is what a call would do with it: nothing heard.
          res.status(200).json({ text: result.kind === 'text' ? result.text : '', ms });
        })
        .catch((cause: unknown) => sendSttError(res, cause));
    },
  );

  return router;
}

/** Same rule as {@link sendProviderError}: never 401. */
function sendSttError(res: Response, cause: unknown): void {
  if (!(cause instanceof SttError)) {
    res.status(500).json({ error: 'stt_failed', message: String(cause) });
    return;
  }
  if (cause.kind === 'unconfigured') {
    res.status(400).json({ error: 'openrouter_key_missing', message: cause.message });
    return;
  }
  const refused = cause.status === 401 || cause.status === 403;
  res.status(refused ? 400 : 502).json({
    error: refused ? 'openrouter_unauthorized' : `stt_${cause.kind}`,
    message: cause.message,
  });
}

function parseBody(body: unknown): Record<string, unknown> | Invalid {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'invalid_body', message: 'Expected a JSON object.' };
  }
  return body as Record<string, unknown>;
}

/** A key typed on the page; `null` means "use the stored one". */
function candidateKey(body: Record<string, unknown>, error: string): string | Invalid | null {
  const raw = body['key'];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return { error, message: 'The key must be a string.' };
  const key = raw.trim();
  return key === '' ? null : key;
}

/** The slugs to check: typed ones where given, the saved ones otherwise. */
function parseSlugs(raw: unknown, saved: OpenRouterSlugs): OpenRouterSlugs | Invalid {
  if (raw === undefined || raw === null) return pickSlugs(saved);
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'invalid_models', message: 'models must be a JSON object.' };
  }
  const input = raw as Record<string, unknown>;
  const slugs: Record<keyof OpenRouterSlugs, string> = { ...pickSlugs(saved) };
  for (const field of SLUG_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    const isValid = field === 'orTtsVoice' ? isValidOpenRouterVoice : isValidOpenRouterSlug;
    if (typeof value !== 'string' || !isValid(value.trim())) {
      return { error: 'invalid_models', message: `${field} is not a valid OpenRouter name.` };
    }
    slugs[field] = value.trim();
  }
  return slugs;
}

const SLUG_FIELDS = ['orSttModel', 'chiefModel', 'orTtsModel', 'orTtsVoice'] as const;

function pickSlugs(saved: OpenRouterSlugs): OpenRouterSlugs {
  return {
    orSttModel: saved.orSttModel,
    chiefModel: saved.chiefModel,
    orTtsModel: saved.orTtsModel,
    orTtsVoice: saved.orTtsVoice,
  };
}

/**
 * Never 401: that status is reserved for *our* expired session cookie, and the
 * SPA redirects to /login on it. A refused key is a 400, a provider that is
 * down or confused is a 502, and both carry the provider's own words.
 */
function sendProviderError(res: Response, cause: unknown): void {
  if (cause instanceof VoiceProviderError) {
    const status = cause.kind === 'unauthorized' ? 400 : 502;
    const code = `${cause.provider}_${cause.kind}`;
    res.status(status).json({ error: code, message: cause.message });
    return;
  }
  res.status(500).json({ error: 'voice_provider_failed', message: String(cause) });
}
