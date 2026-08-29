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
`CHIEF_WEB_PORT` in `.env`).

Health check:

```sh
curl http://localhost:8080/api/health   # -> {"status":"ok"}
```

## Layout

```
docker-compose.yml   the whole stack: one `server` service + two named volumes
Dockerfile           multi-stage build producing the production image
server/              Node.js + TypeScript backend (API, WebSockets, orchestrator)
web/                 React + Vite frontend, served as static files by the server
```

Persistent state lives in two named Docker volumes:

| Volume       | Mount          | Contents                                      |
| ------------ | -------------- | --------------------------------------------- |
| `chief-data` | `/data`        | SQLite database, SSH deploy keys, workspaces   |
| `claude-auth`| `/claude-auth` | Claude Code credentials shared by all sessions |

## Data layer

State lives in a single SQLite database inside the data volume (`DATABASE_PATH`,
default `/data/chief-web.db`), accessed through the typed data layer in
`server/src/db`. It is built on Node's built-in `node:sqlite`, so the image needs
no native modules.

| Table          | Contents                                                           |
| -------------- | ------------------------------------------------------------------ |
| `repositories` | registered repos: name, SSH URL, GitHub slug, default base branch   |
| `sessions`     | one row per session: status, branches, schedule, container, PR, error |
| `stories`      | the stories parsed from a session's `prd.md`, with commit SHAs      |
| `settings`     | key-value configuration (GitHub PAT, concurrency limit, …)          |

Migrations in `server/src/db/migrations.ts` run automatically on server start.
They are append-only and recorded in `schema_migrations`, so restarting the stack
re-applies nothing and never touches existing data.

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
- The `server` container mounts `/var/run/docker.sock` so it can spawn one
  container per session. **This grants the server root-equivalent control of the
  host.** This is accepted for a single-operator, self-hosted deployment; do not
  expose chief-web to untrusted users.
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
