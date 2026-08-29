# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# chief-web runner image (US-006).
#
# One container per session: it holds the repository clone and is where every
# agent, git and shell process runs. The server starts it with the idle command
# below and `docker exec`s work into it, so the image only has to provide the
# tools and a correctly configured environment.
# ---------------------------------------------------------------------------
FROM node:22-alpine

# Pin the agent CLI so rebuilding the image is reproducible; bump deliberately.
ARG CLAUDE_CODE_VERSION=2.1.251

# git/openssh-client: clone, commit, push over SSH.
# bash/ripgrep/jq/curl/less: the shell and search tools the agent expects.
# libgcc/libstdc++: musl runtime deps of the CLI's native pieces.
# tini: PID 1 that reaps the processes the server execs into the container.
RUN apk add --no-cache \
        bash \
        ca-certificates \
        curl \
        git \
        jq \
        less \
        libgcc \
        libstdc++ \
        openssh-client \
        ripgrep \
        tini

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force \
 && claude --version

# SSH: GitHub's host keys are pinned, everything else is accept-new so a clone
# from any other remote still runs non-interactively.
COPY ssh/known_hosts /etc/ssh/ssh_known_hosts
COPY ssh/ssh_config /etc/ssh/chief-web_ssh_config
RUN cat /etc/ssh/chief-web_ssh_config /etc/ssh/ssh_config > /etc/ssh/ssh_config.new \
 && mv /etc/ssh/ssh_config.new /etc/ssh/ssh_config \
 && rm /etc/ssh/chief-web_ssh_config \
 && chmod 644 /etc/ssh/ssh_config /etc/ssh/ssh_known_hosts

COPY entrypoint.sh /usr/local/bin/chief-web-entrypoint
RUN chmod 755 /usr/local/bin/chief-web-entrypoint

# `node` (uid 1000) already exists in the base image; the container never runs
# as root. Both directories are created here so that the volumes mounted over
# them inherit this ownership instead of ending up root-owned.
#   /home/node/.claude  → the shared `claude-auth` volume (FR-5)
#   /workspace          → the per-session workspace from the data volume
RUN mkdir -p /home/node/.claude /home/node/.ssh /workspace \
 && chown -R node:node /home/node /workspace \
 && chmod 700 /home/node/.ssh

ENV HOME=/home/node \
    # Keeps *all* Claude Code state (credentials, config) inside the mounted
    # volume instead of the container-local ~/.claude.json.
    CLAUDE_CONFIG_DIR=/home/node/.claude \
    # The CLI's bundled ripgrep is glibc-only; use the Alpine package instead.
    USE_BUILTIN_RIPGREP=0 \
    CHIEF_GIT_AUTHOR_NAME=chief-web \
    CHIEF_GIT_AUTHOR_EMAIL=chief-web@localhost \
    CHIEF_SSH_KEY_PATH=/keys/id_ed25519

USER node
WORKDIR /workspace
VOLUME ["/home/node/.claude"]

# Idle by design: the server execs into a running container, so PID 1 only has
# to stay alive and reap children.
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/chief-web-entrypoint"]
CMD ["tail", "-f", "/dev/null"]
