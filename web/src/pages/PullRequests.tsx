import { useCallback, useEffect, useRef, useState } from 'react';

import {
  fetchPrReview,
  fetchPrRun,
  fetchPullRequestFeedback,
  fetchPullRequests,
  type PrReview,
  type PrRun,
  prFailureStageLabel,
  prPhaseLabel,
  prReviewFailureStageLabel,
  prReviewPhaseLabel,
  type PullRequest,
  type PullRequestFeedback,
  type PullRequestList,
  pullRequestKey,
  type RepositoryPullRequests,
  type ReviewThread,
  sessionPath,
  startPrReview,
  startPrRun,
  stopPrReview,
  stopPrRun,
} from '../api.ts';
import { type BodyPart, parseCommentBody, splitPath } from '../comment.ts';
import { ConfirmDialog } from '../ConfirmDialog.tsx';
import { describeError, redirectIfUnauthorised } from '../data.tsx';
import { Icon } from '../Icon.tsx';
import { Link } from '../router.tsx';
import { since } from '../schedule.ts';
import { useToast } from '../toast.tsx';
import { Badge, EmptyState, Notice, PageHeader, Panel, Skeleton } from '../ui.tsx';

/**
 * Every open pull request on the configured repositories, and the review
 * feedback each carries (US-021).
 *
 * Unlike the session list, nothing here polls GitHub. The list is one request
 * per repository against a rate-limited budget, so it is loaded once,
 * refreshed on demand, and revalidated only when the tab becomes visible again
 * after a while. A hidden tab costs nothing.
 */

const REVALIDATE_AFTER_MS = 120_000;
const RUN_POLL_MS = 2000;
const LIST_REVALIDATE_MS = 300_000;

interface FeedbackState {
  readonly loading: boolean;
  readonly value: PullRequestFeedback | null;
  readonly error: string | null;
}

export function PullRequests() {
  const toast = useToast();
  const [list, setList] = useState<PullRequestList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /** Only one row is open at a time: expanding costs a GitHub call. */
  const [expanded, setExpanded] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, FeedbackState>>({});
  /** Run state per pull request, seeded from the list and then polled. */
  const [runs, setRuns] = useState<Record<string, PrRun>>({});
  /** Review state per pull request, seeded and polled the same way. */
  const [reviews, setReviews] = useState<Record<string, PrReview>>({});
  const [confirming, setConfirming] = useState<{ group: RepositoryPullRequests; pull: PullRequest; count: number } | null>(null);
  const [starting, setStarting] = useState(false);
  const [confirmingReview, setConfirmingReview] = useState<{ group: RepositoryPullRequests; pull: PullRequest } | null>(null);
  const [startingReview, setStartingReview] = useState(false);
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
        setReviews((current) => {
          const next = { ...current };
          for (const group of value.repositories) {
            for (const pull of group.pullRequests) {
              if (pull.review !== null) next[pullRequestKey(group.repositoryId, pull.number)] = pull.review;
            }
          }
          return next;
        });
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

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, LIST_REVALIDATE_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [load]);

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
            if (!run.running) load({ refresh: true });
          })
          .catch(() => {
            // The next tick, or a refresh, sorts it out.
          });
      }
    };
    const timer = window.setInterval(tick, RUN_POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [liveKeys, load]);

  const liveReviewKeys = Object.entries(reviews)
    .filter(([, review]) => review.running)
    .map(([key, review]) => `${key}:${review.id}`)
    .sort()
    .join(',');

  useEffect(() => {
    if (liveReviewKeys === '') return;
    const entries = liveReviewKeys.split(',').map((entry) => {
      const cut = entry.lastIndexOf(':');
      return { key: entry.slice(0, cut), id: entry.slice(cut + 1) };
    });
    const tick = (): void => {
      for (const { key, id } of entries) {
        fetchPrReview(id)
          .then((review) => {
            setReviews((current) => ({ ...current, [key]: review }));
            // A finished review may have started a feedback run; the refresh
            // picks that run up along with the review itself.
            if (!review.running) load({ refresh: true });
          })
          .catch(() => {
            // The next tick, or a refresh, sorts it out.
          });
      }
    };
    const timer = window.setInterval(tick, RUN_POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [liveReviewKeys, load]);

  const onStartReview = (): void => {
    if (confirmingReview === null) return;
    const { group, pull } = confirmingReview;
    const key = pullRequestKey(group.repositoryId, pull.number);
    setStartingReview(true);
    startPrReview(group.repositoryId, pull.number)
      .then((review) => {
        setReviews((current) => ({ ...current, [key]: review }));
        toast.ok(`Reviewing #${String(pull.number)}.`);
      })
      .catch((error: unknown) => toast.error(describeError(error)))
      .finally(() => {
        setConfirmingReview(null);
        setStartingReview(false);
      });
  };

  const onStopReview = (group: RepositoryPullRequests, pull: PullRequest, review: PrReview): void => {
    const key = pullRequestKey(group.repositoryId, pull.number);
    stopPrReview(review.id)
      .then((stopped) => setReviews((current) => ({ ...current, [key]: stopped })))
      .catch((error: unknown) => toast.error(describeError(error)));
  };

  const onStart = (): void => {
    if (confirming === null) return;
    const { group, pull } = confirming;
    const key = pullRequestKey(group.repositoryId, pull.number);
    setStarting(true);
    startPrRun(group.repositoryId, pull.number)
      .then((run) => {
        setRuns((current) => ({ ...current, [key]: run }));
        toast.ok(`Processing feedback on #${String(pull.number)}.`);
      })
      .catch((error: unknown) => toast.error(describeError(error)))
      .finally(() => {
        setConfirming(null);
        setStarting(false);
      });
  };

  const onStop = (group: RepositoryPullRequests, pull: PullRequest, run: PrRun): void => {
    const key = pullRequestKey(group.repositoryId, pull.number);
    stopPrRun(run.id)
      .then((stopped) => setRuns((current) => ({ ...current, [key]: stopped })))
      .catch((error: unknown) => toast.error(describeError(error)));
  };

  const loadFeedback = useCallback(async (group: RepositoryPullRequests, pull: PullRequest): Promise<PullRequestFeedback | null> => {
    const key = pullRequestKey(group.repositoryId, pull.number);
    const known = feedbackRef.current[key]?.value;
    if (known != null) return known;
    setFeedback((current) => ({ ...current, [key]: { loading: true, value: null, error: null } }));
    try {
      const value = await fetchPullRequestFeedback(group.repositoryId, pull.number);
      setFeedback((current) => ({ ...current, [key]: { loading: false, value, error: null } }));
      return value;
    } catch (error: unknown) {
      setFeedback((current) => ({ ...current, [key]: { loading: false, value: null, error: describeError(error) } }));
      return null;
    }
  }, []);

  const onToggle = (group: RepositoryPullRequests, pull: PullRequest): void => {
    const key = pullRequestKey(group.repositoryId, pull.number);
    if (expanded === key) {
      setExpanded(null);
      return;
    }
    setExpanded(key);
    void loadFeedback(group, pull);
  };

  const onProcess = (group: RepositoryPullRequests, pull: PullRequest): void => {
    const key = pullRequestKey(group.repositoryId, pull.number);
    setExpanded(key);
    setPreparing(key);
    void loadFeedback(group, pull)
      .then((value) => {
        if (value === null) return;
        const count = value.threads.filter((thread) => !thread.isResolved).length + value.reviews.length;
        if (count === 0) {
          toast.info('There is no unresolved review feedback on that pull request.');
          return;
        }
        setConfirming({ group, pull, count });
      })
      .finally(() => setPreparing(null));
  };

  const groups = list?.repositories ?? [];
  const total = groups.reduce((sum, group) => sum + group.pullRequests.length, 0);

  return (
    <div className="page">
      <PageHeader
        title="Pull requests"
        subtitle={
          list === null
            ? 'Asking GitHub…'
            : `${String(total)} open across ${String(groups.length)} ${groups.length === 1 ? 'repository' : 'repositories'} · asked GitHub ${since(list.fetchedAt)}`
        }
        actions={
          <button type="button" className="button" onClick={() => load({ refresh: true })} disabled={refreshing}>
            <Icon name="sync" />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        }
      />

      {loadError !== null && <Notice kind="error">Could not load pull requests: {loadError}</Notice>}

      {list === null && loadError === null && (
        <div className="panel">
          <div className="panel__body">
            <Skeleton lines={4} />
          </div>
        </div>
      )}

      {list !== null && groups.length === 0 && (
        <EmptyState icon="repo" title="No repositories configured" action={<Link className="button" href="/repositories">Add a repository</Link>}>
          Open pull requests on every repository chief-web knows about appear here, whether or not chief-web opened them.
        </EmptyState>
      )}

      {groups.map((group) => (
        <Panel
          key={group.repositoryId}
          title={group.repositoryName}
          icon="repo"
          meta={<span className="panel__meta muted">{group.error !== null ? 'not loaded' : `${String(group.pullRequests.length)} open`}</span>}
          actions={
            <a className="link" href={`https://github.com/${group.githubSlug}/pulls`} target="_blank" rel="noreferrer">
              {group.githubSlug}
              <Icon name="link-external" />
            </a>
          }
        >
          {group.error !== null && (
            <Notice kind="error">
              Could not read pull requests for <code className="mono">{group.githubSlug}</code>: {group.message ?? group.error}
            </Notice>
          )}
          {group.error === null && group.pullRequests.length === 0 && (
            <p className="muted">No open pull requests. Anything opened on GitHub appears here on the next refresh.</p>
          )}
          {group.pullRequests.length > 0 && (
            <ul className="rows rows--divided">
              {group.pullRequests.map((pull) => (
                <PullRequestRow
                  key={pull.number}
                  group={group}
                  pull={pull}
                  expanded={expanded === pullRequestKey(group.repositoryId, pull.number)}
                  feedback={feedback[pullRequestKey(group.repositoryId, pull.number)]}
                  run={runs[pullRequestKey(group.repositoryId, pull.number)]}
                  review={reviews[pullRequestKey(group.repositoryId, pull.number)]}
                  preparing={preparing === pullRequestKey(group.repositoryId, pull.number)}
                  onToggle={() => onToggle(group, pull)}
                  onProcess={() => onProcess(group, pull)}
                  onStop={(run) => onStop(group, pull, run)}
                  onReview={() => setConfirmingReview({ group, pull })}
                  onStopReview={(review) => onStopReview(group, pull, review)}
                />
              ))}
            </ul>
          )}
        </Panel>
      ))}

      <ConfirmDialog
        open={confirming !== null}
        title={confirming === null ? '' : `Process feedback on ${confirming.group.githubSlug} #${String(confirming.pull.number)}?`}
        confirmLabel={confirming === null ? 'Process' : `Process ${String(confirming.count)} ${confirming.count === 1 ? 'comment' : 'comments'}`}
        busyLabel="Starting…"
        busy={starting}
        onConfirm={onStart}
        onCancel={() => setConfirming(null)}
      >
        <p>
          chief-web checks out <code className="mono">{confirming?.pull.headRef}</code>, runs a headless Claude Code agent over the
          unresolved comments, then commits and pushes to that branch. The pull request updates for everyone watching it.
        </p>
        <p>
          It then replies to each comment it addressed and marks the thread resolved. <strong>Those replies are public</strong>, posted
          by the account your stored GitHub token belongs to.
        </p>
        {confirming?.pull.sessionId === null && (
          <p>chief-web has no workspace for this pull request yet, so it makes a fresh clone first.</p>
        )}
        <p className="field__hint">
          Nothing is force-pushed, no comment is deleted, and no thread the agent did not address is resolved. If the agent changes
          nothing, nothing is pushed.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmingReview !== null}
        title={confirmingReview === null ? '' : `Review ${confirmingReview.group.githubSlug} #${String(confirmingReview.pull.number)}?`}
        confirmLabel="Start review"
        busyLabel="Starting…"
        busy={startingReview}
        onConfirm={onStartReview}
        onCancel={() => setConfirmingReview(null)}
      >
        <p>
          chief-web checks out <code className="mono">{confirmingReview?.pull.headRef}</code> and runs a headless Claude Code agent over
          its diff against <code className="mono">{confirmingReview?.pull.baseRef}</code>. It changes nothing on the branch.
        </p>
        <p>
          The findings are posted to the pull request as one review, of type comment. <strong>That review is public</strong>, posted by
          the account your stored GitHub token belongs to. Findings that flag something then start a feedback run to work on them, as
          if you had pressed Address feedback.
        </p>
        <p className="field__hint">
          The review runs on the model chosen under Settings → Models → Review, and takes one build slot while it runs.
        </p>
      </ConfirmDialog>
    </div>
  );
}

function PullRequestRow({
  group,
  pull,
  expanded,
  feedback,
  run,
  review,
  preparing,
  onToggle,
  onProcess,
  onStop,
  onReview,
  onStopReview,
}: {
  readonly group: RepositoryPullRequests;
  readonly pull: PullRequest;
  readonly expanded: boolean;
  readonly feedback: FeedbackState | undefined;
  readonly run: PrRun | undefined;
  readonly review: PrReview | undefined;
  readonly preparing: boolean;
  readonly onToggle: () => void;
  readonly onProcess: () => void;
  readonly onStop: (run: PrRun) => void;
  readonly onReview: () => void;
  readonly onStopReview: (review: PrReview) => void;
}) {
  const panelId = `pr-panel-${group.repositoryId}-${String(pull.number)}`;
  const unresolved =
    feedback?.value === undefined || feedback.value === null
      ? null
      : feedback.value.threads.filter((thread) => !thread.isResolved).length + feedback.value.reviews.length;

  return (
    <li className="row row--stacked pr__row">
      <div className="row__line">
        <Icon name="git-pull-request" className={pull.draft ? 'text-muted' : 'text-done'} />
        <div className="row__main">
          <span className="row__title">
            <a className="link link--strong" href={pull.url} target="_blank" rel="noreferrer">
              {pull.title}
            </a>
            <span className="mono muted"> #{pull.number}</span>
            {pull.sessionId !== null && <Badge tone="final">chief</Badge>}
            {pull.draft && <Badge>draft</Badge>}
            {pull.fromFork && <Badge tone="danger">fork</Badge>}
            {run !== undefined && <RunBadge run={run} />}
            {review !== undefined && <ReviewBadge review={review} />}
          </span>
          <span className="row__meta">
            <span className="mono">
              {pull.headRef} → {pull.baseRef}
            </span>
            {pull.authorLogin !== null && ` · ${pull.authorLogin}`}
            {` · updated ${since(pull.updatedAt)}`}
            {pull.sessionId !== null && (
              <>
                {' · '}
                <Link className="link" href={sessionPath(pull.sessionId)}>
                  session
                </Link>
              </>
            )}
          </span>
        </div>
        <div className="row__actions">
          <button type="button" className="button button--small button--quiet pr__toggle" aria-expanded={expanded} aria-controls={panelId} onClick={onToggle}>
            <Icon name="comment" />
            Feedback{unresolved !== null && ` (${String(unresolved)})`}
            <span className="visually-hidden"> on pull request {pull.number}</span>
            <Icon name="chevron-down" />
          </button>
          {!pull.fromFork && review?.running !== true && (
            <button type="button" className="button button--small" onClick={onReview}>
              <Icon name="search" />
              Review
              <span className="visually-hidden"> pull request {pull.number}</span>
            </button>
          )}
          {review?.running === true && (
            <button type="button" className="button button--small" onClick={() => onStopReview(review)}>
              <Icon name="stop" />
              Stop review
            </button>
          )}
          {!pull.fromFork && run?.running !== true && (
            <button type="button" className="button button--small button--primary" disabled={preparing} onClick={onProcess}>
              <Icon name="zap" />
              {preparing ? 'Reading…' : 'Address feedback'}
            </button>
          )}
          {run?.running === true && (
            <button type="button" className="button button--small" onClick={() => onStop(run)}>
              <Icon name="stop" />
              Stop
            </button>
          )}
        </div>
      </div>

      {review !== undefined && review.status !== 'pending' && <ReviewSummary review={review} />}
      {run !== undefined && run.status !== 'pending' && <RunSummary run={run} />}

      {expanded && (
        <div className="pr__panel" id={panelId}>
          <Feedback pull={pull} state={feedback} />
        </div>
      )}
    </li>
  );
}

function RunBadge({ run }: { readonly run: PrRun }) {
  if (run.running && run.phase !== null) {
    return (
      <Badge tone="active" pulse>
        {prPhaseLabel(run.phase)}
      </Badge>
    );
  }
  if (run.status === 'failed') {
    return <Badge tone="danger">failed{run.failureStage === null ? '' : `: ${prFailureStageLabel(run.failureStage)}`}</Badge>;
  }
  if (run.status === 'finished') return <Badge tone="done">answered</Badge>;
  return null;
}

function ReviewBadge({ review }: { readonly review: PrReview }) {
  if (review.running && review.phase !== null) {
    return (
      <Badge tone="review" pulse>
        {prReviewPhaseLabel(review.phase)}
      </Badge>
    );
  }
  if (review.status === 'failed') {
    return (
      <Badge tone="danger">
        review failed{review.failureStage === null ? '' : `: ${prReviewFailureStageLabel(review.failureStage)}`}
      </Badge>
    );
  }
  if (review.status === 'finished') return <Badge tone="review">reviewed</Badge>;
  return null;
}

function ReviewSummary({ review }: { readonly review: PrReview }) {
  if (review.running) {
    return (
      <p className="row__meta">
        Review {review.attempt} · started {review.startedAt === null ? 'just now' : since(review.startedAt)}
      </p>
    );
  }
  if (review.status === 'failed') {
    return (
      <div className="pr__run">
        <Notice kind="error">{review.lastError ?? 'The review failed.'}</Notice>
      </div>
    );
  }

  const total = (review.inlineComments ?? 0) + (review.foldedFindings ?? 0);
  return (
    <div className="pr__run">
      <Notice kind="ok">
        {total === 0
          ? 'The review found nothing to comment on.'
          : `The review posted ${String(total)} ${total === 1 ? 'finding' : 'findings'}${(review.foldedFindings ?? 0) > 0 ? ` (${String(review.foldedFindings)} in the review body)` : ''}.`}
        {review.headSha !== null && ` Reviewed ${review.headSha.slice(0, 7)}.`}
        {review.solverMessage !== null && ` ${review.solverMessage}`}
        {review.reviewUrl !== null && (
          <>
            {' '}
            <a className="link" href={review.reviewUrl} target="_blank" rel="noreferrer">
              Open on GitHub
              <Icon name="link-external" />
            </a>
          </>
        )}
      </Notice>
    </div>
  );
}

function RunSummary({ run }: { readonly run: PrRun }) {
  const addressed = run.threads.filter((thread) => thread.outcome === 'addressed').length;
  const replied = run.threads.filter((thread) => thread.replied).length;
  const resolved = run.threads.filter((thread) => thread.resolved).length;
  const unanswered = run.threads.filter((thread) => thread.error !== null && !thread.replied);
  const notes = [...new Set(run.threads.filter((thread) => thread.error !== null && thread.replied).map((thread) => thread.error ?? ''))];

  if (run.running) {
    return (
      <p className="row__meta">
        Pass {run.attempt} · started {run.startedAt === null ? 'just now' : since(run.startedAt)}
      </p>
    );
  }

  return (
    <div className="pr__run">
      {run.status === 'failed' ? (
        <Notice kind="error">{run.lastError ?? 'The run failed.'}</Notice>
      ) : (
        <Notice kind={replied > 0 && addressed === 0 ? 'warn' : 'ok'}>
          {run.headSha === null ? 'The agent changed nothing, so nothing was pushed.' : `Pushed ${run.headSha.slice(0, 7)}.`} Answered{' '}
          {replied} of {run.threads.length} comments, resolved {resolved}.
        </Notice>
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
                <Badge tone="danger">not answered</Badge>
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

function Feedback({ pull, state }: { readonly pull: PullRequest; readonly state: FeedbackState | undefined }) {
  if (state === undefined || state.loading) return <Skeleton lines={3} />;
  if (state.error !== null) return <Notice kind="error">{state.error}</Notice>;
  if (state.value === null) return null;

  const unresolved = state.value.threads.filter((thread) => !thread.isResolved);
  const reviews = state.value.reviews;

  if (unresolved.length === 0 && reviews.length === 0) {
    return <Notice kind="ok">No unresolved review comments on this pull request.</Notice>;
  }

  return (
    <>
      <p className="field__hint">
        {unresolved.length} unresolved review {unresolved.length === 1 ? 'thread' : 'threads'} and {reviews.length} review{' '}
        {reviews.length === 1 ? 'summary' : 'summaries'}. Threads already resolved on GitHub are not shown.
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
