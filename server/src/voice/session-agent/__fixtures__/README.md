# Session agent stream-json fixtures

Real recordings of Claude Code in the mode a session voice agent runs in
(plan §10.1). `events.test.ts` runs every one through the parser, and checks
that the stdin builders in `../process.ts` reproduce what was sent.

| Fixture | What it shows |
|---|---|
| `text-reply` | `system/init`, a text reply as `stream_event` `text_delta`s, the complete `assistant` message, the `result` line |
| `tool-use` | a `Read` `tool_use`, its `tool_result` as a `user` line, then the answer |
| `multi-turn` | two user messages on one process: stdin keeps being read after the first `result`; `init` repeats per turn; two `Write` tool calls whose `tool_result` arrives in the middle of the next block's stream |
| `interrupt` | a `control_request` interrupt sent after the first text delta: `control_response`, the partial `assistant` text, a `[Request interrupted by user]` text line, `result` `error_during_execution` / `aborted_streaming`; then a next turn on the same process |
| `no-partials` | the same without `--include-partial-messages`: text only in the complete `assistant` message |

Each `<name>.jsonl` is the CLI's stdout, one JSON per line, unedited.
`<name>.stdin.jsonl` is what was written to its stdin.

## How they were recorded

- On 2026-09-25, with Claude Code **2.1.280** (`claude_code_version` in the
  `init` lines), the release the runner image's `CLAUDE_CODE_VERSION=latest`
  installed at the time. The owner approved running it against the Claude
  subscription for this.
- On the development host, not in a runner container, logged in with the
  subscription (`apiKeySource: "none"`), `--model haiku` to keep it cheap, in a
  throwaway directory holding a `README.md` and a two-line `math.js`.
- Flags: `--dangerously-skip-permissions -p --input-format stream-json
  --output-format stream-json --verbose [--include-partial-messages]`, stdin
  lines produced by `userMessageLine` / `interruptRequestLine`.
- Host-specific noise: the `init` lines list the recording host's MCP servers,
  plugins, skills and slash commands, and the `multi-turn` model chose to save
  the word to that host's auto-memory (the two `Write` calls). Thinking blocks
  are empty with an opaque `signature`. None of this matters to the parser.

To re-record (spends subscription usage; needs a logged-in `claude` on the PATH):

```sh
cd server
node --import tsx src/voice/session-agent/__fixtures__/record.ts            # all scenarios
node --import tsx src/voice/session-agent/__fixtures__/record.ts interrupt  # one
```

`RECORD_MODEL=sonnet` records with another model. The script creates its
directory under the system temp dir; Claude Code keeps the transcripts under
`~/.claude/projects/-tmp-chief-voice-record-*`, which can be deleted afterwards.
After re-recording, run `events.test.ts`: the assertions name the recorded
texts (`OK.`, `Pelican.`, `Understood.`, `Planning sounds good.`), and a model
that answers differently needs them updated.
