[← chief-web](../README.md) · [All docs](../README.md#documentation)

# Claude authentication

Claude Code is signed in **once**, interactively, and every container the server
spawns shares that login: the credentials live in the account's directory on
the data volume (`/data/claude-accounts/<id>`), mounted at `~/.claude` in the
runner image. Nothing is stored in the
database, and there is no API key to configure.

From **Settings → Claude Code**:

- The indicator says **Authenticated** or **Not authenticated**. It is the
  verdict of a non-interactive probe: `GET /api/claude` runs, for every
  account, a `--rm` runner container with that account's directory mounted and
  reads `claude auth status --json` (at most 3 probe containers at once).
  Asking the CLI beats parsing its credential file, which is an internal format.
  Each account's answer is cached for `CLAUDE_STATUS_CACHE_MS` (15s) because it
  costs a container start, and a successful probe writes the account's email,
  organization, subscription and auth method onto its row (a probe that says
  "signed out" clears the auth method again). The response is
  `{ accounts: [{ id, nickname, email, organization, subscription,
  authenticated, error, checkedAt, usage }], defaultAccountId,
  defaultIsExplicit, login }`.
- Sessions are blocked (409 `claude_not_authenticated`) only while **no**
  account is signed in.
- **Add account** (`POST /api/claude/accounts`) creates an account and its
  directory, starts a temporary container named
  `chief-web-claude-login-<account id>` with only that directory mounted, opens
  a browser terminal in it running `claude auth login`, and shows it inline.
  Follow the URL it prints, approve the request, and paste the code back
  (Ctrl+Shift+V).
- **Sign in again** later (token expiry, another email behind the account) is
  `POST /api/claude/accounts/<id>/login`: the same flow on the existing account.
- **Close login terminal** (`DELETE /api/claude/accounts/<id>/login`) kills the
  terminal, removes the container, and re-probes that account — so the
  indicator reflects the result immediately, with no server restart. The
  credentials stay in the account directory and survive `docker compose down`.
  An account added by this login that never got signed in is deleted again, so
  an abandoned login leaves nothing behind.
- One login terminal is open at a time; starting another answers
  `409 claude_login_in_progress` with the `accountId` whose login is open.

The panel lists one row per account: a status dot, the nickname (or the email),
email, organization and subscription, the 5-hour and 7-day usage with when each
resets, and a **Default** badge on the default account. An account that is not
signed in stays listed until it is removed; one whose probe failed shows the
error and **Check again**. Per row:

- **Rename** — `PATCH /api/claude/accounts/<id> { nickname }`; blank clears the
  nickname, so the email shows again.
- **Make default** — `POST /api/claude/accounts/<id>/default` stores the
  `default_claude_account_id` setting, also readable and writable as
  `defaultClaudeAccountId` on `GET/PATCH /api/settings` (an id that is no
  account → `400 claude_account_not_found`; `null` clears it). Without it the
  default is the signed-in account with the lowest position (else the first
  account), shown as **Default (automatic)**; `defaultIsExplicit` on
  `GET /api/claude` says which. The account imported from the legacy volume
  is made the explicit default.
- **Check again** — `POST /api/claude/accounts/<id>/check` re-probes one account.
- **Remove** — asks first, naming how many sessions and recurring tasks are
  bound to the account (`GET /api/claude/accounts/<id>/bindings`), then
  `DELETE /api/claude/accounts/<id>`: `409 account_is_default` while it is the
  default and another account exists (make another one the default first; the
  last account can always go), `409 account_in_use` while a session or PR-run
  container labelled `chief-web.claude-account=<id>` is running, otherwise the
  row, its directory and every reference to it (sessions, recurring tasks,
  account settings, which fall back to the default) are deleted → `204`.

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

**Which account a session runs on.** A session stores `claudeAccountId`
(`null` = follow the default); `GET /api/sessions[/<id>]` also returns
`effectiveClaudeAccountId`, the account its next container mounts. `POST
/api/sessions` and `PATCH /api/sessions/<id>/account { claudeAccountId }`
answer `400 claude_account_unknown` for an id that names no account and `409
claude_account_not_authenticated` for one that is not signed in; the PATCH is
refused (`409 claude_account_locked`) once the session is finished or merged,
like the thinking effort. Session containers carry the label
`chief-web.claude-account=<id>`. When a session's effective account changes
(a PATCH, or a new default for a session that follows it) its running container
is left alone until the next launch of agent work — a build iteration, a
planning terminal, a review or a description — which recreates it on the new
account; the iteration already running is never interrupted.

**Automated work.** Every other launcher has its own choice, `null` meaning
the default account: a recurring task stores `claudeAccountId` (passed to each
run it creates); Settings → GitHub's “Account for PR review, feedback and
conflict fixes” (`prAutomationClaudeAccountId`, setting
`pr_automation_claude_account_id`) is what PR review, PR feedback and conflict
fix containers mount; Settings → Sentry's “Account for Sentry fixes”
(`sentryClaudeAccountId`, setting `sentry_claude_account_id`) is passed to the
fix sessions and also used for the Sentry planning container. Sessions created
by voice name no account and follow the default. Removing an account clears
every task and setting that named it, so that work falls back to the default.

**Plan usage and token refresh.** Every account's 5-hour and 7-day usage is
read from Anthropic's usage endpoint (`GET /api/oauth/usage`) with the OAuth
access token in the account's `.credentials.json`, by a background ticker
(`server/src/claude/usage.ts`) that caches each answer for
`CLAUDE_USAGE_CACHE_MS` (default 60 s). `GET /api/claude` carries it per
account and `GET /api/stats` as `accounts: [{ id, usage, holdUntil }]`. An
API-key or console login has no plan windows; those read as `null`. The same
ticker refreshes any token that expires within ten minutes by letting the CLI
refresh it itself in a `--rm` runner container (`claude auth status --json`,
then one `claude -p "ok" --model haiku` if the token is still expired). Only
when the refresh token is gone, or the refresh leaves the token expired, does
the account read “sign in again” in Settings and the sidebar.
