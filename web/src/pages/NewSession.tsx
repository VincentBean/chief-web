import { type FormEvent, useEffect, useState } from 'react';

import {
  createSession,
  featureBranchFor,
  fetchSettings,
  type PrTargetBranch,
  type SessionInput,
  sessionPath,
} from '../api.ts';
import { describeError, useAppData } from '../data.tsx';
import { Icon } from '../Icon.tsx';
import { Link, navigate } from '../router.tsx';
import { fromLocalParts, normaliseTime } from '../schedule.ts';
import { useToast } from '../toast.tsx';
import { Notice, PageHeader, Panel, Skeleton } from '../ui.tsx';

/** Session names become branch names and directories, so keep them to a slug. */
const SESSION_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Creating a session: the form on the left, what it does on the right. Its
 * own page rather than a form folded into the list, so the URL can be handed
 * out and the keyboard shortcut has somewhere to go.
 */
export function NewSession() {
  const { sessions, repositories, claude, refresh } = useAppData();
  const toast = useToast();
  const usable = (repositories ?? []).filter((repository) => repository.keyConfigured);

  const [repositoryId, setRepositoryId] = useState('');
  const [name, setName] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [prTargetBranch, setPrTargetBranch] = useState<PrTargetBranch>('main');
  const [schedule, setSchedule] = useState(false);
  const [day, setDay] = useState('');
  const [time, setTime] = useState('');
  /** null until the global default has loaded, so an early create can omit it. */
  const [codeReview, setCodeReview] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stderr, setStderr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // "Code review by default" only seeds the checkbox: once it has loaded, or
  // once the operator has touched the box, their choice is what is sent.
  useEffect(() => {
    const controller = new AbortController();
    fetchSettings(controller.signal)
      .then((settings) => setCodeReview((current) => current ?? settings.codeReviewDefault))
      .catch(() => {
        // A convenience, not a requirement: an unreadable setting leaves it off
        // here and the server resolves the default itself.
      });
    return () => controller.abort();
  }, []);

  // The first usable repository is the default, and the base branch follows
  // the repository until the operator overrides it.
  const selected = usable.find((r) => r.id === repositoryId) ?? usable[0] ?? null;
  const effectiveBase = baseBranch === '' ? (selected?.defaultBaseBranch ?? 'main') : baseBranch;
  const trimmedName = name.trim();

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setError(null);
    setStderr(null);
    if (selected === null) {
      setError('Choose a repository.');
      return;
    }
    if (!SESSION_NAME_PATTERN.test(trimmedName)) {
      setError('The session name may only contain letters, numbers, hyphens and underscores.');
      return;
    }
    if ((sessions ?? []).some((s) => s.repositoryId === selected.id && s.name === trimmedName)) {
      setError('That repository already has a session with this name.');
      return;
    }
    const input: SessionInput = { repositoryId: selected.id, name: trimmedName, prTargetBranch };
    // Still loading: say nothing and let the server apply the global default.
    if (codeReview !== null) input.codeReview = codeReview;
    if (effectiveBase.trim() !== '') input.baseBranch = effectiveBase.trim();
    if (schedule) {
      const at = fromLocalParts(day, time);
      if (at === null) {
        setError(day === '' ? 'Pick a day as well as a time.' : 'Write the time as HH:mm on a 24-hour clock, such as 07:30.');
        return;
      }
      input.scheduledStartAt = at;
    }

    setBusy(true);
    createSession(input)
      .then(async (result) => {
        await refresh();
        if (result.setup.ok) {
          toast.ok(`Created ${result.session.name} on ${result.session.featureBranch}.`);
          navigate(sessionPath(result.session.id));
          return;
        }
        // The session exists but its clone failed: show git's words here,
        // where the form still has the values that produced them.
        setError(result.setup.message);
        setStderr(result.setup.stderr === '' ? null : result.setup.stderr);
        toast.warn(`${result.session.name} was created but could not be cloned.`);
      })
      .catch((cause: unknown) => setError(describeError(cause)))
      .finally(() => setBusy(false));
  };

  const blocked = claude !== null && !claude.status.authenticated;

  return (
    <div className="page page--narrow">
      <PageHeader
        back={{ href: '/sessions', label: 'Sessions' }}
        title="New session"
        subtitle="A container, a clone and a branch of its own. Planning starts on the next page."
      />

      {blocked && (
        <Notice kind="error">
          Claude Code is not signed in, so a session cannot be created yet.{' '}
          <Link className="link" href="/settings#claude">
            Sign in from Settings
          </Link>
          .
        </Notice>
      )}

      <div className="grid grid--form">
        <form className="panel" onSubmit={submit}>
          <div className="panel__body form">
            {repositories === null ? (
              <Skeleton lines={4} />
            ) : usable.length === 0 ? (
              <Notice kind="info">
                No repository has a deploy key yet.{' '}
                <Link className="link" href="/repositories">
                  Add one
                </Link>{' '}
                first.
              </Notice>
            ) : (
              <>
                <div className="field">
                  <label className="field__label" htmlFor="session-repository">
                    Repository
                  </label>
                  <select
                    id="session-repository"
                    className="field__input"
                    value={selected?.id ?? ''}
                    onChange={(event) => {
                      setRepositoryId(event.target.value);
                      setBaseBranch('');
                    }}
                  >
                    {usable.map((repository) => (
                      <option key={repository.id} value={repository.id}>
                        {repository.name} · {repository.githubSlug}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <label className="field__label" htmlFor="session-name">
                    Name
                  </label>
                  <input
                    id="session-name"
                    className="field__input"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="add-login"
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus
                    aria-describedby="session-name-hint"
                  />
                  <p className="field__hint" id="session-name-hint">
                    Letters, numbers, hyphens and underscores. Branch:{' '}
                    <code className="mono">{featureBranchFor(trimmedName === '' ? '<name>' : trimmedName)}</code>
                  </p>
                </div>

                <div className="field__row">
                  <div className="field">
                    <label className="field__label" htmlFor="session-base-branch">
                      Base branch
                    </label>
                    <input
                      id="session-base-branch"
                      className="field__input"
                      value={effectiveBase}
                      onChange={(event) => setBaseBranch(event.target.value)}
                      placeholder="main"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <p className="field__hint">What the feature branch is created from.</p>
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor="session-pr-target">
                      Pull request into
                    </label>
                    <select
                      id="session-pr-target"
                      className="field__input"
                      value={prTargetBranch}
                      onChange={(event) => setPrTargetBranch(event.target.value as PrTargetBranch)}
                    >
                      <option value="main">main</option>
                      <option value="develop">develop</option>
                    </select>
                    <p className="field__hint">Opened when the last story is done.</p>
                  </div>
                </div>

                <div className="field">
                  <label className="checkbox">
                    <input type="checkbox" checked={schedule} onChange={(event) => setSchedule(event.target.checked)} />
                    Start the build at a set time
                  </label>
                  {schedule && (
                    <div className="field__pair">
                      <input
                        className="field__input"
                        type="date"
                        value={day}
                        onChange={(event) => setDay(event.target.value)}
                        aria-label="Day the build starts"
                      />
                      <input
                        className="field__input field__input--narrow"
                        type="text"
                        inputMode="numeric"
                        placeholder="HH:mm"
                        maxLength={5}
                        value={time}
                        onChange={(event) => setTime(event.target.value)}
                        onBlur={() => {
                          const tidy = normaliseTime(time);
                          if (tidy !== null) setTime(tidy);
                        }}
                        aria-label="Time the build starts, 24-hour clock"
                        aria-invalid={time !== '' && normaliseTime(time) === null}
                      />
                    </div>
                  )}
                  <p className="field__hint">
                    {schedule
                      ? 'Your timezone, 24-hour clock. The PRD has to be marked ready by then, or the start is missed.'
                      : 'Leave off to start it by hand once the PRD is ready.'}
                  </p>
                </div>

                <div className="field">
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={codeReview ?? false}
                      onChange={(event) => setCodeReview(event.target.checked)}
                    />
                    Code review
                  </label>
                  <p className="field__hint">
                    The review runs automatically after the pull request is created and posts its comments to GitHub.
                  </p>
                </div>

                {error !== null && <Notice kind="error">{error}</Notice>}
                {stderr !== null && <pre className="output">{stderr}</pre>}

                <div className="field__actions">
                  <button type="submit" className="button button--primary" disabled={busy || blocked || trimmedName === ''}>
                    <Icon name="plus" />
                    {busy ? 'Creating and cloning…' : 'Create session'}
                  </button>
                  <Link className="button button--quiet" href="/sessions">
                    Cancel
                  </Link>
                </div>
              </>
            )}
          </div>
        </form>

        <Panel title="What happens next" icon="info" className="panel--aside">
          <ol className="steps steps--plain">
            <li className="step">
              <span className="step__marker">1</span>
              <div className="step__main">
                <span className="step__title">Clone</span>
                <span className="step__body">
                  A container starts and clones the repository with its deploy key, on a branch cut from the base.
                </span>
              </div>
            </li>
            <li className="step">
              <span className="step__marker">2</span>
              <div className="step__main">
                <span className="step__title">Plan</span>
                <span className="step__body">
                  You talk to Claude in a browser terminal until it has written a PRD of user stories.
                </span>
              </div>
            </li>
            <li className="step">
              <span className="step__marker">3</span>
              <div className="step__main">
                <span className="step__title">Build</span>
                <span className="step__body">
                  Mark it ready. One fresh agent per story, one commit per story, in priority order.
                </span>
              </div>
            </li>
            <li className="step">
              <span className="step__marker">4</span>
              <div className="step__main">
                <span className="step__title">Pull request</span>
                <span className="step__body">The branch is pushed and a pull request opened when the last story is done.</span>
              </div>
            </li>
          </ol>
        </Panel>
      </div>
    </div>
  );
}
