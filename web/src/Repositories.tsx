import { type FormEvent, useEffect, useState } from 'react';

import {
  ApiError,
  type ConnectionTestResult,
  createRepository,
  deleteRepository,
  fetchRepositories,
  type Repository,
  type RepositoryInput,
  testRepositoryConnection,
  updateRepository,
} from './api.ts';

type Notice = { kind: 'ok' | 'error'; text: string };
type TestState = { status: 'running' } | ({ status: 'done' } & ConnectionTestResult);

const describe = (error: unknown): string =>
  error instanceof ApiError ? error.message : String(error);

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

/**
 * Repository management (US-005): register a git remote, get an ed25519 deploy
 * key to paste into GitHub, and prove the key works with `git ls-remote`.
 */
export function Repositories() {
  const [repositories, setRepositories] = useState<Repository[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** The repository added in this visit — its deploy key needs attention now. */
  const [addedId, setAddedId] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});

  useEffect(() => {
    const controller = new AbortController();

    fetchRepositories(controller.signal)
      .then(setRepositories)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          window.location.replace('/login');
          return;
        }
        setLoadError(describe(error));
      });

    return () => controller.abort();
  }, []);

  const reload = async (): Promise<void> => {
    setRepositories(await fetchRepositories());
  };

  const onCreate = (input: RepositoryInput): void => {
    setSaving(true);
    setNotice(null);
    createRepository(input)
      .then(async (created) => {
        await reload();
        setAdding(false);
        setAddedId(created.id);
        setNotice({
          kind: 'ok',
          text:
            created.keySource === 'generated'
              ? `Added ${created.name}. Add the deploy key below to GitHub with write access.`
              : `Added ${created.name} with the key you provided.`,
        });
      })
      .catch((error: unknown) => setNotice({ kind: 'error', text: describe(error) }))
      .finally(() => setSaving(false));
  };

  const onUpdate = (id: string, input: RepositoryInput): void => {
    setSaving(true);
    setNotice(null);
    updateRepository(id, input)
      .then(async () => {
        await reload();
        setEditingId(null);
        setNotice({ kind: 'ok', text: 'Repository saved.' });
      })
      .catch((error: unknown) => setNotice({ kind: 'error', text: describe(error) }))
      .finally(() => setSaving(false));
  };

  const onDelete = (repository: Repository): void => {
    if (!window.confirm(`Delete "${repository.name}" and its SSH key?`)) return;
    setBusyId(repository.id);
    setNotice(null);
    deleteRepository(repository.id)
      .then(async () => {
        await reload();
        setNotice({ kind: 'ok', text: `Deleted ${repository.name}.` });
      })
      .catch((error: unknown) => setNotice({ kind: 'error', text: describe(error) }))
      .finally(() => setBusyId(null));
  };

  const onTest = (repository: Repository): void => {
    setTests((current) => ({ ...current, [repository.id]: { status: 'running' } }));
    testRepositoryConnection(repository.id)
      .then((result) => {
        setTests((current) => ({ ...current, [repository.id]: { status: 'done', ...result } }));
      })
      .catch((error: unknown) => {
        setTests((current) => ({
          ...current,
          [repository.id]: { status: 'done', ok: false, message: describe(error), stderr: '' },
        }));
      });
  };

  if (loadError !== null) {
    return (
      <main className="shell">
        <Header />
        <p className="notice notice--error" role="alert">
          Could not load repositories: {loadError}
        </p>
      </main>
    );
  }

  return (
    <main className="shell">
      <Header />
      <p className="tagline">
        Each repository gets its own SSH deploy key. Session containers clone, fetch and push with
        it — the private half never leaves the server.
      </p>

      {notice !== null && (
        <p className={`notice notice--${notice.kind}`} role="alert">
          {notice.text}
        </p>
      )}

      {adding ? (
        <RepositoryForm
          mode="create"
          busy={saving}
          onSubmit={onCreate}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <div className="field__actions field__actions--spaced">
          <button type="button" className="button button--primary" onClick={() => setAdding(true)}>
            Add repository
          </button>
        </div>
      )}

      {repositories === null ? (
        <p className="tagline">Loading…</p>
      ) : repositories.length === 0 ? (
        <p className="tagline">No repositories yet.</p>
      ) : (
        <ul className="cards">
          {repositories.map((repository) => (
            <li className="card" key={repository.id}>
              {editingId === repository.id ? (
                <RepositoryForm
                  mode="edit"
                  initial={repository}
                  busy={saving}
                  onSubmit={(input) => onUpdate(repository.id, input)}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <>
                  <div className="card__header">
                    <h2 className="card__title">{repository.name}</h2>
                    <div className="field__actions">
                      <button
                        type="button"
                        className="button button--quiet"
                        onClick={() => onTest(repository)}
                        disabled={tests[repository.id]?.status === 'running'}
                      >
                        {tests[repository.id]?.status === 'running'
                          ? 'Testing…'
                          : 'Test connection'}
                      </button>
                      <button
                        type="button"
                        className="button button--quiet"
                        onClick={() => {
                          setEditingId(repository.id);
                          setNotice(null);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="button button--quiet button--danger"
                        onClick={() => onDelete(repository)}
                        disabled={busyId === repository.id}
                      >
                        {busyId === repository.id ? 'Deleting…' : 'Delete'}
                      </button>
                    </div>
                  </div>

                  <dl className="meta">
                    <dt>SSH URL</dt>
                    <dd className="mono">{repository.sshUrl}</dd>
                    <dt>GitHub</dt>
                    <dd className="mono">{repository.githubSlug}</dd>
                    <dt>Base branch</dt>
                    <dd className="mono">{repository.defaultBaseBranch}</dd>
                    <dt>Key</dt>
                    <dd className="mono">
                      {repository.keyConfigured
                        ? `${repository.keyFingerprint ?? 'stored'} (${repository.keySource ?? 'unknown'})`
                        : 'missing — edit and paste a private key'}
                    </dd>
                  </dl>

                  <DeployKey repository={repository} highlight={addedId === repository.id} />
                  <TestResult state={tests[repository.id]} />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function TestResult({ state }: { state: TestState | undefined }) {
  if (state === undefined || state.status === 'running') return null;
  return (
    <div className="test-result">
      <p className={`notice notice--${state.ok ? 'ok' : 'error'}`} role="status">
        {state.message}
      </p>
      {state.stderr !== '' && <pre className="output">{state.stderr}</pre>}
    </div>
  );
}

function DeployKey({ repository, highlight }: { repository: Repository; highlight: boolean }) {
  if (repository.publicKey === null) {
    return (
      <p className="field__hint">
        The public half of this key is not stored — it was imported from a PEM private key. Use the
        public key you already have on GitHub.
      </p>
    );
  }

  return (
    <details className="key" open={highlight}>
      <summary className="key__summary">Deploy key</summary>
      <p className="field__hint">
        Add this as a deploy key on{' '}
        <a
          className="link"
          href={`https://github.com/${repository.githubSlug}/settings/keys/new`}
          target="_blank"
          rel="noreferrer"
        >
          github.com/{repository.githubSlug}
        </a>{' '}
        and tick <strong>Allow write access</strong> — sessions push their feature branch with it.
      </p>
      <pre className="output output--wrap">{repository.publicKey}</pre>
      <CopyButton value={repository.publicKey} />
    </details>
  );
}

function CopyButton({ value }: { value: string }) {
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
    <button type="button" className="button button--quiet" onClick={onCopy}>
      {copied ? 'Copied' : 'Copy public key'}
    </button>
  );
}

interface FormProps {
  mode: 'create' | 'edit';
  initial?: Repository;
  busy: boolean;
  onSubmit: (input: RepositoryInput) => void;
  onCancel: () => void;
}

function RepositoryForm({ mode, initial, busy, onSubmit, onCancel }: FormProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [sshUrl, setSshUrl] = useState(initial?.sshUrl ?? '');
  const [githubSlug, setGithubSlug] = useState(initial?.githubSlug ?? '');
  const [baseBranch, setBaseBranch] = useState(initial?.defaultBaseBranch ?? 'main');
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

    const input: RepositoryInput = {
      name: name.trim(),
      sshUrl: sshUrl.trim(),
      defaultBaseBranch: baseBranch.trim() === '' ? 'main' : baseBranch.trim(),
    };
    // Empty means "derive from the URL"; the server is the one that decides.
    if (githubSlug.trim() !== '') input.githubSlug = githubSlug.trim();
    if (keyMode === 'paste') input.privateKey = privateKey;

    onSubmit(input);
  };

  return (
    <form className="form form--card" onSubmit={submit}>
      <h2 className="card__title">{mode === 'create' ? 'Add repository' : `Edit ${initial?.name ?? ''}`}</h2>

      <section className="field">
        <label className="field__label" htmlFor={`name-${mode}`}>
          Name
        </label>
        <input
          id={`name-${mode}`}
          className="field__input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="my-app"
          autoComplete="off"
        />
      </section>

      <section className="field">
        <label className="field__label" htmlFor={`ssh-url-${mode}`}>
          SSH URL
        </label>
        <input
          id={`ssh-url-${mode}`}
          className="field__input"
          value={sshUrl}
          onChange={(event) => setSshUrl(event.target.value)}
          placeholder="git@github.com:owner/repo.git"
          autoComplete="off"
          spellCheck={false}
        />
      </section>

      <section className="field">
        <label className="field__label" htmlFor={`slug-${mode}`}>
          GitHub slug
        </label>
        <p className="field__hint">
          Used to open pull requests. Leave blank to derive it from the SSH URL
          {derived === null ? '.' : ` (${derived}).`}
        </p>
        <input
          id={`slug-${mode}`}
          className="field__input"
          value={githubSlug}
          onChange={(event) => setGithubSlug(event.target.value)}
          placeholder={derived ?? 'owner/repo'}
          autoComplete="off"
          spellCheck={false}
        />
      </section>

      <section className="field">
        <label className="field__label" htmlFor={`branch-${mode}`}>
          Default base branch
        </label>
        <input
          id={`branch-${mode}`}
          className="field__input field__input--narrow"
          value={baseBranch}
          onChange={(event) => setBaseBranch(event.target.value)}
          placeholder="main"
          autoComplete="off"
          spellCheck={false}
        />
      </section>

      <section className="field">
        <span className="field__label">SSH key</span>
        <p className="field__hint">
          {mode === 'create'
            ? 'chief-web generates an ed25519 keypair and shows you the public half to add as a GitHub deploy key.'
            : 'The stored key is kept unless you paste a replacement.'}
        </p>
        <label className="radio">
          <input
            type="radio"
            name={`key-mode-${mode}`}
            checked={keyMode === 'generate'}
            onChange={() => setKeyMode('generate')}
          />
          {mode === 'create' ? 'Generate a new ed25519 keypair' : 'Keep the stored key'}
        </label>
        <label className="radio">
          <input
            type="radio"
            name={`key-mode-${mode}`}
            checked={keyMode === 'paste'}
            onChange={() => setKeyMode('paste')}
          />
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
      </section>

      {error !== null && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}

      <div className="field__actions">
        <button type="submit" className="button" disabled={busy}>
          {busy ? 'Saving…' : mode === 'create' ? 'Add repository' : 'Save'}
        </button>
        <button type="button" className="button button--quiet" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Header() {
  return (
    <header className="topbar">
      <h1>Repositories</h1>
      <a className="link" href="/">
        Back
      </a>
    </header>
  );
}
