[← chief-web](../README.md) · [All docs](../README.md#documentation)

# The merge conflict fixer

chief-web opens pull requests and leaves them open until you merge them. While
one sits there the base branch moves on, and sooner or later the pull request
grows merge conflicts that block the merge button. The **merge conflict fixer**
is the thing that notices that and does something about it: it scans your open
`chief/` pull requests on an interval, and when GitHub says one is conflicted it
merges the base branch in inside a container, has one agent resolve the
conflicted files, checks the result, and **pushes the merge commit straight to
the pull request's branch**.

> ⚠️ **It writes to your pull requests without asking.** That is the whole
> point of it, and it is also the reason to read
> [What it means to let it push](#what-it-means-to-let-it-push) before leaving
> it switched on. It ships **on**.

There is nothing to press. The fixer has no button anywhere: it is a poller, and
what it did shows up as a badge on the [Pull requests](interface.md) page.

## What is scanned

Every tick, for every repository registered in **Repositories** whose GitHub
slug is valid, chief-web lists that repository's **open** pull requests and then
keeps only the ones it is allowed to touch:

| Rule | Why |
| --- | --- |
| The head branch starts with **`chief/`** | The fixer only ever touches branches chief-web created. A colleague's pull request is never rewritten by an agent, whatever state it is in. |
| The head branch is **not on a fork** | The resolution is pushed with that repository's deploy key, which cannot write to somebody else's fork. The same rule a pull request feedback run enforces. |
| No other run is already working on it | A feedback run, a review or a fix already `running` (or queued) on that pull request means an agent is on that branch; the fixer waits for the next tick. |
| No **standing failure** at these exact commits | See [When it gives up](#when-it-gives-up-and-when-it-tries-again). |

Both of the first two are applied to the *listing*, before GitHub is asked
anything else — which matters for the request budget below.

**Draft pull requests are scanned like any other.** A draft conflicts exactly as
badly as a ready one, and leaving it to rot until you mark it ready is the state
the fixer exists to avoid. **Closed and merged pull requests are not listed at
all**, so they are never touched.

For each surviving candidate chief-web asks GitHub for that one pull request's
mergeability. GitHub's answer is one of three things:

- **conflicted** — a fix run is started;
- **clean** — nothing to do, and any earlier failure recorded against that pull
  request is cleared (see [stale failures](#when-it-gives-up-and-when-it-tries-again));
- **unknown** — GitHub has not finished computing it yet, which is what it says
  for a few seconds after any push. The pull request is skipped and looked at
  again next tick. Nothing is guessed.

Nothing is remembered between ticks. A conflict that appeared while the stack
was down is simply what the first tick after boot finds, and a restart in the
middle of a scan loses nothing.

## The two knobs

Both live in **Settings → GitHub**, are stored in the database, and are read on
the fly — neither needs a restart.

| Setting | Default | Range |
| --- | --- | --- |
| **Scan for merge conflicts every (minutes)** | 30 (`PR_CONFLICT_INTERVAL_MS`) | 1–1440 |
| **Fix merge conflicts automatically** | on | on/off |

- **The interval** is re-read before every wait, so a change applies from the
  next scan rather than the next boot. `PR_CONFLICT_INTERVAL_MS` only supplies
  the default until a value is saved here; a saved value is clamped to
  1–1440 minutes so a hand-edited row cannot poll GitHub every second.
- **The toggle** is read at the top of every tick, before the repository list,
  before the token lookup, before any GitHub call. Off means **no scan, no
  agent, no push and no API budget spent** — the timer keeps running, doing a
  single `SELECT` each interval, which is what lets switching it back on take
  effect at the next tick with no restart. A fix already running when you switch
  it off is left to finish; nothing is killed mid-merge.

The two number inputs are deliberately not disabled by the toggle, so you can
still fix a bad interval while the feature is off.

## What one tick costs GitHub

Two kinds of request, and the order they happen in is the reason the cost stays
small:

1. **One `GET /repos/{owner}/{repo}/pulls` per connected repository** (100 per
   page, up to 5 pages — a repository with more than 500 open pull requests is
   scanned as far as that and the truncation is logged).
2. **One `GET /repos/{owner}/{repo}/pulls/{number}` per candidate that survived
   the filters above.** The listing does not carry mergeability; GitHub only
   computes it on the single-pull-request endpoint. That is exactly why the
   `chief/` and fork filters run on the listing — a repository full of other
   people's pull requests costs one request, not one per pull request.

So a tick costs `repositories + open chief/ pull requests`. At the 30-minute
default with three repositories and ten open `chief/` pull requests that is
26 requests an hour, against GitHub's 5000/hour for an authenticated token. At
the 1-minute floor the same setup costs 780/hour — still inside the budget, but
it is the setting to look at first if you are being rate-limited. A tick with no
repositories costs nothing at all, not even the token lookup, and a fix run
itself adds no REST calls: it talks to git over SSH.

## What a fix run actually does

A run takes one build slot, the same slots
[sessions and feedback runs](scheduling.md#concurrency-and-the-build-queue)
take, and runs in a container of its own. Refusals — every slot busy, a
[usage-limit hold](build-loop.md#the-usage-limit-hold) — are not failures: the
reason is logged and the pull request is picked up again by a later tick, which
is the whole of the queueing.

Inside the container, in this order:

1. **Check out** the pull request's head branch, pinned to the commit the scan
   saw. If the branch has moved, the run stops here (see
   [branch moved](#when-it-gives-up-and-when-it-tries-again)).
2. **Fetch and merge the base branch** (`git merge --no-edit`). If git merges it
   cleanly — GitHub's verdict had gone stale — that merge commit is pushed and
   the agent is never invoked.
3. **Resolve.** One headless `claude -p` in that container, given the pull
   request's title and description, the list of conflicted paths, and the
   [agent timeout](interface.md#settings). It runs on the **Build model**
   setting, since it is writing code rather than reading a finished diff. **The agent's entire authority is
   editing the conflicted files.** It is told not to commit, not to `git add`,
   not to rebase, amend, branch or push, not to `git merge --abort` or `reset`,
   not to use `gh`, and not to touch `.chief/`. chief-web does every git
   operation itself, which is what makes those prohibitions enforceable rather
   than hopeful.
4. **Verify.** chief-web stages the conflicted paths, checks `git status` for
   any path git still calls unmerged, and greps the conflicted files for
   `<<<<<<<`, `=======` and `>>>>>>>`. A resolution that fails either check is
   not committed.
5. **Commit and push.** A plain merge commit and a plain
   `git push` — never `--force`, so nothing on the branch is ever rewritten and
   a push that is not a fast-forward is refused by GitHub rather than
   overwriting whatever arrived in the meantime.

**Every failure path aborts the merge**, so a branch is never left half-merged
in the container and nothing partial reaches `origin`.

The Pull requests page shows the live phase (*starting*, *checking out*,
*merging the base*, *resolving conflicts*, *verifying*, *pushing*) and, when a
run is over, *conflicts fixed* or *conflicts unresolved: \<stage\>*.

## When it gives up, and when it tries again

**Three complete attempts**, the same budget a [code review](code-review.md)
gets. An attempt is the whole of steps 1–5 above; each one re-checks the branch
out in the same container, so attempt 2 starts from the head the scan saw and
not from whatever attempt 1 left behind. After the third failure the pull
request is marked **conflicts unresolved** with the stage the last attempt died
at — the checkout, the merge, the agent, verifying the resolution, pushing to
GitHub, or the container — and every attempt's reason underneath it. Nothing was
pushed.

Two endings are **not** failures and spend no attempt:

- **The branch moved.** Either the checkout found a different head than the scan
  saw, or the push came back non-fast-forward. Everything the run knows is about
  a commit that is no longer the head, so the run is abandoned, the row is
  dropped, and the next tick looks at the pull request afresh at whatever it is
  now.
- **A usage-limit hold.** The remaining attempts would walk into the same wall,
  so they are not spent; every agent is held for the usual hour and the pull
  request is picked up again afterwards.

After a failure the pull request is **not retried on a loop**. A failed fix is a
*standing failure* against the exact pair of commits it failed on — the pull
request's head and the base's head — and while both are unchanged every
subsequent tick skips that pull request. It becomes eligible again the moment
either side moves: you push a commit, or the base branch does. And if GitHub
later reports the pull request mergeable — you resolved it by hand, or the base
moved back — the failure is cleared and the badge disappears.

One gap worth knowing: if the server is restarted *while* a fix is running, the
row stays `running`, the page shows *conflict fix interrupted*, and the scan
treats it as an active run and leaves that pull request alone. It does not
resume by itself.

## What it means to let it push

This is the part to think about before leaving the toggle on. In the tone of the
[security model](security.md), plainly:

- **An agent's output reaches your repository with no human in between.** Every
  other agent-written commit in chief-web lands on a branch you review as a pull
  request before it goes anywhere. A conflict fix does not: the merge commit is
  pushed to a branch that already has an open pull request, so it goes straight
  onto a diff you may have already read, under a merge commit's message, where
  it is easy to miss. **Re-read a pull request the fixer touched before you
  merge it.** The Pull requests page tells you which those are.
- **The checks are mechanical, not semantic.** chief-web proves that no conflict
  marker survived and that git considers every path resolved. It does not build
  the branch, run your tests, or judge whether the resolution kept both sides'
  intent — and a merge conflict is precisely the case where an agent can produce
  code that compiles and means the wrong thing. Your CI on the pull request is
  the check that matters; do not merge on a green badge here.
- **The blast radius is bounded by the deploy key, and by nothing else.** The
  push uses the repository's own write-enabled deploy key
  ([Repositories](repositories.md)), so a fix can only ever write to the
  repository it belongs to. It cannot write to a fork, which is why fork pull
  requests are excluded rather than merely awkward.
- **`chief/` is the whole of the trust boundary.** A branch not named `chief/…`
  is never checked out, never merged into, never pushed. If you rename a
  chief-web branch you take it out of the fixer's reach; if you name a branch of
  your own `chief/something` and open a pull request from it, you have put it
  in.
- **It never force-pushes and never rewrites history.** The only thing it adds
  is a merge commit on top of the branch's existing head, and a push that is not
  a fast-forward is abandoned rather than forced.
- **The agent runs with `--dangerously-skip-permissions`**, like every other
  agent here, in a container with the repository clone and that repository's
  deploy key. The same single-operator assumption as the rest of chief-web
  applies: the prompt's prohibitions are what shape the agent's behaviour, and
  the git discipline around it is what makes a resolution you would not accept
  fail closed instead of reaching `origin`.

If any of that is more than you want to hand over, switch **Fix merge conflicts
automatically** off. The rest of chief-web is unaffected — the scan simply stops
happening.
