---
name: send-to-chief
description: Hand the current piece of work to chief-web as a new session with a ready-written PRD, pending by default or started right away when the operator asks for it. Use when the operator types /send-to-chief, or asks to "send this to chief", "hand this to chief", "let chief build this", "create a chief session for this", "send this to chief-web", "send this to chief and build it", "send this to chief and start it" or "start it in chief".
---

# Send to chief

Turn the work discussed in this conversation into a chief-web session: match this repository
in chief-web, write a PRD in chief-web's exact format, confirm it with the operator, and create
the session through chief-web's agent API. By default the session is created **pending** —
nothing builds until the operator reviews the PRD in chief-web and starts it. Only when the
operator **explicitly asked** to start or build it (e.g. "send this to chief and build it",
"start it in chief") does the same request also start it.

### When to start

Start the session only on an explicit request to build or start it now, in the operator's own
words: "… and build it", "… and start it", "start it in chief", "build it right away". Anything
else — "send this to chief", "hand this to chief", "let chief build this", "create a chief
session for this" — is a plain hand-off: create it pending. When you are unsure, do not start;
the summary in step 4 tells the operator how to ask for a start. Never start a session the
operator did not ask you to start.

Work through the steps in order. Stop at the first step that fails and tell the operator what
to do; never guess past an error.

## The token is a secret

`CHIEF_WEB_API_TOKEN` can create sessions on the operator's chief-web. Throughout this skill:

- Never print, echo, quote or summarise the token value — not in a message, not in a command's
  output. Refer to it only as `$CHIEF_WEB_API_TOKEN` inside commands.
- Never read `.env` with a file-reading tool, `cat`, `grep` without `-q`, or anything else that
  shows its contents; load it into the shell as described below.
- Never write the token to any file (no temp files, no header files, no config, no curl
  `-K` config file, no commit).
- Never use `curl -v`, `--trace`, `--trace-ascii` or `set -x`: they print the
  `Authorization` header.
- Only ever send the token to `$CHIEF_WEB_URL`.

Every shell command below starts with the same loader, because shell state does not carry over
between commands:

```bash
set -a; [ -f .env ] && . ./.env; set +a
```

Run it from the project root. It reads the project's `.env` if there is one and otherwise
leaves the variables as the environment has them; it prints nothing.

## Step 1: Check the configuration

```bash
set -a; [ -f .env ] && . ./.env; set +a
for var in CHIEF_WEB_URL CHIEF_WEB_API_TOKEN; do
  if [ -z "$(printenv "$var")" ]; then echo "missing: $var"; fi
done
echo "url: ${CHIEF_WEB_URL%/}"
```

If either variable is reported missing, stop and tell the operator, naming the variable, e.g.:

> `CHIEF_WEB_API_TOKEN` is not set in this project's `.env` or in the environment. Generate a
> token in chief-web under **Settings → API token** and add the two lines it offers
> (`CHIEF_WEB_URL=…` and `CHIEF_WEB_API_TOKEN=…`) to `.env`. Make sure `.env` is in
> `.gitignore`.

Strip a trailing slash from `CHIEF_WEB_URL` when you build URLs (`${CHIEF_WEB_URL%/}`).

## Step 2: Match this repository in chief-web

```bash
set -a; [ -f .env ] && . ./.env; set +a
remote=$(git remote get-url origin) || { echo "no origin remote"; exit 1; }
curl -sS -G "${CHIEF_WEB_URL%/}/api/agent/repositories/match" \
  --data-urlencode "remote=$remote" \
  -H "Authorization: Bearer $CHIEF_WEB_API_TOKEN" \
  -w '\nHTTP %{http_code}\n'
```

`--data-urlencode` URL-encodes the remote for you. If there is no `origin` remote, stop: chief-web
always clones from `origin`, so the operator has to add one first.

What the status means:

| Status | Body | Tell the operator |
| --- | --- | --- |
| 200 | `{ "repository": { "id", "name", "githubSlug", "defaultBaseBranch", "openPullRequestDefault" } }` | Nothing yet — keep `id`, `name` and `defaultBaseBranch` for the next steps. |
| 400 `invalid_remote` | `{ "error", "message" }` | `origin` is not an SSH or HTTPS git remote chief-web can read (show them the remote URL). |
| 401 `unauthorized` | `{ "error", "message" }` | The token is wrong, revoked or regenerated since it was copied. Generate a new one in chief-web under **Settings → API token** and update `CHIEF_WEB_API_TOKEN` in `.env`. Do not retry in a loop: failed attempts are rate limited. |
| 404 `repository_not_found` | `{ "error", "message" }` | Quote `message`: no chief-web repository matches this remote. Add the repository in chief-web first (**Repositories → Add repository**), then run `/send-to-chief` again. |
| 409 `ambiguous_repository` | `{ "error", "repositories": [{ "id", "name" }] }` | More than one chief-web repository matches. List the `name`s and ask which one to use; use that entry's `id`. Its base branch is not in this response: ask the operator, or leave `baseBranch` and `prTargetBranch` out of the body in step 5 and chief-web uses the repository's defaults. |
| 429 `too_many_attempts` | `{ "error", "message" }` | Too many failed token attempts; wait for the `Retry-After` seconds before trying again, and fix the token first. |
| anything else / no response | | chief-web could not be reached at `CHIEF_WEB_URL`; show the status and stop. |

## Step 3: Write the PRD

Base the PRD on **this conversation and the local code you can see**: what the operator asked
for, what you agreed on, and the files, modules and patterns that already exist. Read the
relevant code before writing so the stories name real files and fit the existing structure.
Do not invent requirements the operator never mentioned; if something essential is undecided,
ask before writing, or record it under `## Open Questions`.

Make every story **small enough for one focused build iteration**: one coherent change that a
coding agent can implement, test and commit in a single pass (roughly: one model, one route, one
screen, one migration). Split anything bigger. Order the stories so each one builds on the
ones before it — schema and backend first, then API, then UI, then docs.

### Session name

Derive a short name from the work: a lowercase slug of letters, digits and hyphens
(`[a-z0-9-]`), at most **60 characters**, no leading or trailing hyphen, e.g. `csv-export` or
`invoice-reminder-emails`. The session's feature branch becomes `chief/<name>`, and the name
must not be used by another session of the same repository.

### The exact format

chief-web parses the PRD and rejects it if a story cannot be read. Follow these rules exactly:

- Start with `# PRD: <Project title>`, then `## Introduction` with a short paragraph, then
  optional `## Goals`, then `## User Stories`.
- Each story starts with a heading **exactly** like `### US-001: Title` — three `#`, `US-`, a
  three-digit number, a colon, a space, the title. Ids are unique and numbered `US-001`,
  `US-002`, … in order.
- Directly under the heading, in this order:
  - `**Status:** todo` (always `todo` for a new PRD)
  - `**Priority:** <n>` — a whole number greater than 0, unique per story; use `1, 2, 3, …`
    in build order.
  - `**Description:** As a <role>, I want <capability> so that <benefit>.` on one line.
  - A blank line, then `**Acceptance Criteria:**`.
  - At least one criterion, each a line starting with `- [ ] ` (dash, space, `[`, space, `]`,
    space). Make them concrete and checkable. End code stories with
    `- [ ] Typecheck passes` (or the project's own check) when the project has one.
- Any other `##` or `###` heading ends the story above it, so put nothing else between
  stories, and put sections like `## Functional Requirements`, `## Non-Goals` or
  `## Open Questions` after the last story.
- Text inside fenced code blocks is ignored, so you may use them in descriptions, but never put
  a story or its checklist in one.

### Worked example

```markdown
# PRD: CSV export of invoices

## Introduction

Accountants ask for their invoices as a spreadsheet. This adds a CSV export of the invoice
list, honouring the filters that are applied on screen.

## Goals

- An accountant can download the invoices they are looking at as CSV in one click.
- The export never includes invoices of another team.

## User Stories

### US-001: Build the CSV from an invoice query
**Status:** todo
**Priority:** 1
**Description:** As a developer, I need a function that turns an invoice query into CSV rows so that every export uses the same columns.

**Acceptance Criteria:**
- [ ] A new `InvoiceCsv::fromQuery()` returns a header row plus one row per invoice with number, date, customer, total and status
- [ ] Amounts use a dot as decimal separator and two decimals
- [ ] Unit tests cover an empty query, one invoice and a customer name containing a comma
- [ ] Typecheck passes

### US-002: Download route
**Status:** todo
**Priority:** 2
**Description:** As an accountant, I want a download URL for the CSV so that my browser saves the file.

**Acceptance Criteria:**
- [ ] `GET /invoices/export.csv` answers with `Content-Type: text/csv` and a `Content-Disposition` file name containing today's date
- [ ] The route applies the same filters as the invoice list (status, date range, search)
- [ ] A user only ever gets invoices of their own team; a test proves it
- [ ] Typecheck passes

### US-003: Export button on the invoice list
**Status:** todo
**Priority:** 3
**Description:** As an accountant, I want an **Export CSV** button above the invoice list so that I can download what I see.

**Acceptance Criteria:**
- [ ] The button sits next to the filter bar and links to the export route with the current filters
- [ ] The button is hidden when the list is empty
- [ ] Typecheck passes

## Non-Goals

- No Excel (.xlsx) export.
- No scheduled or emailed exports.
```

Write the PRD to a temporary file — never into the project, and never into a shell string:

```bash
tmp=$(mktemp -d)   # note the path; reuse it in step 5
echo "$tmp"
```

Then write `$tmp/prd.md` with your file-writing tool (or a quoted heredoc,
`cat > "$tmp/prd.md" <<'PRD' … PRD`, whose quotes stop the shell from expanding anything
inside it).

## Step 4: Confirm with the operator — required

Before sending anything, show the operator:

- **Repository:** the matched repository's `name`
- **Session name:** the slug from step 3 (feature branch `chief/<name>`)
- **Base branch:** the repository's `defaultBaseBranch`, unless the operator chose another
- **PR target:** `develop` when the base branch is `develop`, otherwise `main` (chief-web
  accepts only `develop` or `main`)
- **Stories:** each story's id, title and number of acceptance criteria, in priority order
- **Start:** one of
  - "stays pending — nothing builds until you start it" — the default, whenever the operator
    did not explicitly ask to start or build it (see [When to start](#when-to-start)); you may
    add "say *and build it* if you want it to start right away";
  - "builds right away (or joins the build queue)" — only when the operator explicitly asked
    to start or build it;
  - "starts at <time>" — when they asked to start it at a given time ("build it at 06:00");
    show the time in their local time zone as well as the UTC `scheduledStartAt` you will send.
    A scheduled start without a request to start keeps the first line: it stays pending, and
    the time only applies once they start it in chief-web.

Then ask them to confirm, e.g. "Send this to chief-web? (yes / change …)", or, when it will
start, "Send this to chief-web and start it? (yes / change …)". The operator may change the
repository, name, base branch, PR target, the start or any story first; apply the change,
rewrite `$tmp/prd.md` if needed, and show the summary again. **Send only after an explicit
yes.** Silence, a question or "looks interesting" is not a yes. If they decline, delete
`$tmp` and stop.

When the summary says it starts, that one explicit yes covers both creating and starting the
session: do not ask a second question before sending. A yes to a summary that says "stays
pending" never starts it; if the operator asks to start it only after confirming, show the
summary again with the new **Start** line and wait for a new yes.

## Step 5: Create the session

Build the JSON body with `jq` from the file, so the PRD is never pasted into a command line
and every quote, backtick and `$` in it survives unchanged. Set `TMP` to the directory from
step 3 and fill in the confirmed values:

```bash
set -a; [ -f .env ] && . ./.env; set +a
TMP=/tmp/tmp.XXXXXX        # the directory from step 3
jq -n \
  --arg repositoryId '<repository id>' \
  --arg name '<session name>' \
  --arg baseBranch '<base branch>' \
  --arg prTargetBranch '<develop or main>' \
  --argjson start false \
  --rawfile prd "$TMP/prd.md" \
  '{repositoryId: $repositoryId, name: $name, baseBranch: $baseBranch, prTargetBranch: $prTargetBranch, start: $start, prd: $prd}' \
  > "$TMP/body.json"
curl -sS -X POST "${CHIEF_WEB_URL%/}/api/agent/sessions" \
  -H "Authorization: Bearer $CHIEF_WEB_API_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @"$TMP/body.json" \
  -w '\nHTTP %{http_code}\n'
```

Keep `--argjson start false` unless the summary the operator said yes to read "builds right
away" or "starts at <time>"; only then write `--argjson start true`. `start` must be a JSON
boolean — `--argjson`, not `--arg`, which would send the string `"true"` and be refused.

`body.json` holds only the session fields and the PRD, never the token. Optional fields the
API also accepts: `codeReview` (boolean, default `false`), `openPullRequest` (boolean, defaults
to the repository's setting) and `scheduledStartAt` (UTC ISO-8601, e.g.
`2026-10-09T06:00:00Z`) — add them with `--argjson` / `--arg` only when the operator asked.

What the status means:

| Status | Body | What to do |
| --- | --- | --- |
| 201 | `{ "session": { "id", "name", "status", "branch", "scheduledStartAt" }, "setup": { "ok", "message" }, "prdWritten", "url" }`, plus `"start"` when you sent `start: true` | The session was created — even when `start.ok` is `false`. Go to step 6; never send the create again. |
| 201 `start` | `{ "ok": true, "outcome": "started" \| "queued" \| "scheduled", "queued", "queuePosition", "message" }` or `{ "ok": false, "error", "message" }` | Only present with `start: true`. The start never changes the HTTP status; read `start.ok` and `start.outcome` in step 6. On a successful start, `session.status` is already `building` or `ready`. |
| 400 `invalid_start` | `{ "error", "message" }` | Nothing was created: `start` was not a JSON boolean. Rebuild `body.json` with `--argjson start true` or `--argjson start false` (never `--arg`) and send again. |
| 400 `invalid_prd` | `{ "error", "errors": [{ "line", "message" }] }` (or a single `message`) | Nothing was created. Each `line` is a 1-based line of `prd.md`; fix exactly those problems (missing `- [ ]` criteria, a duplicated id, a bad priority or status), rebuild `body.json` and send again. Tell the operator what you fixed; if the fix changed the stories, confirm again first. |
| 400 `invalid_session_name`, `invalid_base_branch`, `invalid_pr_target_branch`, `invalid_scheduled_start` | `{ "error", "message" }` | Nothing was created. Fix that field (quote `message`), confirm the new value with the operator, and send again. |
| 401 / 429 | | As in step 2. |
| 404 `repository_not_found` | | The repository was removed in chief-web since step 2; start over from step 2. |
| 409 `session_name_taken` | `{ "error", "message" }` | That repository already has a session with this name. Propose a new name (e.g. append `-2` or a more specific word), get the operator's yes, and send again. |
| 409 `claude_not_authenticated` | `{ "error", "message" }` | chief-web has no working Claude login. The operator must sign in under **Settings → Claude Code** in chief-web; then send again. |
| 5xx or no response | | Show the status and `message`; do not retry more than once. |

## Step 6: Report back

Tell the operator:

- The session **URL** from the response (`url`), as a link.
- Whether it is building, from the `start` object (table below).
- If `setup.ok` is `false`: setup failed and the PRD was kept on the session; quote
  `setup.message` (git's message, e.g. that the branch `chief/<name>` already exists on
  origin). Once they fix the cause and click **Retry setup** in chief-web, the PRD is written
  into the clone.
- If `setup.ok` is `true` but `prdWritten` is `false`, say the PRD could not be written into
  the workspace and that **Retry setup** in chief-web writes it.

What the `start` object means, and whether the operator has to do anything in chief-web:

| Response | Tell the operator | Anything to do in chief-web? |
| --- | --- | --- |
| no `start` (you sent `start: false`) | The session is **pending**: nothing builds until they start it. | Yes — open it, review the PRD and click **Mark ready**. |
| `start.ok: true`, `outcome: "started"` | It is **building** now. | No. They can follow it at the URL. |
| `start.ok: true`, `outcome: "queued"` | It is ready and **waiting for a build slot**: number `start.queuePosition` in the build queue. Quote `start.message` (a Claude usage-limit hold also answers `queued`). | No — it starts by itself when a slot frees up. |
| `start.ok: true`, `outcome: "scheduled"` | It is ready and **starts at** `session.scheduledStartAt` (give the time in their local time zone too). | No — chief-web starts it at that time. |
| `start.ok: false`, `error: "setup_failed"` | It was created but **not started**: setup or writing the PRD did not finish, so it stays **pending**. Explain the setup problem as in the list above. | Yes — fix the cause, click **Retry setup**, then **Mark ready**. |
| `start.ok: false`, any other `error` | It was created but **did not start**; quote `start.error` and `start.message`. `session.status` says whether it is still `pending` or was already marked `ready`. | Yes — once the cause in `message` is fixed, open it and click **Mark ready** (pending) or **Start build** (ready). Never send the create again: the session exists. |

Say the operator has to click **Mark ready** only in the rows that say so: a session that was
started, queued or scheduled needs nothing from them in chief-web.

To check on the session later:

```bash
set -a; [ -f .env ] && . ./.env; set +a
curl -sS "${CHIEF_WEB_URL%/}/api/agent/sessions/<session id>" \
  -H "Authorization: Bearer $CHIEF_WEB_API_TOKEN" -w '\nHTTP %{http_code}\n'
```

It answers `{ "session": { "id", "name", "status", "branch", "setupError", "scheduledStartAt", "pullRequestUrl" }, "url" }`.

Finally remove the temporary directory (`rm -rf "$TMP"`).
