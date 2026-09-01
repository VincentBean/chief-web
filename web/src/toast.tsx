import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react';

import { Icon, type IconName } from './Icon.tsx';

/**
 * Transient confirmation of an action ("Build started", "Deleted add-login").
 *
 * The pages used to put every outcome in a notice paragraph at the top, which
 * meant scrolling up to find out whether the button you just pressed worked.
 * A toast appears where the eye already is and leaves on its own; anything
 * that has to stay readable — git's stderr, a parse error — is still rendered
 * inline by the page that owns it.
 */

export type ToastKind = 'ok' | 'error' | 'info' | 'warn';

interface Toast {
  readonly id: number;
  readonly kind: ToastKind;
  readonly text: string;
}

export interface Toaster {
  push(kind: ToastKind, text: string): void;
  ok(text: string): void;
  error(text: string): void;
  info(text: string): void;
  warn(text: string): void;
}

const Context = createContext<Toaster | null>(null);

const ICONS: Record<ToastKind, IconName> = {
  ok: 'check-circle',
  error: 'x-circle',
  info: 'info',
  warn: 'alert',
};

/** Errors stay longer: they are the ones that have to be read. */
const LIFETIME_MS: Record<ToastKind, number> = { ok: 5000, info: 6000, warn: 8000, error: 10000 };

export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number): void => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, text: string): void => {
      const id = next.current;
      next.current += 1;
      setToasts((current) => [...current.slice(-3), { id, kind, text }]);
      window.setTimeout(() => dismiss(id), LIFETIME_MS[kind]);
    },
    [dismiss],
  );

  const toaster = useMemo<Toaster>(
    () => ({
      push,
      ok: (text) => push('ok', text),
      error: (text) => push('error', text),
      info: (text) => push('info', text),
      warn: (text) => push('warn', text),
    }),
    [push],
  );

  return (
    <Context.Provider value={toaster}>
      {children}
      <div className="toasts" aria-live="polite" aria-relevant="additions">
        {toasts.map((toast) => (
          <div className={`toast toast--${toast.kind}`} key={toast.id} role={toast.kind === 'error' ? 'alert' : 'status'}>
            <Icon name={ICONS[toast.kind]} />
            <span className="toast__text">{toast.text}</span>
            <button
              type="button"
              className="toast__close"
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss"
            >
              <Icon name="x" />
            </button>
          </div>
        ))}
      </div>
    </Context.Provider>
  );
}

export function useToast(): Toaster {
  const value = useContext(Context);
  if (value === null) throw new Error('useToast() outside <ToastProvider>');
  return value;
}
