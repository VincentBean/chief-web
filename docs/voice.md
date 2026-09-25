[← chief-web](../README.md) · [All docs](../README.md#documentation)

# Voice calls

Talk to **chief** from any page: the **Call** item in the sidebar opens the call
panel. The rest of this guide (setup, providers and costs, what chief can do,
privacy, troubleshooting) is still being written; the sections below are the
ones that exist so far.

## HTTPS

Browsers only hand a page the microphone in a *secure context*: over HTTPS, or
on `localhost`. Opened over plain HTTP on any other address, the call panel says
so instead of starting. Serve chief-web behind a TLS-terminating reverse proxy
(Caddy, Traefik, nginx) and open it at its `PUBLIC_URL`.

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

**Clocks.** `t_first_audio_played` comes from the browser's clock and the rest
from the server's, so **Play** (and the total) are only as right as the two
clocks agree. On the same machine, or with both synced over NTP, the error is a
few milliseconds. A negative **Play** means the clocks disagree.
