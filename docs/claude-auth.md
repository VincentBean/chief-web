[← chief-web](../README.md) · [All docs](../README.md#documentation)

# Claude authentication

chief-web runs Claude Code on one or more **Claude accounts**. Each account is a
Claude Code login of its own — a Pro/Max subscription or an Anthropic Console
login — signed in interactively from **Settings → Claude Code**. There is no
API key to configure.

Every container the server spawns (sessions, PR runs, the login and status
probes) mounts exactly **one** account's credentials at `~/.claude` in the
runner image. Which account that is depends on the work: a session's own choice,
the PR-automation or Sentry account, a default you pinned, or — when none of
those is set, which is the normal case — the account chief-web
[chooses automatically](#automatic-choice). While an account is held by its
usage limit, work pinned to it [fails over](#failover) to another.

## Where accounts live

An account is two things that are always created and removed together:

- a row in the `claude_accounts` table: its id (16 hex characters), an optional
  nickname, its position in the list, and the email, organization,
  subscription and auth method the last successful status probe reported;
- a directory `DATA_DIR/claude-accounts/<id>` (`/data/claude-accounts/<id>` in
  Docker), mode `0700` and owned by the runner user, holding the CLI's own
  files (`.credentials.json` and the rest of `~/.claude`). chief-web never
  writes the credentials itself; the CLI does, during the login and every
  token refresh.

Both live on the data volume, so they survive restarts and
`docker compose down`, and backing up `chief-web-data` backs up every login.

Containers mount the account directory at its **host path**: a bind mount of
the server's own `/data/claude-accounts/<id>` would be resolved on the host,
where that path does not exist, so the server looks up the data volume's host
mountpoint and appends the relative path, exactly as it does for session
workspaces. Session and PR-run containers carry the label
`chief-web.claude-account=<id>`.

## Managing accounts

**Settings → Claude Code** (`/settings#claude`) lists one row per account: a
status dot, the nickname (or the email), email, organization and subscription,
and the 5-hour and 7-day usage with when each window resets. With a default
pinned, that row carries a **Default** badge and the panel offers **Choose
automatically**; without one, the panel explains the
[automatic choice](#automatic-choice) and the account it would start new work
on right now carries **Next up**. An account that is not signed in stays listed
until it is removed; one whose probe failed shows the error and **Check
again**.

### Add an account

**Add account** (`POST /api/claude/accounts`) creates the row and its
directory, starts a temporary container named
`chief-web-claude-login-<account id>` with only that directory mounted, and
opens a browser terminal in it running `claude auth login`, shown inline:

1. Copy the URL it prints (Ctrl+Shift+C) and open it in a new tab.
2. Approve the request and copy the code Claude gives you.
3. Paste it into the **Code** field under the terminal and press **Send code**.
   Claude Code reads the code with echo off, so nothing appears in the terminal
   as it is typed or pasted; the field sends it to the terminal followed by
   Enter, and the terminal answers with the result.
4. Press **Close login terminal**.

Closing (`DELETE /api/claude/accounts/<id>/login`) kills the terminal, removes
the container and re-probes that account, so the row shows the result straight
away. An account this login created that never got signed in is deleted again,
so an abandoned login leaves nothing behind. One login terminal is open at a
time; starting another answers `409 claude_login_in_progress` with the
`accountId` whose login is open.

Use one account per Claude login. Two accounts signed in to the same email
share one set of usage limits, so failing over between them gains nothing.

### Rename

**Rename** (`PATCH /api/claude/accounts/<id> { nickname }`) sets the name shown
in the sidebar, the account pickers and the session pages. Blank clears it, and
the email shows again. At most 100 characters.

### Sign in again

**Sign in again** (`POST /api/claude/accounts/<id>/login`) runs the same login
flow on an existing account — after its login expired, after you signed it out
elsewhere, or to put another email behind it. The new credentials replace the
old ones in the account's directory; sessions bound to the account keep it and
pick the new login up at their next agent launch. Nothing has to be restarted.

### Make default

**Make default** (`POST /api/claude/accounts/<id>/default`) pins the
`default_claude_account_id` setting. Everything that names no account of its
own then runs on that account, and moves only while it is held
([failover](#failover)). **Choose automatically** (`PATCH /api/settings {
"defaultClaudeAccountId": null }`) unpins it again, and the
[automatic choice](#automatic-choice) takes over. See [Settings](#settings).

### Check again

**Check again** (`POST /api/claude/accounts/<id>/check`) re-probes one account,
ignoring the cache.

### Remove

**Remove** asks first, naming how many sessions and recurring tasks are bound
to the account (`GET /api/claude/accounts/<id>/bindings`), then
`DELETE /api/claude/accounts/<id>`:

- `409 account_is_default` while it is the pinned default and another account
  exists — make another one the default, or choose automatically, first; the
  last account can always go;
- `409 account_in_use` while a session or PR-run container labelled
  `chief-web.claude-account=<id>` is running — stop that work first;
- otherwise the row, its directory and every reference to it are deleted →
  `204`. Sessions, recurring tasks and the PR-automation and Sentry settings
  that named it fall back to the default (or the automatic choice), and its
  usage-limit hold goes with it.

Removing an account deletes chief-web's copy of the login. It does not sign the
login out at Anthropic.

## Status

Whether an account is signed in is the verdict of a non-interactive probe:
`GET /api/claude` runs, for every account, a `--rm` runner container with that
account's directory mounted and reads `claude auth status --json` (at most 3
probe containers at once). Asking the CLI beats parsing its credential file,
which is an internal format. Each account's answer is cached for
`CLAUDE_STATUS_CACHE_MS` (15 s) because it costs a container start, and a
successful probe writes the account's email, organization, subscription and
auth method onto its row (a probe that says "signed out" clears the auth method
again). The response is `{ accounts: [{ id, nickname, email, organization,
subscription, authenticated, error, checkedAt, usage }], defaultAccountId,
defaultIsExplicit, login }`.

**Session creation is blocked only while no account is signed in** — `POST
/api/sessions` and planning answer `409 claude_not_authenticated` with what to
do about it, and the home page says so too. A session container whose agent
cannot authenticate would otherwise fail at its first invocation, far from the
cause. A status check that cannot run (Docker unreachable, runner image
missing) counts as not signed in: chief-web fails closed and reports the
reason.

## Plan usage and token refresh

Every account's 5-hour and 7-day usage is read from Anthropic's usage endpoint
(`GET /api/oauth/usage`) with the OAuth access token in the account's
`.credentials.json`, by a background ticker (`server/src/claude/usage.ts`) that
caches each answer for `CLAUDE_USAGE_CACHE_MS` (default 60 s). `GET
/api/claude` carries it per account and `GET /api/stats` as `accounts: [{ id,
usage, holdUntil }]`. An API-key or console login has no plan windows; those
read as `null`.

The same ticker refreshes any token that expires within ten minutes by letting
the CLI refresh it itself in a `--rm` runner container (`claude auth status
--json`, then one `claude -p "ok" --model haiku` if the token is still
expired). Only when the refresh token is gone, or the refresh leaves the token
expired, does the account read “sign in again” in Settings and the sidebar.

## Which account work runs on

**Sessions.** A session stores `claudeAccountId` (`null` = follow the default);
`GET /api/sessions[/<id>]` also returns `automaticClaudeAccount` (true while
it names no account and no default is pinned), `effectiveClaudeAccountId` (its
own account, else the pinned default, else the account the automatic choice
last launched it on — `null` before an automatic session's first launch) and
`failoverClaudeAccountId` (the account it is running on instead while its
pinned account is held, else `null`). It is chosen on the
new-session form and changed in the **Claude account** card on the session page
— see [Claude account](sessions.md#claude-account). `POST /api/sessions` and
`PATCH /api/sessions/<id>/account { claudeAccountId }` answer `400
claude_account_unknown` for an id that names no account and `409
claude_account_not_authenticated` for one that is not signed in; the PATCH is
refused (`409 claude_account_locked`) once the session is finished or merged,
like the thinking effort.

When a session's account changes (a PATCH, a new default for a session that
follows it, a failover, or the automatic choice moving on) its running
container is left alone until the next launch of agent work — a build
iteration, a planning terminal, a review or a description — which recreates it
on the new account. The iteration already running is never interrupted, and
neither are the other stories of a [parallel build](build-loop.md#parallel-stories):
while any of them is running or merging in the container, a story that starts
next to them stays on the container's account, and the move waits for the
first launch with nothing else running.

**Automated work.** Every other launcher has its own choice, `null` meaning
the default account — the automatic choice unless a default is pinned:

- a [recurring task](scheduling.md#recurring-tasks) stores `claudeAccountId`
  and passes it to each run it creates (an unset task's runs follow the
  default, rather than being pinned to today's);
- **Settings → GitHub → Account for PR review, feedback and conflict fixes** is
  what [code review](code-review.md), PR feedback and
  [merge-conflict fix](merge-conflicts.md) containers mount;
- **Settings → Sentry → Account for Sentry fixes** is passed to the
  [Sentry](sentry.md) fix sessions and also used for the Sentry planning
  container;
- sessions created by [voice](voice.md) name no account and follow the
  default.

## Automatic choice

With no default pinned, work that names no account — a session left at
**Automatic**, a recurring task's runs, PR automation and Sentry work with no
account set — is placed by chief-web itself, at every launch of agent work
(`pickAutomaticAccount`, `server/src/claude/failover.ts`). It only considers
accounts that are signed in and not [held](#the-usage-limit-hold), and drains
them in this order:

1. **accounts with no 7-day window** first. They have no weekly quota to save,
   and 5-hour capacity left idle is simply lost;
2. then the accounts with a 7-day window, **lowest 7-day usage first**, so they
   drain about evenly over the week;
3. then accounts whose usage is unknown — not read yet, or not a plan login
   (an API-key or console account bills per token, so it goes last);
4. ties go to the lower 5-hour usage, then to the position in the list.

**A session stays where it is** while its account has room: a container's
account is kept as long as that account is signed in, not held and its 5-hour
usage is **at most 95%** — even when another account now ranks first. Moving a
session means recreating its container, so it only moves once its account is
nearly drained (or held, or signed out); the next agent launch after that puts
it on the first account with room. A container that is not running gets the
first account in the order straight away.

**When every usable account is above 95%** the work still runs — on the
account it is already on, else the one with the lowest 5-hour usage — because
there is no hold to wait for; a refusal then holds that account as usual.
**When every signed-in account is held** the work waits for the first hold to
lift.

A session records where the choice put it as `automaticClaudeAccountId`
(column `automatic_claude_account_id`), which is what its page and the
sessions list show — **<name> (automatic)** — and what a refusal holds. `GET
/api/stats` reports `automaticAccountId`, the account new automatic work would
start on right now: the **Next up** badge in Settings and the "now <name>" hint
in the account picker.

## The usage-limit hold

Claude's usage limit is on the account, so the
[usage-limit hold](build-loop.md#the-usage-limit-hold) is **per account**
(setting `claude_limit_until:<account id>`, `server/src/limits/hold.ts`):

- a refusal for the usage limit holds the account the refused run was on, for
  one hour;
- a 5-hour or 7-day window reported at 100% holds its account until that
  window's `resetsAt`, the later of the two when both are full;
- a hold expires by itself at that time, or when **Resume now** clears it.

Work on other accounts keeps running. `GET /api/stats` reports each account's
own expiry as `accounts[].holdUntil`, and `hold.until` (the sidebar's **On
hold** countdown) only while **every** signed-in account is held, as the
earliest expiry. `GET /api/limits/hold` returns `{ until, accounts: [{
accountId, until }] }`; `POST /api/limits/hold/clear` takes an optional `{
accountId }` and lifts every hold when it is omitted.

### Failover

Work pinned to an account that is held does not have to wait: it **fails
over** to another account, chosen by `pickFailoverAccount`
(`server/src/claude/failover.ts`):

1. candidates are the other accounts that are signed in, not held, and whose
   5-hour usage is **at most 95%** — an account above that would only be
   refused minutes later (a 5-hour window with no reading counts as 0%);
2. of those, the first in the [drain order](#automatic-choice) wins: no 7-day
   window first, then the lowest 7-day usage, then unknown usage, ties to the
   lower 5-hour usage and the position in the list;
3. work whose container already fails over to an account stays on it while it
   still qualifies, rather than being moved for a better-ranked one.

Work pinned to no account does not fail over: the automatic choice simply
places it on another account at its next launch.

When no account qualifies the work waits for its own account's hold to expire,
as with a single account, and the server logs once per account and reason why
(no other signed-in account is free, or every other one is above 95%).

Failover applies to sessions (builds, planning, reviews, descriptions,
scheduled starts, recurring-task runs) and to PR runs. A session records the
account it fails over to as `failoverClaudeAccountId`, and its page and the
sessions list read **Running on <failover> while <own> is on hold until
<time>**. A build that is running when its account is held moves straight
away: its agents come off the held account and it carries on, still
**building**, on the failover account, where the next agent launch recreates its
container ([details](build-loop.md#failover-to-another-account)). Only a build
with nowhere to go is parked at **waiting**; the next scheduler tick resumes it
on a failover account as soon as one qualifies. It goes back to its own account
at the first agent launch after that account's hold has expired. A refusal on
the failover account holds the failover account, not the session's own.

## Settings

Three settings choose accounts; each is `null` (follow the default) or an
account id, and naming an id that is no account answers `400
claude_account_not_found` and saves nothing of the update:

| Setting | Where | API field (`GET`/`PATCH /api/settings`) | Used by |
| --- | --- | --- | --- |
| Default account | **Make default** on an account row; **Choose automatically** unpins it | `defaultClaudeAccountId` | everything that names no account of its own; `null` (the default) means the [automatic choice](#automatic-choice) |
| PR automation account | Settings → GitHub → **Account for PR review, feedback and conflict fixes** | `prAutomationClaudeAccountId` | code review, PR feedback and merge-conflict fix runs |
| Sentry account | Settings → Sentry → **Account for Sentry fixes** | `sentryClaudeAccountId` | Sentry planning and fix sessions |

The default is also returned by `GET /api/claude` as `defaultAccountId`, with
`defaultIsExplicit` saying whether it was pinned. When it was not, the id is
only a stand-in — the first signed-in account, which a launch falls back to
when the automatic choice has nothing to offer.

## Upgrading from a single account

Before multiple accounts, chief-web kept one login in the `claude-auth` Docker
volume (`chief-web-claude-auth`) and mounted it into every container. That
volume is now only **imported**:

- On start, when there are **no accounts at all** and
  `CLAUDE_AUTH_DIR/.credentials.json` exists (`/claude-auth`, the legacy volume
  mounted read-only into the server), the server creates an account, **copies**
  the whole directory into `DATA_DIR/claude-accounts/<id>`, and hands it to
  the runner user. The default is left unpinned: with one account the
  automatic choice is that account anyway. The log says “imported the existing
  Claude login as the first account”.
- Older versions pinned the imported account as the default. Migration
  `0036_automatic_claude_account` lifts that pin on an install that still has
  exactly one account — with one account the pin and the automatic choice
  behave the same — so an account added later is used automatically. A
  default pinned on an install with several accounts is left alone.
- The volume is never written and no container mounts it.
- If the copy fails, the half-made account is deleted again and the error
  logged; the next start retries. A bad volume never keeps the server from
  starting.

**`CLAUDE_AUTH_VOLUME` is gone.** The server no longer reads it, and
`docker-compose.yml` names the legacy volume `chief-web-claude-auth` outright.
If you had renamed the volume before upgrading, put that name under
`volumes: claude-auth: name:` in `docker-compose.yml` before the first start of
the new version, or the import finds nothing.

**Once the import has happened** — the account is listed in Settings — the
volume can be removed. It is worth doing: the import runs whenever there are no
accounts, so with the volume still there, removing every account brings the
old login back on the next start.

```sh
docker compose down
docker volume rm chief-web-claude-auth
docker compose up -d
```

Compose recreates an empty volume on `up`, which imports nothing. To be rid of
it entirely, also delete the `claude-auth:/claude-auth:ro` mount and the
`claude-auth` volume from `docker-compose.yml`. Removing the volume is clean-up,
not a way to sign out: the accounts' logins live on the data volume, and
**Sign in again** or **Remove** on an account row is how you change them.
