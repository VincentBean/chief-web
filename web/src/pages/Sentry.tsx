import { useCallback, useEffect, useRef, useState } from 'react';

import {
  fetchSentryIssues,
  type SentryIssue,
  type SentryIssueList,
  type SentryIssueStatus,
  sentryIssueStatusLabel,
  sessionPath,
} from '../api.ts';
import { describeError, redirectIfUnauthorised } from '../data.tsx';
import { Icon } from '../Icon.tsx';
import { Link } from '../router.tsx';
import { since } from '../schedule.ts';
import { Badge, EmptyState, Notice, PageHeader, Panel, Skeleton } from '../ui.tsx';

/**
 * Every Sentry issue chief-web is tracking, and how far the auto-fixer got
 * with it (US-009).
 *
 * Three sections rather than one list: an operator comes here to ask "what is
 * it doing, and what has it given up on", and those are different questions
 * from "what has it already fixed". Within a section the newest error is the
 * one worth reading first, so each is ordered by when Sentry last saw it.
 *
 * Like the pull request list and unlike the session list, nothing here polls.
 * The pipeline behind it moves on a fifteen-minute tick, so a three-second
 * poll would ask fifty times for the same answer; the page loads once,
 * refreshes on demand, and revalidates when the tab comes back into view.
 */

const REVALIDATE_AFTER_MS = 120_000;

/** The three groups the page renders, and which pipeline states feed each. */
const SECTIONS: readonly {
  readonly key: string;
  readonly title: string;
  readonly icon: 'sync' | 'check-circle' | 'x-circle';
  readonly statuses: readonly SentryIssueStatus[];
  readonly empty: string;
}[] = [
  {
    key: 'working',
    title: 'Working',
    icon: 'sync',
    statuses: ['pending', 'queued', 'working'],
    empty: 'Nothing is in flight. New unresolved issues appear here on the next poll.',
  },
  {
    key: 'fixed',
    title: 'Fixed',
    icon: 'check-circle',
    statuses: ['fixed'],
    empty: 'No issue has been fixed yet. One lands here when its pull request is merged.',
  },
  {
    key: 'cannot_fix',
    title: 'Cannot fix',
    icon: 'x-circle',
    statuses: ['cannot_fix'],
    empty: 'Nothing has been given up on.',
  },
];

/** Newest activity first, the order Sentry itself lists issues in. */
function byLastSeen(a: SentryIssue, b: SentryIssue): number {
  return b.lastSeen.localeCompare(a.lastSeen);
}

export function Sentry() {
  const [list, setList] = useState<SentryIssueList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const loadedAt = useRef(0);

  const load = useCallback((options: { refresh?: boolean } = {}): void => {
    if (options.refresh === true) setRefreshing(true);
    fetchSentryIssues()
      .then((value) => {
        setList(value);
        setLoadError(null);
        loadedAt.current = Date.now();
      })
      .catch((error: unknown) => {
        if (redirectIfUnauthorised(error)) return;
        setLoadError(describeError(error));
      })
      .finally(() => setRefreshing(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - loadedAt.current < REVALIDATE_AFTER_MS) return;
      load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const issues = list?.issues ?? [];

  return (
    <div className="page">
      <PageHeader
        title="Sentry"
        subtitle={
          list === null
            ? 'Reading tracked issues…'
            : `${String(issues.length)} tracked ${issues.length === 1 ? 'issue' : 'issues'} · read ${since(list.generatedAt)}`
        }
        actions={
          <button type="button" className="button" onClick={() => load({ refresh: true })} disabled={refreshing}>
            <Icon name="sync" />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        }
      />

      {loadError !== null && <Notice kind="error">Could not load Sentry issues: {loadError}</Notice>}

      {list !== null && !list.tokenConfigured && (
        <Notice kind="warn">
          No Sentry auth token is configured, so nothing is being polled. Add one under{' '}
          <Link className="link" href="/settings#sentry">
            Settings → Sentry
          </Link>
          , then link a repository to a Sentry project.
        </Notice>
      )}

      {list === null && loadError === null && (
        <div className="panel">
          <div className="panel__body">
            <Skeleton lines={4} />
          </div>
        </div>
      )}

      {list !== null && issues.length === 0 && (
        <EmptyState
          icon="alert"
          title="No issues tracked yet"
          action={
            <Link className="button" href="/repositories">
              Link a repository
            </Link>
          }
        >
          Unresolved issues on the Sentry projects linked to your repositories appear here, each one classified as working, fixed
          or impossible to fix from the code.
        </EmptyState>
      )}

      {list !== null &&
        issues.length > 0 &&
        SECTIONS.map((section) => {
          const rows = issues.filter((issue) => section.statuses.includes(issue.status)).sort(byLastSeen);
          return (
            <Panel
              key={section.key}
              title={section.title}
              icon={section.icon}
              meta={<span className="panel__meta muted">{String(rows.length)}</span>}
            >
              {rows.length === 0 && <p className="muted">{section.empty}</p>}
              {rows.length > 0 && (
                <ul className="rows rows--divided">
                  {rows.map((issue) => (
                    <IssueRow key={issue.id} issue={issue} showState={section.key === 'working'} />
                  ))}
                </ul>
              )}
            </Panel>
          );
        })}
    </div>
  );
}

function IssueRow({ issue, showState }: { readonly issue: SentryIssue; readonly showState: boolean }) {
  return (
    <li className="row row--stacked">
      <div className="row__line">
        <Icon name="alert" className={issue.status === 'fixed' ? 'text-done' : 'text-muted'} />
        <div className="row__main">
          <span className="row__title">
            <a className="link link--strong" href={issue.permalink} target="_blank" rel="noreferrer">
              {issue.title}
              <Icon name="link-external" />
            </a>
            {/* Only the Working section needs the internal state spelled out:
                in the other two the section heading already says it. */}
            {showState && (
              <Badge tone={issue.status === 'working' ? 'active' : 'wait'} pulse={issue.status === 'working'}>
                {sentryIssueStatusLabel(issue.status)}
              </Badge>
            )}
            {issue.status === 'fixed' && issue.resolvedInSentry && <Badge tone="done">resolved in Sentry</Badge>}
            {issue.level !== null && <Badge>{issue.level}</Badge>}
          </span>
          <span className="row__meta">
            <span className="mono">{issue.shortId}</span>
            {` · ${issue.repositoryName}`}
            {issue.culprit !== null && (
              <>
                {' · '}
                <span className="mono">{issue.culprit}</span>
              </>
            )}
            {` · ${String(issue.eventCount)} ${issue.eventCount === 1 ? 'event' : 'events'}`}
            {` · last seen ${since(issue.lastSeen)}`}
            {` · first seen ${since(issue.firstSeen)}`}
            {issue.sessionId !== null && (
              <>
                {' · '}
                <Link className="link" href={sessionPath(issue.sessionId)}>
                  {issue.sessionName ?? 'session'}
                </Link>
              </>
            )}
          </span>
          {/* Why it was given up on is the whole point of the section, so it is
              read without a click. */}
          {issue.explanation !== null && issue.status === 'cannot_fix' && (
            <p className="row__meta">{issue.explanation}</p>
          )}
        </div>
      </div>
    </li>
  );
}
