# chief-web

Self-hosted web version of [chief](https://github.com/minicodemonkey/chief), the
autonomous PRD-driven coding agent. You plan a PRD in a browser terminal running
Claude Code, then chief-web runs the Ralph Wiggum loop — one fresh agent
invocation per user story, one commit per story — on an isolated feature branch
inside a dedicated Docker container, and opens a pull request when it is done.

Installation requires nothing but Docker.

## Quick start

```sh
cp .env.example .env      # set CHIEF_WEB_PASSWORD
docker compose up --build
```

The UI is then available on <http://localhost:8080> (change the host port with
`CHIEF_WEB_PORT` in `.env`). First-run setup is completed in the browser: log in
with the password, add a GitHub token and repositories, and sign Claude Code in
once from **Settings → Set up Claude** (see
[Claude authentication](#claude-authentication)).

Health check:

```sh
curl http://localhost:8080/api/health   # -> {"status":"ok"}
```

## Layout

```
docker-compose.yml   the whole stack: the `server` service, the `runner` image
                     and its two named volumes
Dockerfile           multi-stage build producing the production server image
runner/              Dockerfile for the image every session container runs
server/              Node.js + TypeScript backend (API, WebSockets, orchestrator)
web/                 React + Vite frontend, served as static files by the server
```

Persistent state lives in two named Docker volumes:

| Volume                   | Mount          | Contents                                      |
| ------------------------ | -------------- | --------------------------------------------- |
| `chief-web-data`         | `/data`        | SQLite database, SSH deploy keys, workspaces   |
| `chief-web-claude-auth`  | `/claude-auth` | Claude Code credentials shared by all sessions |

Both are named explicitly (`CHIEF_DATA_VOLUME`, `CLAUDE_AUTH_VOLUME`) rather than
carrying the compose project prefix, because the server passes those names to the
Docker socket when it spawns containers.

## Data layer

State lives in a single SQLite database inside the data volume (`DATABASE_PATH`,
default `/data/chief-web.db`), accessed through the typed data layer in
`server/src/db`. It is built on Node's built-in `node:sqlite`, so the image needs
no native modules.

| Table          | Contents                                                           |
| -------------- | ------------------------------------------------------------------ |
| `repositories` | registered repos: name, SSH URL, GitHub slug, base branch, deploy key |
| `sessions`     | one row per session: status, branches, schedule, container, PR, error |
| `stories`      | the stories parsed from a session's `prd.md`, with commit SHAs      |
| `settings`     | key-value configuration (GitHub PAT, concurrency limit, …)          |

Migrations in `server/src/db/migrations.ts` run automatically on server start.
They are append-only and recorded in `schema_migrations`, so restarting the stack
re-applies nothing and never touches existing data.

## Repositories

`/repositories` registers the git remotes sessions work on. Each repository has a
name, an SSH URL (`git@github.com:owner/repo.git`), a GitHub `owner/repo` slug —
derived from the URL, overridable — and a default base branch.

Every repository gets **its own SSH key**:

- On add, chief-web generates an **ed25519** keypair and shows you the public
  half. Add it as a *deploy key* on `github.com/<owner>/<repo>/settings/keys` and
  tick **Allow write access**, since sessions push their feature branch with it.
- Alternatively, paste an existing **unencrypted** private key. A
  passphrase-protected key is rejected: a session container has no way to unlock
  it.
- The private key is written to `SSH_KEYS_DIR/<repository id>.key` with mode
  `0600` in a `0700` directory, and is never returned by the API or shown in the
  UI after creation — only its `SHA256:…` fingerprint is.

**Test connection** runs `git ls-remote` in a short-lived runner container with
that key on stdin (never in argv or the environment) and reports either success
or git's own stderr, so a missing deploy key shows up as
`Permission denied (publickey)` rather than a generic failure. It needs the
runner image (`RUNNER_IMAGE`, built by the compose stack).

Deleting a repository is refused while any session still references it; delete
those sessions first. A successful delete also removes the private key file.

## Runner image

Sessions never run inside the server container. `docker compose build` also
builds `runner/Dockerfile` and tags it `chief-web-runner:latest` (`RUNNER_IMAGE`);
the server starts one container from it per session through the Docker socket,
plus a short-lived one for each repository "Test connection".

The image ships git, OpenSSH, Node.js 22 and the Claude Code CLI (`claude`), and:

- runs as the unprivileged **`node`** user (uid 1000) — never root;
- mounts the shared `claude-auth` volume at **`~/.claude`** (`/home/node/.claude`),
  with `CLAUDE_CONFIG_DIR` pointing there so all agent state persists in it;
- mounts the per-session workspace at **`/workspace`**, which is also the workdir;
- idles as PID 1 (`tini` + `tail -f /dev/null`) because the server `docker exec`s
  every agent, git and shell process into the running container;
- configures the git commit identity from `CHIEF_GIT_AUTHOR_NAME` /
  `CHIEF_GIT_AUTHOR_EMAIL` (defaulting to `chief-web <chief-web@localhost>`, and
  overridable on the Settings page) so agent commits never fail on a missing
  identity;
- reads the repository's SSH key from `CHIEF_SSH_KEY_PATH` (default
  `/keys/id_ed25519`, mounted read-only) and copies it to a private `0600` file
  the runner user owns. **The mounted key must be readable by uid 1000.**
- pins github.com's host keys in a baked-in `/etc/ssh/ssh_known_hosts` and uses
  `StrictHostKeyChecking=accept-new` for every other host, so clones from
  non-GitHub remotes are still non-interactive.

`server/src/runner/image.ts` is the server-side mirror of these paths — change
both together.

## Session containers

`server/src/orchestrator` owns one container per session. It talks to the Docker
socket directly (`server/src/docker/api.ts`) rather than through the CLI, and
every container it creates carries the label **`chief-web.session=<session-id>`**
— the only reliable way to find a session's container again after a restart, and
what `docker ps --filter label=chief-web.session` lists.

Each session container mounts exactly three things:

| Source                                | Target                | Mode |
| ------------------------------------- | --------------------- | ---- |
| `claude-auth` volume                  | `/home/node/.claude`  | rw   |
| `workspaces/<session-id>/`            | `/workspace`          | rw   |
| the repository's SSH private key      | `/keys/id_ed25519`    | ro   |

No ports are published; the container needs outbound network only.

The workspace lives on the data volume at `workspaces/<session-id>/`, with the
clone in `repo/` inside it. **Stopping or removing a container never deletes it**
— the clone and the `.chief/` state are what a retry resumes from. Only deleting
the session itself removes a workspace.

Two details are easy to get wrong:

- **Bind sources are resolved on the host.** The server's own `/data` means
  nothing to the daemon, so the workspace path is translated through the data
  volume's host mountpoint (`docker volume inspect`) before it is mounted. That
  is why `CHIEF_DATA_VOLUME` exists.
- **The key is mounted as a copy.** The registered key is `0600` and owned by
  root, and the runner is uid 1000, so it could never open it. The orchestrator
  stages a copy at `ssh-keys/sessions/<session-id>.key` owned by uid 1000 and
  mounts that read-only. The copy is disposable and is deleted with the
  container; the registered key is never touched.

### Reconciliation

The daemon and the database can disagree — the stack can be stopped mid-build, a
container can die unwatched. On every startup the orchestrator compares the two
and:

- removes containers whose session is `finished`, `failed` or gone;
- removes containers that are no longer running (a stopped runner cannot be
  exec'd into, so it is as good as missing);
- marks a `building` session with no running container as `failed` with the error
  **`container lost`**;
- adopts a running container onto its session, and clears a `container_id` that
  points at something that no longer exists.

If Docker cannot be reached the server still starts and changes nothing: an
unanswerable daemon is not evidence that anything is gone.

## Sessions

A session is one feature: its own container, its own clone, its own branch. The
[dashboard](#dashboard) creates one from a repository, a name, a base branch, a PR
target (`develop` or `main`) and an optional scheduled start. The name is a slug
(letters, numbers, hyphens, underscores), unique per repository, and becomes both
the feature branch **`chief/<session-name>`** and the workspace directory.

Submitting the form does four things, in order:

1. writes the session row as `pending`;
2. starts its container (see [Session containers](#session-containers));
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
  to build?" text filling chief's `{{CONTEXT}}` slot.
- **Resume planning** uses the *edit* prompt whenever `prd.md` already exists,
  exactly like `chief edit`: an existing PRD is changed, never rewritten.
- The terminal is an ordinary [browser terminal](#browser-terminals), so the
  server owns the process. Reloading the page or opening a second tab rejoins
  the same conversation; only **Close terminal** ends it.

The page also shows a live indicator for `prd.md`: whether it exists, when it
was last written, how many stories it holds, and — when it does not parse — the
parse errors with their line numbers. It is polled from the workspace on the
data volume (a `stat` plus a parse of a small markdown file), never through
Docker. The parser lives in `server/src/prd/` and follows chief's
`internal/prd/markdown.go`.

Planning is behind the same guard as session creation: Claude Code has to be
signed in once (see [Claude authentication](#claude-authentication)) before an
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

## The build loop

**Start build** turns a **ready** session into a **building** one and hands it to
the Ralph loop (`server/src/build/`) — or, when every build slot is taken, into
the [FIFO queue](#concurrency-and-the-build-queue). One iteration is:

1. Re-read `prd.md`, sync the `stories` table, and pick the story with the
   lowest priority number that is not `done`.
2. Write `**Status:** in-progress` for that story, into the file *and* the row.
3. Exec `claude --dangerously-skip-permissions --output-format stream-json --verbose -p "<prompt>"`
   in `/workspace/repo` inside the session container. The prompt is chief's
   `embed/prompt.txt`, ported verbatim into `server/src/build/templates.ts`,
   with the story inlined as JSON plus a chief-web addendum carrying the PRD's
   own context, the current `progress.md`, and what the agent has to leave
   behind: a commit `feat: US-xxx - <title>`, `**Status:** done` with the
   acceptance criteria checked off in `prd.md`, and a learnings entry appended
   to `.chief/prds/<session-name>/progress.md`.
4. Re-read `prd.md` and `git rev-parse HEAD`. A story that is `done` in the file
   is done; a HEAD that moved is recorded as that story's commit SHA. Nothing is
   taken on the agent's word.

The loop stops itself in four ways:

- **Completion.** Every story `done` hands off to the delivery step below,
  which pushes the branch and opens the pull request.
- **A stalled story.** An iteration that produces neither a status change nor a
  commit is retried twice; the third one marks the session **failed** with the
  agent's last output in `last_error`.
- **The iteration cap.** A run may take the outstanding stories plus 50%, never
  fewer than 10. A loop that is committing but never finishing anything hits it
  and fails, rather than churning forever.
- **Stop build.** The running agent is signalled (`SIGTERM`, via a pid file it
  writes inside the container) and the session goes back to **ready**.
  Everything already committed is kept, so a stopped build resumes rather than
  restarts.

A **failed** session shows the stored reason at the top of its page and can be
started again — that is what **Retry build** is. The loop resumes from `prd.md`,
so every story already marked `done` is skipped and nothing is rebuilt.

### The live log

The agent is asked for `stream-json` rather than the default text format,
because the default prints nothing until the process exits — which for one
iteration is up to an hour. Each event is rendered into a readable line as it
arrives and goes to two places at once:

- **`.chief/prds/<session-name>/agent.log`** in the workspace, next to the PRD
  and `progress.md`. The file is the log: it outlives the container, the server
  and the browser tab, and it is what the per-iteration history is read back
  from. Each iteration is delimited by
  `=== chief-web iteration <n> | <story> | <timestamp> ===` markers, and the
  clone's `.git/info/exclude` is told to ignore the file so no agent can commit
  chief-web's own log alongside its work.
- **`ws://…/api/sessions/<id>/build/log`**, the WebSocket the session page
  attaches to. Attaching replays every section written so far and then follows,
  so opening the page mid-build, reloading it, or coming back the next day all
  show the same thing. The view auto-scrolls while you are at the bottom and
  pauses as soon as you scroll up (or press **Pause scrolling**).

Detaching a watcher never touches the loop, and a log file that cannot be
written is a warning, not a failed build.

Nothing about a run is stored in memory that matters: the statuses are in
`prd.md` on the data volume, the work is in commits, and the learnings are in
`progress.md`. A server restart therefore loses at most the iteration that was
in flight — startup reconciliation marks such a session `failed` with
`container lost`.

## Push and pull request

The loop pushes the feature branch to `origin` **after every story it
completes**, so what the remote has is never more than one story behind what the
container has. Those pushes are best-effort: the commits are safe locally, so a
remote that is briefly unavailable is logged and the build carries on.

When the last story is done, `server/src/delivery/` takes over:

1. `git push --set-upstream origin <feature-branch>` once more, from **inside**
   the session container — that is where the repository's deploy key is. Never
   a force push, and never a refspec chief-web invented.
2. `POST /repos/<owner>/<repo>/pulls` with the global PAT from Settings. The
   title is the **session name**; the body lists the completed stories by id and
   title (with their short commit SHAs), names the branches, and ends with a note
   saying chief-web generated it — a link back to the session page when
   `PUBLIC_URL` is set.
3. The session becomes **finished**, the pull request URL is stored on the row,
   and the session page shows it as a link.

**An existing pull request is adopted, never duplicated.** The open pull request
for that head/base is looked up first, and GitHub's own 422 ("a pull request
already exists") is handled the same way — look again, adopt what is there.

**A failure at either step marks the session `failed`** with the underlying
reason: git's stderr, or GitHub's own message (`No commits between develop and
chief/x`, a token that cannot see the repository, …). Because every story is
already committed, there is nothing to rebuild — **Retry push & PR**
(`POST /api/sessions/<id>/delivery`) re-attempts only that step and never runs a
story again. Like session setup, it answers `200 { ok: false, … }` for a remote
failure and reserves `409` for the wrong state (still building, or a story left
outstanding).

## Scheduled starts

A session can be given a **scheduled start**: a timestamp at which chief-web
starts its build by itself, so a long run can happen overnight or off-hours. It
is set when the session is created, and set, moved or cleared afterwards from
the session page (`PUT /api/sessions/<id>/schedule`, `scheduledStartAt: null` to
clear) for as long as the session is `pending` or `ready`.

The schedule is a **column, not a timer**. `sessions.scheduled_start_at` is the
whole of it; the scheduler is only the thing that keeps looking at it, every
`SCHEDULER_INTERVAL_MS` (30 s by default, and capped there). Two things follow:

- **it survives a restart.** The first tick after boot runs before the first
  request is served and is the same query as every other tick, so anything that
  came due while the stack was down is simply due now and starts immediately;
- **nothing has to be told when a schedule changes.** The next tick reads it.

Only a `ready` session is started. A session still being planned when its moment
arrives **does not start** — chief-web never builds against a PRD it has not
parsed. The dashboard and the session page say *missed schedule — mark ready to
start*, and marking it ready then starts the build immediately, after a
confirmation that says so.

Schedules are **one-shot**. The timestamp is cleared the moment the session
enters `building` — or the build queue below, which is the same promise
honoured as far as the concurrency cap allows — whether the scheduler fired it
or someone pressed **Start build** early, so a session that is later stopped or fails can never restart
itself from a timestamp that has long passed. A fire that could not be honoured
(no container, say) clears it too and records the reason on the session, rather
than retrying every half minute for the rest of the day.

The dashboard and the session page both show the scheduled time in the visitor's
own timezone with a `starts in …` countdown, refreshed by the same three-second
poll as everything else.

## Concurrency and the build queue

Several sessions build at the same time, each in its **own container, its own
workspace and its own branch**. Nothing is shared between two sessions of the
same repository: the workspace is `workspaces/<session-id>/` (a UUID, not a
name), the container is labelled with that id, and the branch is
`chief/<session name>`, which `UNIQUE (repository_id, name)` keeps distinct.

How many may run at once is the **Max concurrent building sessions** setting
(`MAX_CONCURRENT_SESSIONS` supplies the default until a value is saved). The cap
is read on every start decision, so raising it takes effect at the next slot,
without a restart.

A start beyond the cap — pressed by hand, or fired by a schedule — is **not
refused**: the session stays `ready` with a `queued_at` timestamp and waits its
turn. `POST /api/sessions/<id>/build` answers `200` with `queued: true` and the
session's 1-based `queuePosition`; the dashboard and the session page show
*Queued (#2)*.

- **FIFO, and it survives a restart.** The order is the `queued_at` column
  ordered by timestamp then id, so it is the same order before and after a
  reboot. Nothing is spawned for a queued session, so waiting costs nothing.
- **It starts on its own.** Every run that ends — finished, stopped, failed or
  deleted — hands its slot to the head of the queue. The scheduler's tick pumps
  the queue too, which is what picks it up again after a restart, when no run of
  this process ever ended to free a slot.
- **Pressing start again does not lose your place.** The first `queued_at` is
  kept.
- **Leave queue** (`DELETE /api/sessions/<id>/queue`) takes a waiting session
  back to plain `ready` in one click. Nothing was started, so nothing is lost.
- A session that can no longer be built when its turn comes (it went back to
  planning, its stories are all done) **leaves the queue with the reason on it**
  and the next session gets the slot.

## Dashboard

The home page (and `/sessions`) is the dashboard: every session, most recently
updated first, with its repository, status badge, story progress (`4/9 done`),
feature branch, [scheduled start](#scheduled-starts) with its countdown, its
place in the [build queue](#concurrency-and-the-build-queue) if it is waiting
for a slot, and pull request link. Each row links to the
[session page](#planning), and the "New session" form lives here too, so the
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

## Claude authentication

Claude Code is signed in **once**, interactively, and every container the server
spawns shares that login: the credentials live in the named `claude-auth` Docker
volume, mounted at `~/.claude` in the runner image. Nothing is stored in the
database, and there is no API key to configure.

From **Settings → Claude Code**:

- The indicator says **Authenticated** or **Not authenticated**. It is the
  verdict of a non-interactive probe: `POST`/`GET /api/claude` runs a `--rm`
  runner container with the credentials volume mounted and reads
  `claude auth status --json`. Asking the CLI beats parsing its credential file,
  which is an internal format. The answer is cached for `CLAUDE_STATUS_CACHE_MS`
  (15s) because it costs a container start.
- **Set up Claude** (`POST /api/claude/login`) starts a temporary container named
  `chief-web-claude-login` with only that volume mounted, opens a browser
  terminal in it running `claude auth login`, and shows it inline. Follow the
  URL it prints, approve the request, and paste the code back (Ctrl+Shift+V).
- **Close login terminal** (`DELETE /api/claude/login`) kills the terminal,
  removes the container, and re-probes — so the indicator reflects the result
  immediately, with no server restart. The credentials stay in the volume and
  survive `docker compose down` (they are only lost by
  `docker volume rm chief-web-claude-auth`).
- Signing in again later (token expiry, another account) is the same button.

**Session creation is blocked while this says Not authenticated** — `POST
/api/sessions` answers `409 claude_not_authenticated` with what to do about it,
and the home page says so too. A session container whose agent cannot
authenticate would otherwise fail at its first invocation, far from the cause.
A status check that cannot run (Docker unreachable, runner image missing) also
blocks: chief-web fails closed and reports the reason.

Containers the server spawns mount the credentials **by volume name**
(`CLAUDE_AUTH_VOLUME`, default `chief-web-claude-auth`), not by path: a bind
mount of the server's own `/claude-auth` would be resolved on the host, where
that path does not exist. `docker-compose.yml` names the volume explicitly so
the name does not depend on the compose project name.

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
- **Commit author name and email** — the git identity agents commit with inside
  session containers. Blank restores the defaults (`chief-web` /
  `chief-web@localhost`), which are also baked into the runner image. Use an
  address your GitHub account owns if you want the commits linked to it.
- **Claude Code** — the one-time interactive login and its status; see
  [Claude authentication](#claude-authentication).

## Configuration

All environment variables are documented in [`.env.example`](.env.example).

## Security model

- The UI is protected by a **single shared password** (`CHIEF_WEB_PASSWORD`).
  There are no user accounts. If the variable is unset, the server generates a
  password on first boot, logs it once and persists only its scrypt hash; setting
  the variable always takes precedence over that stored hash.
- Logging in sets `chief_session`, an `HttpOnly`, `SameSite=Lax` cookie holding an
  HMAC-signed, 7-day token. Changing the password invalidates every existing
  cookie. Everything requires it except `GET /api/health`, `POST /api/auth/login`,
  the `/login` page and the static frontend bundle (which serves that page).
  Unauthenticated page loads redirect to `/login`; API calls get `401`; WebSocket
  handshakes are closed with code `4401`.
- A browser terminal is a shell inside a container with the same reach as the
  container itself, and `GET /api/containers` lists every running container on
  the host. Both are behind the shared password; the same single-operator
  assumption as the Docker socket applies.
- The `server` container mounts `/var/run/docker.sock` so it can spawn one
  container per session. **This grants the server root-equivalent control of the
  host.** This is accepted for a single-operator, self-hosted deployment; do not
  expose chief-web to untrusted users.
- The GitHub token is stored in plain text in the SQLite database, and repository
  SSH private keys in plain text on the data volume (`0600`): the server must be
  able to use both unattended, so protect the data volume rather than the values.
  Private keys never leave the server — no API response, log line or UI element
  contains one. The per-session copy a container mounts is `0400`, owned by the
  runner user, and is staged outside the workspace so it can never end up inside
  the clone or a commit. Inside the container the agent runs as that same user
  and can read the key — it has to, in order to push.
- There is no HTTPS termination. Put a reverse proxy in front if you expose it
  beyond localhost.

## Development

Requires Node.js 22+.

```sh
npm install
npm run dev          # API on :8080 (tsx watch)
npm run dev -w web   # UI on :5173, proxying /api to :8080
```

Quality checks — these must pass before every commit:

```sh
npm run typecheck
npm run lint
npm test
```

A production build (`npm run build`) compiles the server to `server/dist` and the
frontend to `web/dist`; `npm start` then serves both from a single port.
