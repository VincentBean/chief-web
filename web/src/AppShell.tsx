import { type ReactNode, useEffect, useState } from 'react';

import {
  type ClaudeAccountStatus,
  type ClaudeUsage,
  type ClaudeUsageWindow,
  claudeAccountName,
  claudeNeedsSignIn,
  describeBuildSlots,
  logout,
} from './api.ts';
import { isActive, needsAttention, useAppData, useKeyChords } from './data.tsx';
import { Icon, type IconName } from './Icon.tsx';
import { Link, navigate, useLocation } from './router.tsx';
import { countdown, resetsAtShort, shortDuration } from './schedule.ts';
import { claudeUsageTone, Gauge, Kbd, Meter } from './ui.tsx';
import { CallPanel } from './voice/CallPanel.tsx';
import { useCall } from './voice/CallProvider.tsx';

/**
 * The frame around every authenticated page: a sidebar with the seven places
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
  { href: '/recurring-tasks', label: 'Recurring tasks', icon: 'clock', key: 'c', match: ['/recurring-tasks'] },
  { href: '/repositories', label: 'Repositories', icon: 'repo', key: 'r', match: ['/repositories'] },
  { href: '/sentry', label: 'Sentry', icon: 'alert', key: 'y', match: ['/sentry'] },
  { href: '/terminal', label: 'Terminals', icon: 'terminal', key: 't', match: ['/terminal'] },
  { href: '/settings', label: 'Settings', icon: 'gear', key: ',', match: ['/settings'] },
];

/** Past calls and their transcripts, listed under the Call entry. */
const CALLS_ITEM: NavItem = { href: '/calls', label: 'History', icon: 'history', key: '', match: ['/calls'] };

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
  const call = useCall();
  const inCall = call.status === 'connecting' || call.status === 'live' || call.status === 'reconnecting';
  const openCall = call.open;

  // The drawer closes on navigation, and the page scrolls back to the top the
  // way a full navigation would have.
  useEffect(() => {
    setOpen(false);
    window.scrollTo(0, 0);
  }, [pathname]);

  useKeyChords({
    ...Object.fromEntries(NAV.map((item) => [`g ${item.key}`, () => navigate(item.href)])),
    'g n': () => navigate('/sessions/new'),
    // A key press is a user gesture, so the call's audio may start from it.
    ...(call.enabled ? { 'g v': openCall } : {}),
  });

  const active = (sessions ?? []).filter(isActive).length;
  const attention = (sessions ?? []).filter(needsAttention).length;
  const hold = stats?.hold.until ?? null;
  const awaitingDecision = stats?.sentry.configured === true ? stats.sentry.awaitingDecision : 0;

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
    '/sentry': awaitingDecision > 0 && (
      <span className="nav__count nav__count--danger" title={`${String(awaitingDecision)} need your decision`}>
        {awaitingDecision}
      </span>
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
        {call.enabled && (
          <li>
            <button
              type="button"
              className={`nav__item nav__item--button${call.panelOpen ? ' nav__item--current' : ''}`}
              onClick={() => {
                setOpen(false);
                openCall();
              }}
              aria-pressed={call.panelOpen}
              title="g then v"
            >
              <Icon name="broadcast" />
              <span className="nav__label">Call</span>
              {inCall && (
                <span className="nav__count nav__count--danger" title={call.micOpen ? 'In a call, microphone open' : 'In a call'}>
                  live
                </span>
              )}
            </button>
            {/* Call history (voice US-024), nested under the call it belongs to. */}
            <Link
              className={`nav__item nav__item--sub${isCurrent(CALLS_ITEM, pathname) ? ' nav__item--current' : ''}`}
              href={CALLS_ITEM.href}
              aria-current={isCurrent(CALLS_ITEM, pathname) ? 'page' : undefined}
            >
              <Icon name="history" />
              <span className="nav__label">{CALLS_ITEM.label}</span>
            </Link>
          </li>
        )}
      </ul>
    </nav>
  );

  const status = (
    <div className="sidebar__status">
      {hold !== null && <HoldClock until={hold} />}
      <div
        className="status-row"
        title={stats === null ? 'Build slots in use' : describeBuildSlots(stats.builds)}
      >
        <Icon name="zap" />
        <span className="status-row__label">
          Slots
          {stats !== null && stats.builds.queued > 0 && (
            <span className="status-row__note">+{stats.builds.queued} queued</span>
          )}
        </span>
        <span className="status-row__value">
          {stats === null ? '…' : `${String(stats.builds.active)}/${String(stats.builds.max)}`}
        </span>
        {stats !== null && (
          <Meter value={stats.builds.active} max={stats.builds.max} label={describeBuildSlots(stats.builds)} />
        )}
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
      <ClaudeAccountRows stats={stats?.accounts ?? null} claude={claude?.accounts ?? null} />
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

      <CallPanel />
    </div>
  );
}

/** One sidebar row's worth of an account: who it is, and its live usage and hold. */
interface AccountRowData {
  readonly id: string;
  /** The account as `GET /api/claude` last described it; null while that is unknown. */
  readonly status: ClaudeAccountStatus | null;
  readonly usage: ClaudeUsage | null;
  readonly holdUntil: string | null;
}

/**
 * Every Claude account's 5h and 7d usage, one row each in position order
 * (multiple accounts US-008). The numbers ride the 5-second `/api/stats` poll;
 * names and sign-in state come from the Claude state the app already holds.
 */
function ClaudeAccountRows({
  stats,
  claude,
}: {
  readonly stats: readonly { id: string; usage: ClaudeUsage | null; holdUntil: string | null }[] | null;
  readonly claude: readonly ClaudeAccountStatus[] | null;
}) {
  const rows: readonly AccountRowData[] | null =
    stats !== null
      ? stats.map((entry) => ({ ...entry, status: claude?.find((account) => account.id === entry.id) ?? null }))
      : claude !== null
        ? claude.map((account) => ({ id: account.id, status: account, usage: null, holdUntil: null }))
        : null;

  if (rows === null) {
    return (
      <Link className="status-row status-row--link" href="/settings#claude" title="Claude Code accounts">
        <span className="dot dot--neutral" />
        <span className="status-row__label">Claude</span>
        <span className="status-row__value">checking…</span>
      </Link>
    );
  }
  if (rows.length === 0) {
    return (
      <Link className="status-row status-row--link status-row--danger" href="/settings#claude" title="Add a Claude account in Settings">
        <span className="dot dot--danger" />
        <span className="status-row__label status-row__value">Claude: no account</span>
      </Link>
    );
  }
  return rows.map((row) => <ClaudeAccountRow key={row.id} row={row} />);
}

/** "5h 42% (resets in 1h 12m)", or "5h –" when the window is unknown. */
function describeWindow(label: string, window: ClaudeUsageWindow | null, now: number): string {
  if (window === null) return `${label} –`;
  const percent = `${label} ${String(Math.round(window.utilization))}%`;
  return window.resetsAt === null ? percent : `${percent} (${resetsAtShort(window.resetsAt, now)})`;
}

function ClaudeAccountRow({ row }: { readonly row: AccountRowData }) {
  // A held account re-renders every second, counting down like `HoldClock`;
  // the rest follow the 5-second stats poll, so the clock is read at render.
  const [, tick] = useState(0);
  useEffect(() => {
    if (row.holdUntil === null) return undefined;
    const timer = window.setInterval(() => tick((count) => count + 1), 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [row.holdUntil]);
  const now = Date.now();

  const { status, usage } = row;
  const name = status === null ? `Account ${row.id.slice(0, 8)}` : claudeAccountName(status);
  const who = status?.nickname != null && status.email !== null ? `${status.nickname} (${status.email})` : name;
  const signedOut = status !== null && !status.authenticated;
  const signInAgain = claudeNeedsSignIn(usage);
  const holdMs = row.holdUntil === null ? 0 : new Date(row.holdUntil).getTime() - now;
  const held = !signedOut && !signInAgain && holdMs > 0;

  const dot = status === null ? 'dot--neutral' : signedOut || signInAgain ? 'dot--danger' : 'dot--done';
  const title = [
    who,
    ...(signedOut
      ? ['not signed in']
      : signInAgain
        ? ['login expired, sign in again']
        : [
            ...(held ? [`on hold, resumes in ${shortDuration(holdMs)}`] : []),
            describeWindow('5h', usage?.fiveHour ?? null, now),
            describeWindow('7d', usage?.sevenDay ?? null, now),
          ]),
  ].join(' · ');

  const bar = (label: string, window: ClaudeUsageWindow | null) => (
    <span className="status-row__window">
      <span className="status-row__window-label">{label}</span>
      {window === null ? (
        <span className="status-row__window-value">–</span>
      ) : (
        <>
          <Gauge
            value={window.utilization / 100}
            label={`${name} ${label} usage`}
            tone={claudeUsageTone(window.utilization)}
          />
          <span className="status-row__window-value">{`${String(Math.round(window.utilization))}%`}</span>
        </>
      )}
    </span>
  );

  return (
    <Link
      className={`status-row status-row--link status-row--account${signedOut || signInAgain ? ' status-row--danger' : held ? ' status-row--wait' : ''}`}
      href="/settings#claude"
      title={title}
    >
      <span className={`dot ${dot}`} />
      <span className="status-row__name">{name}</span>
      <span className="status-row__usage">
        {signedOut ? (
          <span className="status-row__value">not signed in</span>
        ) : signInAgain ? (
          <span className="status-row__value">sign in again</span>
        ) : held ? (
          <span className="status-row__window">
            <Icon name="hourglass" />
            <span className="status-row__value">{`on hold · ${shortDuration(holdMs)}`}</span>
          </span>
        ) : (
          <>
            {bar('5h', usage?.fiveHour ?? null)}
            {bar('7d', usage?.sevenDay ?? null)}
          </>
        )}
      </span>
    </Link>
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
