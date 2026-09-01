[← chief-web](../README.md) · [All docs](../README.md#documentation)

# Your first session

One session is one feature: its own container, its own clone, its own branch,
one pull request at the end. Here it is end to end.

## 1. Create the session

On the sessions page, open **New session**:

| Field | Notes |
| --- | --- |
| **Repository** | one you registered in [step 5](../README.md#5-add-a-repository-and-its-deploy-key) |
| **Session name** | a slug (`letters-numbers-hyphens`), unique per repository. It becomes the feature branch **`chief/<name>`** and the workspace directory — so name it after the feature: `rate-limiting`, not `test1` |
| **Base branch** | what to branch from; defaults to the repository's |
| **PR target branch** | where the pull request will be opened (`develop` or `main`) |
| **Scheduled start** | optional — see [Scheduled starts](scheduling.md#scheduled-starts) |

**Create session** starts the container, checks that `chief/<name>` does not
already exist on `origin`, clones the base branch and creates the feature
branch. That takes a few seconds on a small repository. If it fails — bad key,
missing base branch, unreachable remote — the session stays **pending** with
git's own stderr on screen and a **Retry setup** button; fix the cause and press
it, and the existing clone is reused.

## 2. Plan the PRD

The session page (`/sessions/<id>`) opens on a browser terminal running Claude
Code **inside the session's container**, in the clone. Press **Start planning**,
optionally filling in the "What do you want to build?" box first — a paragraph
of context is plenty.

This is `chief new` in a browser. Claude asks 3–5 clarifying questions with
lettered options; answer them the compact way (`1A, 2C, 3B`) or in prose. It
then writes `.chief/prds/<session-name>/prd.md`: a numbered list of user stories
with a status, a priority and acceptance criteria.

- The panel above the terminal shows whether `prd.md` exists, when it was last
  written and how many stories it holds. It polls the workspace, so it updates
  on its own as Claude writes.
- The terminal belongs to the server, not to the tab. Reload the page, close the
  laptop, come back tomorrow — **Resume planning** rejoins the same
  conversation. Only **Close terminal** ends it.
- Reopening planning on a session that already has a PRD uses the *edit* prompt,
  so an existing PRD is amended, never rewritten.

Read the PRD before you go on. Stories that are too big are the single most
common reason a build stalls: one story should be one commit's worth of work.
You can ask Claude to split, merge, reorder or reprioritise them right in the
same conversation.

## 3. Mark it ready

Press **Mark ready**. chief-web parses `prd.md` and only promotes the session
from **pending** to **ready** if the whole file is usable — nothing is ever built
against a PRD it cannot read. The stories then appear on the page with their id,
title, priority and status.

If the file does not parse, the session stays pending and you get the specific
errors with line numbers (an unknown status, a duplicated story id, a story with
no acceptance criteria). Fix them the same way you wrote them: **Resume
planning** and tell Claude what to correct.

**Back to planning** returns a ready session to pending whenever you want to
change the PRD again.

## 4. Build

Press **Start build**. From here it is autonomous. Each iteration:

1. picks the lowest-priority-number story that is not `done`;
2. marks it `in-progress` in `prd.md`;
3. runs one fresh headless `claude -p` on it inside the container;
4. verifies the result against the world — did the story's status change, did
   `git rev-parse HEAD` move — never against what the agent claims.

Watch it in the **live log** on the session page. It streams from the agent as
it works and is also written to `.chief/prds/<session-name>/agent.log` in the
workspace, so the history is there after a reload, a restart, or a week later.
The story list updates as stories are completed, and the feature branch is
pushed to `origin` **after every completed story** — so what the remote has is
never more than one story behind.

While it runs you can:

- **Stop build** — signals the agent and returns the session to **ready**.
  Everything already committed stays, so pressing **Start build** again resumes
  rather than restarts.
- Open a [browser terminal](interface.md#browser-terminals) into the same container to look
  around while the agent works.
- Leave. Nothing depends on the tab being open, and if all the build slots are
  taken the session waits in a [FIFO queue](scheduling.md#concurrency-and-the-build-queue)
  and starts by itself.

Expect a build to take from minutes to hours depending on the PRD. The default
budget is 30 minutes per story iteration (**Settings → Agent timeout**), two
retries for a story that makes no progress, and an overall iteration cap of the
outstanding stories plus 50%.

## 5. Push and pull request

When the last story is `done`, chief-web pushes the branch once more and opens
the pull request itself:

- **title**: the session name;
- **body**: the completed stories by id and title with their short commit SHAs,
  the branches involved, and a link back to the session page when `PUBLIC_URL`
  is set;
- **base**: the PR target branch you chose.

The session becomes **finished** and the pull request URL appears on both the
session page and the dashboard. An open pull request for the same head/base is
adopted rather than duplicated, so this is safe to retry.

If the push or the PR fails — expired token, protected branch, no commits — the
session goes **failed** at the `push` or `pull_request` stage with the underlying
message, and **Retry push & PR** re-attempts *only* that step. No story is ever
rebuilt.

## 6. Review and merge

Review the pull request like any other. It is ordinary git: the branch is
`chief/<session-name>`, one commit per story, and the PRD, the progress notes
and the agent log are in `.chief/prds/<session-name>/` in the workspace (the
agent commits the PRD and progress file; the log is excluded from commits).

Needs another round? The session is finished, but the workspace and branch are
still there: open a new session for the follow-up work, or push commits of your
own. Merge, and you have gone from zero to a merged PR.

When you no longer need it, **Delete** removes the container, the workspace and
the row. **It never touches the remote** — the branch and the pull request are
the output of the session and outlive it.
