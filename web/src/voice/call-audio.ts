/**
 * The audio side of a call (voice US-009; plan §13.3–13.4): microphone,
 * hands-free VAD or push-to-talk, and playback, wired to the call socket's
 * protocol. The React side (US-010's `CallProvider`) owns the socket and
 * hands this its messages; this sends `speech.*`, `ptt`, `playback.progress`
 * and the WAV utterances back through a {@link CallAudioSink}.
 *
 * Construct it synchronously in the Call button's click handler: both audio
 * contexts are created and resumed there, which browsers only allow during a
 * user gesture. `start()` (which asks for the microphone) may be awaited after.
 */
import { createCaptureContext, openMic, type Mic } from './mic.ts';
import { AudioPlayer } from './player.ts';
import {
  decodeFrame,
  encodeFrame,
  FRAME_KIND_AUDIO,
  FRAME_KIND_UTTERANCE,
  type ClientMessage,
  type ServerMessage,
} from './protocol.ts';
import { installSpaceToTalk, PushToTalkRecorder } from './ptt.ts';
import { startVad, type Vad } from './vad.ts';

export type TalkMode = 'hands-free' | 'push-to-talk';

export interface CallAudioSink {
  json(message: ClientMessage): void;
  binary(frame: ArrayBuffer): void;
}

export interface CallAudioOptions {
  mode: TalkMode;
  /** `voice_vad_silence_ms`. */
  vadSilenceMs: number;
  /** `voice_ptt_global`: Space talks anywhere outside editable elements. */
  pttGlobal: boolean;
  /** The call panel; Space talks while focus is inside it. */
  panel: () => HTMLElement | null;
}

export class CallAudio {
  readonly player: AudioPlayer;
  private readonly captureCtx: AudioContext;
  private mic: Mic | null = null;
  private vad: Vad | null = null;
  private recorder: PushToTalkRecorder | null = null;
  private removeSpace: (() => void) | null = null;
  private mode: TalkMode = 'hands-free';
  private pttGlobal = false;
  private closed = false;

  constructor(private readonly sink: CallAudioSink) {
    this.captureCtx = createCaptureContext();
    this.player = new AudioPlayer((progress) => this.sink.json({ type: 'playback.progress', ...progress }));
  }

  async start(options: CallAudioOptions): Promise<void> {
    this.mode = options.mode;
    this.pttGlobal = options.pttGlobal;
    const mic = await openMic(this.captureCtx);
    if (this.closed) {
      mic.close();
      return;
    }
    this.mic = mic;
    this.recorder = new PushToTalkRecorder(mic.node, (wav) => this.sendUtterance(wav));
    this.removeSpace = installSpaceToTalk({
      panel: options.panel,
      global: () => this.pttGlobal,
      down: () => this.pttDown(),
      up: () => this.pttUp(),
    });
    if (this.mode === 'hands-free') await this.startVad(options.vadSilenceMs);
  }

  setPttGlobal(global: boolean): void {
    this.pttGlobal = global;
  }

  async setMode(mode: TalkMode, vadSilenceMs: number): Promise<void> {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === 'push-to-talk') {
      const vad = this.vad;
      this.vad = null;
      await vad?.destroy();
    } else if (this.mic !== null) {
      await this.startVad(vadSilenceMs);
    }
  }

  setMicMuted(muted: boolean): void {
    this.mic?.setMuted(muted);
  }

  /** Space or the hold-to-talk button went down. Works in both modes. */
  pttDown(): void {
    if (this.recorder === null || this.recorder.active) return;
    this.sink.json({ type: 'ptt', down: true });
    void this.vad?.pause();
    this.recorder.start();
  }

  pttUp(): void {
    if (this.recorder === null || !this.recorder.active) return;
    this.sink.json({ type: 'ptt', down: false });
    const recorder = this.recorder;
    void recorder.stop().then(() => {
      if (!this.closed) void this.vad?.resume();
    });
  }

  /** Feed every server JSON message; the audio ones are handled here. */
  handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'tts.segment':
        this.player.beginSegment(message);
        break;
      case 'tts.end':
        this.player.endSegment(message.segmentId);
        break;
      case 'tts.stop':
        this.player.stop(message.turn);
        break;
      default:
        break;
    }
  }

  /** Feed every binary frame from the socket. */
  handleBinary(frame: ArrayBuffer): void {
    const decoded = decodeFrame(frame);
    if (decoded?.kind === FRAME_KIND_AUDIO) this.player.pushAudio(decoded.segmentId, decoded.payload);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.removeSpace?.();
    this.recorder?.cancel();
    const vad = this.vad;
    this.vad = null;
    await vad?.destroy().catch(() => undefined);
    this.mic?.close();
    await Promise.allSettled([this.player.close(), this.captureCtx.close()]);
  }

  private async startVad(silenceMs: number): Promise<void> {
    const mic = this.mic;
    if (mic === null) return;
    const vad = await startVad({
      stream: mic.stream,
      ctx: this.captureCtx,
      silenceMs,
      sink: {
        speechStart: () => this.sink.json({ type: 'speech.start' }),
        speechCancel: () => this.sink.json({ type: 'speech.cancel' }),
        utterance: (wav) => this.sendUtterance(wav),
      },
    });
    if (this.closed || this.mode !== 'hands-free') {
      await vad.destroy();
      return;
    }
    this.vad = vad;
  }

  private sendUtterance(wav: ArrayBuffer): void {
    if (!this.closed) this.sink.binary(encodeFrame(FRAME_KIND_UTTERANCE, 0, wav));
  }
}
