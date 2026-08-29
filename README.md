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
                     and two named volumes
Dockerfile           multi-stage build producing the production server image
runner/              Dockerfile for the image every session container runs
server/              Node.js + TypeScript backend (API, WebSockets, orchestrator)
web/                 React + Vite frontend, served as static files by the server
```

Persistent state lives in two named Docker volumes:

| Volume                   | Mount          | Contents                                      |
| ------------------------ | -------------- | --------------------------------------------- |
| `chief-data`             | `/data`        | SQLite database, SSH deploy keys, workspaces   |
| `chief-web-claude-auth`  | `/claude-auth` | Claude Code credentials shared by all sessions |

The credentials volume is named explicitly (`CLAUDE_AUTH_VOLUME`) rather than
carrying the compose project prefix, because the server passes that name to
`docker run` when it spawns containers.

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
  contains one.
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
