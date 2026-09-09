import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import {
  approveSentryPlan,
  fetchSentryIssues,
  MAX_SENTRY_PLAN_CHARS,
  rejectSentryPlan,
  type SentryIssue,
  type SentryIssueList,
  type SentryIssueStatus,
  sentryIssueStatusLabel,
  sessionPath,
} from '../api.ts';
import { ConfirmDialog } from '../ConfirmDialog.tsx';
import { describeError, redirectIfUnauthorised } from '../data.tsx';
import { Icon } from '../Icon.tsx';
import { Link } from '../router.tsx';
import { since } from '../schedule.ts';
import { useToast } from '../toast.tsx';
import { Badge, EmptyState, Notice, PageHeader, Panel, Skeleton } from '../ui.tsx';

/**
 * Every Sentry issue chief-web is tracking, how far the pipeline got with it
 * (US-009), and — since nothing is fixed without a decision — the plan
 * proposed for it and the two buttons that settle it (US-008).
 *
 * Five sections rather than one list, because an operator arrives with one of
 * five questions: what is waiting on me, what have I said yes to, what is
 * running, what is done, what has been given up on. The first is the one that
 * costs them time, so it is at the top and carries the whole plan as text: a
 * decision that needs a click to read is a decision that gets postponed.
 *
 * Like the pull request list and unlike the session list, nothing here polls —
 * not even after a decision. The pipeline behind it moves on a fifteen-minute
 * tick, so a three-second poll would ask fifty times for the same answer; the
 * page loads once, refreshes on demand, revalidates when the tab comes back
 * into view, and patches in the one row the server just answered with.
 */

const REVALIDATE_AFTER_MS = 120_000;

/** The five groups the page renders, and which pipeline states feed each. */
const SECTIONS: readonly {
  readonly key: string;
  readonly title: string;
  readonly icon: 'tasklist' | 'check' | 'sync' | 'check-circle' | 'x-circle';
  readonly statuses: readonly SentryIssueStatus[];
  readonly empty: string;
}[] = [
  {
    key: 'planned',
    title: 'Needs your decision',
    icon: 'tasklist',
    statuses: ['planned'],
    empty: 'No plan is waiting on you. One lands here as soon as an issue is triaged as fixable.',
  },
  {
    key: 'approved',
    title: 'Approved',
    icon: 'check',
    statuses: ['approved'],
    empty: 'Nothing is approved and waiting. An approved plan sits here until its session is started.',
  },
  {
    key: 'working',
    title: 'Working',
    icon: 'sync',
    statuses: ['pending', 'working'],
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
    empty: 'Nothing has been given up on, and no plan has been rejected.',
  },
];

/** Newest activity first, the order Sentry itself lists issues in. */
function byLastSeen(a: SentryIssue, b: SentryIssue): number {
  return b.lastSeen.localeCompare(a.lastSeen);
}

export function Sentry() {
  const toast = useToast();
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

  /**
   * A decided issue comes back from the server whole, so the row moves to its
   * new section without a reload — the page still asks Sentry for nothing.
   */
  const replace = useCallback((issue: SentryIssue): void => {
    setList((current) =>
      current === null
        ? current
        : { ...current, issues: current.issues.map((row) => (row.id === issue.id ? issue : row)) },
    );
  }, []);

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
          Unresolved issues on the Sentry projects linked to your repositories appear here, each one triaged into a proposed fix
          plan for you to approve, or an explanation of why it cannot be fixed from the code.
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
                  {rows.map((issue) =>
                    section.key === 'planned' ? (
                      <PlannedRow
                        key={issue.id}
                        issue={issue}
                        onDecided={(decided, message) => {
                          replace(decided);
                          toast.ok(message);
                        }}
                      />
                    ) : (
                      <IssueRow key={issue.id} issue={issue} showState={section.key === 'working'} />
                    ),
                  )}
                </ul>
              )}
            </Panel>
          );
        })}
    </div>
  );
}

/**
 * A proposed plan, with the two decisions on it (US-008).
 *
 * The state is the row's own: two rows being edited at once is normal — a plan
 * is read, half-rewritten, left alone while the next one is read — and a
 * failure belongs beside the button that caused it rather than at the top of
 * the page. Nothing is optimistic: the row only moves when the server has said
 * it moved, so a refused decision leaves the plan, the edit and the buttons
 * exactly as they were.
 */
function PlannedRow({
  issue,
  onDecided,
}: {
  readonly issue: SentryIssue;
  readonly onDecided: (issue: SentryIssue, message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(issue.plan ?? '');
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const edited = draft.trim();
  const tooLong = edited.length > MAX_SENTRY_PLAN_CHARS;
  const emptyEdit = editing && edited === '';

  const settle = (work: Promise<SentryIssue>, kind: 'approve' | 'reject', message: string): void => {
    setBusy(kind);
    setError(null);
    work
      .then((decided) => {
        setRejecting(false);
        onDecided(decided, message);
      })
      .catch((cause: unknown) => {
        if (redirectIfUnauthorised(cause)) return;
        // The row keeps its plan, its edit and its buttons; only the reason
        // dialog closes, so the error is not hidden behind it.
        setRejecting(false);
        setError(describeError(cause));
      })
      .finally(() => setBusy(null));
  };

  const approve = (): void => {
    if (emptyEdit || tooLong) return;
    // An untouched plan is approved as it stands; sending it back unchanged
    // would only risk a normalisation the operator never asked for.
    const plan = editing && edited !== (issue.plan ?? '') ? edited : undefined;
    settle(approveSentryPlan(issue.id, plan), 'approve', `Approved the plan for ${issue.shortId}.`);
  };

  const reject = (): void => {
    const text = reason.trim();
    if (text === '') return;
    settle(rejectSentryPlan(issue.id, text), 'reject', `Rejected the plan for ${issue.shortId}.`);
  };

  return (
    <IssueRow issue={issue} showState={false}>
      {editing ? (
        <div className="field">
          <textarea
            className="field__input field__textarea"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={10}
            spellCheck={false}
            aria-label={`Fix plan for ${issue.shortId}`}
          />
          <p className="field__hint">
            {tooLong
              ? `A plan can be at most ${MAX_SENTRY_PLAN_CHARS.toLocaleString()} characters; this one is ${edited.length.toLocaleString()}.`
              : emptyEdit
                ? 'A plan cannot be empty. Reject the issue instead of emptying its plan.'
                : 'Approving sends this text, and the fix session is given exactly what you leave here.'}
          </p>
        </div>
      ) : issue.plan === null ? (
        <p className="row__meta">No plan was stored with this proposal.</p>
      ) : (
        <pre className="output output--wrap">{issue.plan}</pre>
      )}

      {error !== null && (
        <p className="row__meta text-danger" role="alert">
          {error}
        </p>
      )}

      <div className="row__actions">
        <button
          type="button"
          className="button button--quiet"
          onClick={() => {
            setDraft(issue.plan ?? '');
            setEditing(!editing);
          }}
          disabled={busy !== null}
        >
          <Icon name="pencil" />
          {editing ? 'Discard edit' : 'Edit plan'}
        </button>
        <button
          type="button"
          className="button button--danger"
          onClick={() => {
            setReason('');
            setRejecting(true);
          }}
          disabled={busy !== null}
        >
          <Icon name="x" />
          Reject
        </button>
        <button
          type="button"
          className="button button--primary"
          onClick={approve}
          disabled={busy !== null || emptyEdit || tooLong}
        >
          <Icon name="check" />
          {busy === 'approve' ? 'Approving…' : 'Approve'}
        </button>
      </div>

      <ConfirmDialog
        open={rejecting}
        title={`Reject the plan for ${issue.shortId}?`}
        confirmLabel="Reject plan"
        busyLabel="Rejecting…"
        busy={busy === 'reject'}
        confirmDisabled={reason.trim() === '' || reason.trim().length > MAX_SENTRY_PLAN_CHARS}
        danger
        onConfirm={reject}
        onCancel={() => setRejecting(false)}
      >
        <p>
          The issue moves to <strong>Cannot fix</strong> with your reason on it, and chief-web also resolves it in Sentry so the
          poller does not bring it back and propose the same plan again.
        </p>
        <div className="field">
          <label className="field__label" htmlFor={`reject-reason-${issue.id}`}>
            Why this plan is wrong
          </label>
          <textarea
            id={`reject-reason-${issue.id}`}
            className="field__input field__textarea"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={4}
            placeholder="The stack trace is in a vendored file we do not own."
          />
          <p className="field__hint">
            {reason.trim() === '' ? 'A reason is required — it is all that is left on the issue afterwards.' : 'Kept as the issue’s explanation.'}
          </p>
        </div>
      </ConfirmDialog>
    </IssueRow>
  );
}

function IssueRow({
  issue,
  showState,
  children,
}: {
  readonly issue: SentryIssue;
  readonly showState: boolean;
  /** The plan, the decision buttons and their errors, under the meta line. */
  readonly children?: ReactNode;
}) {
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
                in the other sections the heading already says it. */}
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
          {/* Why it was given up on — or why its plan was rejected — is the
              whole point of the section, so it is read without a click. */}
          {issue.explanation !== null && issue.status === 'cannot_fix' && (
            <p className="row__meta">{issue.explanation}</p>
          )}
        </div>
      </div>
      {children}
    </li>
  );
}
