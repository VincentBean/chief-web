# chief-web

> ## ⚠️ Personal project — no guarantees
>
> **I built chief-web for myself.** It is a personal project, shaped around my
> own machine, my own workflow and my own repositories. It is not a product,
> it is not supported, and there is **no guarantee that it works** — for you or
> at all. Expect rough edges, breaking changes without notice, and no promise
> of fixes, releases or answered issues.
>
> **It was vibe coded**, deliberately: the goal was to get it working as fast
> as possible, not to get it right. The code is largely agent-written and only
> lightly reviewed, so **the quality is not guaranteed either** — the
> architecture, the tests and the error handling are whatever got it running.
> Read it before you trust it.
>
> Read the [security model](docs/security.md) before you run it: chief-web
> needs the Docker socket, which gives it root-equivalent control of the host,
> and it lets an agent run with `--dangerously-skip-permissions`. Use it at
> your own risk, on a machine you own, against repositories you can afford to
> have touched.

Self-hosted web version of [chief](https://github.com/minicodemonkey/chief), the
autonomous PRD-driven coding agent. You plan a PRD in a browser terminal running
Claude Code, then chief-web runs the Ralph Wiggum loop — one fresh agent
invocation per user story, one commit per story — on an isolated feature branch
inside a dedicated Docker container, and opens a pull request when it is done.

**Why it exists.** I wanted a web interface for chief that can run
[concurrent sessions](docs/scheduling.md#concurrency-and-the-build-queue) —
several features being built at the same time, each in its own container,
workspace and branch — instead of one terminal I have to keep open per feature.
So sessions here are queued and run in parallel, they survive a closed tab or a
restart, and they can be started on a schedule.

**Recurring sessions.** A repository can also be given
[recurring tasks](docs/scheduling.md#recurring-tasks): a stored prompt ("run
rector and fix what it reports", "check the code style against the guide") plus
a cron expression. Every time one comes due, chief-web spawns a fresh session
for it with a PRD it generates itself, builds it with nobody in the loop, and
opens a pull request — or finishes clean with no pull request when the run found
nothing to change. While the previous run's pull request is still open the next
occurrence is skipped, so nothing stacks up.

Installation requires nothing but Docker.

**New here?** [Prerequisites](#prerequisites) → [Setup](#setup) →
[Your first session](docs/first-session.md) → [Documentation](#documentation).

## Prerequisites

- **Docker Engine 24+ with the Compose v2 plugin.** Check with
  `docker --version` and `docker compose version` — if the second one prints
  usage instead of a version, you have the old `docker-compose` binary and need
  the plugin. Docker Desktop (macOS/Windows) and Docker Engine (Linux) both ship
  it.
- **Access to the Docker socket**, because chief-web starts a container per
  session (see [Architecture](docs/architecture.md)). On Linux that means your user is
  in the `docker` group or you run compose with `sudo`. Rootless Docker works
  too, but its socket is elsewhere (`$XDG_RUNTIME_DIR/docker.sock`), so both the
  bind mount in `docker-compose.yml` and `DOCKER_SOCKET` have to point at it.
- **A GitHub account with admin rights on the repositories you want worked on** —
  you need to add a deploy key to each of them, and a personal access token that
  may open pull requests.
- **A Claude account you can sign into interactively** (a Claude Pro/Max
  subscription or Anthropic Console credentials). There is no API key to paste:
  Claude Code is signed in once, in a browser terminal, and the credentials are
  reused by every session.
- **Outbound network** to `github.com` over SSH (port 22) and to
  `api.github.com` and Anthropic over HTTPS.
- **A couple of GB of disk** for the two images, plus a full clone per session
  on the data volume, and enough RAM for the sessions you run at once — each one
  is a container running an agent and, usually, your test suite.

Nothing else is needed on the host: git, Node.js and the Claude Code CLI all
live inside the images.

## Quick start

```sh
cp .env.example .env      # set CHIEF_WEB_PASSWORD
docker compose up --build
```

The UI is then available on <http://localhost:8080> (change the host port with
`CHIEF_WEB_PORT` in `.env`). First-run setup is completed in the browser: log in
with the password, add a GitHub token and repositories, and sign Claude Code in
once from **Settings → Set up Claude**. [Setup](#setup) walks through all of it
step by step.

Health check:

```sh
curl http://localhost:8080/api/health   # -> {"status":"ok"}
```

## Setup

Six steps from a clean host to a repository chief-web can build. Steps 1–3 are
the terminal; 4–6 are the browser and take a couple of minutes.

### 1. Configure `.env`

```sh
git clone https://github.com/<you>/chief-web.git
cd chief-web
cp .env.example .env
```

Every value has a working default; the one worth setting by hand is the
password protecting the whole UI:

```ini
CHIEF_WEB_PASSWORD=a-long-random-passphrase
CHIEF_WEB_PORT=8080          # host port; the container always listens on 8080
```

If you leave `CHIEF_WEB_PASSWORD` empty the server generates a password on first
boot and logs it exactly once (`docker compose logs server | grep -i password`).
Setting the variable later always wins over that generated one.

Two more are worth a look now; the rest are documented in
[`.env.example`](.env.example) and can wait:

```ini
PUBLIC_URL=https://chief.example.com   # only used to link a PR back to its session
MAX_CONCURRENT_SESSIONS=3              # default build concurrency (changeable in the UI)
```

### 2. Start the stack

```sh
docker compose up --build
```

This builds **two** images — the server (`chief-web:latest`) and the runner
(`chief-web-runner:latest`, the image every session container runs) — and starts
only the server. The first build takes a few minutes. Add `-d` to run it in the
background; `docker compose logs -f server` follows the logs afterwards.

Check it is up:

```sh
curl http://localhost:8080/api/health    # -> {"status":"ok"}
```

### 3. First login

Open <http://localhost:8080>. Every page redirects to `/login` until you are
signed in; enter the password from step 1. There are no user accounts — the
password *is* the operator — and the session cookie lasts 7 days.

The home page is the [overview](docs/interface.md#overview); the sidebar links
to **Sessions**, **Pull requests**, **Recurring tasks**, **Repositories**,
**Terminals** and **Settings**. Until setup is complete the overview shows a
checklist of what is still missing — Claude Code not signed in, no repository
yet — which is steps 4–6.

### 4. Add a GitHub token

chief-web opens pull requests with a **GitHub Personal Access Token**. Create
one at <https://github.com/settings/tokens>, in either flavour:

| Token type | Where | What to grant |
| --- | --- | --- |
| **Classic PAT** | Settings → Developer settings → Personal access tokens → **Tokens (classic)** | the **`repo`** scope (that whole checkbox; it covers private repositories and pull requests) |
| **Fine-grained token** | … → **Fine-grained tokens** | *Repository access*: the repositories chief-web will work on. *Repository permissions*: **Contents: Read and write** and **Pull requests: Read and write** |

Prefer the fine-grained token: it can be limited to the repositories you
actually hand to chief-web. If those repositories belong to an organisation, a
fine-grained token has to be approved by an org owner before it works.

Give it an expiry you are willing to renew — an expired token fails at the very
last step of a session, when the pull request is opened
([troubleshooting](docs/troubleshooting.md#recovering-a-failed-session)).

Then in chief-web: **Settings → GitHub Personal Access Token**, paste, **Save**,
then press **Validate**. Validate calls `GET https://api.github.com/user` and
shows the account the token authenticates as, so a typo is caught here rather
than at the end of a build. The token is write-only from then on: the UI only
ever shows whether one is stored plus its last four characters.

The token opens pull requests. It is *not* how sessions push code — that is the
per-repository deploy key in the next step.

### 5. Add a repository and its deploy key

Go to **Repositories → Add repository**:

| Field | Value |
| --- | --- |
| **Name** | how it appears in chief-web |
| **SSH URL** | `git@github.com:owner/repo.git` — SSH, not HTTPS |
| **GitHub slug** | `owner/repo`, derived from the URL; override it only for an unusual remote |
| **Default base branch** | what sessions branch from by default (`main`, `develop`, …) |
| **SSH key** | leave **Generate a new ed25519 keypair** selected |

Save. chief-web generates the keypair and shows you the **public** half under
**Deploy key**, with a **Copy public key** button and a link straight to the
right GitHub page.

On GitHub, go to `https://github.com/<owner>/<repo>/settings/keys/new`, paste the
key, give it a title (`chief-web`), and — this is the part everyone forgets —
**tick "Allow write access"**. Sessions push their feature branch with this key;
a read-only deploy key clones fine and then fails at the first push.

Back in chief-web, press **Test connection**. It runs `git ls-remote` in a
short-lived runner container using that key and reports either success or git's
own stderr. Do not skip it: it turns a mistake here into one line of output now
instead of a failed session later.

If you would rather use a key you already have, pick **Paste an existing private
key** instead. It must be **unencrypted** — a session container has no way to
answer a passphrase prompt. The private half never leaves the server: it is
stored `0600` on the data volume and is never returned by the API, shown in the
UI, or written to a log.

Repeat for every repository you want chief-web to work on. Each gets its own
key.

### 6. Sign Claude Code in

Go to **Settings → Claude Code** and press **Set up Claude**. chief-web starts a
temporary container with only the credentials volume mounted, runs
`claude auth login` in it, and shows the terminal inline:

1. Select the URL it prints, copy it with **Ctrl+Shift+C**, and open it in a
   new tab.
2. Approve the request in your browser and copy the code Claude gives you back.
3. Paste it into the terminal with **Ctrl+Shift+V** and press Enter.
4. Press **Close login terminal**.

The indicator flips to **Authenticated** immediately — closing the terminal
removes the container and re-probes. The credentials live in the named
`chief-web-claude-auth` volume and are shared by every session container, so
this is a one-time step that survives `docker compose down` and restarts.

**Creating or planning a session is blocked until this says Authenticated**, on
purpose: an agent that cannot authenticate would otherwise fail on its first
invocation, a long way from the cause.

Setup is done. Everything after this is per session.

## Configuration

All environment variables are documented in [`.env.example`](.env.example).

## Documentation

The rest of the manual lives in [`docs/`](docs/):

| Document | What is in it |
| --- | --- |
| [Your first session](docs/first-session.md) | one feature end to end: create, plan a PRD, mark ready, build, pull request, merge |
| [Architecture](docs/architecture.md) | one container per session, the volumes, the Docker socket, the data layer, the runner image |
| [Repositories](docs/repositories.md) | registering a remote, deploy keys, testing the connection |
| [Sessions](docs/sessions.md) | what a session is, setup, sessions a recurring task started, planning the PRD, marking it ready, the session states |
| [The build loop](docs/build-loop.md) | the Ralph loop, the live log, the usage-limit hold, push and pull request, failure and recovery |
| [Code review](docs/code-review.md) | the per-session flag, the review model, what lands on the pull request, the three attempts, the feedback hand-off, reviewing an open pull request by hand |
| [Scheduling and concurrency](docs/scheduling.md) | scheduled starts, recurring tasks and the FIFO build queue |
| [Merge conflict fixer](docs/merge-conflicts.md) | the conflict scan, the `chief/`-branch rule, the three attempts, and what letting an agent push to your pull requests means |
| [Web interface](docs/interface.md) | the layout and shortcuts, the overview, sessions, browser terminals, the settings page |
| [Claude authentication](docs/claude-auth.md) | the one-time login and the shared credentials volume |
| [Security model](docs/security.md) | what the password protects, and what it does not |
| [Troubleshooting](docs/troubleshooting.md) | SSH failures, auth failures, recovering a failed session |
| [Development](docs/development.md) | running it from source, the quality checks |
