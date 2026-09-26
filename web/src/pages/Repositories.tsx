import { type FormEvent, type KeyboardEvent, useEffect, useState } from 'react';

import {
  type ConnectionTestResult,
  createRepository,
  createRepositoryLogin,
  deleteRepository,
  deleteRepositoryLogin,
  fetchRepositoryLogins,
  type Repository,
  type RepositoryInput,
  type RepositoryLogin,
  testRepositoryConnection,
  updateRepository,
} from '../api.ts';
import { type TextRun } from '../comment.ts';
import { ConfirmDialog } from '../ConfirmDialog.tsx';
import { describeError, useAppData } from '../data.tsx';
import { Icon } from '../Icon.tsx';
import { type MarkdownBlock, parseMarkdown } from '../markdown.ts';
import { Link } from '../router.tsx';
import { useToast } from '../toast.tsx';
import { Badge, EmptyState, Notice, PageHeader, Panel, Segmented, Skeleton } from '../ui.tsx';
import { MAX_CREDENTIAL_CHARS, parseBrowserUrl } from '../voice/protocol.ts';

type TestState = { status: 'running' } | ({ status: 'done' } & ConnectionTestResult);

/**
 * Best-effort `owner/repo` preview, mirroring the server's derivation. It only
 * drives the placeholder — leaving the slug field empty makes the server derive
 * the real value, so the two can never disagree in the stored record.
 */
function deriveSlugPreview(raw: string): string | null {
  let value = raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  value = value.replace(/^[^@/:]+@/, '');
  const separator = value.search(/[:/]/);
  if (separator === -1) return null;
  let repoPath = value.slice(separator + 1);
  if (repoPath.toLowerCase().endsWith('.git')) repoPath = repoPath.slice(0, -'.git'.length);
  const segments = repoPath.split('/').filter((segment) => segment !== '');
  return segments.length === 2 ? segments.join('/') : null;
}

/** Mirrors `isValidSentrySlug` on the server, so the form catches a typo first. */
const SENTRY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Mirrors `MAX_REVIEW_CONTEXT_LENGTH` in `routes/repositories.ts` (US-003). */
const MAX_REVIEW_CONTEXT_LENGTH = 10_000;

/** Mirrors `MAX_LOGIN_LABEL_LENGTH` in `repositories/logins.ts` (voice feedback US-010). */
const MAX_LOGIN_LABEL_LENGTH = 100;

/**
 * Repository management (US-005): register a git remote, get an ed25519 deploy
 * key to paste into GitHub, and prove the key works with `git ls-remote`.
 */
export function Repositories() {
  const { repositories, sessions, stats, refresh } = useAppData();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<Repository | null>(null);
  /** The repository added in this visit — its deploy key needs attention now. */
  const [addedId, setAddedId] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});

  const onCreate = (input: RepositoryInput): void => {
    setSaving(true);
    createRepository(input)
      .then(async (created) => {
        await refresh();
        setAdding(false);
        setAddedId(created.id);
        toast.ok(
          created.keySource === 'generated'
            ? `Added ${created.name}. Add its deploy key to GitHub with write access.`
            : `Added ${created.name} with the key you provided.`,
        );
      })
      .catch((error: unknown) => toast.error(describeError(error)))
      .finally(() => setSaving(false));
  };

  const onUpdate = (id: string, input: RepositoryInput): void => {
    setSaving(true);
    updateRepository(id, input)
      .then(async () => {
        await refresh();
        setEditingId(null);
        toast.ok('Repository saved.');
      })
      .catch((error: unknown) => toast.error(describeError(error)))
      .finally(() => setSaving(false));
  };

  const onDelete = (): void => {
    if (deleting === null) return;
    const repository = deleting;
    setDeleting(null);
    deleteRepository(repository.id)
      .then(async () => {
        await refresh();
        toast.ok(`Deleted ${repository.name}.`);
      })
      .catch((error: unknown) => toast.error(describeError(error)));
  };

  const onTest = (repository: Repository): void => {
    setTests((current) => ({ ...current, [repository.id]: { status: 'running' } }));
    testRepositoryConnection(repository.id)
      .then((result) => setTests((current) => ({ ...current, [repository.id]: { status: 'done', ...result } })))
      .catch((error: unknown) =>
        setTests((current) => ({ ...current, [repository.id]: { status: 'done', ok: false, message: describeError(error), stderr: '' } })),
      );
  };

  const sessionCount = (id: string): number => (sessions ?? []).filter((session) => session.repositoryId === id).length;
  const repoStats = (id: string) => stats?.repositories.find((r) => r.repositoryId === id) ?? null;

  return (
    <div className="page">
      <PageHeader
        title="Repositories"
        subtitle="Each gets its own deploy key. Session containers clone, fetch and push with it; the private half never leaves the server."
        actions={
          !adding && (
            <button type="button" className="button button--primary" onClick={() => setAdding(true)}>
              <Icon name="plus" />
              Add repository
            </button>
          )
        }
      />

      {adding && <RepositoryForm mode="create" busy={saving} onSubmit={onCreate} onCancel={() => setAdding(false)} />}

      {repositories === null ? (
        <div className="panel">
          <div className="panel__body">
            <Skeleton lines={4} />
          </div>
        </div>
      ) : repositories.length === 0 && !adding ? (
        <EmptyState
          icon="repo"
          title="No repositories yet"
          action={
            <button type="button" className="button button--primary" onClick={() => setAdding(true)}>
              <Icon name="plus" />
              Add the first one
            </button>
          }
        >
          Register a GitHub repository by its SSH URL. chief-web generates a deploy key for it and shows you the public half to
          paste into GitHub.
        </EmptyState>
      ) : (
        <div className="stack">
          {repositories.map((repository) =>
            editingId === repository.id ? (
              <RepositoryForm
                key={repository.id}
                mode="edit"
                initial={repository}
                busy={saving}
                onSubmit={(input) => onUpdate(repository.id, input)}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <Panel
                key={repository.id}
                title={repository.name}
                icon="repo"
                meta={
                  <>
                    {repository.keyConfigured ? (
                      <Badge tone="done">key stored</Badge>
                    ) : (
                      <Badge tone="danger">no key</Badge>
                    )}
                    {repository.sentryOrg !== null && repository.sentryProject !== null && (
                      <Badge tone="review" title={`Sentry: ${repository.sentryOrg}/${repository.sentryProject}`}>
                        <Icon name="alert" />
                        Sentry
                      </Badge>
                    )}
                  </>
                }
                actions={
                  <>
                    <button
                      type="button"
                      className="button button--small"
                      onClick={() => onTest(repository)}
                      disabled={tests[repository.id]?.status === 'running' || !repository.keyConfigured}
                    >
                      <Icon name="pulse" />
                      {tests[repository.id]?.status === 'running' ? 'Testing…' : 'Test connection'}
                    </button>
                    <button type="button" className="button button--small button--quiet" onClick={() => setEditingId(repository.id)}>
                      <Icon name="pencil" />
                      Edit
                    </button>
                    <button
                      type="button"
                      className="button button--small button--quiet button--danger button--icon"
                      onClick={() => setDeleting(repository)}
                      aria-label={`Delete ${repository.name}`}
                      title="Delete"
                    >
                      <Icon name="trash" />
                    </button>
                  </>
                }
              >
                <div className="repo-facts">
                  <span className="repo-fact">
                    <Icon name="link-external" />
                    <a className="link mono" href={`https://github.com/${repository.githubSlug}`} target="_blank" rel="noreferrer">
                      {repository.githubSlug}
                    </a>
                  </span>
                  <span className="repo-fact mono">
                    <Icon name="git-branch" />
                    {repository.defaultBaseBranch}
                  </span>
                  <span className="repo-fact mono" title={repository.sshUrl}>
                    <Icon name="terminal" />
                    {repository.sshUrl}
                  </span>
                  <span className="repo-fact mono" title={repository.keySource === null ? undefined : `${repository.keySource} key`}>
                    <Icon name="key" />
                    {repository.keyConfigured ? (repository.keyFingerprint ?? 'stored') : 'missing — edit and paste a private key'}
                  </span>
                  <span className="repo-fact">
                    <Icon name="rocket" />
                    <Link className="link" href={`/sessions?repository=${encodeURIComponent(repository.id)}`}>
                      {sessionCount(repository.id)} {sessionCount(repository.id) === 1 ? 'session' : 'sessions'}
                    </Link>
                    {repoStats(repository.id) !== null && (
                      <span className="muted">
                        {' '}
                        · {repoStats(repository.id)?.storiesDone} stories shipped
                      </span>
                    )}
                  </span>
                </div>

                <DeployKey repository={repository} highlight={addedId === repository.id} />
                <TestResult state={tests[repository.id]} />
              </Panel>
            ),
          )}
        </div>
      )}

      <ConfirmDialog
        open={deleting !== null}
        title={deleting === null ? '' : `Delete ${deleting.name}?`}
        confirmLabel="Delete repository"
        danger
        onConfirm={onDelete}
        onCancel={() => setDeleting(null)}
      >
        <p>The repository and its SSH key are removed from this server. Nothing on GitHub changes; remove the deploy key there yourself.</p>
        {deleting !== null && sessionCount(deleting.id) > 0 && (
          <p>
            <strong>
              It has {sessionCount(deleting.id)} {sessionCount(deleting.id) === 1 ? 'session' : 'sessions'}.
            </strong>{' '}
            The server refuses to delete a repository that still has sessions; delete them first.
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}

function TestResult({ state }: { readonly state: TestState | undefined }) {
  if (state === undefined || state.status === 'running') return null;
  return (
    <div className="stack stack--tight">
      <Notice kind={state.ok ? 'ok' : 'error'}>{state.message}</Notice>
      {state.stderr !== '' && <pre className="output">{state.stderr}</pre>}
    </div>
  );
}

function DeployKey({ repository, highlight }: { readonly repository: Repository; readonly highlight: boolean }) {
  if (repository.publicKey === null) {
    return (
      <p className="field__hint">
        The public half of this key is not stored: it was imported from a PEM private key. Use the public key you already have on
        GitHub.
      </p>
    );
  }
  return (
    <details className="disclosure" open={highlight}>
      <summary className="disclosure__summary">
        <Icon name="chevron-right" />
        Deploy key
      </summary>
      <div className="disclosure__body">
        <p className="field__hint">
          Add this as a deploy key on{' '}
          <a className="link" href={`https://github.com/${repository.githubSlug}/settings/keys/new`} target="_blank" rel="noreferrer">
            github.com/{repository.githubSlug}
          </a>{' '}
          and tick <strong>Allow write access</strong>: sessions push their feature branch with it.
        </p>
        <pre className="output output--wrap">{repository.publicKey}</pre>
        <CopyButton value={repository.publicKey} />
      </div>
    </details>
  );
}

function CopyButton({ value }: { readonly value: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = (): void => {
    navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => setCopied(false));
  };
  return (
    <button type="button" className="button button--small" onClick={onCopy}>
      <Icon name={copied ? 'check' : 'copy'} />
      {copied ? 'Copied' : 'Copy public key'}
    </button>
  );
}

function RepositoryForm({
  mode,
  initial,
  busy,
  onSubmit,
  onCancel,
}: {
  readonly mode: 'create' | 'edit';
  readonly initial?: Repository;
  readonly busy: boolean;
  readonly onSubmit: (input: RepositoryInput) => void;
  readonly onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [sshUrl, setSshUrl] = useState(initial?.sshUrl ?? '');
  const [githubSlug, setGithubSlug] = useState(initial?.githubSlug ?? '');
  const [baseBranch, setBaseBranch] = useState(initial?.defaultBaseBranch ?? 'main');
  const [sentryOrg, setSentryOrg] = useState(initial?.sentryOrg ?? '');
  const [sentryProject, setSentryProject] = useState(initial?.sentryProject ?? '');
  const [reviewContext, setReviewContext] = useState(initial?.reviewContext ?? '');
  const [contextView, setContextView] = useState<'write' | 'preview'>('write');
  const [keyMode, setKeyMode] = useState<'generate' | 'paste'>('generate');
  const [privateKey, setPrivateKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const derived = deriveSlugPreview(sshUrl);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setError(null);
    if (name.trim() === '' || sshUrl.trim() === '') {
      setError('Name and SSH URL are required.');
      return;
    }
    if (keyMode === 'paste' && privateKey.trim() === '') {
      setError('Paste a private key, or switch back to generating one.');
      return;
    }
    const org = sentryOrg.trim();
    const project = sentryProject.trim();
    if ((org === '') !== (project === '')) {
      setError('A Sentry link needs both an org slug and a project slug. Fill in both, or clear both to unlink.');
      return;
    }
    if ((org !== '' && !SENTRY_SLUG_PATTERN.test(org)) || (project !== '' && !SENTRY_SLUG_PATTERN.test(project))) {
      setError('Sentry slugs are lowercase letters, digits and hyphens, exactly as they appear in the Sentry URL.');
      return;
    }
    // The server trims before measuring, so the count the form checks and the
    // one it rejects on are the same number.
    const context = reviewContext.trim();
    if (context.length > MAX_REVIEW_CONTEXT_LENGTH) {
      setError(
        `The review context is ${context.length.toLocaleString()} characters; the limit is ${MAX_REVIEW_CONTEXT_LENGTH.toLocaleString()}.`,
      );
      return;
    }
    const input: RepositoryInput = {
      name: name.trim(),
      sshUrl: sshUrl.trim(),
      defaultBaseBranch: baseBranch.trim() === '' ? 'main' : baseBranch.trim(),
      // Always sent, so emptying a field unlinks instead of being ignored.
      sentryOrg: org === '' ? null : org,
      sentryProject: project === '' ? null : project,
      reviewContext: context === '' ? null : context,
    };
    if (githubSlug.trim() !== '') input.githubSlug = githubSlug.trim();
    if (keyMode === 'paste') input.privateKey = privateKey;
    onSubmit(input);
  };

  return (
    <form className="panel" onSubmit={submit}>
      <header className="panel__header">
        <h2 className="panel__title">
          <Icon name={mode === 'create' ? 'plus' : 'pencil'} />
          {mode === 'create' ? 'Add repository' : `Edit ${initial?.name ?? ''}`}
        </h2>
      </header>
      <div className="panel__body form">
        <div className="field__row">
          <div className="field">
            <label className="field__label" htmlFor={`name-${mode}`}>
              Name
            </label>
            <input id={`name-${mode}`} className="field__input" value={name} onChange={(event) => setName(event.target.value)} placeholder="my-app" autoComplete="off" autoFocus />
            <p className="field__hint">How it appears in chief-web.</p>
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`branch-${mode}`}>
              Default base branch
            </label>
            <input id={`branch-${mode}`} className="field__input" value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)} placeholder="main" autoComplete="off" spellCheck={false} />
            <p className="field__hint">What new sessions branch from.</p>
          </div>
        </div>

        <div className="field">
          <label className="field__label" htmlFor={`ssh-url-${mode}`}>
            SSH URL
          </label>
          <input id={`ssh-url-${mode}`} className="field__input mono" value={sshUrl} onChange={(event) => setSshUrl(event.target.value)} placeholder="git@github.com:owner/repo.git" autoComplete="off" spellCheck={false} />
          <p className="field__hint">SSH, not HTTPS: the deploy key is what authenticates.</p>
        </div>

        <div className="field">
          <label className="field__label" htmlFor={`slug-${mode}`}>
            GitHub slug
          </label>
          <input id={`slug-${mode}`} className="field__input mono" value={githubSlug} onChange={(event) => setGithubSlug(event.target.value)} placeholder={derived ?? 'owner/repo'} autoComplete="off" spellCheck={false} />
          <p className="field__hint">Used to open pull requests. Leave blank to derive it from the URL{derived === null ? '.' : ` (${derived}).`}</p>
        </div>

        <div className="field__row">
          <div className="field">
            <label className="field__label" htmlFor={`sentry-org-${mode}`}>
              Sentry org slug <span className="muted">(optional)</span>
            </label>
            <input
              id={`sentry-org-${mode}`}
              className="field__input mono"
              value={sentryOrg}
              onChange={(event) => setSentryOrg(event.target.value)}
              placeholder="my-org"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`sentry-project-${mode}`}>
              Sentry project slug <span className="muted">(optional)</span>
            </label>
            <input
              id={`sentry-project-${mode}`}
              className="field__input mono"
              value={sentryProject}
              onChange={(event) => setSentryProject(event.target.value)}
              placeholder="my-app"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </div>
        <p className="field__hint">
          Set both to have chief-web poll this Sentry project for issues to fix; clear both to unlink. They are the two slugs in a
          Sentry URL: <span className="mono">sentry.io/organizations/&lt;org&gt;/projects/&lt;project&gt;</span>.
        </p>

        <div className="field">
          <div className="field__head">
            <label className="field__label" htmlFor={`review-context-${mode}`}>
              Code review context <span className="muted">(optional)</span>
            </label>
            <Segmented
              value={contextView}
              options={[
                { value: 'write', label: 'Write' },
                { value: 'preview', label: 'Preview' },
              ]}
              onChange={setContextView}
              ariaLabel="Review context view"
            />
          </div>
          {contextView === 'write' ? (
            <textarea
              id={`review-context-${mode}`}
              className="field__input field__textarea"
              value={reviewContext}
              onChange={(event) => setReviewContext(event.target.value)}
              placeholder={'## Conventions\n- Money is handled in cents; flag float arithmetic.\n- `app/Legacy` is being retired — do not review it.'}
              rows={8}
              spellCheck={false}
            />
          ) : (
            <MarkdownPreview text={reviewContext} />
          )}
          <p className="field__hint">
            Added to the AI code review prompt for this repository, so reviews know its conventions and the places to look hard at.
            Markdown, up to {MAX_REVIEW_CONTEXT_LENGTH.toLocaleString()} characters
            {reviewContext.trim() === '' ? '' : ` (${reviewContext.trim().length.toLocaleString()} used)`}. Leave it empty to
            review with the standard prompt.
          </p>
        </div>

        <div className="field">
          <span className="field__label">SSH key</span>
          <label className="radio">
            <input type="radio" name={`key-mode-${mode}`} checked={keyMode === 'generate'} onChange={() => setKeyMode('generate')} />
            {mode === 'create' ? 'Generate a new ed25519 keypair' : 'Keep the stored key'}
          </label>
          <label className="radio">
            <input type="radio" name={`key-mode-${mode}`} checked={keyMode === 'paste'} onChange={() => setKeyMode('paste')} />
            Paste an existing private key
          </label>
          {keyMode === 'paste' && (
            <textarea
              className="field__input field__textarea"
              value={privateKey}
              onChange={(event) => setPrivateKey(event.target.value)}
              placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n…'}
              rows={6}
              spellCheck={false}
              aria-label="Private key"
            />
          )}
          <p className="field__hint">
            {mode === 'create'
              ? 'The public half is shown after saving, to add as a GitHub deploy key. A pasted key must be unencrypted.'
              : 'The stored key is kept unless you paste a replacement.'}
          </p>
        </div>

        {mode === 'edit' && initial !== undefined && <SavedLogins repository={initial} />}

        {error !== null && <Notice kind="error">{error}</Notice>}

        <div className="field__actions">
          <button type="submit" className="button button--primary" disabled={busy}>
            {busy ? 'Saving…' : mode === 'create' ? 'Add repository' : 'Save'}
          </button>
          <button type="button" className="button button--quiet" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </form>
  );
}

/** The host of a saved login's URL, for the list; the stored URL itself if it no longer parses. */
function loginHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * A repository's saved logins (voice feedback US-010), offered by the "watch
 * with me" card of a session on it. Lives inside the editor's `<form>`, so it
 * uses plain inputs and buttons: Enter adds a login rather than saving the
 * repository.
 */
function SavedLogins({ repository }: { readonly repository: Repository }) {
  const toast = useToast();
  const [logins, setLogins] = useState<RepositoryLogin[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<RepositoryLogin | null>(null);
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchRepositoryLogins(repository.id, controller.signal)
      .then(setLogins)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setLoadError(describeError(cause));
      });
    return () => controller.abort();
  }, [repository.id]);

  const add = (): void => {
    setError(null);
    const parsedUrl = parseBrowserUrl(url);
    if (parsedUrl === null) {
      setError('Enter a full http:// or https:// address.');
      return;
    }
    if (password === '') {
      setError('A saved login needs a password.');
      return;
    }
    if (label.trim().length > MAX_LOGIN_LABEL_LENGTH) {
      setError(`The label must be at most ${MAX_LOGIN_LABEL_LENGTH} characters.`);
      return;
    }
    setAdding(true);
    createRepositoryLogin(repository.id, {
      url: parsedUrl,
      username: username.trim(),
      password,
      ...(label.trim() === '' ? {} : { label: label.trim() }),
    })
      .then((login) => {
        setLogins((current) => [...(current ?? []), login]);
        setLabel('');
        setUrl('');
        setUsername('');
        setPassword('');
        toast.ok(`Saved the login ${login.label}.`);
      })
      .catch((cause: unknown) => setError(describeError(cause)))
      .finally(() => setAdding(false));
  };

  const onDelete = (): void => {
    if (deleting === null) return;
    const login = deleting;
    setDeleting(null);
    deleteRepositoryLogin(repository.id, login.id)
      .then(() => {
        setLogins((current) => (current ?? []).filter((saved) => saved.id !== login.id));
        toast.ok(`Deleted the login ${login.label}.`);
      })
      .catch((cause: unknown) => toast.error(describeError(cause)));
  };

  const addOnEnter = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (!adding) add();
  };

  return (
    <div className="field">
      <span className="field__label">Saved logins</span>
      {loadError !== null ? (
        <Notice kind="error">{loadError}</Notice>
      ) : logins === null ? (
        <Skeleton lines={2} />
      ) : logins.length === 0 ? (
        <p className="field__hint">None yet. A session on this repository can pick a saved login when it opens a page with you.</p>
      ) : (
        <ul className="rows rows--tight">
          {logins.map((login) => (
            <li className="row" key={login.id}>
              <div className="row__main">
                <span>{login.label}</span>
                <span className="row__meta mono">
                  {loginHost(login.url)}
                  {login.username === '' ? '' : ` · ${login.username}`}
                </span>
              </div>
              <div className="row__actions">
                <button
                  type="button"
                  className="button button--small button--quiet button--danger button--icon"
                  onClick={() => setDeleting(login)}
                  aria-label={`Delete the login ${login.label}`}
                  title="Delete"
                >
                  <Icon name="trash" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="field__row">
        <input
          className="field__input mono"
          type="text"
          inputMode="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={addOnEnter}
          placeholder="http://host.docker.internal:3000/login"
          aria-label="Login URL"
          autoComplete="off"
          spellCheck={false}
        />
        <input
          className="field__input"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          onKeyDown={addOnEnter}
          placeholder="Label (optional)"
          aria-label="Login label"
          maxLength={MAX_LOGIN_LABEL_LENGTH}
          autoComplete="off"
        />
      </div>
      <div className="field__pair">
        <input
          className="field__input"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          onKeyDown={addOnEnter}
          placeholder="Username"
          aria-label="Login username"
          maxLength={MAX_CREDENTIAL_CHARS}
          autoComplete="off"
        />
        <input
          className="field__input"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          onKeyDown={addOnEnter}
          placeholder="Password"
          aria-label="Login password"
          maxLength={MAX_CREDENTIAL_CHARS}
          autoComplete="new-password"
        />
        <button type="button" className="button button--small" onClick={add} disabled={adding}>
          <Icon name="plus" />
          {adding ? 'Adding…' : 'Add login'}
        </button>
      </div>
      {error !== null && <p className="field__error">{error}</p>}
      <p className="field__hint">
        Stored in plain text on this server, like the GitHub token, and never shown again. The label defaults to the host plus the
        username.
      </p>

      <ConfirmDialog
        open={deleting !== null}
        title={deleting === null ? '' : `Delete the login ${deleting.label}?`}
        confirmLabel="Delete login"
        danger
        onConfirm={onDelete}
        onCancel={() => setDeleting(null)}
      >
        <p>Sessions on {repository.name} will no longer offer it. Nothing changes on the site itself.</p>
      </ConfirmDialog>
    </div>
  );
}

/**
 * The review context as the reader of a review prompt would see it. Empty text
 * gets a line saying so rather than a blank box, which reads as broken.
 */
function MarkdownPreview({ text }: { readonly text: string }) {
  const blocks: MarkdownBlock[] = parseMarkdown(text);
  if (blocks.length === 0) return <p className="markdown markdown--empty">Nothing to preview yet.</p>;
  return (
    <div className="markdown">
      {blocks.map((block, index) => {
        if (block.kind === 'code') {
          return (
            <pre className="output output--wrap" key={index}>
              {block.text}
            </pre>
          );
        }
        if (block.kind === 'list') {
          const items = block.items.map((runs, itemIndex) => <li key={itemIndex}>{renderRuns(runs)}</li>);
          return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
        }
        if (block.kind === 'heading') {
          const Heading = `h${String(block.level)}` as 'h1' | 'h2' | 'h3';
          return <Heading key={index}>{renderRuns(block.runs)}</Heading>;
        }
        return <p key={index}>{renderRuns(block.runs)}</p>;
      })}
    </div>
  );
}

function renderRuns(runs: readonly TextRun[]) {
  return runs.map((run, index) =>
    run.code ? (
      <code className="mono" key={index}>
        {run.text}
      </code>
    ) : (
      <span key={index}>{run.text}</span>
    ),
  );
}
