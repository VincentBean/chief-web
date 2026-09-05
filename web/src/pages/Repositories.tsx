import { type FormEvent, useState } from 'react';

import {
  type ConnectionTestResult,
  createRepository,
  deleteRepository,
  type Repository,
  type RepositoryInput,
  testRepositoryConnection,
  updateRepository,
} from '../api.ts';
import { ConfirmDialog } from '../ConfirmDialog.tsx';
import { describeError, useAppData } from '../data.tsx';
import { Icon } from '../Icon.tsx';
import { Link } from '../router.tsx';
import { useToast } from '../toast.tsx';
import { Badge, EmptyState, Notice, PageHeader, Panel, Skeleton } from '../ui.tsx';

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
    const input: RepositoryInput = {
      name: name.trim(),
      sshUrl: sshUrl.trim(),
      defaultBaseBranch: baseBranch.trim() === '' ? 'main' : baseBranch.trim(),
      // Always sent, so emptying a field unlinks instead of being ignored.
      sentryOrg: org === '' ? null : org,
      sentryProject: project === '' ? null : project,
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
