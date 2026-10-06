[← chief-web](../README.md) · [All docs](../README.md#documentation)

# Decisions

A build agent is alone in a container with a story and a PRD. Most of what it
needs it can find — in the code, in `progress.md`, in the git log. Once in a
while it cannot, because what is missing is not information but a *decision*:
keep the old API as a shim or drop it, store the new field on the user or on
the account, do a thing the PRD never mentioned because the story cannot be
honest without it.

Before this feature there were two ways that went, and both were bad. The agent
guessed — and a guess that turns out wrong is a story's worth of work to undo,
or worse, a pull request that reads fine and does the wrong thing. Or it stalled,
which the loop reads as an iteration that achieved nothing: two retries spent
on a wall it cannot climb, then the session **failed** with the question buried
somewhere in the log.

So now it can ask, and **wait**.

```
build iteration                  chief-web                     you
──────────────────────────────────────────────────────────────────────────
ask_operator({question, …}) ───▶ sees the tool call
  (blocked, holding its           session → deciding            the card on
   context and working tree)      iteration's clock STOPPED     the session page
                                                                  │
                                                            type the decision
                                  answer handed to the agent ◀────┘
carries on, same story ◀───────── session → building
  same iteration, same retries    clock running again
```

Nothing is given up while it waits. The agent is alive with its whole context,
the container still holds the half-finished working tree, and the session keeps
its [build slot](scheduling.md#concurrency-and-the-build-queue) — because the
work *is* still there, it is just standing still. The one thing that stops is
the iteration's own clock, so a question answered four hours later costs the
run neither a retry nor a minute of its
[budget](build-loop.md#the-live-log).

## What it asks about

The agent is told to ask only when the decision is genuinely not its to make:

- the PRD and the code leave a product question open, and the two readings lead
  to different work;
- two designs are both defensible and the choice is not reversible in a later
  story;
- doing the story properly needs something outside its scope — a schema change,
  a new dependency, touching a module the PRD never mentions;
- what it found contradicts the story: the behaviour is already there, or cannot
  work as written.

And it is told, at least as firmly, not to ask for anything it can settle
itself. A question whose answer is in the repository wastes your attention and
its own turn, so the prompt sends it to the code, the PRD, `progress.md` and
the git log first — and it may never ask for permission to proceed, for a
review of work it has already done, or for help with an error.

Whether a model honours that is a matter of prompting, not of enforcement. If
your sessions ask too much or too little, the text to change is `askSection()`
in `server/src/build/prompts.ts`.

## Answering it

The session page shows the question above everything else, because while it
stands nothing else on that page is going to change. The card carries what the
agent established, the options it offered — click one to drop it into the box —
and which one it would take unasked.

- **Send decision** hands your answer to the waiting agent *verbatim*, and the
  build carries on from exactly where it stopped: same story, same iteration,
  same retries in hand. The answer is stored on the question, so what was
  decided and why is still there weeks later.
- **Discuss this** opens a second, **read-only** Claude in the same container,
  started on the question itself. It reads the code, tells you what the real
  choice is and what each option would cost *here*, and answers follow-ups. It
  cannot write: the edit tools are refused at the CLI as well as forbidden in
  its prompt, because a build agent owns that working tree and is mid-story in
  it. It also never answers for you — the decision goes through the card, and
  the discussion closes when you send it.
- **Stop build** works as it always does. The agent is signalled, the question
  goes with it, and everything already committed stays committed.

The question also goes into the [live log](build-loop.md#the-live-log) with its
options, so an operator watching the log rather than the page sees it, and
[chief mentions it on a voice call](voice.md) however quiet you have asked it to
be about everything else.

## If nobody answers

A question stands for **four hours**. That is long enough to cover a night's
sleep and short enough that a forgotten question does not hold a build slot for
a week.

When it runs out the agent is told so, and told what to do about it: take the
most conservative of the options it offered, write the question and the choice
it made under `## Open Questions` in the PRD and into its `progress.md` entry,
and finish the story on that basis. The session goes back to **building**. So
an unanswered question costs wall-clock time and nothing else — and what it
decided alone is written down where the next iteration, the
[code review](code-review.md) and you will all see it.

The timeout is one number shared by both ends of the wait
(`DECISION_TIMEOUT_MS` in `server/src/build/decisions.ts`), passed into the MCP
server's environment so the two cannot drift apart.

## What a restart does to it

Nothing good, and the page says so plainly. The agent was blocked inside an
exec that *this server process* was holding open, so a restart takes both the
agent and the only channel an answer could have arrived on. Startup
reconciliation fails such a session at the `agent` stage with that reason on
it, exactly as it does for a [lost container](build-loop.md#failure-and-recovery),
and **Retry** resumes at the first story that is not `done` — with a fresh
iteration that is free to ask again if it still needs to.

The question itself is kept as a record. It is shown with no answer box and a
note saying nothing is waiting for it any more, which is the one thing worse
than losing a question: appearing to accept an answer that reaches nobody.

## How it works

The agent's end is one tool on the `chief` MCP server the runner image ships
(`runner/chief-mcp.js`), the same server the voice session agent talks to. A
build iteration gets it with `ask_operator` turned on and *nothing else* — no
browser it would be looking at alone, and no `start_build` for a build it is
already inside.

The two halves meet over a pair of files in the container, the same round trip
as the voice call's "watch with me" card:

| | |
| --- | --- |
| `/tmp/.chief-build/ask/<id>.request` | written by the tool: the question, its options, the context, the recommendation |
| `/tmp/.chief-build/ask/<id>.answer` | written by chief-web: `{ answered: true, answer }`, or `{ answered: false, reason }` |

chief-web notices the call on the iteration's `stream-json` output — which it is
already parsing a line at a time for the log, so noticing one costs nothing —
then reads the request, records it, parks the session and stops the clock. Both
files are deleted the moment the answer has been read.

```
server/src/build/
├── decisions.ts    DecisionWatcher: the relay, the row, the status, the clock
├── mcp.ts          the iteration's --mcp-config: one server, one tool
└── prompts.ts      askSection(): when an iteration should reach for it
server/src/docker/
├── deadline.ts     ExecDeadline: the iteration budget, pausable
└── request-files.ts  the request/answer file round trip, shared with voice
server/src/db/decisions.ts   one row per question asked
```

Each question is a row in `decisions`, keyed by the MCP request id — so an
answer written for one question can never land on another — and it is `open`,
`answered`, `expired` (nobody answered in time) or `abandoned` (the run that
asked it ended first). A session has at most one open question: its agent is
blocked on the one it asked, so there is nobody left to ask a second.
