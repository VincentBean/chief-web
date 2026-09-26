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
    const signal = daemon.execs().find((exec) => exec.containerId === `c-${sessionId}` && !exec.attachStdin);
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

  it('stops every browser', async () => {
    const [a, b] = [newSession(), newSession()];
    await Promise.all([service.start(a), service.start(b)]);
    await service.stopAll();
    assert.equal(service.isRunning(a), false);
    assert.equal(service.isRunning(b), false);
    assert.equal(browser.chromiumExecs().some((exec) => exec.running), false);
  });
});
