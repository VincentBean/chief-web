[← chief-web](../README.md) · [All docs](../README.md#documentation)

# Scheduling and concurrency

## Scheduled starts

A session can be given a **scheduled start**: a timestamp at which chief-web
starts its build by itself, so a long run can happen overnight or off-hours. It
is set when the session is created, and set, moved or cleared afterwards from
the session page (`PUT /api/sessions/<id>/schedule`, `scheduledStartAt: null` to
clear) for as long as the session is `pending` or `ready`.

The schedule is a **column, not a timer**. `sessions.scheduled_start_at` is the
whole of it; the scheduler is only the thing that keeps looking at it, every
`SCHEDULER_INTERVAL_MS` (30 s by default, and capped there). Two things follow:

- **it survives a restart.** The first tick after boot runs before the first
  request is served and is the same query as every other tick, so anything that
  came due while the stack was down is simply due now and starts immediately;
- **nothing has to be told when a schedule changes.** The next tick reads it.

Only a `ready` session is started. A session still being planned when its moment
arrives **does not start** — chief-web never builds against a PRD it has not
parsed. The dashboard and the session page say *missed schedule — mark ready to
start*, and marking it ready then starts the build immediately, after a
confirmation that says so.

Schedules are **one-shot**. The timestamp is cleared the moment the session
enters `building` — or the build queue below, which is the same promise
honoured as far as the concurrency cap allows — whether the scheduler fired it
or someone pressed **Start build** early, so a session that is later stopped or fails can never restart
itself from a timestamp that has long passed. A fire that could not be honoured
(no container, say) clears it too and records the reason on the session, rather
than retrying every half minute for the rest of the day.

The dashboard and the session page both show the scheduled time in the visitor's
own timezone with a `starts in …` countdown, refreshed by the same three-second
poll as everything else.

## Recurring tasks

A **recurring task** is a stored prompt plus a cron expression. Every time it
comes due, chief-web starts an ordinary session for it — its own container, its
own clone, its own branch — writes the PRD for it, builds it and opens a pull
request, with nobody in the loop. It is how "run rector and fix what it reports"
or "check the code style against the guide" becomes something that happens every
night instead of something you remember to do.

Tasks live under **Recurring tasks** in the sidebar (`g c`) and are created there
with a repository, a slug **name**, the **prompt**, a five-field **cron
expression**, a base branch, a PR target and the [code review](code-review.md)
flag — the same fields a session has, minus the planning. The name is capped at
46 characters because every run is a session named
**`<task name>-<YYYYMMDD-HHmm>`**, which is what gives each occurrence a branch
`origin` has never seen. The expression is read in the **server's timezone**,
described in English as you type it (`0 3 * * 1` → *At 03:00, only on Monday*)
and previewed with the moment it next names, so a schedule is never saved on
trust. **Pause** stops a task without deleting it: a paused task has no next run
at all, and resuming it schedules the next occurrence from now.

### The generated PRD

A run has no planning step, so chief-web writes its PRD itself: one story,
`US-001`, whose description is the task's prompt on a single line — the build
loop hands the agent the story and nothing else of the file — with the prompt
repeated underneath, quoted line by line, for whoever opens the document. The
quoting is not decoration: it means a prompt that itself contains `### US-002`
headings or `- [ ]` checkboxes cannot smuggle extra stories into the run.

Its three acceptance criteria are the whole contract with the agent: carry the
task out, commit what it needed with the repository's own quality checks
passing, **or** find nothing to do, tick the criteria and finish without a
commit. From there the run is an ordinary session: the same parser reads the
file, the same [build loop](build-loop.md) runs the story, the same delivery
opens the pull request, and the session page shows all of it.

### A run that changed nothing

Most runs against a healthy repository find nothing to do, and that is an
expected outcome rather than a failure. Before pushing, a recurring run counts
the commits on its branch; when there are none it **skips the push, the pull
request and the review** and finishes clean — no branch left on `origin`, no
empty pull request to close. The session reads *nothing to deliver*, the task's
history records *nothing to change*, and the next occurrence is scheduled as
usual.

This applies to recurring runs only. An interactive session with an empty branch
still goes through delivery and still gets GitHub's own complaint about it,
because there it is a surprise its operator should see. And if the commit count
cannot be read at all — a container that would not start, a range git could not
resolve — the run delivers as usual rather than guessing.

### Skipping while the last pull request is open

An occurrence is **skipped** when the previous run of the same task is still in
the way, so runs of one task never overlap and its pull requests never stack up
behind each other. Two things hold one back, both read off the task's most
recent run:

- the run has not ended — it is still being set up, still waiting for a build
  slot, still building, or [held by the usage
  limit](build-loop.md#the-usage-limit-hold);
- the run's **pull request is still open** — nobody has merged or closed it yet.

Everything else lets the occurrence through: a failed run, a merged or a closed
pull request, a run that changed nothing, a task that has never run. A skip is a
row in the task's history naming the run that blocked it, and it **spends the
occurrence**: the schedule has already moved on to the next moment the
expression names, rather than trying again every half minute. Merge or close the
pull request and the next occurrence runs.

### The hold, and coming back from downtime

Recurring tasks are due-queried by the same tick as scheduled starts — the same
`SCHEDULER_INTERVAL_MS`, with a `next_run_at` column where a session has
`scheduled_start_at` — so they inherit the same two behaviours:

- **while the [usage-limit hold](build-loop.md#the-usage-limit-hold) is on,
  nothing is fired.** A due task is left due rather than fired and lost, and the
  first tick after the hold lifts runs it. Runs that have already *ended* are
  still settled during a hold; only the firing waits.
- **downtime costs a task one run, not one per missed occurrence.** There is no
  notion of "while we were down": a task whose moment passed is simply due now
  and fires at the first tick after boot, and its next run is then computed
  **from that moment**, not from the occurrence that was missed. An hourly task
  that was down for a day catches up once and is back on its hour.

The next run is booked the moment a task fires, before anything else can happen,
which is what makes one occurrence cost exactly one slot — whether the run takes
three hours, is skipped, or is refused a container outright. A firing that fails
before the build starts is a **could not start** row in the history with git's
or Docker's own reason on it, and the half-created session is left `pending`
with the usual **Retry setup**; nothing is retried before the next occurrence.

### The run history

Each task has a page of its own listing every occurrence: when it happened, what
became of it, and the session it ran as. The outcomes are *running*, *pull
request opened*, *nothing to change*, *skipped*, *could not start* and *failed*,
and the newest of them is also the badge on the task list. A run's session is an
ordinary one, so its log, its stories and its pull request are one click away —
and deleting a task leaves the sessions it already ran behind.

## The usage-limit hold

While Claude's [usage-limit hold](build-loop.md#the-usage-limit-hold) is on, the
scheduler **starts nothing**. A due `scheduled_start_at` is left exactly where
it is rather than fired and lost: it is simply still due at the first tick after
the hold lifts, which is the same catch-up the scheduler already does after a
restart. The queue is not pumped either, so its order is kept rather than spent
on starts that would only be refused, and no [recurring task](#recurring-tasks)
is fired — a task that came due during the hold is simply still due when it
lifts.

What the tick does do during and after a hold is **resume waiting sessions**.
Every tick asks for the sessions whose `waiting_until` has passed, oldest first,
and puts them back to building — in the same container, on the same story, with
the iteration and attempt counters they were paused with. That runs *before* the
due schedules, because a held session never gave its build slot back and a
schedule fired first could take one from it. Anything that no longer fits the
cap goes onto the queue in the order it was resumed in.

## Concurrency and the build queue

Several sessions build at the same time, each in its **own container, its own
workspace and its own branch**. Nothing is shared between two sessions of the
same repository: the workspace is `workspaces/<session-id>/` (a UUID, not a
name), the container is labelled with that id, and the branch is
`chief/<session name>`, which `UNIQUE (repository_id, name)` keeps distinct.

How many may run at once is the **Max concurrent building sessions** setting
(`MAX_CONCURRENT_SESSIONS` supplies the default until a value is saved). The cap
is read on every start decision, so raising it takes effect at the next slot,
without a restart.

A start beyond the cap — pressed by hand, or fired by a schedule — is **not
refused**: the session stays `ready` with a `queued_at` timestamp and waits its
turn. `POST /api/sessions/<id>/build` answers `200` with `queued: true` and the
session's 1-based `queuePosition`; the dashboard and the session page show
*Queued (#2)*.

- **FIFO, and it survives a restart.** The order is the `queued_at` column
  ordered by timestamp then id, so it is the same order before and after a
  reboot. Nothing is spawned for a queued session, so waiting costs nothing.
- **It starts on its own.** Every run that ends — finished, stopped, failed or
  deleted — hands its slot to the head of the queue. The scheduler's tick pumps
  the queue too, which is what picks it up again after a restart, when no run of
  this process ever ended to free a slot.
- **Pressing start again does not lose your place.** The first `queued_at` is
  kept.
- **Leave queue** (`DELETE /api/sessions/<id>/queue`) takes a waiting session
  back to plain `ready` in one click. Nothing was started, so nothing is lost.
- A session that can no longer be built when its turn comes (it went back to
  planning, its stories are all done) **leaves the queue with the reason on it**
  and the next session gets the slot.
