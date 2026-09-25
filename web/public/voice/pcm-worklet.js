// The call's capture worklet (voice US-009; docs/voice-plan.md §13.3). Loaded by
// `web/src/voice/mic.ts` into the 16 kHz capture context: it turns the
// microphone into ~100 ms batches of 16 kHz mono PCM16 (1600 samples) and
// posts each batch's ArrayBuffer to the main thread. Push-to-talk collects
// these; a `'flush'` message posts the partial batch so a release loses no
// audio.
class Pcm16 extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(1600);
    this.n = 0;
    this.port.onmessage = (event) => {
      if (event.data !== 'flush') return;
      this.port.postMessage(this.buf.buffer.slice(0, this.n * 2));
      this.n = 0;
    };
  }

  process([input]) {
    const ch = input && input[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = Math.max(-1, Math.min(1, ch[i])) * 0x7fff;
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf.buffer.slice(0));
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm16', Pcm16);
