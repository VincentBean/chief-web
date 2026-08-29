import { type FormEvent, useEffect, useState } from 'react';

import {
  ApiError,
  fetchSettings,
  saveSettings,
  type Settings as SettingsData,
  type SettingsUpdate,
  validateGithubToken,
} from './api.ts';

type Notice = { kind: 'ok' | 'error'; text: string };

const describe = (error: unknown): string =>
  error instanceof ApiError ? error.message : String(error);

/**
 * Global settings (US-004): the GitHub PAT used to open pull requests and the
 * build concurrency cap. The token is write-only — once saved, the server only
 * ever tells us its last four characters.
 */
export function Settings() {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [maxSessions, setMaxSessions] = useState('3');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<'save' | 'validate' | 'remove' | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    fetchSettings(controller.signal)
      .then(applyLoaded)
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

  function applyLoaded(loaded: SettingsData): void {
    setSettings(loaded);
    setMaxSessions(String(loaded.maxConcurrentSessions));
  }

  const run = (kind: NonNullable<typeof busy>, action: () => Promise<Notice>): void => {
    setBusy(kind);
    setNotice(null);
    action()
      .then(setNotice)
      .catch((error: unknown) => setNotice({ kind: 'error', text: describe(error) }))
      .finally(() => setBusy(null));
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();

    const parsed = Number.parseInt(maxSessions, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
      setNotice({ kind: 'error', text: 'Max concurrent sessions must be a whole number ≥ 1.' });
      return;
    }

    // An untouched (empty) token field must not wipe the stored token, so it is
    // only sent when the operator actually typed something.
    const update: SettingsUpdate = { maxConcurrentSessions: parsed };
    if (token.trim() !== '') update.githubToken = token.trim();

    run('save', async () => {
      applyLoaded(await saveSettings(update));
      setToken('');
      return { kind: 'ok', text: 'Settings saved.' };
    });
  };

  const onValidate = () => {
    const candidate = token.trim();
    run('validate', async () => {
      const { login } = await validateGithubToken(candidate === '' ? undefined : candidate);
      return { kind: 'ok', text: `Token is valid — authenticated as ${login}.` };
    });
  };

  const onRemove = () => {
    run('remove', async () => {
      applyLoaded(await saveSettings({ githubToken: null }));
      setToken('');
      return { kind: 'ok', text: 'GitHub token removed.' };
    });
  };

  if (loadError !== null) {
    return (
      <main className="shell">
        <Header />
        <p className="notice notice--error" role="alert">
          Could not load settings: {loadError}
        </p>
      </main>
    );
  }

  if (settings === null) {
    return (
      <main className="shell">
        <Header />
        <p className="tagline">Loading…</p>
      </main>
    );
  }

  const stored = settings.githubToken;
  const canValidate = token.trim() !== '' || stored.configured;

  return (
    <main className="shell">
      <Header />
      <p className="tagline">Applies to every repository and session.</p>

      <form className="form" onSubmit={onSubmit}>
        <section className="field">
          <label className="field__label" htmlFor="github-token">
            GitHub Personal Access Token
          </label>
          <p className="field__hint">
            {stored.configured
              ? `Saved token: ${'•'.repeat(8)}${stored.last4 ?? ''}. Enter a new one to replace it.`
              : 'Not configured. Needs repo contents and pull-request write access.'}
          </p>
          <input
            id="github-token"
            name="github-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={stored.configured ? 'Leave blank to keep the current token' : 'ghp_…'}
            value={token}
            onChange={(event) => setToken(event.target.value)}
            className="field__input"
          />
          <div className="field__actions">
            <button
              type="button"
              className="button button--quiet"
              onClick={onValidate}
              disabled={busy !== null || !canValidate}
            >
              {busy === 'validate' ? 'Validating…' : 'Validate'}
            </button>
            {stored.configured && (
              <button
                type="button"
                className="button button--quiet"
                onClick={onRemove}
                disabled={busy !== null}
              >
                {busy === 'remove' ? 'Removing…' : 'Remove'}
              </button>
            )}
          </div>
        </section>

        <section className="field">
          <label className="field__label" htmlFor="max-sessions">
            Max concurrent building sessions
          </label>
          <p className="field__hint">Sessions started beyond this cap are queued.</p>
          <input
            id="max-sessions"
            name="max-sessions"
            type="number"
            min={1}
            max={50}
            step={1}
            value={maxSessions}
            onChange={(event) => setMaxSessions(event.target.value)}
            className="field__input field__input--narrow"
          />
        </section>

        <div className="field__actions">
          <button type="submit" className="button" disabled={busy !== null}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
        </div>

        {notice !== null && (
          <p className={`notice notice--${notice.kind}`} role="alert">
            {notice.text}
          </p>
        )}
      </form>
    </main>
  );
}

function Header() {
  return (
    <header className="topbar">
      <h1>Settings</h1>
      <a className="link" href="/">
        Back
      </a>
    </header>
  );
}
