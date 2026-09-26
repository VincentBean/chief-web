[← chief-web](../README.md) · [All docs](../README.md#documentation)

# Voice calls

Talk to **chief** from any page. Chief is a manager agent that knows every
session, build, pull request and recurring task, and can act on them: create a
session, start or stop a build, review a pull request, pause a recurring task.
When you want to think a feature through, chief hands the call to a **session
agent**: Claude Code running in that session's container with the repository
open. It plans the feature with you and writes the `prd.md` that **Mark ready**
expects. While you talk, the UI follows: pages open, the PRD indicator fills in,
and tool calls show up as cards in the call panel.

Voice is optional and off by default. Without it, nothing in this document runs
and no provider is contacted.

- [Setup](#setup)
- [Making a call](#making-a-call)
- [Providers and costs](#providers-and-costs)
- [HTTPS](#https)
- [What chief can do](#what-chief-can-do)
- [Session agents](#session-agents)
- [Intents](#intents)
- [Background events](#background-events)
- [Privacy](#privacy)
- [Latency](#latency)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)

The design behind all of this, with its reasoning, is in
[voice-plan.md](voice-plan.md).

## Setup

Everything is in **Settings → Voice**. Nothing needs to go in `.env`; the
`VOICE_*` variables there are operational limits with working defaults (see
[Environment](#environment)).

1. **OpenRouter API key** (required). Create one at
   [openrouter.ai/keys](https://openrouter.ai/keys) and add some credit. It pays
   for speech-to-text, chief's brain and the backup voice. **Check OpenRouter
   key** tests the key and checks the four model names below against
   OpenRouter's catalog: that each exists and is the right kind of model, and
   that the backup voice is one the backup model has.
2. **ElevenLabs API key** (optional, recommended). Create one in the ElevenLabs
   dashboard under **API keys**. It gives the agents their voice. **Check
   ElevenLabs key** shows your remaining credits. Without this key the backup
   voice speaks every line.
3. **Voice.** The picker lists the voices in your ElevenLabs library. The list
   is fetched by the server, so the key never reaches the browser. Add a voice
   to your library on the ElevenLabs site first if it is not there. One voice
   is used for chief and every session agent.
4. **Language** (default `nl`), **Second language** (default `en`, blank for
   none) and **Time zone** (default `Europe/Amsterdam`; this is what "tonight"
   and "tomorrow at 9" mean).
5. **Enable voice calls with chief**, then **Save**. A save checks any model
   name you changed against OpenRouter's catalog first. It is only refused when
   the catalog says a name is unusable, not when OpenRouter cannot be reached.

Then **Test microphone** (records 3 s and shows what was heard and how long it
took) and **Play test voice** (one Dutch and one English sentence) to hear it
end to end.

### Model slugs

OpenRouter model names change. The defaults were the cheapest models that did
the job on 2026-09-25. Any slug from [openrouter.ai/models](https://openrouter.ai/models)
works as long as it is the right kind of model:

| Setting | Default | Must be |
| --- | --- | --- |
| **OpenRouter speech-to-text model** (`voice_or_stt_model`) | `openai/whisper-large-v3-turbo` | a transcription model |
| **Chief model** (`voice_chief_model`) | `inclusionai/ling-3.0-flash` | a chat model with tool calling |
| **Backup voice model** (`voice_or_tts_model`) | `google/gemini-3.8-flash-lite-tts` | a text-to-speech model that speaks your language |
| **Backup voice** (`voice_or_tts_voice`) | `Kore` | one of that model's voices |
| **Backup voice sample rate** (`voice_or_tts_sample_rate`) | `24000` | the rate the backup model returns; a voice that sounds too fast or too slow has the wrong one |

The chief default was picked on price and tool support alone. If its Dutch or
its judgement disappoints, a faster or larger tool-calling model is a one-line
change. The other voice settings:

| Setting | Default | What it does |
| --- | --- | --- |
| **ElevenLabs model** (`voice_tts_model`) | Flash v2.5 | Flash is fastest and cheapest; Turbo v2.5 and Multilingual v2 sound richer and are slower |
| **Speech to text** (`voice_stt_provider`) | OpenRouter | see [Providers and costs](#providers-and-costs) |
| **Live captions** (`voice_live_captions`) | Off | rough captions from the browser while you speak, OpenRouter mode only |
| **Send key terms to Scribe** (`voice_keyterms_enabled`) | off | Scribe only: bias recognition towards chief, PRD and repository names, for about 20% more credits |
| **Speculative chief** (`voice_speculative_chief`) | off | Scribe only: see [Latency](#latency) |
| **Session agent model** (`voice_session_model`) | Sonnet | the Claude Code model of session agents |
| **End of speech after** (`voice_vad_silence_ms`) | 800 ms | how long a pause ends what you are saying (400–2000) |
| **Interrupting the agent** (`voice_barge_in`) | Careful | On: any speech interrupts. Careful: only clear speech does. Off: use push-to-talk or the stop button |
| **Events chief mentions during a call** (`voice_event_verbosity`) | Important | see [Background events](#background-events) |
| **Keep transcripts for** (`voice_transcript_retention_days`) | 30 days | see [Privacy](#privacy) (1–365) |
| **Push-to-talk works on every page** (`voice_ptt_global`) | off | off: Space only talks while the call panel has focus |
| **Pronunciations** (`voice_pronunciations`) | a starter map | JSON of term → how to say it, applied to everything the agents speak |

### Environment

These are read once at startup and bounded; a value outside the bounds stops the
server with a message. They are listed in `.env.example` as well.

| Variable | Default | Meaning |
| --- | --- | --- |
| `VOICE_IDLE_TIMEOUT_MS` | `600000` | end a silent call after 10 minutes |
| `VOICE_KEEP_AGENTS_MS` | `900000` | keep session agents alive this long after a call |
| `VOICE_MAX_SESSION_AGENTS` | `3` | session agents running at once; the least recently used idle one is stopped; one still drafting never is, and when all of them are drafting a new one is refused |
| `VOICE_DETACHED_TURN_TIMEOUT_MS` | `600000` | a session agent's detached turn (one it runs while the call is elsewhere) is interrupted after this long (60000..3600000) |
| `VOICE_STT_TIMEOUT_MS` | `8000` | cap on one speech-to-text request |
| `VOICE_MAX_UTTERANCE_MS` | `60000` | longest utterance sent to speech-to-text |
| `VOICE_CHIEF_MAX_TOOL_HOPS` | `6` | tool round trips chief may make for one thing you say |
| `VOICE_SCRIBE_IDLE_CLOSE_MS` | `20000` | close an idle Scribe socket after this long |
| `OPENROUTER_API_URL` | `https://openrouter.ai/api/v1` | only for a proxy or a test stub |
| `ELEVENLABS_API_URL` | `https://api.elevenlabs.io` | only for a proxy or a test stub |

## Making a call

Click **Call** in the sidebar, or press `g v`. The call panel opens and stays
open while you move between pages. Hiding it does not end the call;
the red dot says the microphone is open.

- **Hands-free** (default): just talk. A pause of **End of speech after** ends
  your turn.
- **Push to talk**: hold the talk button, or hold Space while the panel has
  focus (on every page with **Push-to-talk works on every page**). There is no
  end-of-speech wait, so it is the fastest way to talk.
- **Typing** in the message box works in either mode.
- **Mute microphone**, **Mute voice** (text only for the rest of the call) and
  **Stop the agent** are in the panel's footer. Talking over the agent stops it
  too, depending on **Interrupting the agent**.
- The **focus chip** in the header says who you are talking to: chief, or a
  session. Pick a session there to hand the call to it.
- The footer shows the ElevenLabs credits left this billing month and what
  OpenRouter cost this call.

One call runs at a time. Opening one in a second tab asks whether to take it
over. A dropped connection reconnects on its own for 30 seconds. Past calls and
their transcripts are under **Call → History** (`/calls`), where each one can
be deleted.

## Providers and costs

Three providers, and no new subscription beyond what chief-web already uses:

| Part | Default | Alternatives | Rough cost |
| --- | --- | --- | --- |
| Your voice → text | OpenRouter, one request per utterance (**Speech to text**) | **ElevenLabs Scribe realtime**: words stream while you talk, live captions, uses ElevenLabs credits. **Browser speech recognition**: development only | Whisper Large V3 Turbo is about $0.012 per hour of your speech |
| Agent → voice | ElevenLabs over one WebSocket per call | OpenRouter text-to-speech, the **backup voice**, switched to automatically | ElevenLabs bills per character: roughly 900 characters, so 450–900 credits, per minute of agent speech depending on the model and plan |
| Chief's brain | OpenRouter, **Chief model** | any tool-calling OpenRouter model | a few cents per call |
| Session agents | Claude Code in the session container | **Session agent model** | your Claude subscription; counts towards its usage limit |

**The backup voice.** A call starts on ElevenLabs when a key and a voice are
set. It switches to OpenRouter for the rest of the call, with a "Switched to
backup voice" toast, when ElevenLabs refuses the key, runs out of credits or its
socket fails twice within 30 s. Out of credits also keeps the next calls on the
backup voice until the credits reset. If OpenRouter fails too, the reply is shown
as text only.

**Where to see it.** The call panel's footer has the running figures, **Call
history** has each call's characters, seconds and OpenRouter dollars, and the
Overview shows **Voice this month** (calls, minutes, ElevenLabs credits,
OpenRouter dollars) for the calendar month. Once you have made a Scribe call of
at least 30 seconds, Settings shows what Scribe costs per minute on your plan.

**Scribe tokens.** In Scribe mode the browser talks to ElevenLabs directly with a
single-use token the server mints, at most 10 per hour. Each Scribe socket needs
a fresh token, and an idle one closes after `VOICE_SCRIBE_IDLE_CLOSE_MS`. When
the hour's tokens run out, the call falls back to OpenRouter with a toast.

## HTTPS

Browsers only hand a page the microphone in a *secure context*: over HTTPS, or
on `localhost`. Opened over plain HTTP on any other address, the call panel says
so instead of starting. Serve chief-web behind a TLS-terminating reverse proxy
(Caddy, Traefik, nginx) and open it at its `PUBLIC_URL`.

When `PUBLIC_URL` is set, the call socket also refuses a browser whose `Origin`
is not that address.

## What chief can do

Chief answers most questions ("what's building?", "does anything need me?")
from a snapshot of the sessions, queue and pull requests that it gets with every
request, without calling a tool. The snapshot also lists the planning sessions
with their state and number of open questions, so "what's still open?" or
"welke sessies wachten op mij?" is answered with names and counts; ask what a
session wants to know and chief reads its questions with `get_session`. Sessions, repositories and tasks can be named
the way you say them: "billing export" finds `billing-export`, and when a name
matches more than one, chief asks which.

### The confirmation rule

Anything that changes something is **confirmed first, and the server enforces
it**. Chief's first call of such a tool does nothing: it reads back what it is
about to do ("Create session csv-export-invoices on shop-api, targeting
develop?") and the panel shows **Confirm** / **Cancel**. The action only runs
on a later turn: a bare "yes", "ja" or "do it", a click on **Confirm**, or chief
confirming after you answered. It runs exactly what was read back, not what the
model asks for then. Chief cannot confirm in the same turn it asked, a question
expires after 60 seconds, a new question replaces the old one, and moving the
call to a session cancels it. "No", "nee" or **Cancel** drops it.

### Tools

| Tool | What it does | Confirmed |
| --- | --- | --- |
| `list_sessions` | sessions, active first, filtered by status or repository; `planning` for only the planning sessions with their state | – |
| `get_session` | one session: status, stories, build progress, PRD, pull request; a planning session's state and open questions | – |
| `list_repositories` | the registered repositories | – |
| `overview` | the dashboard numbers and the usage-limit hold | – |
| `build_status` | the current story and a summary of the latest build log | – |
| `show` | opens a page: Overview, Sessions, Pull requests, Recurring tasks, Repositories, Sentry, Settings | – |
| `focus_session` | hands the call to a session's agent | – |
| `answer_planning_question` | passes an answer to one open question (by number) or all of a planning session's open questions; the session updates its PRD alone and its end is announced like a finished draft ("csv-export updated its PRD; 3 open questions left"). Refused for a session that is not planning, is drafting or has no open questions, and during the usage-limit hold or with the planning terminal open | – (read back) |
| `create_session` | creates a session; the clone continues in the background | yes |
| `start_build` | starts (or queues) a ready session | yes |
| `stop_build` | stops a build, or takes a session out of the queue | yes |
| `mark_ready` | parses the PRD and reads out any errors | yes |
| `back_to_planning` | returns a ready session to planning | yes |
| `schedule_start` | sets or clears a session's start time ("tonight at 2") | yes |
| `retry` | retries a failed session | yes |
| `list_pull_requests` | open pull requests with their runs and conflicts | – |
| `review_pull_request` | starts a code review, posted on GitHub | yes |
| `address_pr_feedback` | starts a run that works through the unresolved review comments | yes |
| `request_pr_change` | posts your instruction as a review comment, then starts a run that implements it | yes |
| `stop_pr_run` | stops the feedback run on a pull request | yes |
| `fix_pr_conflicts` | checks a pull request for conflicts and starts the fix | yes |
| `list_recurring_tasks` | recurring tasks with schedule, next run and last outcome | – |
| `get_recurring_task` | one task with its prompt and last five runs | – |
| `create_recurring_task` | creates a task; the schedule is read back in words | yes |
| `update_recurring_task` | changes a task | yes |
| `pause_recurring_task` / `resume_recurring_task` | pauses or resumes a task | yes |
| `run_recurring_task_now` | runs one occurrence now | yes |
| `confirm` | runs the pending confirmation (only on a later turn) | – |
| `end_call` | says goodbye and hangs up | – |

**What chief cannot do.** There is no tool to delete anything (sessions,
repositories, tasks, transcripts), change settings, open a terminal, merge a
pull request or touch the Claude login. Those stay in the UI.

## Session agents

"Let's talk about billing export", **Talk it through** in a pending session's
planning panel, **Ask about this session** on any other cloned session, or the
focus chip hands the call to that session's agent. It is `claude` running inside
the session's container, with the repository open, on your subscription. The
first start takes a few seconds ("one sec"); after that it stays alive for the
call and `VOICE_KEEP_AGENTS_MS` after it.

- **Planning** (a `pending` session): it asks about the feature, reads the code
  where that helps, and writes `prd.md`. When the PRD parses, the PRD indicator
  fills in and chief mentions it. Say "back to chief" and ask chief to mark it
  ready and build it.
- **Q&A** (any other status): it can read the code and the build log, but is
  started with the edit tools disallowed, because the build loop owns the tree.
- **Handing over to the keyboard.** **Resume planning** in the session's
  terminal continues the voice conversation where it left off. Starting the
  terminal while a voice agent runs for that session asks to stop the agent
  first; handing a call to a session whose terminal is open asks to close it.

A session agent refuses to start for a session without a clone yet, and while
Claude's usage-limit hold is on. It has no chief-web tools at all: it cannot
build, create or change anything outside its own container, so it asks you to
say "back to chief".

## Intents

A few short phrases are handled by the call itself, in English and Dutch, before
the agent sees them. They only match an utterance of at most 8 words that is
exactly the phrase, so a normal sentence is never taken.

| Intent | Examples | What happens |
| --- | --- | --- |
| back to chief | "chief", "back to chief", "terug naar chief" | focus returns to chief, who says one line |
| carry on | "carry on", "work it out", "you take it from here", "werk het uit", "ga je gang" | only while you talk to a planning session: it drafts the PRD alone and the call goes back to chief, who says one line; anywhere else the words go to the agent |
| switch to a session | "switch to billing export", "talk to …", "ga naar …", "praat met …" | the call moves to that session's agent |
| stop talking | "stop", "wait", "hold on", "wacht" | cuts the current reply; no answer |
| repeat | "say that again", "repeat", "wat zei je", "herhaal" | replays the last reply without a new provider call |
| mute / unmute | "mute", "text only", "stil" / "unmute", "stem aan" | text only for the rest of the call / voice again |
| yes / no | "yes", "do it", "ja", "klopt" / "no", "cancel", "nee", "laat maar" | answers the pending confirmation |
| hang up | "hang up", "that's all", "bye", "ophangen", "dat was het" | goodbye, and the call ends |

The full lists are in `server/src/voice/intents.ts`.

## Background events

While a call is open, chief speaks up about what happens elsewhere, at the next
quiet moment (2 s of silence on both sides):

- **Important** (default): a session cloned or failed to set up, a build
  finished or failed, a pull request opened, a feedback run finished, a conflict
  fixed, Claude's usage-limit hold, a planning session that finished drafting
  on its own ("Your session csv-export on shop-api has finished with 4 open
  questions.").
- **All** adds: each finished story, a build waiting, a recurring task fired, a
  review finished, a PRD that just became valid.
- **None** speaks nothing.

Every event is also shown as a toast in the panel. With a session agent in
focus, only events about that session are spoken — except a finished draft,
which is announced whoever has the focus. A PRD that became valid is not
announced separately when its finished draft is.

Chief also keeps track of your other planning sessions. "Back to chief" names
them ("Back with me. csv-export has a draft PRD with 2 open questions.
billing-export on shop-api is waiting with 4 open questions."), and when the
session you are talking to finishes its PRD, chief names the others at the next
quiet moment. If exactly one is waiting it asks "Shall I switch you over?"; say
yes (or press Confirm) to go there.

Going back to a planning session that is waiting for you (by name, the focus
chip or that "yes") does not start with a greeting: its agent is handed its open
questions and asks them one at a time, and if you speak first your words go
along with them. A finished session says its PRD is complete; one whose draft
failed is told why and picks up from what is on disk. After every reply the PRD
is read again, so the chip's open-question count and the session page's PRD
panel count down as you answer.

## Privacy

- **Audio is never stored.** chief-web holds your speech in memory only long
  enough to send it to speech-to-text; the agents' audio is streamed to your
  browser and forgotten. Short replies are kept in memory for **repeat** until
  the call ends.
- **Transcripts** (what you said, what the agents said, tool summaries and
  timings) are stored in the SQLite database, per call, and deleted after
  **Keep transcripts for** days (default 30). Delete a call by hand under
  **Call → History**. The **Voice this month** figure is summed from these
  rows, so a retention under a month undercounts it.
- **What leaves the server, and where to:**
  - **OpenRouter** receives your speech (in OpenRouter speech-to-text mode), the
    whole chief conversation including the state snapshot (session, repository
    and pull request names and statuses, never repository content), and the
    backup voice's text. OpenRouter passes each request to the model's
    provider; what is kept is governed by OpenRouter's settings and privacy
    policy and by that provider's.
  - **ElevenLabs** receives everything the agents say, as text, and in Scribe
    mode your speech, streamed straight from the browser. Its retention follows
    its own policy and your plan.
  - **Anthropic**, through Claude Code in the session container, receives the
    session agent conversation, exactly as it does for planning and builds.
  - With **Browser speech recognition** or **Live captions**, your browser may
    send audio to its vendor's speech service (Chrome does).
- **Keys stay on the server.** See [Security model](security.md#voice-calls).

## Latency

The target is **2 seconds** from the moment you stop talking to the moment you
hear chief's first word. Every turn records six timestamps, and the call panel
can show where the time went.

**Seeing it.** Click the pulse icon in the call panel's header. A strip under
the header shows the last turn's stages as deltas, plus the total (drawn in
amber when it is over 2 s), and every one of your lines gets its speech-to-text
time next to "You". The toggle is remembered in this browser. Past calls show a
summary line per reply in **Call history**.

**The stages.** Each timestamp is stored on the turn's rows in `voice_turns`
(the first two on your line, the rest on the agent's reply):

| Column | When it is taken | Stage shown in the panel |
| --- | --- | --- |
| `t_speech_end` | the server receives your finished utterance | — |
| `t_transcript` | the transcript is ready | **STT** = transcript − speech end |
| `t_first_token` | the agent's first word of text arrives | **LLM** = first token − transcript |
| `t_first_chunk` | the first sentence is complete enough to speak | **Chunk** = first chunk − first token |
| `t_first_audio_sent` | the first audio bytes go out to the browser | **TTS** = first audio sent − first chunk |
| `t_first_audio_played` | the browser starts playing them (its `metrics` message) | **Play** = first audio played − first audio sent |

**What moves each stage.** All of these are in **Settings → Voice**:

- **Before `t_speech_end`: End of speech after (ms)** (`voice_vad_silence_ms`).
  This is how long you must be silent before the browser treats the utterance
  as finished. The timer is not in the table because it runs before the first
  timestamp, yet every millisecond of it adds to what you wait. Lower it for
  snappier turns; raise it if chief keeps answering half a sentence.
  Push-to-talk skips this wait entirely.
- **STT: Speech to text** (`voice_stt_provider`) and **OpenRouter
  speech-to-text model** (`voice_or_stt_model`). With OpenRouter the whole WAV
  is uploaded after you stop, so this stage grows with the length of what you
  said. With ElevenLabs Scribe the words stream while you talk and the
  transcript is nearly instant. The server does not see the end of speech in
  that mode, so STT shows `—` and the total counts from the transcript.
- **LLM: Chief model** (`voice_chief_model`) for chief. For a session agent it
  is **Session agent model** (`voice_session_model`) plus Claude Code's own
  start-up; the first turn after a handover is the slow one. A turn that calls
  a tool before it says anything counts the tool as well. **Speculative chief**
  (`voice_speculative_chief`, Scribe only) starts chief on a stable partial
  transcript, and can take most of this stage off the clock.
- **Chunk:** text is spoken a sentence at a time, and the first sentence waits
  for its punctuation (at least ~40 characters). No setting moves this. It is
  long when the model opens with a long sentence.
- **TTS: ElevenLabs model** (`voice_tts_model`; `eleven_flash_v2_5` is the
  fastest) and **Voice**. When ElevenLabs is out of credits or unreachable, the
  **Backup voice model** is used instead, which is usually slower to its first
  audio.
- **Play:** the network between the server and your browser, the 80 ms jitter
  buffer, and the audio device's output latency. No setting moves this.

When nothing has been heard 700 ms after your turn ended, a short
acknowledgement ("mm-hm", "okay") plays so the silence does not feel dead.
These are rendered once per voice and cached under
`<DATA_DIR>/voice-cache/`.

**Clocks.** `t_first_audio_played` comes from the browser's clock and the rest
from the server's, so **Play** (and the total) are only as right as the two
clocks agree. On the same machine, or with both synced over NTP, the error is a
few milliseconds. A negative **Play** means the clocks disagree.

## Testing

The server side is covered by `node:test` suites under `server/src/voice/`,
including a scripted end-to-end call in `call.test.ts` that needs no network.
What they cannot cover is real audio, real browsers and real providers. Before
trusting a change to the call, go through this list:

- [ ] **Browsers:** a call in Chrome, Firefox and Safari: the microphone
      prompt, hands-free turns, push-to-talk, and the agent's voice.
- [ ] **Headset vs speakers:** on speakers, count how often the agent's own
      voice interrupts it (false barge-in) with **Interrupting the agent** on
      Careful; with a headset, try On.
- [ ] **Dutch and English:** a few turns in each, with **Language** and
      **Second language** set; check the transcript and the pronunciation of
      session names.
- [ ] **A 30-minute planning call end to end:** "let's start a new session for
      …", confirm, wait for the clone, plan the feature by voice until the PRD
      is written, then "back to chief" and have it marked ready. The PRD must
      parse and **Mark ready** must go green.

## Troubleshooting

**The call panel says the microphone needs HTTPS.** See [HTTPS](#https).

**"Voice is turned off" / "Voice needs an OpenRouter API key" when calling.**
The toast says which setting is missing; fix it in **Settings → Voice**. "Scribe
needs an ElevenLabs API key" means **Speech to text** is on Scribe without an
ElevenLabs key.

**The browser never asked for the microphone, or it hears nothing.** Check the
site's microphone permission in the address bar and the input device your OS
uses. **Test microphone** in Settings shows what the server heard.

**"A call is already open in another tab".** Another tab or browser holds the
call; **Take it over here** moves it to this one. The other tab gets a toast.

**Chief answers half a sentence, or cuts in while you think.** Raise **End of
speech after**, or use push-to-talk.

**The agent keeps interrupting itself on speakers.** Set **Interrupting the
agent** to Careful or Off, or use a headset.

**"Switched to backup voice".** ElevenLabs refused the key, ran out of credits
or dropped the socket twice. The rest of the call uses the backup voice; check
the key and your balance with **Check ElevenLabs key**. If the backup voice
sounds too fast or slow, fix **Backup voice sample rate**.

**No voice at all, only text.** Either the voice is muted ("unmute"), or both
ElevenLabs and OpenRouter speech failed; the panel shows an error per turn.

**Chief says "I can't reach my brain right now".** OpenRouter refused or failed the chat
request. **Check OpenRouter key** tells you whether the key, the credit or the
**Chief model** slug is the problem. A model without tool calling is refused
there.

**A session agent will not start.** It says why: the session has no clone yet,
the planning terminal is open (it offers to close it), or Claude's usage limit
is on hold until the time it gives. Claude Code must also be logged in, as for
builds; see [Claude authentication](claude-auth.md).

**Scribe falls back to OpenRouter mid-call.** The hour's 10 single-use tokens ran
out, or ElevenLabs refused one. A long, talkative call can hit this because an
idle Scribe socket closes after `VOICE_SCRIBE_IDLE_CLOSE_MS` and the next one
needs a new token; raise that value.

**Replies are slow.** Open the latency strip (pulse icon) and see which stage is
long; [Latency](#latency) lists what moves each one.
