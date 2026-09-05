import { type ReactNode, useEffect, useState } from 'react';

import { logout } from './api.ts';
import { isActive, needsAttention, useAppData, useKeyChords } from './data.tsx';
import { Icon, type IconName } from './Icon.tsx';
import { Link, navigate, useLocation } from './router.tsx';
import { countdown } from './schedule.ts';
import { Gauge, Kbd, Meter } from './ui.tsx';

/**
 * The frame around every authenticated page: a sidebar with the six places
 * the app has, and the facts an operator wants at all times — whether Claude
 * Code is signed in, how many build slots are busy, and what that is costing
 * the machine in CPU and memory.
 *
 * The sidebar collapses to a top bar below `lg`, where a drawer takes its
 * place; the same list, the same shortcuts.
 */

interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: IconName;
  readonly key: string;
  /** Path prefixes that count as "here". */
  readonly match: readonly string[];
}

const NAV: readonly NavItem[] = [
  { href: '/', label: 'Overview', icon: 'home', key: 'o', match: ['/'] },
  { href: '/sessions', label: 'Sessions', icon: 'rocket', key: 's', match: ['/sessions'] },
  { href: '/pull-requests', label: 'Pull requests', icon: 'git-pull-request', key: 'p', match: ['/pull-requests'] },
  { href: '/repositories', label: 'Repositories', icon: 'repo', key: 'r', match: ['/repositories'] },
  { href: '/terminal', label: 'Terminals', icon: 'terminal', key: 't', match: ['/terminal'] },
  { href: '/settings', label: 'Settings', icon: 'gear', key: ',', match: ['/settings'] },
];

/** Bytes as gigabytes, one decimal below 10 GB and whole numbers above it. */
function gigabytes(bytes: number): string {
  const value = bytes / 1024 ** 3;
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
}

function isCurrent(item: NavItem, pathname: string): boolean {
  if (item.href === '/') return pathname === '/';
  return item.match.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function AppShell({ children }: { readonly children: ReactNode }) {
  const { pathname } = useLocation();
  const { sessions, stats, claude } = useAppData();
  const [open, setOpen] = useState(false);

  // The drawer closes on navigation, and the page scrolls back to the top the
  // way a full navigation would have.
  useEffect(() => {
    setOpen(false);
    window.scrollTo(0, 0);
  }, [pathname]);

  useKeyChords({
    ...Object.fromEntries(NAV.map((item) => [`g ${item.key}`, () => navigate(item.href)])),
    'g n': () => navigate('/sessions/new'),
  });

  const active = (sessions ?? []).filter(isActive).length;
  const attention = (sessions ?? []).filter(needsAttention).length;
  const hold = stats?.hold.until ?? null;

  const counts: Partial<Record<string, ReactNode>> = {
    '/sessions': (
      <>
        {attention > 0 && (
          <span className="nav__count nav__count--danger" title={`${String(attention)} need attention`}>
            {attention}
          </span>
        )}
        {active > 0 && (
          <span className="nav__count nav__count--active" title={`${String(active)} building or queued`}>
            {active}
          </span>
        )}
      </>
    ),
  };

  const nav = (
    <nav className="nav" aria-label="Main">
      <ul className="nav__list">
        {NAV.map((item) => (
          <li key={item.href}>
            <Link
              className={`nav__item${isCurrent(item, pathname) ? ' nav__item--current' : ''}`}
              href={item.href}
              aria-current={isCurrent(item, pathname) ? 'page' : undefined}
              title={`g then ${item.key}`}
            >
              <Icon name={item.icon} />
              <span className="nav__label">{item.label}</span>
              {counts[item.href]}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );

  const status = (
    <div className="sidebar__status">
      {hold !== null && <HoldClock until={hold} />}
      <div className="status-row" title="Build slots in use">
        <Icon name="zap" />
        <span className="status-row__label">Slots</span>
        <span className="status-row__value">
          {stats === null ? '…' : `${String(stats.builds.active)}/${String(stats.builds.max)}`}
        </span>
        {stats !== null && <Meter value={stats.builds.active} max={stats.builds.max} label="Build slots" />}
      </div>
      <div
        className="status-row"
        title={
          stats === null
            ? 'Host CPU'
            : `Host CPU across ${String(stats.host.cores)} core${stats.host.cores === 1 ? '' : 's'}`
        }
      >
        <Icon name="pulse" />
        <span className="status-row__label">CPU</span>
        <span className="status-row__value">
          {stats === null || stats.host.cpu === null ? '…' : `${String(Math.round(stats.host.cpu * 100))}%`}
        </span>
        {stats !== null && stats.host.cpu !== null && <Gauge value={stats.host.cpu} label="Host CPU" />}
      </div>
      <div className="status-row" title="Host memory in use">
        <Icon name="package" />
        <span className="status-row__label">RAM</span>
        <span className="status-row__value">
          {stats === null ? '…' : `${gigabytes(stats.host.memory.used)}/${gigabytes(stats.host.memory.total)} GB`}
        </span>
        {stats !== null && stats.host.memory.total > 0 && (
          <Gauge value={stats.host.memory.used / stats.host.memory.total} label="Host memory" />
        )}
      </div>
      <Link
        className={`status-row status-row--link ${claude === null ? '' : claude.status.authenticated ? 'status-row--ok' : 'status-row--danger'}`}
        href="/settings#claude"
        title={claude?.status.account ?? 'Claude Code sign-in'}
      >
        <span className={`dot ${claude === null ? 'dot--neutral' : claude.status.authenticated ? 'dot--done' : 'dot--danger'}`} />
        <span className="status-row__label">Claude</span>
        <span className="status-row__value">
          {claude === null ? 'checking…' : claude.status.authenticated ? 'signed in' : 'not signed in'}
        </span>
      </Link>
    </div>
  );

  return (
    <div className={`shell${open ? ' shell--drawer-open' : ''}`}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <header className="topbar">
        <button
          type="button"
          className="button button--icon button--quiet"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          aria-controls="sidebar"
          aria-label={open ? 'Close menu' : 'Open menu'}
        >
          <Icon name={open ? 'x' : 'menu'} />
        </button>
        <Link className="brand" href="/">
          <Mark />
          <span>chief</span>
        </Link>
      </header>

      <aside className="sidebar" id="sidebar">
        <Link className="brand sidebar__brand" href="/">
          <Mark />
          <span>chief</span>
        </Link>
        {nav}
        <div className="sidebar__spacer" />
        {status}
        <div className="sidebar__foot">
          <button
            type="button"
            className="nav__item nav__item--button"
            onClick={() => {
              logout().finally(() => window.location.replace('/login'));
            }}
          >
            <Icon name="sign-out" />
            <span className="nav__label">Log out</span>
          </button>
          <p className="sidebar__hint">
            <Kbd>g</Kbd> then a key jumps: <Kbd>o</Kbd> overview, <Kbd>s</Kbd> sessions,{' '}
            <Kbd>n</Kbd> new session.
          </p>
        </div>
      </aside>
      {open && <button type="button" className="scrim" aria-label="Close menu" onClick={() => setOpen(false)} />}

      <main className="content" id="main">
        {children}
      </main>
    </div>
  );
}

/** The usage-limit hold, counting down in the sidebar wherever the operator is. */
function HoldClock({ until }: { readonly until: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);
  return (
    <Link className="status-row status-row--link status-row--wait" href="/sessions?filter=attention" title="Claude’s usage limit was reached; builds resume when the hold lifts">
      <Icon name="clock" />
      <span className="status-row__label">On hold</span>
      <span className="status-row__value mono">{countdown(until, now)}</span>
    </Link>
  );
}

/** The wordmark's diamond: the favicon, at text size. */
export function Mark() {
  return (
    <svg className="mark" viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="var(--color-surface-sunken)" />
      <rect x="0.5" y="0.5" width="31" height="31" rx="6.5" fill="none" stroke="var(--color-line-default)" />
      <path d="M16 7.5 24.5 16 16 24.5 7.5 16Z" fill="var(--color-accent-fg)" />
      <path d="M16 12.5 19.5 16 16 19.5 12.5 16Z" fill="var(--color-surface-sunken)" />
    </svg>
  );
}
