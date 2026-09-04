[← chief-web](../README.md) · [All docs](../README.md#documentation)

# Web interface

## Layout

Every authenticated page shares one frame: a sidebar with the six places the
app has — **Overview**, **Sessions**, **Pull requests**, **Repositories**,
**Terminals**, **Settings** — and, at the bottom, the two facts worth having on
screen at all times: how many build slots are in use, and whether Claude Code is
signed in. When Claude's usage limit is holding work, a countdown to the end of
the hold sits there too. Below a laptop-width viewport the sidebar becomes a
drawer behind the menu button.

Navigation is client-side, so moving between pages does not reload the app.
Keyboard shortcuts: press `g` then a letter to jump — `o` overview, `s`
sessions, `p` pull requests, `r` repositories, `t` terminals, `,` settings, `n`
new session. On the sessions page `n` opens the new-session form and `/`
focuses the filter box.

Outcomes of actions (a build started, a session deleted, a token validated) are
shown as a short-lived toast in the corner; anything that has to stay readable
— git's stderr, PRD parse errors, a failed session's reason — is rendered inline
on the page that owns it.

## Overview

The home page (`/`) is what the server is doing right now and what it has done
lately:

- **Get set up** — shown until Claude Code is signed in, a repository with a
  deploy key exists and a session has been created; each step links to where it
  is done.
- **Needs you** — failed sessions (with a one-click **Retry**), sessions held by
  the usage limit, and sessions that slept through their scheduled start.
- **Right now** — every session holding or waiting for a build slot, with its
  story progress, and the slot meter.
- **Up next** — scheduled starts, soonest first.
- **Figures** — stories shipped, sessions finished and sessions started over the
  last fourteen days, each with a bar per day, and the all-time finish rate.
- **Repositories** — per repository: sessions, active builds, stories done,
  finished and failed counts.
- **Recently finished** — with a link to each pull request.

The numbers come from `GET /api/stats`, an aggregate over the database (no
Docker or GitHub calls), polled every five seconds while the tab is visible.
`?days=` widens or narrows the activity window (1–90, default 14).

## Sessions

`/sessions` is a table of every session, most recently updated first: status,
name and repository, story progress, feature branch and target, when it last
changed, and the actions that make sense for its state (**Retry**, **Retry
setup**, **Leave queue**, the pull request, **Open**, **Delete**). Rows that need
attention are marked at their left edge.

Filters live in the URL, so a bookmark to `/sessions?filter=attention` is a
to-do list: `filter` is one of `active`, `attention`, `planning`, `ready`,
`finished`; `repository` narrows to one repository; `q` matches the name,
repository or branch. The sidebar's counts link to the matching filter.

**The list is polled every 3 seconds, not pushed.** A session is moved along by
the build loop, the planning terminal and the delivery step — all in other
processes, none of them able to reach a browser tab — and the whole list is a
handful of database rows plus one `stat` per session, so re-reading it is
cheaper than a socket per browser would be. One poll feeds the sidebar, the
overview and the list at once; a hidden tab polls nothing.

**New session** (`/sessions/new`) is its own page: repository, name, base
branch, pull request target, an optional scheduled start and a **Code review**
checkbox (seeded from the [global default](#settings)), with what happens next
explained beside it. A successful create lands on the session page; a
failed clone keeps the form and shows git's output under it.

### The session page

`/sessions/<id>` is built around the stage the session is in. Under the header
— name, status, the one primary action for that state (**Mark ready**, **Start
build**, **Stop build**, **Resume now**, **Retry**, **Open pull request**) — a
four-step strip shows Plan → Ready → Build → Pull request, with the step that
failed marked in red when a session has failed. The main column shows what that
stage needs: the planning terminal while pending, the loop's iteration and
attempt counters and the story list while building, the failure reason and what
a retry will do when failed. The side column carries the facts (branches, pull
request, timestamps), the PRD's parse state, the schedule, and the
[code review](code-review.md) toggle, which stays changeable until the session
is finished. The agent log runs full width underneath and follows live output
while the loop runs.

### Deleting a session

**Delete** removes what chief-web created *here*, and nothing on the remote:

1. a `building` session is stopped first — the agent process is signalled and
   the loop unwound, exactly like **Stop build**, so no container is pulled out
   from under a running agent;
2. the planning terminal, if one is open, is closed;
3. the container is removed;
4. the workspace on the data volume is deleted — the clone, the PRD, and
   anything the agent wrote that was never committed;
5. the row goes, and its stories with it.

The feature branch on `origin` and the pull request are **left untouched**. They
are the output of the session, and deleting a session is cleaning up this
server, not undoing the work. The confirmation dialog says all of this, and says
the extra sentence about stopping the loop when the session is building.

Docker is asked before anything local is removed: if the daemon cannot be
reached the deletion is refused with `502 session_container_unavailable` and
nothing changes, because an orphaned container next to a deleted workspace is
worse than a session that is still there.

## Browser terminals

The `/terminal` page opens a real PTY inside a running container and streams it
to an [xterm.js](https://xtermjs.org) terminal over a WebSocket. It is the
interface used to drive Claude Code sessions and to complete interactive login
flows.

How it works:

- `POST /api/terminals` creates a TTY-backed `exec` in the target container
  through the **Docker Engine API on the unix socket** — not the CLI, because
  `docker exec -it` requires a TTY on its own stdin, which a WebSocket bridge
  does not have. The API version is negotiated with the daemon on first use.
- The browser attaches at `ws://…/api/terminals/<id>/stream`. Binary frames are
  raw PTY bytes in both directions; text frames are JSON control messages
  (`resize` upstream, `attached` / `exit` / `error` downstream).
- **The server owns the terminal, not the tab.** Output is appended to a
  server-side scrollback buffer (2000 lines by default, at least 500 required),
  so closing the tab, reloading, or losing the network only detaches a viewer.
  Reconnecting to the same terminal id replays the buffer and resumes typing
  into the same shell. The id is kept in the page URL (`/terminal?id=…`), so a
  refresh rejoins automatically.
- The process only ends when you close the terminal (`DELETE
  /api/terminals/<id>`) or it exits by itself. Closing it sends **SIGHUP** to
  the shell — an interactive shell ignores SIGTERM — and escalates to SIGKILL
  after half a second. The pid is recorded by a wrapper inside the container,
  because the pid Docker reports for an exec is a *host* pid and cannot be
  signalled from within the container's PID namespace.
- Copy with Ctrl+Shift+C (or Ctrl+Insert), paste with Ctrl+Shift+V or Ctrl+V.
  The terminal refits to the window on every layout change and tells the PTY its
  new size.

`GET /api/containers` lists the running containers a terminal can target; once
sessions exist (US-009) their containers show up there.

## Settings

`/settings` holds the configuration that is not environment-specific, stored in
the `settings` table so it can be changed without a restart:

- **GitHub Personal Access Token** — used to open pull requests on your behalf.
  A classic PAT needs the `repo` scope; a fine-grained token needs *Contents:
  read/write* and *Pull requests: read/write* on the target repositories. The
  token is write-only: after saving, the API only ever reports whether one is
  configured plus its last four characters. **Validate** calls
  `GET https://api.github.com/user` with the token and shows the account it
  authenticates as, or GitHub's error.
- **Max concurrent building sessions** — the build concurrency cap.
  `MAX_CONCURRENT_SESSIONS` only supplies the default until a value is saved here.
- **Agent timeout (minutes per iteration)** — how long one headless `claude -p`
  may run on a single story, 1–720 minutes, default 30. It is read at the start
  of every iteration, so a change applies to the next one with no restart, and
  an iteration that runs out of time counts as a failed attempt toward the two
  retries. The number is also written into the prompt, so the agent knows what
  it is being held to and can decide against starting the whole test suite with
  four minutes left. `BUILD_ITERATION_TIMEOUT_MS` only supplies the default.
- **Planning model**, **Build model** and **Review model** — which model Claude
  Code runs on, set separately for the interactive planning terminal, for each
  headless story iteration of the build loop, and for the one
  [code review](code-review.md) pass over a finished branch. The choices are
  Claude Code's own `--model` aliases — `opus`, `sonnet`, `haiku`, `fable` — so
  each keeps meaning the latest model of its family as the pinned CLI in
  `runner/Dockerfile` moves.
  The default is **Let Claude Code choose**: no `--model` is passed at all and
  the CLI applies its own default, which on a subscription is whatever the plan
  defaults to. Splitting them is the point — planning is one conversation and
  cheap to run on the best model, a build is one fresh invocation per story and
  is where the usage goes, and a review is one pass over a diff that is already
  written. The planning model applies to the next terminal you open; the build
  model is read at the start of every iteration, so changing it mid-build
  applies from the next story and never rebuilds one already committed; the
  review model is read when a review starts. To offer a pinned id
  (`claude-opus-5`) or another family, add it to `AGENT_MODELS` in
  `server/src/settings/service.ts` and `web/src/api.ts` — the allowlist is
  deliberate, because `--model` accepts any string and only warns on one it does
  not recognise, so an unchecked typo would run a whole build on the fallback
  rather than failing.
- **Run code review on new sessions** — the starting value of the **Code
  review** checkbox on the new-session form, and what a session created through
  `POST /api/sessions` without a `codeReview` field gets. It is only a default:
  sessions that already exist keep the flag they were created with, and any
  session can be toggled on its own page. See [Code review](code-review.md).
- **Scan for merge conflicts every (minutes)** and **Fix merge conflicts
  automatically** — how often open `chief/` pull requests are checked for merge
  conflicts (1–1440, default 30) and whether the fixer runs at all. Both are
  read on the fly, so a change applies from the next scan; off means no scan, no
  agent and no GitHub requests. See
  [The merge conflict fixer](merge-conflicts.md).
- **Commit author name and email** — the git identity agents commit with inside
  session containers. Blank restores the defaults (`chief-web` /
  `chief-web@localhost`), which are also baked into the runner image. Use an
  address your GitHub account owns if you want the commits linked to it.
- **Claude Code** — the one-time interactive login and its status; see
  [Claude authentication](claude-auth.md).
