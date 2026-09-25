/**
 * Microphone capture for a call (voice US-009; docs/voice-plan.md §13.3): one
 * `getUserMedia` stream (mono, echo cancellation, noise suppression, auto
 * gain) feeding a 16 kHz `AudioContext` with the `pcm16` worklet from
 * `web/public/voice/pcm-worklet.js`. The VAD (`vad.ts`) listens to the same
 * stream and context; push-to-talk (`ptt.ts`) collects the worklet's batches.
 */

export const CAPTURE_SAMPLE_RATE = 16_000;
export const PCM_WORKLET_URL = '/voice/pcm-worklet.js';

/**
 * The capture context. Browsers only let an `AudioContext` run after a user
 * gesture, so call this synchronously from the Call button's click handler
 * (before any `await`), which also resumes it. Firefox refuses to connect a
 * microphone to a context whose rate differs from the device's; this does not
 * work around that.
 */
export function createCaptureContext(): AudioContext {
  const ctx = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE });
  void ctx.resume();
  return ctx;
}

export interface Mic {
  readonly stream: MediaStream;
  readonly ctx: AudioContext;
  /** Posts an `ArrayBuffer` of Int16 samples every ~100 ms. */
  readonly node: AudioWorkletNode;
  setMuted(muted: boolean): void;
  /** Stops the tracks and disconnects the worklet; the context is the caller's. */
  close(): void;
}

export async function openMic(ctx: AudioContext): Promise<Mic> {
  if (!window.isSecureContext) {
    throw new Error('The microphone needs HTTPS (or localhost).');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  try {
    if (ctx.state === 'suspended') await ctx.resume();
    await ctx.audioWorklet.addModule(PCM_WORKLET_URL);
    const node = new AudioWorkletNode(ctx, 'pcm16', { numberOfOutputs: 0 });
    const source = ctx.createMediaStreamSource(stream);
    source.connect(node);
    return {
      stream,
      ctx,
      node,
      setMuted(muted) {
        for (const track of stream.getAudioTracks()) track.enabled = !muted;
      },
      close() {
        source.disconnect();
        node.port.onmessage = null;
        for (const track of stream.getTracks()) track.stop();
      },
    };
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    throw error;
  }
}
