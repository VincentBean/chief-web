/**
 * The WAV an utterance arrives in (voice US-004; docs/voice-plan.md §7.1): 16 kHz mono PCM16,
 * as `web/src/voice/wav.ts` writes it. Checked before anything is sent to a
 * provider, so a VAD misfire or a runaway recording costs nothing.
 */

export const WAV_SAMPLE_RATE = 16_000;

/** Shorter than this is a VAD misfire, not speech. */
export const MIN_UTTERANCE_MS = 250;

/**
 * Why an utterance was refused before transcription. Distinct from a provider
 * failure (`SttError`): the call says "I didn't catch that" for these without
 * treating the provider as broken.
 */
export type WavRejection = 'not_wav' | 'unsupported_format' | 'too_short' | 'too_long';

export type WavCheck =
  | { readonly ok: true; readonly durationMs: number }
  | { readonly ok: false; readonly reason: WavRejection; readonly message: string };

const BYTES_PER_SECOND = WAV_SAMPLE_RATE * 2;

/**
 * Walks the RIFF chunks rather than assuming the canonical 44-byte header, so
 * a writer that adds a `LIST` chunk is still accepted. The duration comes from
 * the `data` chunk's declared size, capped at what the buffer actually holds.
 */
export function checkWav(wav: Buffer, maxUtteranceMs: number): WavCheck {
  if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    return { ok: false, reason: 'not_wav', message: 'The audio is not a WAV file.' };
  }
  let format: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let dataBytes: number | null = null;
  let offset = 12;
  while (offset + 8 <= wav.length && dataBytes === null) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= wav.length) {
      format = {
        audioFormat: wav.readUInt16LE(body),
        channels: wav.readUInt16LE(body + 2),
        sampleRate: wav.readUInt32LE(body + 4),
        bitsPerSample: wav.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataBytes = Math.min(size, wav.length - body);
    }
    // Chunks are word-aligned: an odd size is followed by one pad byte.
    offset = body + size + (size % 2);
  }
  if (format === null || dataBytes === null) {
    return { ok: false, reason: 'not_wav', message: 'The WAV file has no fmt or data chunk.' };
  }
  if (
    format.audioFormat !== 1 ||
    format.channels !== 1 ||
    format.sampleRate !== WAV_SAMPLE_RATE ||
    format.bitsPerSample !== 16
  ) {
    return {
      ok: false,
      reason: 'unsupported_format',
      message: `Expected 16 kHz mono 16-bit PCM, got ${String(format.sampleRate)} Hz, ${String(format.channels)} channel(s), ${String(format.bitsPerSample)}-bit (format ${String(format.audioFormat)}).`,
    };
  }
  const durationMs = Math.round((dataBytes / BYTES_PER_SECOND) * 1000);
  if (durationMs < MIN_UTTERANCE_MS) {
    return { ok: false, reason: 'too_short', message: `The utterance is ${String(durationMs)} ms; at least ${String(MIN_UTTERANCE_MS)} ms is needed.` };
  }
  if (durationMs > maxUtteranceMs) {
    return { ok: false, reason: 'too_long', message: `The utterance is ${String(durationMs)} ms; at most ${String(maxUtteranceMs)} ms is allowed.` };
  }
  return { ok: true, durationMs };
}
