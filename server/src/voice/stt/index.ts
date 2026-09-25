import type { Config } from '../../config.js';
import type { Database } from '../../db/index.js';
import { getOpenRouterApiKey, getVoiceSettings, type VoiceSettings } from '../../settings/index.js';
import { isHallucination } from './hallucinations.js';
import { SttError, transcribeWithOpenRouter } from './openrouter.js';
import { checkWav, type WavRejection } from './wav.js';

export { HALLUCINATION_MAX_MS, isHallucination } from './hallucinations.js';
export { OPENROUTER_REFERER, OPENROUTER_TITLE, SttError, type SttErrorKind, type Transcript, transcribeWithOpenRouter } from './openrouter.js';
export { checkWav, MIN_UTTERANCE_MS, WAV_SAMPLE_RATE, type WavCheck, type WavRejection } from './wav.js';

export type VoiceSttProvider = VoiceSettings['sttProvider'];

/**
 * One utterance's outcome. `rejected` never reached a provider (a bad or
 * out-of-bounds WAV); `dropped` did, but what came back is silence. Provider
 * failures are thrown as {@link SttError} instead.
 */
export type SttResult =
  | {
      readonly kind: 'text';
      readonly text: string;
      readonly durationMs: number;
      readonly costUsd: number;
      readonly seconds: number;
    }
  | { readonly kind: 'rejected'; readonly reason: WavRejection; readonly message: string }
  | {
      readonly kind: 'dropped';
      readonly reason: 'hallucination';
      readonly text: string;
      readonly durationMs: number;
      readonly costUsd: number;
      readonly seconds: number;
    };

export interface TranscribeOptions {
  /**
   * Force a provider instead of `voice_stt_provider`: a call that fell back
   * from Scribe (US-022) transcribes through OpenRouter for the rest of it.
   */
  readonly provider?: VoiceSttProvider;
}

/**
 * Server-side speech-to-text for a call (voice US-004; plan §4). Settings are
 * read on every utterance, so a changed model or language applies to the next
 * sentence without restarting anything.
 *
 * Only `openrouter` transcribes on the server. `elevenlabs-realtime` and
 * `browser` run in the browser (plan §7.2, §7.3) and deliver a finished
 * transcript, so audio reaching the server under them is refused as
 * `unconfigured` rather than being billed to a provider nobody chose.
 */
export class SttService {
  constructor(
    private readonly db: Database,
    private readonly config: Config,
  ) {}

  /** The configured provider, so the call knows whether the browser transcribes. */
  get provider(): VoiceSttProvider {
    return getVoiceSettings(this.db).sttProvider;
  }

  async transcribe(wav: Buffer, signal?: AbortSignal, options: TranscribeOptions = {}): Promise<SttResult> {
    const settings = getVoiceSettings(this.db);
    const provider = options.provider ?? settings.sttProvider;
    if (provider !== 'openrouter') {
      throw new SttError('unconfigured', 0, '', `Speech-to-text "${provider}" runs in the browser, not on the server.`);
    }

    const check = checkWav(wav, this.config.voiceMaxUtteranceMs);
    if (!check.ok) return { kind: 'rejected', reason: check.reason, message: check.message };

    const apiKey = getOpenRouterApiKey(this.db);
    if (apiKey === null) throw new SttError('unconfigured', 0, '', 'Save an OpenRouter API key first.');

    const transcript = await transcribeWithOpenRouter(wav, {
      baseUrl: this.config.openrouterApiUrl,
      apiKey,
      model: settings.orSttModel,
      // With a secondary language the model detects Dutch or English per
      // utterance; pinning the primary would transcribe English as Dutch.
      language: settings.secondaryLanguage === null ? settings.language : undefined,
      timeoutMs: this.config.voiceSttTimeoutMs,
      signal,
    });
    const result = { ...transcript, durationMs: check.durationMs };
    return isHallucination(transcript.text, check.durationMs)
      ? { kind: 'dropped', reason: 'hallucination', ...result }
      : { kind: 'text', ...result };
  }
}
