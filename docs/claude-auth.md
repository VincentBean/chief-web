[← chief-web](../README.md) · [All docs](../README.md#documentation)

# Claude authentication

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
