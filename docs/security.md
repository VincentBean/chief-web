[← chief-web](../README.md) · [All docs](../README.md#documentation)

# Security model

- The UI is protected by a **single shared password** (`CHIEF_WEB_PASSWORD`).
  There are no user accounts. If the variable is unset, the server generates a
  password on first boot, logs it once and persists only its scrypt hash; setting
  the variable always takes precedence over that stored hash.
- **Failed sign-ins are throttled.** `POST /api/auth/login` allows
  `LOGIN_ATTEMPT_LIMIT` failures (5) per client within
  `LOGIN_ATTEMPT_WINDOW_MS` (15 minutes) and answers `429` with a `Retry-After`
  until the sliding window frees an attempt. It is checked before the password
  is verified, so a refused attempt costs no scrypt — which matters, because
  that hash is deliberately expensive and the server is single-threaded. Only
  failures count and a success clears the record. The counters are per client
  address and held in memory: behind a reverse proxy every client shares one
  bucket, since the app does not trust forwarded headers, and a restart clears
  them.
- Logging in sets `chief_session`, an `HttpOnly`, `SameSite=Lax` cookie holding an
  HMAC-signed, 7-day token. Changing the password invalidates every existing
  cookie. Everything requires it except `GET /api/health`, `POST /api/auth/login`,
  the `/login` page and the static frontend bundle (which serves that page).
  Unauthenticated page loads redirect to `/login`; API calls get `401`; WebSocket
  handshakes are closed with code `4401`.
- A browser terminal is a shell inside a container with the same reach as the
  container itself, and `GET /api/containers` lists every running container on
  the host. Both are behind the shared password; the same single-operator
  assumption as the Docker socket applies.
- The `server` container mounts `/var/run/docker.sock` so it can spawn one
  container per session. **This grants the server root-equivalent control of the
  host.** This is accepted for a single-operator, self-hosted deployment; do not
  expose chief-web to untrusted users.
- The GitHub token is stored in plain text in the SQLite database, and repository
  SSH private keys in plain text on the data volume (`0600`): the server must be
  able to use both unattended, so protect the data volume rather than the values.
  Private keys never leave the server — no API response, log line or UI element
  contains one. The per-session copy a container mounts is `0400`, owned by the
  runner user, and is staged outside the workspace so it can never end up inside
  the clone or a commit. Inside the container the agent runs as that same user
  and can read the key — it has to, in order to push.
- There is no HTTPS termination. Put a reverse proxy in front if you expose it
  beyond localhost.
