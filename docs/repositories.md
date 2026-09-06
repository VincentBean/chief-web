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

## Code review context

**Code review context** on the repository form is free-form text that is added
to the prompt of every [code review](code-review.md) of this repository — the
pass a session runs after it opens its pull request, and the one the **Review**
button runs by hand. Write what a reviewer who has never seen the repository
would need: its conventions, the places it has been bitten before, and the
directories to leave alone.

- It is **markdown**, and the **Write** / **Preview** toggle above the box
  switches between the raw text and how it renders. Nothing else in chief-web
  displays it — it is there to be read by the review agent.
- Up to **10,000 characters**. The form counts them as you type and refuses to
  save over the limit, and the API rejects an over-long value with a 400.
- **Optional and clearable.** Emptying the box — or leaving nothing but
  whitespace in it — clears the stored value on save, and reviews of the
  repository go back to the standard prompt.

Deleting a repository is refused while any session still references it; delete
those sessions first. A successful delete also removes the private key file.
