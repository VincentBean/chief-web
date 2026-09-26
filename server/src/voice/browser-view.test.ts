import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { BROWSER_CLOSED_MESSAGE, BrowserService } from '../browser/index.js';
import { DockerApi } from '../docker/index.js';
import { FakeBrowser, FakeDockerDaemon } from '../docker/fake-daemon.js';
import {
  BrowserView,
  parseViewInput,
  SCREENCAST_PARAMS,
  type ViewSink,
  WS_CLOSE_BROWSER_CLOSED,
  WS_CLOSE_VIEW_REPLACED,
} from './browser-view.js';

const until = async (condition: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

/** What the view sent down its socket, text parsed, binary kept. */
class RecordingSink implements ViewSink {
  readonly sent: (Record<string, unknown> | Buffer)[] = [];
  closedWith: { code: number; reason: string } | null = null;
  /** Hold the socket's "sent" callbacks, to see acks wait for them. */
  holdCallbacks = false;
  readonly held: (() => void)[] = [];

  send(data: string | Buffer, done: (error?: Error) => void): void {
    this.sent.push(typeof data === 'string' ? (JSON.parse(data) as Record<string, unknown>) : data);
    if (this.holdCallbacks) this.held.push(() => done());
    else setImmediate(() => done());
  }

  close(code: number, reason: string): void {
    this.closedWith = { code, reason };
  }

  json(): Record<string, unknown>[] {
    return this.sent.filter((entry): entry is Record<string, unknown> => !Buffer.isBuffer(entry));
  }

  frames(): Buffer[] {
    return this.sent.filter((entry): entry is Buffer => Buffer.isBuffer(entry));
  }
}

describe('page view', () => {
  let daemon: FakeDockerDaemon;
  let docker: DockerApi;
  let browser: FakeBrowser;
  let service: BrowserService;
  let seq = 0;

  const newSession = (): string => {
    seq += 1;
    const sessionId = `00000000-0000-4000-9000-${String(seq).padStart(12, '0')}`;
    daemon.addContainer({ id: `c-${sessionId}`, name: `chief-web-v${String(seq)}` });
    return sessionId;
  };

  /** A running browser and a view attached to it, screencast started. */
  const openView = async (): Promise<{ sessionId: string; view: BrowserView; sink: RecordingSink; relay: string }> => {
    const sessionId = newSession();
    await service.start(sessionId);
    const relay = browser.relayExecs().find((exec) => exec.containerId === `c-${sessionId}` && exec.running)?.id ?? '';
    const sink = new RecordingSink();
    const view = new BrowserView(service, sessionId, sink);
    await view.open();
    return { sessionId, view, sink, relay };
  };

  const commandsOf = (relay: string): { method: string; params: Record<string, unknown> }[] =>
    browser.commands.filter((command) => command.execId === relay).map(({ method, params }) => ({ method, params }));

  const frame = (data: Buffer, screencastSession: number, width = 1280, height = 800): Record<string, unknown> => ({
    data: data.toString('base64'),
    sessionId: screencastSession,
    metadata: { deviceWidth: width, deviceHeight: height, offsetTop: 0, pageScaleFactor: 1, scrollOffsetX: 0, scrollOffsetY: 0 },
  });

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
    browser.replies.set('Page.getFrameTree', () => ({
      result: { frameTree: { frame: { id: 'main', url: 'http://host.docker.internal:3000/login' } } },
    }));
    service = new BrowserService({ docker, container: (sessionId) => Promise.resolve(`c-${sessionId}`) });
  });

  it('enables the page, says the current URL and starts a JPEG screencast at quality 60, at most 1280×800', async () => {
    const { sink, relay } = await openView();

    assert.deepEqual(
      commandsOf(relay).map((command) => command.method),
      ['Page.enable', 'Page.getFrameTree', 'Page.startScreencast'],
    );
    assert.deepEqual(commandsOf(relay)[2]?.params, {
      format: 'jpeg',
      quality: 60,
      maxWidth: 1280,
      maxHeight: 800,
      everyNthFrame: 1,
    });
    assert.deepEqual(SCREENCAST_PARAMS.quality, 60);
    assert.deepEqual(sink.json(), [{ type: 'url', url: 'http://host.docker.internal:3000/login' }]);
  });

  it('forwards each frame as binary JPEG, says the page size once, and acknowledges every frame after the socket took it', async () => {
    const { sink, relay } = await openView();
    sink.holdCallbacks = true;
    const first = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const second = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6]);

    browser.emitEvent('Page.screencastFrame', frame(first, 7));
    await until(() => sink.frames().length === 1);
    await tick();
    assert.equal(commandsOf(relay).filter((command) => command.method === 'Page.screencastFrameAck').length, 0);
    for (const done of sink.held.splice(0)) done();
    await until(() => commandsOf(relay).some((command) => command.method === 'Page.screencastFrameAck'));

    browser.emitEvent('Page.screencastFrame', frame(second, 8));
    await until(() => sink.frames().length === 2);
    for (const done of sink.held.splice(0)) done();
    await until(() => commandsOf(relay).filter((command) => command.method === 'Page.screencastFrameAck').length === 2);

    assert.deepEqual(sink.frames(), [first, second]);
    assert.deepEqual(
      commandsOf(relay).filter((command) => command.method === 'Page.screencastFrameAck').map((command) => command.params),
      [{ sessionId: 7 }, { sessionId: 8 }],
    );
    // The page size precedes the first frame and is not repeated while it holds.
    const viewportAt = sink.sent.findIndex((entry) => !Buffer.isBuffer(entry) && entry['type'] === 'viewport');
    const firstFrameAt = sink.sent.findIndex((entry) => Buffer.isBuffer(entry));
    assert.ok(viewportAt >= 0 && viewportAt < firstFrameAt);
    assert.deepEqual(
      sink.json().filter((message) => message['type'] === 'viewport'),
      [{ type: 'viewport', width: 1280, height: 800 }],
    );

    browser.emitEvent('Page.screencastFrame', frame(first, 9, 1024, 700));
    await until(() => sink.frames().length === 3);
    assert.deepEqual(sink.json().at(-1), { type: 'viewport', width: 1024, height: 700 });
  });

  it('says the URL of every main-frame navigation, whoever made it, and ignores iframes', async () => {
    const { sink } = await openView();

    browser.emitEvent('Page.frameNavigated', { frame: { id: 'main', url: 'http://app.test/orders' } });
    browser.emitEvent('Page.frameNavigated', { frame: { id: 'ad', parentId: 'main', url: 'http://ads.test/' } });
    browser.emitEvent('Page.navigatedWithinDocument', { frameId: 'main', url: 'http://app.test/orders#42' });
    browser.emitEvent('Page.navigatedWithinDocument', { frameId: 'ad', url: 'http://ads.test/#x' });
    await until(() => sink.json().length >= 3);
    await tick();

    assert.deepEqual(
      sink.json().map((message) => message['url']),
      ['http://host.docker.internal:3000/login', 'http://app.test/orders', 'http://app.test/orders#42'],
    );
  });

  it('forwards mouse, wheel, key and resize messages as CDP commands', async () => {
    const { view, relay } = await openView();
    const before = commandsOf(relay).length;

    view.receive(JSON.stringify({ type: 'mouse', action: 'move', x: 10.5, y: 20, button: 'none' }));
    view.receive(JSON.stringify({ type: 'mouse', action: 'down', x: 10.5, y: 20, button: 'left', buttons: 1 }));
    view.receive(JSON.stringify({ type: 'mouse', action: 'up', x: 10.5, y: 20, button: 'left' }));
    view.receive(JSON.stringify({ type: 'wheel', x: 100, y: 200, deltaX: 0, deltaY: 120 }));
    view.receive(JSON.stringify({ type: 'key', action: 'down', key: 'a', code: 'KeyA', text: 'a', modifiers: 0 }));
    view.receive(JSON.stringify({ type: 'key', action: 'up', key: 'a', code: 'KeyA', modifiers: 0 }));
    view.receive(JSON.stringify({ type: 'key', action: 'down', key: 'Enter', code: 'Enter', modifiers: 0 }));
    view.receive(JSON.stringify({ type: 'key', action: 'down', key: 'Backspace', code: 'Backspace', modifiers: 0 }));
    view.receive(JSON.stringify({ type: 'key', action: 'down', key: 'A', code: 'KeyA', text: 'A', modifiers: 8 }));
    view.receive(JSON.stringify({ type: 'resize', width: 1024, height: 700 }));
    await until(() => commandsOf(relay).length === before + 10);

    assert.deepEqual(commandsOf(relay).slice(before), [
      {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mouseMoved', x: 10.5, y: 20, button: 'none', buttons: 0, clickCount: 0, modifiers: 0 },
      },
      {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mousePressed', x: 10.5, y: 20, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 },
      },
      {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mouseReleased', x: 10.5, y: 20, button: 'left', buttons: 0, clickCount: 1, modifiers: 0 },
      },
      {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mouseWheel', x: 100, y: 200, deltaX: 0, deltaY: 120 },
      },
      {
        method: 'Input.dispatchKeyEvent',
        params: {
          type: 'keyDown',
          key: 'a',
          code: 'KeyA',
          modifiers: 0,
          windowsVirtualKeyCode: 65,
          nativeVirtualKeyCode: 65,
          text: 'a',
          unmodifiedText: 'a',
        },
      },
      {
        method: 'Input.dispatchKeyEvent',
        params: { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 0, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 },
      },
      {
        method: 'Input.dispatchKeyEvent',
        params: {
          type: 'keyDown',
          key: 'Enter',
          code: 'Enter',
          modifiers: 0,
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
          text: '\r',
          unmodifiedText: '\r',
        },
      },
      {
        method: 'Input.dispatchKeyEvent',
        params: {
          type: 'rawKeyDown',
          key: 'Backspace',
          code: 'Backspace',
          modifiers: 0,
          windowsVirtualKeyCode: 8,
          nativeVirtualKeyCode: 8,
        },
      },
      {
        method: 'Input.dispatchKeyEvent',
        params: {
          type: 'keyDown',
          key: 'A',
          code: 'KeyA',
          modifiers: 8,
          windowsVirtualKeyCode: 65,
          nativeVirtualKeyCode: 65,
          text: 'A',
          unmodifiedText: 'A',
        },
      },
      {
        method: 'Emulation.setDeviceMetricsOverride',
        params: { width: 1024, height: 700, deviceScaleFactor: 1, mobile: false },
      },
    ]);
  });

  it('answers a malformed input with bad_message and forwards nothing', async () => {
    const { view, sink, relay } = await openView();
    const before = commandsOf(relay).length;

    view.receive('{"type":"mouse","action":"down","x":"10","y":20,"button":"left"}');
    await tick();

    assert.equal(commandsOf(relay).length, before);
    assert.deepEqual(sink.json().at(-1), { type: 'error', code: 'bad_message' });
  });

  it('Close browser stops Chromium and sends nothing more, not even the frames still coming', async () => {
    const { sessionId, view, sink } = await openView();
    const sentBefore = sink.sent.length;

    view.receive(JSON.stringify({ type: 'close' }));
    browser.emitEvent('Page.screencastFrame', frame(Buffer.from([1, 2, 3]), 1));
    browser.emitEvent('Page.frameNavigated', { frame: { id: 'main', url: 'http://app.test/late' } });
    await until(() => !service.isRunning(sessionId));
    await tick();

    assert.deepEqual(sink.closedWith, { code: WS_CLOSE_BROWSER_CLOSED, reason: 'closed' });
    assert.equal(sink.sent.length, sentBefore);
    assert.deepEqual(browser.signals.at(-1), 'TERM');
    assert.equal(view.closed, true);
  });

  it('says "Browser closed" when Chromium exits, and the next browser command fails with browser_closed', async () => {
    const { sessionId, sink } = await openView();

    browser.crash();
    await until(() => sink.closedWith !== null);

    assert.deepEqual(sink.json().at(-1), { type: 'closed', message: BROWSER_CLOSED_MESSAGE });
    assert.deepEqual(sink.closedWith, { code: WS_CLOSE_BROWSER_CLOSED, reason: 'browser_closed' });
    await assert.rejects(service.send(sessionId, 'Page.navigate', { url: 'http://app.test/' }), {
      code: 'browser_closed',
      message: BROWSER_CLOSED_MESSAGE,
    });
  });

  it('says "Browser closed" at once when the session has no browser, and does not start one', async () => {
    const sessionId = newSession();
    const sink = new RecordingSink();

    await new BrowserView(service, sessionId, sink).open();

    assert.deepEqual(sink.json(), [{ type: 'closed', message: BROWSER_CLOSED_MESSAGE }]);
    assert.equal(service.isRunning(sessionId), false);
    assert.equal(browser.chromiumExecs().filter((exec) => exec.containerId === `c-${sessionId}`).length, 0);
  });

  it('waits for a browser that is still starting', async () => {
    const sessionId = newSession();
    const starting = service.start(sessionId);
    const sink = new RecordingSink();

    await new BrowserView(service, sessionId, sink).open();
    await starting;

    assert.deepEqual(sink.json(), [{ type: 'url', url: 'http://host.docker.internal:3000/login' }]);
  });

  it('a view that leaves stops the screencast; one that is replaced does not', async () => {
    const { sessionId, view, sink, relay } = await openView();

    view.detach({ replaced: true });
    assert.deepEqual(sink.closedWith, { code: WS_CLOSE_VIEW_REPLACED, reason: 'replaced' });
    const next = new BrowserView(service, sessionId, new RecordingSink());
    await next.open();
    await tick();
    assert.equal(commandsOf(relay).filter((command) => command.method === 'Page.stopScreencast').length, 0);

    next.detach();
    await until(() => commandsOf(relay).some((command) => command.method === 'Page.stopScreencast'));
    assert.equal(service.isRunning(sessionId), true);
  });
});

describe('page view input parser', () => {
  const valid: Record<string, unknown>[] = [
    { type: 'mouse', action: 'move', x: 0, y: 0, button: 'none' },
    { type: 'mouse', action: 'down', x: 1279.5, y: 799, button: 'right', clickCount: 2, modifiers: 15 },
    { type: 'wheel', x: 1, y: 2, deltaX: -50, deltaY: 50 },
    { type: 'key', action: 'up', key: 'Shift', code: 'ShiftLeft', modifiers: 8 },
    { type: 'key', action: 'down', key: 'é', code: '', text: 'é', modifiers: 0 },
    { type: 'resize', width: 1280, height: 800 },
    { type: 'close' },
  ];

  const malformed: [string, string][] = [
    ['not JSON', 'mouse down'],
    ['an array', '[]'],
    ['an unknown type', '{"type":"navigate","url":"http://x"}'],
    ['no type', '{"x":1,"y":2}'],
    ['a mouse action that is not move/down/up', '{"type":"mouse","action":"click","x":1,"y":2,"button":"left"}'],
    ['a string coordinate', '{"type":"mouse","action":"down","x":"1","y":2,"button":"left"}'],
    ['a negative coordinate', '{"type":"mouse","action":"move","x":-1,"y":2,"button":"none"}'],
    ['a huge coordinate', '{"type":"mouse","action":"move","x":1e9,"y":2,"button":"none"}'],
    ['an unknown button', '{"type":"mouse","action":"down","x":1,"y":2,"button":"back"}'],
    ['a missing button', '{"type":"mouse","action":"down","x":1,"y":2}'],
    ['a fractional clickCount', '{"type":"mouse","action":"down","x":1,"y":2,"button":"left","clickCount":1.5}'],
    ['modifiers out of range', '{"type":"mouse","action":"down","x":1,"y":2,"button":"left","modifiers":16}'],
    ['a wheel without deltaY', '{"type":"wheel","x":1,"y":2,"deltaX":0}'],
    ['a key without key', '{"type":"key","action":"down","code":"KeyA","modifiers":0}'],
    ['an empty key', '{"type":"key","action":"down","key":"","code":"KeyA","modifiers":0}'],
    ['an over-long key', `{"type":"key","action":"down","key":"${'x'.repeat(33)}","code":"KeyA","modifiers":0}`],
    ['a pasted paragraph as key text', `{"type":"key","action":"down","key":"a","code":"KeyA","text":"${'x'.repeat(40)}","modifiers":0}`],
    ['an empty key text', '{"type":"key","action":"down","key":"a","code":"KeyA","text":"","modifiers":0}'],
    ['a key action that is not down/up', '{"type":"key","action":"press","key":"a","code":"KeyA","modifiers":0}'],
    ['a fractional resize', '{"type":"resize","width":1024.5,"height":700}'],
    ['a tiny resize', '{"type":"resize","width":10,"height":10}'],
    ['a giant resize', '{"type":"resize","width":100000,"height":700}'],
  ];

  for (const message of valid) {
    it(`accepts ${JSON.stringify(message)}`, () => {
      assert.notEqual(parseViewInput(JSON.stringify(message)), null);
    });
  }

  for (const [name, raw] of malformed) {
    it(`rejects ${name}`, () => {
      assert.equal(parseViewInput(raw), null);
    });
  }
});
