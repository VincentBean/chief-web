import type { RawData, WebSocket } from 'ws';

import type { Config } from '../config.js';
import {
  BROWSER_CLOSED_MESSAGE,
  type BrowserEvent,
  type BrowserService,
} from '../browser/index.js';
import { logger } from '../lib/logger.js';
import type { WebSocketRoute } from '../ws/gateway.js';
import { WS_CLOSE_BAD_ORIGIN, WS_CLOSE_TAKEN_OVER } from './protocol.js';
import { originAllowed } from './socket.js';

/**
 * The live page view (voice feedback US-008): the session's shared Chromium
 * tab in the call panel, where the operator watches and clicks along.
 *
 * Server → browser: every `Page.screencastFrame` as one **binary** message (the
 * JPEG itself), preceded by `{type:'viewport', width, height}` whenever the
 * page's CSS size changes (input coordinates are in that size), `{type:'url'}`
 * on each main-frame navigation, `{type:'closed', message}` once Chromium is
 * gone, and `{type:'error', code:'bad_message'}` for an input that did not parse.
 *
 * Browser → server: the {@link ViewInput} messages, each forwarded to the page
 * as one CDP `Input.*` / `Emulation.*` command, and `{type:'close'}`, the
 * **Close browser** button, which stops Chromium.
 *
 * Frames only pass through: none is kept, logged, or written anywhere.
 */

export const BROWSER_VIEW_WS_PATH = '/api/voice/browser/:sessionId';

/** A second view of the same session took this one's place. */
export const WS_CLOSE_VIEW_REPLACED = WS_CLOSE_TAKEN_OVER;
/** The browser is gone (or was never there); the reason says which. */
export const WS_CLOSE_BROWSER_CLOSED = 1000;

/** `Page.startScreencast`: the story's quality and size cap. */
export const SCREENCAST_PARAMS = {
  format: 'jpeg',
  quality: 60,
  maxWidth: 1280,
  maxHeight: 800,
  everyNthFrame: 1,
} as const;

/** Bounds of what an input message may carry. */
const MAX_COORDINATE = 10_000;
const MAX_WHEEL_DELTA = 10_000;
const MIN_VIEWPORT = { width: 200, height: 150 } as const;
const MAX_VIEWPORT = { width: 3840, height: 2160 } as const;
const MAX_KEY_CHARS = 32;
/** A key's text is one character, maybe a surrogate pair or a combining sequence. */
const MAX_KEY_TEXT_CHARS = 8;

export type MouseButton = 'none' | 'left' | 'middle' | 'right';
const MOUSE_BUTTONS: readonly MouseButton[] = ['none', 'left', 'middle', 'right'];

export type ViewInput =
  | {
      readonly type: 'mouse';
      readonly action: 'move' | 'down' | 'up';
      readonly x: number;
      readonly y: number;
      readonly button: MouseButton;
      /** Buttons held, as a bitmask (left 1, right 2, middle 4); drags need it on `move`. */
      readonly buttons: number;
      /** 2 for the second press of a double click. */
      readonly clickCount: number;
      readonly modifiers: number;
    }
  | { readonly type: 'wheel'; readonly x: number; readonly y: number; readonly deltaX: number; readonly deltaY: number }
  | {
      readonly type: 'key';
      readonly action: 'down' | 'up';
      readonly key: string;
      readonly code: string;
      /** What the key types; absent for keys that type nothing. */
      readonly text?: string;
      /** Alt 1, Ctrl 2, Meta 4, Shift 8 — CDP's bitmask. */
      readonly modifiers: number;
    }
  | { readonly type: 'resize'; readonly width: number; readonly height: number }
  | { readonly type: 'close' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function number(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function integer(value: unknown, min: number, max: number): number | null {
  const parsed = number(value, min, max);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

/** An optional field: absent → `fallback`, present but wrong → null. */
function optionalInteger(value: unknown, min: number, max: number, fallback: number): number | null {
  return value === undefined ? fallback : integer(value, min, max);
}

function text(value: unknown, max: number, allowEmpty = false): string | null {
  return typeof value === 'string' && value.length <= max && (allowEmpty || value !== '') ? value : null;
}

/**
 * One text message of the view socket, or null when it is not exactly one of
 * the {@link ViewInput} shapes: unknown type or action, a coordinate that is
 * not a finite number in range, an over-long key, a fractional size.
 */
export function parseViewInput(raw: string): ViewInput | null {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(message)) return null;

  switch (message['type']) {
    case 'mouse': {
      const action = message['action'];
      if (action !== 'move' && action !== 'down' && action !== 'up') return null;
      const x = number(message['x'], 0, MAX_COORDINATE);
      const y = number(message['y'], 0, MAX_COORDINATE);
      const button = MOUSE_BUTTONS.find((entry) => entry === message['button']);
      const buttons = optionalInteger(message['buttons'], 0, 7, 0);
      const clickCount = optionalInteger(message['clickCount'], 0, 3, action === 'move' ? 0 : 1);
      const modifiers = optionalInteger(message['modifiers'], 0, 15, 0);
      if (x === null || y === null || button === undefined || buttons === null || clickCount === null || modifiers === null) {
        return null;
      }
      return { type: 'mouse', action, x, y, button, buttons, clickCount, modifiers };
    }
    case 'wheel': {
      const x = number(message['x'], 0, MAX_COORDINATE);
      const y = number(message['y'], 0, MAX_COORDINATE);
      const deltaX = number(message['deltaX'], -MAX_WHEEL_DELTA, MAX_WHEEL_DELTA);
      const deltaY = number(message['deltaY'], -MAX_WHEEL_DELTA, MAX_WHEEL_DELTA);
      if (x === null || y === null || deltaX === null || deltaY === null) return null;
      return { type: 'wheel', x, y, deltaX, deltaY };
    }
    case 'key': {
      const action = message['action'];
      if (action !== 'down' && action !== 'up') return null;
      const key = text(message['key'], MAX_KEY_CHARS);
      const code = text(message['code'], MAX_KEY_CHARS, true);
      const modifiers = optionalInteger(message['modifiers'], 0, 15, 0);
      if (key === null || code === null || modifiers === null) return null;
      if (message['text'] === undefined) return { type: 'key', action, key, code, modifiers };
      const typed = text(message['text'], MAX_KEY_TEXT_CHARS);
      if (typed === null) return null;
      return { type: 'key', action, key, code, text: typed, modifiers };
    }
    case 'resize': {
      const width = integer(message['width'], MIN_VIEWPORT.width, MAX_VIEWPORT.width);
      const height = integer(message['height'], MIN_VIEWPORT.height, MAX_VIEWPORT.height);
      if (width === null || height === null) return null;
      return { type: 'resize', width, height };
    }
    case 'close':
      return { type: 'close' };
    default:
      return null;
  }
}

/** Windows virtual key codes: without one Chromium types letters but ignores Enter, Backspace, arrows… */
const NAMED_KEY_CODES: Readonly<Record<string, number>> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  NumpadEnter: 13,
  ShiftLeft: 16,
  ShiftRight: 16,
  ControlLeft: 17,
  ControlRight: 17,
  AltLeft: 18,
  AltRight: 18,
  Escape: 27,
  Space: 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  MetaLeft: 91,
  MetaRight: 92,
  Semicolon: 186,
  Equal: 187,
  Comma: 188,
  Minus: 189,
  Period: 190,
  Slash: 191,
  Backquote: 192,
  BracketLeft: 219,
  Backslash: 220,
  BracketRight: 221,
  Quote: 222,
};

export function windowsKeyCode(code: string): number | undefined {
  const named = NAMED_KEY_CODES[code];
  if (named !== undefined) return named;
  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  if (letter !== undefined) return letter.charCodeAt(0);
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit?.[1] !== undefined) return (code.startsWith('Numpad') ? 96 : 48) + Number(digit[1]);
  const fn = /^F([1-9]|1[0-2])$/.exec(code)?.[1];
  if (fn !== undefined) return 111 + Number(fn);
  return undefined;
}

/** The CDP command one input becomes; `null` for `close`, which is not CDP. */
export function inputCommand(input: ViewInput): { method: string; params: Record<string, unknown> } | null {
  switch (input.type) {
    case 'mouse':
      return {
        method: 'Input.dispatchMouseEvent',
        params: {
          type: input.action === 'move' ? 'mouseMoved' : input.action === 'down' ? 'mousePressed' : 'mouseReleased',
          x: input.x,
          y: input.y,
          button: input.button,
          buttons: input.buttons,
          clickCount: input.clickCount,
          modifiers: input.modifiers,
        },
      };
    case 'wheel':
      return {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mouseWheel', x: input.x, y: input.y, deltaX: input.deltaX, deltaY: input.deltaY },
      };
    case 'key': {
      const keyCode = windowsKeyCode(input.code);
      // Enter types a carriage return, as a real keyboard does; that is what submits a form.
      const typed = input.key === 'Enter' ? '\r' : input.text;
      const params: Record<string, unknown> = {
        type: input.action === 'up' ? 'keyUp' : typed === undefined ? 'rawKeyDown' : 'keyDown',
        key: input.key,
        code: input.code,
        modifiers: input.modifiers,
      };
      if (keyCode !== undefined) {
        params['windowsVirtualKeyCode'] = keyCode;
        params['nativeVirtualKeyCode'] = keyCode;
      }
      if (input.action === 'down' && typed !== undefined) {
        params['text'] = typed;
        params['unmodifiedText'] = typed;
      }
      return { method: 'Input.dispatchKeyEvent', params };
    }
    case 'resize':
      return {
        method: 'Emulation.setDeviceMetricsOverride',
        params: { width: input.width, height: input.height, deviceScaleFactor: 1, mobile: false },
      };
    case 'close':
      return null;
  }
}

/** The outgoing half of a view socket; `ws` in production, a recorder in tests. */
export interface ViewSink {
  send(data: string | Buffer, done: (error?: Error) => void): void;
  close(code: number, reason: string): void;
}

/** The slice of {@link BrowserService} a view uses. */
export type ViewBrowsers = Pick<BrowserService, 'whenRunning' | 'send' | 'subscribe' | 'stop'>;

/**
 * One operator's view of one session's browser. {@link open} attaches it;
 * {@link receive} takes each text message; {@link detach} is the socket gone.
 */
export class BrowserView {
  private dead = false;
  private unsubscribe: (() => void) | null = null;
  private viewport: { width: number; height: number } | null = null;
  private mainFrameId: string | null = null;

  constructor(
    private readonly browsers: ViewBrowsers,
    readonly sessionId: string,
    private readonly sink: ViewSink,
  ) {}

  get closed(): boolean {
    return this.dead;
  }

  /** Waits for a browser that is still starting; says `closed` when there is none. */
  async open(): Promise<void> {
    const running = await this.browsers.whenRunning(this.sessionId);
    if (this.dead) return;
    const unsubscribe = running === null ? null : this.browsers.subscribe(this.sessionId, (event) => this.onEvent(event));
    if (unsubscribe === null) {
      this.end(BROWSER_CLOSED_MESSAGE);
      return;
    }
    this.unsubscribe = unsubscribe;
    try {
      await this.command('Page.enable');
      const tree = await this.command('Page.getFrameTree');
      const frame = isRecord(tree) && isRecord(tree['frameTree']) ? tree['frameTree']['frame'] : undefined;
      if (isRecord(frame)) {
        if (typeof frame['id'] === 'string') this.mainFrameId = frame['id'];
        if (typeof frame['url'] === 'string') this.sendJson({ type: 'url', url: frame['url'] });
      }
      await this.command('Page.startScreencast', { ...SCREENCAST_PARAMS });
    } catch (cause) {
      // A browser that died meanwhile has already said `closed` through the subscription.
      logger.debug('page view could not start', { session: this.sessionId, error: String(cause) });
    }
  }

  receive(raw: string): void {
    if (this.dead) return;
    const input = parseViewInput(raw);
    if (input === null) {
      this.sendJson({ type: 'error', code: 'bad_message' });
      return;
    }
    if (input.type === 'close') {
      this.closeBrowser();
      return;
    }
    const command = inputCommand(input);
    if (command !== null) {
      this.command(command.method, command.params).catch((cause: unknown) => {
        logger.debug('page view input refused', { session: this.sessionId, method: command.method, error: String(cause) });
      });
    }
  }

  /**
   * The socket closed: stop listening, and unless another view took over, stop
   * the screencast and drop the size an expanded view set, which would
   * otherwise stay in force for the agent.
   */
  detach(options: { replaced?: boolean } = {}): void {
    if (this.dead) return;
    this.dead = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (options.replaced === true) {
      this.sink.close(WS_CLOSE_VIEW_REPLACED, 'replaced');
      return;
    }
    this.browsers.send(this.sessionId, 'Page.stopScreencast').catch(() => undefined);
    this.browsers.send(this.sessionId, 'Emulation.clearDeviceMetricsOverride').catch(() => undefined);
  }

  /** **Close browser**: from here on nothing more is sent, then Chromium is stopped. */
  private closeBrowser(): void {
    this.dead = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.sink.close(WS_CLOSE_BROWSER_CLOSED, 'closed');
    this.browsers.stop(this.sessionId).catch((cause: unknown) => {
      logger.warn('could not stop the session browser', { session: this.sessionId, error: String(cause) });
    });
  }

  private onEvent(event: BrowserEvent): void {
    if (this.dead) return;
    if (event.type === 'closed') {
      this.end(event.message);
      return;
    }
    const { method, params } = event;
    if (method === 'Page.screencastFrame') this.onFrame(params);
    else if (method === 'Page.frameNavigated') {
      const frame = params['frame'];
      if (!isRecord(frame) || frame['parentId'] !== undefined || typeof frame['url'] !== 'string') return;
      if (typeof frame['id'] === 'string') this.mainFrameId = frame['id'];
      this.sendJson({ type: 'url', url: frame['url'] });
    } else if (method === 'Page.navigatedWithinDocument') {
      // pushState and hash changes: the address changes without a navigation.
      if (params['frameId'] !== this.mainFrameId || typeof params['url'] !== 'string') return;
      this.sendJson({ type: 'url', url: params['url'] });
    }
  }

  private onFrame(params: Record<string, unknown>): void {
    const screencastSession = params['sessionId'];
    const ack = (): void => {
      // Chromium sends the next frame only once this one is acknowledged, so
      // acknowledging after the socket took it is the view's flow control.
      this.browsers.send(this.sessionId, 'Page.screencastFrameAck', { sessionId: screencastSession }).catch(() => undefined);
    };
    const metadata = isRecord(params['metadata']) ? params['metadata'] : {};
    const width = metadata['deviceWidth'];
    const height = metadata['deviceHeight'];
    if (
      typeof width === 'number' &&
      typeof height === 'number' &&
      (this.viewport?.width !== width || this.viewport.height !== height)
    ) {
      this.viewport = { width, height };
      this.sendJson({ type: 'viewport', width, height });
    }
    if (typeof params['data'] !== 'string') {
      ack();
      return;
    }
    this.sink.send(Buffer.from(params['data'], 'base64'), ack);
  }

  private end(message: string): void {
    if (this.dead) return;
    this.sendJson({ type: 'closed', message });
    this.dead = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.sink.close(WS_CLOSE_BROWSER_CLOSED, 'browser_closed');
  }

  private command(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.browsers.send(this.sessionId, method, params);
  }

  private sendJson(message: Record<string, unknown>): void {
    if (this.dead) return;
    this.sink.send(JSON.stringify(message), () => undefined);
  }
}

/**
 * `/api/voice/browser/:sessionId`, on the gateway's cookie check and, like the
 * call socket, `PUBLIC_URL`'s origin. One view per session: a new one replaces
 * the old, whose `Page.stopScreencast` would otherwise blind the new one.
 */
export function createBrowserViewRoute(browsers: ViewBrowsers, config: Pick<Config, 'publicUrl'>): WebSocketRoute {
  const views = new Map<string, BrowserView>();
  return {
    path: BROWSER_VIEW_WS_PATH,
    handle(socket: WebSocket, req, params) {
      if (!originAllowed(req, config.publicUrl)) {
        logger.warn('rejected page view socket from another origin', { origin: req.headers.origin });
        socket.close(WS_CLOSE_BAD_ORIGIN, 'bad_origin');
        return;
      }
      const sessionId = params['sessionId'] ?? '';
      const view = new BrowserView(browsers, sessionId, {
        send: (data, done) => {
          if (socket.readyState !== socket.OPEN) {
            done();
            return;
          }
          socket.send(data, done);
        },
        close: (code, reason) => socket.close(code, reason),
      });
      views.get(sessionId)?.detach({ replaced: true });
      views.set(sessionId, view);
      socket.on('message', (data, isBinary) => {
        if (isBinary) return;
        view.receive(rawText(data));
      });
      socket.on('close', () => {
        view.detach();
        if (views.get(sessionId) === view) views.delete(sessionId);
      });
      void view.open();
    },
  };
}

function rawText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}
