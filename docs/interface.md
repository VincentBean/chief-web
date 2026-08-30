[← chief-web](../README.md) · [All docs](../README.md#documentation)

# Web interface

## Dashboard

The home page (and `/sessions`) is the dashboard: every session, most recently
updated first, with its repository, status badge, story progress (`4/9 done`),
feature branch, [scheduled start](scheduling.md#scheduled-starts) with its countdown, its
place in the [build queue](scheduling.md#concurrency-and-the-build-queue) if it is waiting
for a slot, and pull request link. Each row links to the
[session page](sessions.md#planning), and the "New session" form lives here too, so the
page an operator lands on is the one they work from.

**The list is polled every 3 seconds, not pushed.** A session is moved along by
the build loop, the planning terminal and the delivery step — all in other
processes, none of them able to reach a browser tab — and the whole list is a
handful of database rows plus one `stat` per session, so re-reading it is
cheaper than a socket per browser would be. A status change is on screen within
one poll.

The status and repository filters are applied in the browser over that same
list, so filtering never costs a request and never reorders anything.

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
  retries. `BUILD_ITERATION_TIMEOUT_MS` only supplies the default.
- **Planning model** and **Build model** — which model Claude Code runs on, set
  separately for the interactive planning terminal and for each headless story
  iteration of the build loop. The choices are Claude Code's own `--model`
  aliases — `opus`, `sonnet`, `haiku`, `fable` — so each keeps meaning the
  latest model of its family as the pinned CLI in `runner/Dockerfile` moves.
  The default is **Let Claude Code choose**: no `--model` is passed at all and
  the CLI applies its own default, which on a subscription is whatever the plan
  defaults to. Splitting the two is the point — planning is one conversation
  and cheap to run on the best model, while a build is one fresh invocation per
  story and is where the usage goes. The planning model applies to the next
  terminal you open; the build model is read at the start of every iteration,
  so changing it mid-build applies from the next story and never rebuilds one
  already committed. To offer a pinned id (`claude-opus-5`) or another family,
  add it to `AGENT_MODELS` in `server/src/settings/service.ts` and
  `web/src/api.ts` — the allowlist is deliberate, because `--model` accepts any
  string and only warns on one it does not recognise, so an unchecked typo
  would run a whole build on the fallback rather than failing.
- **Commit author name and email** — the git identity agents commit with inside
  session containers. Blank restores the defaults (`chief-web` /
  `chief-web@localhost`), which are also baked into the runner image. Use an
  address your GitHub account owns if you want the commits linked to it.
- **Claude Code** — the one-time interactive login and its status; see
  [Claude authentication](claude-auth.md).
