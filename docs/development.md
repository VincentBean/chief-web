[← chief-web](../README.md) · [All docs](../README.md#documentation)

# Development

Requires Node.js 22+.

```sh
npm install
npm run dev          # API on :8080 (tsx watch)
npm run dev -w web   # UI on :5173, proxying /api to :8080
```

Quality checks — these must pass before every commit:

```sh
npm run typecheck
npm run lint
npm test
```

A production build (`npm run build`) compiles the server to `server/dist` and the
frontend to `web/dist`; `npm start` then serves both from a single port.

## The runner image and its browser

`runner/Dockerfile` builds the image every session container runs
(`docker compose build runner`). Since the feedback sessions it also carries a
headless Chromium (Alpine's `chromium`, plus `font-dejavu` and
`font-liberation` for Latin text), which the agent and the operator share
during a call. That makes the image **roughly 750 MB larger** (uncompressed):
Chromium alone installs 305 MiB, and its libraries, codecs, GTK and fonts —
173 packages the image did not have — come to about 755 MiB in all. Measured
by installing the same packages into an `apk --root` on Alpine 3.24, not by
comparing two `docker compose build`s.

Chromium's DevTools port (9222) only listens on the container's loopback, and
no container port is published. The server reaches it through
`runner/cdp-relay.js`, installed as `/usr/local/lib/chief-web/cdp-relay.js`
and run with `docker exec`: one Chrome DevTools Protocol message per line on
its stdin and stdout (see `server/src/browser/`). The service's tests play
both processes on the fake Docker daemon (`FakeBrowser` in
`server/src/docker/fake-daemon.ts`), so no Docker is needed to run them.
