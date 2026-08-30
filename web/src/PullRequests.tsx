import { useCallback, useEffect, useRef, useState } from 'react';

import {
  ApiError,
  fetchPrRun,
  fetchPullRequestFeedback,
  fetchPullRequests,
  logout,
  type PrRun,
  prFailureStageLabel,
  prPhaseLabel,
  type PullRequest,
  type PullRequestFeedback,
  type PullRequestList,
  pullRequestKey,
  type RepositoryPullRequests,
  type ReviewThread,
  sessionPath,
  startPrRun,
  stopPrRun,
} from './api.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { type BodyPart, parseCommentBody, splitPath } from './comment.ts';
import { Icon } from './Icon.tsx';
import { since } from './schedule.ts';

/**
 * Every open pull request on the configured repositories, and the review
 * feedback each carries (US-021).
 *
 * Unlike the dashboard, nothing here polls. The list is one GitHub request per
 * repository against a rate-limited budget, so it is loaded once, refreshed on
 * demand, and revalidated only when the tab becomes visible again after a
 * while. A hidden tab costs nothing.
 */

/** How long a background tab may go stale before returning to it refetches. */
const REVALIDATE_AFTER_MS = 120_000;

/**
 * How often a *live* run is re-read. Only while one is running, and only that
 * one run — this is a local endpoint, not GitHub, so it costs nothing.
 */
const RUN_POLL_MS = 2000;

/**
 * How often the list re-asks GitHub while the tab is watched.
 *
 * This is what makes a pull request closed or merged elsewhere disappear on its
 * own — the list only ever asks for open ones. Five minutes is deliberately
 * slow: it is one request per repository, so a handful of repositories costs a
 * few dozen of the 5000 an hour GitHub allows, where the dashboard's
 * three-second cadence would cost twelve hundred per repository.
 */
const LIST_REVALIDATE_MS = 300_000;

const describe = (error: unknown): string =>
  error instanceof ApiError ? error.message : String(error);

interface FeedbackState {
  readonly loading: boolean;
  readonly value: PullRequestFeedback | null;
  readonly error: string | null;
}

export function PullRequests() {
  const [list, setList] = useState<PullRequestList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /** Only one row is open at a time: expanding costs a GitHub call. */
  const [expanded, setExpanded] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, FeedbackState>>({});
  /** Run state per pull request, seeded from the list and then polled. */
  const [runs, setRuns] = useState<Record<string, PrRun>>({});
  const [confirming, setConfirming] = useState<{ group: RepositoryPullRequests; pull: PullRequest; count: number } | null>(null);
  const [starting, setStarting] = useState(false);
  const [notices, setNotices] = useState<Record<string, string>>({});
  /** Which row is fetching its comments in order to open the confirmation. */
  const [preparing, setPreparing] = useState<string | null>(null);
  const loadedAt = useRef(0);
  const feedbackRef = useRef(feedback);
  feedbackRef.current = feedback;

  const load = useCallback((options: { refresh?: boolean } = {}): void => {
    if (options.refresh === true) setRefreshing(true);
    fetchPullRequests(options.refresh === true ? { refresh: true } : {})
      .then((value) => {
        setList(value);
        setLoadError(null);
        loadedAt.current = Date.now();
        setRuns((current) => {
          const next = { ...current };
          for (const group of value.repositories) {
            for (const pull of group.pullRequests) {
              if (pull.run !== null) next[pullRequestKey(group.repositoryId, pull.number)] = pull.run;
            }
          }
          return next;
        });
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) {
          window.location.replace('/login');
          return;
        }
        // The banner never replaces the page: whatever loaded stays readable.
        setLoadError(describe(error));
      })
      .finally(() => setRefreshing(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Coming back to a tab left open over lunch costs one request; a tab left
  // hidden costs none at all.
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

  // A slow revalidate so a pull request closed or merged on GitHub drops out of
  // the list without anyone pressing Refresh. Skipped entirely while the tab is
  // hidden — a background tab must not spend the GitHub budget.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      load();
    }, LIST_REVALIDATE_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [load]);

  // Only runs that are actually moving are polled, and only those — the list
  // itself is never polled, because that costs GitHub calls and this does not.
  // Every live run is polled, not just the first: runs share the build cap, so
  // several can be in flight at once and each needs its own state.
  const liveKeys = Object.entries(runs)
    .filter(([, run]) => run.running)
    .map(([key, run]) => `${key}:${run.id}`)
    .sort()
    .join(',');

  useEffect(() => {
    if (liveKeys === '') return;
    const entries = liveKeys.split(',').map((entry) => {
      const cut = entry.lastIndexOf(':');
      return { key: entry.slice(0, cut), id: entry.slice(cut + 1) };
    });

    const tick = (): void => {
      for (const { key, id } of entries) {
        fetchPrRun(id)
          .then((run) => {
            setRuns((current) => ({ ...current, [key]: run }));
            // The moment it stops, re-read the list: the comment counts have
            // changed, and a pull request the run's push caused to be merged
            // should drop out rather than linger until the next revalidate.
            if (!run.running) load({ refresh: true });
          })
          .catch(() => {
            // A run that cannot be read is not a reason to break the page; the
            // next tick, or a refresh, sorts it out.
          });
      }
    };

    const timer = window.setInterval(tick, RUN_POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [liveKeys, load]);

  const onStart = (): void => {
    if (confirming === null) return;
    const { group, pull } = confirming;
    const key = pullRequestKey(group.repositoryId, pull.number);
    setStarting(true);
    startPrRun(group.repositoryId, pull.number)
      .then((run) => {
        setRuns((current) => ({ ...current, [key]: run }));
        setNotices((current) => ({ ...current, [key]: '' }));
        setConfirming(null);
      })
      .catch((error: unknown) => {
        setNotices((current) => ({ ...current, [key]: describe(error) }));
        setConfirming(null);
      })
      .finally(() => setStarting(false));
  };

  const onStop = (group: RepositoryPullRequests, pull: PullRequest, run: PrRun): void => {
    const key = pullRequestKey(group.repositoryId, pull.number);
    stopPrRun(run.id)
      .then((stopped) => {
        setRuns((current) => ({ ...current, [key]: stopped }));
      })
      .catch((error: unknown) => {
        setNotices((current) => ({ ...current, [key]: describe(error) }));
      });
  };

  /**
   * Reads a pull request's feedback once and caches it.
   *
   * Both the disclosure and the action need it — the action because the
   * confirmation has to say how many comments are about to be sent — so it is
   * fetched here rather than by whichever of them the operator pressed first.
   */
  const loadFeedback = useCallback(
    async (group: RepositoryPullRequests, pull: PullRequest): Promise<PullRequestFeedback | null> => {
      const key = pullRequestKey(group.repositoryId, pull.number);
      const known = feedbackRef.current[key]?.value;
      if (known != null) return known;

      setFeedback((current) => ({ ...current, [key]: { loading: true, value: null, error: null } }));
      try {
        const value = await fetchPullRequestFeedback(group.repositoryId, pull.number);
        setFeedback((current) => ({ ...current, [key]: { loading: false, value, error: null } }));
        return value;
      } catch (error: unknown) {
        setFeedback((current) => ({
          ...current,
          [key]: { loading: false, value: null, error: describe(error) },
        }));
        return null;
      }
    },
    [],
  );

  const onToggle = (group: RepositoryPullRequests, pull: PullRequest): void => {
    const key = pullRequestKey(group.repositoryId, pull.number);
    if (expanded === key) {
      setExpanded(null);
      return;
    }
    setExpanded(key);
    void loadFeedback(group, pull);
  };

  /**
   * The action is reachable without expanding the row, so it reads the comments
   * first and puts the count in the confirmation. What is about to be sent is
   * still shown before anything happens — in the dialog rather than by making
   * the operator scroll past it.
   */
  const onProcess = (group: RepositoryPullRequests, pull: PullRequest): void => {
    const key = pullRequestKey(group.repositoryId, pull.number);
    setExpanded(key);
    setPreparing(key);
    void loadFeedback(group, pull)
      .then((value) => {
        if (value === null) return;
        const count =
          value.threads.filter((thread) => !thread.isResolved).length + value.reviews.length;
        if (count === 0) {
          setNotices((current) => ({
            ...current,
            [key]: 'There is no unresolved review feedback on that pull request.',
          }));
          return;
        }
        setConfirming({ group, pull, count });
      })
      .finally(() => setPreparing(null));
  };

  const groups = list?.repositories ?? [];
  const configured = groups.length > 0;

  return (
    <main className="shell shell--wide">
      <Header />

      <p className="tagline">
        Every open pull request on the repositories chief-web knows about, whether or not chief-web
        opened it. Review comments are read when you open a row.
      </p>

      <div className="field__actions field__actions--spaced">
        <button
          type="button"
          className="button"
          onClick={() => load({ refresh: true })}
          disabled={refreshing}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
        {list !== null && (
          <span className="field__hint">
            Asked GitHub {since(list.fetchedAt)} · once per repository
          </span>
        )}
      </div>

      {loadError !== null && (
        <p className="notice notice--error" role="alert">
          <Icon name="alert" />
          Could not load pull requests: {loadError}
        </p>
      )}

      {list === null && loadError === null && <p className="tagline">Loading…</p>}

      {list !== null && !configured && (
        <p className="notice notice--info">
          <Icon name="info" />
          No repositories are configured yet. Add one on the{' '}
          <a className="link" href="/repositories">
            repositories page
          </a>{' '}
          and its open pull requests appear here.
        </p>
      )}

      {groups.map((group) => (
        <section className="pr-group" key={group.repositoryId}>
          <div className="pr-group__head">
            <h2>{group.repositoryName}</h2>
            <span className="pr-group__count">
              {group.error !== null
                ? 'not loaded'
                : `${String(group.pullRequests.length)} open`}
            </span>
          </div>

          {group.error !== null && (
            <p className="notice notice--error" role="alert">
              <Icon name="alert" />
              Could not read pull requests for <code className="mono">{group.githubSlug}</code>:{' '}
              {group.message ?? group.error}
            </p>
          )}

          {group.error === null && group.pullRequests.length === 0 && (
            <p className="notice notice--info">
              <Icon name="info" />
              No open pull requests. Anything opened on GitHub — by you or by chief-web — appears
              here on the next refresh.
            </p>
          )}

          {group.pullRequests.length > 0 && (
            <ul className="cards">
              {group.pullRequests.map((pull) => (
                <PullRequestCard
                  key={pull.number}
                  group={group}
                  pull={pull}
                  expanded={expanded === pullRequestKey(group.repositoryId, pull.number)}
                  feedback={feedback[pullRequestKey(group.repositoryId, pull.number)]}
                  run={runs[pullRequestKey(group.repositoryId, pull.number)]}
                  notice={notices[pullRequestKey(group.repositoryId, pull.number)]}
                  onToggle={() => onToggle(group, pull)}
                  preparing={preparing === pullRequestKey(group.repositoryId, pull.number)}
                  onProcess={() => onProcess(group, pull)}
                  onStop={(run) => onStop(group, pull, run)}
                />
              ))}
            </ul>
          )}
        </section>
      ))}

      <ConfirmDialog
        open={confirming !== null}
        title={
          confirming === null
            ? ''
            : `Process feedback on ${confirming.group.githubSlug} #${String(confirming.pull.number)}?`
        }
        confirmLabel={
          confirming === null ? 'Process' : `Process ${String(confirming.count)} comments`
        }
        busy={starting}
        onConfirm={onStart}
        onCancel={() => setConfirming(null)}
      >
        <p>
          chief-web will check out <code className="mono">{confirming?.pull.headRef}</code>, run a
          headless Claude Code agent over the unresolved comments, then commit and push to that
          branch. The pull request updates for everyone watching it.
        </p>
        <p>
          It then replies to each comment it addressed and marks the thread resolved.{' '}
          <strong>Those replies are public</strong>, and are posted by the account your stored
          GitHub token belongs to.
        </p>
        {confirming?.pull.sessionId === null && (
          <p>
            chief-web has no workspace for this pull request yet, so it makes a fresh clone first.
            That takes a moment before the agent starts.
          </p>
        )}
        <p className="field__hint">
          Nothing is force-pushed, no comment is deleted, and no thread the agent did not address is
          resolved. If the agent changes nothing, nothing is pushed.
        </p>
      </ConfirmDialog>
    </main>
  );
}

function PullRequestCard({
  group,
  pull,
  expanded,
  feedback,
  run,
  notice,
  preparing,
  onToggle,
  onProcess,
  onStop,
}: {
  readonly group: RepositoryPullRequests;
  readonly pull: PullRequest;
  readonly expanded: boolean;
  readonly feedback: FeedbackState | undefined;
  readonly run: PrRun | undefined;
  readonly notice: string | undefined;
  /** Its comments are being read so the confirmation can name a count. */
  readonly preparing: boolean;
  readonly onToggle: () => void;
  readonly onProcess: () => void;
  readonly onStop: (run: PrRun) => void;
}) {
  const panelId = `pr-panel-${group.repositoryId}-${String(pull.number)}`;
  const unresolved =
    feedback?.value === undefined || feedback.value === null
      ? null
      : feedback.value.threads.filter((thread) => !thread.isResolved).length +
        feedback.value.reviews.length;

  return (
    <li className="card">
      <div className="card__header">
        <h3 className="card__title">
          <span className="mono">#{pull.number}</span>
          {pull.title}
          {pull.sessionId !== null && <span className="badge badge--finished">chief-web</span>}
          {pull.draft && <span className="badge badge--pending">draft</span>}
          {pull.fromFork && <span className="badge badge--failed">fork</span>}
          {run !== undefined && <RunBadge run={run} />}
        </h3>
        <div className="field__actions">
          <button
            type="button"
            className="button pr__toggle"
            aria-expanded={expanded}
            aria-controls={panelId}
            onClick={onToggle}
          >
            Feedback
            {unresolved !== null && ` (${String(unresolved)})`}
            <span className="visually-hidden">
              {' '}
              on pull request {pull.number}, {pull.title}
            </span>
            <Icon name="chevron-down" />
          </button>
          {!pull.fromFork && (
            <button
              type="button"
              className="button button--primary"
              disabled={run?.running === true || preparing}
              onClick={onProcess}
            >
              {run?.running === true
                ? 'Running…'
                : preparing
                  ? 'Reading comments…'
                  : 'Process feedback comments'}
            </button>
          )}
          {run?.running === true && (
            <button type="button" className="button button--quiet" onClick={() => onStop(run)}>
              Stop
            </button>
          )}
          <a className="button button--quiet" href={pull.url} target="_blank" rel="noreferrer">
            GitHub
            <Icon name="link-external" />
          </a>
        </div>
      </div>

      <div className="pr__facts">
        <span className="mono">
          {pull.headRef} → {pull.baseRef}
        </span>
        {pull.authorLogin !== null && <span>{pull.authorLogin}</span>}
        <span>updated {since(pull.updatedAt)}</span>
        {pull.sessionId !== null && (
          <a className="link" href={sessionPath(pull.sessionId)}>
            session
          </a>
        )}
      </div>

      {notice !== undefined && notice !== '' && (
        <p className="notice notice--error" role="alert">
          <Icon name="alert" />
          {notice}
        </p>
      )}

      {run !== undefined && run.status !== 'pending' && <RunSummary run={run} />}

      {expanded && (
        <div className="pr__panel" id={panelId}>
          <Feedback pull={pull} state={feedback} />
        </div>
      )}
    </li>
  );
}

/**
 * The run's state as one pill.
 *
 * Every working phase shares the blue "building" tint — the question at a
 * glance is "is it moving?", which the pulsing dot answers — and the word says
 * at what. Inventing a tint per phase would break the status vocabulary the
 * rest of the app uses.
 */
function RunBadge({ run }: { readonly run: PrRun }) {
  if (run.running && run.phase !== null) {
    return <span className="badge badge--building">{prPhaseLabel(run.phase)}</span>;
  }
  if (run.status === 'failed') {
    return (
      <span className="badge badge--failed">
        failed{run.failureStage === null ? '' : `: ${prFailureStageLabel(run.failureStage)}`}
      </span>
    );
  }
  if (run.status === 'finished') return <span className="badge badge--done">answered</span>;
  return null;
}

/** What a finished or failed run actually did, in the numbers that matter. */
function RunSummary({ run }: { readonly run: PrRun }) {
  const addressed = run.threads.filter((thread) => thread.outcome === 'addressed').length;
  const replied = run.threads.filter((thread) => thread.replied).length;
  const resolved = run.threads.filter((thread) => thread.resolved).length;
  // A thread that was answered but not resolved is not a problem — it is a
  // note, and usually the same note on every thread. Only a comment that never
  // got an answer belongs in a red list.
  const unanswered = run.threads.filter((thread) => thread.error !== null && !thread.replied);
  const notes = [
    ...new Set(
      run.threads
        .filter((thread) => thread.error !== null && thread.replied)
        .map((thread) => thread.error ?? ''),
    ),
  ];

  if (run.running) {
    return (
      <p className="field__hint">
        Pass {run.attempt} · started {run.startedAt === null ? 'just now' : since(run.startedAt)}
      </p>
    );
  }

  return (
    <div className="pr__run">
      {run.status === 'failed' ? (
        <p className="notice notice--error" role="alert">
          <Icon name="alert" />
          {run.lastError ?? 'The run failed.'}
        </p>
      ) : (
        <p className={replied > 0 && addressed === 0 ? 'notice notice--warn' : 'notice notice--ok'}>
          <Icon name={addressed > 0 ? 'check-circle' : 'info'} />
          {run.headSha === null
            ? 'The agent changed nothing, so nothing was pushed.'
            : `Pushed ${run.headSha.slice(0, 7)}.`}{' '}
          Answered {replied} of {run.threads.length} comments, resolved {resolved}.
        </p>
      )}

      {notes.map((note) => (
        <p className="field__hint" key={note}>
          {note}
        </p>
      ))}

      {unanswered.length > 0 && (
        <ul className="threads">
          {unanswered.map((thread) => (
            <li className="thread" key={thread.threadId}>
              <div className="thread__head">
                <span className="thread__file">{thread.key}</span>
                <span className="badge badge--failed">not answered</span>
              </div>
              <div className="thread__body">
                <p>{thread.error}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Feedback({
  pull,
  state,
}: {
  readonly pull: PullRequest;
  readonly state: FeedbackState | undefined;
}) {
  if (state === undefined || state.loading) return <p className="tagline">Reading comments…</p>;
  if (state.error !== null) {
    return (
      <p className="notice notice--error" role="alert">
        <Icon name="alert" />
        {state.error}
      </p>
    );
  }
  if (state.value === null) return null;

  const unresolved = state.value.threads.filter((thread) => !thread.isResolved);
  const reviews = state.value.reviews;

  if (unresolved.length === 0 && reviews.length === 0) {
    return (
      <p className="notice notice--ok">
        <Icon name="check-circle" />
        No unresolved review comments on this pull request.
      </p>
    );
  }

  return (
    <>
      <p className="field__hint">
        {unresolved.length} unresolved review {unresolved.length === 1 ? 'thread' : 'threads'} and{' '}
        {reviews.length} review {reviews.length === 1 ? 'summary' : 'summaries'}. Threads already
        resolved on GitHub are not shown.
        {pull.fromFork && ' This pull request comes from a fork, so chief-web cannot push to it.'}
      </p>

      <ul className="threads">
        {unresolved.map((thread) => (
          <ThreadItem key={thread.id} thread={thread} />
        ))}
        {reviews.map((review) => (
          <li className="thread" key={review.id}>
            <div className="thread__head">
              <span className="thread__path">
                <span className="thread__file">Review summary</span>
              </span>
              <span className="thread__author">
                {review.authorLogin ?? 'unknown'}
                {review.authorType === 'Bot' && ' · bot'}
              </span>
            </div>
            <CommentBody body={review.body} />
          </li>
        ))}
      </ul>
    </>
  );
}

function ThreadItem({ thread }: { readonly thread: ReviewThread }) {
  const comment = thread.comments[0];
  const path = thread.path === null ? null : splitPath(thread.path);

  return (
    <li className="thread">
      <div className="thread__head">
        <span className="thread__path">
          {path?.dir != null && <span className="thread__dir">{path.dir}</span>}
          <span className="thread__file">
            {path?.name ?? 'On the pull request'}
            {thread.line !== null && `:${String(thread.line)}`}
          </span>
        </span>
        <span className="thread__author">
          {comment?.authorLogin ?? 'unknown'}
          {comment?.authorType === 'Bot' && ' · bot'}
          {thread.isOutdated && ' · outdated'}
        </span>
      </div>
      <CommentBody body={comment?.body ?? ''} />
    </li>
  );
}

/**
 * A comment body, rendered from the small markdown subset these actually use.
 * Everything is a React node, so the text is escaped and no HTML is ever built
 * from something a reviewer wrote.
 */
function CommentBody({ body }: { readonly body: string }) {
  const parts: BodyPart[] = parseCommentBody(body);
  return (
    <div className="thread__body">
      {parts.map((part, index) =>
        part.kind === 'code' ? (
          <pre className="output output--wrap" key={index}>
            {part.text}
          </pre>
        ) : (
          <p key={index}>
            {part.runs.map((run, runIndex) =>
              run.code ? (
                <code className="mono" key={runIndex}>
                  {run.text}
                </code>
              ) : (
                <span key={runIndex}>{run.text}</span>
              ),
            )}
          </p>
        ),
      )}
    </div>
  );
}

/** Written as its own component so the shared nav can replace it in one edit. */
function Header() {
  return (
    <header className="topbar">
      <h1>Pull requests</h1>
      <nav className="topbar__nav">
        <a className="link" href="/sessions">
          Sessions
        </a>
        <a className="link" href="/repositories">
          Repositories
        </a>
        <a className="link" href="/terminal">
          Terminal
        </a>
        <a className="link" href="/settings">
          Settings
        </a>
        <button
          type="button"
          className="button button--quiet"
          onClick={() => {
            logout().finally(() => window.location.replace('/login'));
          }}
        >
          Log out
        </button>
      </nav>
    </header>
  );
}
