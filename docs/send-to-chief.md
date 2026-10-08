[← chief-web](../README.md) · [All docs](../README.md#documentation)

# Send to chief

**Send to chief** starts a chief-web session from a Claude Code conversation in
another project. You talk a feature through with Claude Code on your own
machine, type `/send-to-chief`, and the skill matches the project's git remote
to a chief-web repository, writes a PRD in chief-web's format, shows it to you
and — after you say yes — creates a **pending** session with that PRD through
chief-web's agent API. Nothing builds until you open the session in chief-web,
review the PRD and click **Mark ready**.

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

The token can create sessions on your chief-web. Make sure `.env` is ignored
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
4. shows you the repository, session name, base branch, PR target and the list
   of stories, and **waits for an explicit yes**. You can change any of them
   first;
5. creates the session, fixing and resending the PRD if chief-web rejects a line
   of it;
6. gives you the session's link.

The skill never prints the token, never writes it to a file and sends it only
to `CHIEF_WEB_URL`.

## What happens after sending

The new session is an ordinary session ([Sessions](sessions.md)), created the
same way as one from the dashboard: its row, its container, its clone and its
feature branch `chief/<session-name>`. The difference is that the PRD the skill
wrote is put into the clone at `.chief/prds/<session-name>/prd.md` as soon as
setup succeeds, so no planning conversation is needed.

1. **Pending.** The session waits on the dashboard as `pending`. Nothing
   builds yet, even if you gave it a scheduled start.
2. **Review.** Open the link the skill gave you (or the session from the
   dashboard) and read the PRD. You can still open the planning terminal and
   change it — it is the same file a planned session has.
3. **Mark ready.** **Mark ready** parses the PRD and queues the session for the
   [build loop](build-loop.md), exactly as for a session you planned yourself.

If setup failed — most often because `chief/<session-name>` already exists on
`origin` — the session stays pending with the reason on screen, and the PRD is
kept on the session. Fix the cause and click **Retry setup**; the PRD is
written into the clone when setup succeeds.

Code review is off for a session sent this way unless the request asked for
it, and the pull request target follows the repository: `develop` when its
default base branch is `develop`, otherwise `main`.

## The agent API

The skill talks to three endpoints under `/api/agent`. You can call them
yourself with any HTTP client. Every request needs

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

Creates a pending session with a ready-written PRD.

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

`201`:

```json
{
  "session": {
    "id": "a83d…",
    "name": "csv-export",
    "status": "pending",
    "branch": "chief/csv-export",
    "scheduledStartAt": null
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

| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid_body` | The body is not a JSON object. |
| 400 | `invalid_repository_id`, `invalid_session_name`, `invalid_base_branch`, `invalid_pr_target_branch`, `invalid_scheduled_start`, `invalid_code_review`, `invalid_open_pull_request` | That field is missing or malformed; `message` says how. |
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
    "pullRequestUrl": null
  },
  "url": "https://chief.example.com/sessions/a83d…"
}
```

`status` is one of the [session states](sessions.md#session-states).
`setupError` is the session's last error — a failed setup, but also a later
build or delivery failure — or `null`. `pullRequestUrl` is set once a pull
request is open. Nothing else is returned: no PRD, logs, workspace paths or
container ids.

| Status | `error` | When |
| --- | --- | --- |
| 404 | `session_not_found` | No session with that id. |
