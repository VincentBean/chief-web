/**
 * The audio side of a call (voice US-009; docs/voice-plan.md §13.3–13.4): microphone,
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
import { AudioPlayer, pcm16Buffer } from './player.ts';
import {
  decodeFrame,
  encodeFrame,
  FRAME_KIND_AUDIO,
  FRAME_KIND_UTTERANCE,
  type ClientMessage,
  type ServerMessage,
  type SttMode,
} from './protocol.ts';
import { installSpaceToTalk, PushToTalkRecorder } from './ptt.ts';
import { BrowserSpeech } from './captions.ts';
import { ScribeClient } from './scribe.ts';
import { type BargeInMode, startVad, type Vad } from './vad.ts';

export type TalkMode = 'hands-free' | 'push-to-talk';

export interface CallAudioSink {
  json(message: ClientMessage): void;
  binary(frame: ArrayBuffer): void;
  /** Live caption of what is being said ('' clears it), US-022. */
  caption(text: string): void;
  /** Scribe gave up; the call continues on OpenRouter speech-to-text. */
  fallback(reason: string): void;
}

/** How speech becomes text on this side (US-022). */
export interface SttOptions {
  /** `voice_live_captions`: Web Speech captions in OpenRouter mode. */
  liveCaptions: 'off' | 'browser';
  /** `voice_speculative_chief`: stable Scribe partials go to chief early. */
  speculative: boolean;
  /** `voice_language`, for the Web Speech API. */
  language: string;
}

export interface CallAudioOptions {
  mode: TalkMode;
  /** `voice_vad_silence_ms`. */
  vadSilenceMs: number;
  /** `voice_ptt_global`: Space talks anywhere outside editable elements. */
  pttGlobal: boolean;
  /** The call panel; Space talks while focus is inside it. */
  panel: () => HTMLElement | null;
  /** `voice_barge_in`: how speech over the agent's voice interrupts it (docs/voice-plan.md §13.5). */
  bargeIn: BargeInMode;
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
  private bargeIn: BargeInMode = 'careful';
  private closed = false;
  private sttMode: SttMode = 'openrouter';
  private sttOptions: SttOptions = { liveCaptions: 'off', speculative: false, language: 'nl' };
  private scribe: ScribeClient | null = null;
  private speech: BrowserSpeech | null = null;
  /** A Scribe partial already interrupted the agent for this utterance. */
  private scribeBargedIn = false;
  private pttHeld = false;
  private readonly onBatch = (event: MessageEvent<ArrayBuffer>): void => this.scribe?.push(event.data);
  /** Earcon audio still arriving after `ready`, by segment id (US-021). */
  private readonly incoming = new Map<number, { name: string; sampleRate: number; chunks: Uint8Array[] }>();
  /** Decoded earcons, by name; `earcon` plays one. */
  private readonly earcons = new Map<string, AudioBuffer>();

  constructor(private readonly sink: CallAudioSink) {
    this.captureCtx = createCaptureContext();
    this.player = new AudioPlayer(
      (progress) => this.sink.json({ type: 'playback.progress', ...progress }),
      (turn, atMs) => this.sink.json({ type: 'metrics', turn, firstAudioPlayedAt: new Date(atMs).toISOString() }),
    );
  }

  async start(options: CallAudioOptions): Promise<void> {
    this.mode = options.mode;
    this.pttGlobal = options.pttGlobal;
    this.bargeIn = options.bargeIn;
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
    this.applyStt();
  }

  /**
   * The mode the server confirmed in `ready` (US-022). Scribe streams the
   * microphone to ElevenLabs; `browser` and live captions run the Web
   * Speech API. Safe to call again (a resumed socket sends `ready` again).
   */
  setStt(mode: SttMode, options: SttOptions): void {
    this.sttMode = mode;
    this.sttOptions = options;
    this.applyStt();
  }

  private applyStt(): void {
    const mic = this.mic;
    if (mic === null || this.closed) return;
    if (this.sttMode === 'elevenlabs-realtime' && this.scribe === null) {
      this.scribe = new ScribeClient(
        {
          partial: (text) => {
            this.sink.caption(text);
            // Barge-in: the first words over the agent's voice interrupt it.
            if (this.player.playing && !this.scribeBargedIn) {
              this.scribeBargedIn = true;
              this.player.stop();
              this.sink.json({ type: 'speech.start' });
            }
          },
          committed: (text) => {
            this.scribeBargedIn = false;
            this.sink.caption('');
            this.sink.json({ type: 'transcript.final', text });
          },
          seconds: (seconds) => this.sink.json({ type: 'scribe.usage', seconds }),
          stable: (text) => this.sink.json({ type: 'transcript.partial', text }),
          unstable: () => this.sink.json({ type: 'speculation.cancel' }),
          fatal: (reason) => {
            this.sttMode = 'openrouter';
            this.sink.caption('');
            this.sink.json({ type: 'stt.fallback', reason });
            this.applyStt();
            this.sink.fallback(reason);
          },
        },
        {
          // Silence is billed: nothing goes out while the agent talks, unless it can be talked over.
          paused: () => this.player.playing && this.bargeIn === 'off',
          speculative: this.sttOptions.speculative,
        },
      );
      mic.node.port.addEventListener('message', this.onBatch);
      mic.node.port.start();
    } else if (this.sttMode !== 'elevenlabs-realtime' && this.scribe !== null) {
      mic.node.port.removeEventListener('message', this.onBatch);
      const scribe = this.scribe;
      this.scribe = null;
      scribe.close();
    }

    const speech = this.sttMode === 'browser' || (this.sttMode === 'openrouter' && this.sttOptions.liveCaptions === 'browser');
    if (speech && this.speech === null) {
      const transcribes = this.sttMode === 'browser';
      this.speech = new BrowserSpeech(this.sttOptions.language, {
        interim: (text) => this.sink.caption(text),
        final: (text) => {
          if (!transcribes) {
            this.sink.caption(text);
            return;
          }
          this.sink.caption('');
          this.sink.json({ type: 'transcript.final', text });
        },
        failed: (reason) => {
          this.speech = null;
          if (transcribes) {
            this.sttMode = 'openrouter';
            this.sink.json({ type: 'stt.fallback', reason: 'browser_speech_failed' });
            this.sink.fallback(reason);
          }
        },
      });
      this.speech.start();
    } else if (!speech && this.speech !== null) {
      this.speech.stop();
      this.speech = null;
    }
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

  /**
   * The stop button: the agent goes quiet here at once, and the server hears
   * the `stop` intent, which interrupts the turn without a reply.
   */
  stopAgent(): void {
    this.player.stop();
    this.sink.json({ type: 'text', text: 'stop' });
  }

  /**
   * Space or the hold-to-talk button went down. Works in both modes, and
   * always interrupts the agent, whatever `voice_barge_in` says.
   */
  pttDown(): void {
    if (this.recorder === null || this.pttHeld) return;
    this.pttHeld = true;
    this.player.stop();
    this.sink.json({ type: 'ptt', down: true });
    // Scribe and the browser transcribe what they hear; only OpenRouter takes a WAV.
    if (this.sttMode !== 'openrouter') {
      this.scribe?.speechStarted();
      return;
    }
    void this.vad?.pause();
    this.recorder.start();
  }

  pttUp(): void {
    if (this.recorder === null || !this.pttHeld) return;
    this.pttHeld = false;
    this.sink.json({ type: 'ptt', down: false });
    if (!this.recorder.active) return;
    const recorder = this.recorder;
    void recorder.stop().then(() => {
      if (!this.closed) void this.vad?.resume();
    });
  }

  /** Feed every server JSON message; the audio ones are handled here. */
  handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'ready':
        // Earcons come once per socket; a resumed one sends them again.
        this.incoming.clear();
        for (const earcon of message.earcons) {
          this.incoming.set(earcon.segmentId, { name: earcon.name, sampleRate: earcon.sampleRate, chunks: [] });
        }
        break;
      case 'earcon': {
        const buffer = this.earcons.get(message.name);
        if (buffer !== undefined) this.player.playClip(buffer);
        break;
      }
      case 'tts.segment':
        this.player.beginSegment(message);
        break;
      case 'tts.end':
        if (!this.finishEarcon(message.segmentId)) this.player.endSegment(message.segmentId);
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
    if (decoded?.kind !== FRAME_KIND_AUDIO) return;
    const earcon = this.incoming.get(decoded.segmentId);
    if (earcon !== undefined) earcon.chunks.push(new Uint8Array(decoded.payload));
    else this.player.pushAudio(decoded.segmentId, decoded.payload);
  }

  /** An earcon's audio is complete: it becomes an `AudioBuffer` kept for the call. */
  private finishEarcon(segmentId: number): boolean {
    const earcon = this.incoming.get(segmentId);
    if (earcon === undefined) return false;
    this.incoming.delete(segmentId);
    const bytes = new Uint8Array(earcon.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of earcon.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const buffer = pcm16Buffer(this.player.ctx, bytes, earcon.sampleRate);
    if (buffer !== null) this.earcons.set(earcon.name, buffer);
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.removeSpace?.();
    this.recorder?.cancel();
    this.scribe?.close();
    this.scribe = null;
    this.speech?.stop();
    this.speech = null;
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
      bargeIn: () => this.bargeIn,
      playing: () => this.player.playing,
      sink: {
        speechStart: () => {
          // Scribe: local speech (re)opens the socket; its partials do the barge-in.
          if (this.sttMode === 'elevenlabs-realtime') {
            this.scribe?.speechStarted();
            return;
          }
          // Barge-in: silent here first (instant), and `stop()` reports what
          // was heard before the server hears about the speech (docs/voice-plan.md §13.5).
          this.player.stop();
          this.sink.json({ type: 'speech.start' });
        },
        speechCancel: () => {
          if (this.sttMode !== 'elevenlabs-realtime') this.sink.json({ type: 'speech.cancel' });
        },
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
    // In Scribe and browser mode the words travel as `transcript.final`.
    if (!this.closed && this.sttMode === 'openrouter') this.sink.binary(encodeFrame(FRAME_KIND_UTTERANCE, 0, wav));
  }
}
