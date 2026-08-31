[← chief-web](../README.md) · [All docs](../README.md#documentation)

# The build loop

**Start build** turns a **ready** session into a **building** one and hands it to
the Ralph loop (`server/src/build/`) — or, when every build slot is taken, into
the [FIFO queue](scheduling.md#concurrency-and-the-build-queue). One iteration is:

1. Re-read `prd.md`, sync the `stories` table, and pick the story with the
   lowest priority number that is not `done`.
2. Write `**Status:** in-progress` for that story, into the file *and* the row.
3. Exec `claude --dangerously-skip-permissions --output-format stream-json --verbose -p "<prompt>"`
   in `/workspace/repo` inside the session container, with `--model` in front
   when a build model is set (**Settings → Build model**). The prompt is chief's
   `embed/prompt.txt`, ported verbatim into `server/src/build/templates.ts`,
   with the story inlined as JSON plus a chief-web addendum carrying the PRD's
   own context, the current `progress.md`, and what the agent has to leave
   behind: a commit `feat: US-xxx - <title>`, `**Status:** done` with the
   acceptance criteria checked off in `prd.md`, and a learnings entry appended
   to `.chief/prds/<session-name>/progress.md`.
4. Re-read `prd.md` and `git rev-parse HEAD`. A story that is `done` in the file
   is done; a HEAD that moved is recorded as that story's commit SHA. Nothing is
   taken on the agent's word.

The loop stops itself in five ways:

- **Completion.** Every story `done` hands off to the delivery step below,
  which pushes the branch and opens the pull request.
- **A stalled story.** An iteration that produces neither a status change nor a
  commit is retried twice; the third one marks the session **failed** with the
  agent's last output in `last_error`.
- **An iteration that runs out of time.** One headless `claude -p` may run for
  **30 minutes** by default, configurable per iteration on the settings page
  (1–720 minutes). An iteration cut short counts as a failed attempt exactly
  like a stalled one — even if it committed something — so the same two retries
  apply and the third failure ends the run. The agent it gave up on is *reaped*
  first (`SIGTERM`, ten seconds, `SIGKILL`), because the timeout itself only
  closes chief-web's end of the exec: the Docker Engine API cannot kill an
  exec, so without this the agent — and every test run and database server it
  started — would still be in the container, holding the clone, when the retry
  started a second agent in the same working tree. Each iteration records its
  pid under a file of its own, so an agent that outlives its iteration stays
  addressable. A run sweeps the container once before its first iteration too,
  for the case where the *server* was restarted mid-iteration.
- **The iteration cap.** A run may take the outstanding stories plus 50%, never
  fewer than 10. A loop that is committing but never finishing anything hits it
  and fails, rather than churning forever.
- **Stop build.** The running agent is signalled (`SIGTERM`, via a pid file it
  writes inside the container) and the session goes back to **ready**.
  Everything already committed is kept, so a stopped build resumes rather than
  restarts. An agent that has not gone by the time the loop stops waiting for
  it is reaped, so the session is never made startable again while a previous
  agent is still in its workspace.

Not one of them: **a Claude usage limit.** An iteration refused because the
account is out of usage has produced neither a status change nor a commit, so it
looks exactly like a stalled story, and it was cut off part-way, so it looks
something like an iteration that ran out of time. It is neither. Nothing is
wrong with the build, nothing would be different if it were tried again
immediately, and there is nothing for an operator to fix — so the session is
**paused**, not failed, and the pause costs it neither a retry nor an iteration.
See [The usage-limit hold](#the-usage-limit-hold).

A **failed** session shows the stored reason at the top of its page, along with
the **stage** it failed at, and one **Retry** button. See
[Failure and recovery](#failure-and-recovery).

## The live log

The agent is asked for `stream-json` rather than the default text format,
because the default prints nothing until the process exits — which for one
iteration is up to half an hour by default. Each event is rendered into a readable line as it
arrives and goes to two places at once:

- **`.chief/prds/<session-name>/agent.log`** in the workspace, next to the PRD
  and `progress.md`. The file is the log: it outlives the container, the server
  and the browser tab, and it is what the per-iteration history is read back
  from. Each iteration is delimited by
  `=== chief-web iteration <n> | <story> | <timestamp> ===` markers, and the
  clone's `.git/info/exclude` is told to ignore the file so no agent can commit
  chief-web's own log alongside its work.
- **`ws://…/api/sessions/<id>/build/log`**, the WebSocket the session page
  attaches to. Attaching replays every section written so far and then follows,
  so opening the page mid-build, reloading it, or coming back the next day all
  show the same thing. The view auto-scrolls while you are at the bottom and
  pauses as soon as you scroll up (or press **Pause scrolling**).

Detaching a watcher never touches the loop, and a log file that cannot be
written is a warning, not a failed build.

Nothing about a run is stored in memory that matters: the statuses are in
`prd.md` on the data volume, the work is in commits, and the learnings are in
`progress.md`. A server restart therefore loses at most the iteration that was
in flight — startup reconciliation marks such a session `failed` at the
`container_lost` stage, and retrying it starts a fresh container on the very
same workspace.

## The usage-limit hold

Claude's usage limit is on the **account**, not on a session. When it is
reached, every agent chief-web could start is refused, and the only useful
response is to stop asking for a while. That pause is the **hold**, and it is
one thing for the whole server.

**How a refusal is recognised.** The loop asks `isUsageLimitRefusal(result)`
(`server/src/limits/detect.ts`) about the agent run before anything else looks
at it — before the iteration is classified, so a limit can never be read as a
stall. It is a pure function over the exit code and the output: the refusal
wordings live in one `USAGE_LIMIT_PATTERNS` array and nowhere else, an agent
that exited `0` is never a refusal (it did the work, whatever it may have
quoted along the way), and a timed-out run is never one either — that keeps its
own handling above. The list is deliberately broad, because the wording is the
CLI's to change and the two mistakes do not cost the same: a false positive
wastes an hour of waiting, a false negative fails a session and needs a human.

**The wait is a fixed hour, and it is deliberately not parsed from the
message.** The refusal usually names a reset time; chief-web ignores it.
`USAGE_LIMIT_HOLD_MS` is one hour, and that is the whole rule. A timestamp
scraped out of prose is a timezone bug, a wording change or an off-by-one
waiting to happen, and being wrong in the optimistic direction means resuming
straight back into the limit. An hour is simple, always safe, and at worst costs
some idle time an operator can end with one click.

**The hold is global.** It is a single `claude_limit_until` row in `settings`,
not a field on the refused session, so:

- the refused session is parked at **waiting**, with `waiting_until` carrying
  the moment it may resume;
- every *other* `building` session is unwound the same way — its loop is told to
  stop, its agent is reaped, and it is parked on the same expiry — because they
  are all spending the same account;
- a PR-feedback run is refused up front with `409 usage_limit_hold`, before it
  costs a container, a checkout or a GitHub call; one refused mid-run arms the
  hold and parks the builds too;
- **Start build** during a hold enqueues the session and answers
  `429 usage_limit_hold`; the
  [queue](scheduling.md#concurrency-and-the-build-queue) is not pumped while the
  hold is on, so its order is kept rather than spent;
- the row is on disk, so a server restarted mid-hold picks the hold back up
  instead of resuming every session straight into the limit.

**It costs no retry and no iteration.** The refused iteration is given back, the
story's attempt count is left exactly where it was, and `prd.md` is untouched —
the story keeps the `in-progress` the loop wrote before the agent ran. A session
that had already stalled twice is still one attempt away from failing when it
comes back, not zero. A held session also keeps its **build slot**: it counts
against the concurrency cap for as long as it waits, so nothing starts into the
limit in its place and the slot is still there when it resumes.

**Coming back.** The scheduler resumes a waiting session by itself once
`waiting_until` has passed (see
[Scheduling](scheduling.md#the-usage-limit-hold)) — same container, same story,
same counters, so the run continues rather than restarts. **Resume now** on the
session page ends the hold early: `POST /api/limits/hold/clear` clears the row
and puts *every* waiting session back to work at once, subject to the cap, with
the overflow on the queue. `GET /api/limits/hold` answers `{ until }` for
anything that needs to know whether there is a hold at all. **Stop build** works
on a held session too, and takes it back to **ready** without waiting the hour
out.

## Push and pull request

The loop pushes the feature branch to `origin` **after every story it
completes**, so what the remote has is never more than one story behind what the
container has. Those pushes are best-effort: the commits are safe locally, so a
remote that is briefly unavailable is logged and the build carries on.

When the last story is done, `server/src/delivery/` takes over:

1. `git push --set-upstream origin <feature-branch>` once more, from **inside**
   the session container — that is where the repository's deploy key is. Never
   a force push, and never a refspec chief-web invented.
2. `POST /repos/<owner>/<repo>/pulls` with the global PAT from Settings. The
   title is the **session name**; the body lists the completed stories by id and
   title (with their short commit SHAs), names the branches, and ends with a note
   saying chief-web generated it — a link back to the session page when
   `PUBLIC_URL` is set.
3. The session becomes **finished**, the pull request URL is stored on the row,
   and the session page shows it as a link.

**An existing pull request is adopted, never duplicated.** The open pull request
for that head/base is looked up first, and GitHub's own 422 ("a pull request
already exists") is handled the same way — look again, adopt what is there.

**A failure at either step marks the session `failed`** with the underlying
reason: git's stderr, or GitHub's own message (`No commits between develop and
chief/x`, a token that cannot see the repository, …) — at the `push` or
`pull_request` stage respectively. Because every story is already committed,
there is nothing to rebuild: **Retry push & PR**
(`POST /api/sessions/<id>/delivery`) re-attempts only that step and never runs a
story again. Like session setup, it answers `200 { ok: false, … }` for a remote
failure and reserves `409` for the wrong state (still building, or a story left
outstanding).

## Failure and recovery

Every path that ends in **failed** stores two things on the session: a
human-readable `last_error`, and the **stage** it failed at.

| Stage | What failed | What a retry does |
| --- | --- | --- |
| `agent` | An iteration stalled, ran out of time, or could not be run at all | Restarts the loop at the first story that is not `done` |
| `prd` | `prd.md` can no longer be read, so nothing knows what is done | Same, once the file parses again |
| `container_lost` | The session container disappeared mid-build (found by startup reconciliation) | Starts a **fresh container on the same workspace** and resumes |
| `push` | `git push` of the feature branch | Re-runs the push and the pull request only |
| `pull_request` | Opening the pull request at GitHub | Same — an open pull request is adopted, never duplicated |

A **clone or setup failure is deliberately not one of these**: it leaves the
session `pending` with the reason on it and a **Retry setup** action, because
there is nothing to resume yet.

`POST /api/sessions/<id>/retry` is the one endpoint over both recoveries — it
reads the stage and dispatches, so the UI never has to guess — and
`GET /api/sessions/<id>/retry` answers with what it *would* do, which is what
labels the button. Only the half that runs an agent is behind the Claude Code
guard: a session whose push failed has nothing left to build, so its recovery is
not blocked on credentials it does not use. Neither path redoes work: everything
already committed stays committed, and every story `prd.md` calls `done` is
skipped.
