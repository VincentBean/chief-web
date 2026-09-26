# chief-web voice: implementation plan

**Goal.** Put a phone-call-style voice agent in chief-web. You open a call, talk to **chief** (a manager agent that knows every session, build and pull request), say *"let's start a new session for the CSV export"*, and chief creates it and hands you over to a **session agent**. The session agent is Claude running inside that session's container with the repository open, and you think out loud with it until the PRD is written. While you talk, the UI follows: the session page opens, the PRD indicator fills in, and tool calls show up as cards.

**Constraints this plan is built around**

| Constraint | Consequence |
|---|---|
| No new subscriptions | Only **ElevenLabs** (121k credits/month, already paid), **OpenRouter** (pay per use) and the existing **Claude subscription** through Claude Code |
| No Anthropic API key in chief-web | Session agents are `claude -p` processes in session containers, as the build loop already runs them |
| chief-web is self-hosted and private | No cloud service may need to call *into* chief-web. Every connection goes outward. |
| Agents run with `--dangerously-skip-permissions` | Session agents get no management tools. Anything irreversible needs a spoken confirmation that the **server** enforces. |

---

## 0. Contents

1. [Architecture at a glance](#1-architecture-at-a-glance)
2. [Provider choices and costs](#2-provider-choices-and-costs)
3. [Latency budget and how we hit it](#3-latency-budget)
4. [Server: new modules and files](#4-server-modules)
5. [The call state machine](#5-the-call-state-machine)
6. [WebSocket protocol](#6-websocket-protocol)
7. [Speech-to-text (your voice)](#7-speech-to-text)
8. [Text-to-speech (the agent's voice)](#8-text-to-speech)
9. [Chief: the manager agent (OpenRouter)](#9-chief-the-manager-agent)
10. [Session agents: Claude Code over stream-json](#10-session-agents)
11. [Focus, handoff and intents](#11-focus-handoff-and-intents)
12. [Background events: chief speaks up](#12-background-events)
13. [Browser: call panel and audio pipeline](#13-browser)
14. [Settings, config and secrets](#14-settings-config-and-secrets)
15. [Database migrations](#15-database-migrations)
16. [Usage and cost tracking](#16-usage-and-cost-tracking)
17. [Security](#17-security)
18. [Testing](#18-testing)
19. [Phased delivery](#19-phased-delivery)
20. [Risks and open questions](#20-risks-and-open-questions)
21. [Appendix A: prompts](#appendix-a-prompts)
22. [Appendix B: chief tool schemas](#appendix-b-chief-tool-schemas)
23. [Appendix C: PRD for chief-web to build this itself](#appendix-c-prd)

---

## 1. Architecture at a glance

```
┌───────────────────────────── browser ─────────────────────────────┐
│  CallPanel (docked in AppShell, survives navigation)               │
│   mic ─► AudioWorklet(16 kHz PCM16) ─► VAD ─► utterance WAV ──┐    │
│   (Scribe mode: PCM ─► wss://api.elevenlabs.io STT directly)  │    │
│   speaker ◄─ AudioPlayer(queue of PCM segments) ◄──┐          │    │
│   transcript · tool cards · focus chip · meter     │          │    │
└────────────────────────────────────────────────────┼──────────┼────┘
                                   binary + JSON over │          │
                                   WS /api/voice/stream (cookie auth, existing gateway)
┌────────────────────────────────────────────────────┼──────────┼────┐
│ server/src/voice                                   │          ▼    │
│   VoiceCall ── SttService ──► OpenRouter /audio/transcriptions     │
│      │ final text                                                  │
│      ├── IntentRouter ("back to chief", "switch to …", "stop")     │
│      ▼                                                             │
│   focus = chief ──► ChiefAgent ──► OpenRouter /chat/completions    │
│      │                  └─ tools ─► SessionService, BuildService,  │
│      │                             PlanningService, stats … (in-process)
│      │                                                             │
│   focus = session X ──► SessionVoiceAgent                          │
│      │                   └─ docker exec (stdin attached) in X's container:
│      │                      claude -p --input-format stream-json … │
│      ▼ text deltas                                                 │
│   Speakable (markdown strip + sentence chunker)                    │
│      ▼                                                             │
│   TtsService ──► ElevenLabs WS multi-stream-input (Flash)          │
│              └─► fallback: OpenRouter /audio/speech                │
│      ▼ PCM chunks ────────────────────────────────────────► browser│
│   EventBus ◄── build finished / failed / PR opened / PRD written   │
└────────────────────────────────────────────────────────────────────┘
```

**Why this split**

- **Chief runs in-process on OpenRouter.** It's fast (a small model with low time to first token) and its tools are plain function calls into the existing services. That means no MCP server, no bearer tokens and no containers on the compose network.
- **Session agents run on Claude Code in the session container.** They can read the repo, they use your subscription, and they write the PRD in the place the existing `prd.md` poller, parser and **Mark ready** already expect.
- **Speech lives at the edges.** Text-to-speech is always server-side, because that's where agent text appears. Speech-to-text is server-side via OpenRouter by default. It can be switched to ElevenLabs Scribe Realtime, streamed directly from the browser with a single-use token.

---

## 2. Provider choices and costs

| Part | Default | Alternative (setting) | Rough cost |
|---|---|---|---|
| Your voice → text | OpenRouter, batch per utterance (Parakeet / MAI-Transcribe / Qwen ASR class, ~$0.10–0.13 per audio hour) | `elevenlabs-realtime`: Scribe v2 Realtime (streaming, live captions, uses EL credits); `browser`: Web Speech API (dev only) | ~$0.02 per 30-min call |
| Agent → voice | ElevenLabs **Flash/Turbo** over multi-context WebSocket, `pcm_24000` | OpenRouter `/audio/speech` (automatic fallback when EL credits are exhausted) | ~450 EL credits per minute of agent speech |
| Chief brain | OpenRouter, a fast tool-calling model (e.g. a Haiku-class or Gemini-Flash-class model; configurable slug) | any OpenRouter model | a few cents per call |
| Session brain | Claude Code (`claude -p`) in the session container, Sonnet, no extended thinking | configurable model | subscription |

**Budget with 121k EL credits:** ~4.5 h of agent speech per month, or about 11 h of calls when the agent talks ~40% of the time. After that the automatic fallback switches to OpenRouter text-to-speech (§8.6) instead of breaking.

Model slugs on OpenRouter change. Store them as settings with sensible defaults, and validate them against `GET https://openrouter.ai/api/v1/models` in the Settings page (§14).

---

## 3. Latency budget

Target: **first audible word ≤ 2 s** after you stop talking with chief, **≤ 3 s** with a session agent (excluding tool work).

| Stage | Budget | How |
|---|---|---|
| End-of-speech detection | 600–900 ms (0 with push-to-talk) | Silero VAD in the browser; `redemptionFrames` tuned; PTT (hold Space) always available |
| Upload + transcription (OpenRouter) | 300–700 ms | 16 kHz mono WAV, typically 50–300 KB; HTTP keep-alive agent; language pinned |
| Chief first sentence | 400–800 ms | fast model, short system prompt with a *state snapshot* (§9.3) so most questions need no tool call; `stream: true` |
| Session agent first sentence | 1–3 s | process stays alive for the whole call; Sonnet; no thinking; "say what you'll look at before using a tool" |
| Sentence chunking | 0–200 ms | emit on first `, ; : — .!?` after ≥ 40 chars for the first chunk, then full sentences |
| TTS first audio (EL Flash WS) | 150–300 ms | socket opened at call start; `auto_mode=true`; keep-alive |
| Browser playback | ~100 ms | small jitter buffer (80 ms) |

**Tricks, in order of value**

1. **Earcons and acknowledgements.** Pre-render "mm-hm", "let me check", "one sec", "okay" once per voice into `/data/voice-cache/<voice-id>/*.pcm`. The browser gets them at call start. Play one at the end of your turn if no agent audio has started within 700 ms.
2. **Push-to-talk** removes endpointing entirely.
3. **State snapshot** in chief's prompt (no tool round trip for "what's building?").
4. **Speculative chief** (Phase 4). In Scribe mode, send a stable partial transcript (unchanged for 300 ms) to chief early. Discard the result if you keep speaking.
5. **Async long work.** Clones, builds and deep code reads never block the conversation (§12).

**Instrument everything.** Every turn stores `t_speech_end`, `t_transcript`, `t_first_token`, `t_first_chunk`, `t_first_audio_sent`, and the browser reports `t_first_audio_played` (§15). The call panel has a debug toggle showing these numbers for the last turn.

---

## 4. Server modules

New directory `server/src/voice/`, following the repo's conventions: one module per concern, `index.ts` re-exports, `*.test.ts` beside each, `node:test`, no new frameworks.

```
server/src/voice/
  index.ts                  factory: createVoice(config, db, deps) → { router, socketRoute, service }
  service.ts                VoiceService: owns calls (max 1 active per server by default), event bus wiring
  call.ts                   VoiceCall: the state machine (§5)
  socket.ts                 WebSocketRoute for /api/voice/stream (§6)
  routes.ts                 REST: status, scribe token, usage, call history, voice cache
  protocol.ts               message types shared (copied, not imported) with web/src/voice/protocol.ts
  speakable.ts              markdown → speech text; SentenceChunker
  intents.ts                regex/phrase intents for handoff & control (§11)
  events.ts                 VoiceEventBus: build/PR/PRD events → chief (§12)
  usage.ts                  per-call usage accounting (§16)
  earcons.ts                pre-rendered acknowledgement clips
  stt/
    index.ts                SttService: chooses provider per settings
    openrouter.ts           POST /api/v1/audio/transcriptions
    elevenlabs-token.ts     mint single-use Scribe tokens
    wav.ts                  WAV header validation / duration
  tts/
    index.ts                TtsService: provider + fallback
    elevenlabs.ts           multi-context WebSocket client
    openrouter.ts           POST /api/v1/audio/speech (streamed pcm)
    types.ts                TtsProvider interface
  chief/
    agent.ts                ChiefAgent: OpenRouter streaming chat loop with tools
    openrouter-client.ts    fetch-based SSE client (no SDK dependency)
    tools.ts                tool definitions + handlers over existing services
    confirm.ts              server-enforced confirmation tokens
    snapshot.ts             compact state snapshot for the system prompt
    prompt.ts               system prompt (Appendix A.1)
  session-agent/
    agent.ts                SessionVoiceAgent: lifecycle of one claude process
    process.ts              exec with stdin, stream-json framing
    events.ts               stream-json parser → typed events
    prompt.ts               voice planning prompt (Appendix A.2)
    registry.ts             one agent per session; lock vs. the PTY planning terminal
```

**Changes to existing files**

| File | Change |
|---|---|
| `server/src/docker/api.ts` | add `attachExec(container, spec)` → `{ stdin: Writable, output: AsyncIterable<ExecChunk>, execId }`, using `createExec(… tty:false, attachStdin:true)` + `startExec(id, undefined, false)` + an **incremental** demultiplexer (the existing `demultiplex(raw)` works on a whole buffer; extract a streaming `FrameDecoder` from the code `streamExec` already uses) |
| `server/src/docker/fake-daemon.ts` | support stdin-attached non-TTY execs so session-agent tests can script a fake `claude` |
| `server/src/app.ts` | build `createVoice(...)`, `api.use(voice.router)` after `requireApiAuth`, `gateway.register(voice.socketRoute)` |
| `server/src/settings/service.ts` | voice settings + masked secrets (§14) |
| `server/src/db/migrations.ts` | append migrations (§15) |
| `server/src/planning/service.ts` | expose `isTerminalRunning(sessionId)`; refuse `start()` while a voice agent holds the session (`409 session_in_voice_call`), and vice versa |
| `server/src/planning/prompts.ts` | export the init/edit prompt bodies so the voice prompt can reuse chief's PRD format text rather than duplicating it |
| `server/src/build/service.ts`, `delivery/service.ts`, `sessions/service.ts` | emit events on the new `VoiceEventBus` (a tiny `EventEmitter` passed in as an optional dependency; `null`-safe like the optional agent steps in delivery) |
| `.env.example` | voice env vars (§14.2) |
| `docs/voice.md` | user docs, and a line in the README feature list |

No new server dependencies are required: `ws` is already present (used as a client for ElevenLabs too), `fetch` is built into Node 22.

---

## 5. The call state machine

One `VoiceCall` per browser call. States:

```
            connect
  idle ───────────────► listening ◄──────────────────────────────┐
                           │ utterance (final transcript)        │
                           ▼                                     │
                        thinking ── agent text chunk ──► speaking┤
                           │                                │    │ playback done
                           │ intent handled locally         │    │ (browser ack)
                           └────────────────────────────────┘    │
  barge-in (speech start while speaking/thinking) ──► interrupt ─┘
  hangup / socket close / idle timeout ─► ended
```

Fields:

```ts
interface VoiceCallState {
  id: string;                      // uuid, row in voice_calls
  focus: { kind: 'chief' } | { kind: 'session'; sessionId: string };
  phase: 'listening' | 'thinking' | 'speaking' | 'ended';
  turn: number;                    // increments per user utterance
  activeTurn: AbortController | null; // aborts LLM stream + TTS context for this turn
  spokenSoFar: string;             // text actually confirmed played (for cut-off notes)
  pendingConfirmation: Confirmation | null;
  ttsProvider: 'elevenlabs' | 'openrouter';
  queue: VoiceEvent[];             // background events waiting for a quiet moment
}
```

Rules:

- **Exactly one active turn.** A new utterance while `thinking`/`speaking` is a barge-in. Abort `activeTurn`, which cancels the chief stream, interrupts the session agent (§10.5) and closes the TTS context. Send `tts.stop` to the browser. Then process the new utterance.
- **Cut-off note.** When a turn is interrupted, the next user message to that agent is prefixed with `[You were interrupted after saying: "<spokenSoFar tail 200 chars>"]`.
- **Idle timeout.** `VOICE_IDLE_TIMEOUT_MS` (default 10 min) with no speech in either direction ends the call with a spoken goodbye. Session agents are *not* killed on call end if `keepAgentsMs` (default 15 min) hasn't passed, so a quick reconnect resumes the same process.
- **One call at a time** (single operator). A second tab opening a call gets `4409 call_in_progress` with the option to take over (`?takeover=1`). The old socket is closed with `4410 taken_over`.

---

## 6. WebSocket protocol

Path: **`/api/voice/stream`** registered on the existing `WebSocketGateway`, so cookie auth is already enforced (`4401`). Query: `?focus=chief` or `?focus=session:<id>`, `&takeover=1`.

Text frames are JSON. Binary frames have a 5-byte header: `u8 kind` + `u32 LE segmentId`, then the payload.

### 6.1 Browser → server

| type | fields | meaning |
|---|---|---|
| `hello` | `{ sttMode, sampleRateOut: 24000, clientVersion }` | first message |
| binary kind `0x01` | WAV bytes (16 kHz mono PCM16) | one complete utterance (OpenRouter STT mode) |
| `transcript.final` | `{ text, language?, sttMs }` | committed transcript (Scribe or browser mode) |
| `speech.start` | `{}` | VAD/Scribe detected speech; used for barge-in |
| `speech.cancel` | `{}` | VAD misfire (too short), undo a tentative barge-in |
| `ptt` | `{ down: boolean }` | push-to-talk key state |
| `playback.progress` | `{ segmentId, playedMs, done }` | lets the server know what was actually heard |
| `focus` | `{ target: 'chief' \| {sessionId} }` | user clicked the focus chip |
| `text` | `{ text }` | typed message (keyboard fallback, same pipeline minus STT) |
| `hangup` | `{}` | end call |
| `metrics` | `{ turn, firstAudioPlayedAt }` | latency instrumentation |

### 6.2 Server → browser

| type | fields | meaning |
|---|---|---|
| `ready` | `{ callId, focus, sttMode, scribeToken?, earcons: {name: segmentId}[] , sampleRate }` | call is live |
| `state` | `{ phase, focus }` | drives the panel's status ring |
| `user.transcript` | `{ turn, text }` | echo of what was heard (after STT) |
| `agent.delta` | `{ turn, agent: 'chief'\|'session', text }` | streaming transcript of the reply |
| `agent.done` | `{ turn, interrupted }` | |
| `tts.segment` | `{ segmentId, turn, text, sampleRate, format: 'pcm16' \| 'mp3' }` | audio for this text follows as binary kind `0x02` with the same segmentId |
| binary kind `0x02` | PCM16 LE / mp3 bytes | audio chunk |
| `tts.end` | `{ segmentId }` | |
| `tts.stop` | `{ turn }` | barge-in: flush everything queued |
| `tool` | `{ turn, id, name, status: 'running'\|'ok'\|'error', summary, detail? }` | tool card |
| `confirm` | `{ id, prompt, expiresAt }` | show a Confirm / Cancel pill (voice "yes" also works) |
| `ui` | `{ action: 'navigate', path } \| { action: 'highlight', target } \| { action: 'toast', text }` | the UI follows the call |
| `usage` | `{ elCreditsUsed, orCostUsd, elCreditsRemaining? }` | meter |
| `error` | `{ code, message, fatal }` | |

Close codes: `4401` unauthorized (gateway), `4409` call in progress, `4410` taken over, `4422` voice not configured.

---

## 7. Speech-to-text

### 7.1 Default: OpenRouter, one request per utterance

**Browser side (§13.3):** Silero VAD (`@ricky0123/vad-web`) produces a `Float32Array` at 16 kHz for each utterance. Convert it to PCM16 and wrap it in a WAV header (`web/src/voice/wav.ts`). Send it as binary kind `0x01`.

**Server side (`stt/openrouter.ts`):**

```ts
export async function transcribe(wav: Buffer, opts: { model: string; language?: string; apiKey: string; signal: AbortSignal }) {
  const res = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
    method: 'POST',
    signal: opts.signal,
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/vincentBean/chief-web',
      'X-Title': 'chief-web voice',
    },
    body: JSON.stringify({
      model: opts.model,
      input_audio: { data: wav.toString('base64'), format: 'wav' },
      ...(opts.language ? { language: opts.language } : {}),
    }),
  });
  if (!res.ok) throw new SttError(res.status, await res.text());
  const body = (await res.json()) as { text: string; usage?: { cost?: number; seconds?: number } };
  return { text: body.text.trim(), costUsd: body.usage?.cost ?? 0, seconds: body.usage?.seconds ?? 0 };
}
```

Guards:
- Reject utterances **< 250 ms** (VAD misfire) and **> 60 s**. The browser force-splits at 55 s, because upstream providers time out around 60 s.
- Drop transcripts that are empty or are known hallucinations of silence ("Thank you.", "Bedankt voor het kijken", "you", "."). Keep a small list in `stt/hallucinations.ts`, applied only when the utterance is < 1.2 s.
- Timeout 8 s; on failure speak the earcon "sorry, I didn't catch that" and stay `listening`.

**Captions:** OpenRouter mode has no partials. Optionally (setting `voice_live_captions=browser`), run the Web Speech API in parallel **only for on-screen captions**. The OpenRouter transcript stays authoritative.

### 7.2 Option: ElevenLabs Scribe v2 Realtime (browser-direct)

**Token (server, `stt/elevenlabs-token.ts`):** mint a single-use token for `realtime_scribe` with the stored API key. Tokens expire after 15 minutes, so mint one per call and re-mint on reconnect.

> Implementation note: the docs show this via the SDK (`elevenlabs.tokens.singleUse.create("realtime_scribe")`). Use the equivalent REST call with `xi-api-key` (check the exact path in the API reference when implementing, at the time of writing `POST /v1/single-use-token/realtime_scribe`), and cover it with a test against a recorded response.

**Browser:** open

```
wss://api.elevenlabs.io/v1/speech-to-text/realtime
  ?model_id=scribe_v2_realtime
  &token=<single-use>
  &audio_format=pcm_16000
  &commit_strategy=vad
  &vad_silence_threshold_secs=0.8
  &language_code=nl            (setting)
  &secondary_languages=en      (setting)
  &keyterms=chief&keyterms=PRD&keyterms=<repo names>…   (optional, +20% cost, max 50)
```

- Send `{"message_type":"input_audio_chunk","audio_base_64":"…"}` every ~100 ms from the AudioWorklet.
- Handle `partial_transcript` by showing the caption and sending `speech.start` on the first non-empty partial while the agent is speaking (barge-in).
- Handle `committed_transcript` by sending `transcript.final`.
- On `quota_exceeded`, `auth_error` or `session_time_limit_exceeded`, fall back to OpenRouter mode for the rest of the call and toast it.

**Don't stream silence** (it's billed). Pause sending audio chunks while the agent is speaking *unless* barge-in is enabled. Close the socket after `VOICE_SCRIBE_IDLE_CLOSE_MS` (default 20 s) of no speech, and reopen on the next local VAD `onSpeechStart`, buffering the first 300 ms locally so nothing is lost.

### 7.3 Option: browser Web Speech API

Dev/demo only: Chrome/Edge, audio goes to Google, and the quality varies. Implemented as the `browser` mode because it costs nothing and needs no key.

---

## 8. Text-to-speech

### 8.1 Interface

```ts
// tts/types.ts
export interface TtsSegment { segmentId: number; text: string }
export interface TtsProvider {
  readonly name: 'elevenlabs' | 'openrouter';
  readonly format: { kind: 'pcm16'; sampleRate: number } | { kind: 'mp3' };
  /** Opens per-call resources (sockets). */
  open(call: { callId: string; voiceId: string }): Promise<void>;
  /** Streams audio for one segment; must stop promptly when `signal` aborts. */
  speak(seg: TtsSegment, signal: AbortSignal, onAudio: (chunk: Buffer) => void): Promise<{ chars: number }>;
  /** Cancels all in-flight audio for a turn (barge-in). */
  cancelTurn(turn: number): void;
  close(): Promise<void>;
}
```

### 8.2 Speakable text (`speakable.ts`)

Pipeline applied to agent deltas before TTS. The transcript shown on screen keeps the original text.

1. **Code fences**: while inside ```` ``` ````, emit nothing. On close, emit once: *"I've put the code on screen."*
2. **Inline code** `` `x` ``: keep the content. If it looks like a path (`/`, `.ts`), shorten it to the last segment without extension: `server/src/sessions/service.ts` → "the sessions service".
3. **Markdown**: strip `**`, `__`, `#`, `>`, list markers, and table rows (tables become "I've put a table on screen").
4. **URLs** → "a link on screen".
5. **Symbols**: `->` → "to", `&` → "and", `e.g.` → "for example", `PR` → "P R" only for TTS voices that mispronounce it (setting `voice_pronunciations` JSON map).
6. **Numbers**: leave them to the TTS engine (EL handles "US-012" → "U S zero twelve" acceptably. Add a map if not).

`SentenceChunker`:

```ts
export class SentenceChunker {
  private buf = '';
  private first = true;
  constructor(private readonly emit: (text: string) => void) {}
  push(delta: string): void {
    this.buf += delta;
    for (;;) {
      const min = this.first ? 40 : 60;
      const re = this.first ? /[,;:—.!?](\s|$)/g : /[.!?](\s|$)|\n\n/g;
      re.lastIndex = min;
      const m = this.buf.length > min ? re.exec(this.buf) : null;
      if (!m) break;
      const end = m.index + m[0].length;
      this.out(this.buf.slice(0, end));
      this.buf = this.buf.slice(end);
      this.first = false;
    }
    if (this.buf.length > 280) { this.out(this.buf); this.buf = ''; } // runaway sentence
  }
  flush(): void { if (this.buf.trim()) this.out(this.buf); this.buf = ''; this.first = true; }
  private out(s: string) { const t = toSpeakable(s).trim(); if (t) this.emit(t); }
}
```

Unit-test it with fixtures: code blocks spanning deltas, abbreviations ("e.g."), decimals ("1.5"), file names ("prd.md"). Don't split on `.` followed by a lowercase letter or digit.

### 8.3 ElevenLabs (default): multi-context WebSocket

One socket per call, opened at call start so the handshake isn't paid on the first reply:

```
wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/multi-stream-input
  ?model_id=<voice_tts_model, default Flash>
  &output_format=pcm_24000
  &auto_mode=true
  &inactivity_timeout=180
header: xi-api-key: <key>
```

- **One context per turn** (`context_id = "t<turn>"`). A barge-in sends `close_context` for the current turn's context, and the audio stops without reconnecting. This is why the multi-context endpoint is used instead of `stream-input`.
- Send each chunker segment as text to the turn's context; send `flush` after the last segment of the turn.
- Incoming messages carry base64 `audio` plus the context id and a final flag. Decode, wrap with the binary header (kind `0x02`, segmentId) and forward. Map contexts to segment ids in the call.
- Keep-alive every 15 s of silence during the call (socket's inactivity timeout max is 180 s).
- Different voice per agent: chief uses `voice_chief_voice_id`, session agents use `voice_session_voice_id` (defaults to chief's). Two voices means two sockets, both opened lazily.
- **Exact message field names**: take them from the "Multi-Context WebSocket" API reference at implementation time and record a real session as a test fixture (`tts/__fixtures__/el-multi-context.jsonl`).

**Character accounting**: count characters sent per context and add them to `voice_usage` (§16). Refresh the remaining balance from `GET /v1/user/subscription` (`character_count`, `character_limit`, `next_character_count_reset_unix`) at call start and every 5 min during a call.

### 8.4 OpenRouter TTS (fallback)

```ts
const res = await fetch('https://openrouter.ai/api/v1/audio/speech', {
  method: 'POST', signal,
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model, input: text, voice, response_format: 'pcm' }),
});
for await (const chunk of res.body!) onAudio(Buffer.from(chunk));
```

- One request per segment. Keep at most 2 in flight so segment N+1 is synthesizing while N plays.
- Sample rate of `pcm` output depends on the model (OpenAI-style models use 24 kHz mono s16le). Make it a setting (`voice_or_tts_sample_rate`, default 24000) and verify it by ear in the Settings "Test voice" button.
- **Dutch**: check the chosen model's language support. Kokoro (cheapest) doesn't do Dutch.

### 8.5 Browser playback contract

The server sends `tts.segment` then binary chunks then `tts.end`. The browser schedules chunks back to back (§13.4) and reports `playback.progress`. `spokenSoFar` is updated from those progress reports (proportionally mapping playedMs to characters), so the cut-off note is accurate.

### 8.6 Fallback policy

`TtsService` wraps the providers:

- ElevenLabs errors with quota/401/402, or the socket fails twice within 30 s, **switches the call to OpenRouter**. It sends `ui.toast` "Switched to backup voice", and if it was quota, stores `voice_el_exhausted_until = next_character_count_reset_unix`, so later calls start on OpenRouter directly until the reset.
- If both fail, the reply is shown as text only and an `error` is sent with `fatal:false`.

---

## 9. Chief: the manager agent

### 9.1 Loop (`chief/agent.ts`)

A hand-written OpenAI-compatible streaming loop, with no SDK:

```ts
async *run(userText: string, signal: AbortSignal): AsyncGenerator<ChiefEvent> {
  this.messages.push({ role: 'user', content: userText });
  for (let hop = 0; hop < MAX_TOOL_HOPS /* 6 */; hop++) {
    const stream = this.client.chat({
      model: settings.chiefModel,
      messages: [{ role: 'system', content: systemPrompt(snapshot(this.deps)) }, ...this.window()],
      tools: CHIEF_TOOLS,
      tool_choice: 'auto',
      stream: true,
      temperature: 0.4,
      max_tokens: 400,
      usage: { include: true },          // OpenRouter returns cost in the final chunk
    }, signal);
    const { text, toolCalls, usage } = yield* this.consume(stream);   // yields {type:'delta', text}
    this.usage.add(usage);
    this.messages.push({ role: 'assistant', content: text || null, tool_calls: toolCalls.length ? toolCalls : undefined });
    if (toolCalls.length === 0) return;
    for (const call of toolCalls) {
      yield { type: 'tool', id: call.id, name: call.function.name, status: 'running' };
      const result = await this.tools.execute(call, { signal, turn: this.turn });
      yield { type: 'tool', id: call.id, name: call.function.name, status: result.ok ? 'ok' : 'error', summary: result.summary };
      for (const ui of result.ui ?? []) yield { type: 'ui', ...ui };
      this.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result.data) });
    }
  }
}
```

- `window()` keeps the last 30 messages. When over budget, older turns are summarized into one system line by the same model, asynchronously and off the hot path.
- SSE parsing in `openrouter-client.ts`: read `data:` lines, ignore `: OPENROUTER PROCESSING` comments, accumulate `choices[0].delta.tool_calls[i].function.arguments` fragments by index, stop on `[DONE]`.
- **Text before tools.** The prompt tells chief to say a short phrase ("Let me check.") *before* calling a slow tool. Deltas are spoken as they arrive, so you hear that phrase while the tool runs.
- Retries: one retry on 429/5xx with 300 ms backoff. After that, speak "I can't reach my brain right now" (earcon plus text) and stay in the call.

### 9.2 Tools (`chief/tools.ts`)

Each tool is `{ definition (JSON schema), handler(args, ctx) → ToolResult }`. `ToolResult = { ok, data, summary, ui? }`, where `summary` is a one-liner for the tool card and `data` is compact JSON for the model (ids, names, statuses; never full logs).

| Tool | Calls | Confirmation | UI effect |
|---|---|---|---|
| `list_sessions({status?, repository?})` | `SessionService.list` | – | – |
| `get_session({session})` | `get`, `stories`, `BuildService.status`, planning status | – | – |
| `list_repositories()` | db `repositories` | – | – |
| `create_session({repository, name, base_branch?, pr_target?, code_review?})` | `SessionService.create` (returns immediately; clone continues, see §12) | **yes** | navigate to `/sessions/<id>` |
| `focus_session({session})` | switches call focus (§11) and starts the session agent | – | navigate |
| `start_build({session})` | `BuildService.start` | **yes** | navigate |
| `stop_build({session})` | `BuildService.stop` | **yes** | – |
| `mark_ready({session})` | `SessionService.markReady` (returns parse errors as data) | – | highlight PRD panel |
| `back_to_planning({session})` | `SessionService.backToPlanning` | – | – |
| `schedule_start({session, at})` | `setSchedule` (at is natural language → ISO; see below) | **yes** | – |
| `build_status({session})` | `BuildService.status` + last 20 rendered log lines (via `BuildLogStore`) summarized to ≤ 600 chars | – | navigate to session, scroll to log |
| `retry({session})` | retry router's service | **yes** | – |
| `list_pull_requests({state?})` | pull-requests service | – | navigate `/pull-requests` |
| `review_pull_request({repository, number})` | prreview service | **yes** | – |
| `overview()` | stats service + queue + limits hold | – | navigate `/` |
| `show({page})` | – | – | navigate to Overview/Sessions/PRs/… |
| `confirm({confirmation_id})` | executes a pending action (§9.4) | – | – |
| `end_call()` | ends call after goodbye | – | – |

Deliberately **not** exposed: deleting sessions or repositories, settings changes, terminals, the Claude login. Those stay manual.

**Name resolution.** `session` and `repository` args accept an id *or* a spoken name. A resolver in `tools.ts` normalizes both sides (lowercase, spaces/underscores → `-`, strip "the"/"session"), then tries exact, then prefix, then Levenshtein ≤ 2. When there are 0 or >1 matches it returns `{ok:false, data:{candidates:[…]}}` so chief asks "Did you mean billing-export or billing-exports?".

**Session names from speech.** `create_session` slugifies `name` (`"CSV export for invoices"` → `csv-export-invoices`, max 40 chars, `[a-z0-9-_]`), and the confirmation prompt reads the slug back.

**Times.** `schedule_start.at` accepts ISO or phrases ("tonight at 2", "in 3 hours"). Parse with a tiny parser in `chief/time.ts` in the operator's timezone (setting `voice_timezone`, default `Europe/Amsterdam`). Reject ambiguous input so the model asks again.

### 9.3 State snapshot

Rebuilt for every chief request (cheap, all SQLite) and placed in the system prompt:

```
NOW 2026-09-25 14:02 Europe/Amsterdam
REPOS: shop-api (base develop), chief-web (base main)
SESSIONS (active first, max 15):
- billing-export [shop-api] building story 3/7 (US-003 "CSV writer"), started 12m ago
- sentry-fix-4821 [shop-api] waiting (usage limit) until 15:10
- onboarding-copy [chief-web] pending, planning not started
- nightly-rector-20260925-0200 [shop-api] finished, PR #212 open
QUEUE: 1 queued (dark-mode)  SLOTS: 2/3 busy
NEEDS YOU: onboarding-copy (pending), PR #209 has 3 unresolved review comments
FOCUS: chief
```

With this in the prompt, "what's building?" and "anything need me?" are answered with **zero tool calls**.

### 9.4 Server-enforced confirmation (`chief/confirm.ts`)

The model must not be able to start a build just because it misheard. Tools marked **yes**:

1. On the first call, *don't execute*. Create `Confirmation { id, tool, args, prompt, createdAtTurn, expiresAt: now+60s }`, send `confirm` to the browser, and return `{ok:true, data:{needs_confirmation:true, confirmation_id, say: prompt}}`. Chief speaks the prompt: *"Create session csv-export-invoices on shop-api, targeting develop, is that right?"*
2. `confirm({confirmation_id})` executes **only if** a *new user utterance* has arrived since `createdAtTurn` (`call.turn > createdAtTurn`) and the confirmation hasn't expired. Otherwise it returns `{ok:false, reason:'await_user'}`. The model can't confirm on its own in the same turn.
3. As a shortcut, `intents.ts` recognizes a bare "yes / ja / do it / go / klopt" or "no / nee / cancel" as the whole utterance while a confirmation is pending. It resolves directly without an LLM round trip, then tells chief what happened via a tool-result message.
4. Clicking **Confirm** or **Cancel** in the panel works the same way.

### 9.5 Chief model settings

`voice_chief_model` defaults to a fast Anthropic or Gemini flash-class slug. Use `temperature 0.4` and `max_tokens 400`. The prompt caps spoken replies at 2–3 sentences (Appendix A.1). Pin `provider: { sort: 'latency' }` in the request when OpenRouter supports it for that model.

---

## 10. Session agents

### 10.1 What runs

In the session's container, as uid 1000, cwd `/workspace/repo`, through the new `DockerApi.attachExec`, wrapped with the same pid-file trick as build agents (`wrapAgentCommand`-style, directory `/tmp/.chief-voice`):

```
claude
  [--model <voice_session_model, default sonnet>]
  --dangerously-skip-permissions
  -p
  --input-format stream-json
  --output-format stream-json
  --verbose
  --include-partial-messages
  [--resume <claude_session_id>]          # when voice_session_agents has one for this session
  --append-system-prompt "<voice rules, Appendix A.2 part 1>"
```

The first stdin message is the voice planning prompt (Appendix A.2 part 2), with the session context filled in exactly as `planningPrompt()` does today (mode `create` or `edit` depending on whether `prd.md` exists).

> **Verify with the pinned CLI version** (the repo just bumped to "latest claude code"). Check that `--input-format stream-json` with `-p` keeps reading stdin for multiple turns, the exact shape of the user message line, the `stream_event` partial-message envelope, and the `control_request` interrupt. Write `session-agent/__fixtures__/*.jsonl` from a real run and test the parser against them. The shapes below are what current Claude Code emits, but treat them as assumptions until the fixtures exist.

### 10.2 Input framing (stdin, one JSON per line)

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<utterance>"}]}}
```

Utterances from the call are prefixed with lightweight context the agent can use:

```
[voice] <utterance>
```

and, after an interrupt, `[voice][interrupted after: "…"] <utterance>`.

### 10.3 Output events (`session-agent/events.ts`)

Parse line by line (reuse the partial-line handling of `AgentOutputFormatter`):

| stream-json | → SessionAgentEvent |
|---|---|
| `{"type":"system","subtype":"init","session_id":…}` | `init { claudeSessionId }`: persist to `voice_session_agents` |
| `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":…}}}` | `delta { text }`: to chunker and transcript |
| `{"type":"assistant","message":{"content":[{"type":"tool_use","name","input"}]}}` | `tool { name, input }`: tool card, e.g. "Reading server/src/auth/service.ts" |
| `{"type":"user", … tool_result}` | `toolResult { ok }` |
| `{"type":"result", …}` | `turnEnd { costUsd?, durationMs }`: agent.done |
| anything else | ignored (logged at debug) |

Don't speak text from `assistant` messages if you've already streamed it through `stream_event` deltas. Dedupe by message id. If partial messages turn out to be unavailable, fall back to speaking each complete `assistant` text block. That's slower, but it works.

### 10.4 Lifecycle and registry

- `SessionAgentRegistry` holds at most one agent per session, and `VOICE_MAX_SESSION_AGENTS` (default 3) alive at once. Least-recently-used agents are stopped (SIGTERM via the pid file, same approach as `agentSignalSpec`).
- **Preconditions** to start: session exists, `isCloned`, the container can be started (`containers.start(session)`), and no PTY planning terminal is running (`409 session_in_planning_terminal`). *(Superseded: the call no longer offers to close the terminal. `focus_session` refuses with "The planning terminal is open for <name>; close it in the browser first, then ask again.")*
- The **reverse lock**: `PlanningService.start` refuses while a voice agent is alive for the session.
- **Status**: voice planning is for `pending` sessions. For `ready`, `building` or `finished` sessions, start the agent with a *read-only Q&A* prompt variant: "you may read the code and the build log; do not edit files". The build loop owns the tree while building, so the prompt forbids writes, and the agent is started with `--disallowedTools Edit,Write,MultiEdit,NotebookEdit` in that mode.
- **Crash or exit** of the process: tell the user ("The session agent stopped, I'm restarting it") and restart once with `--resume`.
- **Handover to typing:** because the conversation lives in the shared `~/.claude`, a later phase adds `--resume <claude_session_id>` to the planning terminal's `planningCommand` so **Resume planning** continues the voice conversation in the terminal.

### 10.5 Interrupt

On barge-in:
1. Write `{"type":"control_request","request_id":"<uuid>","request":{"subtype":"interrupt"}}` to stdin (verify against the fixture/CLI).
2. Mark the turn as muted: any further deltas for this turn are dropped until `result` arrives.
3. If no `result` arrives within 5 s, SIGINT the process via the pid file, and restart with `--resume` on the next utterance.

### 10.6 PRD written

The existing planning poller (`readPrdStatus`) already detects `prd.md` changes. `VoiceEventBus` subscribes. When `prd.md` parses with ≥ 1 story and no errors after a voice turn, the server sends `ui.highlight('prd')` and queues a chief event: *"The PRD for csv-export-invoices has 6 stories and parses cleanly."* The session agent itself is told in its prompt to say so and suggest going back to chief to mark it ready and build.

### 10.7 Detached turns: planning several sessions at once

Added later by the PRD *Voice planning of several sessions at once* (`.chief/prds/voice-multi-planning-workflow/prd.md`, stories US-001 to US-015). Originally a planning agent only worked while it had a spoken turn; now leaving a session hands it one more turn to run alone.

- **Detached turn** (US-003): `SessionAgentRegistry.runDetached(sessionId, message)` sends one stream-json user message and reads the reply to its `result`, never speaking or streaming it. The text and tool summaries are stored as one `voice_turns` row (`speaker: 'agent'`, text `[detached] …`). It is interrupted after `VOICE_DETACHED_TURN_TIMEOUT_MS`. A process has one event queue, so a spoken turn for that session waits (with the "one sec" earcon) until the detached turn ends.
- **Prompts** (US-004): the planning prompt explains the `[detached]` convention. `detachPrompt` says nobody is listening and asks for the draft PRD with every operator question under `## Open Questions`. `resumePrompt` walks through those questions when the operator comes back (US-011), and `answerPrompt` carries an answer relayed by chief (US-012).
- **Planning state** (US-001, US-002): the parser returns `openQuestions`, which never make a PRD invalid. `PlanningStates` derives `briefing | drafting | waiting | done | failed` for every pending plan-mode session from the registry and the PRD on disk.
- **Triggers** (US-005, US-006): `VoiceCall.setFocus` leaving a briefed session calls `onSessionLeft` → `VoiceService.detach`, and so does the `carry_on` intent. Sessions that are `done` or already `drafting` are skipped.
- **Capacity** (US-007): eviction skips a drafting agent, and `acquire` refuses with `session_agents_busy`, naming the sessions, when every slot is drafting.
- **Chief** (US-008 to US-010, US-012): a finished turn publishes `planning.drafted` (important tier, spoken under any focus, a fixed line and no model call, and a same-batch `prd.valid` is dropped). "Back to chief" and a session becoming `done` name the other planning sessions and may offer a switch. The snapshot lists `PLANNING SESSIONS`, and `answer_planning_question` starts a detached turn with the answer.
- **Panel** (US-013): a `planning` server message carries every planning session's state, shown as badges in the focus chip's menu.
- **Tests** (US-014): scripted end-to-end runs in `call.test.ts` plan two sessions on two repositories in one call and exercise the cap.

---

## 11. Focus, handoff and intents

`intents.ts` runs on every final transcript **before** routing. It uses exact phrase lists (NL + EN), normalized and punctuation-stripped, and **matches only when the utterance is short (≤ 8 words)** so normal sentences aren't hijacked.

| Intent | Phrases (examples) | Action |
|---|---|---|
| `to_chief` | "back to chief", "chief", "terug naar chief", "hey chief" | focus → chief; chief says one line: "Back with me. csv-export-invoices has a draft PRD." |
| `to_session` | "switch to <name>", "ga naar <name>", "talk to <name>" | resolve name → focus_session |
| `stop_talking` | "stop", "wait", "hold on", "wacht" | interrupt current turn, stay listening, no reply |
| `repeat` | "say that again", "wat zei je" | replay last turn's segments from cache |
| `yes` / `no` | see §9.4 | resolve pending confirmation |
| `mute` / `unmute` | "mute", "stil" | stop TTS for the rest of the call (text only) |
| `hangup` | "hang up", "that's all", "ophangen" | goodbye + end |

Everything else goes to the focused agent. Chief can change focus through `focus_session`. The session agent can't (no tools into chief-web), so it asks the user to say "back to chief".

**Focus switch mechanics**
1. Abort the active turn.
2. Set `call.focus` and persist `voice_turns.agent`.
3. Send `state` and `ui.navigate('/sessions/<id>')`.
4. Start the session agent if it isn't running. Play the "one sec" earcon while it boots; first boot takes ~2–5 s.
5. The session agent's first message is the planning prompt. Its first spoken output is its opening question.

---

## 12. Background events

`VoiceEventBus` (in `voice/events.ts`) receives:

| Source | Event | Spoken as (chief) |
|---|---|---|
| `SessionService.create` → setup done/failed | `session.setup` | "csv-export-invoices is cloned and ready to plan." / "Setup failed: branch already exists." |
| `BuildService` | `build.story_done`, `build.finished`, `build.failed`, `build.waiting` | "billing-export finished story 4 of 7." (only if the user asked to be kept posted, see below) |
| `DeliveryService` | `pr.opened` | "Pull request 213 is open for billing-export." |
| planning poller | `prd.valid` | see §10.6 |
| limits hold | `limits.hold` | "Claude hit its usage limit; builds resume at 15:10." |

**Delivery rules**
- Only spoken when `phase === 'listening'` and there has been ≥ 2 s of silence. Otherwise it's queued and delivered at the next quiet moment.
- Events are **injected into chief's conversation** as `{role:'user', content:'[event] …'}`, and chief produces the spoken line. It's short, and it can combine several events.
- If focus is a session agent, only events about *that* session are announced, briefly and in chief's voice, then focus stays where it is.
- Verbosity setting `voice_event_verbosity`: `important` (setup, finished, failed, PR opened: default), `all`, `none`.
- Always shown as toasts in the panel, spoken or not.

---

## 13. Browser

New directory `web/src/voice/`:

```
web/src/voice/
  CallProvider.tsx     React context: socket, state, transcript, actions (start/hangup/ptt/focus/text)
  CallPanel.tsx        docked panel UI
  CallButton.tsx       sidebar button + "Talk it through" button on Session page
  protocol.ts          message types (copy of server/src/voice/protocol.ts)
  mic.ts               getUserMedia + AudioWorklet capture
  vad.ts               @ricky0123/vad-web wrapper (OpenRouter mode)
  scribe.ts            ElevenLabs realtime client (Scribe mode)
  player.ts            AudioPlayer: segment queue, flush, progress
  wav.ts               Float32 → PCM16 → WAV
  captions.ts          optional Web Speech captions
web/public/voice/pcm-worklet.js
web/public/voice/vad/…  (silero model + onnxruntime wasm, copied at build)
```

### 13.1 Where it lives

- `CallProvider` wraps the app in `main.tsx` inside the authenticated area, so the call survives page changes (the router is client-side).
- `AppShell.tsx` gets a **Call** item in the sidebar with the key chord `v` (added to `useKeyChords`). It renders `<CallPanel/>` fixed bottom-right (desktop) or as a bottom sheet (below `lg`).
- `pages/Session.tsx` gets **Talk it through** next to **Start planning** for pending sessions. It starts a call with `focus=session:<id>`, or switches focus if a call is already active.
- `ui.navigate` events call the existing `navigate()` from `router.tsx`. `ui.highlight` sets a transient `data-voice-highlight` attribute that CSS pulses (`styles/feedback.css`).

### 13.2 Panel UI

- **Header:** focus chip (`Chief` / `csv-export-invoices`) with a dropdown to switch, status ring (listening / thinking / speaking), and a timer.
- **Body:** the transcript. Each user line shows its STT latency in debug mode. Agent lines stream in. Tool cards appear inline (icon, name, one-line summary, status spinner/check/cross). A confirmation pill has **Confirm** and **Cancel** buttons.
- **Footer:**
  - hold-to-talk button (also **Space** while the panel has focus, or globally with the `voice_ptt_global` setting)
  - mute mic, mute voice (text only), text input (type instead of speak)
  - hang up
  - usage meter ("EL 38.2k / 121k this month · OR $0.14 this call")
- **Auto modes:** `hands-free` (VAD, the default) and `push-to-talk`, remembered in `localStorage` with try/catch.
- **Accessibility:** status changes are announced via `aria-live="polite"`. All controls are keyboard reachable.

### 13.3 Capture

```ts
// mic.ts
export async function openMic(): Promise<{ stream: MediaStream; ctx: AudioContext; node: AudioWorkletNode }> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext({ sampleRate: 16000 });
  await ctx.audioWorklet.addModule('/voice/pcm-worklet.js');
  const node = new AudioWorkletNode(ctx, 'pcm16');
  ctx.createMediaStreamSource(stream).connect(node);
  return { stream, ctx, node };
}
```

```js
// public/voice/pcm-worklet.js: batches ~100 ms of Int16 frames
class Pcm16 extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Int16Array(1600); this.n = 0; }
  process([input]) {
    const ch = input[0]; if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = Math.max(-1, Math.min(1, ch[i])) * 0x7fff;
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.buffer.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('pcm16', Pcm16);
```

**OpenRouter mode:** use `MicVAD` from `@ricky0123/vad-web` (Silero v5).

```ts
const vad = await MicVAD.new({
  stream,                                // reuse our getUserMedia stream (echo cancellation on)
  model: 'v5',
  positiveSpeechThreshold: 0.6,
  negativeSpeechThreshold: 0.35,
  redemptionFrames: settings.vadRedemptionFrames, // ≈ silence before end; default tuned to ~800 ms
  minSpeechFrames: 8,                     // ≈ 250 ms
  preSpeechPadFrames: 10,
  onSpeechStart: () => send({ type: 'speech.start' }),
  onVADMisfire: () => send({ type: 'speech.cancel' }),
  onSpeechEnd: (audio: Float32Array) => sendBinary(0x01, 0, encodeWav(audio, 16000)),
  baseAssetPath: '/voice/vad/', onnxWASMBasePath: '/voice/vad/',
});
```

Assets: add a Vite step that copies `@ricky0123/vad-web/dist/*.onnx`, `vad.worklet.bundle.min.js` and `onnxruntime-web/dist/*.wasm` to `web/public/voice/vad/` (for example `vite-plugin-static-copy` as a devDependency of `web`), and check the Dockerfile's web build stage includes them.

**Push-to-talk mode:** no VAD. While the key is down, collect worklet frames. On release, encode a WAV and send it.

### 13.4 Playback (`player.ts`)

```ts
export class AudioPlayer {
  private ctx = new AudioContext({ sampleRate: 24000 });
  private cursor = 0;                                   // ctx time where the next chunk starts
  private sources = new Set<AudioBufferSourceNode>();
  playPcm16(segmentId: number, bytes: ArrayBuffer) {
    const i16 = new Int16Array(bytes); const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 0x8000;
    const buf = this.ctx.createBuffer(1, f32.length, 24000); buf.copyToChannel(f32, 0);
    const src = this.ctx.createBufferSource(); src.buffer = buf; src.connect(this.ctx.destination);
    const startAt = Math.max(this.cursor, this.ctx.currentTime + 0.08);   // 80 ms jitter buffer
    src.start(startAt); this.cursor = startAt + buf.duration;
    this.sources.add(src); src.onended = () => { this.sources.delete(src); this.report(segmentId); };
  }
  stop() { for (const s of this.sources) try { s.stop(); } catch {} this.sources.clear(); this.cursor = 0; }
}
```

- MP3 segments (OpenRouter fallback with `mp3`): accumulate per segment and `decodeAudioData` on `tts.end`. Prefer `pcm`.
- `AudioContext` must be resumed from a user gesture. The **Call** button click does that.
- Earcons: received at `ready` as binary segments and cached in `AudioBuffer`s.

### 13.5 Barge-in and echo

- Barge-in triggers when `speech.start` (VAD or Scribe partial) arrives while the player is playing. The browser stops locally first (instant), then the server aborts the turn.
- **False barge-in from the agent's own voice** is the main risk on speakers. Mitigations:
  1. `echoCancellation: true`. Chrome's AEC references audio the page itself plays through the same output device.
  2. While playing, raise `positiveSpeechThreshold` to 0.8 and require ≥ 300 ms of speech.
  3. Setting `voice_barge_in`: `on` (headset), `careful` (default, the stricter thresholds above), `off` (use PTT or the stop button to interrupt).

### 13.6 Microphone permission and HTTPS

`getUserMedia` needs a secure context: `http://localhost` is fine, anything else needs HTTPS. The panel detects `!window.isSecureContext` and explains this instead of failing silently, linking to `docs/voice.md#https`.

---

## 14. Settings, config and secrets

### 14.1 Settings (SQLite `settings` table, edited in **Settings → Voice**)

| Key | Type | Default |
|---|---|---|
| `voice_enabled` | bool | false |
| `openrouter_api_key` | secret (masked like `github_token`, last 4 shown) | – |
| `elevenlabs_api_key` | secret | – |
| `voice_stt_provider` | `openrouter` \| `elevenlabs-realtime` \| `browser` | `openrouter` |
| `voice_or_stt_model` | slug | a Parakeet/MAI-Transcribe-class model |
| `voice_language` | ISO-639-1 | `nl` |
| `voice_secondary_language` | ISO-639-1 \| null | `en` |
| `voice_keyterms_enabled` | bool (Scribe only; +20%) | false |
| `voice_tts_model` | EL model id | Flash (latest) |
| `voice_chief_voice_id` | EL voice id | – (picker lists `GET /v1/voices`) |
| `voice_session_voice_id` | EL voice id \| null | null (= chief) |
| `voice_or_tts_model` / `voice_or_tts_voice` / `voice_or_tts_sample_rate` | fallback voice | an OpenAI-style mini TTS / `alloy` / 24000 |
| `voice_chief_model` | OpenRouter slug | fast tool-calling model |
| `voice_session_model` | `sonnet` \| `opus` \| `haiku` … (existing `AGENT_MODELS`) | `sonnet` |
| `voice_vad_silence_ms` | 400–2000 | 800 |
| `voice_barge_in` | `on` \| `careful` \| `off` | `careful` |
| `voice_event_verbosity` | `important` \| `all` \| `none` | `important` |
| `voice_timezone` | IANA | `Europe/Amsterdam` |
| `voice_pronunciations` | JSON map | `{}` |
| `voice_transcript_retention_days` | int | 30 |
| `voice_el_exhausted_until` | ISO \| null | internal |

**Settings page** (`web/src/pages/Settings.tsx`, new section):
- **Test** buttons:
  - OpenRouter key: calls `GET /api/v1/key` (auth check) and validates the model slugs against `/api/v1/models`.
  - ElevenLabs key: calls `GET /v1/user/subscription` and shows the remaining credits.
  - "Play test voice": synthesizes a Dutch and an English sentence.
  - "Test microphone": records 3 s, runs STT, shows the text and latency.
- Voice picker populated from `GET /v1/voices` (proxied through the server so the key stays there).

### 14.2 Environment (`server/src/config.ts`, `.env.example`)

```ini
# Voice (optional). Keys are set in Settings → Voice, not here.
VOICE_IDLE_TIMEOUT_MS=600000          # end a silent call after 10 min
VOICE_KEEP_AGENTS_MS=900000           # keep session agents alive this long after a call
VOICE_MAX_SESSION_AGENTS=3
VOICE_STT_TIMEOUT_MS=8000
VOICE_MAX_UTTERANCE_MS=60000
VOICE_CHIEF_MAX_TOOL_HOPS=6
VOICE_SCRIBE_IDLE_CLOSE_MS=20000
VOICE_BROWSER_IDLE_MS=600000         # stop a session browser unused for 10 min
```

Parse them the way `config.ts` parses the existing numeric vars, with bounds.

### 14.3 REST routes (`voice/routes.ts`, all behind `requireApiAuth`)

| Route | Purpose |
|---|---|
| `GET /api/voice/status` | configured?, providers, EL balance (cached 60 s), active call id |
| `POST /api/voice/scribe-token` | single-use Scribe token (rate limit: 10/hour) |
| `GET /api/voice/voices` | proxy EL voice list |
| `POST /api/voice/test/tts` | `{text, provider}` → audio/pcm for the Settings test |
| `POST /api/voice/test/stt` | WAV body → `{text, ms}` |
| `GET /api/voice/calls?limit=` | call history with duration, cost |
| `GET /api/voice/calls/:id` | transcript (turns + tool events) |
| `DELETE /api/voice/calls/:id` | delete a transcript |

---

## 15. Database migrations

Append to `MIGRATIONS` in `server/src/db/migrations.ts` (append-only, ids continue the existing scheme):

```sql
CREATE TABLE voice_calls (
  id            TEXT PRIMARY KEY,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  end_reason    TEXT,                      -- hangup | idle | error | taken_over
  stt_provider  TEXT NOT NULL,
  tts_provider  TEXT NOT NULL,             -- last used
  el_chars      INTEGER NOT NULL DEFAULT 0,
  stt_seconds   REAL    NOT NULL DEFAULT 0,
  or_cost_usd   REAL    NOT NULL DEFAULT 0,
  claude_turns  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE voice_turns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id         TEXT NOT NULL REFERENCES voice_calls(id) ON DELETE CASCADE,
  turn            INTEGER NOT NULL,
  speaker         TEXT NOT NULL,            -- user | chief | session | event
  session_id      TEXT,                     -- focus at the time, NULL for chief
  text            TEXT NOT NULL,
  interrupted     INTEGER NOT NULL DEFAULT 0,
  tools_json      TEXT,                     -- [{name, status, summary}]
  t_speech_end    TEXT, t_transcript TEXT, t_first_token TEXT,
  t_first_chunk   TEXT, t_first_audio_sent TEXT, t_first_audio_played TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_voice_turns_call ON voice_turns (call_id, turn);

CREATE TABLE voice_session_agents (
  session_id        TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  claude_session_id TEXT NOT NULL,
  mode              TEXT NOT NULL,          -- plan | qa
  updated_at        TEXT NOT NULL
);
```

Retention: the scheduler tick (existing `scheduler/service.ts`) deletes `voice_calls` older than `voice_transcript_retention_days`. **Audio is never stored.**

Typed accessors in `server/src/db/voice.ts` with tests, following `db/pr-runs.ts`.

---

## 16. Usage and cost tracking

- **EL characters:** counted per TTS segment sent. At call start and every 5 min, `GET /v1/user/subscription` gives the authoritative `character_count/limit`. The meter shows the authoritative number, plus a local estimate between refreshes.
- **Scribe (if used):** track seconds streamed. Credit cost per minute is plan-dependent, so show seconds and let the meter's authoritative refresh reveal the cost. After the first test call, a Settings hint shows "Scribe cost ≈ N credits/min on your plan", computed from the delta.
- **OpenRouter:** STT responses include `usage.cost`. Chat completions return cost with `usage: {include:true}`. TTS returns an `X-Generation-Id`: fetch `GET /api/v1/generation?id=…` lazily (after the call) to fill in cost.
- **Claude:** count turns. There's no cost to show (subscription), but a usage-limit hold (`limits/hold.ts`) must be respected. If the hold is active, the session agent can't start, and chief says so.
- The **Overview** page gets a small "Voice this month" stat (minutes, EL credits used, OR $).

---

## 17. Security

- **Keys stay on the server.** The only credential the browser ever gets is a Scribe single-use token (15 min, one session, rate limited).
- **Voice actions are gated.** Irreversible or costly tools require server-enforced confirmation (§9.4). Deletion isn't exposed at all.
- **Session agents** are as privileged as build agents already are (skip-permissions inside their own container), no more. They get **no** chief-web tools and no network path to the server. Q&A mode disallows edit tools.
- **Prompt injection:** repository content read by a session agent can't reach chief's tools, because the session agent has none, and intents are matched only on *user* transcripts. Chief sees session names and statuses (operator-controlled) but no repo content.
- **Transcripts** are stored locally in SQLite, with retention and per-call delete. **Audio isn't stored** anywhere by chief-web. OpenRouter/ElevenLabs retention follows their policies. Note this in `docs/voice.md` and `docs/security.md`.
- **Microphone** only while a call is active. The browser's mic indicator is the source of truth, and the panel shows a red dot too.
- **HTTPS** for any non-localhost access (already recommended by the docs; now required for the mic).
- The **WebSocket** reuses the gateway's cookie check. Add an `Origin` check for `/api/voice/stream` against `PUBLIC_URL` if it's set, since a voice socket is more sensitive than a log stream.

---

## 18. Testing

Follow the repo style: `node:test` + `tsx`, fakes over mocks, and `fake-daemon.ts` for Docker.

**Unit**
- `speakable.test.ts`: markdown stripping, code fences across deltas, chunker boundaries (abbreviations, decimals, file names, first-chunk rule, runaway sentences).
- `intents.test.ts`: NL/EN phrases, the ≤ 8-word rule, name extraction for `to_session`.
- `confirm.test.ts`: can't confirm in the same turn, expiry, yes/no shortcut.
- `chief/tools.test.ts`: name resolution (exact / prefix / fuzzy / ambiguous), slugify, time parsing, each tool against in-memory services.
- `chief/openrouter-client.test.ts`: SSE parser with fragmented tool-call arguments, comments, `[DONE]`, usage chunk.
- `session-agent/events.test.ts`: recorded stream-json fixtures (init, partial deltas, tool use, result, unknown events).
- `stt/openrouter.test.ts`, `tts/*.test.ts` against a local fake HTTP/WS server (`node:http` + `ws`), including 402/429/quota paths and fallback switching.
- `docker/api.test.ts`: `attachExec` stdin write + incremental demux over the fake daemon.

**Integration (`voice/call.test.ts`)**
- A scripted call with the fake STT (returns canned text per utterance), fake chief model (scripted SSE), fake TTS (returns N bytes per char) and a fake session agent (fake daemon exec that runs a script echoing stream-json):
  - "what's building" → spoken answer with no tool call
  - create session → confirm → yes → navigate + setup event spoken later
  - focus session → agent boots → reply streamed → "back to chief"
  - barge-in mid-reply → `tts.stop`, interrupt written to stdin, cut-off note on the next message
  - EL quota error → fallback provider used, toast sent
- Latency fields are all populated and monotonic.

**Manual checklist** (`docs/voice.md#testing`): Chrome + Firefox + Safari; headset vs speakers (false barge-in rate); Dutch and English; a 30-minute planning call end to end resulting in a parseable PRD and a green **Mark ready**.

`npm run check` (typecheck + lint) must stay clean. New code follows the existing ESLint config.

---

## 19. Phased delivery

Each phase is shippable on its own and behind `voice_enabled`.

**Phase 1: Talk to chief (text brain, voice edges)**
- Settings + secrets, migrations, REST status/test routes
- WS route, `VoiceCall` (no barge-in yet), protocol
- OpenRouter STT with VAD utterances; EL TTS with the chunker; OpenRouter TTS fallback
- Chief with snapshot + read-only tools (`list_sessions`, `get_session`, `overview`, `build_status`, `list_pull_requests`, `show`)
- CallPanel with transcript, tool cards, PTT and hands-free, UI navigation
- *Done when:* "what's building and does anything need me?" is answered by voice in ≤ 2.5 s, and the Overview page opens.

**Phase 2: Actions**
- Confirmation system; `create_session`, `start_build`, `stop_build`, `mark_ready`, `back_to_planning`, `schedule_start`, `retry`, `review_pull_request`
- Background events (§12)
- *Done when:* a session is created, planned manually in the terminal, marked ready and built, with every step triggered by voice, and completion announced.

**Phase 3: Talk it through (session agents)**
- `attachExec`, session-agent process/events/registry, voice planning prompt, planning-terminal lock
- Focus/handoff intents, "Talk it through" button, PRD-valid event
- Interrupts for session agents
- *Done when:* "let's start a new session for X", then a voice planning conversation, produces a PRD that passes **Mark ready** without touching the keyboard.

**Phase 4: Polish**
- Barge-in with the echo safeguards; earcons; repeat/mute intents
- Scribe realtime mode with live captions and speculative chief
- Usage meter + Overview stat; call history page; transcript retention
- Q&A mode for non-pending sessions; `--resume` handover to the planning terminal
- Latency debug overlay and tuning pass

---

## 20. Risks and open questions

| Risk | Mitigation |
|---|---|
| Claude Code stream-json input/interrupt shapes differ from the assumptions | Fixture-first: record real runs with the pinned CLI before writing the parser; fall back to one `-p` process per turn with `--resume` (slower but robust) |
| False barge-in on laptop speakers | `careful` default, headset recommendation, PTT |
| OpenRouter batch STT adds ~0.5 s | Scribe mode switch; PTT; earcons mask it |
| Scribe credit cost unclear on the Creator plan | Default to OpenRouter STT; measure via subscription delta after one call |
| Chief hallucinating actions | Server-enforced confirmation; tool results are the only source of truth; snapshot in the prompt |
| Model slugs disappearing on OpenRouter | Validate in Settings; the error surfaces as a spoken + toast message, not a crash |
| Dutch pronunciation of code terms | `voice_pronunciations` map; EL multilingual voice for Dutch |
| Session agent editing files while a build runs | Q&A mode with disallowed edit tools; voice planning only for `pending` |
| Long clones blocking the call | Async setup + event announcement |

**Open questions for the owner**
1. Dutch, English, or both in one call (affects `language` pinning vs auto-detect)?
2. One voice for everything, or a distinct voice for session agents?
3. Should chief ever start a build *without* confirmation for sessions you marked "auto-build"?
4. Keep transcripts 30 days, or never store them?

---

## Appendix A: prompts

### A.1 Chief system prompt (`chief/prompt.ts`)

```
You are Chief, the voice of chief-web: a self-hosted app that plans features as PRDs and builds them
in Docker containers, one session per feature, and opens pull requests. You are on a live voice call
with the operator, {{operatorName}}. Everything you write is spoken aloud.

How to speak:
- Two or three short sentences. No markdown, no lists, no code, no URLs, no emoji.
- Say names naturally ("the billing export session"), never ids or paths.
- If something is long (a list of sessions, errors), say the gist and add "details are on screen".
- Speak {{language}} unless the operator switches language; then follow them.
- Before a tool that takes a moment, first say a few words like "Let me check."

What you know:
- The STATE block below is current. Answer from it without tools when you can.
- Tool results are the only truth about what happened. Never claim an action succeeded unless a tool
  result says so.

Actions:
- Creating sessions, starting or stopping builds, scheduling, retrying and reviewing need confirmation:
  the tool returns needs_confirmation with a sentence to say. Say it, then wait. Only call confirm
  after the operator answered in a new message.
- When the operator wants to think a feature through, plan it, or talk about the code of one session,
  use focus_session. The session agent has the repository open; you do not.
- When a new session is created, offer to talk it through once setup is done.
- If a name is ambiguous, ask which one, naming at most three options.

Events: messages starting with [event] are system notifications. Mention them in one short sentence,
combine several into one, and skip ones the operator obviously already knows.

STATE
{{snapshot}}
```

### A.2 Session voice agent

**Part 1: `--append-system-prompt` (voice rules):**

```
You are on a live voice call. Everything you write is converted to speech.
- Reply in at most three short spoken sentences, then stop and let the operator talk.
- No markdown, no lists, no code blocks in replies. If code matters, say what it does in words;
  the operator sees a transcript.
- Before reading files or searching, say in one short sentence what you are about to look at.
- Before each thing you do in the browser, say in one sentence what you are about to do there.
  Describe what you see on the page in at most three sentences.
- When the operator wants to look at the running application together ("watch with me", "let's look
  at it"), call open_browser_with_operator with a short hint of what you want to see. First say one
  short sentence such as "Type the address in the panel and I'll open it". Never ask for or read out
  a URL, a username or a password; the operator types them into the card. The tool opens the page
  and logs in itself; tell the operator how that went in one sentence, naming the page rather than
  reading the URL out. If the operator did not open a browser, move on without it.
- Never say or write a username or a password: not in a reply, not in a file, not in the PRD, and
  not in a command you run. Refer to "the login" instead.
- The operator can close the browser, or it can crash. When a browser tool fails because the browser is
  closed or cannot be reached, say "The browser was closed" in one sentence and offer to open it again
  with open_browser_with_operator; do not retry the tool on your own.
- Ask one question at a time. Never use lettered or numbered options; ask naturally.
- Messages starting with [voice] are the operator's transcribed speech; transcription can be wrong,
  so if something sounds odd, check rather than guess.
- When you have written or updated the PRD, say so in one sentence, say how many stories it has,
  and suggest saying "back to chief" to mark it ready and build it.
- Speak {{language}} unless the operator switches language.
```

**Part 2: first user message** = the existing chief init/edit prompt from `planning/templates.ts`, with this replacement block appended:

```
VOICE MODE OVERRIDES
- Instead of 3–5 lettered clarifying questions at once, have a conversation: one question per turn,
  building on the previous answer, until you understand the feature well enough. Bounce ideas; point
  out risks you see in the code.
- Before writing the PRD, summarize the scope in two or three sentences and ask "shall I write it?".
- Write the PRD exactly in the story format specified above to {{prdPath}}; that format is parsed
  by a machine.
- Start now by greeting the operator in one sentence and asking what they want to build
  {{#if context}}(they said: "{{context}}"){{/if}}.
```

### A.3 Q&A mode (non-pending sessions)

Same voice rules. First message: "You are answering questions about session {{name}} ({{status}}). Read the code, `.chief/` progress files and git log as needed. Do not modify any files."

---

## Appendix B: chief tool schemas

OpenAI-compatible `tools` array (abbreviated descriptions; put the full ones in `tools.ts`):

```json
[
  {"type":"function","function":{"name":"list_sessions","description":"List sessions, active first.","parameters":{"type":"object","properties":{"status":{"type":"string","enum":["pending","ready","building","waiting","failed","finished"]},"repository":{"type":"string"}}}}},
  {"type":"function","function":{"name":"get_session","description":"Details of one session: status, stories, build progress, PRD state, PR.","parameters":{"type":"object","properties":{"session":{"type":"string","description":"Session id or spoken name"}},"required":["session"]}}},
  {"type":"function","function":{"name":"list_repositories","description":"Registered repositories.","parameters":{"type":"object","properties":{}}}},
  {"type":"function","function":{"name":"create_session","description":"Create a session (needs confirmation). Setup (clone) continues in the background.","parameters":{"type":"object","properties":{"repository":{"type":"string"},"name":{"type":"string","description":"Human name; will be slugified"},"base_branch":{"type":"string"},"pr_target":{"type":"string","enum":["develop","main"]},"code_review":{"type":"boolean"}},"required":["repository","name"]}}},
  {"type":"function","function":{"name":"focus_session","description":"Hand the call to the session's own agent, which has the repository open, to plan or discuss it.","parameters":{"type":"object","properties":{"session":{"type":"string"}},"required":["session"]}}},
  {"type":"function","function":{"name":"mark_ready","description":"Parse the session's PRD and mark it ready; returns parse errors if any.","parameters":{"type":"object","properties":{"session":{"type":"string"}},"required":["session"]}}},
  {"type":"function","function":{"name":"back_to_planning","description":"Return a ready session to pending.","parameters":{"type":"object","properties":{"session":{"type":"string"}},"required":["session"]}}},
  {"type":"function","function":{"name":"start_build","description":"Start or queue the build (needs confirmation).","parameters":{"type":"object","properties":{"session":{"type":"string"}},"required":["session"]}}},
  {"type":"function","function":{"name":"stop_build","description":"Stop a running build (needs confirmation).","parameters":{"type":"object","properties":{"session":{"type":"string"}},"required":["session"]}}},
  {"type":"function","function":{"name":"schedule_start","description":"Schedule a ready session's build (needs confirmation).","parameters":{"type":"object","properties":{"session":{"type":"string"},"at":{"type":"string","description":"ISO time or phrase like 'tonight at 2'"}},"required":["session","at"]}}},
  {"type":"function","function":{"name":"build_status","description":"Current story and a short summary of the latest build log.","parameters":{"type":"object","properties":{"session":{"type":"string"}},"required":["session"]}}},
  {"type":"function","function":{"name":"retry","description":"Retry a failed session at the stage it failed (needs confirmation).","parameters":{"type":"object","properties":{"session":{"type":"string"}},"required":["session"]}}},
  {"type":"function","function":{"name":"list_pull_requests","description":"Open pull requests chief-web knows about.","parameters":{"type":"object","properties":{"state":{"type":"string","enum":["open","all"]}}}}},
  {"type":"function","function":{"name":"review_pull_request","description":"Run a code review on a pull request (needs confirmation).","parameters":{"type":"object","properties":{"repository":{"type":"string"},"number":{"type":"integer"}},"required":["repository","number"]}}},
  {"type":"function","function":{"name":"overview","description":"Dashboard numbers: running, queued, needs attention, usage-limit hold.","parameters":{"type":"object","properties":{}}}},
  {"type":"function","function":{"name":"show","description":"Open a page in the operator's browser.","parameters":{"type":"object","properties":{"page":{"type":"string","enum":["overview","sessions","pull-requests","recurring-tasks","repositories","sentry","settings"]}},"required":["page"]}}},
  {"type":"function","function":{"name":"confirm","description":"Execute an action the operator just confirmed in a new message.","parameters":{"type":"object","properties":{"confirmation_id":{"type":"string"}},"required":["confirmation_id"]}}},
  {"type":"function","function":{"name":"end_call","description":"End the call after saying goodbye.","parameters":{"type":"object","properties":{}}}}
]
```

---

## Appendix C: PRD

The same work in chief's PRD format, so chief-web can build it itself. Save as `.chief/prds/voice-agent/prd.md` in a session on the chief-web repository, then **Mark ready**. Phases map to priorities. Story sizes are chosen to fit one agent iteration each.

```markdown
# PRD: Voice calls with chief

Add a voice call to chief-web: talk to a manager agent ("chief") that knows every session and can act on
them, and hand off to a per-session Claude Code agent to plan features by voice. Speech-to-text via
OpenRouter (default) or ElevenLabs Scribe Realtime; text-to-speech via ElevenLabs with OpenRouter fallback.
The full design is in docs/voice-plan.md.

### US-001: Voice settings and secrets
**Status:** todo
**Priority:** 1
**Description:** As the operator, I want to store OpenRouter and ElevenLabs keys and voice preferences so that the voice feature can be configured without environment variables.

**Acceptance Criteria:**
- [ ] Settings keys from docs/voice-plan.md §14.1 exist with defaults and validation in settings/service.ts
- [ ] API keys are write-only and masked (configured + last4) exactly like the GitHub token
- [ ] Settings → Voice section renders all fields; voice_enabled toggles the feature
- [ ] Test buttons: OpenRouter key check, ElevenLabs subscription check with remaining credits
- [ ] Unit tests cover validation and masking; npm run check passes

### US-002: Voice database tables
**Status:** todo
**Priority:** 2
**Description:** As a developer, I want voice_calls, voice_turns and voice_session_agents tables with typed accessors so that calls, transcripts and agent resumes are persisted.

**Acceptance Criteria:**
- [ ] Append-only migrations add the three tables and index from §15
- [ ] server/src/db/voice.ts provides typed insert/update/list functions with tests
- [ ] Transcript retention cleanup runs on the scheduler tick using voice_transcript_retention_days

### US-003: Speakable text and sentence chunker
**Status:** todo
**Priority:** 3
**Description:** As the operator, I want agent replies turned into clean spoken sentences so that markdown, code and paths are not read aloud.

**Acceptance Criteria:**
- [ ] server/src/voice/speakable.ts implements toSpeakable and SentenceChunker per §8.2
- [ ] Code fences across deltas produce one "I've put the code on screen" sentence
- [ ] Tests cover abbreviations, decimals, file names, first-chunk early emission and runaway sentences

### US-004: OpenRouter speech-to-text
**Status:** todo
**Priority:** 4
**Description:** As the operator, I want my utterances transcribed through OpenRouter so that speech-to-text costs cents and no ElevenLabs credits.

**Acceptance Criteria:**
- [ ] stt/openrouter.ts posts base64 WAV to /api/v1/audio/transcriptions with model and language settings
- [ ] Utterances under 250 ms or over 60 s are rejected; short known hallucinations are dropped
- [ ] Timeouts and 4xx/5xx produce a typed SttError; tests use a local fake HTTP server
- [ ] POST /api/voice/test/stt returns text and latency

### US-005: ElevenLabs text-to-speech with OpenRouter fallback
**Status:** todo
**Priority:** 5
**Description:** As the operator, I want replies spoken with low latency by ElevenLabs, falling back to OpenRouter when credits run out, so that calls never go silent.

**Acceptance Criteria:**
- [ ] tts/elevenlabs.ts uses the multi-context WebSocket, one context per turn, pcm_24000, keep-alive
- [ ] cancelTurn closes the turn's context without reconnecting
- [ ] tts/openrouter.ts streams pcm from /api/v1/audio/speech
- [ ] TtsService switches to OpenRouter on quota/auth errors or two socket failures in 30 s, records voice_el_exhausted_until
- [ ] Characters are counted per call; tests use fake WS/HTTP servers

### US-006: Voice WebSocket and call state machine
**Status:** todo
**Priority:** 6
**Description:** As the operator, I want a single authenticated voice socket carrying audio and events so that the browser and server can hold a call.

**Acceptance Criteria:**
- [ ] /api/voice/stream is registered on the existing WebSocketGateway with the protocol of §6
- [ ] VoiceCall implements listening/thinking/speaking/ended with one active turn and AbortController
- [ ] Second call returns 4409 unless takeover=1, which closes the old socket with 4410
- [ ] Idle timeout ends the call; turns and latency timestamps are persisted
- [ ] Integration test drives a call with fake STT, fake chief and fake TTS

### US-007: Chief agent with read-only tools
**Status:** todo
**Priority:** 7
**Description:** As the operator, I want to ask chief what is going on and have it answer by voice so that I don't have to look at the dashboard.

**Acceptance Criteria:**
- [ ] chief/openrouter-client.ts parses streaming SSE including fragmented tool-call arguments and usage
- [ ] chief/agent.ts runs the tool loop with max hops, message window and one retry
- [ ] State snapshot per §9.3 is injected into the system prompt from Appendix A.1
- [ ] Tools list_sessions, get_session, list_repositories, overview, build_status, list_pull_requests, show are implemented with name resolution
- [ ] show and other UI effects emit ui.navigate events
- [ ] Tests cover SSE parsing, name resolution and each tool

### US-008: Call panel, capture and playback in the browser
**Status:** todo
**Priority:** 8
**Description:** As the operator, I want a call panel that is always available so that I can talk to chief from any page.

**Acceptance Criteria:**
- [ ] CallProvider wraps the authenticated app; CallPanel is docked in AppShell and survives navigation
- [ ] Sidebar Call item with key chord v; secure-context check with explanation
- [ ] Silero VAD (vad-web) sends WAV utterances; push-to-talk with Space works; assets are served from /voice/vad/
- [ ] AudioPlayer plays PCM segments gaplessly, reports playback.progress and stops instantly on tts.stop
- [ ] Transcript, tool cards, status ring, mute, text input and hang up work
- [ ] ui.navigate events navigate the router

### US-009: Server-enforced confirmations and action tools
**Status:** todo
**Priority:** 9
**Description:** As the operator, I want chief to create sessions and start builds only after I confirm so that a misheard sentence cannot start work.

**Acceptance Criteria:**
- [ ] chief/confirm.ts implements confirmations that only execute after a new user turn and within 60 s
- [ ] Yes/no intents and panel buttons resolve pending confirmations without an LLM round trip
- [ ] create_session (with slugify), start_build, stop_build, mark_ready, back_to_planning, schedule_start (with time parsing), retry and review_pull_request are implemented
- [ ] Tests prove the model cannot confirm in the same turn

### US-010: Background events spoken by chief
**Status:** todo
**Priority:** 10
**Description:** As the operator, I want chief to tell me when setup finishes, builds finish or fail, and PRs open so that I stay informed during a call.

**Acceptance Criteria:**
- [ ] VoiceEventBus receives events from sessions, build, delivery, limits and the PRD poller
- [ ] Events are queued and spoken only when listening and silent for 2 s, according to voice_event_verbosity
- [ ] Every event is shown as a toast in the panel

### US-011: Streaming exec with stdin in DockerApi
**Status:** todo
**Priority:** 11
**Description:** As a developer, I want to run a long-lived non-TTY process with stdin in a container so that session agents can take messages over stdin.

**Acceptance Criteria:**
- [ ] DockerApi.attachExec returns a writable stdin and an async iterable of demultiplexed stdout/stderr chunks
- [ ] An incremental frame decoder handles frames split across chunks
- [ ] fake-daemon supports stdin-attached execs; tests cover write, read and exit

### US-012: Session voice agent over Claude Code stream-json
**Status:** todo
**Priority:** 12
**Description:** As the operator, I want to talk to a Claude agent inside a session's container so that I can think a feature through with the repository open.

**Acceptance Criteria:**
- [ ] Recorded stream-json fixtures from the pinned CLI exist and the parser is tested against them
- [ ] session-agent starts claude -p with stream-json input/output, partial messages, voice system prompt and --resume when known
- [ ] Deltas are spoken; tool uses become tool cards; claude session id is persisted
- [ ] Interrupt writes a control request and mutes the rest of the turn, with SIGINT fallback after 5 s
- [ ] Registry limits live agents, keeps them after a call for VOICE_KEEP_AGENTS_MS and restarts once on crash
- [ ] Planning terminal and voice agent lock each other out with 409 errors

### US-013: Focus, handoff and intents
**Status:** todo
**Priority:** 13
**Description:** As the operator, I want to say "back to chief" or "switch to <session>" so that I can move between chief and session agents in one call.

**Acceptance Criteria:**
- [ ] intents.ts implements the NL and EN intents of §11 with the eight-word rule
- [ ] focus_session tool and focus chip switch focus, navigate and start the agent with an earcon while booting
- [ ] Session page has a "Talk it through" button for pending sessions
- [ ] A valid PRD after a voice turn highlights the PRD panel and queues a chief event

### US-014: Barge-in, earcons and echo safeguards
**Status:** todo
**Priority:** 14
**Description:** As the operator, I want to interrupt the agent by speaking and hear quick acknowledgements so that the call feels natural.

**Acceptance Criteria:**
- [ ] Speech start during playback stops audio locally and aborts the turn server-side, with a cut-off note on the next message
- [ ] voice_barge_in on/careful/off behaves as in §13.5
- [ ] Earcons are pre-rendered per voice, cached on the data volume and played when no audio starts within 700 ms

### US-015: Scribe realtime mode
**Status:** todo
**Priority:** 15
**Description:** As the operator, I want the option of streaming speech-to-text with live captions so that I can trade ElevenLabs credits for lower latency.

**Acceptance Criteria:**
- [ ] POST /api/voice/scribe-token mints single-use tokens with rate limiting
- [ ] Browser streams PCM to Scribe with VAD commit, language and optional keyterms settings
- [ ] Partials show as captions and trigger barge-in; committed transcripts are sent to the server
- [ ] Silence is not streamed; quota or auth errors fall back to OpenRouter mode

### US-016: Usage meter and call history
**Status:** todo
**Priority:** 16
**Description:** As the operator, I want to see what calls cost and how many ElevenLabs credits remain so that I stay within my plan.

**Acceptance Criteria:**
- [ ] Per-call EL characters, STT seconds and OpenRouter cost are recorded
- [ ] Panel meter shows remaining EL credits refreshed from the subscription endpoint
- [ ] Call history list and transcript view with delete; Overview shows voice usage this month

### US-017: Voice documentation
**Status:** todo
**Priority:** 17
**Description:** As a new user, I want documentation for voice calls so that I can set it up and understand what is stored and sent where.

**Acceptance Criteria:**
- [ ] docs/voice.md covers setup, providers, costs, HTTPS requirement, privacy and troubleshooting
- [ ] README feature list and docs/security.md are updated
- [ ] .env.example documents the VOICE_* variables
```

---

### References

- ElevenLabs Realtime STT API: https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
- ElevenLabs client-side streaming (single-use tokens): https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/client-side-streaming
- ElevenLabs Multi-Context TTS WebSocket: https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-multi-stream-input
- ElevenLabs pricing: https://elevenlabs.io/pricing/api
- OpenRouter transcription API: https://openrouter.ai/docs/api/api-reference/transcriptions/create-audio-transcriptions
- OpenRouter text-to-speech: https://openrouter.ai/docs/guides/overview/multimodal/tts
- OpenRouter STT / TTS model collections: https://openrouter.ai/collections/speech-to-text-models, https://openrouter.ai/collections/text-to-speech-models
- Silero VAD for the browser: https://github.com/ricky0123/vad
