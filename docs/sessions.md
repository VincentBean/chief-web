[← chief-web](../README.md) · [All docs](../README.md#documentation)

# Sessions

A session is one feature: its own container, its own clone, its own branch. The
[dashboard](interface.md#sessions) creates one from a repository, a name, a base branch, a PR
target (`develop` or `main`), an optional scheduled start, a [code
review](code-review.md) flag and optional [feedback](#feedback-sessions). The name is a slug (letters, numbers, hyphens,
underscores), unique per repository, and becomes both the feature branch
**`chief/<session-name>`** and the workspace directory.

Submitting the form does four things, in order:

1. writes the session row as `pending`;
2. starts its container (see [Session containers](architecture.md#session-containers));
3. asks `origin` whether `chief/<session-name>` already exists;
4. clones the base branch into `/workspace/repo` and creates the feature branch
   from `origin/<base branch>`.

Each step runs as its own `docker exec` inside the container, so it uses the
repository's deploy key and the runner's SSH configuration — nothing about the
clone is special-cased on the server. Everything the shell needs arrives in the
environment, so a repository URL or branch name is never parsed as shell syntax.

**A feature branch that already exists on `origin` stops the setup.** The message
says so and asks for a different session name (or for the remote branch to be
deleted). chief-web never reuses or force-pushes a branch it did not create — a
leftover branch from a deleted session is somebody's work until they say
otherwise.

Any other failure — an unreachable remote, a missing base branch, a rejected key
— leaves the session **`pending`** with git's own stderr on screen, the reason
stored on the session, and a **Retry setup** action. The container of a failed
setup is removed; the workspace is not, so a retry reuses an existing clone
instead of starting over. `SESSION_SETUP_TIMEOUT_MS` caps each git command.

## Sessions a recurring task started

Not every session is created by hand. A [recurring
task](scheduling.md#recurring-tasks) — a stored prompt plus a cron expression —
spawns a fresh session of its own on every occurrence that comes due, named
`<task name>-<YYYYMMDD-HHmm>`, stamped in UTC. It is an ordinary session in
every way that matters: its own container, its own clone, its own branch, the
same setup steps above, the same [build loop](build-loop.md), the same queue and
the same delivery. Three things are different:

- **nobody plans it.** There is no browser terminal and no PRD conversation:
  chief-web writes a single-story PRD from the task's prompt and marks the
  session ready itself, so it goes from `pending` to `ready` to building without
  anyone touching it.
- **it may finish without a pull request.** When the run committed nothing —
  the usual outcome of a nightly "fix what the linter reports" task — the push,
  the pull request and the code review are all skipped and the session goes
  straight to `finished`, showing *nothing to deliver* instead of a PR link.
  Only recurring runs do this; an interactive session with an empty branch still
  goes through delivery.
- **it is one occurrence of a schedule.** The session page links back to the
  task, the task's history records what became of this run, and the next
  occurrence is skipped for as long as this one is unfinished or its pull
  request is still open.

Deleting a recurring task does not delete the sessions it ran; they stay exactly
where they are, with their branches and pull requests, and simply stop belonging
to a task.

## Feedback sessions

A session can carry **feedback**: what is wrong, or could be better, in an
application the repository already has ("the checkout total is wrong when you
use a coupon"). It is the session's `feedback` field, up to 4000 characters
(trimmed; blank means none), set when the session is created: by the
**Feedback** box on the new-session form, by `feedback` in
`POST /api/sessions`, or by chief's `start_feedback_session` on a
[voice call](voice.md#feedback-sessions). `GET /api/sessions` and
`GET /api/sessions/:id` return it (`null` when there is none), and the
dashboard marks such a session with a **Feedback** badge.

A feedback session is planned from the feedback instead of from "what do you
want to build?". The [planning](#planning) prompt quotes it verbatim and asks
the agent to find the code involved, to reproduce the problem in the browser
when one is available, and to write a `## Feedback` section into `prd.md`: the
feedback, the pages involved as paths, and, when the browser was used, the
steps to reproduce it with what was expected and what was observed, plus links
to screenshots in `.chief/prds/<session-name>/screenshots/`. That section is
not a story, so [Mark ready](#marking-a-session-ready) ignores it; the
[build loop](build-loop.md) tells every iteration to read it. Past planning, a
feedback session is an ordinary session.

## Session states

A session is in exactly one of six states, and the badge on the
[dashboard](interface.md#sessions) is that state:

| Status | What it means | What moves it on |
| --- | --- | --- |
| `pending` | Being set up, or being planned: there is no PRD chief-web can build yet | **Mark ready**, once `prd.md` parses |
| `ready` | The PRD is parsed and the stories are in the database | **Start build**, a [scheduled start](scheduling.md#scheduled-starts), or its turn in the [queue](scheduling.md#concurrency-and-the-build-queue) |
| `building` | The [build loop](build-loop.md) is running an agent on a story | The loop itself: completion, a failure, or **Stop build** |
| `waiting` | Paused by Claude's [usage-limit hold](build-loop.md#the-usage-limit-hold); the container and the build slot are kept, and `waiting_until` says when it resumes | The scheduler when the hold expires or another account can take over ([failover](#claude-account)), **Resume now**, or **Stop build** |
| `failed` | A stage gave up and stored why (see [Failure and recovery](build-loop.md#failure-and-recovery)) | **Retry**, which resumes at the stage that failed |
| `finished` | Every story is `done`, the pull request is open and the [code review](code-review.md), if it was on, has been posted — or, for a [recurring run](#sessions-a-recurring-task-started) that changed nothing, there was nothing to deliver at all | Nothing — the session's work is on `origin` |

A queued session is `ready` with a `queued_at` timestamp, not a state of its
own, so leaving the queue costs nothing.

## Code review

Every session carries one more flag: whether chief-web reviews the pull request
it opens. It is set on the new-session form (seeded from **Settings → Run code
review on new sessions**) and can be changed from the session page at any time
until the session is finished. What the review does, what it posts and what
happens when it fails is [its own page](code-review.md).

## Thinking effort

A session can also carry a **thinking effort**: how hard Claude Code thinks
before it answers, passed to the CLI as `--effort <level>`. There are five
levels, from least to most: **`low`**, **`medium`**, **`high`**, **`xhigh`**
and **`max`**. More effort means more thinking tokens per turn, so it costs
more usage and time.

The effort applies to the two places chief-web launches Claude Code for a
session: the [planning terminal](#planning) and every
[build iteration](build-loop.md). Nothing else changes. The
[code review](code-review.md) pass, pull request feedback runs and
[merge conflict fix](merge-conflicts.md) runs always launch without
`--effort`, whatever the session or the setting says.

The effort a launch uses is resolved in this order:

1. **The session's own effort**, if it has one. Set it on the new-session form
   or in the **Thinking effort** card on the session page.
2. **The global default**, **Settings → Default thinking effort**, for a
   session left at **Default**.
3. **Claude Code's own default**, when neither is set. In that case no
   `--effort` is passed at all.

A session left at **Default** stores no level of its own, so a later change to
the global default reaches it too. Sessions created by a
[recurring task](#sessions-a-recurring-task-started), a Sentry fix or a voice
action always start at **Default**.

**A change applies from the next launch.** Nothing is restarted. The planning
terminal reads the effort when it is opened, so a terminal that is already
open keeps its effort until you close it and open a new one. A build reads it
at the start of every iteration, so a change made while a session is
**building** applies from the next iteration, and the story that is running
finishes at the old effort. Each iteration writes the effort it uses to the
build log as `Thinking effort: <level> (session)` or `(default)`. Once a session
is **finished** its effort can no longer be changed, because no agent will run
for it again.

## Claude account

chief-web can have [several Claude accounts](claude-auth.md), and each session
runs on one of them. Every container the session gets — the planning terminal,
the build, the review, the pull request description — mounts that account's
login, and its usage counts against that account's limits.

**The picker.** The new-session form has a **Claude account** field right after
**Thinking effort**, and the session page has a **Claude account** card under
the thinking effort card. Both open the same picker: each account with its
status dot, its nickname or email, and its 5-hour and 7-day usage, marked *not
signed in* or *sign in again* (those cannot be chosen) or *on hold* (it can be
chosen; the work fails over or waits, see below).

**The default.** The first choice is **Default (<name>)**: the session stores
no account of its own and follows the default account, so a later change of
the default reaches it too. The default is the account pinned with **Make
default** in [Settings → Claude Code](claude-auth.md#make-default); with none
pinned it is the first signed-in account, and the option reads **Default
(first signed-in account)**. The account a launch uses is resolved in this
order:

1. **The session's own account**, if it has one.
2. **The default account**, for a session left at **Default**.

With no account signed in at all, no session can be created or planned. A
session whose account is removed falls back to the default. Sessions created by
a [recurring task](#sessions-a-recurring-task-started) run on the task's
account, Sentry fix sessions on the Sentry account
([Settings](claude-auth.md#settings)), and voice-created sessions on the
default.

**Changing it on a running session.** The card saves on change. Nothing is
interrupted: the account is read when agent work is launched, so the change
applies from the next build iteration, planning terminal, review or
description, and the story that is running finishes on the old account. Unlike
the thinking effort, an account cannot be swapped inside a running container,
so that next launch **recreates the session's container** on the new account
first — the workspace on the data volume is kept; a planning terminal or
browser terminal open in the old container closes. The toast says so when the
session has a container. Once a session is **finished** or merged its account
can no longer be changed (`409 claude_account_locked`).

**Failover.** When the session's account is held by its
[usage limit](build-loop.md#the-usage-limit-hold), the session does not have to
wait: it runs on another signed-in account that is not held and whose 5-hour
usage is at most 95% — the least used one. The card's badge names the account
it is actually running on, the card reads **Running on <other> while <own> is
on hold until <time>**, and the sessions list carries the same line without
the time. As soon as its own account's
hold has expired, the next launch takes it back home. When no other account
qualifies, the session waits at **waiting** as it would with one account. The
full rules are in [Failover](claude-auth.md#failover).

## Planning

Each session has a page of its own at `/sessions/<id>`, and while the session is
**pending** that page is `chief new` in the browser: it opens a browser terminal
inside the session's container running **`claude` interactively in
`/workspace/repo`**, started with chief's PRD-generation prompt targeting
`.chief/prds/<session-name>/prd.md`.

The prompts are ported from chief's `embed/init_prompt.txt` and
`embed/edit_prompt.txt` into `server/src/planning/templates.ts`, so the
conversation is the one chief has: 3–5 clarifying questions with lettered
options ("1A, 2C, 3B"), then a PRD written in chief's exact format —
`### US-xxx: Title` headings with `**Status:**`, `**Priority:**`,
`**Description:**` and `- [ ]` acceptance criteria. chief's own prompts leave
the status line implicit (chief writes it itself), so chief-web appends the
story format it parses to both prompts.

- **Start planning** uses the init prompt, with the optional "what do you want
  to build?" text filling chief's `{{CONTEXT}}` slot. `--model` is passed when a
  planning model is set (**Settings → Planning model**), and omitted otherwise.
- **Resume planning** uses the *edit* prompt whenever `prd.md` already exists,
  exactly like `chief edit`: an existing PRD is changed, never rewritten.
- The terminal is an ordinary [browser terminal](interface.md#browser-terminals), so the
  server owns the process. Reloading the page or opening a second tab rejoins
  the same conversation; only **Close terminal** ends it.

Above the terminal sits a row of **quick question** buttons, one per entry of
**Settings → Planning questions** — by default *Any open questions?* and
*Re-check the entire PRD for issues, gaps and other unwanted behaviour*. A click
sends the button's text to the terminal followed by Enter, exactly as if you had
typed it, and puts the focus back in the terminal. The buttons are disabled
unless planning is running and the terminal is connected; an empty list hides
the row altogether.

The page also shows a live indicator for `prd.md`: whether it exists, when it
was last written, how many stories it holds, and — when it does not parse — the
parse errors with their line numbers. It is polled from the workspace on the
data volume (a `stat` plus a parse of a small markdown file), never through
Docker. The parser lives in `server/src/prd/` and follows chief's
`internal/prd/markdown.go`.

Planning is behind the same guard as session creation: at least one Claude account has to be
signed in (see [Claude authentication](claude-auth.md)) before an
interactive `claude` can be started.

## Marking a session ready

**Mark ready** is the gate between planning and building: it parses
`.chief/prds/<session-name>/prd.md` and only promotes the session from
**pending** to **ready** if the whole file is usable. Nothing is ever built
against a PRD chief-web cannot read.

- On success the parsed stories are synced into the `stories` table — new ones
  inserted, existing ones updated in place (their commit SHAs survive), and ones
  the PRD no longer has removed — and the page lists them by id, title, priority
  and status.
- On failure the session **stays pending** and the specific parse errors are
  shown with their line numbers and what was expected (an unknown status value,
  a non-integer priority, a duplicated story id, a story with no acceptance
  criteria, a file with no stories at all). This is a `200` with `ok: false`,
  not an error response: it is a result to read, not a failed request.
- **Back to planning** returns a ready session to `pending` so the PRD can be
  edited again. The stories stay in the database until the next **Mark ready**
  reconciles them with the file.

The parser is a round trip. `setStoryStatus(content, id, status)` in
`server/src/prd/write.ts` rewrites a single `**Status:**` line in place —
inserting one under the heading when the story has none — and leaves every other
byte of the file, including its prose, ordering and CRLF endings, untouched.
The PRD is the agent's document; the status line is the only thing chief-web
writes into it.
