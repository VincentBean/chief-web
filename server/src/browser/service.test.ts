import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { DockerApi } from '../docker/index.js';
import { FakeBrowser, FakeDockerDaemon } from '../docker/fake-daemon.js';
import {
  BROWSER_CLOSED_MESSAGE,
  BrowserError,
  type BrowserEvent,
  BrowserService,
  chromiumCommand,
  chromiumStartFailure,
  formatMemory,
  idleClosedMessage,
  NO_BROWSER_MESSAGE,
  parseMemoryLimit,
} from './index.js';

const until = async (condition: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('session browser', () => {
  let daemon: FakeDockerDaemon;
  let docker: DockerApi;
  let browser: FakeBrowser;
  let service: BrowserService;
  let seq = 0;

  const newSession = (): string => {
    seq += 1;
    const sessionId = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
    daemon.addContainer({ id: `c-${sessionId}`, name: `chief-web-s${String(seq)}` });
    return sessionId;
  };

  const closedEvents = (sessionId: string): BrowserEvent[] => {
    const events: BrowserEvent[] = [];
    const unsubscribe = service.subscribe(sessionId, (event) => events.push(event));
    assert.notEqual(unsubscribe, null);
    return events;
  };

  before(async () => {
    daemon = await FakeDockerDaemon.start();
    docker = new DockerApi(daemon.socketPath);
  });

  after(async () => {
    await daemon.close();
  });

  beforeEach(() => {
    daemon.onExec = null;
    browser = new FakeBrowser(daemon);
    service = new BrowserService({ docker, container: (sessionId) => Promise.resolve(`c-${sessionId}`) });
  });

  it('starts Chromium as uid 1000 under the pid-file wrapper, then the relay', async () => {
    const sessionId = newSession();
    const info = await service.start(sessionId);

    assert.deepEqual(info, { sessionId, containerId: `c-${sessionId}`, targetId: 'page-1' });
    assert.equal(service.isRunning(sessionId), true);

    const chromium = browser.chromiumExecs().find((exec) => exec.containerId === `c-${sessionId}`);
    assert.ok(chromium);
    assert.equal(chromium.user, '1000');
    assert.equal(chromium.running, true);
    assert.deepEqual(chromium.cmd.slice(0, 2), ['/bin/sh', '-c']);
    assert.match(chromium.cmd[2] ?? '', /mkdir -p \/tmp\/\.chief-browser .*echo \$\$ > \/tmp\/\.chief-browser\/[0-9a-f-]+\.pid; exec "\$@"/);
    assert.deepEqual(chromium.cmd.slice(4), [
      'chromium',
      '--headless=new',
      '--remote-debugging-port=9222',
      '--remote-debugging-address=127.0.0.1',
      '--no-sandbox',
      '--disable-gpu',
      '--window-size=1280,800',
      '--user-data-dir=/tmp/.chief-browser/profile',
    ]);
    assert.deepEqual(chromium.cmd.slice(4), chromiumCommand());

    const relay = browser.relayExecs().find((exec) => exec.containerId === `c-${sessionId}`);
    assert.ok(relay);
    assert.deepEqual(relay.cmd, ['node', '/usr/local/lib/chief-web/cdp-relay.js']);
    assert.equal(relay.user, '1000');
    assert.equal(relay.attachStdin, true);
    assert.equal(relay.tty, false);

    await service.stop(sessionId);
  });

  it('returns the running browser when started twice, also when both starts overlap', async () => {
    const sessionId = newSession();
    const [first, second] = await Promise.all([service.start(sessionId), service.start(sessionId)]);
    const third = await service.start(sessionId);

    assert.deepEqual(first, second);
    assert.deepEqual(first, third);
    assert.equal(browser.chromiumExecs().filter((exec) => exec.containerId === `c-${sessionId}`).length, 1);
    assert.equal(browser.relayExecs().filter((exec) => exec.containerId === `c-${sessionId}`).length, 1);

    await service.stop(sessionId);
  });

  it('sends CDP commands through the relay and streams its events', async () => {
    const sessionId = newSession();
    await service.start(sessionId);
    browser.replies.set('Runtime.evaluate', (params) => ({ result: { result: { type: 'number', value: 2, echo: params['expression'] } } }));
    browser.replies.set('Page.navigate', () => ({ error: 'Cannot navigate to invalid URL' }));

    const events: BrowserEvent[] = [];
    service.subscribe(sessionId, (event) => events.push(event));

    assert.deepEqual(await service.send(sessionId, 'Page.enable'), {});
    assert.deepEqual(await service.send(sessionId, 'Runtime.evaluate', { expression: '1+1' }), {
      result: { type: 'number', value: 2, echo: '1+1' },
    });
    await assert.rejects(service.send(sessionId, 'Page.navigate', { url: 'nope' }), (error: unknown) => {
      assert.ok(error instanceof BrowserError);
      assert.equal(error.code, 'cdp_error');
      assert.equal(error.message, 'Cannot navigate to invalid URL');
      return true;
    });
    assert.deepEqual(
      browser.commands.map((command) => [command.id, command.method]),
      [
        [1, 'Page.enable'],
        [2, 'Runtime.evaluate'],
        [3, 'Page.navigate'],
      ],
    );

    browser.emitEvent('Page.frameNavigated', { frame: { id: 'page-1', url: 'https://example.test/checkout' } });
    await until(() => events.length === 1);
    assert.deepEqual(events[0], {
      type: 'cdp',
      method: 'Page.frameNavigated',
      params: { frame: { id: 'page-1', url: 'https://example.test/checkout' } },
    });

    await service.stop(sessionId);
  });

  it('stops Chromium with TERM through its pid file and ends the relay', async () => {
    const sessionId = newSession();
    await service.start(sessionId);
    const events = closedEvents(sessionId);

    await service.stop(sessionId);

    assert.deepEqual(browser.signals, ['TERM']);
    const signal = daemon
      .execs()
      .find((exec) => exec.containerId === `c-${sessionId}` && !exec.attachStdin && exec.cmd.join(' ').includes('kill -'));
    assert.ok(signal);
    assert.match(signal.cmd.join(' '), /\/tmp\/\.chief-browser\/[0-9a-f-]+\.pid/);
    assert.match(signal.cmd.join(' '), /grep -qa chief-browser \/proc/);
    assert.equal(browser.chromiumExecs().some((exec) => exec.running), false);
    assert.equal(browser.relayExecs().some((exec) => exec.running), false);
    assert.equal(service.isRunning(sessionId), false);
    assert.deepEqual(events, [{ type: 'closed', crashed: false, message: BROWSER_CLOSED_MESSAGE }]);
    await assert.rejects(service.send(sessionId, 'Page.enable'), { code: 'browser_closed', message: BROWSER_CLOSED_MESSAGE });

    // Stopping again, or a session that never had one, is a no-op.
    await service.stop(sessionId);
    await service.stop(newSession());
  });

  it('reports a Chromium that dies as closed, failing what was in flight', async () => {
    // Past the startup window, a crash is just "Browser closed".
    service = new BrowserService({ docker, container: (id) => Promise.resolve(`c-${id}`), startupWindowMs: 0 });
    const sessionId = newSession();
    await service.start(sessionId);
    const events = closedEvents(sessionId);
    browser.silent = true;
    const inFlight = service.send(sessionId, 'Page.navigate', { url: 'https://example.test' });
    await until(() => browser.commands.length > 0);

    browser.crash();

    await assert.rejects(inFlight, { code: 'browser_closed', message: 'Browser closed' });
    await until(() => events.length === 1);
    assert.deepEqual(events, [{ type: 'closed', crashed: true, message: 'Browser closed' }]);
    assert.equal(service.isRunning(sessionId), false);
    assert.equal(browser.relayExecs().some((exec) => exec.running), false);
  });

  it('closes the browser when the relay dies, signals the Chromium it leaves, and restarts fresh', async () => {
    const sessionId = newSession();
    await service.start(sessionId);
    const events = closedEvents(sessionId);
    browser.silent = true;
    const inFlight = service.send(sessionId, 'Runtime.evaluate', { expression: 'document.title' });
    await until(() => browser.commands.length > 0);

    browser.killRelays();

    await assert.rejects(inFlight, (error: unknown) => {
      assert.ok(error instanceof BrowserError);
      assert.equal(error.code, 'browser_closed');
      return true;
    });
    await until(() => events.length === 1);
    assert.deepEqual(events, [{ type: 'closed', crashed: true, message: BROWSER_CLOSED_MESSAGE }]);
    assert.equal(service.isRunning(sessionId), false);
    // Nothing reconnects; the orphaned Chromium is signalled instead.
    await until(() => !browser.chromiumExecs().some((exec) => exec.running));
    assert.deepEqual(browser.signals, ['TERM']);
    const mine = (execs: readonly { containerId: string }[]): number =>
      execs.filter((exec) => exec.containerId === `c-${sessionId}`).length;
    assert.equal(mine(browser.relayExecs()), 1);

    browser.silent = false;
    await service.start(sessionId);
    assert.equal(mine(browser.chromiumExecs()), 2);
    assert.equal(mine(browser.relayExecs()), 2);
    assert.deepEqual(await service.send(sessionId, 'Page.enable'), {});
    await service.stop(sessionId);
  });

  it('fails the start when the relay cannot reach Chromium, leaving nothing behind', async () => {
    const sessionId = newSession();
    // Chromium exits the moment it starts, so the relay finds no DevTools endpoint.
    const previous = daemon.onExec;
    daemon.onExec = (exec) => {
      const script = previous?.(exec) ?? {};
      if (exec.cmd.includes('chromium')) setImmediate(() => daemon.finish(exec.id, 1));
      return script;
    };

    await assert.rejects(service.start(sessionId), (error: unknown) => {
      assert.ok(error instanceof BrowserError);
      assert.equal(error.code, 'browser_unavailable');
      return true;
    });
    assert.equal(service.isRunning(sessionId), false);
    assert.equal(browser.relayExecs().some((exec) => exec.running), false);
  });

  it('reports a container that cannot be started', async () => {
    const failing = new BrowserService({ docker, container: () => Promise.reject(new Error('no such image')) });
    await assert.rejects(failing.start(newSession()), {
      code: 'browser_unavailable',
      message: 'The session container could not be started: no such image',
    });
  });

  describe('limits and failure modes (voice feedback US-012)', () => {
    const logs: string[] = [];
    const captureWarnings = (): (() => void) => {
      const original = console.error;
      console.error = (line: unknown) => logs.push(String(line));
      return () => {
        console.error = original;
      };
    };

    it('runs at most maxBrowsers at once, answering the rest "no browser available right now"', async () => {
      const capped = new BrowserService({ docker, container: (id) => Promise.resolve(`c-${id}`), maxBrowsers: 2 });
      const [a, b, c] = [newSession(), newSession(), newSession()];
      await Promise.all([capped.start(a), capped.start(b)]);

      await assert.rejects(capped.start(c), { code: 'browser_limit', message: NO_BROWSER_MESSAGE });
      assert.equal(NO_BROWSER_MESSAGE, 'no browser available right now');
      assert.equal(browser.chromiumExecs().filter((exec) => exec.containerId === `c-${c}`).length, 0, 'nothing was started for it');
      // A session that has one gets its own back, never a second.
      assert.equal((await capped.start(a)).sessionId, a);
      assert.equal(browser.chromiumExecs().filter((exec) => exec.containerId === `c-${a}`).length, 1);

      await capped.stop(a);
      await capped.start(c);
      assert.equal(capped.isRunning(c), true);
      await capped.stopAll();
    });

    it('stops a browser nothing used for idleMs, and says why', async () => {
      const idle = new BrowserService({ docker, container: (id) => Promise.resolve(`c-${id}`), idleMs: 150 });
      const sessionId = newSession();
      await idle.start(sessionId);
      const events: BrowserEvent[] = [];
      idle.subscribe(sessionId, (event) => events.push(event));

      // Tool calls and frame requests (every send) keep it alive.
      for (let i = 0; i < 4; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        if (i % 2 === 0) idle.touch(sessionId);
        else await idle.send(sessionId, 'Page.screencastFrameAck', { sessionId: 1 });
      }
      assert.equal(idle.isRunning(sessionId), true);
      assert.deepEqual(events.filter((event) => event.type === 'closed'), []);

      await until(() => events.some((event) => event.type === 'closed'));
      assert.deepEqual(events.at(-1), { type: 'closed', crashed: false, message: 'Browser closed after 0 seconds without use' });
      assert.equal(idle.isRunning(sessionId), false);
      assert.ok(browser.signals.includes('TERM'), 'Chromium was stopped, not left behind');
      assert.equal(idleClosedMessage(600_000), 'Browser closed after 10 minutes without use');
      assert.equal(idleClosedMessage(60_000), 'Browser closed after 1 minute without use');
    });

    it('refuses to start Chromium in a container with less than 1 GB of memory', async () => {
      daemon.onExec = (exec) =>
        exec.cmd.join(' ').includes('/sys/fs/cgroup/memory.max') ? { stdout: `${String(512 * 1024 ** 2)}\n` } : {};
      browser = new FakeBrowser(daemon);
      const sessionId = newSession();

      await assert.rejects(service.start(sessionId), {
        code: 'browser_memory',
        message:
          'the session container has only 512 MB of memory and the browser needs at least 1 GB; raise CONTAINER_MEMORY_LIMIT_MB',
      });
      assert.equal(browser.chromiumExecs().filter((exec) => exec.containerId === `c-${sessionId}`).length, 0);

      // cgroup v2 "max", or exactly 1 GB, is enough.
      daemon.onExec = (exec) => (exec.cmd.join(' ').includes('/sys/fs/cgroup/memory.max') ? { stdout: 'max\n' } : {});
      browser = new FakeBrowser(daemon);
      await service.start(sessionId);
      await service.stop(sessionId);
    });

    it('reads cgroup memory limits', () => {
      assert.equal(parseMemoryLimit('max\n'), null);
      assert.equal(parseMemoryLimit(''), null);
      assert.equal(parseMemoryLimit('9223372036854771712\n'), null, 'cgroup v1 for no limit');
      assert.equal(parseMemoryLimit('1073741824\n'), 1024 ** 3);
      assert.equal(formatMemory(1536 * 1024 ** 2), '1.5 GB');
    });

    it('names a missing Chromium binary and logs its stderr', async () => {
      browser.startFailure = { exitCode: 127, stderr: '/bin/sh: exec: line 1: chromium: not found\n' };
      const sessionId = newSession();
      const restore = captureWarnings();
      try {
        await assert.rejects(service.start(sessionId), {
          code: 'browser_unavailable',
          message: 'Chromium is not installed in the session container (/bin/sh: exec: line 1: chromium: not found)',
        });
      } finally {
        restore();
      }
      assert.equal(service.isRunning(sessionId), false);
      assert.equal(browser.relayExecs().some((exec) => exec.running), false);
      const logged = logs.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line['session'] === sessionId && line['message'] === 'the session browser failed to start');
      assert.ok(logged, 'the failure is logged');
      assert.equal(logged['exitCode'], 127);
      assert.match(String(logged['stderr']), /chromium: not found/);
    });

    it('reports a Chromium that crashes within 5 seconds of its start with its cause', async () => {
      const sessionId = newSession();
      await service.start(sessionId);
      const events = closedEvents(sessionId);
      const restore = captureWarnings();
      try {
        browser.crash(134, '[0926/124200.000:FATAL:zygote_host_impl_linux.cc(127)] No usable sandbox!\n');
        await until(() => events.length === 1);
      } finally {
        restore();
      }
      assert.deepEqual(events, [
        {
          type: 'closed',
          crashed: true,
          message: 'Chromium crashed while starting with exit code 134: [0926/124200.000:FATAL:zygote_host_impl_linux.cc(127)] No usable sandbox!',
        },
      ]);
      assert.equal(chromiumStartFailure(null, ''), 'Chromium crashed while starting');
    });
  });

  it('stops every browser', async () => {
    const [a, b] = [newSession(), newSession()];
    await Promise.all([service.start(a), service.start(b)]);
    await service.stopAll();
    assert.equal(service.isRunning(a), false);
    assert.equal(service.isRunning(b), false);
    assert.equal(browser.chromiumExecs().some((exec) => exec.running), false);
  });
});
