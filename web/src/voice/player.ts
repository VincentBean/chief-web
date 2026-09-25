/**
 * Plays the agent's voice (voice US-009; plan §8.5, §13.4). Each `tts.segment`
 * is followed by binary kind `0x02` chunks and a `tts.end`. PCM16 chunks are
 * scheduled back to back on a 24 kHz context behind an 80 ms jitter buffer;
 * MP3 segments are accumulated and decoded on `tts.end`. Progress goes back
 * as `playback.progress` so the server knows what was actually heard.
 */

export const PLAYBACK_SAMPLE_RATE = 24_000;
/** Headroom before a chunk that starts from an idle player. */
export const JITTER_BUFFER_S = 0.08;
/** Minimum gap between two progress reports of one segment (`done` always goes). */
const PROGRESS_INTERVAL_MS = 250;

export interface PlaybackProgress {
  readonly segmentId: number;
  readonly playedMs: number;
  readonly done: boolean;
}

export interface SegmentStart {
  readonly segmentId: number;
  readonly turn: number;
  readonly sampleRate: number;
  readonly format: 'pcm16' | 'mp3';
}

interface Scheduled {
  readonly startAt: number;
  readonly ms: number;
}

interface Segment extends SegmentStart {
  /** Sources scheduled and not yet ended. */
  readonly live: Map<AudioBufferSourceNode, Scheduled>;
  playedMs: number;
  ended: boolean;
  /** An odd trailing byte of the last PCM chunk. */
  carry: number | null;
  readonly mp3: Uint8Array[];
  lastReportAt: number;
}

export class AudioPlayer {
  readonly ctx: AudioContext;
  /** Context time where the next chunk starts. */
  private cursor = 0;
  private readonly segments = new Map<number, Segment>();
  /** Turns stopped by `stop()`; their late segments and chunks are dropped. */
  private stoppedThroughTurn = -1;
  /** Bumped by `stop()` so pending MP3 decodes are discarded. */
  private generation = 0;
  /** Set while an MP3 decode holds up the segments after it. */
  private tail: Promise<void> | null = null;
  /** The newest turn whose first audio was scheduled, for `onFirstPlay`. */
  private firstPlayedTurn = -1;
  /** Earcons playing (US-021); they report no progress. */
  private readonly clips = new Set<AudioBufferSourceNode>();

  /**
   * Create this from the Call button's click handler: the context is resumed
   * here, and browsers only allow that during a user gesture.
   */
  constructor(
    private readonly onProgress: (progress: PlaybackProgress) => void,
    /** A turn's first agent audio starts at `atMs` (epoch ms, this clock), for `metrics` (US-026). */
    private readonly onFirstPlay: (turn: number, atMs: number) => void = () => undefined,
  ) {
    this.ctx = new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE });
    void this.ctx.resume();
  }

  /** True while any audio is scheduled or playing. */
  get playing(): boolean {
    if (this.clips.size > 0) return true;
    for (const segment of this.segments.values()) if (segment.live.size > 0) return true;
    return false;
  }

  /**
   * Plays a cached earcon now, or right after what is queued; agent audio
   * that arrives meanwhile follows it. `stop()` silences it like speech.
   */
  playClip(buffer: AudioBuffer): void {
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    const startAt = Math.max(this.cursor, this.ctx.currentTime + JITTER_BUFFER_S);
    source.start(startAt);
    this.cursor = startAt + buffer.duration;
    this.clips.add(source);
    source.onended = () => {
      this.clips.delete(source);
    };
  }

  /** `tts.segment`. */
  beginSegment(start: SegmentStart): void {
    if (start.turn <= this.stoppedThroughTurn) return;
    this.segments.set(start.segmentId, {
      ...start,
      live: new Map(),
      playedMs: 0,
      ended: false,
      carry: null,
      mp3: [],
      lastReportAt: 0,
    });
  }

  /** The payload of a binary kind `0x02` frame. */
  pushAudio(segmentId: number, bytes: ArrayBuffer): void {
    const segment = this.segments.get(segmentId);
    if (segment === undefined || segment.ended) return;
    if (segment.format === 'mp3') {
      segment.mp3.push(new Uint8Array(bytes));
      return;
    }
    const buffer = this.pcmBuffer(segment, new Uint8Array(bytes));
    if (buffer !== null) this.run(() => this.schedule(segment, buffer));
  }

  /** `tts.end`: the segment's audio is complete. */
  endSegment(segmentId: number): void {
    const segment = this.segments.get(segmentId);
    if (segment === undefined) return;
    if (segment.format === 'pcm16') {
      this.run(() => this.finish(segment));
      return;
    }
    const bytes = concat(segment.mp3);
    segment.mp3.length = 0;
    const generation = this.generation;
    this.run(async () => {
      if (bytes.byteLength > 0) {
        try {
          const decoded = await this.ctx.decodeAudioData(bytes.buffer);
          if (generation !== this.generation) return;
          this.schedule(segment, decoded);
        } catch {
          // Undecodable audio: report the segment done unheard.
        }
      }
      if (generation === this.generation) this.finish(segment);
    });
  }

  /**
   * Halts every source at once (barge-in, `tts.stop`, hang-up) and drops
   * everything queued. Each interrupted segment reports what was heard of it
   * with `done: false`.
   */
  stop(turn?: number): void {
    this.generation += 1;
    this.tail = null;
    const now = this.ctx.currentTime;
    let lastTurn = turn ?? -1;
    for (const segment of this.segments.values()) {
      lastTurn = Math.max(lastTurn, segment.turn);
      const hadAudio = segment.live.size > 0 || segment.playedMs > 0;
      for (const [source, scheduled] of segment.live) {
        segment.playedMs += clamp((now - scheduled.startAt) * 1000, 0, scheduled.ms);
        source.onended = null;
        try {
          source.stop();
        } catch {
          // Already stopped.
        }
      }
      segment.live.clear();
      if (hadAudio) {
        this.onProgress({ segmentId: segment.segmentId, playedMs: Math.round(segment.playedMs), done: false });
      }
    }
    this.segments.clear();
    for (const clip of this.clips) {
      clip.onended = null;
      try {
        clip.stop();
      } catch {
        // Already stopped.
      }
    }
    this.clips.clear();
    this.stoppedThroughTurn = Math.max(this.stoppedThroughTurn, lastTurn);
    this.cursor = 0;
  }

  async close(): Promise<void> {
    this.stop();
    await this.ctx.close();
  }

  /** Runs `op` now, or after the MP3 decode that is holding up playback. */
  private run(op: () => void | Promise<void>): void {
    if (this.tail === null) {
      const result = op();
      if (result !== undefined) this.hold(result);
      return;
    }
    const generation = this.generation;
    this.hold(this.tail.then(() => (generation === this.generation ? op() : undefined)));
  }

  private hold(promise: Promise<void>): void {
    const tail: Promise<void> = promise
      .catch(() => undefined)
      .then(() => {
        if (this.tail === tail) this.tail = null;
      });
    this.tail = tail;
  }

  private pcmBuffer(segment: Segment, bytes: Uint8Array): AudioBuffer | null {
    const carry = segment.carry === null ? 0 : 1;
    const total = carry + bytes.byteLength;
    const even = total - (total % 2);
    const joined = new Uint8Array(even);
    if (segment.carry !== null) joined[0] = segment.carry;
    joined.set(bytes.subarray(0, even - carry), carry);
    segment.carry = total % 2 === 1 ? (bytes[bytes.byteLength - 1] ?? 0) : null;
    if (even === 0) return null;

    const pcm = new Int16Array(joined.buffer);
    const samples = new Float32Array(pcm.length) as Float32Array<ArrayBuffer>;
    for (let i = 0; i < pcm.length; i++) samples[i] = (pcm[i] ?? 0) / 0x8000;
    const buffer = this.ctx.createBuffer(1, samples.length, segment.sampleRate);
    buffer.copyToChannel(samples, 0);
    return buffer;
  }

  private schedule(segment: Segment, buffer: AudioBuffer): void {
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    const startAt = Math.max(this.cursor, this.ctx.currentTime + JITTER_BUFFER_S);
    source.start(startAt);
    this.cursor = startAt + buffer.duration;
    const ms = buffer.duration * 1000;
    if (segment.turn > this.firstPlayedTurn) {
      this.firstPlayedTurn = segment.turn;
      // When it reaches the speakers: the scheduling lead plus the output latency.
      const leadS = startAt - this.ctx.currentTime + (this.ctx.outputLatency || 0);
      this.onFirstPlay(segment.turn, Date.now() + Math.max(0, leadS) * 1000);
    }
    segment.live.set(source, { startAt, ms });
    source.onended = () => {
      if (!segment.live.delete(source)) return;
      segment.playedMs += ms;
      this.report(segment);
    };
  }

  private finish(segment: Segment): void {
    segment.ended = true;
    segment.carry = null;
    this.report(segment);
  }

  private report(segment: Segment): void {
    const done = segment.ended && segment.live.size === 0;
    const now = performance.now();
    if (!done && now - segment.lastReportAt < PROGRESS_INTERVAL_MS) return;
    segment.lastReportAt = now;
    if (done) this.segments.delete(segment.segmentId);
    this.onProgress({ segmentId: segment.segmentId, playedMs: Math.round(segment.playedMs), done });
  }
}

/** Mono PCM16 LE bytes as an `AudioBuffer` of `ctx` (earcons, US-021). */
export function pcm16Buffer(ctx: BaseAudioContext, bytes: Uint8Array, sampleRate: number): AudioBuffer | null {
  const count = Math.floor(bytes.byteLength / 2);
  if (count === 0 || sampleRate <= 0) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
  const samples = new Float32Array(count) as Float32Array<ArrayBuffer>;
  for (let i = 0; i < count; i++) samples[i] = view.getInt16(i * 2, true) / 0x8000;
  const buffer = ctx.createBuffer(1, count, sampleRate);
  buffer.copyToChannel(samples, 0);
  return buffer;
}

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
