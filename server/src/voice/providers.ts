/**
 * The account-level calls Settings → Voice makes to OpenRouter and ElevenLabs
 * (voice US-001): is the key good, what does the catalog hold, how much credit
 * is left, which voices are there.
 *
 * Same shape as `server/src/lib/github.ts`: no SDK, one `fetch` each, and every
 * failure — HTTP or network — turned into a {@link VoiceProviderError} carrying
 * the provider's own words, because "show the provider's error text" is the
 * whole point of the test buttons.
 */

export type VoiceProvider = 'openrouter' | 'elevenlabs';

/**
 * `unauthorized` is a key the provider refused; `unreachable` is a network
 * failure or timeout; `error` is any other non-2xx answer.
 */
export type VoiceProviderErrorKind = 'unauthorized' | 'unreachable' | 'error';

export class VoiceProviderError extends Error {
  constructor(
    readonly provider: VoiceProvider,
    readonly kind: VoiceProviderErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'VoiceProviderError';
  }
}

/** Long enough for a slow catalog listing, short enough for a button press. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Most of a provider's error body worth showing to the operator. */
const MAX_ERROR_CHARS = 500;

const PROVIDER_NAMES: Record<VoiceProvider, string> = {
  openrouter: 'OpenRouter',
  elevenlabs: 'ElevenLabs',
};

async function call(
  provider: VoiceProvider,
  url: string,
  headers: Record<string, string>,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (cause) {
    throw new VoiceProviderError(
      provider,
      'unreachable',
      `${PROVIDER_NAMES[provider]} could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const text = await res.text();
  if (!res.ok) {
    const kind = res.status === 401 || res.status === 403 ? 'unauthorized' : 'error';
    throw new VoiceProviderError(
      provider,
      kind,
      `${PROVIDER_NAMES[provider]} answered ${String(res.status)}: ${errorText(text)}`,
      res.status,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new VoiceProviderError(provider, 'error', `${PROVIDER_NAMES[provider]} answered with something that is not JSON.`);
  }
}

/**
 * The human part of a provider error body. OpenRouter says
 * `{"error":{"message":…}}`; ElevenLabs says `{"detail":{"message":…}}` or
 * `{"detail":"…"}`. Anything else is shown as it came, trimmed.
 */
export function errorText(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    const found = findMessage(parsed);
    if (found !== null) return found.slice(0, MAX_ERROR_CHARS);
  } catch {
    // Not JSON: fall through to the raw text.
  }
  const trimmed = body.trim();
  return trimmed === '' ? 'no error message' : trimmed.slice(0, MAX_ERROR_CHARS);
}

function findMessage(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  for (const key of ['message', 'error', 'detail']) {
    const found = findMessage(record[key]);
    if (found !== null) return found;
  }
  return null;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const num = (value: unknown): number | null => (typeof value === 'number' ? value : null);
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/* ------------------------------------------------------------------------ */
/* OpenRouter                                                               */
/* ------------------------------------------------------------------------ */

/** What `GET /key` says about the key, reduced to what the page shows. */
export interface OpenRouterKeyInfo {
  readonly label: string | null;
  /** Credits spent with this key, in USD. */
  readonly usage: number | null;
  /** The key's own spending cap in USD, or `null` for none. */
  readonly limit: number | null;
  readonly limitRemaining: number | null;
  readonly isFreeTier: boolean;
}

export async function fetchOpenRouterKey(baseUrl: string, apiKey: string): Promise<OpenRouterKeyInfo> {
  const body = record(await call('openrouter', `${baseUrl}/key`, bearer(apiKey)));
  const data = record(body['data']);
  return {
    label: str(data['label']),
    usage: num(data['usage']),
    limit: num(data['limit']),
    limitRemaining: num(data['limit_remaining']),
    isFreeTier: data['is_free_tier'] === true,
  };
}

/** One catalog entry, reduced to what validating a setting needs. */
export interface OpenRouterModel {
  readonly id: string;
  readonly inputModalities: readonly string[];
  readonly outputModalities: readonly string[];
  readonly supportedParameters: readonly string[];
  /** Voices a speech model accepts; empty when the catalog lists none. */
  readonly supportedVoices: readonly string[];
}

/**
 * The whole catalog. `output_modalities=all` matters: without it the listing
 * holds text-output models only, and every speech-to-text and text-to-speech
 * slug would look unknown.
 */
export async function fetchOpenRouterModels(baseUrl: string): Promise<OpenRouterModel[]> {
  const body = record(await call('openrouter', `${baseUrl}/models?output_modalities=all`, {}));
  const data = Array.isArray(body['data']) ? body['data'] : [];
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  return data.flatMap((entry) => {
    const model = record(entry);
    const id = str(model['id']);
    if (id === null) return [];
    const architecture = record(model['architecture']);
    return [
      {
        id,
        inputModalities: strings(architecture['input_modalities']),
        outputModalities: strings(architecture['output_modalities']),
        supportedParameters: strings(model['supported_parameters']),
        supportedVoices: strings(model['supported_voices']),
      },
    ];
  });
}

/** The four OpenRouter slugs Settings → Voice holds, as the operator typed them. */
export interface OpenRouterSlugs {
  readonly orSttModel: string;
  readonly chiefModel: string;
  readonly orTtsModel: string;
  readonly orTtsVoice: string;
}

export interface SlugCheck {
  readonly field: keyof OpenRouterSlugs;
  readonly value: string;
  readonly ok: boolean;
  /** Why it is not usable, or `null` when it is. */
  readonly problem: string | null;
}

const isSpeechToText = (model: OpenRouterModel): boolean =>
  model.inputModalities.includes('audio') &&
  (model.outputModalities.includes('transcription') || model.outputModalities.includes('text'));

const isTextToSpeech = (model: OpenRouterModel): boolean =>
  model.outputModalities.includes('speech') || model.outputModalities.includes('audio');

/**
 * Checks each slug against the catalog: it has to exist, and it has to be the
 * right kind of model for its field — a chat model in the speech-to-text field
 * exists, but it will not transcribe anything.
 */
export function checkOpenRouterSlugs(
  slugs: OpenRouterSlugs,
  models: readonly OpenRouterModel[],
): SlugCheck[] {
  const byId = new Map(models.map((model) => [model.id, model]));
  const check = (
    field: keyof OpenRouterSlugs,
    kind: string,
    fits: (model: OpenRouterModel) => boolean,
  ): SlugCheck => {
    const value = slugs[field];
    const model = byId.get(value);
    if (model === undefined) {
      return { field, value, ok: false, problem: `OpenRouter has no model called "${value}".` };
    }
    if (!fits(model)) {
      return { field, value, ok: false, problem: `"${value}" is not ${kind}.` };
    }
    return { field, value, ok: true, problem: null };
  };

  const tts = byId.get(slugs.orTtsModel);
  const voice: SlugCheck =
    tts === undefined || tts.supportedVoices.length === 0 || tts.supportedVoices.includes(slugs.orTtsVoice)
      ? { field: 'orTtsVoice', value: slugs.orTtsVoice, ok: true, problem: null }
      : {
          field: 'orTtsVoice',
          value: slugs.orTtsVoice,
          ok: false,
          problem: `"${slugs.orTtsModel}" has no voice called "${slugs.orTtsVoice}". It offers: ${tts.supportedVoices.slice(0, 12).join(', ')}${tts.supportedVoices.length > 12 ? ', …' : ''}.`,
        };

  return [
    check('orSttModel', 'a speech-to-text model', isSpeechToText),
    check(
      'chiefModel',
      'a text model that supports tool calling',
      (model) => model.outputModalities.includes('text') && model.supportedParameters.includes('tools'),
    ),
    check('orTtsModel', 'a text-to-speech model', isTextToSpeech),
    voice,
  ];
}

function bearer(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

/* ------------------------------------------------------------------------ */
/* ElevenLabs                                                               */
/* ------------------------------------------------------------------------ */

/** What `GET /v1/user/subscription` says about the credit balance. */
export interface ElevenLabsSubscription {
  readonly tier: string | null;
  readonly characterCount: number;
  readonly characterLimit: number;
  readonly remaining: number;
  /** When the balance resets, as an ISO timestamp, when ElevenLabs says. */
  readonly resetsAt: string | null;
}

export async function fetchElevenLabsSubscription(
  baseUrl: string,
  apiKey: string,
): Promise<ElevenLabsSubscription> {
  const body = record(await call('elevenlabs', `${baseUrl}/v1/user/subscription`, xiKey(apiKey)));
  const characterCount = num(body['character_count']) ?? 0;
  const characterLimit = num(body['character_limit']) ?? 0;
  const reset = num(body['next_character_count_reset_unix']);
  return {
    tier: str(body['tier']),
    characterCount,
    characterLimit,
    remaining: Math.max(0, characterLimit - characterCount),
    resetsAt: reset === null ? null : new Date(reset * 1000).toISOString(),
  };
}

/** One voice of the operator's ElevenLabs library, for the picker. */
export interface ElevenLabsVoice {
  readonly voiceId: string;
  readonly name: string;
  readonly category: string | null;
  readonly previewUrl: string | null;
  /** Accent, gender, age and the like, as ElevenLabs labels them. */
  readonly labels: Readonly<Record<string, string>>;
}

export async function fetchElevenLabsVoices(baseUrl: string, apiKey: string): Promise<ElevenLabsVoice[]> {
  const body = record(await call('elevenlabs', `${baseUrl}/v1/voices`, xiKey(apiKey)));
  const voices = Array.isArray(body['voices']) ? body['voices'] : [];
  return voices.flatMap((entry) => {
    const voice = record(entry);
    const voiceId = str(voice['voice_id']);
    if (voiceId === null) return [];
    const labels: Record<string, string> = {};
    for (const [key, value] of Object.entries(record(voice['labels']))) {
      if (typeof value === 'string') labels[key] = value;
    }
    return [
      {
        voiceId,
        name: str(voice['name']) ?? voiceId,
        category: str(voice['category']),
        previewUrl: str(voice['preview_url']),
        labels,
      },
    ];
  });
}

function xiKey(apiKey: string): Record<string, string> {
  return { 'xi-api-key': apiKey };
}
