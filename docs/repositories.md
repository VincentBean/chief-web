[← chief-web](../README.md) · [All docs](../README.md#documentation)

# Repositories

`/repositories` registers the git remotes sessions work on. Each repository has a
name, an SSH URL (`git@github.com:owner/repo.git`), a GitHub `owner/repo` slug —
derived from the URL, overridable — and a default base branch.

Every repository gets **its own SSH key**:

- On add, chief-web generates an **ed25519** keypair and shows you the public
  half. Add it as a *deploy key* on `github.com/<owner>/<repo>/settings/keys` and
  tick **Allow write access**, since sessions push their feature branch with it.
- Alternatively, paste an existing **unencrypted** private key. A
  passphrase-protected key is rejected: a session container has no way to unlock
  it.
- The private key is written to `SSH_KEYS_DIR/<repository id>.key` with mode
  `0600` in a `0700` directory, and is never returned by the API or shown in the
  UI after creation — only its `SHA256:…` fingerprint is.

**Test connection** runs `git ls-remote` in a short-lived runner container with
that key on stdin (never in argv or the environment) and reports either success
or git's own stderr, so a missing deploy key shows up as
`Permission denied (publickey)` rather than a generic failure. It needs the
runner image (`RUNNER_IMAGE`, built by the compose stack).

Deleting a repository is refused while any session still references it; delete
those sessions first. A successful delete also removes the private key file.
