import { type FormEvent, useEffect, useState } from 'react';

import {
  createRecurringTask,
  type CronPreview,
  fetchRecurringTask,
  type PrTargetBranch,
  previewCron,
  type RecurringTask,
  type RecurringTaskInput,
  updateRecurringTask,
} from '../api.ts';
import { describeError, redirectIfUnauthorised, useAppData } from '../data.tsx';
import { Icon } from '../Icon.tsx';
import { editedRecurringTaskIdFromPath, Link, navigate, useLocation } from '../router.tsx';
import { localTime, nextRunIn } from '../schedule.ts';
import { useToast } from '../toast.tsx';
import { Notice, PageHeader, Panel, Skeleton } from '../ui.tsx';

/**
 * Creating and editing a recurring task (US-008).
 *
 * One component for both, because the two forms differ in exactly two places:
 * where the values come from and where they are sent. `/recurring-tasks/new`
 * starts empty; `/recurring-tasks/<id>/edit` loads the task first.
 *
 * The point of the page is the box under the cron input. Nothing here parses
 * cron — the server does, on every (debounced) keystroke, and answers with the
 * schedule in words and the next occurrence as an instant. That keeps one
 * authority on what an expression means (`server/src/lib/cron.ts`), and it is
 * also the validation: an expression the server will not describe is one the
 * scheduler could not fire, so the form refuses to submit it.
 */

/** Task names become run names and branches, so keep them to a slug. */
const TASK_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Kept in step with the server's `MAX_RECURRING_TASK_NAME_LENGTH`: a run is
 * named `<name>-YYYYMMDD-HHmm` and has to stay a legal session name.
 */
const MAX_TASK_NAME_LENGTH = 46;

/** Long enough that a typed expression settles, short enough to feel live. */
const PREVIEW_DEBOUNCE_MS = 250;

/**
 * A starting point rather than a menu: the three or four schedules an
 * unattended job actually wants, each of which is then edited by hand.
 */
const PRESETS: readonly { readonly label: string; readonly expression: string }[] = [
  { label: 'Daily at 03:00', expression: '0 3 * * *' },
  { label: 'Every Monday at 03:00', expression: '0 3 * * 1' },
  { label: 'Weekdays at 09:00', expression: '0 9 * * 1-5' },
  { label: 'Hourly', expression: '0 * * * *' },
];

export function RecurringTaskForm() {
  const { pathname } = useLocation();
  const taskId = editedRecurringTaskIdFromPath(pathname);
  const editing = taskId !== null;

  const { repositories } = useAppData();
  const toast = useToast();
  const usable = (repositories ?? []).filter((repository) => repository.keyConfigured);

  const [repositoryId, setRepositoryId] = useState('');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [cronExpression, setCronExpression] = useState('0 3 * * *');
  const [baseBranch, setBaseBranch] = useState('');
  const [prTarget, setPrTarget] = useState<PrTargetBranch>('main');
  const [runCodeReview, setRunCodeReview] = useState(false);

  /** The task being edited, once it has loaded; null while creating. */
  const [task, setTask] = useState<RecurringTask | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [preview, setPreview] = useState<CronPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Editing starts from what is stored, including the base branch the create
  // defaulted — a task always has one, so nothing is inferred here.
  useEffect(() => {
    if (taskId === null) return;
    const controller = new AbortController();
    fetchRecurringTask(taskId, controller.signal)
      .then((loaded) => {
        setTask(loaded);
        setRepositoryId(loaded.repositoryId);
        setName(loaded.name);
        setPrompt(loaded.prompt);
        setCronExpression(loaded.cronExpression);
        setBaseBranch(loaded.baseBranch);
        setPrTarget(loaded.prTarget);
        setRunCodeReview(loaded.runCodeReview);
        setLoadError(null);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (redirectIfUnauthorised(cause)) return;
        setLoadError(describeError(cause));
      });
    return () => controller.abort();
  }, [taskId]);

  // The live description. Debounced so a typed expression is one request
  // rather than one per character, and aborted on the next keystroke so a slow
  // answer can never overwrite a newer one.
  const typedCron = cronExpression.trim();
  useEffect(() => {
    if (typedCron === '') {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      previewCron(typedCron, controller.signal)
        .then((result) => {
          setPreview(result);
          setPreviewError(null);
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          if (redirectIfUnauthorised(cause)) return;
          setPreview(null);
          setPreviewError(describeError(cause));
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [typedCron]);

  // A preview is only about the expression it echoes back: while the debounce
  // is still pending, the box holds the *previous* answer, and submitting on
  // it would store a schedule nobody has seen judged.
  const current = preview !== null && preview.expression === typedCron ? preview : null;
  const scheduleReady = current !== null && current.valid;
  const scheduleRejected = current !== null && !current.valid;

  const trimmedName = name.trim();
  const selected =
    usable.find((repository) => repository.id === repositoryId) ?? (editing ? null : usable[0]);
  const effectiveBase =
    baseBranch === '' ? (editing ? '' : (selected?.defaultBaseBranch ?? 'main')) : baseBranch;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setError(null);
    if (trimmedName.length > MAX_TASK_NAME_LENGTH) {
      setError(
        `The name must be at most ${String(MAX_TASK_NAME_LENGTH)} characters — every run is named "${trimmedName}-YYYYMMDD-HHmm" and has to stay a legal session name.`,
      );
      return;
    }
    if (!TASK_NAME_PATTERN.test(trimmedName)) {
      setError('The name may only contain letters, numbers, hyphens and underscores.');
      return;
    }
    if (prompt.trim() === '') {
      setError('Write the prompt each run is given.');
      return;
    }
    if (!scheduleReady) {
      setError(current?.message ?? 'Give the task a schedule chief-web can read.');
      return;
    }
    if (!editing && (selected === null || selected === undefined)) {
      setError('Choose a repository.');
      return;
    }

    setBusy(true);
    const fields = {
      name: trimmedName,
      prompt: prompt.trim(),
      cronExpression: typedCron,
      prTarget,
      runCodeReview,
      ...(effectiveBase.trim() === '' ? {} : { baseBranch: effectiveBase.trim() }),
    };

    const update: RecurringTaskInput = fields;
    const saved: Promise<RecurringTask> =
      taskId === null
        ? createRecurringTask({ ...fields, repositoryId: selected?.id ?? '' })
        : updateRecurringTask(taskId, update);

    saved
      .then((result) => {
        toast.ok(
          editing
            ? `Saved ${result.name}.`
            : `Created ${result.name}. ${
                result.nextRunAt === null
                  ? 'It is paused.'
                  : `First run ${nextRunIn(result.nextRunAt)}.`
              }`,
        );
        navigate('/recurring-tasks');
      })
      .catch((cause: unknown) => setError(describeError(cause)))
      .finally(() => setBusy(false));
  };

  const loading = editing && task === null && loadError === null;

  return (
    <div className="page page--narrow">
      <PageHeader
        back={{ href: '/recurring-tasks', label: 'Recurring tasks' }}
        title={editing ? `Edit ${task?.name ?? 'task'}` : 'New recurring task'}
        subtitle="A prompt and a schedule. Every occurrence gets a fresh session, container and branch, and opens a pull request only when the run produced commits."
      />

      {loadError !== null && (
        <Notice kind="error">Could not read this recurring task: {loadError}</Notice>
      )}

      <div className="grid grid--form">
        <form className="panel" onSubmit={submit}>
          <div className="panel__body form">
            {loading || repositories === null ? (
              <Skeleton lines={6} />
            ) : !editing && usable.length === 0 ? (
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
                  <label className="field__label" htmlFor="task-repository">
                    Repository
                  </label>
                  <select
                    id="task-repository"
                    className="field__input"
                    value={selected?.id ?? repositoryId}
                    disabled={editing}
                    onChange={(event) => {
                      setRepositoryId(event.target.value);
                      setBaseBranch('');
                    }}
                    aria-describedby={editing ? 'task-repository-hint' : undefined}
                  >
                    {editing && selected === null && (
                      <option value={repositoryId}>
                        {task?.repositoryName ?? 'unknown repository'}
                      </option>
                    )}
                    {usable.map((repository) => (
                      <option key={repository.id} value={repository.id}>
                        {repository.name} · {repository.githubSlug}
                      </option>
                    ))}
                  </select>
                  {editing && (
                    <p className="field__hint" id="task-repository-hint">
                      A task stays with the repository it was created for. Create a second task to
                      run the same prompt elsewhere.
                    </p>
                  )}
                </div>

                <div className="field">
                  <label className="field__label" htmlFor="task-name">
                    Name
                  </label>
                  <input
                    id="task-name"
                    className="field__input"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="nightly-rector"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={MAX_TASK_NAME_LENGTH}
                    autoFocus
                    aria-describedby="task-name-hint"
                    aria-invalid={trimmedName !== '' && !TASK_NAME_PATTERN.test(trimmedName)}
                  />
                  <p className="field__hint" id="task-name-hint">
                    Letters, numbers, hyphens and underscores, at most{' '}
                    {String(MAX_TASK_NAME_LENGTH)} characters. Each run is a session named{' '}
                    <code className="mono">
                      {trimmedName === '' ? '<name>' : trimmedName}-YYYYMMDD-HHmm
                    </code>
                    .
                  </p>
                </div>

                <div className="field">
                  <label className="field__label" htmlFor="task-prompt">
                    Prompt
                  </label>
                  <textarea
                    id="task-prompt"
                    className="field__input field__textarea"
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    rows={5}
                    placeholder="run rector and fix what it reports"
                    aria-describedby="task-prompt-hint"
                  />
                  <p className="field__hint" id="task-prompt-hint">
                    What the agent is asked to do, every time. It becomes a one-story PRD, so write
                    it as an instruction rather than as a plan.
                  </p>
                </div>

                <div className="field">
                  <label className="field__label" htmlFor="task-cron">
                    Schedule
                  </label>
                  <input
                    id="task-cron"
                    className="field__input mono"
                    value={cronExpression}
                    onChange={(event) => setCronExpression(event.target.value)}
                    placeholder="0 3 * * *"
                    autoComplete="off"
                    spellCheck={false}
                    aria-describedby="task-cron-preview"
                    aria-invalid={scheduleRejected}
                  />
                  <div className="field__pair" role="group" aria-label="Schedule presets">
                    {PRESETS.map((preset) => (
                      <button
                        key={preset.expression}
                        type="button"
                        className="button button--quiet button--small"
                        onClick={() => setCronExpression(preset.expression)}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                  <SchedulePreview
                    expression={typedCron}
                    preview={current}
                    error={previewError}
                  />
                </div>

                <div className="field__row">
                  <div className="field">
                    <label className="field__label" htmlFor="task-base-branch">
                      Base branch
                    </label>
                    <input
                      id="task-base-branch"
                      className="field__input"
                      value={effectiveBase}
                      onChange={(event) => setBaseBranch(event.target.value)}
                      placeholder="main"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <p className="field__hint">Each run's branch is cut from this.</p>
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor="task-pr-target">
                      Pull request into
                    </label>
                    <select
                      id="task-pr-target"
                      className="field__input"
                      value={prTarget}
                      onChange={(event) => setPrTarget(event.target.value as PrTargetBranch)}
                    >
                      <option value="main">main</option>
                      <option value="develop">develop</option>
                    </select>
                    <p className="field__hint">Only opened when the run produced commits.</p>
                  </div>
                </div>

                <div className="field">
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={runCodeReview}
                      onChange={(event) => setRunCodeReview(event.target.checked)}
                    />
                    Code review
                  </label>
                  <p className="field__hint">
                    Every pull request this task opens is reviewed automatically, with the comments
                    posted to GitHub.
                  </p>
                </div>

                {error !== null && <Notice kind="error">{error}</Notice>}

                <div className="field__actions">
                  <button
                    type="submit"
                    className="button button--primary"
                    disabled={busy || trimmedName === '' || prompt.trim() === '' || !scheduleReady}
                  >
                    <Icon name={editing ? 'check' : 'plus'} />
                    {busy
                      ? editing
                        ? 'Saving…'
                        : 'Creating…'
                      : editing
                        ? 'Save task'
                        : 'Create task'}
                  </button>
                  <Link className="button button--quiet" href="/recurring-tasks">
                    Cancel
                  </Link>
                </div>
              </>
            )}
          </div>
        </form>

        <Panel title="How a run works" icon="info" className="panel--aside">
          <ol className="steps steps--plain">
            <li className="step">
              <span className="step__marker">1</span>
              <div className="step__main">
                <span className="step__title">Fire</span>
                <span className="step__body">
                  On each occurrence chief-web starts an ordinary session — its own container, clone
                  and branch — named after the task and the minute it fired.
                </span>
              </div>
            </li>
            <li className="step">
              <span className="step__marker">2</span>
              <div className="step__main">
                <span className="step__title">Build</span>
                <span className="step__body">
                  The prompt becomes a one-story PRD and the usual build loop runs it, with nobody
                  watching.
                </span>
              </div>
            </li>
            <li className="step">
              <span className="step__marker">3</span>
              <div className="step__main">
                <span className="step__title">Deliver</span>
                <span className="step__body">
                  Commits become a pull request; a run that changed nothing finishes clean, with no
                  branch pushed and no pull request opened.
                </span>
              </div>
            </li>
            <li className="step">
              <span className="step__marker">4</span>
              <div className="step__main">
                <span className="step__title">Skip</span>
                <span className="step__body">
                  While the previous run is still building or its pull request is still open, the
                  occurrence is skipped rather than stacking a second one on top.
                </span>
              </div>
            </li>
          </ol>
        </Panel>
      </div>
    </div>
  );
}

/**
 * What the expression in the box means, under the box.
 *
 * Three states and no fourth: nothing typed, the server's rejection, or the
 * schedule in words with the next occurrence on the visitor's own clock. While
 * a keystroke is still settling the last answer stays put — a box that blanked
 * between characters would be harder to read than cron.
 */
function SchedulePreview({
  expression,
  preview,
  error,
}: {
  readonly expression: string;
  readonly preview: CronPreview | null;
  readonly error: string | null;
}) {
  if (error !== null) {
    return (
      <p className="field__hint" role="status" id="task-cron-preview">
        The schedule could not be checked: {error}
      </p>
    );
  }
  if (expression === '') {
    return (
      <p className="field__hint" id="task-cron-preview">
        Five fields — minute, hour, day of month, month, day of week — read in the server's
        timezone. Pick a preset above to start from.
      </p>
    );
  }
  if (preview === null) {
    return (
      <p className="field__hint" role="status" id="task-cron-preview">
        Checking…
      </p>
    );
  }
  if (!preview.valid) {
    return (
      <p className="field__hint text-danger" role="alert" id="task-cron-preview">
        <Icon name="alert" /> {preview.message ?? 'That is not a schedule chief-web can read.'}
      </p>
    );
  }
  return (
    <p className="field__hint" role="status" id="task-cron-preview">
      <strong>{preview.description}</strong>
      {preview.nextRunAt !== null && (
        <>
          {' — next run '}
          {localTime(preview.nextRunAt)} ({nextRunIn(preview.nextRunAt)}), your time.
        </>
      )}
    </p>
  );
}
