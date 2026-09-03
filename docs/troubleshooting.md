[← chief-web](../README.md) · [All docs](../README.md#documentation)

# Troubleshooting

Most failures show the underlying command's own output on the session or
repository page — read that first; the sections below are what the common ones
mean. Server-side detail is in `docker compose logs -f server`, and
`LOG_LEVEL=debug` in `.env` turns up the volume.

## A clone or push fails over SSH

Symptoms: **Test connection** fails, or a new session stays **pending** with a
setup error, or a build fails at the `push` stage. The message is git's own
stderr.

| What you see | What it means |
| --- | --- |
| `Permission denied (publickey)` | The deploy key is not on the repository, or you added a *different* key. Compare the fingerprint shown on the Repositories page with the one on `github.com/<owner>/<repo>/settings/keys`. |
| Clone works, **push** is rejected (`remote: Write access to repository not granted`) | The classic one: the deploy key was added **without "Allow write access"**. Tick it on GitHub — the key does not have to be replaced. |
| `Repository not found` / `Could not read from remote repository` | Wrong slug or wrong URL. It must be the SSH form, `git@github.com:owner/repo.git`, not `https://…`. |
| `Load key … error in libcrypto` or an interactive passphrase prompt | You pasted a **passphrase-protected** private key. A container cannot answer the prompt; import an unencrypted key or let chief-web generate one. |
| `Host key verification failed` | A non-GitHub remote whose host key changed. github.com's keys are pinned in the runner image; other hosts use `accept-new`. |
| The step times out on a very large repository | Raise `SESSION_SETUP_TIMEOUT_MS` (clone/checkout) or `PUSH_TIMEOUT_MS` in `.env` and restart the stack. |
| `Connection timed out` on port 22 | The host blocks outbound SSH. |

Always re-run **Test connection** after a fix: it is the same key and the same
container the session will use, so a green result there means the session will
clone.

A repository whose key is listed as `missing — edit and paste a private key` lost
its key file (a restored backup that skipped the data volume, usually). Edit the
repository, generate a new keypair, and add the new public key on GitHub.

## Claude says "Not authenticated"

The indicator on **Settings → Claude Code** is the verdict of a real
`claude auth status` run in a container, so it is the truth, not a cached guess.
Session creation, planning and any retry that runs an agent are blocked while it
says this — deliberately, so you find out here instead of two hours into a
build.

- **Credentials expired**, or you signed the account out elsewhere: press **Set
  up Claude** again and repeat the login. It is the same flow as first-time
  setup, and it replaces what is in the volume. Nothing else has to be restarted;
  sessions already running pick the new credentials up on their next iteration,
  because the volume is mounted live.
- **A build failed mid-run with an auth error**: re-authenticate, then press
  **Retry** on the session. Completed stories are not rebuilt.
- **It says Not authenticated with an error next to it** (`docker: …`, `image
  not found`, a timeout): the *probe* could not run. chief-web fails closed — an
  unanswerable check is not a pass. Usually the runner image is missing
  (`docker compose build runner`) or the Docker socket is unreachable. Fix that
  and press **Re-check**.
- **The login terminal shows nothing**: the login container did not start. Check
  `docker compose logs server` and that `RUNNER_IMAGE` exists locally
  (`docker image ls chief-web-runner`).
- The status is cached for 15 seconds (`CLAUDE_STATUS_CACHE_MS`) because each
  probe costs a container start; **Re-check** ignores the cache.

The credentials survive `docker compose down` and restarts. They are lost only
by removing the volume (`docker volume rm chief-web-claude-auth`), which is what
a `docker compose down -v` does.

## Recovering a failed session

A **failed** session shows the reason at the top of its page, a **stage** badge
saying where it broke, and one **Retry** button whose label tells you what it
will do. Nothing already committed is ever redone: every story `prd.md` calls
`done` is skipped.

| Stage | Usual cause | What **Retry** does | What to fix first |
| --- | --- | --- | --- |
| `agent` | A story stalled three times, or an iteration ran out of time | Restarts the loop at the first story that is not `done` | Read the tail of the live log. A story too big for one iteration should be split (**Back to planning**); a slow test suite may just need a bigger **Agent timeout** in Settings |
| `prd` | `prd.md` no longer parses — usually an agent mangled the file | Same, once it parses again | Open the session's terminal (or **Back to planning**) and fix the file; the errors name the lines |
| `container_lost` | The container died or the stack was restarted mid-build | Starts a **fresh container on the same workspace** and resumes | Nothing, normally — just retry. If it recurs, check `docker compose logs` and the host's memory |
| `push` | Deploy key without write access, protected branch, network | Re-runs the push and the pull request only | See [SSH failures](#a-clone-or-push-fails-over-ssh) |
| `pull_request` | Expired/insufficient GitHub token, no commits between the branches, org approval missing | Same — an existing PR is adopted, never duplicated | Re-check the token on Settings with **Validate** ([token setup](../README.md#4-add-a-github-token)) |
| `review` | The [automatic code review](code-review.md) could not run or could not be posted | Re-runs the review only — the pull request is left as it is | Check the GitHub token and the **Review model** in Settings; the reason on the session names which half failed |

Notes that save time:

- **A failed *setup* is not a failed session.** A clone that fails leaves the
  session **pending** with a **Retry setup** button, because there is nothing to
  resume yet.
- **A retry after a `push`/`pull_request` failure does not need Claude.** Only
  the half that runs an agent is behind the auth guard.
- **Work is never lost by a failure.** The commits are in the clone on the data
  volume and, for every completed story, already on `origin`. Even deleting the
  session leaves the remote branch and the pull request untouched.
- **If a retry keeps failing the same way**, stop retrying and look at the
  workspace: open a browser terminal into the session's container and run `git
  status`, `git log --oneline` and your test suite by hand. It is an ordinary
  clone.
- **After a host reboot or `docker compose up` following a crash**, startup
  reconciliation compares the database with the daemon: containers whose session
  is gone are removed, and a `building` or `waiting` session with no container is
  marked failed at `container_lost`. If Docker is unreachable at boot the server starts
  and changes nothing, on purpose — retry once the daemon is back.

## The stack itself

| Symptom | Check |
| --- | --- |
| `/api/health` does not answer | `docker compose ps` and `docker compose logs server`. Port already in use → change `CHIEF_WEB_PORT`. |
| The login page rejects your password | If `CHIEF_WEB_PASSWORD` is set in `.env` it always wins, but only after a `docker compose up -d` that recreates the container. Otherwise grep the logs for the generated one. |
| The login page says *too many failed sign-in attempts* | The throttle on `POST /api/auth/login`: 5 failures per 15 minutes per client. Wait it out — the message says how long — or restart the server, which clears the in-memory counters. Tune it with `LOGIN_ATTEMPT_LIMIT` / `LOGIN_ATTEMPT_WINDOW_MS`. |
| Every request bounces to `/login` | The cookie is `HttpOnly` and 7 days; changing the password invalidates all of them. |
| `permission denied … /var/run/docker.sock` in the logs | The host user running compose is not in the `docker` group. |
| Every session says *Waiting*, nothing runs | Claude's [usage-limit hold](build-loop.md#the-usage-limit-hold): the account is out of usage, so builds are paused for an hour rather than failed. They resume by themselves; **Resume now** on any held session ends the hold early. |
| Sessions never start, all say *Queued* | The concurrency cap. Raise **Max concurrent building sessions** in Settings; it takes effect at the next free slot with no restart. |
| Disk filling up | Each session keeps a full clone under the data volume. Delete finished sessions — the branch and PR on GitHub survive it. |
