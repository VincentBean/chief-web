[← chief-web](../README.md) · [All docs](../README.md#documentation)

# Claude authentication

Claude Code is signed in **once**, interactively, and every container the server
spawns shares that login: the credentials live in the account's directory on
the data volume (`/data/claude-accounts/<id>`), mounted at `~/.claude` in the
runner image. Nothing is stored in the
database, and there is no API key to configure.

From **Settings → Claude Code**:

- The indicator says **Authenticated** or **Not authenticated**. It is the
  verdict of a non-interactive probe: `POST`/`GET /api/claude` runs a `--rm`
  runner container with the account directory mounted and reads
  `claude auth status --json`. Asking the CLI beats parsing its credential file,
  which is an internal format. The answer is cached for `CLAUDE_STATUS_CACHE_MS`
  (15s) because it costs a container start.
- **Add account** (`POST /api/claude/accounts`) creates an account and its
  directory, starts a temporary container named
  `chief-web-claude-login-<account id>` with only that directory mounted, opens
  a browser terminal in it running `claude auth login`, and shows it inline.
  Follow the URL it prints, approve the request, and paste the code back
  (Ctrl+Shift+V).
- **Sign in** again later (token expiry, another email behind the account) is
  `POST /api/claude/accounts/<id>/login`: the same flow on the existing account.
- **Close login terminal** (`DELETE /api/claude/accounts/<id>/login`) kills the
  terminal, removes the container, and re-probes that account — so the
  indicator reflects the result immediately, with no server restart. The
  credentials stay in the account directory and survive `docker compose down`.
  An account added by this login that never got signed in is deleted again, so
  an abandoned login leaves nothing behind.
- One login terminal is open at a time; starting another answers
  `409 claude_login_in_progress` with the `accountId` whose login is open.

**Session creation is blocked while this says Not authenticated** — `POST
/api/sessions` answers `409 claude_not_authenticated` with what to do about it,
and the home page says so too. A session container whose agent cannot
authenticate would otherwise fail at its first invocation, far from the cause.
A status check that cannot run (Docker unreachable, runner image missing) also
blocks: chief-web fails closed and reports the reason.

Containers the server spawns mount the account directory at its **host path**:
a bind mount of the server's own `/data/claude-accounts/<id>` would be resolved
on the host, where that path does not exist, so the server looks up the data
volume's host mountpoint and appends the relative path, exactly as it does for
session workspaces. The legacy `claude-auth` volume of an install from before
multiple accounts is mounted read-only into the server and imported once as the
first account; nothing else uses it.
