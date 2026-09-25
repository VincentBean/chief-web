/**
 * The text-to-speech provider contract (voice US-006; docs/voice-plan.md §8.1). A call holds
 * one provider at a time; `TtsService` (tts/index.ts) picks it and falls back.
 */

export type TtsProviderName = 'elevenlabs' | 'openrouter';

export type TtsFormat = { readonly kind: 'pcm16'; readonly sampleRate: number } | { readonly kind: 'mp3' };

export interface TtsSegment {
  /** The call's segment id; the browser matches audio frames on it. */
  readonly segmentId: number;
  /** The turn the segment belongs to; ElevenLabs speaks it in context `t<turn>`. */
  readonly turn: number;
  /** Speakable text (speakable.ts). May be `''` on a `last` segment: "that was all". */
  readonly text: string;
  /**
   * The turn's final segment. ElevenLabs sends `flush` after it so a trailing
   * sentence without punctuation is spoken too. When the chunker's `flush()`
   * yields nothing, send an empty `last` segment.
   */
  readonly last: boolean;
}

export interface TtsProvider {
  readonly name: TtsProviderName;
  readonly format: TtsFormat;
  /** Opens per-call resources (sockets). */
  open(call: { callId: string; voiceId: string }): Promise<void>;
  /**
   * Streams audio for one segment; must stop promptly when `signal` aborts,
   * rejecting with `signal.reason`. Resolves when the segment's audio is
   * complete, not when its text is accepted, so segments of one turn may be
   * spoken concurrently and still finish in order. `chars` is what was sent
   * to the provider (what it bills); `generationId` is OpenRouter's
   * `X-Generation-Id`, whose cost is looked up after the call (US-023).
   */
  speak(seg: TtsSegment, signal: AbortSignal, onAudio: (chunk: Buffer) => void): Promise<{ chars: number; generationId?: string }>;
  /** Cancels all in-flight audio for a turn (barge-in). Never reconnects. */
  cancelTurn(turn: number): void;
  close(): Promise<void>;
}

/**
 * `unauthorized` (401/403) and `quota` (402, out of credits) switch a call to
 * the backup voice at once; `socket` is a dropped or refused connection,
 * `http`/`network` an HTTP provider's failure; `unconfigured` a missing key or
 * voice.
 */
export type TtsErrorKind = 'unauthorized' | 'quota' | 'socket' | 'http' | 'network' | 'unconfigured';

export class TtsError extends Error {
  constructor(
    readonly kind: TtsErrorKind,
    /** The provider's HTTP status or WebSocket close code, 0 when there was none. */
    readonly status: number,
    message: string,
    /** For ElevenLabs: which connection of the call failed, so one drop counts once. */
    readonly connection = 0,
  ) {
    super(message);
    this.name = 'TtsError';
  }
}
