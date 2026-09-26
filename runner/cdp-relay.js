'use strict';

// ---------------------------------------------------------------------------
// chief-web CDP relay (voice feedback US-005).
//
// The session's headless Chromium listens for the Chrome DevTools Protocol on
// 127.0.0.1:9222 *inside* the container, and no container port is published.
// The server runs this script with `docker exec` (stdin attached) and talks
// CDP over the exec's stdio instead:
//
//   stdin  → one CDP message per line → the page's WebSocket
//   stdout ← one CDP message per line ← the page's WebSocket
//
// Besides CDP messages, stdout carries relay lines, told apart by a `relay`
// key (a CDP message always has `id` or `method` instead):
//
//   {"relay":"ready","targetId":"…","url":"…"}   connected, send away
//
// Nothing is retried once connected: when the WebSocket closes (Chromium
// died) the relay says why on stderr and exits 1. End of stdin exits 0.
//
// Node's built-in WebSocket and fetch only; the image installs no packages
// for this.
// ---------------------------------------------------------------------------

const ENDPOINT = 'http://127.0.0.1:9222';
/** How long Chromium may take to open its DevTools port. */
const STARTUP_TIMEOUT_MS = 15_000;
const POLL_MS = 200;

function fail(message) {
  process.stderr.write(`cdp-relay: ${message}\n`);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The first page target, once the DevTools port answers; a new blank page when there is none. */
async function pageTarget() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError = 'no answer';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${ENDPOINT}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page');
      if (page !== undefined) return page;
      const created = await fetch(`${ENDPOINT}/json/new?about:blank`, { method: 'PUT' });
      return await created.json();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(POLL_MS);
  }
  throw new Error(`Chromium's DevTools endpoint did not answer: ${lastError}`);
}

async function main() {
  const target = await pageTarget();
  const socket = new WebSocket(`ws://127.0.0.1:9222/devtools/page/${target.id}`);
  let open = false;
  let pending = '';
  const queued = [];

  const forward = (line) => {
    if (line.trim() === '') return;
    if (open) socket.send(line);
    else queued.push(line);
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) forward(line);
  });
  process.stdin.on('end', () => {
    forward(pending);
    socket.close();
    process.exit(0);
  });

  socket.addEventListener('open', () => {
    open = true;
    process.stdout.write(`${JSON.stringify({ relay: 'ready', targetId: target.id, url: target.url ?? '' })}\n`);
    for (const line of queued.splice(0)) socket.send(line);
  });
  socket.addEventListener('message', (event) => {
    // Re-serialised so a message can never span two lines.
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    process.stdout.write(`${JSON.stringify(message)}\n`);
  });
  socket.addEventListener('error', () => fail('the DevTools connection failed'));
  socket.addEventListener('close', () => fail('the DevTools connection closed'));
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
