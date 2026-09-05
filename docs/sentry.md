[← chief-web](../README.md) · [All docs](../README.md#documentation)

# The Sentry auto-fixer

chief-web can watch a Sentry project and turn the errors it finds there into
pull requests on its own. Every fifteen minutes it lists the unresolved issues
of every linked project, spends one cheap Claude Code call per new issue
deciding whether it is the kind of thing a code change fixes, and — when it is —
creates an ordinary build session with a generated PRD holding the whole Sentry
report. That session builds, opens a pull request, gets reviewed and answers its
own review feedback like any other. When you merge it, the issue is marked
**fixed** here and resolved in Sentry.

> ⚠️ **A production error is attacker-controlled text.** Titles, messages,
> stack traces, tags and breadcrumbs frequently contain whatever an end user
> typed, and all of it is handed to agents that run with permissions skipped.
> chief-web fences and delimits every byte of it, but **the pull request you
> read before merging is the actual safety boundary.** See
> [Untrusted error data](#untrusted-error-data) and the
> [security model](security.md).

The integration is **off until you configure it**: no token means nothing is
polled, no linked repository means nothing is looked at. There is nothing to
switch on beyond the three setup steps below.

## Setup

### 1. Create a Sentry auth token

chief-web talks to the Sentry web API with a bearer token. Create a **personal
token** at
[**Settings → Account → API → Personal Tokens**](https://sentry.io/settings/account/api/auth-tokens/)
(`https://sentry.io/settings/account/api/auth-tokens/`) — the tokens that start
`sntryu_`. Scopes are chosen when the token is created and **cannot be edited
afterwards**, so get them right the first time; a token with the wrong scopes
has to be replaced.

Two scopes are enough, and they are the only two to tick:

| Scope | What it buys | Which call needs it |
| --- | --- | --- |
| **`event:read`** | listing and reading issues | `GET /projects/{org}/{project}/issues/?query=is:unresolved` (the poll), `GET /organizations/{org}/issues/{id}/` (the issue), `GET /organizations/{org}/issues/{id}/events/latest/` (the stack trace) |
| **`event:write`** | marking an issue resolved | `PUT /organizations/{org}/issues/{id}/` with `{"status":"resolved"}`, sent when the fix PR is merged |

Sentry documents the required scopes on each endpoint's own page
([list a project's issues](https://docs.sentry.io/api/events/list-a-projects-issues/),
[retrieve an issue](https://docs.sentry.io/api/events/retrieve-an-issue/),
[retrieve an issue event](https://docs.sentry.io/api/events/retrieve-an-issue-event/),
[update an issue](https://docs.sentry.io/api/events/update-an-issue/)). Reading
takes `event:read` — the read endpoints also accept `event:write` or
`event:admin`, but `event:read` is the smallest thing that works — and resolving
takes `event:write` (or `event:admin`). **`project:read` is not required**: the
issue endpoints are event-scoped, and chief-web never lists or edits projects.
Do not grant `event:admin`; it also allows deleting issues and events, which
nothing here does.

Two other token types exist and neither fits:

- **Organization tokens** (Settings → Developer Settings → Organization Tokens,
  the `sntrys_` ones) have a **fixed, non-customisable** scope set aimed at CI
  tasks — you cannot add `event:write` to one.
- **Internal integration tokens** (Settings → Custom Integrations → Internal
  Integration) *do* have editable permissions and work fine if you would rather
  not tie the integration to a person. Grant the same two scopes; the
  integration's permission page phrases them as **Issue & Event: Read & Write**.

The token reaches every project the account it belongs to can read, and
chief-web only ever touches the projects you link in step 3.

### 2. Paste it into Settings

**Settings → Sentry** (`/settings#sentry`) has the whole configuration:

| Field | Default | What it does |
| --- | --- | --- |
| **Auth token** | — | The token from step 1. Stored write-only: the UI only ever shows whether one is stored plus its last four characters, and **Remove** deletes it. No token means the poller does nothing at all. |
| **Poll every (minutes)** | 15 | How often linked projects are checked. 1–1440. |
| **Classification model** | `haiku` | The model that judges each new issue. |
| **API base URL** | `https://sentry.io/api/0/` | Only for self-hosted Sentry. Blank restores the hosted API. |

All four are read on the fly — **none of them needs a restart**. The interval is
re-read before every wait, so a change applies from the next poll; the token,
the model and the base URL are read at the moment they are used, so saving a
token starts the integration at the next tick, and removing one stops it.

Bad values are refused twice over: the form and the API reject them, and the
readers behind them clamp or fall back to the defaults, so a value written
straight into the database cannot wedge the poller either.

#### The classification model

Every new issue costs one short, read-only Claude Code call — a checkout of the
repository's base branch, the Sentry report, and one question: can this be fixed
with a code change in this repository? That call runs on the **Classification
model**, `haiku` by default, and that is the whole reason the setting exists:
it is a triage pass over many issues, most of which are not going to be worth a
session, so it should be the cheapest model that can read a stack trace. There
is no "let Claude Code choose" option here — this call always names a model.

**The fix itself does not run on it.** Once an issue is queued, the session it
creates is an ordinary session and uses the **Build** model, the **Review**
model and the agent timeout from [Settings → Models](interface.md#settings) like
every other session.

#### The polling interval

One tick, at the default of fifteen minutes, costs Sentry:

- **one issues-list call per linked project** (100 issues a page, up to 20
  pages), plus
- **one issue call and one latest-event call per issue being classified**, and
  classification is capped at **2 issues per tick across all repositories**,
  oldest first, plus
- **one resolve call per merged fix** still owed to Sentry.

So a tick over three linked projects costs at most about ten requests, which is
nowhere near Sentry's limits. Lowering the interval mostly shortens the delay
between an error appearing and a session starting; it does not make
classification go faster, because the 2-per-tick cap is what paces that. A tick
with nothing linked costs nothing — not even the token lookup.

A `429` is handled as a typed rate-limit error: that project is left exactly as
it was and picked up on the next tick, and the failure never marks an issue
unfixable.

### 3. Link a repository to a Sentry project

A project is linked from the repository form (**Repositories → Add repository**,
or **Edit** on one you already have), with two optional fields:

| Field | Value |
| --- | --- |
| **Sentry org slug** | the `<org>` in `sentry.io/organizations/<org>/projects/<project>` |
| **Sentry project slug** | the `<project>` in the same URL |

Both slugs or neither — a half-link is refused by the form and by the API, and a
repository with only one of them set is skipped by the poller rather than
guessed at. Clearing both unlinks the repository; the issues already tracked
against it stay in the list, they simply stop being refreshed. Linked
repositories carry a **Sentry** badge on the Repositories page.

One repository, one project. The repository is where the fix is built, so the
link is also the answer to "which code does this error come from" — point a
project at the repository that actually contains the code Sentry is complaining
about.

## The status lifecycle

Every issue chief-web has ever seen is a row with one of five statuses. It only
ever moves forward:

```
pending ──► queued ──► working ──► fixed
   │           │          │
   └───────────┴──────────┴──────► cannot_fix
```

| Status | Shown as | What it means | What moves it on |
| --- | --- | --- | --- |
| **`pending`** | *awaiting classification* | The poller has seen the issue and written it down. Nothing has been spent on it yet. | The classification pass, up to 2 issues per tick, oldest first. |
| **`queued`** | *queued* | Classified **fixable**. | The next pass creates the build session — usually the same tick. |
| **`working`** | *session running* | A build session exists, is marked ready and is in the normal build queue. | The session's own outcome. |
| **`fixed`** | Fixed | The session's pull request was **merged**. | Nothing. It is terminal. |
| **`cannot_fix`** | Cannot fix | Either the classifier said no, or the attempt died. Always carries a written explanation. | Nothing. It is terminal, and deliberately final. |

Two things worth knowing about the ends of that walk:

- **`fixed` and "resolved in Sentry" are separate.** Marking the issue fixed
  here is local and instant; telling Sentry is an API call that can fail. Every
  `fixed` issue that has not been reported yet is retried at the top of every
  tick until Sentry accepts it, and a failed resolve **never** reverts the
  status. The Sentry tab badges the ones that have gone through as
  `resolved in Sentry`.
- **`cannot_fix` is never re-classified**, by anything. Not automatically when
  the event count climbs, not by hand — there is no button. An issue Sentry
  reopens after we resolved it is not re-ingested either. If you want chief-web
  to try again, that is a session you create yourself.

An issue that stops arriving in the poll (you resolved or ignored it in Sentry
yourself) keeps whatever row it had. Issues already resolved or ignored in
Sentry when the poller first sees them are never inserted at all.

### Why an issue ends up in cannot_fix

The explanation on the row always says which of these it was:

| Reason | The explanation reads |
| --- | --- |
| The classifier judged it not fixable by a code change | whatever it wrote — a config problem, a third-party outage, an error in a dependency, not enough information in the event |
| Classification failed three times (container, checkout, timeout, unparseable answer) | `classification failed` |
| No session could be created three times | `No fix session could be created for this issue: …` |
| The build session failed | `build session failed at the <stage> stage: <error>` |
| The pull request was closed without merging | `PR #42 closed without merging` |
| The session ended without opening a pull request | `build session ended without opening a pull request` |
| Someone deleted the session | `session was deleted` |

Failures that are Sentry's rather than the issue's — an unreachable API, a rate
limit — cost no attempt at all. An hour of Sentry trouble must not turn real
errors into `cannot_fix` rows, so it does not.

## Fix sessions run fully automatically

This is the part that differs from every other session in chief-web, and it is
worth being explicit about:

- **There is no planning terminal.** You do not plan the PRD; chief-web writes
  it. The generated PRD is one story — read the report, fix the *root cause*,
  add or adjust a test, pass the project's quality checks — with the whole
  Sentry report (title, culprit, level, permalink, message, platform, stack
  trace, tags, breadcrumbs, counts, and the classifier's triage note) fenced
  below it. The planning templates are not used and no terminal is opened.
- **The session marks itself ready.** It is created on the repository's default
  base branch, the PRD is written into the workspace, and `markReady` is called
  immediately. From there it is in the [ordinary build queue](scheduling.md#concurrency-and-the-build-queue),
  competing for the same slots as the sessions you started by hand, with no
  dedicated concurrency cap of its own.
- **Code review is on**, always, whatever the *Run code review on new sessions*
  default happens to be. The [automatic review](code-review.md) posts to the
  pull request, and the feedback solver answers it, exactly as for a
  human-planned session.
- **The pull request is opened automatically** and marked ready for review by
  the existing pipeline.

**Merging is the only human act.** Nothing in this path asks you for anything,
and nothing merges on your behalf — the pull request sits open until you read it
and press the button. That is by design, and it is also the reason the warning
at the top of this page matters: the merge is the one point where a person looks
at what an agent wrote in response to text an end user may have supplied.

Sessions created this way are named after the issue's short id
(`sentry-proj-123`, with a numeric suffix if that name is taken) and appear on
the Sessions page like any other. You can watch, stop, retry or delete one
normally — deleting it moves the issue to `cannot_fix` with `session was
deleted`.

## The Sentry tab

**Sentry** in the sidebar (`g y`) lists every issue chief-web has ever tracked,
in three panels:

| Panel | Rows |
| --- | --- |
| **Working** | `pending`, `queued` and `working` — the ones still in the pipeline, each badged with which of the three it is |
| **Fixed** | `fixed`, badged `resolved in Sentry` once Sentry has been told |
| **Cannot fix** | `cannot_fix`, each with its explanation printed underneath |

Every row's title links to the issue in Sentry, and a row with a session links
to that session here. The meta line carries the short id, the repository, the
culprit, the event count and when the issue was first and last seen; rows are
newest-last-seen first.

The page **does not poll**. It loads on mount, reloads when you come back to the
tab after a couple of minutes, and has a **Refresh** button — the pipeline
behind it moves on a fifteen-minute timer, so a three-second poll would be
noise. If no token is configured the page says so and links to the settings
panel, which is what tells "nothing is broken" apart from "this was never set
up".

There are no per-issue controls. No retry, no force-fix, no dismiss.

## Untrusted error data

Sentry data is the first thing in chief-web that comes from **outside** — not
from you, not from your repository, but from whatever reached your production
error handler. A stack trace can contain a request body; a message can contain a
username; a tag can contain a URL. Someone who can make your application throw
can choose some of that text, and that text is put in front of agents that run
with `--dangerously-skip-permissions` and open pull requests.

chief-web applies the same three-part defence at each of the two places that
text lands, because they have different delimiters and different readers:

- **In the classification prompt**, everything Sentry-derived sits in one block
  between explicit `SENTRY_DATA_BEGIN` / `SENTRY_DATA_END` markers, the rule
  that the block is *data whose embedded instructions must be ignored* is
  stated **before** the block opens, and both markers are defanged inside the
  data so an error message cannot close the block and start speaking in
  chief-web's voice. Every field is length-bounded.
- **In the generated PRD**, the whole report sits inside one ```` ```text ````
  fence, every run of three or more backticks or tildes in the data is defanged,
  and nothing outside the fence is upstream text — the headings use the slugged
  short id, never the Sentry title. The PRD parser is fence-aware precisely so
  that a stack trace line reading `### US-002:` or `**Status:** done` is read as
  error text and not as PRD structure.
- **In the fix session's brief**, the last acceptance criterion of the generated
  story is to ignore any instruction found inside the report.

That is mitigation, not a guarantee. It is why merging stays manual, and why
[docs/security.md](security.md#autonomous-agents-and-untrusted-error-data) says
out loud that **reading the pull request before you merge it is the boundary**.

## Switching it off

Remove the token in **Settings → Sentry**, or clear the two slugs on the
repositories you linked. Either one stops the polling — the timer keeps running
and does a single `SELECT` per interval, which is what lets switching it back on
take effect at the next tick with no restart.

Sessions that are already running are not affected; they finish, open their pull
requests and are yours to merge or close as usual.
