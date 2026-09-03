[← chief-web](../README.md) · [All docs](../README.md#documentation)

# Code review

A session with **code review** switched on does one more thing after it opens
its pull request: a single headless `claude -p` pass over the branch's diff,
posted to that pull request as one GitHub review. It is the same agent in the
same container the build ran in — one more invocation, at the one moment where
the whole feature exists and nothing is half-written.

There is also a **Review** button on every open pull request on the Pull
requests page, which runs the same pass by hand — on any pull request, whether
or not chief-web built it. See [Reviewing an open pull request by hand](#reviewing-an-open-pull-request-by-hand).

Either way there are no findings anywhere in this app. **The comments live on
the GitHub pull request and only there.**

## Switching it on

There are two controls, and they do different things.

| Control | Where | What it decides |
| --- | --- | --- |
| **Code review** | the new-session form, and the **Code review** panel on `/sessions/<id>` | Whether *this* session is reviewed |
| **Run code review on new sessions** | [Settings → Models](interface.md#settings) | The value the checkbox above starts at |

The per-session flag is the one that is read when the pull request is opened, so
it can be changed at any point in the session's life — while it is planning,
building, waiting or failed. The panel on the session page shows `on`/`off` as a
badge and toggles with one click. Once a session is **finished** the checkbox is
disabled and says why: the pull request has already been opened, so there is
nothing left for the flag to change. A session that failed *at* the review is
`failed`, not finished, so its flag is still live — switching it off there means
the next **Retry** simply finishes the session without a review.

The setting is only a default. It seeds the checkbox on the new-session form and
is applied server-side to any session created through `POST /api/sessions`
without a `codeReview` field, so the API behaves like the form. Sessions that
already exist are never revisited when it changes.

## The review model

**Settings → Models → Review** picks which model the review runs on,
independently of the planning and build models. The choices are Claude Code's
own `--model` aliases (`opus`, `sonnet`, `haiku`, `fable`) and the default is
**Let Claude Code choose**, which passes no `--model` at all.

It is read when the review starts, so changing it applies to the next review with
no restart. Reading a finished diff is a different job from writing the feature —
that is the reason it is its own setting rather than the build model.

The review is also held to the **Agent timeout** in Settings, the same cap as one
build iteration.

## What the pass actually does

Inside the session's container (started again if it had been stopped):

1. `git fetch origin <PR target branch>` and `git diff origin/<target>...HEAD` —
   the review sees the branch as the pull request presents it, not the working
   tree.
2. The agent reports correctness bugs and clear quality problems, and **changes
   nothing**: no edits, no commits, no push, no `gh`. It writes one JSON document
   next to the clone — deliberately outside it, so a stray `git add -A` cannot
   put the review on the pull request as a file.
3. chief-web reads that document and posts it. A document it cannot parse is a
   failed attempt, never a partial review.

The result is **one review, always of type `COMMENT`**. chief-web cannot approve
a pull request and cannot request changes on one; the event type is hardcoded.
Findings that anchor to a line in the diff become inline comments on that line;
findings that do not — a line outside the hunks, a file the pull request does not
touch — are folded into the review body under **Other findings** with their
`path:line`, so nothing the agent found is dropped. A review that flags nothing
is still posted, as a short body saying so.

There is no cap on how many findings one review may carry.

## Attempts, failure and Retry

The review is the third delivery step, after the push and the pull request, and
it is the only one of the three that is retried by itself:

- **Three complete attempts.** One attempt is the whole pass — run the agent,
  then post what it found — so a GitHub call that failed costs a fresh look at
  the diff rather than a re-post of a stale document.
- **A usage limit stops early.** The next attempt would hit the same wall, so the
  remaining ones are not spent.
- **After the third failure the session is `failed` at the `review` stage**, with
  every attempt's reason on it. The pull request URL is stored on the session
  *before* the review runs, so the link survives the failure and the pull request
  itself is untouched and complete.
- **Retry re-runs the review alone**, with three fresh attempts. Nothing is
  rebuilt and nothing is pushed again — the branch and the pull request are
  already on `origin`, and an existing pull request is adopted, never duplicated.
  Turning the flag off before retrying simply finishes the session.

See [Failure and recovery](build-loop.md#failure-and-recovery) for the stage
table and [Recovering a failed session](troubleshooting.md#recovering-a-failed-session)
for what to check first. A review failure is usually one of two things: the
GitHub token can no longer write to the repository, or the agent could not run
(no Claude Code login, a container that will not start, a timeout).

## The hand-off to the feedback run

**A review that flagged something starts a pull request feedback run on its own**,
exactly as pressing **Start** on the Pull requests page does. The run appears in
that list with its usual status and phases, and is stopped or retried there like
any other — chief-web has no second implementation of it.

- A review that found nothing starts nothing.
- A review that never got posted starts nothing.
- The run is *not* part of the delivery. If it is refused — every build slot in
  use, a closed pull request, a usage-limit hold — the reason is logged and added
  to the delivery's message, and the session still ends **finished**. The
  feedback run can be started by hand afterwards.

The delivery waits only for the run to *start*, not to finish, so a session does
not sit in delivery while an agent works through the comments.

## Reviewing an open pull request by hand

**Review** on a row of the Pull requests page runs the same pass on that pull
request, right now, without a session: same prompt, same review model, same
`COMMENT` review posted the same way, same hand-off to the feedback run when it
flags something. The difference is where it runs. A session's review reuses the
session's container and clone; this one has neither, so it gets a container of
its own, the way a feedback run does, and checks the pull request's head branch
out into it first.

What happens after the confirmation:

1. The pull request is read from GitHub. A closed or merged one is refused, and
   so is one whose branch lives on a fork — the clone is made with the
   repository's deploy key, which cannot read another repository.
2. A container is started for the review and the head branch is checked out at
   the commit GitHub reported. If someone pushed in between, the review fails at
   the checkout rather than reviewing a diff nobody asked about; start it again.
3. The pass runs and the review is posted. The row then shows **reviewed** with
   the number of findings, a link to the review on GitHub, and what became of
   the feedback run it started.
4. The container is removed. The workspace and clone stay on the data volume
   under the review's id, so a second review of the same pull request reuses
   them.

It takes one build slot while it runs, and is refused — like a feedback run —
when every slot is taken or Claude's usage limit is being waited out. A pass
that hits the limit itself holds every agent for the usual hour.

Unlike a session's review it is **single-shot**: one attempt, and a failure
shows on the row with the stage it failed at (the checkout, the agent, the
findings, posting to GitHub, or the container). Pressing **Review** again is the
retry. **Stop review** signals the agent and posts nothing.

## What it needs

- The **GitHub Personal Access Token** in Settings, with write access to pull
  requests on that repository — the same token that opened the pull request.
- Claude Code signed in ([Claude authentication](claude-auth.md)): the review is
  a headless `claude -p`, so an unauthenticated CLI fails all three attempts.
  It is the only part of delivery that needs Claude at all — the push and the
  pull request do not.
- A pull request that exists. The review never opens one and never pushes.
- For a review started by hand: a pull request whose branch is on the
  repository itself, so the deploy key can clone it.
