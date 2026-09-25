import type { Config } from '../../config.js';
import type { Database } from '../../db/index.js';
import {
  getElevenLabsApiKey,
  getOpenRouterApiKey,
  getVoiceElExhaustedUntil,
  getVoiceSettings,
  setVoiceElExhaustedUntil,
} from '../../settings/index.js';
import { fetchElevenLabsSubscription } from '../providers.js';
import { ElevenLabsTts } from './elevenlabs.js';
import { OpenRouterTts } from './openrouter.js';
import { TtsError, type TtsFormat, type TtsProvider, type TtsProviderName, type TtsSegment } from './types.js';

export { classify, ELEVENLABS_SAMPLE_RATE, ElevenLabsTts, KEEP_ALIVE_MS, parseElevenLabsMessage } from './elevenlabs.js';
export { MAX_IN_FLIGHT, OpenRouterTts } from './openrouter.js';
export { TtsError, type TtsErrorKind, type TtsFormat, type TtsProvider, type TtsProviderName, type TtsSegment } from './types.js';

/** The toast of docs/voice-plan.md §8.6. */
export const SWITCHED_TOAST = 'Switched to backup voice';
/** docs/voice-plan.md §8.6: this many ElevenLabs socket failures ... */
export const SOCKET_FAILURES_TO_SWITCH = 2;
/** ... within this window switch the call to OpenRouter. */
export const SOCKET_FAILURE_WINDOW_MS = 30_000;
/** How long to hold ElevenLabs off after a quota error when the reset time is unknown. */
export const EXHAUSTED_FALLBACK_MS = 60 * 60 * 1000;

/** Where the call hears about the voice: the call socket (US-007) implements it. */
export interface TtsSink {
  /** A `ui` toast. */
  toast(text: string): void;
  /** An `error` message; text-to-speech failures are never fatal to a call. */
  error(error: { code: string; message: string; fatal: false }): void;
  /** Characters sent to a provider for one segment, for `voice_calls` and the usage meter. */
  chars(usage: { provider: TtsProviderName; segmentId: number; turn: number; chars: number; generationId?: string }): void;
  /** The call now speaks through another provider (`voice_calls.tts_provider`). */
  providerChanged?(provider: TtsProviderName): void;
}

export interface SpeakCallbacks {
  /** Called once, before the first chunk, with the format the audio will be in. */
  readonly onStart?: (format: TtsFormat, provider: TtsProviderName) => void;
  readonly onAudio: (chunk: Buffer) => void;
}

export interface SpeakResult {
  /** False when no provider could speak it: the reply is text only. */
  readonly spoken: boolean;
  readonly provider: TtsProviderName;
  readonly chars: number;
}

export interface TtsServiceDeps {
  readonly now?: () => number;
  /** ElevenLabs keep-alive interval, shortened by tests. */
  readonly keepAliveMs?: number;
}

/**
 * Text-to-speech for one call with the fallback policy of docs/voice-plan.md §8.6. The call
 * starts on ElevenLabs unless it has no key or voice, or credits ran out
 * earlier (`voice_el_exhausted_until` still in the future). ElevenLabs 401,
 * 402 or a quota error, or two socket failures within 30 s, switch the call
 * to OpenRouter for good, with a "Switched to backup voice" toast; the failed
 * segment is retried there. If OpenRouter fails too, the segment stays text
 * only and the call gets one non-fatal `error` per turn.
 *
 * `speak` may be called for several segments of a turn without waiting: audio
 * is handed out strictly in call order, a later segment's early audio held
 * back until the one before it is done.
 */
export class TtsService {
  private provider: TtsProvider | null = null;
  private elevenlabs: ElevenLabsTts | null = null;
  private openrouter: OpenRouterTts | null = null;
  private socketFailures: { at: number; connection: number }[] = [];
  private readonly errorTurns = new Set<number>();
  private readonly background: Promise<void>[] = [];
  /** Resolves when the previous segment's audio has all been handed out. */
  private tail: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private closed = false;

  constructor(
    private readonly db: Database,
    private readonly config: Config,
    private readonly sink: TtsSink,
    private readonly deps: TtsServiceDeps = {},
  ) {
    this.now = deps.now ?? Date.now;
  }

  /** The provider the call speaks through now. */
  get providerName(): TtsProviderName {
    return this.provider?.name ?? 'openrouter';
  }

  get format(): TtsFormat {
    return (this.provider ?? this.backup()).format;
  }

  /** Picks the provider and opens the ElevenLabs socket, at call start. */
  async open(callId: string): Promise<void> {
    const settings = getVoiceSettings(this.db);
    const key = getElevenLabsApiKey(this.db);
    if (key === null || settings.voiceId === null || this.exhausted()) {
      this.provider = this.backup();
      return;
    }
    this.elevenlabs = new ElevenLabsTts({
      baseUrl: this.config.elevenlabsApiUrl,
      apiKey: key,
      modelId: settings.ttsModel,
      ...(this.deps.keepAliveMs === undefined ? {} : { keepAliveMs: this.deps.keepAliveMs }),
    });
    this.provider = this.elevenlabs;
    try {
      await this.elevenlabs.open({ callId, voiceId: settings.voiceId });
    } catch (cause) {
      // A refused key or empty balance switches now; a flaky connect is one
      // strike, and the first segment reconnects.
      this.onElevenLabsFailure(cause);
    }
  }

  async speak(seg: TtsSegment, signal: AbortSignal, callbacks: SpeakCallbacks): Promise<SpeakResult> {
    const previous = this.tail;
    let release = (): void => undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    let head = false;
    const held: Buffer[] = [];
    let started = false;
    const deliver = (provider: TtsProvider, chunk: Buffer): void => {
      if (!started) {
        started = true;
        callbacks.onStart?.(provider.format, provider.name);
      }
      callbacks.onAudio(chunk);
    };
    let current: TtsProvider | null = null;
    const onAudio = (chunk: Buffer): void => {
      if (signal.aborted || current === null) return;
      if (head) deliver(current, chunk);
      else held.push(chunk);
    };
    void previous.then(() => {
      head = true;
      if (current !== null) for (const chunk of held.splice(0)) deliver(current, chunk);
    });

    try {
      const result = await this.speakWithFallback(seg, signal, onAudio, (provider) => {
        current = provider;
        held.length = 0;
      });
      await previous;
      if (current !== null) for (const chunk of held.splice(0)) deliver(current, chunk);
      return result;
    } finally {
      release();
    }
  }

  /** docs/voice-plan.md §8.1: the turn was interrupted; its audio stops. */
  cancelTurn(turn: number): void {
    this.elevenlabs?.cancelTurn(turn);
    this.openrouter?.cancelTurn(turn);
  }

  async close(): Promise<void> {
    // Speaks the close rejects are the call ending, not ElevenLabs failing.
    this.closed = true;
    await Promise.allSettled([this.elevenlabs?.close(), this.openrouter?.close(), ...this.background]);
  }

  private async speakWithFallback(
    seg: TtsSegment,
    signal: AbortSignal,
    onAudio: (chunk: Buffer) => void,
    using: (provider: TtsProvider) => void,
  ): Promise<SpeakResult> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const provider = this.provider ?? this.backup();
      using(provider);
      try {
        const { chars, generationId } = await provider.speak(seg, signal, onAudio);
        if (chars > 0) {
          const usage = { provider: provider.name, segmentId: seg.segmentId, turn: seg.turn, chars };
          this.sink.chars(generationId === undefined ? usage : { ...usage, generationId });
        }
        return { spoken: true, provider: provider.name, chars };
      } catch (cause) {
        if (signal.aborted) throw signal.reason;
        if (this.closed) return { spoken: false, provider: provider.name, chars: 0 };
        if (provider.name === 'elevenlabs') {
          this.onElevenLabsFailure(cause);
          continue; // Reconnected ElevenLabs, or OpenRouter after a switch.
        }
        this.bothFailed(seg, cause);
        return { spoken: false, provider: provider.name, chars: 0 };
      }
    }
    this.bothFailed(seg, new TtsError('socket', 0, 'ElevenLabs kept failing.'));
    return { spoken: false, provider: this.providerName, chars: 0 };
  }

  private onElevenLabsFailure(cause: unknown): void {
    if (this.provider !== this.elevenlabs) return;
    const error = cause instanceof TtsError ? cause : new TtsError('socket', 0, String(cause));
    if (error.kind === 'unauthorized' || error.kind === 'quota' || error.kind === 'unconfigured') {
      if (error.kind === 'quota') this.background.push(this.holdElevenLabs());
      this.switchToBackup();
      return;
    }
    const now = this.now();
    this.socketFailures = this.socketFailures.filter((f) => now - f.at < SOCKET_FAILURE_WINDOW_MS);
    if (this.socketFailures.some((f) => f.connection === error.connection && error.connection !== 0)) return;
    this.socketFailures.push({ at: now, connection: error.connection });
    if (this.socketFailures.length >= SOCKET_FAILURES_TO_SWITCH) this.switchToBackup();
  }

  private switchToBackup(): void {
    const elevenlabs = this.elevenlabs;
    this.provider = this.backup();
    this.sink.toast(SWITCHED_TOAST);
    this.sink.providerChanged?.('openrouter');
    if (elevenlabs !== null) this.background.push(elevenlabs.close());
  }

  /** Out of credits: later calls start on OpenRouter until the balance resets. */
  private async holdElevenLabs(): Promise<void> {
    let until = new Date(this.now() + EXHAUSTED_FALLBACK_MS).toISOString();
    const key = getElevenLabsApiKey(this.db);
    if (key !== null) {
      try {
        const subscription = await fetchElevenLabsSubscription(this.config.elevenlabsApiUrl, key);
        if (subscription.resetsAt !== null) until = subscription.resetsAt;
      } catch {
        // The fallback hold applies.
      }
    }
    setVoiceElExhaustedUntil(this.db, until);
  }

  private exhausted(): boolean {
    const until = getVoiceElExhaustedUntil(this.db);
    if (until === null) return false;
    if (Date.parse(until) > this.now()) return true;
    setVoiceElExhaustedUntil(this.db, null);
    return false;
  }

  private bothFailed(seg: TtsSegment, cause: unknown): void {
    if (this.errorTurns.has(seg.turn)) return;
    this.errorTurns.add(seg.turn);
    const detail = cause instanceof Error ? cause.message : String(cause);
    this.sink.error({ code: 'tts_failed', message: `The reply could not be spoken: ${detail}`, fatal: false });
  }

  private backup(): OpenRouterTts {
    if (this.openrouter === null) {
      const settings = getVoiceSettings(this.db);
      this.openrouter = new OpenRouterTts({
        baseUrl: this.config.openrouterApiUrl,
        apiKey: getOpenRouterApiKey(this.db) ?? '',
        model: settings.orTtsModel,
        voice: settings.orTtsVoice,
        sampleRate: settings.orTtsSampleRate,
      });
    }
    return this.openrouter;
  }
}

/**
 * One sentence spoken start to finish, for the Settings "Play test voice"
 * button (`POST /api/voice/test/tts`). Throws a {@link TtsError}.
 */
export async function synthesizeOnce(
  db: Database,
  config: Config,
  provider: TtsProviderName,
  text: string,
  signal: AbortSignal,
): Promise<{ audio: Buffer; format: TtsFormat }> {
  const settings = getVoiceSettings(db);
  const chunks: Buffer[] = [];
  let tts: TtsProvider;
  if (provider === 'elevenlabs') {
    const key = getElevenLabsApiKey(db);
    if (key === null) throw new TtsError('unconfigured', 0, 'Save an ElevenLabs API key first.');
    if (settings.voiceId === null) throw new TtsError('unconfigured', 0, 'Choose an ElevenLabs voice first.');
    tts = new ElevenLabsTts({ baseUrl: config.elevenlabsApiUrl, apiKey: key, modelId: settings.ttsModel });
    await tts.open({ callId: 'test', voiceId: settings.voiceId });
  } else {
    const key = getOpenRouterApiKey(db);
    if (key === null) throw new TtsError('unconfigured', 0, 'Save an OpenRouter API key first.');
    tts = new OpenRouterTts({
      baseUrl: config.openrouterApiUrl,
      apiKey: key,
      model: settings.orTtsModel,
      voice: settings.orTtsVoice,
      sampleRate: settings.orTtsSampleRate,
    });
  }
  try {
    await tts.speak({ segmentId: 1, turn: 1, text, last: true }, signal, (chunk) => chunks.push(chunk));
  } finally {
    await tts.close();
  }
  return { audio: Buffer.concat(chunks), format: tts.format };
}
