/**
 * Browser audio → the 16 kHz mono PCM16 WAV the server's speech-to-text takes
 * (voice US-004; docs/voice-plan.md §7.1). The call's VAD (US-009) hands 16 kHz Float32
 * frames straight to {@link encodeWav}, push-to-talk its PCM16 batches to
 * {@link encodeWavPcm16}; the Settings microphone test records
 * at the device rate and goes through {@link recordWav}.
 */

export const WAV_SAMPLE_RATE = 16_000;

/** Float32 samples in [-1, 1] → PCM16, clamped. */
export function floatToPcm16(samples: Float32Array): Int16Array<ArrayBuffer> {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcm;
}

/** Float32 samples in [-1, 1] at 16 kHz → a canonical 44-byte-header WAV. */
export function encodeWav(samples: Float32Array): ArrayBuffer {
  return encodeWavPcm16(floatToPcm16(samples));
}

/**
 * 16 kHz mono PCM16 samples → a canonical WAV: a 44-byte header (`RIFF`,
 * a 16-byte `fmt ` chunk, `data`) followed by the samples, little-endian.
 * Push-to-talk feeds the capture worklet's Int16 batches straight in.
 */
export function encodeWavPcm16(samples: Int16Array): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, WAV_SAMPLE_RATE, true);
  view.setUint32(28, WAV_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i] ?? 0, true);
  return buffer;
}

/**
 * Records `ms` of microphone audio and returns it as a 16 kHz WAV. The
 * context runs at the device rate (Firefox refuses to connect a microphone to
 * a context at another rate); an `OfflineAudioContext` resamples afterwards.
 */
export async function recordWav(ms: number): Promise<ArrayBuffer> {
  if (!window.isSecureContext) {
    throw new Error('The microphone needs HTTPS (or localhost). Open chief-web over HTTPS to test it.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const context = new AudioContext();
  try {
    const source = context.createMediaStreamSource(stream);
    // ScriptProcessor is deprecated but needs no worklet file for a 3 s test.
    const processor = context.createScriptProcessor(4096, 1, 1);
    const chunks: Float32Array<ArrayBuffer>[] = [];
    processor.onaudioprocess = (event) => {
      chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    source.connect(processor);
    processor.connect(context.destination);
    await new Promise((resolve) => setTimeout(resolve, ms));
    processor.disconnect();
    source.disconnect();

    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (length === 0) throw new Error('The microphone delivered no audio.');
    const recorded = context.createBuffer(1, length, context.sampleRate);
    let offset = 0;
    for (const chunk of chunks) {
      recorded.copyToChannel(chunk, 0, offset);
      offset += chunk.length;
    }
    return encodeWav(await resample(recorded));
  } finally {
    for (const track of stream.getTracks()) track.stop();
    void context.close();
  }
}

async function resample(buffer: AudioBuffer): Promise<Float32Array> {
  if (buffer.sampleRate === WAV_SAMPLE_RATE) return buffer.getChannelData(0);
  const offline = new OfflineAudioContext(1, Math.ceil(buffer.duration * WAV_SAMPLE_RATE), WAV_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  return (await offline.startRendering()).getChannelData(0);
}
