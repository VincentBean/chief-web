# chief-web

> ## ⚠️ Personal project — no guarantees
>
> **I built chief-web for myself**, on my machine, for my repositories. It is
> not a product. There is no support, no releases, and no promise that it works
> for you — or at all. Expect rough edges and breaking changes.
>
> **It was vibe coded on purpose.** The goal was to get it working fast, not to
> get it right. Most of the code was written by an agent and only lightly
> reviewed, so the quality is not guaranteed either. Read it before you trust
> it.
>
> **It needs the Docker socket**, which is root-level access to your machine,
> and it runs agents with `--dangerously-skip-permissions`. Read the
> [security model](docs/security.md) first. Run it on a machine you own,
> against repositories you can afford to have touched.

## What it is

chief-web is a self-hosted web app that builds features for you.

You describe a feature in a browser terminal running Claude Code, which writes
it down as a **PRD** — a list of user stories. Then you press build. chief-web
works through the stories one at a time, each in a fresh agent run, commits
after each one, and opens a pull request when it is done. All of it happens in
a Docker container on its own git branch, so your machine is never touched.

It is a web version of [chief](https://github.com/minicodemonkey/chief). I made
it because I wanted several features building at the same time, in the
background, instead of babysitting one terminal per feature.

**Installing it needs nothing but Docker.**

## What it does

- **Builds a feature from a PRD.** Plan it, press build, get a pull request —
  one agent run per story, one commit per story.
  [How the loop works](docs/build-loop.md)
- **Runs several builds at once.** Each one gets its own container, clone and
  branch. Anything over your limit waits in a queue. Closing the tab or
  restarting the server does not stop them.
  [Concurrency](docs/scheduling.md#concurrency-and-the-build-queue)
- **Starts when you tell it to.** Give a session a start time and it runs
  overnight. [Scheduled starts](docs/scheduling.md#scheduled-starts)
- **Repeats work on a schedule.** Save a prompt and a cron expression — "run
  rector and fix what it reports". It writes its own PRD, builds it with nobody
  watching, and opens a pull request, or nothing at all if there was nothing to
  fix. [Recurring tasks](docs/scheduling.md#recurring-tasks)
- **Reviews its own pull requests.** An agent reads the finished branch and
  leaves a review on GitHub. You can also review any open pull request by hand.
  [Code review](docs/code-review.md)
- **Answers review comments.** Point it at a pull request and an agent works
  through the comment threads, pushes fixes, then replies to each one and marks
  it resolved.
  [Feedback runs](docs/code-review.md#the-hand-off-to-the-feedback-run)
- **Fixes merge conflicts.** It checks its own open pull requests and resolves
  conflicts with the base branch by itself.
  [Merge conflicts](docs/merge-conflicts.md)
- **Fixes Sentry errors.** Link a Sentry project and it works out which errors
  a code change can fix, then opens a pull request for them. Merge it and the
  issue is resolved in Sentry too. [Sentry](docs/sentry.md)
- **Gives you a terminal in the browser.** A real shell inside any running
  container. Close the tab, come back, the output is still there.
  [Terminals](docs/interface.md#browser-terminals)
- **Shows you a dashboard.** What is running, what needs you, what is queued,
  and how much got built in the last two weeks.
  [Overview](docs/interface.md#overview)

If Claude runs into its usage limit mid-build, the session waits for the limit
to lift and carries on instead of failing.
[The hold](docs/build-loop.md#the-usage-limit-hold)

**New here?** [What you need](#what-you-need) → [Setup](#setup) →
[Your first session](docs/first-session.md) → [Documentation](#documentation).

## What you need

- **Docker**, version 24 or newer, with the `compose` plugin. Check with
  `docker compose version` — if it prints usage instead of a version number
  you have the old `docker-compose` binary and need the plugin.
- **Access to the Docker socket**, because chief-web starts a container per
  session. On Linux that means your user is in the `docker` group, or you run
  compose with `sudo`.
- **A GitHub account** that can add a deploy key to each repository you want
  worked on, and create an access token.
- **A Claude account** you can log into — a Pro/Max subscription or Anthropic
  Console. There is no API key to paste; you sign in once, in the browser.
- **Internet access** to GitHub (SSH and HTTPS) and to Anthropic.
- **A few GB of disk** for the images and a full clone per session, plus enough
  RAM for the sessions you run at once. Each one is a container running an agent
  and, usually, your test suite.

You do not need git, Node.js or the Claude Code CLI on your machine — they all
live inside the Docker images.

## Quick start

```sh
cp .env.example .env      # set CHIEF_WEB_PASSWORD
docker compose up --build
```

Then open <http://localhost:8080>. The rest of the setup happens in the browser
and is described below.

To check it is running:

```sh
curl http://localhost:8080/api/health   # -> {"status":"ok"}
```

## Setup

Six steps. The first three are in a terminal, the last three in the browser.

### 1. Configure `.env`

```sh
git clone https://github.com/<you>/chief-web.git
cd chief-web
cp .env.example .env
```

Everything has a working default. The one thing worth setting yourself is the
password for the web interface:

```ini
CHIEF_WEB_PASSWORD=a-long-random-passphrase
CHIEF_WEB_PORT=8080          # the port on your machine
```

Leave the password empty and chief-web makes one for you on first boot and
prints it to the log once — find it with
`docker compose logs server | grep -i password`. Setting the variable later
replaces it.

Two more you may want now. Everything else is explained in
[`.env.example`](.env.example) and can wait:

```ini
PUBLIC_URL=https://chief.example.com   # used to link a pull request back to its session
MAX_CONCURRENT_SESSIONS=3              # how many builds run at once (changeable in the UI)
```

### 2. Start it

```sh
docker compose up --build
```

This builds two images: the server, and the runner image that every session
container is started from. The first build takes a few minutes. Add `-d` to
leave it running in the background, and use `docker compose logs -f server` to
watch the logs.

### 3. Log in

Open <http://localhost:8080> and enter your password. There are no user
accounts, the password is the whole login, and you stay logged in for 7 days.

You land on the overview. Until setup is finished it shows a checklist of what
is still missing, which is steps 4 to 6.

### 4. Add a GitHub token

chief-web opens pull requests with a **personal access token**. Make one at
<https://github.com/settings/tokens>. Either kind works:

| Token type | Where | What to give it |
| --- | --- | --- |
| **Fine-grained** (recommended) | Developer settings → **Fine-grained tokens** | Access to the repositories chief-web will work on, with **Contents: read and write** and **Pull requests: read and write** |
| **Classic** | Developer settings → **Tokens (classic)** | The whole **`repo`** checkbox |

The fine-grained one is better because you can limit it to the repositories you
actually hand over. If those belong to an organisation, an owner has to approve
the token before it works.

Pick an expiry you will remember to renew. An expired token does not fail until
the very last step of a build, when the pull request is opened.

Now paste it into **Settings → GitHub Personal Access Token**, press **Save**,
then press **Validate**. Validate shows you which GitHub account the token
belongs to, so a typo turns up now instead of at the end of a two-hour build.
After saving, the interface only ever shows the last four characters.

This token opens pull requests. It is *not* how code gets pushed — that is the
deploy key in the next step.

### 5. Add a repository

Go to **Repositories → Add repository** and fill in:

| Field | What to put |
| --- | --- |
| **Name** | whatever you want to call it here |
| **SSH URL** | `git@github.com:owner/repo.git` — SSH, not HTTPS |
| **GitHub slug** | `owner/repo`; filled in for you from the URL |
| **Default base branch** | what new sessions branch from (`main`, `develop`, …) |
| **SSH key** | leave **Generate a new ed25519 keypair** selected |

Save it. chief-web makes the key and shows you the public half, with a copy
button and a link to the right GitHub page.

On GitHub, open `https://github.com/<owner>/<repo>/settings/keys/new`, paste the
key, name it `chief-web`, and — this is the part everyone forgets — **tick
"Allow write access"**. Without it the repository clones fine and then fails the
first time a session tries to push.

Back in chief-web, press **Test connection**. It tries to reach the repository
with that key and tells you straight away whether it worked. Do not skip it.

You can paste your own private key instead, if you would rather. It has to be
unencrypted, because nothing inside a container can type a passphrase. Either
way the private key stays on the server and is never shown in the interface, in
the API, or in a log.

Do this once per repository. Each one gets its own key.

### 6. Sign in to Claude Code

Go to **Settings → Claude Code** and press **Set up Claude**. A terminal
appears and asks you to log in:

1. Copy the URL it prints with **Ctrl+Shift+C** and open it in a new tab.
2. Approve it, and copy the code Claude gives you.
3. Paste it back into the terminal with **Ctrl+Shift+V** and press Enter.
4. Press **Close login terminal**.

It should now say **Authenticated**. You only do this once — the login is kept
in a Docker volume, shared by every session, and survives restarts and
`docker compose down`.

Until this says Authenticated you cannot create or plan a session. That is
deliberate: an agent that cannot log in would fail on its first run, a long way
from the actual cause.

That is it. Everything from here on is per session — start with
[your first session](docs/first-session.md).

## Configuration

Every environment variable is explained in [`.env.example`](.env.example).

Your GitHub token, your Sentry token, the git identity commits are made with,
and which model each step uses are all set in **Settings** in the browser, not
in `.env`.

## Documentation

The rest of the manual is in [`docs/`](docs/):

| Document | What it covers |
| --- | --- |
| [Your first session](docs/first-session.md) | one feature from start to finish |
| [Architecture](docs/architecture.md) | how the containers, volumes and data fit together |
| [Repositories](docs/repositories.md) | adding a repository, deploy keys, testing the connection |
| [Sessions](docs/sessions.md) | what a session is and the states it goes through |
| [The build loop](docs/build-loop.md) | how a build runs, the live log, the usage limit, what happens when it fails |
| [Code review](docs/code-review.md) | the automatic review, and reviewing a pull request by hand |
| [Scheduling and concurrency](docs/scheduling.md) | scheduled starts, recurring tasks and the build queue |
| [Merge conflict fixer](docs/merge-conflicts.md) | how conflicts get resolved, and what letting it push means |
| [Sentry auto-fixer](docs/sentry.md) | linking a project, what gets fixed, and what does not |
| [Web interface](docs/interface.md) | the pages, the shortcuts, the settings |
| [Claude authentication](docs/claude-auth.md) | the one-time login |
| [Security model](docs/security.md) | what the password protects, and what it does not |
| [Troubleshooting](docs/troubleshooting.md) | SSH and login failures, recovering a failed session |
| [Development](docs/development.md) | running it from source |
