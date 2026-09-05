import { type AnchorHTMLAttributes, type MouseEvent, useSyncExternalStore } from 'react';

/**
 * A history-API router small enough to read in one sitting.
 *
 * The app has nine entry points and two parameterised routes. What it needs
 * from a router is exactly three things — the current path as React state, a
 * `navigate()` that does not reload the page, and an `<a>` that calls it — and
 * nothing a library adds on top (nested outlets, loaders, data APIs) would be
 * used. The server serves `index.html` for every non-`/api` path, so any URL
 * here survives a reload.
 */

interface Location {
  readonly pathname: string;
  readonly search: string;
}

const listeners = new Set<() => void>();
let current: Location = read();

function read(): Location {
  return { pathname: window.location.pathname, search: window.location.search };
}

function emit(): void {
  current = read();
  for (const listener of listeners) listener();
}

window.addEventListener('popstate', emit);

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (options.replace === true) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  emit();
}

/** Replaces the query string without adding a history entry. */
export function replaceSearch(params: URLSearchParams): void {
  const query = params.toString();
  navigate(`${window.location.pathname}${query === '' ? '' : `?${query}`}`, { replace: true });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLocation(): Location {
  return useSyncExternalStore(subscribe, () => current);
}

/**
 * Same-origin, unmodified left clicks become client-side navigations; anything
 * else (middle click, Ctrl/Cmd, `target="_blank"`, external hrefs) is left to
 * the browser so links keep every behaviour a link is expected to have.
 */
export function Link({
  href,
  onClick,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { readonly href: string }) {
  const handle = (event: MouseEvent<HTMLAnchorElement>): void => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (rest.target !== undefined && rest.target !== '_self') return;
    if (/^[a-z]+:/i.test(href)) return;
    event.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={handle} {...rest} />;
}

/** `/sessions/<id>` → the id, or null for any other path. */
export function sessionIdFromPath(pathname: string): string | null {
  const match = /^\/sessions\/([^/]+)\/?$/.exec(pathname);
  if (match === null || match[1] === 'new') return null;
  return decodeURIComponent(match[1] ?? '');
}

/**
 * `/recurring-tasks/<id>/edit` → the id, or null for any other path (US-008).
 *
 * The edit form is a page rather than a dialog for the same reason the new
 * session form is: the URL can be handed out, and a reload keeps you on it.
 */
export function editedRecurringTaskIdFromPath(pathname: string): string | null {
  const match = /^\/recurring-tasks\/([^/]+)\/edit\/?$/.exec(pathname);
  if (match === null) return null;
  return decodeURIComponent(match[1] ?? '');
}
