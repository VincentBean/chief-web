/**
 * Hands-free turn taking (voice US-009; plan §13.3): Silero v5 through
 * `@ricky0123/vad-web`'s `MicVAD`, listening to the call's own microphone
 * stream and capture context. Each finished utterance goes to the server as
 * one WAV (binary kind `0x01`); speech start and misfires become
 * `speech.start` / `speech.cancel`. The library and its model load lazily, so
 * they stay out of the main bundle.
 *
 * Assets (model, worklet bundle, onnxruntime wasm) are copied to `/voice/vad/`
 * by `vite.config.ts`.
 */
import type { MicVAD } from '@ricky0123/vad-web';
import { encodeWav, WAV_SAMPLE_RATE } from './wav.ts';

export const VAD_ASSET_PATH = '/voice/vad/';
/** Silero v5 scores frames of 512 samples at 16 kHz. */
export const VAD_FRAME_MS = (512 / WAV_SAMPLE_RATE) * 1000;
/** Upstream speech-to-text times out around 60 s; the server rejects > 60 s. */
export const MAX_UTTERANCE_MS = 55_000;

/** Plan §13.3 thresholds, expressed in Silero frames. */
export const VAD_POSITIVE_THRESHOLD = 0.6;
export const VAD_NEGATIVE_THRESHOLD = 0.35;
export const VAD_MIN_SPEECH_FRAMES = 8; // ≈ 250 ms
export const VAD_PRE_SPEECH_PAD_FRAMES = 10;

/** `voice_vad_silence_ms` → the frames of silence that end an utterance. */
export function redemptionFrames(silenceMs: number): number {
  return Math.max(1, Math.round(silenceMs / VAD_FRAME_MS));
}

/**
 * The frame-processor options for a silence setting. vad-web ≥ 0.0.25 takes
 * milliseconds instead of frame counts, so the plan's frame values are
 * converted back with {@link VAD_FRAME_MS}.
 */
export function vadThresholds(silenceMs: number): {
  positiveSpeechThreshold: number;
  negativeSpeechThreshold: number;
  redemptionMs: number;
  minSpeechMs: number;
  preSpeechPadMs: number;
} {
  return {
    positiveSpeechThreshold: VAD_POSITIVE_THRESHOLD,
    negativeSpeechThreshold: VAD_NEGATIVE_THRESHOLD,
    redemptionMs: redemptionFrames(silenceMs) * VAD_FRAME_MS,
    minSpeechMs: VAD_MIN_SPEECH_FRAMES * VAD_FRAME_MS,
    preSpeechPadMs: VAD_PRE_SPEECH_PAD_FRAMES * VAD_FRAME_MS,
  };
}

export interface VadSink {
  speechStart(): void;
  speechCancel(): void;
  /** One utterance, 16 kHz mono PCM16 WAV. */
  utterance(wav: ArrayBuffer): void;
}

export interface Vad {
  /** Stops listening. An utterance in progress is dropped (with `speech.cancel`). */
  pause(): Promise<void>;
  resume(): Promise<void>;
  destroy(): Promise<void>;
}

/** A speech start this soon after a forced split continues the same speech. */
const SPLIT_CONTINUATION_MS = 1000;

export async function startVad(opts: {
  stream: MediaStream;
  ctx: AudioContext;
  silenceMs: number;
  sink: VadSink;
}): Promise<Vad> {
  const { MicVAD } = await import('@ricky0123/vad-web');
  const thresholds = vadThresholds(opts.silenceMs);
  const maxFrames = Math.floor((MAX_UTTERANCE_MS - thresholds.preSpeechPadMs) / VAD_FRAME_MS);

  let speaking = false;
  let speechFrames = 0;
  let splitAt: number | null = null;
  let splitting = false;
  let vad: MicVAD | null = null;

  // Force-splits a long utterance: pausing with `submitUserSpeechOnPause`
  // ends the segment (→ onSpeechEnd with the audio so far), and the restart
  // keeps listening to the same stream.
  const split = async (instance: MicVAD): Promise<void> => {
    splitting = true;
    splitAt = performance.now();
    try {
      instance.setOptions({ submitUserSpeechOnPause: true });
      await instance.pause();
      instance.setOptions({ submitUserSpeechOnPause: false });
      await instance.start();
    } finally {
      splitting = false;
    }
  };

  vad = await MicVAD.new({
    model: 'v5',
    ...thresholds,
    submitUserSpeechOnPause: false,
    startOnLoad: false,
    audioContext: opts.ctx,
    // Reuse the call's stream; the defaults would open and stop their own.
    getStream: async () => opts.stream,
    pauseStream: async () => {},
    resumeStream: async () => opts.stream,
    baseAssetPath: VAD_ASSET_PATH,
    onnxWASMBasePath: VAD_ASSET_PATH,
    onSpeechStart: () => {
      speaking = true;
      speechFrames = 0;
      const continuation = splitAt !== null && performance.now() - splitAt < SPLIT_CONTINUATION_MS;
      splitAt = null;
      if (!continuation) opts.sink.speechStart();
    },
    onFrameProcessed: () => {
      if (!speaking || splitting || vad === null) return;
      speechFrames += 1;
      if (speechFrames >= maxFrames) void split(vad);
    },
    onVADMisfire: () => {
      speaking = false;
      opts.sink.speechCancel();
    },
    onSpeechEnd: (audio) => {
      speaking = false;
      opts.sink.utterance(encodeWav(audio));
    },
  });
  await vad.start();
  const instance = vad;

  return {
    async pause() {
      const wasSpeaking = speaking;
      speaking = false;
      await instance.pause();
      if (wasSpeaking) opts.sink.speechCancel();
    },
    async resume() {
      await instance.start();
    },
    async destroy() {
      speaking = false;
      await instance.destroy();
    },
  };
}
