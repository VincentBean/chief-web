import { type KeyboardEvent, type MouseEvent, useCallback, useEffect, useRef, useState } from 'react';

import { Icon } from '../Icon.tsx';

/**
 * The live page view (voice feedback US-008): the session's shared Chromium
 * tab, drawn from the server's screencast on `/api/voice/browser/:sessionId`.
 * The operator clicks, scrolls and types into it; the session agent drives the
 * same tab, so a navigation by either shows up in the next frame.
 *
 * Frames are drawn and dropped: none is kept in state or stored anywhere.
 * Keyboard focus is taken only while the pointer is over the canvas, or after a
 * click in it until focus moves elsewhere, and the canvas carries
 * `data-captures-keys` so Space-to-talk and the `g` shortcuts leave it alone.
 */

/** Mirrors the server's `BROWSER_VIEW_WS_PATH` (server/src/voice/browser-view.ts). */
function viewSocketUrl(sessionId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/api/voice/browser/${encodeURIComponent(sessionId)}`;
}

/** Chromium's window size (`--window-size`), which the view goes back to when collapsed. */
const DEFAULT_PAGE = { width: 1280, height: 800 } as const;
/** Mirrors the server's resize bounds. */
const MIN_PAGE = { width: 200, height: 150 } as const;
const MAX_PAGE = { width: 3840, height: 2160 } as const;
const CLOSED_MESSAGE = 'Browser closed';

type PageViewInput =
  | {
      readonly type: 'mouse';
      readonly action: 'move' | 'down' | 'up';
      readonly x: number;
      readonly y: number;
      readonly button: 'none' | 'left' | 'middle' | 'right';
      readonly buttons: number;
      readonly clickCount?: number;
      readonly modifiers: number;
    }
  | { readonly type: 'wheel'; readonly x: number; readonly y: number; readonly deltaX: number; readonly deltaY: number }
  | {
      readonly type: 'key';
      readonly action: 'down' | 'up';
      readonly key: string;
      readonly code: string;
      readonly text?: string;
      readonly modifiers: number;
    }
  | { readonly type: 'resize'; readonly width: number; readonly height: number }
  | { readonly type: 'close' };

type ViewState = { readonly kind: 'connecting' } | { readonly kind: 'live' } | { readonly kind: 'closed'; readonly message: string };

const MOUSE_BUTTONS = ['left', 'middle', 'right'] as const;

/** CDP's modifier bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8. */
function modifiersOf(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function PageView({ sessionId, onClose }: { readonly sessionId: string; readonly onClose: () => void }) {
  const [state, setState] = useState<ViewState>({ kind: 'connecting' });
  const [url, setUrl] = useState('');
  const [expanded, setExpanded] = useState(false);
  const socket = useRef<WebSocket | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  /** The page's CSS size, which input coordinates are in. */
  const page = useRef<{ width: number; height: number }>({ ...DEFAULT_PAGE });
  const pinned = useRef(false);
  const focusBefore = useRef<HTMLElement | null>(null);
  const pendingMove = useRef<{ x: number; y: number; buttons: number; modifiers: number } | null>(null);
  const moveFrame = useRef(0);

  const post = useCallback((input: PageViewInput): void => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(input));
  }, []);

  useEffect(() => {
    const ws = new WebSocket(viewSocketUrl(sessionId));
    ws.binaryType = 'blob';
    socket.current = ws;
    let closedMessage: string | null = null;
    let drawing = false;
    /** The newest frame that came in while one was decoding; never dropped, or the last change could go unseen. */
    let pending: Blob | null = null;

    const draw = (frame: Blob): void => {
      drawing = true;
      void createImageBitmap(frame)
        .then((bitmap) => {
          const target = canvas.current;
          const context = target?.getContext('2d');
          if (target && context) {
            if (target.width !== bitmap.width) target.width = bitmap.width;
            if (target.height !== bitmap.height) target.height = bitmap.height;
            context.drawImage(bitmap, 0, 0);
          }
          bitmap.close();
        })
        .catch(() => undefined)
        .finally(() => {
          drawing = false;
          const next = pending;
          pending = null;
          if (next !== null) draw(next);
        });
    };

    ws.onopen = () => setState({ kind: 'live' });
    ws.onmessage = (event: MessageEvent<Blob | string>) => {
      if (typeof event.data !== 'string') {
        // A frame landing while another decodes waits; only the newest is kept.
        if (drawing) pending = event.data;
        else draw(event.data);
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof message !== 'object' || message === null) return;
      const fields = message as Record<string, unknown>;
      if (fields['type'] === 'viewport' && typeof fields['width'] === 'number' && typeof fields['height'] === 'number') {
        page.current = { width: fields['width'], height: fields['height'] };
      } else if (fields['type'] === 'url' && typeof fields['url'] === 'string') {
        setUrl(fields['url']);
      } else if (fields['type'] === 'closed') {
        closedMessage = typeof fields['message'] === 'string' ? fields['message'] : CLOSED_MESSAGE;
      }
    };
    ws.onclose = (event) => {
      if (socket.current === ws) socket.current = null;
      setState({
        kind: 'closed',
        message: closedMessage ?? (event.reason === 'replaced' ? 'The page view moved to another tab.' : CLOSED_MESSAGE),
      });
    };
    return () => {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      pending = null;
      ws.close();
      if (socket.current === ws) socket.current = null;
      window.cancelAnimationFrame(moveFrame.current);
    };
  }, [sessionId]);

  // Expanded, the page takes the size of the area it fills; collapsed, it goes back to the window size.
  useEffect(() => {
    if (state.kind !== 'live') return;
    if (!expanded) {
      post({ type: 'resize', ...DEFAULT_PAGE });
      return;
    }
    const area = body.current;
    if (area === null) return;
    let timer = 0;
    const resize = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        post({
          type: 'resize',
          width: clamp(area.clientWidth, MIN_PAGE.width, MAX_PAGE.width),
          height: clamp(area.clientHeight, MIN_PAGE.height, MAX_PAGE.height),
        });
      }, 150);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(area);
    resize();
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [expanded, state.kind, post]);

  /** Canvas pixels to page CSS pixels. */
  const pagePoint = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const target = canvas.current;
    if (target === null) return null;
    const rect = target.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = ((clientX - rect.left) / rect.width) * page.current.width;
    const y = ((clientY - rect.top) / rect.height) * page.current.height;
    return {
      x: Math.min(page.current.width, Math.max(0, Math.round(x * 10) / 10)),
      y: Math.min(page.current.height, Math.max(0, Math.round(y * 10) / 10)),
    };
  }, []);

  // React's wheel listener is passive; the page's own scrolling must not happen too.
  useEffect(() => {
    const target = canvas.current;
    if (target === null || state.kind !== 'live') return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const point = pagePoint(event.clientX, event.clientY);
      if (point === null) return;
      const scale = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? page.current.height : 1;
      post({
        type: 'wheel',
        ...point,
        deltaX: clamp(event.deltaX * scale, -10_000, 10_000),
        deltaY: clamp(event.deltaY * scale, -10_000, 10_000),
      });
    };
    target.addEventListener('wheel', onWheel, { passive: false });
    return () => target.removeEventListener('wheel', onWheel);
  }, [state.kind, pagePoint, post]);

  const mouse = (action: 'down' | 'up', event: MouseEvent<HTMLCanvasElement>): void => {
    const point = pagePoint(event.clientX, event.clientY);
    const button = MOUSE_BUTTONS[event.button];
    if (point === null || button === undefined) return;
    post({
      type: 'mouse',
      action,
      ...point,
      button,
      buttons: event.buttons & 7,
      clickCount: clamp(event.detail, 1, 3),
      modifiers: modifiersOf(event),
    });
  };

  const move = (event: MouseEvent<HTMLCanvasElement>): void => {
    const point = pagePoint(event.clientX, event.clientY);
    if (point === null) return;
    // One move per animation frame is plenty, and keeps the relay's queue short.
    const first = pendingMove.current === null;
    pendingMove.current = { ...point, buttons: event.buttons & 7, modifiers: modifiersOf(event) };
    if (!first) return;
    moveFrame.current = window.requestAnimationFrame(() => {
      const latest = pendingMove.current;
      pendingMove.current = null;
      if (latest === null) return;
      const { buttons } = latest;
      const held = buttons & 1 ? 'left' : buttons & 2 ? 'right' : buttons & 4 ? 'middle' : 'none';
      post({ type: 'mouse', action: 'move', x: latest.x, y: latest.y, button: held, buttons, modifiers: latest.modifiers });
    });
  };

  const key = (action: 'down' | 'up', event: KeyboardEvent<HTMLCanvasElement>): void => {
    // Everything typed here belongs to the page: no push-to-talk, no shortcuts,
    // no Tab leaving the canvas, no Backspace going back in history.
    event.preventDefault();
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    const types = event.key.length === 1 && !event.ctrlKey && !event.metaKey;
    post({
      type: 'key',
      action,
      key: event.key.slice(0, 32),
      code: event.code.slice(0, 32),
      ...(types ? { text: event.key } : {}),
      modifiers: modifiersOf(event),
    });
  };

  // Focus follows the pointer unless a click pinned it; leaving gives it back.
  const enter = (): void => {
    const target = canvas.current;
    if (target === null || document.activeElement === target) return;
    focusBefore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    target.focus({ preventScroll: true });
  };
  const leave = (): void => {
    if (pinned.current || document.activeElement !== canvas.current) return;
    const previous = focusBefore.current;
    focusBefore.current = null;
    // Blur first: giving focus back to <body> is a no-op and would leave the canvas holding every key.
    canvas.current?.blur();
    if (previous !== null && previous !== document.body && previous.isConnected) previous.focus({ preventScroll: true });
  };

  const close = (): void => {
    post({ type: 'close' });
    socket.current?.close();
    onClose();
  };

  const closed = state.kind === 'closed';
  return (
    <div className={`call-page${expanded ? ' call-page--expanded' : ''}`} aria-label="Live page view">
      <div className="call-page__bar">
        <Icon name="link-external" />
        <span className="call-page__url mono" title={url}>
          {closed ? state.message : url === '' ? 'Opening…' : url}
        </span>
        {!closed && (
          <button
            type="button"
            className="button button--quiet"
            aria-pressed={expanded}
            title={expanded ? 'Back into the call panel' : 'Fill the main area; the transcript stays beside it'}
            onClick={() => setExpanded(!expanded)}
          >
            Expand
          </button>
        )}
        <button type="button" className="button call-page__close" onClick={closed ? onClose : close}>
          {closed ? 'Dismiss' : 'Close browser'}
        </button>
      </div>
      <div className="call-page__body" ref={body}>
        {closed ? (
          <p className="call-page__closed" role="status">
            {state.message}
          </p>
        ) : (
          <canvas
            ref={canvas}
            className="call-page__canvas"
            width={DEFAULT_PAGE.width}
            height={DEFAULT_PAGE.height}
            tabIndex={0}
            data-captures-keys=""
            aria-label="The session's browser. Click to interact; keys go to the page while the pointer is over it."
            onMouseEnter={enter}
            onMouseLeave={leave}
            onMouseDown={(event) => {
              event.preventDefault();
              pinned.current = true;
              canvas.current?.focus({ preventScroll: true });
              mouse('down', event);
            }}
            onMouseUp={(event) => mouse('up', event)}
            onMouseMove={move}
            onContextMenu={(event) => event.preventDefault()}
            onKeyDown={(event) => key('down', event)}
            onKeyUp={(event) => key('up', event)}
            onBlur={() => {
              pinned.current = false;
            }}
          />
        )}
      </div>
    </div>
  );
}
