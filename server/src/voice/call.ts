import { randomUUID } from 'node:crypto';

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
import type { PrdStatus } from '../prd/index.js';
import { getVoiceSettings } from '../settings/index.js';
import { type Confirmation, ConfirmationGate } from './chief/confirm.js';
import { describeEvent, eventSessionId, isAnnounced, type VoiceBusEvent, type VoiceEvent } from './events.js';
import { matchCallIntent, matchConfirmIntent } from './intents.js';
import {
  type AgentKind,
  type CallFocus,
  type CallPhase,
  type ClientMessage,
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

/** One utterance for the focused agent. */
export interface AgentInput {
  readonly text: string;
  readonly turn: number;
  readonly signal: AbortSignal;
  /**
   * Set when the utterance (a bare "yes"/"no") or the pill's button already
   * answered the pending confirmation (US-011): the agent runs or cancels it
   * without asking its model, then speaks about the outcome.
   */
  readonly resolution?: { readonly confirmationId: string; readonly accept: boolean };
  /**
   * Set by the `to_session` intent (US-019): chief runs this tool first, as
   * if it had called it, then speaks about the result. Only chief reads it.
   */
  readonly invoke?: { readonly tool: string; readonly args: Readonly<Record<string, unknown>> };
}

/**
 * The focused agent: chief (US-008) or a session agent (US-018). It must stop
 * promptly when `signal` aborts; throwing `signal.reason` is fine.
 */
export interface VoiceAgent {
  readonly kind: AgentKind;
  run(input: AgentInput): AsyncIterable<AgentEvent>;
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
  /** The agent that answers while `focus` is in effect, on `call`. */
  readonly agent: (focus: CallFocus, call: VoiceCall) => VoiceAgent;
  readonly clock: CallClock;
  /** Told once, when the call has ended, so the service can let go of it. */
  readonly onEnded?: (call: VoiceCall) => void;
  /**
   * The planning poller (US-019): read after every session-agent turn, so a
   * `prd.md` that just became valid publishes `prd.valid`, and for the
   * PRD state chief names on the way back.
   */
  readonly planning?: CallPlanning;
}

/** The slice of `PlanningService` a call reads. */
export interface CallPlanning {
  status(sessionId: string): { readonly sessionName: string; readonly prd: PrdStatus };
}

export type { Confirmation } from './chief/confirm.js';
export type { VoiceEvent } from './events.js';

/** How long both sides must have been quiet before chief speaks a background event (plan §12). */
export const EVENT_QUIET_MS = 2_000;

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
/** What the `hangup` intent says before hanging up. */
export const HANGUP_GOODBYE: Readonly<Record<string, string>> = {
  nl: 'Oké, tot later!',
  en: 'Okay, talk to you later!',
};

/**
 * The one line chief says when the operator comes back from a session agent
 * (plan §11): "Back with me. csv-export-invoices has a draft PRD."
 */
export function backWithMe(language: string, session: { readonly sessionName: string; readonly prd: PrdStatus } | null): string {
  const nl = language === 'nl';
  const back = nl ? 'Je bent weer bij mij.' : 'Back with me.';
  if (session === null) return back;
  const { sessionName: name, prd } = session;
  const stories = prd.storyCount;
  let state: string;
  if (!prd.exists) state = nl ? `${name} heeft nog geen PRD.` : `${name} has no PRD yet.`;
  else if (!prd.parses || stories === 0) state = nl ? `${name} heeft een concept-PRD.` : `${name} has a draft PRD.`;
  else if (nl) state = `De PRD van ${name} heeft ${String(stories)} ${stories === 1 ? 'story' : 'stories'} en is in orde.`;
  else state = `${name} has a PRD with ${String(stories)} ${stories === 1 ? 'story' : 'stories'} that parses cleanly.`;
  return `${back} ${state}`;
}

/** The goodbye is not allowed to keep a dead call open. */
const GOODBYE_MAX_MS = 15_000;

/**
 * One call (voice US-007; plan §5): the state machine between the socket, STT,
 * the focused agent and TTS. Exactly one turn is active at a time; a new
 * utterance while one runs interrupts it first (barge-in).
 */
export class VoiceCall {
  readonly state: VoiceCallState;
  /** The one pending server-enforced confirmation (US-011), kept in `state`. */
  readonly confirmations: ConfirmationGate;
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
  /** Set by chief's `end_call`: hang up once the turn's goodbye is out. */
  private hangUpAfter = false;
  /** A session focus whose agent still has to be started and heard (plan §11 step 4–5). */
  private greetPending: string | null = null;
  private readonly agents = new Map<string, VoiceAgent>();
  private readonly totals = { elChars: 0, sttSeconds: 0, orCostUsd: 0 };
  /** The last sign of speech in either direction, for the event gate. */
  private lastActivityAt = 0;
  /** Set between the operator starting to speak and the utterance (or a misfire). */
  private speechOpenSince: number | null = null;
  private drainTimer: unknown = null;

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
    this.confirmations = new ConfirmationGate({
      holder: this.state,
      now: () => this.deps.clock.now(),
      send: (message) => this.send(message),
      newId: () => randomUUID(),
    });
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

  /** Where the call is focused right now. */
  get focus(): CallFocus {
    return this.state.focus;
  }

  /**
   * Moves the call's focus (plan §11): a pending confirmation does not
   * survive it; the switch is kept in `voice_turns`, the panel hears `state`
   * and a session focus opens the session's page. The session's agent is
   * started and speaks its opening once the turn in progress is over.
   *
   * Called from inside a turn (`focus_session`, a session agent giving the
   * call back); {@link switchFocus} is the one that interrupts first.
   */
  setFocus(focus: CallFocus): void {
    const current = this.state.focus;
    this.confirmations.cancel();
    this.greetPending = null;
    if (sameFocus(current, focus)) {
      this.sendState();
      return;
    }
    this.state.focus = focus;
    const sessionId = focus.kind === 'session' ? focus.sessionId : null;
    if (this.persisted) {
      const name = sessionId === null ? 'chief' : (this.readPlanning(sessionId)?.sessionName ?? sessionId);
      insertVoiceTurn(this.deps.db, { callId: this.id, turn: this.state.turn, speaker: 'event', sessionId, text: `[focus] ${name}` });
    }
    this.sendState();
    if (sessionId === null) return;
    this.send({ type: 'ui', action: 'navigate', path: `/sessions/${encodeURIComponent(sessionId)}` });
    this.greetPending = sessionId;
    if (this.state.activeTurn === null) void this.enqueue((controller) => this.greet(controller));
  }

  /**
   * The panel's focus chip: interrupts the turn in progress, then switches
   * (and starts the session agent) as {@link setFocus} does.
   */
  switchFocus(focus: CallFocus): void {
    this.touch();
    // The aborted turn winds down on the agent that started it; the new
    // focus is in effect at once, and its agent speaks once that turn is out.
    this.state.activeTurn?.abort(new Error('focus switched'));
    this.setFocus(focus);
  }

  /**
   * Hangs up once the turn in progress has been spoken, so a goodbye in the
   * same reply is heard (chief's `end_call`). Without a turn it ends now.
   */
  hangUpAfterTurn(): void {
    if (this.state.activeTurn === null) this.endSoon('hangup');
    else this.hangUpAfter = true;
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
    this.lastActivityAt = this.deps.clock.now();
    this.sendReady(false);
    this.armIdle();
  }

  /** The `hello` of a socket continuing this call after a drop (`?resume=`). */
  resume(): void {
    this.sendReady(true);
    this.armIdle();
    this.markActivity();
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
        // Barge-in on speech start is US-020; for now it is only a sign of
        // life, and background events wait until the utterance is in.
        this.speechOpenSince = this.deps.clock.now();
        this.touch();
        return;
      case 'speech.cancel':
        this.speechOpenSince = null;
        this.touch();
        return;
      case 'ptt':
        this.speechOpenSince = message.down ? this.deps.clock.now() : null;
        this.touch();
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
        this.switchFocus(message.target === 'chief' ? { kind: 'chief' } : { kind: 'session', sessionId: message.target.sessionId });
        return;
      case 'confirm.resolve':
        this.submitResolution(message.id, message.accept);
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
    this.clearDrain();
    // A hang-up or takeover takes the pending confirmation with it.
    this.confirmations.cancel();
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
    this.speechOpenSince = null;
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

  /**
   * The pill's Confirm / Cancel: a turn like a spoken "yes"/"no", but bound
   * to the id the operator clicked, so a pill that was replaced meanwhile
   * cannot answer the new one.
   */
  private submitResolution(id: string, accept: boolean): void {
    this.touch();
    void this.enqueue(async (controller) => {
      if (this.state.focus.kind !== 'chief' || this.confirmations.pending?.id !== id) {
        this.send({ type: 'error', code: 'confirmation_gone', message: 'That confirmation is no longer pending.', fatal: false });
        return;
      }
      await this.runTurn(accept ? 'Confirm' : 'Cancel', controller, {}, { confirmationId: id, accept });
    });
  }

  /** The `text` path (typed) and `transcript.final` (browser STT): no server STT. */
  private submitText(text: string, tTranscript: string | null): void {
    this.speechOpenSince = null;
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
    // A goodbye the operator talked over does not hang up.
    const hangUp = this.hangUpAfter && !controller.signal.aborted;
    this.hangUpAfter = false;
    if (this.state.activeTurn === controller) {
      this.state.activeTurn = null;
      if (hangUp && !this.ended) {
        this.endSoon('hangup');
      } else if (!this.ended) {
        this.setPhase('listening');
        this.armIdle();
        // A switch made during the turn: the session agent speaks next,
        // unless the operator already said something it will answer.
        if (this.greetPending !== null && ticket === this.ticket) void this.enqueue((next) => this.greet(next));
      }
    }
  }

  /** Starts the focused session's agent with no words of the operator's, so it opens the conversation. */
  private async greet(controller: AbortController): Promise<void> {
    const sessionId = this.greetPending;
    this.greetPending = null;
    const focus = this.state.focus;
    if (sessionId === null || focus.kind !== 'session' || focus.sessionId !== sessionId) return;
    // Only a session agent opens a conversation; chief answering a session focus (no registry) waits.
    if (this.agentFor(focus).kind !== 'session') return;
    await this.runTurn('', controller, {}, undefined, 'greeting');
  }

  private async runTurn(
    text: string,
    controller: AbortController,
    times: { readonly tSpeechEnd?: string; readonly tTranscript?: string | null },
    clicked?: AgentInput['resolution'],
    /** `event`: background events for chief; `greeting`: a session agent's opening, with no utterance. */
    mode: 'user' | 'event' | 'greeting' = 'user',
  ): Promise<void> {
    const { signal } = controller;
    const tts = this.tts;
    if (tts === null) return;
    const turn = ++this.state.turn;
    const background = mode === 'event';
    // Background events are always chief's to speak; the focus stays put.
    let focus: CallFocus = background ? { kind: 'chief' } : this.state.focus;
    this.state.spokenSoFar = '';

    if (mode !== 'greeting') {
      if (!background) this.send({ type: 'user.transcript', turn, text });
      insertVoiceTurn(this.deps.db, {
        callId: this.id,
        turn,
        speaker: background ? 'event' : 'user',
        sessionId: focus.kind === 'session' ? focus.sessionId : null,
        text,
        ...(times.tSpeechEnd === undefined ? {} : { tSpeechEnd: times.tSpeechEnd }),
        ...(times.tTranscript === undefined ? {} : { tTranscript: times.tTranscript }),
      });
    }

    // The operator spoke first: the session agent answers that, not a greeting.
    if (mode === 'user') this.greetPending = null;
    const resolution = mode === 'user' ? (clicked ?? this.spokenResolution(text, focus)) : undefined;
    let invoke: AgentInput['invoke'];
    const intent = mode === 'user' && resolution === undefined ? matchCallIntent(text) : null;
    switch (intent?.kind) {
      case 'stop_talking':
        // The turn it interrupted is already aborted; nothing is said.
        this.send({ type: 'agent.done', turn, interrupted: false });
        return;
      case 'hangup':
        await this.sayLine(tts, turn, this.inLanguage(HANGUP_GOODBYE), signal);
        this.hangUpAfter = true;
        return;
      case 'to_chief':
        if (focus.kind === 'chief') break;
        this.setFocus({ kind: 'chief' });
        await this.sayLine(tts, turn, backWithMe(getVoiceSettings(this.deps.db).language, this.readPlanning(focus.sessionId)), signal);
        return;
      case 'to_session':
        // Chief resolves the name with `focus_session` and asks when it is ambiguous.
        focus = { kind: 'chief' };
        invoke = { tool: 'focus_session', args: { session: intent.name } };
        break;
      case undefined:
        break;
    }
    const sessionId = focus.kind === 'session' ? focus.sessionId : null;
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
      for await (const event of agent.run({
        text,
        turn,
        signal,
        ...(resolution === undefined ? {} : { resolution }),
        ...(invoke === undefined ? {} : { invoke }),
      })) {
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
    if (sessionId !== null && agent.kind === 'session') this.pollPrd(sessionId);
  }

  /** A fixed line the call says itself, as chief: an intent's answer, not a model's. */
  private async sayLine(tts: CallTts, turn: number, text: string, signal: AbortSignal): Promise<void> {
    this.send({ type: 'agent.delta', turn, agent: 'chief', text });
    const spoken = toSpeakable(text, getVoiceSettings(this.deps.db).pronunciations);
    await this.speak(tts, turn, spoken, true, signal, {}).catch(() => undefined);
    const interrupted = signal.aborted;
    if (interrupted) {
      tts.cancelTurn(turn);
      this.send({ type: 'tts.stop', turn });
    }
    this.send({ type: 'agent.done', turn, interrupted });
    const row = insertVoiceTurn(this.deps.db, { callId: this.id, turn, speaker: 'chief', text, interrupted });
    this.replyRows.set(turn, row.id);
  }

  private inLanguage(lines: Readonly<Record<string, string>>): string {
    return lines[getVoiceSettings(this.deps.db).language] ?? (lines['en'] as string);
  }

  /** The session's name and PRD as the planning poller sees them; null without one, or on a failure. */
  private readPlanning(sessionId: string): { sessionName: string; prd: PrdStatus } | null {
    try {
      return this.deps.planning?.status(sessionId) ?? null;
    } catch (cause) {
      logger.warn('voice call could not read the planning status', { session: sessionId, error: String(cause) });
      return null;
    }
  }

  /**
   * Polls the planning poller after a session agent's turn (plan §10.6): a
   * `prd.md` that has just become valid comes back through `postEvent`.
   */
  private pollPrd(sessionId: string): void {
    this.readPlanning(sessionId);
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

  /**
   * A bare "yes"/"no" while chief has a confirmation pending answers it
   * directly (plan §9.4), with no model deciding what it meant.
   */
  private spokenResolution(text: string, focus: CallFocus): AgentInput['resolution'] {
    if (focus.kind !== 'chief') return undefined;
    const pending = this.confirmations.pending;
    if (pending === null) return undefined;
    const intent = matchConfirmIntent(text);
    return intent === null ? undefined : { confirmationId: pending.id, accept: intent === 'yes' };
  }

  private agentFor(focus: CallFocus): VoiceAgent {
    const key = focus.kind === 'chief' ? 'chief' : `session:${focus.sessionId}`;
    let agent = this.agents.get(key);
    if (agent === undefined) {
      agent = this.deps.agent(focus, this);
      this.agents.set(key, agent);
    }
    return agent;
  }

  /* -------------------------------------------------------------- events */

  /**
   * A background event (voice US-015; plan §12). It is toasted at once,
   * whatever happens next. Chief speaks it only if `voice_event_verbosity`
   * allows the kind and, while a session agent has the focus, only if it is
   * about that session; then it waits in `state.queue` for a quiet moment.
   */
  postEvent(event: VoiceBusEvent): void {
    if (this.ended || !this.persisted) return;
    const settings = getVoiceSettings(this.deps.db);
    const text = describeEvent(event, settings.timezone);
    this.send({ type: 'ui', action: 'toast', text });
    // A PRD the voice conversation just made valid (plan §10.6): the page
    // points at it, and chief says so even below `all` verbosity.
    const planned = event.kind === 'prd.valid' && this.agents.has(`session:${event.sessionId}`);
    if (planned) this.send({ type: 'ui', action: 'highlight', target: 'prd' });
    if (!isAnnounced(event.kind, settings.eventVerbosity) && !(planned && settings.eventVerbosity !== 'none')) return;
    const queued: VoiceEvent = { kind: event.kind, text, sessionId: eventSessionId(event) };
    if (!this.concerns(queued)) return;
    this.state.queue.push(queued);
    this.scheduleDrain();
  }

  /** Chief speaks about anything; a focused session agent's call only hears its own session. */
  private concerns(event: VoiceEvent): boolean {
    const focus = this.state.focus;
    return focus.kind === 'chief' || event.sessionId === focus.sessionId;
  }

  private markActivity(): void {
    this.lastActivityAt = this.deps.clock.now();
    if (this.state.queue.length > 0) this.scheduleDrain();
  }

  /** (Re)arms the one timer that delivers the queue once both sides have been quiet {@link EVENT_QUIET_MS}. */
  private scheduleDrain(): void {
    this.clearDrain();
    if (this.ended || this.state.queue.length === 0) return;
    const wait = Math.max(0, EVENT_QUIET_MS - (this.deps.clock.now() - this.lastActivityAt));
    this.drainTimer = this.deps.clock.setTimeout(() => {
      this.drainTimer = null;
      this.drain();
    }, wait);
  }

  private clearDrain(): void {
    if (this.drainTimer !== null) this.deps.clock.clearTimeout(this.drainTimer);
    this.drainTimer = null;
  }

  /**
   * Hands every queued event to chief as one `[event]` turn, if the call is
   * listening and quiet. Otherwise it waits: the end of the turn, the next
   * sign of speech or a resumed socket arms the timer again.
   */
  private drain(): void {
    if (this.ended || this.state.queue.length === 0) return;
    if (this.state.phase !== 'listening' || this.state.activeTurn !== null || this.transport === null) return;
    const now = this.deps.clock.now();
    if (this.speechOpenSince !== null) {
      // A speech start with no utterance for longer than one can last was a
      // lost message, not someone still talking.
      if (now - this.speechOpenSince < this.deps.config.voiceMaxUtteranceMs) return;
      this.speechOpenSince = null;
    }
    if (now - this.lastActivityAt < EVENT_QUIET_MS) {
      this.scheduleDrain();
      return;
    }
    // The focus may have moved since the events were queued.
    const events = this.state.queue.splice(0).filter((event) => this.concerns(event));
    if (events.length === 0) return;
    const text = events.map((event) => `[event] ${event.text}`).join('\n');
    void this.enqueue((controller) => this.runTurn(text, controller, {}, undefined, 'event'));
  }

  /* ---------------------------------------------------------------- idle */

  /** Speech in either direction: the idle clock starts over. */
  private touch(): void {
    if (this.idleTimer !== null) this.armIdle();
    this.markActivity();
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
    if (phase === 'listening') this.markActivity();
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

function sameFocus(a: CallFocus, b: CallFocus): boolean {
  return a.kind === 'chief' ? b.kind === 'chief' : b.kind === 'session' && b.sessionId === a.sessionId;
}
