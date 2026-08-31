[← chief-web](../README.md) · [All docs](../README.md#documentation)

# Architecture

```
docker-compose.yml   the whole stack: the `server` service, the `runner` image
                     and its two named volumes
Dockerfile           multi-stage build producing the production server image
runner/              Dockerfile for the image every session container runs
server/              Node.js + TypeScript backend (API, WebSockets, orchestrator)
web/                 React + Vite frontend, served as static files by the server
```

## One container per session

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
  once ([concurrency](scheduling.md#concurrency-and-the-build-queue)).
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

## Volumes

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

## The Docker socket, and what it costs

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
cookie is, what a terminal can reach — is in [Security model](security.md).

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
- marks a `building` or `waiting` session with no running container as `failed`
  with the error **`container lost`**;
- adopts a running container onto its session, and clears a `container_id` that
  points at something that no longer exists.

If Docker cannot be reached the server still starts and changes nothing: an
unanswerable daemon is not evidence that anything is gone.
