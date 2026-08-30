import { type FormEvent, lazy, Suspense, useEffect, useState } from 'react';

import {
  AGENT_MODELS,
  type AgentModel,
  ApiError,
  type ClaudeState,
  fetchClaudeState,
  fetchSettings,
  saveSettings,
  type Settings as SettingsData,
  type SettingsUpdate,
  startClaudeLogin,
  stopClaudeLogin,
  validateGithubToken,
} from './api.ts';

type Notice = { kind: 'ok' | 'error'; text: string };

const describe = (error: unknown): string =>
  error instanceof ApiError ? error.message : String(error);

/**
 * What each model is worth choosing for. The `<select>` uses `''` for "no
 * choice", which is sent to the server as `null` — Claude Code then picks, and
 * on a subscription that means whatever the plan defaults to.
 */
const MODEL_LABELS: Record<AgentModel, string> = {
  opus: 'Opus — most capable, heaviest on usage limits',
  sonnet: 'Sonnet — balanced',
  haiku: 'Haiku — fastest and cheapest',
  fable: 'Fable — most capable of all, highest cost',
};

/** Turns the select's `''` back into the `null` the API expects. */
const asModel = (value: string): AgentModel | null =>
  value === '' ? null : (value as AgentModel);

// xterm.js only matters once an operator actually signs Claude in, so it stays
// in its own chunk rather than in the bundle every page load pays for.
const TerminalPane = lazy(() =>
  import('./TerminalPane.tsx').then((module) => ({ default: module.TerminalPane })),
);

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
  const [agentTimeout, setAgentTimeout] = useState('30');
  const [planningModel, setPlanningModel] = useState('');
  const [buildModel, setBuildModel] = useState('');
  const [authorName, setAuthorName] = useState('');
  const [authorEmail, setAuthorEmail] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<'save' | 'validate' | 'remove' | null>(null);
  const [claude, setClaude] = useState<ClaudeState | null>(null);
  const [claudeNotice, setClaudeNotice] = useState<Notice | null>(null);
  const [claudeBusy, setClaudeBusy] = useState<'start' | 'stop' | 'check' | null>(null);
  // Kept apart from `claude.login.active` so the pane stays on screen (and
  // readable) after the login process itself has exited.
  const [loginTerminal, setLoginTerminal] = useState<string | null>(null);

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

    // A login terminal survives a page reload, so an in-progress one is picked
    // back up rather than started again.
    fetchClaudeState({ signal: controller.signal })
      .then((state) => {
        setClaude(state);
        if (state.login.terminalId !== null) setLoginTerminal(state.login.terminalId);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setClaudeNotice({ kind: 'error', text: describe(error) });
      });

    return () => controller.abort();
  }, []);

  const runClaude = (
    kind: NonNullable<typeof claudeBusy>,
    action: () => Promise<Notice>,
  ): void => {
    setClaudeBusy(kind);
    setClaudeNotice(null);
    action()
      .then(setClaudeNotice)
      .catch((error: unknown) => setClaudeNotice({ kind: 'error', text: describe(error) }))
      .finally(() => setClaudeBusy(null));
  };

  const onSetUpClaude = (): void => {
    runClaude('start', async () => {
      const state = await startClaudeLogin();
      setClaude(state);
      setLoginTerminal(state.login.terminalId);
      return {
        kind: 'ok',
        text: 'Login terminal ready — follow the URL it prints, then paste the code back.',
      };
    });
  };

  // Closing the terminal removes the temporary container and re-checks the
  // credentials, so the indicator above shows the result of the login at once.
  const onCloseLogin = (): void => {
    runClaude('stop', async () => {
      const state = await stopClaudeLogin();
      setClaude(state);
      setLoginTerminal(null);
      return state.status.authenticated
        ? { kind: 'ok', text: 'Claude Code is authenticated.' }
        : { kind: 'error', text: 'Claude Code is still not authenticated.' };
    });
  };

  // The login process exiting is the earliest moment the answer can have
  // changed, so the indicator is refreshed there rather than on a timer.
  const onLoginExit = (): void => {
    fetchClaudeState({ refresh: true })
      .then((state) => {
        setClaude(state);
        setClaudeNotice(
          state.status.authenticated
            ? { kind: 'ok', text: 'Claude Code is authenticated. Close the terminal to clean up.' }
            : {
                kind: 'error',
                text: 'The login ended without authenticating. Close the terminal and try again.',
              },
        );
      })
      .catch((error: unknown) => setClaudeNotice({ kind: 'error', text: describe(error) }));
  };

  const onCheckClaude = (): void => {
    runClaude('check', async () => {
      const state = await fetchClaudeState({ refresh: true });
      setClaude(state);
      return state.status.authenticated
        ? { kind: 'ok', text: 'Claude Code is authenticated.' }
        : { kind: 'error', text: state.status.error ?? 'Claude Code is not authenticated.' };
    });
  };

  function applyLoaded(loaded: SettingsData): void {
    setSettings(loaded);
    setMaxSessions(String(loaded.maxConcurrentSessions));
    setAgentTimeout(String(loaded.agentTimeoutMinutes));
    setPlanningModel(loaded.planningModel ?? '');
    setBuildModel(loaded.buildModel ?? '');
    setAuthorName(loaded.gitAuthorName);
    setAuthorEmail(loaded.gitAuthorEmail);
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

    const timeout = Number.parseInt(agentTimeout, 10);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 720) {
      setNotice({
        kind: 'error',
        text: 'The agent timeout must be a whole number of minutes between 1 and 720.',
      });
      return;
    }

    // An untouched (empty) token field must not wipe the stored token, so it is
    // only sent when the operator actually typed something.
    const update: SettingsUpdate = {
      maxConcurrentSessions: parsed,
      agentTimeoutMinutes: timeout,
      planningModel: asModel(planningModel),
      buildModel: asModel(buildModel),
    };
    if (token.trim() !== '') update.githubToken = token.trim();
    // Blanking an identity field means "use the default again" (null), which is
    // what the runner image falls back to anyway.
    update.gitAuthorName = authorName.trim() === '' ? null : authorName.trim();
    update.gitAuthorEmail = authorEmail.trim() === '' ? null : authorEmail.trim();

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
  const claudeStatus = claude?.status ?? null;

  return (
    <main className={loginTerminal === null ? 'shell' : 'shell shell--wide'}>
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
          <p className="field__hint">
            Sessions started beyond this cap are queued in the order they were started, and each
            one begins on its own as soon as a build slot frees. A new value applies to the next
            session that starts; nothing already building is stopped.
          </p>
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

        <section className="field">
          <label className="field__label" htmlFor="agent-timeout">
            Agent timeout (minutes per iteration)
          </label>
          <p className="field__hint">
            How long one headless Claude may run on a single story before it is cut short. An
            iteration that runs out of time counts as a failed attempt: the loop retries the story
            up to twice more and then fails the session with the reason. Applies to the next
            iteration — nothing already running is interrupted.
          </p>
          <input
            id="agent-timeout"
            name="agent-timeout"
            type="number"
            min={1}
            max={720}
            step={1}
            value={agentTimeout}
            onChange={(event) => setAgentTimeout(event.target.value)}
            className="field__input field__input--narrow"
          />
        </section>

        <section className="field">
          <label className="field__label" htmlFor="planning-model">
            Planning model
          </label>
          <p className="field__hint">
            Which model the interactive Claude Code in the planning terminal runs on. Applies to
            the next planning terminal you open; one already running keeps the model it started
            with.
          </p>
          <select
            id="planning-model"
            name="planning-model"
            value={planningModel}
            onChange={(event) => setPlanningModel(event.target.value)}
            className="field__input field__input--narrow"
          >
            <option value="">Let Claude Code choose (default)</option>
            {AGENT_MODELS.map((model) => (
              <option key={model} value={model}>
                {MODEL_LABELS[model]}
              </option>
            ))}
          </select>
        </section>

        <section className="field">
          <label className="field__label" htmlFor="build-model">
            Build model
          </label>
          <p className="field__hint">
            Which model each headless story iteration of the build loop runs on. Read at the start
            of every iteration, so changing it mid-build applies from the next story — stories
            already committed are not rebuilt.
          </p>
          <select
            id="build-model"
            name="build-model"
            value={buildModel}
            onChange={(event) => setBuildModel(event.target.value)}
            className="field__input field__input--narrow"
          >
            <option value="">Let Claude Code choose (default)</option>
            {AGENT_MODELS.map((model) => (
              <option key={model} value={model}>
                {MODEL_LABELS[model]}
              </option>
            ))}
          </select>
        </section>

        <section className="field">
          <label className="field__label" htmlFor="git-author-name">
            Commit author name
          </label>
          <p className="field__hint">
            Identity agents commit with inside session containers. Leave blank to use the default
            (<code>chief-web</code>).
          </p>
          <input
            id="git-author-name"
            name="git-author-name"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="chief-web"
            value={authorName}
            onChange={(event) => setAuthorName(event.target.value)}
            className="field__input"
          />
        </section>

        <section className="field">
          <label className="field__label" htmlFor="git-author-email">
            Commit author email
          </label>
          <p className="field__hint">
            Leave blank to use the default (<code>chief-web@localhost</code>). Use an address your
            GitHub account owns if you want commits linked to it.
          </p>
          <input
            id="git-author-email"
            name="git-author-email"
            type="email"
            autoComplete="off"
            spellCheck={false}
            placeholder="chief-web@localhost"
            value={authorEmail}
            onChange={(event) => setAuthorEmail(event.target.value)}
            className="field__input"
          />
        </section>

        <div className="field__actions">
          <button type="submit" className="button button--primary" disabled={busy !== null}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
        </div>

        {notice !== null && (
          <p className={`notice notice--${notice.kind}`} role="alert">
            {notice.text}
          </p>
        )}
      </form>

      <section className="form form--card">
        <h2 className="card__title">Claude Code</h2>
        <p className="field__hint">
          Sign in once: the credentials are written to the shared <code>claude-auth</code> volume,
          which every session container mounts at <code>~/.claude</code> and which survives
          restarts of the stack. Sessions cannot be created until this says Authenticated.
        </p>

        <p
          className={`health health--${claudeStatus?.authenticated === true ? 'ok' : 'error'}`}
          role="status"
        >
          {claudeStatus === null
            ? 'Checking…'
            : claudeStatus.authenticated
              ? 'Authenticated'
              : 'Not authenticated'}
          {claudeStatus?.account !== null && claudeStatus?.account !== undefined
            ? ` — ${claudeStatus.account}`
            : ''}
          {claudeStatus?.subscription !== null && claudeStatus?.subscription !== undefined
            ? ` (${claudeStatus.subscription})`
            : ''}
        </p>

        {claudeStatus?.error === null || claudeStatus?.error === undefined ? null : (
          <p className="field__hint">Status check: {claudeStatus.error}</p>
        )}

        <div className="field__actions">
          <button
            type="button"
            className="button"
            onClick={onSetUpClaude}
            disabled={claudeBusy !== null || loginTerminal !== null}
          >
            {claudeBusy === 'start'
              ? 'Starting…'
              : claudeStatus?.authenticated === true
                ? 'Sign in again'
                : 'Set up Claude'}
          </button>
          <button
            type="button"
            className="button button--quiet"
            onClick={onCheckClaude}
            disabled={claudeBusy !== null}
          >
            {claudeBusy === 'check' ? 'Checking…' : 'Re-check'}
          </button>
        </div>

        {claudeNotice !== null && (
          <p className={`notice notice--${claudeNotice.kind}`} role="alert">
            {claudeNotice.text}
          </p>
        )}

        {loginTerminal === null ? null : (
          <div className="terminal">
            <div className="card__header">
              <h3 className="card__title mono">{claude?.login.containerName ?? 'claude login'}</h3>
              <button
                type="button"
                className="button button--quiet button--danger"
                onClick={onCloseLogin}
                disabled={claudeBusy !== null}
              >
                {claudeBusy === 'stop' ? 'Closing…' : 'Close login terminal'}
              </button>
            </div>
            <Suspense fallback={<p className="tagline">Loading terminal…</p>}>
              <TerminalPane terminalId={loginTerminal} onExit={onLoginExit} />
            </Suspense>
            <p className="field__hint">
              Open the URL the terminal prints, approve the request, then paste the code back here
              (Ctrl+Shift+V). Closing the terminal removes the temporary container and re-checks the
              status.
            </p>
          </div>
        )}
      </section>
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
