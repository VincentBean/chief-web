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

The loop stops itself in four ways:

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

  The agent is *told* its budget, in minutes, as part of the prompt: chief-web
  can enforce a deadline but it cannot make one arrive early, and an agent that
  does not know it is on a clock spends it like there is no clock. Along with
  the number it is told what being stopped costs — the commit is the only part
  of an iteration that survives it — and asked to prefer the tests that cover
  its change over the project's whole suite.
- **The iteration cap.** A run may take the outstanding stories plus 50%, never
  fewer than 10. A loop that is committing but never finishing anything hits it
  and fails, rather than churning forever.
- **Stop build.** The running agent is signalled (`SIGTERM`, via a pid file it
  writes inside the container) and the session goes back to **ready**.
  Everything already committed is kept, so a stopped build resumes rather than
  restarts. An agent that has not gone by the time the loop stops waiting for
  it is reaped, so the session is never made startable again while a previous
  agent is still in its workspace.

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
