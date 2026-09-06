[← chief-web](../README.md) · [All docs](../README.md#documentation)

# Pull request descriptions

Every pull request chief-web opens starts with a **What this does** section: two
short paragraphs saying what the branch built and how it works, written by one
headless `claude -p` pass over the branch's diff, just before the pull request is
created.

Without it a reviewer gets a list of story ids and titles — what was *asked
for* — and has to read the whole diff to find out what was *built*. The
description is the part of the body that answers that question.

It is not a setting. There is nothing to switch on, and no per-session flag:
every delivery that can run the pass runs it, and every delivery that cannot
opens its pull request without one.

## Where it sits in the delivery

The delivery runs in this order, and the description is step 3 of 5:

1. `git push --set-upstream origin <feature-branch>` from inside the session
   container.
2. The checks the pull request needs anyway — commits on the branch, a GitHub
   token, a repository with a valid `owner/repo` slug.
3. **The description pass.**
4. `POST /repos/<owner>/<repo>/pulls` with the body the description went into.
5. The [code review](code-review.md), when the session has it switched on.

It runs *after* the token and slug checks on purpose. Those are the failures
that stop a pull request from being opened at all, and there is no point paying
for an agent to describe a branch that is not going to get one.

It runs *before* the pull request exists because that is the only moment the
body is written. See [The body is written once](#the-body-is-written-once).

## What the agent gets

The pass never reads the repository. Everything it describes is handed to it in
the prompt, so it is one agent reading text and writing text rather than an
agent loose in the clone:

| Input | Where it comes from |
| --- | --- |
| The branch diff | `git diff --stat` then `git diff origin/<target>...<feature>`, run in the session's container |
| The session name | The pull request's own title |
| The two branch names | The session row |
| The titles of the **finished** stories | The session's stories, in priority order |

The diff is read against the remote-tracking ref (`origin/<target>`), which is
the same range the pull request itself shows, and it is bounded twice: at
200 KB inside the container, and at 60,000 characters going into the prompt.
Past that the patch is cut at a line boundary and the files it did not reach are
**named** instead — a file-level summary is still something a reviewer can use.

Only stories the build finished are listed, and only as context. Outstanding
stories are deliberately left out so the agent cannot describe work that is not
in the diff, and the prompt says the titles say what was asked for while the
diff says what was built.

**The diff is fenced as untrusted data.** It is code an agent wrote, full of
comments, strings, fixtures and documentation that can read like instructions,
and it ends up in a body a human trusts. So it goes inside one marked block,
the instruction to ignore instructions inside it is stated *before* the block
opens, and anything in the diff that looks like the end marker is broken up on
the way in so the block cannot be closed from inside. This is the same
construction the [Sentry auto-fixer](sentry.md) uses on an issue's stack trace.

## How it is asked to write

The prompt asks for exactly two `###` sections and nothing around them:

- **What was made** — one paragraph: what the branch adds, changes or fixes,
  and what it is for.
- **How it works** — the pieces involved, where they live and how they fit
  together, naming the files or modules a reviewer should start with. Bullet
  points are allowed here.

The style rules it is held to:

- **Under 150 words in total.** Shorter is better; this is read before the
  diff, not instead of it.
- **Simplified technical English** — short sentences, common words, one idea
  per sentence, written for a colleague whose first language is not English.
- **No marketing language.** Nothing is "seamless", "robust", "powerful" or
  "comprehensive", and nothing "enhances" anything.
- **No restating the story list.** The body already lists the stories below the
  description; repeating them spends the words.
- **Only what the diff shows.** Something the agent cannot tell from the diff is
  left out rather than guessed at.
- **Plain markdown** — no title, no heading above `###`, no preamble, no closing
  summary, and no code fence around the whole answer.

The agent may change nothing: no edits, no commits, no push, no `gh`. It writes
the markdown to one file *next to* the clone, never inside it, so a stray
`git add -A` in some other agent's container could not commit the description
onto the branch it describes. chief-web reads that file off the data volume; a
pass that answered in its reply instead of writing the file is still used, but
only when the agent exited cleanly — the output of a crashed one is a stack
trace, and a stack trace at the top of a pull request is worse than no
description.

What comes back is cleaned before it is published: the agent log lines are
dropped, a code fence wrapped around the whole answer is unwrapped, and the
result is capped at 4000 characters.

## The model and the time it gets

The pass runs on **Claude Code's own default model** — it passes no `--model` at
all, unlike the build, planning and review models on
[Settings → Models](interface.md#settings).

It is held to the **Agent timeout** in Settings, capped at **five minutes**
whatever that setting says. A build iteration is allowed an hour because it is
writing code; this one reads a diff it was handed and writes 150 words, inside a
delivery someone is waiting on. The timeout is read when the pass starts, so
changing it applies to the next delivery without a restart.

## When there is no description

**A failed pass never fails the delivery.** Every way it can go wrong ends the
same way: the reason is logged, and the pull request is opened with the body
chief-web used before this feature existed — the preamble, the story lists and
the footer, with no **What this does** section and nothing to say one is
missing. The session still ends **finished**, and there is no `description`
stage in the [failure table](build-loop.md#failure-and-recovery) because a
description can never be what failed.

That covers, all identically:

| Reason | What was logged |
| --- | --- |
| The session container would not start | `The description could not be started: …` |
| `git diff` could not resolve the range | `The description was skipped: …` |
| The agent ran out of its five minutes | It is reaped in the container, then skipped |
| Claude's usage limit was hit | The agent is reaped and the delivery carries on |
| The agent exited non-zero and wrote nothing | The exit code is logged |
| The agent wrote an empty file | An empty section is worse than no section |
| The pass threw, which it is documented never to do | Logged and treated as no description |

Nothing here is retried. The pass is one attempt per delivery — unlike the code
review, which gets three — because there is nothing on the pull request to
repair and a second agent run costs more than the section is worth. A **Retry
push & PR** on a delivery that failed *after* the description will reuse the
text the first attempt already paid for rather than run the agent again.

## The body is written once

**A description is never regenerated for a pull request that exists.** Two
things make that true, and neither depends on the operator:

- The successful description is stored on the session row (`pr_description`), so
  a retry after a GitHub failure opens the pull request with the text the first
  attempt produced.
- The step is skipped outright when the session already has a pull request URL,
  so a retry that adopts an existing pull request never runs an agent.

Underneath both, `openPullRequest` never rewrites the body of a pull request it
adopts — it answers with the one it found. So the body a pull request is created
with is the body it keeps: chief-web will not overwrite a description you have
edited on GitHub, and it will not replace one that has gone stale as the branch
moved on. If the branch changes enough that the description is wrong, edit the
body on GitHub; nothing in chief-web will argue with you about it.

## What it needs

- **Claude Code signed in** ([Claude authentication](claude-auth.md)) — it is a
  headless `claude -p`, like the build and the review.
- **A session container that can be started.** It is started again if it had
  been stopped, as the review's is.
- A branch with a diff against its target. An empty range is a skipped pass.

It needs no GitHub token of its own — the token is checked before the pass runs,
and the description never talks to GitHub. The pull request that carries it
does.
