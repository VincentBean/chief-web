[← chief-web](../README.md) · [All docs](../README.md#documentation)

# The Sentry auto-fixer

chief-web can watch a Sentry project and propose fixes for the errors it finds
there. Every fifteen minutes it lists the unresolved issues of every linked
project and spends one cheap Claude Code call per new issue deciding whether it
is the kind of thing a code change fixes — and, when it is, writing a short
**fix plan**.

That is where the automatic part stops. **Nothing here opens a pull request by
itself.** The plan waits on the Sentry tab until you approve it (editing it
first if you like) or reject it. You then tick the approved issues you want
built, press **Create fix session**, and the whole batch becomes *one* ordinary
build session with a generated PRD holding a story per issue. That session
builds, opens **one** pull request for the batch, gets reviewed and answers its
own review feedback like any other. When you merge it, every issue in the batch
is marked **fixed** here and resolved in Sentry.

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
| **`event:write`** | marking an issue resolved | `PUT /organizations/{org}/issues/{id}/` with `{"status":"resolved"}`, sent when a fix is merged and when you reject a plan |

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
| **Planning model** | `haiku` | The model that triages each new issue and writes the fix plan you approve. |
| **Plans per poll** | 2 | How many issues are planned per poll, across every repository. 1–10. |
| **API base URL** | `https://sentry.io/api/0/` | Only for self-hosted Sentry. Blank restores the hosted API. |

All five are read on the fly — **none of them needs a restart**. The interval is
re-read before every wait, so a change applies from the next poll; the plan cap
is read inside the planning pass itself, so a change applies from the next tick;
the token, the model and the base URL are read at the moment they are used, so
saving a token starts the integration at the next tick, and removing one stops
it.

Bad values are refused twice over: the form and the API reject them, and the
readers behind them clamp or fall back to the defaults, so a value written
straight into the database cannot wedge the poller either.

#### The planning model

Every new issue costs one short, read-only Claude Code call — a checkout of the
repository's base branch, the Sentry report, and two questions: can this be
fixed with a code change in this repository, and if so, what would that change
be? The answer is a verdict plus a plan of at most ten lines of plain prose —
root cause, the files or areas to change, what the change would do. A "fixable"
answer that comes back without a plan is thrown away and the issue is tried
again, because a plan you cannot read is not a plan you can approve.

That call runs on the **Planning model**, `haiku` by default, and that is the
whole reason the setting exists: it is a triage pass over many issues, most of
which are not going to be worth a session, so it should be the cheapest model
that can read a stack trace. There is no "let Claude Code choose" option here —
this call always names a model.

**The fix itself does not run on it.** The session you create from approved
plans is an ordinary session and uses the **Build** model, the **Review** model
and the agent timeout from [Settings → Models](interface.md#settings) like every
other session.

#### The polling interval

One tick, at the default of fifteen minutes, costs Sentry:

- **one issues-list call per linked project** (100 issues a page, up to 20
  pages), plus
- **one issue call and one latest-event call per issue being planned**, capped
  by the **Plans per poll** setting — 2 by default, counted across every
  repository, oldest first — plus
- **one resolve call per issue that still owes Sentry one**, which is every
  merged fix *and* every rejected plan.

So a tick over three linked projects costs at most about ten requests, which is
nowhere near Sentry's limits. Lowering the interval mostly shortens the delay
between an error appearing and a plan landing in front of you; it does not make
planning go faster, because **Plans per poll** is what paces that — raise that
setting instead, up to 10 per tick. A tick with nothing linked costs nothing —
not even the token lookup.

**Planning is the only spend that happens without you.** One Claude Code call
per issue, capped by that setting, is the entire automatic cost of the
integration: no session is created and no pull request is opened until you
approve a plan and ask for one.

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

Every issue chief-web has ever seen is a row with one of six statuses. It only
ever moves forward, and the two middle steps are yours:

```
pending ──► planned ──► approved ──► working ──► fixed
   │           │            │           │
   └───────────┴────────────┴───────────┴──────► cannot_fix
```

| Status | Shown as | What it means | What moves it on |
| --- | --- | --- | --- |
| **`pending`** | *awaiting plan* | The poller has seen the issue and written it down. Nothing has been spent on it yet. | The planning pass, **Plans per poll** issues per tick, oldest first. |
| **`planned`** | *plan proposed* | Triaged **fixable**, with a proposed fix plan attached. It is waiting on you and nothing else. | **Approve** or **Reject** on the Sentry tab. Nothing moves it on its own, ever. |
| **`approved`** | *approved, awaiting a session* | You approved the plan, as proposed or as you edited it. Still nothing built. | Ticking it into a batch and pressing **Create fix session**. |
| **`working`** | *session running* | A build session covering this issue — and possibly others in the same batch — exists, has been marked ready and started, and is building or waiting in the normal build queue. | The session's own outcome, for the whole batch at once. |
| **`fixed`** | Fixed | The batch's pull request was **merged**. | Nothing. It is terminal. |
| **`cannot_fix`** | Cannot fix | The planner said no, you rejected the plan, or the attempt died. Always carries a written explanation. | Nothing. It is terminal, and deliberately final. |

`planned` and `approved` are the two statuses no timer can move. An issue can
sit on `planned` for a week; nothing re-plans it, nothing builds it, and it
costs nothing while it waits.

Three things worth knowing about the ends of that walk:

- **A whole batch moves together.** Every issue that shares a session leaves
  `working` in the same beat, with the same outcome — see
  [a batch is all-or-nothing](#a-batch-is-all-or-nothing).
- **Being finished here and "resolved in Sentry" are separate.** Marking the
  issue fixed — or rejected — here is local and instant; telling Sentry is an
  API call that can fail. **A rejected plan owes Sentry a resolve call exactly
  as a merged fix does**, and for a plainer reason: an issue we are never going
  to fix has to be closed upstream, or the next poll fetches it straight back
  and pays for another plan. Both kinds are retried at the top of every tick
  until Sentry accepts them, one call per issue with its own retry, and a
  failed resolve **never** reverts the local status. The Sentry tab badges the
  ones that have gone through as `resolved in Sentry`.
- **`cannot_fix` is never re-planned**, by anything. Not automatically when the
  event count climbs, not by hand — there is no button. An issue Sentry reopens
  after we resolved it is not re-ingested either. If you want chief-web to try
  again, that is a session you create yourself.

A verdict the planner reached on its own — "this is a configuration problem",
"this is an outage at a third party" — is the one `cannot_fix` that owes Sentry
nothing: that issue was never fixed and was never decided on by you, so it is
left unresolved upstream for a human to deal with there.

An issue that stops arriving in the poll (you resolved or ignored it in Sentry
yourself) keeps whatever row it had. Issues already resolved or ignored in
Sentry when the poller first sees them are never inserted at all.

### Why an issue ends up in cannot_fix

The explanation on the row always says which of these it was:

| Reason | The explanation reads |
| --- | --- |
| The planner judged it not fixable by a code change | whatever it wrote — a config problem, a third-party outage, an error in a dependency, not enough information in the event |
| **You rejected the proposed plan** | `plan rejected: <the reason you typed>` |
| Planning failed three times (container, checkout, timeout, an unparseable answer, a fixable verdict with no plan) | `classification failed` — the stored wording predates the rename |
| The session could not be created three times | `No fix session could be created for this issue: …` |
| The build session failed | `build session failed at the <stage> stage: <error>` |
| The pull request was closed without merging | `PR #42 closed without merging` |
| The session ended without opening a pull request | `build session ended without opening a pull request` |
| Someone deleted the session | `session was deleted` |

Failures that are Sentry's rather than the issue's — an unreachable API, a rate
limit — cost no attempt at all. An hour of Sentry trouble must not turn real
errors into `cannot_fix` rows, so it does not.

The last five reasons are batch-wide. A session that could not be created costs
every issue you ticked an attempt, and the four after it are the session's
outcome — which is the outcome of every issue it was fixing.

## From plan to pull request

Four steps, and two of them are yours.

### 1. chief-web proposes a plan

The planning pass takes the oldest `pending` issues — **Plans per poll** of them
per tick — and asks the planning model its two questions in a read-only checkout
of the repository's base branch. A fixable verdict writes the plan onto the
issue and moves it to `planned`. Nothing else happens: no session, no branch, no
pull request, no further spend.

### 2. You approve or reject it

**Needs your decision** on the [Sentry tab](#the-sentry-tab) prints each
proposed plan in full, under the issue it belongs to.

- **Approve** moves the issue to `approved`. Press **Edit plan** first if the
  proposal is wrong in a detail you can fix — an edited plan is the plan the
  session is built from, and an untouched one is approved exactly as it stands.
  Approving is a decision, not a start: nothing is built yet.
- **Reject** asks for a reason and moves the issue to `cannot_fix` with
  `plan rejected: <your reason>`, and marks it for resolving in Sentry so the
  poller cannot fetch the same error back next tick and pay for another plan.

A decision is final. There is no un-approve and no un-reject; both calls refuse
anything that is not `planned`, so a second click on a decided row is an error
rather than a second decision.

### 3. You pick a batch

The **Approved** section gives every row a checkbox and puts a **Create fix
session** button above them. Tick between 1 and 10 issues — **all in the same
repository**, because one session is one branch — and press it. The
confirmation names the repository and lists the short ids about to be built.

### 4. One session, one pull request

The batch becomes a single build session, and that session is where this flow
differs from every other one in chief-web:

- **There is no planning terminal.** You do not plan the PRD; chief-web writes
  it. The generated PRD holds one story per issue, in the order you ticked them
  — read the report, fix the *root cause*, follow the approved plan, add or
  adjust a test, pass the project's quality checks — with the approved plan and
  the whole Sentry report (title, culprit, level, permalink, message, platform,
  stack trace, tags, breadcrumbs and counts) fenced below each story. The
  planning templates are not used and no terminal is opened.
- **The session marks itself ready and starts itself.** It is created on the
  repository's default base branch, the PRD is written into the workspace,
  `markReady` is called immediately, and then the session is started exactly as
  the **Start** button starts one by hand. From there it is in the
  [ordinary build queue](scheduling.md#concurrency-and-the-build-queue),
  competing for the same slots as the sessions you started yourself, with no
  dedicated concurrency cap of its own — a full server, or Claude's usage limit,
  simply leaves it waiting in that queue until a slot frees.
- **Code review is on**, always, whatever the *Run code review on new sessions*
  default happens to be. The [automatic review](code-review.md) posts to the
  pull request, and the feedback solver answers it, exactly as for a
  human-planned session.
- **One pull request covers the whole batch.** It is opened automatically and
  marked ready for review by the existing pipeline. Ten issues fixed one at a
  time would be ten pull requests and ten reviews of near-identical diffs, and
  a reviewer reading ten of those reads none of them properly — sparing you
  that is the entire point of batching.

Sessions created this way are named `sentry-<short-id>` for a single issue and
`sentry-batch-<yyyymmdd>` for several (with a numeric suffix if that name is
already taken), and they appear on the Sessions page like any other. You can
watch, stop, retry or delete one normally.

### A batch is all-or-nothing

The session is the unit of work, so it is also the unit of outcome: **the
session's result decides every issue in the batch, together.**

- **Merged** → every issue in the batch becomes `fixed`, and each is then
  resolved in Sentry on its own call, with its own retry.
- **Failed, or its pull request closed unmerged, or it opened none at all, or
  you deleted it** → every issue in the batch becomes `cannot_fix`, carrying the
  same explanation (`session was deleted`, `PR #42 closed without merging`, …).

Nothing reads the individual stories out of the PRD to decide this. A story the
agent left `todo` inside a merged pull request is something the code review
should have caught; it is not a reason to leave one issue of a merged batch
open.

Creating the session is all-or-nothing too. If anything goes wrong while it is
being set up — the repository will not clone, the PRD cannot be written — the
half-created session is discarded and *every* issue of the batch goes back to
`approved` with one more attempt against it, so pressing the button again is
the whole retry. At three failed attempts an issue drops out to `cannot_fix`
with the failure named.

### The two human gates

**Approving a plan is the first human act, and merging is the last.** Nothing
in between asks you for anything, and nothing merges on your behalf — the pull
request sits open until you read it and press the button. That is by design,
and it is also the reason the warning at the top of this page matters:

- **Approving** is the first gate, and it is where you decide that this error is
  worth changing code over and that the change described is roughly the right
  one. The plan was written by a model that had just read attacker-influenceable
  text, so read it as a proposal, not as a finding.
- **Merging** is the last gate, and the real safety boundary: it is the one
  point where a person looks at what an agent actually wrote in response to that
  text. Approving a plan narrows what gets attempted; it does not review a diff,
  and nothing about this flow makes reading the pull request optional.

## The Sentry tab

**Sentry** in the sidebar (`g y`) lists every issue chief-web has ever tracked,
in five panels — one per status, except that `pending` and `working` share one:

| Panel | Rows |
| --- | --- |
| **Needs your decision** | `planned` — each with its proposed plan printed in full, **Edit plan**, **Approve** and **Reject** |
| **Approved** | `approved` — each with a checkbox, and **Create fix session** above them |
| **Working** | `pending` and `working` — the ones chief-web is doing something about without you, badged with which of the two it is |
| **Fixed** | `fixed`, badged `resolved in Sentry` once Sentry has been told |
| **Cannot fix** | `cannot_fix`, each with its explanation printed underneath — including the reason you typed when you rejected a plan |

Every row's title links to the issue in Sentry, and a row with a session links
to that session here. The meta line carries the short id, the repository, the
culprit, the event count and when the issue was first and last seen; rows are
newest-last-seen first.

The page **does not poll**. It loads on mount, reloads when you come back to the
tab after a couple of minutes, and has a **Refresh** button — the pipeline
behind it moves on a fifteen-minute timer, so a three-second poll would be
noise. Your own decisions do not wait for that: an approval or a rejection
updates its row in place, and creating a session reloads the list, so the issues
you just batched appear under **Working** with the session linked. If no token
is configured the page says so and links to the settings panel, which is what
tells "nothing is broken" apart from "this was never set up".

The controls are the decision buttons and the batch checkboxes, and that is all.
There is no retry, no force-fix and no dismiss, and a decided issue is never
offered for decision again.

## Untrusted error data

Sentry data is the first thing in chief-web that comes from **outside** — not
from you, not from your repository, but from whatever reached your production
error handler. A stack trace can contain a request body; a message can contain a
username; a tag can contain a URL. Someone who can make your application throw
can choose some of that text, and that text is put in front of agents that run
with `--dangerously-skip-permissions` and open pull requests.

chief-web applies the same three-part defence at each of the two places that
text lands, because they have different delimiters and different readers:

- **In the planning prompt**, everything Sentry-derived sits in one block
  between explicit `SENTRY_DATA_BEGIN` / `SENTRY_DATA_END` markers, the rule
  that the block is *data whose embedded instructions must be ignored* is
  stated **before** the block opens, and both markers are defanged inside the
  data so an error message cannot close the block and start speaking in
  chief-web's voice. Every field is length-bounded.
- **In the generated PRD**, each story's report sits inside one ```` ```text ````
  fence and its approved plan inside another, every run of three or more
  backticks or tildes in either is defanged, and nothing outside those fences is
  upstream text — the headings use the slugged short id, never the Sentry title.
  The PRD parser is fence-aware precisely so that a stack trace line reading
  `### US-002:` or `**Status:** done` is read as error text and not as PRD
  structure. That holds for the plan as well: it is model output about
  attacker-influenceable text, so it is fenced like the report, whether the
  words in it are the planner's or the ones you typed over them.
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
