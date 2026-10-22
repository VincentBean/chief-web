[← chief-web](../README.md) · [All docs](../README.md#documentation)

# Send to chief

**Send to chief** starts a chief-web session from a Claude Code conversation in
another project. You talk a feature through with Claude Code on your own
machine, type `/send-to-chief`, and the skill matches the project's git remote
to a chief-web repository, writes a PRD in chief-web's format, shows it to you
and — after you say yes — creates a session with that PRD through chief-web's
agent API.

By default the session stays **pending**: nothing builds until you open it in
chief-web, review the PRD and click **Mark ready**. When you ask for a build
outright ("send this to chief and build it"), the skill creates **and starts**
the session in one call, so it builds (or joins the build queue) while you
carry on. The skill can also start, schedule or send back to planning a
session it sent earlier — see [Managing a session you sent](#managing-a-session-you-sent).

It needs three things: an API token from chief-web, two lines in the project's
`.env`, and the skill file copied into the project (or into your home directory
for every project).

## Setting it up

### 1. Generate a token

In chief-web, open **Settings → API token** and click **Generate token**. The
panel shows the token once, with a ready-made pair of `.env` lines and a
**Copy** button. Copy them before you leave the page: chief-web stores only a
hash of the token, so it cannot show it again. If you lose it, click
**Regenerate** — that replaces the token, and the old one stops working at
once.

There is one token per chief-web. The panel shows when it was created and
when it was last used; **Revoke** removes it, after which every agent request
is refused until you generate a new one. See
[Security model](security.md#the-agent-api-token) for what the token can and
cannot reach.

### 2. Add the two `.env` lines

In the root of the project you want to send work from, add the two lines to
`.env` (create the file if there is none):

```dotenv
CHIEF_WEB_URL=https://chief.example.com
CHIEF_WEB_API_TOKEN=chief_…
```

`CHIEF_WEB_URL` is chief-web's `PUBLIC_URL` when that is set, otherwise the
address you opened the Settings page on. It must be reachable from the machine
the skill runs on. Both variables may also come from the shell environment
instead; a value in `.env` wins.

### 3. Keep `.env` out of git

The token can create and start sessions on your chief-web. Make sure `.env` is ignored
before you commit anything:

```sh
grep -qxF '.env' .gitignore 2>/dev/null || echo '.env' >> .gitignore
```

### 4. Install the skill

The skill is [`skills/send-to-chief/SKILL.md`](../skills/send-to-chief/SKILL.md)
in this repository. Copy it into the project:

```sh
mkdir -p .claude/skills/send-to-chief
cp /path/to/chief-web/skills/send-to-chief/SKILL.md .claude/skills/send-to-chief/SKILL.md
```

or, to have it in every project, into your home directory:

```sh
mkdir -p ~/.claude/skills/send-to-chief
cp /path/to/chief-web/skills/send-to-chief/SKILL.md ~/.claude/skills/send-to-chief/SKILL.md
```

Each project still needs its own `.env` (or the two variables in your shell).
The skill uses `git`, `curl` and `jq`; `jq` builds the request body so the PRD
is never pasted into a command line.

### 5. Add the repository in chief-web

The skill can only send work to a repository chief-web already knows. Add it
under **Repositories → Add repository** if you have not
(see [Repositories](repositories.md)). The project's `origin` remote is matched
against the repository's SSH URL and its GitHub slug, so an HTTPS clone on your
machine matches an SSH remote in chief-web.

## Sending work

Type `/send-to-chief` in Claude Code, or ask it to "send this to chief". The
skill:

1. checks that `CHIEF_WEB_URL` and `CHIEF_WEB_API_TOKEN` are set, and names the
   one that is missing;
2. matches `git remote get-url origin` to a chief-web repository, and asks you
   to choose when more than one matches;
3. writes a PRD from the conversation and the code it can see — small stories
   in build order, in the exact format [Mark ready](sessions.md#marking-a-session-ready)
   parses;
4. shows you the repository, session name, base branch, PR target, whether it
   will **start** (stays pending, builds right away, or starts at a scheduled
   time) and the list of stories, and **waits for an explicit yes**. You can
   change any of them first;
5. creates the session — and starts it, if you asked for that — fixing and
   resending the PRD if chief-web rejects a line of it;
6. gives you the session's link and, for a started session, whether it is
   building, queued (with its place in the queue) or waiting for its scheduled
   start.

The skill never prints the token, never writes it to a file and sends it only
to `CHIEF_WEB_URL`.

### Pending by default, started on request

A plain "send this to chief" creates a **pending** session: the skill never
starts a build you did not ask for. Ask for it in the same breath — "send this
to chief and build it", "start it in chief" — and the summary in step 4 says
the session *builds right away (or joins the build queue)*; your single yes to
that summary covers both creating and starting it, with no second question.
With a scheduled start the summary says *starts at <time>* instead, and the
session waits, ready, for that moment.

Under the hood this is one `POST /api/agent/sessions` with `"start": true`
(see [the create endpoint](#post-apiagentsessions)). If setup fails, nothing
starts and the session stays pending, exactly as without `start`.

### Managing a session you sent

After sending, you can keep steering the session from the same conversation:

- **"Start the chief session you sent"** — marks a pending session ready and
  starts or queues its build, like **Mark ready** followed by **Start build**
  ([`POST …/start`](#post-apiagentsessionsidstart)).
- **"Schedule it for 06:00"** / **"clear the schedule"** — sets, changes or
  clears the scheduled start; the skill converts your local time to UTC
  ([`PUT …/schedule`](#put-apiagentsessionsidschedule)).
- **"Un-start it"** — sends a `ready` session back to planning and takes it off
  the build queue, as long as its build has not begun
  ([`POST …/back-to-planning`](#post-apiagentsessionsidback-to-planning)).
- **"How is it doing?"** — reads its status, queue position and pull request
  link ([`GET …/sessions/:id`](#get-apiagentsessionsid)).

The skill uses the session id from the response it got when it sent the
session; if it no longer has it, it asks you for the session's URL, whose last
path segment is the id. Starting a session it did not send in this
conversation needs your explicit yes, the same as sending one. A build that
has begun can only be stopped with **Stop build** in chief-web: the agent API
does not stop builds.

## What happens after sending

The new session is an ordinary session ([Sessions](sessions.md)), created the
same way as one from the dashboard: its row, its container, its clone and its
feature branch `chief/<session-name>`. The difference is that the PRD the skill
wrote is put into the clone at `.chief/prds/<session-name>/prd.md` as soon as
setup succeeds, so no planning conversation is needed.

For a session that was not started:

1. **Pending.** The session waits on the dashboard as `pending`. Nothing
   builds yet, even if you gave it a scheduled start.
2. **Review.** Open the link the skill gave you (or the session from the
   dashboard) and read the PRD. You can still open the planning terminal and
   change it — it is the same file a planned session has.
3. **Mark ready.** **Mark ready** parses the PRD and queues the session for the
   [build loop](build-loop.md), exactly as for a session you planned yourself.

A session that was started skips all three: it is `ready` and then
`building` straight away, `ready` on the
[build queue](scheduling.md#concurrency-and-the-build-queue) when every build
slot is taken or Claude is on a
[usage-limit hold](build-loop.md#the-usage-limit-hold), or `ready` until its
[scheduled start](scheduling.md#scheduled-starts). Nothing needs clicking in
chief-web; the session page shows the build as for any other.

If setup failed — most often because `chief/<session-name>` already exists on
`origin` — the session stays pending with the reason on screen, and the PRD is
kept on the session. Fix the cause and click **Retry setup**; the PRD is
written into the clone when setup succeeds.

Code review is off for a session sent this way unless the request asked for
it, and the pull request target follows the repository: `develop` when its
default base branch is `develop`, otherwise `main`.

## The agent API

The skill talks to six endpoints under `/api/agent`. You can call them
yourself with any HTTP client:

| Endpoint | What it does |
| --- | --- |
| [`GET /api/agent/repositories/match`](#get-apiagentrepositoriesmatch) | Finds the repository a git remote belongs to. |
| [`POST /api/agent/sessions`](#post-apiagentsessions) | Creates a pending session with a ready-written PRD, and starts it with `"start": true`. |
| [`GET /api/agent/sessions/:id`](#get-apiagentsessionsid) | Reads a session back, including its place in the build queue. |
| [`POST /api/agent/sessions/:id/start`](#post-apiagentsessionsidstart) | Marks a session ready and starts or queues its build. |
| [`PUT /api/agent/sessions/:id/schedule`](#put-apiagentsessionsidschedule) | Sets, changes or clears the scheduled start. |
| [`POST /api/agent/sessions/:id/back-to-planning`](#post-apiagentsessionsidback-to-planning) | Returns a ready session to pending and takes it off the build queue. |

Nothing under `/api/agent` stops a build, merges a pull request or changes a
setting. Every request needs

```http
Authorization: Bearer <token>
```

The login cookie is not accepted here, and the token is accepted nowhere else.
Every response is JSON. Unknown paths under `/api/agent` answer `404
{ "error": "not_found" }`.

### Errors every endpoint can return

| Status | `error` | When |
| --- | --- | --- |
| 401 | `unauthorized` | No `Authorization` header, a malformed one, a wrong, regenerated or revoked token, or no token configured at all. The body is always `{ "error": "unauthorized", "message": "Missing or invalid API token." }`, so a caller cannot tell which. |
| 429 | `too_many_attempts` | Too many failed token attempts from this address. The response has a `Retry-After` header and `retryAfterSeconds` in the body. See [rate limiting](security.md#the-agent-api-token). |

### `GET /api/agent/repositories/match`

Finds the chief-web repository a git remote belongs to. Pass the remote URL as
the `remote` query parameter (URL-encoded); SSH (`git@host:owner/repo.git`,
`ssh://…`) and HTTPS forms are accepted, with or without `.git`, in any case.

```sh
curl -sS -G "$CHIEF_WEB_URL/api/agent/repositories/match" \
  --data-urlencode "remote=git@github.com:acme/shop.git" \
  -H "Authorization: Bearer $CHIEF_WEB_API_TOKEN"
```

`200`:

```json
{
  "repository": {
    "id": "6f1c…",
    "name": "shop",
    "githubSlug": "acme/shop",
    "defaultBaseBranch": "develop",
    "openPullRequestDefault": true
  }
}
```

| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid_remote` | `remote` is missing or is not an SSH or HTTPS git remote (a local path or a `file://` URL, for example). |
| 404 | `repository_not_found` | No repository matches. `message` names the remote. |
| 409 | `ambiguous_repository` | More than one repository matches. The body lists them: `{ "error": "ambiguous_repository", "repositories": [{ "id", "name" }] }`. |

### `POST /api/agent/sessions`

Creates a pending session with a ready-written PRD, and — with `"start": true`
— starts it straight away.

```sh
curl -sS -X POST "$CHIEF_WEB_URL/api/agent/sessions" \
  -H "Authorization: Bearer $CHIEF_WEB_API_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @body.json
```

```json
{
  "repositoryId": "6f1c…",
  "name": "csv-export",
  "baseBranch": "develop",
  "prTargetBranch": "develop",
  "prd": "# PRD: CSV export of invoices\n\n## Introduction\n…"
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `repositoryId` | yes | From the match endpoint. |
| `name` | yes | Letters, numbers, hyphens and underscores, at most 60 characters, unique per repository. Becomes `chief/<name>`. |
| `prd` | yes | The PRD as Markdown, at most 200 000 characters. It must pass the same parser as **Mark ready**. |
| `baseBranch` | no | Defaults to the repository's default base branch. |
| `prTargetBranch` | no | `develop` or `main`. Defaults to `develop` when the repository's default base branch is `develop`, otherwise `main`. |
| `scheduledStartAt` | no | ISO-8601 timestamp. Only a ready session starts, so a moment that passes while the session is still pending starts the build as soon as you mark it ready ([Scheduling](scheduling.md)). |
| `codeReview` | no | Boolean, default `false`. |
| `openPullRequest` | no | Boolean, defaults to the repository's setting. |
| `maxParallelStories` | no | Integer from 1 to 10, default `3`: how many of the session's stories may run at the same time. `1` builds the PRD one story after another. |
| `start` | no | Boolean, default `false`. `true` starts the session once it is created, exactly as [`POST …/start`](#post-apiagentsessionsidstart) would. |

`201`:

```json
{
  "session": {
    "id": "a83d…",
    "name": "csv-export",
    "status": "pending",
    "branch": "chief/csv-export",
    "scheduledStartAt": null,
    "maxParallelStories": 3
  },
  "setup": { "ok": true, "message": "…" },
  "prdWritten": true,
  "url": "https://chief.example.com/sessions/a83d…"
}
```

`setup.ok` is `false` when the clone failed; `setup.message` then carries
git's reason, the session still exists, and the PRD is written on the next
successful **Retry setup**. `prdWritten` is `true` only when the PRD is already
in the clone. `url` starts with `PUBLIC_URL` when that is set, otherwise with
the address the request came in on.

With `"start": true` the response is still `201` with the same fields, plus a
`start` object saying how the start went, and `session` shows the status after
it (`ready` or `building`):

```json
{
  "session": { "id": "a83d…", "name": "csv-export", "status": "building", "branch": "chief/csv-export", "scheduledStartAt": null },
  "setup": { "ok": true, "message": "…" },
  "prdWritten": true,
  "start": {
    "ok": true,
    "outcome": "started",
    "queued": false,
    "queuePosition": null,
    "message": "\"csv-export\" is building."
  },
  "url": "https://chief.example.com/sessions/a83d…"
}
```

`start.outcome` is `"started"`, `"queued"` (with `queuePosition`) or
`"scheduled"`, with the same meaning as for
[`POST …/start`](#post-apiagentsessionsidstart). When the session cannot be
started, the session is still created and the status is still `201`, but
`start` is `{ "ok": false, "error", "message" }`:

- `setup_failed` — setup did not finish or the PRD was not written into the
  clone. The session stays **pending**; fix the cause and click **Retry setup**,
  then **Mark ready**.
- any other code from [`POST …/start`](#post-apiagentsessionsidstart) — the
  start step itself failed. The session may already be `ready`; the session
  page shows what is left to do (usually **Start build**).

Without `start`, or with `"start": false`, there is no `start` key and the
session is `pending`.

| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid_body` | The body is not a JSON object. |
| 400 | `invalid_repository_id`, `invalid_session_name`, `invalid_base_branch`, `invalid_pr_target_branch`, `invalid_scheduled_start`, `invalid_code_review`, `invalid_open_pull_request`, `invalid_max_parallel_stories` | That field is missing or malformed; `message` says how. |
| 400 | `invalid_start` | `start` is present but not a boolean (`"yes"` and `null` included). |
| 400 | `invalid_prd` | `prd` is missing, empty or too long (`message`), or does not parse. A parse failure lists every problem with its 1-based line: `{ "error": "invalid_prd", "errors": [{ "line": 18, "message": "…" }] }`. |
| 400 | `repository_key_missing` | The repository has no private key, so nothing can be cloned. |
| 404 | `repository_not_found` | No repository with that id. |
| 409 | `session_name_taken` | The repository already has a session with that name. |
| 409 | `claude_not_authenticated` | chief-web has no working Claude login (see [Claude authentication](claude-auth.md)). This is checked before the body. |
| 503 | `sessions_unavailable` | The server is still starting up; try again in a moment. |

Nothing is created when the request is rejected.

### `GET /api/agent/sessions/:id`

Reads a session back: whether setup worked, where it stands, and where to
review it.

```sh
curl -sS "$CHIEF_WEB_URL/api/agent/sessions/a83d…" \
  -H "Authorization: Bearer $CHIEF_WEB_API_TOKEN"
```

`200`:

```json
{
  "session": {
    "id": "a83d…",
    "name": "csv-export",
    "status": "pending",
    "branch": "chief/csv-export",
    "setupError": null,
    "scheduledStartAt": null,
    "pullRequestUrl": null,
    "maxParallelStories": 3,
    "queued": false,
    "queuePosition": null
  },
  "url": "https://chief.example.com/sessions/a83d…"
}
```

`status` is one of the [session states](sessions.md#session-states).
`setupError` is the session's last error — a failed setup, but also a later
build or delivery failure — or `null`. `pullRequestUrl` is set once a pull
request is open. `maxParallelStories` is how many of its stories may run at
once. `queued` is `true` while a `ready` session waits on the
[build queue](scheduling.md#concurrency-and-the-build-queue) for a slot, and
`queuePosition` is then its 1-based place in it (`null` otherwise). Nothing
else is returned: no PRD, logs, workspace paths or container ids.

| Status | `error` | When |
| --- | --- | --- |
| 404 | `session_not_found` | No session with that id. |

### `POST /api/agent/sessions/:id/start`

Starts a session: **Mark ready** followed by **Start build**, in one call. A
`pending` session has its PRD parsed and its stories synced, exactly as
[Mark ready](sessions.md#marking-a-session-ready) does; a `ready` session goes
straight to the build. The build starts when a slot is free and otherwise joins
the [build queue](scheduling.md#concurrency-and-the-build-queue). A session
whose scheduled start is still in the future is marked ready but not started:
the scheduler starts it at that time. A schedule that has already passed starts
it now. No body is needed.

```sh
curl -sS -X POST "$CHIEF_WEB_URL/api/agent/sessions/a83d…/start" \
  -H "Authorization: Bearer $CHIEF_WEB_API_TOKEN"
```

`200`:

```json
{
  "session": {
    "id": "a83d…",
    "name": "csv-export",
    "status": "ready",
    "branch": "chief/csv-export",
    "scheduledStartAt": null
  },
  "outcome": "queued",
  "queued": true,
  "queuePosition": 2,
  "message": "\"csv-export\" is waiting for a build slot (#2 in the queue).",
  "url": "https://chief.example.com/sessions/a83d…"
}
```

| `outcome` | `session.status` | Meaning |
| --- | --- | --- |
| `started` | `building` | The build loop is running. |
| `queued` | `ready` | Every build slot is taken, or Claude is on a [usage-limit hold](build-loop.md#the-usage-limit-hold); `queuePosition` is its place in the queue and it starts on its own. A hold is reported this way — `200` with the hold in `message` — never as a `429`. |
| `scheduled` | `ready` | It starts at `scheduledStartAt`. |

| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid_prd` | The PRD in the clone does not parse. The session stays `pending`, and `errors` lists every problem with its line, as for the create endpoint. |
| 404 | `session_not_found` | No session with that id. |
| 409 | `session_not_startable` | The session is neither `pending` nor `ready`; `message` names its status. Nothing changes. |
| 409 | `claude_not_authenticated` | chief-web has no working Claude login. Checked before anything else. |
| 409 | `session_not_cloned`, `session_has_no_stories`, `session_already_complete` | The build cannot start. A pending session has already been marked ready by then, so it is left `ready`. |
| 502 | `session_container_unavailable` | The session's container could not be started. |
| 503 | `sessions_unavailable` | The server is still starting up; try again in a moment. |

### `PUT /api/agent/sessions/:id/schedule`

Sets, changes or clears the [scheduled start](scheduling.md#scheduled-starts)
of a `pending` or `ready` session — the same as the schedule on the session
page. The body is `{ "scheduledStartAt": "<ISO-8601>" }`, or
`{ "scheduledStartAt": null }` to clear it. Send UTC (`2026-10-14T04:00:00Z`
is 06:00 in Amsterdam in summer) or a timestamp with an explicit offset.

```sh
curl -sS -X PUT "$CHIEF_WEB_URL/api/agent/sessions/a83d…/schedule" \
  -H "Authorization: Bearer $CHIEF_WEB_API_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{ "scheduledStartAt": "2026-10-14T04:00:00Z" }'
```

`200`:

```json
{
  "session": {
    "id": "a83d…",
    "name": "csv-export",
    "status": "pending",
    "branch": "chief/csv-export",
    "scheduledStartAt": "2026-10-14T04:00:00.000Z"
  },
  "url": "https://chief.example.com/sessions/a83d…"
}
```

A schedule only ever starts a `ready` session: on a `pending` one it waits
until the session is marked ready or started, and a `ready` session starts when
the moment comes — so setting a time that has already passed on a `ready`
session starts it on the scheduler's next tick. This endpoint runs no build
itself, so it is not behind the Claude login check.

| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid_body` | The body is not a JSON object. |
| 400 | `invalid_scheduled_start` | `scheduledStartAt` is missing, or neither `null` nor an ISO-8601 timestamp. |
| 404 | `session_not_found` | No session with that id. |
| 409 | `session_not_schedulable` | The session is neither `pending` nor `ready`; `message` names its status. |
| 503 | `sessions_unavailable` | The server is still starting up; try again in a moment. |

### `POST /api/agent/sessions/:id/back-to-planning`

Undoes a start that has not begun building: a `ready` session goes back to
`pending`, the same as **Back to planning** on the session page. If it was
waiting on the build queue it is taken off the queue first, so it can never
start afterwards. Its scheduled start is left as it is; clear it with
[`PUT …/schedule`](#put-apiagentsessionsidschedule) if it should not apply the
next time the session is marked ready. No body is needed.

```sh
curl -sS -X POST "$CHIEF_WEB_URL/api/agent/sessions/a83d…/back-to-planning" \
  -H "Authorization: Bearer $CHIEF_WEB_API_TOKEN"
```

`200`: the same `{ "session": { "id", "name", "status", "branch",
"scheduledStartAt" }, "url" }` as the schedule endpoint, with `status`
`"pending"`.

| Status | `error` | When |
| --- | --- | --- |
| 404 | `session_not_found` | No session with that id. |
| 409 | `session_not_ready` | The session is not `ready`; `message` names its status. For `building`, `waiting` or `deciding` it adds that the build has begun and only **Stop build** in chief-web stops it — the agent API does not stop builds. |
| 503 | `sessions_unavailable` | The server is still starting up; try again in a moment. |
