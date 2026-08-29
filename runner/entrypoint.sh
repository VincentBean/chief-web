#!/bin/sh
# chief-web runner entrypoint (US-006).
#
# Runs as the unprivileged `node` user before every container command. It makes
# the container self-sufficient for git work — commit identity and SSH key — and
# then execs its argument, which by default is an idle loop: the server keeps the
# container alive and `docker exec`s the agent, git and shell processes into it.
set -e

: "${CHIEF_GIT_AUTHOR_NAME:=chief-web}"
: "${CHIEF_GIT_AUTHOR_EMAIL:=chief-web@localhost}"
: "${CHIEF_SSH_KEY_PATH:=/keys/id_ed25519}"

# Commit identity: without this every agent commit fails with
# "Please tell me who you are". Both values are overridable from the settings
# page, which passes them in as environment variables.
git config --global user.name "$CHIEF_GIT_AUTHOR_NAME"
git config --global user.email "$CHIEF_GIT_AUTHOR_EMAIL"
git config --global init.defaultBranch main
git config --global advice.detachedHead false
# The workspace is a bind mount from the host and may be owned by another uid.
git config --global --add safe.directory '*'

mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
touch "$HOME/.ssh/known_hosts"
chmod 600 "$HOME/.ssh/known_hosts"

# The repository key is mounted read-only and may be owned by root, so it is
# copied to a private 0600 file we definitely own — ssh refuses group- or
# world-readable keys outright.
key="$HOME/.ssh/id_repository"
if [ -r "$CHIEF_SSH_KEY_PATH" ]; then
    rm -f "$key"
    (umask 077 && cat "$CHIEF_SSH_KEY_PATH" > "$key")
elif [ -e "$CHIEF_SSH_KEY_PATH" ]; then
    echo "chief-web: $CHIEF_SSH_KEY_PATH is not readable by $(id -un) — SSH will fail" >&2
fi

# Written at run time rather than baked in because the key path is configurable.
umask 077
cat > "$HOME/.ssh/config" <<CONFIG
Host *
    IdentityFile $key
    IdentitiesOnly yes
    UserKnownHostsFile $HOME/.ssh/known_hosts
CONFIG
umask 022

exec "$@"
