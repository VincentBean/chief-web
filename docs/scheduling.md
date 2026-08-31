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

## The usage-limit hold

While Claude's [usage-limit hold](build-loop.md#the-usage-limit-hold) is on, the
scheduler **starts nothing**. A due `scheduled_start_at` is left exactly where
it is rather than fired and lost: it is simply still due at the first tick after
the hold lifts, which is the same catch-up the scheduler already does after a
restart. The queue is not pumped either, so its order is kept rather than spent
on starts that would only be refused.

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
