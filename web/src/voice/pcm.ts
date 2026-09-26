/**
 * Plays raw PCM16 LE mono audio at its sample rate (voice US-006), for the
 * Settings "Play test voice" button. Resolves when playback ends.
 */
export async function playPcm16(pcm: ArrayBuffer, sampleRate: number): Promise<void> {
  const samples = new Int16Array(pcm, 0, Math.floor(pcm.byteLength / 2));
  if (samples.length === 0) return;
  const context = new AudioContext();
  try {
    const buffer = context.createBuffer(1, samples.length, sampleRate);
    const channel = new Float32Array(samples.length) as Float32Array<ArrayBuffer>;
    for (let i = 0; i < samples.length; i += 1) channel[i] = (samples[i] ?? 0) / 32768;
    buffer.copyToChannel(channel, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    await new Promise<void>((resolve) => {
      source.onended = () => resolve();
      source.start();
    });
  } finally {
    await context.close();
  }
}
