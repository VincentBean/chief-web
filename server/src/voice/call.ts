import type { Config } from '../config.js';
import {
  createVoiceCall,
  type Database,
  insertVoiceTurn,
  updateVoiceCall,
  updateVoiceTurn,
  type VoiceEndReason,
} from '../db/index.js';
import { logger } from '../lib/logger.js';
import { getVoiceSettings } from '../settings/index.js';
import {
  type AgentKind,
  type CallFocus,
  type CallPhase,
  type ClientMessage,
  type ConfirmationView,
  decodeFrame,
  FRAME_KIND_UTTERANCE,
  parseClientMessage,
  type ServerMessage,
  type SttMode,
  type ToolStatus,
  type UiAction,
  WS_CLOSE_CALL_ENDED,
} from './protocol.js';
import { SentenceChunker, toSpeakable } from './speakable.js';
import type { SttResult } from './stt/index.js';
import type { SpeakCallbacks, SpeakResult, TtsSink } from './tts/index.js';
import type { TtsFormat, TtsProviderName, TtsSegment } from './tts/types.js';

/** Timers the call runs on; tests pass a fake one to drive the idle timeout. */
export interface CallClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: CallClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** What an agent yields while it answers one utterance. */
export type AgentEvent =
  | { readonly type: 'delta'; readonly text: string }
  | {
      readonly type: 'tool';
      readonly id: string;
      readonly name: string;
      readonly status: ToolStatus;
      readonly summary: string;
      readonly detail?: string;
    }
  | { readonly type: 'ui'; readonly ui: UiAction }
  | { readonly type: 'usage'; readonly costUsd: number };

/**
 * The focused agent: chief (US-008) or a session agent (US-018). It must stop
 * promptly when `signal` aborts; throwing `signal.reason` is fine.
 */
export interface VoiceAgent {
  readonly kind: AgentKind;
  run(input: { readonly text: string; readonly turn: number; readonly signal: AbortSignal }): AsyncIterable<AgentEvent>;
}

/** The slice of `SttService` a call uses. */
export interface CallStt {
  transcribe(wav: Buffer, signal?: AbortSignal): Promise<SttResult>;
}

/** The slice of `TtsService` a call uses. */
export interface CallTts {
  readonly providerName: TtsProviderName;
  readonly format: TtsFormat;
  open(callId: string): Promise<void>;
  speak(seg: TtsSegment, signal: AbortSignal, callbacks: SpeakCallbacks): Promise<SpeakResult>;
  cancelTurn(turn: number): void;
  close(): Promise<void>;
}

/** The socket as the call sees it; the service adapts a `ws` socket to this. */
export interface CallTransport {
  send(message: ServerMessage): void;
  sendAudio(segmentId: number, chunk: Buffer): void;
  close(code: number, reason: string): void;
}

export interface VoiceCallDeps {
  readonly db: Database;
  readonly config: Config;
  readonly stt: CallStt;
  /** One text-to-speech service per call, reporting to the call's sink. */
  readonly tts: (sink: TtsSink) => CallTts;
  /** The agent that answers while `focus` is in effect. */
  readonly agent: (focus: CallFocus) => VoiceAgent;
  readonly clock: CallClock;
  /** Told once, when the call has ended, so the service can let go of it. */
  readonly onEnded?: (call: VoiceCall) => void;
}

/** A pending server-enforced confirmation (US-011). */
export interface Confirmation extends ConfirmationView {
  readonly tool: string;
  readonly args: unknown;
  readonly createdAtTurn: number;
}

/** A background event waiting for a quiet moment (US-015). */
export interface VoiceEvent {
  readonly kind: string;
  readonly text: string;
}

/** Plan §5. */
export interface VoiceCallState {
  readonly id: string;
  focus: CallFocus;
  phase: CallPhase;
  /** Increments per user utterance (and for the idle goodbye). */
  turn: number;
  /** Aborts the LLM stream and the TTS context of the turn in progress. */
  activeTurn: AbortController | null;
  /** The current turn's text the browser reported as played. */
  spokenSoFar: string;
  pendingConfirmation: Confirmation | null;
  ttsProvider: TtsProviderName;
  queue: VoiceEvent[];
}

/** What the idle timeout says before hanging up, in the call's language. */
export const IDLE_GOODBYE: Readonly<Record<string, string>> = {
  nl: 'Ik hoor al een tijdje niets meer, dus ik hang op. Tot later!',
  en: "I haven't heard from you in a while, so I'm hanging up. Talk to you later!",
};
/** The goodbye is not allowed to keep a dead call open. */
const GOODBYE_MAX_MS = 15_000;

/**
 * One call (voice US-007; plan §5): the state machine between the socket, STT,
 * the focused agent and TTS. Exactly one turn is active at a time; a new
 * utterance while one runs interrupts it first (barge-in).
 */
export class VoiceCall {
  readonly state: VoiceCallState;
  private transport: CallTransport | null = null;
  private tts: CallTts | null = null;
  private sttMode: SttMode = 'openrouter';
  /** True once the `voice_calls` row exists (at `ready`). */
  private persisted = false;
  private segmentSeq = 0;
  private readonly segmentTexts = new Map<number, { turn: number; text: string }>();
  /** The agent reply row of each turn, for `metrics`. */
  private readonly replyRows = new Map<number, number>();
  private running: Promise<void> = Promise.resolve();
  /** Bumped by every utterance; a stale one that was superseded while waiting gives up. */
  private ticket = 0;
  private idleTimer: unknown = null;
  private readonly agents = new Map<string, VoiceAgent>();
  private readonly totals = { elChars: 0, sttSeconds: 0, orCostUsd: 0 };

  constructor(
    id: string,
    focus: CallFocus,
    private readonly deps: VoiceCallDeps,
  ) {
    this.state = {
      id,
      focus,
      phase: 'listening',
      turn: 0,
      activeTurn: null,
      spokenSoFar: '',
      pendingConfirmation: null,
      ttsProvider: 'openrouter',
      queue: [],
    };
  }

  get id(): string {
    return this.state.id;
  }

  get ended(): boolean {
    return this.state.phase === 'ended';
  }

  /** Whether a socket is carrying the call right now. */
  get attached(): boolean {
    return this.transport !== null;
  }

  get mode(): SttMode {
    return this.sttMode;
  }

  /** True once `start` has created the `voice_calls` row. */
  get started(): boolean {
    return this.persisted;
  }

  /** The socket that carries the call from now on. */
  attach(transport: CallTransport): void {
    this.transport = transport;
  }

  /** The first `hello`: opens TTS, creates the `voice_calls` row and goes live. */
  start(sttMode: SttMode): Promise<void> {
    const opening = this.open(sttMode);
    // Utterances that arrive while TTS opens wait for the row to exist.
    this.running = opening.catch(() => undefined);
    return opening;
  }

  private async open(sttMode: SttMode): Promise<void> {
    this.sttMode = sttMode;
    this.tts = this.deps.tts(this.sink());
    await this.tts.open(this.id);
    if (this.ended) return;
    this.state.ttsProvider = this.tts.providerName;
    createVoiceCall(this.deps.db, {
      id: this.id,
      sttProvider: sttMode,
      ttsProvider: this.tts.providerName,
      startedAt: this.isoNow(),
    });
    this.persisted = true;
    this.sendReady(false);
    this.armIdle();
  }

  /** The `hello` of a socket continuing this call after a drop (`?resume=`). */
  resume(): void {
    this.sendReady(true);
    this.armIdle();
  }

  /**
   * The socket went away without a hang-up: stop talking, keep the call.
   * False when `transport` was no longer the call's socket.
   */
  detach(transport: CallTransport): boolean {
    if (this.transport !== transport) return false;
    this.transport = null;
    this.clearIdle();
    this.state.activeTurn?.abort(new Error('socket closed'));
    return true;
  }

  /** Replaces the socket without ending the call: the old one is told why. */
  replaceTransport(code: number, reason: string): void {
    const old = this.transport;
    this.transport = null;
    old?.close(code, reason);
  }

  /** A frame from the browser. */
  handleFrame(data: Buffer, isBinary: boolean): void {
    if (this.ended) return;
    if (isBinary) {
      const frame = decodeFrame(data);
      if (frame === null || frame.kind !== FRAME_KIND_UTTERANCE) {
        this.send({ type: 'error', code: 'bad_frame', message: 'Unsupported binary frame.', fatal: false });
        return;
      }
      if (this.sttMode !== 'openrouter') {
        this.send({ type: 'error', code: 'unexpected_audio', message: `Audio is transcribed in the browser in ${this.sttMode} mode.`, fatal: false });
        return;
      }
      this.submitAudio(frame.payload);
      return;
    }
    const message = parseClientMessage(data.toString('utf8'));
    if (message === null) {
      this.send({ type: 'error', code: 'bad_message', message: 'Unsupported message.', fatal: false });
      return;
    }
    this.handleMessage(message);
  }

  handleMessage(message: ClientMessage): void {
    switch (message.type) {
      case 'hello':
        // Only the first one matters; the service consumed it.
        return;
      case 'text':
        this.submitText(message.text, null);
        return;
      case 'transcript.final':
        this.submitText(message.text, this.isoNow());
        return;
      case 'speech.start':
      case 'speech.cancel':
        // Barge-in on speech start is US-020; for now it is only a sign of life.
        this.touch();
        return;
      case 'ptt':
        if (message.down) this.touch();
        return;
      case 'playback.progress': {
        this.touch();
        const segment = this.segmentTexts.get(message.segmentId);
        if (message.done && segment !== undefined && segment.turn === this.state.turn) {
          this.state.spokenSoFar = `${this.state.spokenSoFar} ${segment.text}`.trim();
          this.segmentTexts.delete(message.segmentId);
        }
        return;
      }
      case 'focus':
        // The full handoff (agent start, navigation) is US-019.
        this.state.focus = message.target === 'chief' ? { kind: 'chief' } : { kind: 'session', sessionId: message.target.sessionId };
        this.sendState();
        return;
      case 'metrics': {
        const row = this.replyRows.get(message.turn);
        if (row !== undefined) updateVoiceTurn(this.deps.db, row, { tFirstAudioPlayed: message.firstAudioPlayedAt });
        return;
      }
      case 'hangup':
        this.endSoon('hangup');
        return;
    }
  }

  /** {@link end} from a callback: a failure is logged, never an unhandled rejection. */
  endSoon(reason: VoiceEndReason, closeCode = WS_CLOSE_CALL_ENDED, closeReason = 'call_ended'): void {
    this.end(reason, closeCode, closeReason).catch((cause: unknown) => {
      logger.error('voice call did not end cleanly', { call: this.id, error: String(cause) });
    });
  }

  /**
   * Ends the call once; later calls are no-ops. Closes the socket with
   * `closeCode` and the `voice_calls` row with `reason`.
   */
  async end(reason: VoiceEndReason, closeCode = WS_CLOSE_CALL_ENDED, closeReason = 'call_ended'): Promise<void> {
    if (this.ended) return;
    this.clearIdle();
    this.state.activeTurn?.abort(new Error('call ended'));
    this.state.phase = 'ended';
    this.sendState();
    const transport = this.transport;
    this.transport = null;
    transport?.close(closeCode, closeReason);
    if (this.persisted) {
      updateVoiceCall(this.deps.db, this.id, { endedAt: this.isoNow(), endReason: reason });
    }
    this.deps.onEnded?.(this);
    await this.running.catch(() => undefined);
    await this.tts?.close();
  }

  /* --------------------------------------------------------------- turns */

  private submitAudio(wav: Buffer): void {
    const speechEnd = this.isoNow();
    this.touch();
    void this.enqueue(async (controller) => {
      const tts = this.tts;
      if (tts === null) return;
      let result: SttResult;
      try {
        result = await this.deps.stt.transcribe(wav, controller.signal);
      } catch (cause) {
        if (controller.signal.aborted) return;
        logger.warn('voice transcription failed', { error: String(cause) });
        this.send({ type: 'error', code: 'stt_failed', message: 'I could not transcribe that.', fatal: false });
        return;
      }
      if (result.kind === 'rejected') {
        this.send({ type: 'error', code: `audio_${result.reason}`, message: result.message, fatal: false });
        return;
      }
      this.addUsage({ sttSeconds: result.seconds, orCostUsd: result.costUsd });
      if (result.kind === 'dropped') return;
      await this.runTurn(result.text, controller, { tSpeechEnd: speechEnd, tTranscript: this.isoNow() });
    });
  }

  /** The `text` path (typed) and `transcript.final` (browser STT): no server STT. */
  private submitText(text: string, tTranscript: string | null): void {
    this.touch();
    void this.enqueue((controller) => this.runTurn(text, controller, { tTranscript }));
  }

  /**
   * Runs `work` as the one active turn, after interrupting (and waiting out)
   * whatever turn was running. An utterance overtaken by a newer one while it
   * waited is dropped.
   */
  private async enqueue(work: (controller: AbortController) => Promise<void>): Promise<void> {
    const ticket = ++this.ticket;
    this.state.activeTurn?.abort(new Error('interrupted'));
    await this.running.catch(() => undefined);
    if (ticket !== this.ticket || this.ended || this.transport === null || !this.persisted) return;

    const controller = new AbortController();
    this.state.activeTurn = controller;
    this.setPhase('thinking');
    const done = work(controller).catch((cause: unknown) => {
      logger.error('voice turn failed', { call: this.id, error: String(cause) });
    });
    this.running = done;
    await done;
    if (this.state.activeTurn === controller) {
      this.state.activeTurn = null;
      if (!this.ended) {
        this.setPhase('listening');
        this.armIdle();
      }
    }
  }

  private async runTurn(
    text: string,
    controller: AbortController,
    times: { readonly tSpeechEnd?: string; readonly tTranscript?: string | null },
  ): Promise<void> {
    const { signal } = controller;
    const tts = this.tts;
    if (tts === null) return;
    const turn = ++this.state.turn;
    const focus = this.state.focus;
    const sessionId = focus.kind === 'session' ? focus.sessionId : null;
    this.state.spokenSoFar = '';

    this.send({ type: 'user.transcript', turn, text });
    insertVoiceTurn(this.deps.db, {
      callId: this.id,
      turn,
      speaker: 'user',
      sessionId,
      text,
      ...(times.tSpeechEnd === undefined ? {} : { tSpeechEnd: times.tSpeechEnd }),
      ...(times.tTranscript === undefined ? {} : { tTranscript: times.tTranscript }),
    });

    const agent = this.agentFor(focus);
    const marks: { tFirstToken?: string; tFirstChunk?: string; tFirstAudioSent?: string } = {};
    const speaks: Promise<void>[] = [];
    let flushed: string[] | null = null;
    const chunker = new SentenceChunker((segment) => {
      marks.tFirstChunk ??= this.isoNow();
      if (flushed !== null) flushed.push(segment);
      else speaks.push(this.speak(tts, turn, segment, false, signal, marks));
    }, getVoiceSettings(this.deps.db).pronunciations);

    let reply = '';
    const tools: { name: string; status: ToolStatus; summary: string }[] = [];
    try {
      for await (const event of agent.run({ text, turn, signal })) {
        if (signal.aborted) break;
        switch (event.type) {
          case 'delta':
            marks.tFirstToken ??= this.isoNow();
            reply += event.text;
            this.send({ type: 'agent.delta', turn, agent: agent.kind, text: event.text });
            chunker.push(event.text);
            break;
          case 'tool':
            this.send({
              type: 'tool',
              turn,
              id: event.id,
              name: event.name,
              status: event.status,
              summary: event.summary,
              ...(event.detail === undefined ? {} : { detail: event.detail }),
            });
            if (event.status !== 'running') tools.push({ name: event.name, status: event.status, summary: event.summary });
            break;
          case 'ui':
            this.send({ type: 'ui', ...event.ui });
            break;
          case 'usage':
            this.addUsage({ orCostUsd: event.costUsd });
            break;
        }
      }
      if (!signal.aborted) {
        flushed = [];
        chunker.flush();
        const tail = flushed as string[];
        flushed = null;
        if (tail.length === 0) tail.push('');
        tail.forEach((segment, i) => {
          speaks.push(this.speak(tts, turn, segment, i === tail.length - 1, signal, marks));
        });
      }
    } catch (cause) {
      if (!signal.aborted) {
        logger.warn('voice agent failed', { call: this.id, error: String(cause) });
        this.send({ type: 'error', code: 'agent_failed', message: 'The agent could not answer.', fatal: false });
      }
    }
    await Promise.allSettled(speaks);

    const interrupted = signal.aborted;
    if (interrupted) {
      tts.cancelTurn(turn);
      this.send({ type: 'tts.stop', turn });
    }
    this.send({ type: 'agent.done', turn, interrupted });
    if (reply !== '' || tools.length > 0) {
      const row = insertVoiceTurn(this.deps.db, {
        callId: this.id,
        turn,
        speaker: agent.kind,
        sessionId,
        text: reply,
        interrupted,
        toolsJson: tools.length > 0 ? JSON.stringify(tools) : null,
        ...marks,
      });
      this.replyRows.set(turn, row.id);
    }
  }

  /** Speaks one segment: `tts.segment`, binary audio, then `tts.end`. */
  private async speak(
    tts: CallTts,
    turn: number,
    text: string,
    last: boolean,
    signal: AbortSignal,
    marks: { tFirstAudioSent?: string },
  ): Promise<void> {
    const segmentId = ++this.segmentSeq;
    this.segmentTexts.set(segmentId, { turn, text });
    let started = false;
    try {
      await tts.speak({ segmentId, turn, text, last }, signal, {
        onStart: (format) => {
          started = true;
          this.setPhase('speaking');
          this.send({
            type: 'tts.segment',
            segmentId,
            turn,
            text,
            sampleRate: format.kind === 'pcm16' ? format.sampleRate : 0,
            format: format.kind,
          });
        },
        onAudio: (chunk) => {
          if (signal.aborted) return;
          marks.tFirstAudioSent ??= this.isoNow();
          this.transport?.sendAudio(segmentId, chunk);
          this.touch();
        },
      });
    } finally {
      if (started && !signal.aborted) this.send({ type: 'tts.end', segmentId });
    }
  }

  private agentFor(focus: CallFocus): VoiceAgent {
    const key = focus.kind === 'chief' ? 'chief' : `session:${focus.sessionId}`;
    let agent = this.agents.get(key);
    if (agent === undefined) {
      agent = this.deps.agent(focus);
      this.agents.set(key, agent);
    }
    return agent;
  }

  /* ---------------------------------------------------------------- idle */

  /** Speech in either direction: the idle clock starts over. */
  private touch(): void {
    if (this.idleTimer !== null) this.armIdle();
  }

  private armIdle(): void {
    this.clearIdle();
    if (this.ended || this.transport === null) return;
    this.idleTimer = this.deps.clock.setTimeout(() => {
      this.idleTimer = null;
      this.onIdle().catch((cause: unknown) => {
        logger.error('voice idle goodbye failed', { call: this.id, error: String(cause) });
        this.endSoon('idle');
      });
    }, this.deps.config.voiceIdleTimeoutMs);
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) this.deps.clock.clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private async onIdle(): Promise<void> {
    if (this.ended) return;
    if (this.state.activeTurn !== null) {
      // A turn is still going; the timer restarts when it is done.
      return;
    }
    const tts = this.tts;
    if (tts !== null) {
      const controller = new AbortController();
      this.state.activeTurn = controller;
      const turn = ++this.state.turn;
      const settings = getVoiceSettings(this.deps.db);
      const text = IDLE_GOODBYE[settings.language] ?? (IDLE_GOODBYE['en'] as string);
      this.setPhase('speaking');
      this.send({ type: 'agent.delta', turn, agent: 'chief', text });
      let timer: unknown = null;
      await Promise.race([
        this.speak(tts, turn, toSpeakable(text, settings.pronunciations), true, controller.signal, {}).catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = this.deps.clock.setTimeout(resolve, GOODBYE_MAX_MS);
        }),
      ]);
      this.deps.clock.clearTimeout(timer);
      this.send({ type: 'agent.done', turn, interrupted: false });
      insertVoiceTurn(this.deps.db, { callId: this.id, turn, speaker: 'chief', text });
      if (this.state.activeTurn === controller) this.state.activeTurn = null;
    }
    await this.end('idle');
  }

  /* ------------------------------------------------------------- helpers */

  private sink(): TtsSink {
    return {
      toast: (text) => this.send({ type: 'ui', action: 'toast', text }),
      error: (error) => this.send({ type: 'error', ...error }),
      chars: ({ provider, chars }) => {
        if (provider === 'elevenlabs') this.addUsage({ elChars: chars });
      },
      providerChanged: (provider) => {
        this.state.ttsProvider = provider;
        if (this.persisted) updateVoiceCall(this.deps.db, this.id, { ttsProvider: provider });
      },
    };
  }

  private addUsage(add: { elChars?: number; sttSeconds?: number; orCostUsd?: number }): void {
    this.totals.elChars += add.elChars ?? 0;
    this.totals.sttSeconds += add.sttSeconds ?? 0;
    this.totals.orCostUsd += add.orCostUsd ?? 0;
    if (this.persisted) updateVoiceCall(this.deps.db, this.id, { ...this.totals });
    this.send({ type: 'usage', elCreditsUsed: this.totals.elChars, orCostUsd: this.totals.orCostUsd });
  }

  private sendReady(resumed: boolean): void {
    this.send({
      type: 'ready',
      callId: this.id,
      focus: this.state.focus,
      sttMode: this.sttMode,
      earcons: [],
      sampleRate: this.tts?.format.kind === 'pcm16' ? this.tts.format.sampleRate : 0,
      resumed,
    });
    this.sendState();
  }

  private setPhase(phase: CallPhase): void {
    if (this.ended || this.state.phase === phase) return;
    this.state.phase = phase;
    this.sendState();
  }

  private sendState(): void {
    this.send({ type: 'state', phase: this.state.phase, focus: this.state.focus });
  }

  private send(message: ServerMessage): void {
    this.transport?.send(message);
  }

  private isoNow(): string {
    return new Date(this.deps.clock.now()).toISOString();
  }
}
