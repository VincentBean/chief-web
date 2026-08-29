# chief-web

Self-hosted web version of [chief](https://github.com/minicodemonkey/chief), the
autonomous PRD-driven coding agent. You plan a PRD in a browser terminal running
Claude Code, then chief-web runs the Ralph Wiggum loop — one fresh agent
invocation per user story, one commit per story — on an isolated feature branch
inside a dedicated Docker container, and opens a pull request when it is done.

Installation requires nothing but Docker.

**New here?** [Prerequisites](#prerequisites) → [Setup](#setup) →
[Your first session](#your-first-session) → [Architecture](#architecture) →
[Troubleshooting](#troubleshooting).

## Prerequisites

- **Docker Engine 24+ with the Compose v2 plugin.** Check with
  `docker --version` and `docker compose version` — if the second one prints
  usage instead of a version, you have the old `docker-compose` binary and need
  the plugin. Docker Desktop (macOS/Windows) and Docker Engine (Linux) both ship
  it.
- **Access to the Docker socket**, because chief-web starts a container per
  session (see [Architecture](#architecture)). On Linux that means your user is
  in the `docker` group or you run compose with `sudo`. Rootless Docker works
  too, but its socket is elsewhere (`$XDG_RUNTIME_DIR/docker.sock`), so both the
  bind mount in `docker-compose.yml` and `DOCKER_SOCKET` have to point at it.
- **A GitHub account with admin rights on the repositories you want worked on** —
  you need to add a deploy key to each of them, and a personal access token that
  may open pull requests.
- **A Claude account you can sign into interactively** (a Claude Pro/Max
  subscription or Anthropic Console credentials). There is no API key to paste:
  Claude Code is signed in once, in a browser terminal, and the credentials are
  reused by every session.
- **Outbound network** to `github.com` over SSH (port 22) and to
  `api.github.com` and Anthropic over HTTPS.
- **A couple of GB of disk** for the two images, plus a full clone per session
  on the data volume, and enough RAM for the sessions you run at once — each one
  is a container running an agent and, usually, your test suite.

Nothing else is needed on the host: git, Node.js and the Claude Code CLI all
live inside the images.

## Quick start

```sh
cp .env.example .env      # set CHIEF_WEB_PASSWORD
docker compose up --build
```

The UI is then available on <http://localhost:8080> (change the host port with
`CHIEF_WEB_PORT` in `.env`). First-run setup is completed in the browser: log in
with the password, add a GitHub token and repositories, and sign Claude Code in
once from **Settings → Set up Claude**. [Setup](#setup) walks through all of it
step by step.

Health check:

```sh
curl http://localhost:8080/api/health   # -> {"status":"ok"}
```

## Setup

Six steps from a clean host to a repository chief-web can build. Steps 1–3 are
the terminal; 4–6 are the browser and take a couple of minutes.

### 1. Configure `.env`

```sh
git clone https://github.com/<you>/chief-web.git
cd chief-web
cp .env.example .env
```

Every value has a working default; the one worth setting by hand is the
password protecting the whole UI:

```ini
CHIEF_WEB_PASSWORD=a-long-random-passphrase
CHIEF_WEB_PORT=8080          # host port; the container always listens on 8080
```

If you leave `CHIEF_WEB_PASSWORD` empty the server generates a password on first
boot and logs it exactly once (`docker compose logs server | grep -i password`).
Setting the variable later always wins over that generated one.

Two more are worth a look now; the rest are documented in
[`.env.example`](.env.example) and can wait:

```ini
PUBLIC_URL=https://chief.example.com   # only used to link a PR back to its session
MAX_CONCURRENT_SESSIONS=3              # default build concurrency (changeable in the UI)
```

### 2. Start the stack

```sh
docker compose up --build
```

This builds **two** images — the server (`chief-web:latest`) and the runner
(`chief-web-runner:latest`, the image every session container runs) — and starts
only the server. The first build takes a few minutes. Add `-d` to run it in the
background; `docker compose logs -f server` follows the logs afterwards.

Check it is up:

```sh
curl http://localhost:8080/api/health    # -> {"status":"ok"}
```

### 3. First login

Open <http://localhost:8080>. Every page redirects to `/login` until you are
signed in; enter the password from step 1. There are no user accounts — the
password *is* the operator — and the session cookie lasts 7 days.

The home page is the [dashboard](#dashboard), and it is the hub: links to
**Repositories**, **Settings**, **Terminals** and **Log out** are in its header,
and every other page links back to it. It also says what is still missing — no
repository yet, Claude Code not authenticated — which is steps 4–6.

### 4. Add a GitHub token

chief-web opens pull requests with a **GitHub Personal Access Token**. Create
one at <https://github.com/settings/tokens>, in either flavour:

| Token type | Where | What to grant |
| --- | --- | --- |
| **Classic PAT** | Settings → Developer settings → Personal access tokens → **Tokens (classic)** | the **`repo`** scope (that whole checkbox; it covers private repositories and pull requests) |
| **Fine-grained token** | … → **Fine-grained tokens** | *Repository access*: the repositories chief-web will work on. *Repository permissions*: **Contents: Read and write** and **Pull requests: Read and write** |

Prefer the fine-grained token: it can be limited to the repositories you
actually hand to chief-web. If those repositories belong to an organisation, a
fine-grained token has to be approved by an org owner before it works.

Give it an expiry you are willing to renew — an expired token fails at the very
last step of a session, when the pull request is opened
([troubleshooting](#recovering-a-failed-session)).

Then in chief-web: **Settings → GitHub Personal Access Token**, paste, **Save**,
then press **Validate**. Validate calls `GET https://api.github.com/user` and
shows the account the token authenticates as, so a typo is caught here rather
than at the end of a build. The token is write-only from then on: the UI only
ever shows whether one is stored plus its last four characters.

The token opens pull requests. It is *not* how sessions push code — that is the
per-repository deploy key in the next step.

### 5. Add a repository and its deploy key

Go to **Repositories → Add repository**:

| Field | Value |
| --- | --- |
| **Name** | how it appears in chief-web |
| **SSH URL** | `git@github.com:owner/repo.git` — SSH, not HTTPS |
| **GitHub slug** | `owner/repo`, derived from the URL; override it only for an unusual remote |
| **Default base branch** | what sessions branch from by default (`main`, `develop`, …) |
| **SSH key** | leave **Generate a new ed25519 keypair** selected |

Save. chief-web generates the keypair and shows you the **public** half under
**Deploy key**, with a **Copy public key** button and a link straight to the
right GitHub page.

On GitHub, go to `https://github.com/<owner>/<repo>/settings/keys/new`, paste the
key, give it a title (`chief-web`), and — this is the part everyone forgets —
**tick "Allow write access"**. Sessions push their feature branch with this key;
a read-only deploy key clones fine and then fails at the first push.

Back in chief-web, press **Test connection**. It runs `git ls-remote` in a
short-lived runner container using that key and reports either success or git's
own stderr. Do not skip it: it turns a mistake here into one line of output now
instead of a failed session later.

If you would rather use a key you already have, pick **Paste an existing private
key** instead. It must be **unencrypted** — a session container has no way to
answer a passphrase prompt. The private half never leaves the server: it is
stored `0600` on the data volume and is never returned by the API, shown in the
UI, or written to a log.

Repeat for every repository you want chief-web to work on. Each gets its own
key.

### 6. Sign Claude Code in

Go to **Settings → Claude Code** and press **Set up Claude**. chief-web starts a
temporary container with only the credentials volume mounted, runs
`claude auth login` in it, and shows the terminal inline:

1. Select the URL it prints, copy it with **Ctrl+Shift+C**, and open it in a
   new tab.
2. Approve the request in your browser and copy the code Claude gives you back.
3. Paste it into the terminal with **Ctrl+Shift+V** and press Enter.
4. Press **Close login terminal**.

The indicator flips to **Authenticated** immediately — closing the terminal
removes the container and re-probes. The credentials live in the named
`chief-web-claude-auth` volume and are shared by every session container, so
this is a one-time step that survives `docker compose down` and restarts.

**Creating or planning a session is blocked until this says Authenticated**, on
purpose: an agent that cannot authenticate would otherwise fail on its first
invocation, a long way from the cause.

Setup is done. Everything after this is per session.

## Your first session

One session is one feature: its own container, its own clone, its own branch,
one pull request at the end. Here it is end to end.

### 1. Create the session

On the dashboard, open **New session**:

| Field | Notes |
| --- | --- |
| **Repository** | one you registered in [step 5](#5-add-a-repository-and-its-deploy-key) |
| **Session name** | a slug (`letters-numbers-hyphens`), unique per repository. It becomes the feature branch **`chief/<name>`** and the workspace directory — so name it after the feature: `rate-limiting`, not `test1` |
| **Base branch** | what to branch from; defaults to the repository's |
| **PR target branch** | where the pull request will be opened (`develop` or `main`) |
| **Scheduled start** | optional — see [Scheduled starts](#scheduled-starts) |

**Create session** starts the container, checks that `chief/<name>` does not
already exist on `origin`, clones the base branch and creates the feature
branch. That takes a few seconds on a small repository. If it fails — bad key,
missing base branch, unreachable remote — the session stays **pending** with
git's own stderr on screen and a **Retry setup** button; fix the cause and press
it, and the existing clone is reused.

### 2. Plan the PRD

The session page (`/sessions/<id>`) opens on a browser terminal running Claude
Code **inside the session's container**, in the clone. Press **Start planning**,
optionally filling in the "What do you want to build?" box first — a paragraph
of context is plenty.

This is `chief new` in a browser. Claude asks 3–5 clarifying questions with
lettered options; answer them the compact way (`1A, 2C, 3B`) or in prose. It
then writes `.chief/prds/<session-name>/prd.md`: a numbered list of user stories
with a status, a priority and acceptance criteria.

- The panel above the terminal shows whether `prd.md` exists, when it was last
  written and how many stories it holds. It polls the workspace, so it updates
  on its own as Claude writes.
- The terminal belongs to the server, not to the tab. Reload the page, close the
  laptop, come back tomorrow — **Resume planning** rejoins the same
  conversation. Only **Close terminal** ends it.
- Reopening planning on a session that already has a PRD uses the *edit* prompt,
  so an existing PRD is amended, never rewritten.

Read the PRD before you go on. Stories that are too big are the single most
common reason a build stalls: one story should be one commit's worth of work.
You can ask Claude to split, merge, reorder or reprioritise them right in the
same conversation.

### 3. Mark it ready

Press **Mark ready**. chief-web parses `prd.md` and only promotes the session
from **pending** to **ready** if the whole file is usable — nothing is ever built
against a PRD it cannot read. The stories then appear on the page with their id,
title, priority and status.

If the file does not parse, the session stays pending and you get the specific
errors with line numbers (an unknown status, a duplicated story id, a story with
no acceptance criteria). Fix them the same way you wrote them: **Resume
planning** and tell Claude what to correct.

**Back to planning** returns a ready session to pending whenever you want to
change the PRD again.

### 4. Build

Press **Start build**. From here it is autonomous. Each iteration:

1. picks the lowest-priority-number story that is not `done`;
2. marks it `in-progress` in `prd.md`;
3. runs one fresh headless `claude -p` on it inside the container;
4. verifies the result against the world — did the story's status change, did
   `git rev-parse HEAD` move — never against what the agent claims.

Watch it in the **live log** on the session page. It streams from the agent as
it works and is also written to `.chief/prds/<session-name>/agent.log` in the
workspace, so the history is there after a reload, a restart, or a week later.
The story list updates as stories are completed, and the feature branch is
pushed to `origin` **after every completed story** — so what the remote has is
never more than one story behind.

While it runs you can:

- **Stop build** — signals the agent and returns the session to **ready**.
  Everything already committed stays, so pressing **Start build** again resumes
  rather than restarts.
- Open a [browser terminal](#browser-terminals) into the same container to look
  around while the agent works.
- Leave. Nothing depends on the tab being open, and if all the build slots are
  taken the session waits in a [FIFO queue](#concurrency-and-the-build-queue)
  and starts by itself.

Expect a build to take from minutes to hours depending on the PRD. The default
budget is 30 minutes per story iteration (**Settings → Agent timeout**), two
retries for a story that makes no progress, and an overall iteration cap of the
outstanding stories plus 50%.

### 5. Push and pull request

When the last story is `done`, chief-web pushes the branch once more and opens
the pull request itself:

- **title**: the session name;
- **body**: the completed stories by id and title with their short commit SHAs,
  the branches involved, and a link back to the session page when `PUBLIC_URL`
  is set;
- **base**: the PR target branch you chose.

The session becomes **finished** and the pull request URL appears on both the
session page and the dashboard. An open pull request for the same head/base is
adopted rather than duplicated, so this is safe to retry.

If the push or the PR fails — expired token, protected branch, no commits — the
session goes **failed** at the `push` or `pull_request` stage with the underlying
message, and **Retry push & PR** re-attempts *only* that step. No story is ever
rebuilt.

### 6. Review and merge

Review the pull request like any other. It is ordinary git: the branch is
`chief/<session-name>`, one commit per story, and the PRD, the progress notes
and the agent log are in `.chief/prds/<session-name>/` in the workspace (the
agent commits the PRD and progress file; the log is excluded from commits).

Needs another round? The session is finished, but the workspace and branch are
still there: open a new session for the follow-up work, or push commits of your
own. Merge, and you have gone from zero to a merged PR.

When you no longer need it, **Delete** removes the container, the workspace and
the row. **It never touches the remote** — the branch and the pull request are
the output of the session and outlive it.

## Architecture

```
docker-compose.yml   the whole stack: the `server` service, the `runner` image
                     and its two named volumes
Dockerfile           multi-stage build producing the production server image
runner/              Dockerfile for the image every session container runs
server/              Node.js + TypeScript backend (API, WebSockets, orchestrator)
web/                 React + Vite frontend, served as static files by the server
```

### One container per session

The `server` container never runs an agent. It is a Node process that serves the
UI and the API and **spawns one container per session** from the runner image,
through the Docker socket:

```
      browser
         │  HTTP + WebSocket
   ┌─────▼──────────────────────────┐        ┌──────────────────────────┐
   │ server (chief-web:latest)      │ Docker │ session container        │
   │  API · orchestrator · build    │ socket │  claude · git · node     │
   │  loop · SQLite · deploy keys   ├───────▶│  /workspace = its clone  │
   └────────────────────────────────┘        └──────────────────────────┘
         │                                    (one per session, plus
         └── /data, /claude-auth               short-lived helpers)
```

Each session container gets the repository's deploy key, its own clone at
`/workspace/repo` and its own branch, and is labelled
`chief-web.session=<session-id>` — the only durable link between a database row
and a container, and what `docker ps --filter label=chief-web.session` lists.

Why a container per session, rather than one shared workspace:

- **Isolation.** Sessions of the same repository never see each other's working
  tree, branch, dependencies or half-finished edits, so several can build at
  once ([concurrency](#concurrency-and-the-build-queue)).
- **Blast radius.** The agent runs with
  `--dangerously-skip-permissions`, so it must not be able to touch the host or
  another session. It runs as an unprivileged user (uid 1000) in a container
  with no published ports and nothing mounted but its own workspace, the shared
  credentials and one key.
- **Recoverability.** The container is disposable; the *workspace* is the state.
  A lost container is replaced over the same clone and the build resumes.

Short-lived containers are started the same way for the repository connection
test, the Claude auth probe and the Claude login. Details:
[Session containers](#session-containers), [Runner image](#runner-image).

### Volumes

Everything that must survive a restart is in **two named Docker volumes** — the
containers themselves hold nothing you would miss:

| Volume                  | Mounted in server at | Contents                                                          |
| ----------------------- | -------------------- | ----------------------------------------------------------------- |
| `chief-web-data`        | `/data`              | the SQLite database, the per-repository SSH deploy keys, and one workspace (clone + `.chief/` state) per session |
| `chief-web-claude-auth` | `/claude-auth`       | the Claude Code credentials, shared by every session container     |

Both are named explicitly (`CHIEF_DATA_VOLUME`, `CLAUDE_AUTH_VOLUME`) rather
than carrying the compose project prefix, because the server passes those names
to the Docker socket when it spawns containers. A container mounts the
credentials volume **by name**; its own workspace is a *subdirectory* of the data
volume, which a name cannot express, so the server looks the volume's host
mountpoint up once and bind-mounts the subdirectory — bind sources are always
resolved on the host.

`docker compose down` keeps both volumes. `docker compose down -v` destroys
them: every session, every workspace, every deploy key and the Claude login.
Backing chief-web up means backing up `chief-web-data`.

### The Docker socket, and what it costs

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

The server needs the socket because spawning, exec'ing into and removing session
containers *is* what chief-web does. There is no way to do it without.

**This grants the server container root-equivalent control of the host.** A
process that can talk to the Docker socket can start a privileged container that
mounts `/`, so it is not meaningfully weaker than root on the machine — the
container boundary around the server is not a security boundary against the
server itself. What follows from that:

- **Anyone with the chief-web password effectively has root on the host.** The
  browser terminal is a shell inside a container of their choosing, and
  `GET /api/containers` lists every running container on the host. Treat the
  shared password as a root password: long, random, and never reused.
- **Do not put chief-web on a machine you share with people you would not give
  root to**, and do not expose it to the public internet. It is designed for a
  single operator on their own host or VM.
- **There is no HTTPS termination.** If it must be reachable beyond localhost,
  put a reverse proxy with TLS (and, ideally, your own auth) in front of it, or
  reach it over a VPN or an SSH tunnel.
- **The agent itself runs unprivileged**, in a container that has no access to
  the socket — only the server does. Nothing chief-web starts gives an agent the
  host.

The rest of the threat model — where the token and the keys are stored, what the
cookie is, what a terminal can reach — is in [Security model](#security-model).

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
- **An iteration that runs out of time.** One headless `claude -p` may run for
  **30 minutes** by default, configurable per iteration on the settings page
  (1–720 minutes). An iteration cut short counts as a failed attempt exactly
  like a stalled one — even if it committed something — so the same two retries
  apply and the third failure ends the run.
- **The iteration cap.** A run may take the outstanding stories plus 50%, never
  fewer than 10. A loop that is committing but never finishing anything hits it
  and fails, rather than churning forever.
- **Stop build.** The running agent is signalled (`SIGTERM`, via a pid file it
  writes inside the container) and the session goes back to **ready**.
  Everything already committed is kept, so a stopped build resumes rather than
  restarts.

A **failed** session shows the stored reason at the top of its page, along with
the **stage** it failed at, and one **Retry** button. See
[Failure and recovery](#failure-and-recovery).

### The live log

The agent is asked for `stream-json` rather than the default text format,
because the default prints nothing until the process exits — which for one
iteration is up to half an hour by default. Each event is rendered into a readable line as it
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
in flight — startup reconciliation marks such a session `failed` at the
`container_lost` stage, and retrying it starts a fresh container on the very
same workspace.

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
chief/x`, a token that cannot see the repository, …) — at the `push` or
`pull_request` stage respectively. Because every story is already committed,
there is nothing to rebuild: **Retry push & PR**
(`POST /api/sessions/<id>/delivery`) re-attempts only that step and never runs a
story again. Like session setup, it answers `200 { ok: false, … }` for a remote
failure and reserves `409` for the wrong state (still building, or a story left
outstanding).

## Failure and recovery

Every path that ends in **failed** stores two things on the session: a
human-readable `last_error`, and the **stage** it failed at.

| Stage | What failed | What a retry does |
| --- | --- | --- |
| `agent` | An iteration stalled, ran out of time, or could not be run at all | Restarts the loop at the first story that is not `done` |
| `prd` | `prd.md` can no longer be read, so nothing knows what is done | Same, once the file parses again |
| `container_lost` | The session container disappeared mid-build (found by startup reconciliation) | Starts a **fresh container on the same workspace** and resumes |
| `push` | `git push` of the feature branch | Re-runs the push and the pull request only |
| `pull_request` | Opening the pull request at GitHub | Same — an open pull request is adopted, never duplicated |

A **clone or setup failure is deliberately not one of these**: it leaves the
session `pending` with the reason on it and a **Retry setup** action, because
there is nothing to resume yet.

`POST /api/sessions/<id>/retry` is the one endpoint over both recoveries — it
reads the stage and dispatches, so the UI never has to guess — and
`GET /api/sessions/<id>/retry` answers with what it *would* do, which is what
labels the button. Only the half that runs an agent is behind the Claude Code
guard: a session whose push failed has nothing left to build, so its recovery is
not blocked on credentials it does not use. Neither path redoes work: everything
already committed stays committed, and every story `prd.md` calls `done` is
skipped.

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
- **Agent timeout (minutes per iteration)** — how long one headless `claude -p`
  may run on a single story, 1–720 minutes, default 30. It is read at the start
  of every iteration, so a change applies to the next one with no restart, and
  an iteration that runs out of time counts as a failed attempt toward the two
  retries. `BUILD_ITERATION_TIMEOUT_MS` only supplies the default.
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

## Troubleshooting

Most failures show the underlying command's own output on the session or
repository page — read that first; the sections below are what the common ones
mean. Server-side detail is in `docker compose logs -f server`, and
`LOG_LEVEL=debug` in `.env` turns up the volume.

### A clone or push fails over SSH

Symptoms: **Test connection** fails, or a new session stays **pending** with a
setup error, or a build fails at the `push` stage. The message is git's own
stderr.

| What you see | What it means |
| --- | --- |
| `Permission denied (publickey)` | The deploy key is not on the repository, or you added a *different* key. Compare the fingerprint shown on the Repositories page with the one on `github.com/<owner>/<repo>/settings/keys`. |
| Clone works, **push** is rejected (`remote: Write access to repository not granted`) | The classic one: the deploy key was added **without "Allow write access"**. Tick it on GitHub — the key does not have to be replaced. |
| `Repository not found` / `Could not read from remote repository` | Wrong slug or wrong URL. It must be the SSH form, `git@github.com:owner/repo.git`, not `https://…`. |
| `Load key … error in libcrypto` or an interactive passphrase prompt | You pasted a **passphrase-protected** private key. A container cannot answer the prompt; import an unencrypted key or let chief-web generate one. |
| `Host key verification failed` | A non-GitHub remote whose host key changed. github.com's keys are pinned in the runner image; other hosts use `accept-new`. |
| The step times out on a very large repository | Raise `SESSION_SETUP_TIMEOUT_MS` (clone/checkout) or `PUSH_TIMEOUT_MS` in `.env` and restart the stack. |
| `Connection timed out` on port 22 | The host blocks outbound SSH. |

Always re-run **Test connection** after a fix: it is the same key and the same
container the session will use, so a green result there means the session will
clone.

A repository whose key is listed as `missing — edit and paste a private key` lost
its key file (a restored backup that skipped the data volume, usually). Edit the
repository, generate a new keypair, and add the new public key on GitHub.

### Claude says "Not authenticated"

The indicator on **Settings → Claude Code** is the verdict of a real
`claude auth status` run in a container, so it is the truth, not a cached guess.
Session creation, planning and any retry that runs an agent are blocked while it
says this — deliberately, so you find out here instead of two hours into a
build.

- **Credentials expired**, or you signed the account out elsewhere: press **Set
  up Claude** again and repeat the login. It is the same flow as first-time
  setup, and it replaces what is in the volume. Nothing else has to be restarted;
  sessions already running pick the new credentials up on their next iteration,
  because the volume is mounted live.
- **A build failed mid-run with an auth error**: re-authenticate, then press
  **Retry** on the session. Completed stories are not rebuilt.
- **It says Not authenticated with an error next to it** (`docker: …`, `image
  not found`, a timeout): the *probe* could not run. chief-web fails closed — an
  unanswerable check is not a pass. Usually the runner image is missing
  (`docker compose build runner`) or the Docker socket is unreachable. Fix that
  and press **Re-check**.
- **The login terminal shows nothing**: the login container did not start. Check
  `docker compose logs server` and that `RUNNER_IMAGE` exists locally
  (`docker image ls chief-web-runner`).
- The status is cached for 15 seconds (`CLAUDE_STATUS_CACHE_MS`) because each
  probe costs a container start; **Re-check** ignores the cache.

The credentials survive `docker compose down` and restarts. They are lost only
by removing the volume (`docker volume rm chief-web-claude-auth`), which is what
a `docker compose down -v` does.

### Recovering a failed session

A **failed** session shows the reason at the top of its page, a **stage** badge
saying where it broke, and one **Retry** button whose label tells you what it
will do. Nothing already committed is ever redone: every story `prd.md` calls
`done` is skipped.

| Stage | Usual cause | What **Retry** does | What to fix first |
| --- | --- | --- | --- |
| `agent` | A story stalled three times, or an iteration ran out of time | Restarts the loop at the first story that is not `done` | Read the tail of the live log. A story too big for one iteration should be split (**Back to planning**); a slow test suite may just need a bigger **Agent timeout** in Settings |
| `prd` | `prd.md` no longer parses — usually an agent mangled the file | Same, once it parses again | Open the session's terminal (or **Back to planning**) and fix the file; the errors name the lines |
| `container_lost` | The container died or the stack was restarted mid-build | Starts a **fresh container on the same workspace** and resumes | Nothing, normally — just retry. If it recurs, check `docker compose logs` and the host's memory |
| `push` | Deploy key without write access, protected branch, network | Re-runs the push and the pull request only | See [SSH failures](#a-clone-or-push-fails-over-ssh) |
| `pull_request` | Expired/insufficient GitHub token, no commits between the branches, org approval missing | Same — an existing PR is adopted, never duplicated | Re-check the token on Settings with **Validate** ([token setup](#4-add-a-github-token)) |

Notes that save time:

- **A failed *setup* is not a failed session.** A clone that fails leaves the
  session **pending** with a **Retry setup** button, because there is nothing to
  resume yet.
- **A retry after a `push`/`pull_request` failure does not need Claude.** Only
  the half that runs an agent is behind the auth guard.
- **Work is never lost by a failure.** The commits are in the clone on the data
  volume and, for every completed story, already on `origin`. Even deleting the
  session leaves the remote branch and the pull request untouched.
- **If a retry keeps failing the same way**, stop retrying and look at the
  workspace: open a browser terminal into the session's container and run `git
  status`, `git log --oneline` and your test suite by hand. It is an ordinary
  clone.
- **After a host reboot or `docker compose up` following a crash**, startup
  reconciliation compares the database with the daemon: containers whose session
  is gone are removed, and a `building` session with no container is marked
  failed at `container_lost`. If Docker is unreachable at boot the server starts
  and changes nothing, on purpose — retry once the daemon is back.

### The stack itself

| Symptom | Check |
| --- | --- |
| `/api/health` does not answer | `docker compose ps` and `docker compose logs server`. Port already in use → change `CHIEF_WEB_PORT`. |
| The login page rejects your password | If `CHIEF_WEB_PASSWORD` is set in `.env` it always wins, but only after a `docker compose up -d` that recreates the container. Otherwise grep the logs for the generated one. |
| Every request bounces to `/login` | The cookie is `HttpOnly` and 7 days; changing the password invalidates all of them. |
| `permission denied … /var/run/docker.sock` in the logs | The host user running compose is not in the `docker` group. |
| Sessions never start, all say *Queued* | The concurrency cap. Raise **Max concurrent building sessions** in Settings; it takes effect at the next free slot with no restart. |
| Disk filling up | Each session keeps a full clone under the data volume. Delete finished sessions — the branch and PR on GitHub survive it. |

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
