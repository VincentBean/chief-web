import { type FormEvent, lazy, Suspense, useEffect, useState } from 'react';

import {
  AGENT_MODELS,
  type AgentModel,
  fetchClaudeState,
  fetchSettings,
  saveSettings,
  type Settings as SettingsData,
  type SettingsUpdate,
  startClaudeLogin,
  stopClaudeLogin,
  validateGithubToken,
} from '../api.ts';
import { DESKTOP_QUERY, describeError, redirectIfUnauthorised, useAppData, useMediaQuery } from '../data.tsx';
import { Icon } from '../Icon.tsx';
import { useToast } from '../toast.tsx';
import { Badge, Notice, PageHeader, Panel, Skeleton } from '../ui.tsx';

/**
 * What each model is worth choosing for. The `<select>` uses `''` for "no
 * choice", which is sent to the server as `null` — Claude Code then picks.
 */
const MODEL_LABELS: Record<AgentModel, string> = {
  opus: 'Opus — most capable, heaviest on usage limits',
  sonnet: 'Sonnet — balanced',
  haiku: 'Haiku — fastest and cheapest',
  fable: 'Fable — most capable of all, highest cost',
};

const asModel = (value: string): AgentModel | null => (value === '' ? null : (value as AgentModel));

// xterm.js only matters once an operator actually signs Claude in.
const TerminalPane = lazy(() => import('../TerminalPane.tsx').then((module) => ({ default: module.TerminalPane })));

/**
 * Global settings (US-004): the GitHub token, the build cap and timeout, the
 * models, the commit identity, and Claude Code's one-time sign-in. One form;
 * the save bar appears when something has changed.
 */
export function Settings() {
  const toast = useToast();
  const { claude, setClaude } = useAppData();
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [maxSessions, setMaxSessions] = useState('3');
  const [agentTimeout, setAgentTimeout] = useState('30');
  const [prSyncInterval, setPrSyncInterval] = useState('15');
  const [planningModel, setPlanningModel] = useState('');
  const [buildModel, setBuildModel] = useState('');
  const [reviewModel, setReviewModel] = useState('');
  const [codeReviewDefault, setCodeReviewDefault] = useState(false);
  const [authorName, setAuthorName] = useState('');
  const [authorEmail, setAuthorEmail] = useState('');
  const [busy, setBusy] = useState<'save' | 'validate' | 'remove' | null>(null);
  const [claudeBusy, setClaudeBusy] = useState<'start' | 'stop' | 'check' | null>(null);
  // Kept apart from `claude.login.active` so the pane stays on screen (and
  // readable) after the login process itself has exited.
  const [loginTerminal, setLoginTerminal] = useState<string | null>(null);
  // Below `lg` the login terminal is not rendered at all: mounting it would
  // open a WebSocket onto a PTY too narrow to read and impossible to paste
  // a code into. The login itself keeps running on the server.
  const desktop = useMediaQuery(DESKTOP_QUERY);

  useEffect(() => {
    const controller = new AbortController();
    fetchSettings(controller.signal)
      .then(applyLoaded)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (redirectIfUnauthorised(error)) return;
        setLoadError(describeError(error));
      });
    // A login terminal survives a page reload, so an in-progress one is picked
    // back up rather than started again.
    fetchClaudeState({ signal: controller.signal })
      .then((state) => {
        setClaude(state);
        if (state.login.terminalId !== null) setLoginTerminal(state.login.terminalId);
      })
      .catch(() => {
        // The status line below says "checking" until it can say more.
      });
    return () => controller.abort();
  }, [setClaude]);

  // `/settings#claude` from the sidebar or the overview lands on that panel.
  useEffect(() => {
    if (settings === null || window.location.hash === '') return;
    document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [settings]);

  function applyLoaded(loaded: SettingsData): void {
    setSettings(loaded);
    setMaxSessions(String(loaded.maxConcurrentSessions));
    setAgentTimeout(String(loaded.agentTimeoutMinutes));
    setPrSyncInterval(String(loaded.prSyncIntervalMinutes));
    setPlanningModel(loaded.planningModel ?? '');
    setBuildModel(loaded.buildModel ?? '');
    setReviewModel(loaded.reviewModel ?? '');
    setCodeReviewDefault(loaded.codeReviewDefault);
    setAuthorName(loaded.gitAuthorName);
    setAuthorEmail(loaded.gitAuthorEmail);
  }

  const run = (kind: NonNullable<typeof busy>, action: () => Promise<string>): void => {
    setBusy(kind);
    action()
      .then((message) => toast.ok(message))
      .catch((error: unknown) => toast.error(describeError(error)))
      .finally(() => setBusy(null));
  };

  const runClaude = (kind: NonNullable<typeof claudeBusy>, action: () => Promise<{ ok: boolean; text: string }>): void => {
    setClaudeBusy(kind);
    action()
      .then((result) => toast.push(result.ok ? 'ok' : 'error', result.text))
      .catch((error: unknown) => toast.error(describeError(error)))
      .finally(() => setClaudeBusy(null));
  };

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    const parsed = Number.parseInt(maxSessions, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
      toast.error('Max concurrent sessions must be a whole number of at least 1.');
      return;
    }
    const timeout = Number.parseInt(agentTimeout, 10);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 720) {
      toast.error('The agent timeout must be a whole number of minutes between 1 and 720.');
      return;
    }
    const syncInterval = Number.parseInt(prSyncInterval, 10);
    if (!Number.isInteger(syncInterval) || syncInterval < 1 || syncInterval > 1440) {
      toast.error(
        'The pull request sync interval must be a whole number of minutes between 1 and 1440.',
      );
      return;
    }
    const update: SettingsUpdate = {
      maxConcurrentSessions: parsed,
      agentTimeoutMinutes: timeout,
      prSyncIntervalMinutes: syncInterval,
      planningModel: asModel(planningModel),
      buildModel: asModel(buildModel),
      reviewModel: asModel(reviewModel),
      codeReviewDefault,
      gitAuthorName: authorName.trim() === '' ? null : authorName.trim(),
      gitAuthorEmail: authorEmail.trim() === '' ? null : authorEmail.trim(),
    };
    // An untouched (empty) token field must not wipe the stored token.
    if (token.trim() !== '') update.githubToken = token.trim();
    run('save', async () => {
      applyLoaded(await saveSettings(update));
      setToken('');
      return 'Settings saved.';
    });
  };

  const onValidate = (): void => {
    const candidate = token.trim();
    run('validate', async () => {
      const { login } = await validateGithubToken(candidate === '' ? undefined : candidate);
      return `Token is valid: authenticated as ${login}.`;
    });
  };

  const onRemove = (): void => {
    run('remove', async () => {
      applyLoaded(await saveSettings({ githubToken: null }));
      setToken('');
      return 'GitHub token removed.';
    });
  };

  const onSetUpClaude = (): void => {
    runClaude('start', async () => {
      const state = await startClaudeLogin();
      setClaude(state);
      setLoginTerminal(state.login.terminalId);
      return { ok: true, text: 'Login terminal ready. Open the URL it prints, then paste the code back.' };
    });
  };

  const onCloseLogin = (): void => {
    runClaude('stop', async () => {
      const state = await stopClaudeLogin();
      setClaude(state);
      setLoginTerminal(null);
      return state.status.authenticated
        ? { ok: true, text: 'Claude Code is signed in.' }
        : { ok: false, text: 'Claude Code is still not signed in.' };
    });
  };

  const onLoginExit = (): void => {
    fetchClaudeState({ refresh: true })
      .then((state) => {
        setClaude(state);
        toast.push(
          state.status.authenticated ? 'ok' : 'error',
          state.status.authenticated
            ? 'Claude Code is signed in. Close the terminal to clean up.'
            : 'The login ended without signing in. Close the terminal and try again.',
        );
      })
      .catch((error: unknown) => toast.error(describeError(error)));
  };

  const onCheckClaude = (): void => {
    runClaude('check', async () => {
      const state = await fetchClaudeState({ refresh: true });
      setClaude(state);
      return state.status.authenticated
        ? { ok: true, text: 'Claude Code is signed in.' }
        : { ok: false, text: state.status.error ?? 'Claude Code is not signed in.' };
    });
  };

  if (loadError !== null) {
    return (
      <div className="page page--narrow">
        <PageHeader title="Settings" />
        <Notice kind="error">Could not load settings: {loadError}</Notice>
      </div>
    );
  }

  if (settings === null) {
    return (
      <div className="page page--narrow">
        <PageHeader title="Settings" />
        <div className="panel">
          <div className="panel__body">
            <Skeleton lines={6} />
          </div>
        </div>
      </div>
    );
  }

  const stored = settings.githubToken;
  const dirty =
    token.trim() !== '' ||
    maxSessions !== String(settings.maxConcurrentSessions) ||
    agentTimeout !== String(settings.agentTimeoutMinutes) ||
    prSyncInterval !== String(settings.prSyncIntervalMinutes) ||
    planningModel !== (settings.planningModel ?? '') ||
    buildModel !== (settings.buildModel ?? '') ||
    reviewModel !== (settings.reviewModel ?? '') ||
    codeReviewDefault !== settings.codeReviewDefault ||
    authorName !== settings.gitAuthorName ||
    authorEmail !== settings.gitAuthorEmail;
  const claudeStatus = claude?.status ?? null;

  return (
    <div className="page page--narrow">
      <PageHeader title="Settings" subtitle="Applies to every repository and session. Changes take effect at the next iteration; nothing running is interrupted." />

      <Panel
        title="Claude Code"
        icon="zap"
        id="claude"
        meta={
          claudeStatus === null ? (
            <Badge>checking…</Badge>
          ) : claudeStatus.authenticated ? (
            <Badge tone="done">signed in</Badge>
          ) : (
            <Badge tone="danger">not signed in</Badge>
          )
        }
        actions={
          <>
            <button type="button" className={claudeStatus?.authenticated === true ? 'button button--small' : 'button button--small button--primary'} onClick={onSetUpClaude} disabled={claudeBusy !== null || loginTerminal !== null}>
              <Icon name="key" />
              {claudeBusy === 'start' ? 'Starting…' : claudeStatus?.authenticated === true ? 'Sign in again' : 'Sign in'}
            </button>
            <button type="button" className="button button--small button--quiet" onClick={onCheckClaude} disabled={claudeBusy !== null}>
              <Icon name="sync" />
              {claudeBusy === 'check' ? 'Checking…' : 'Re-check'}
            </button>
          </>
        }
      >
        <p className={claudeStatus?.authenticated === true ? undefined : 'muted'}>
          {claudeStatus === null
            ? 'Probing the shared credentials volume…'
            : claudeStatus.authenticated
              ? `Signed in${claudeStatus.account === null ? '' : ` as ${claudeStatus.account}`}${claudeStatus.subscription === null ? '' : ` (${claudeStatus.subscription})`}. Every session container shares these credentials.`
              : 'Sessions cannot be created until Claude Code is signed in. It is a one-time browser login; the credentials are kept on a volume that survives restarts.'}
        </p>
        {claudeStatus?.error != null && <p className="field__hint">Status check: {claudeStatus.error}</p>}

        {loginTerminal !== null && (
          <div className="stack stack--tight">
            <div className="row__line">
              <span className="mono muted">{claude?.login.containerName ?? 'claude login'}</span>
              <span className="toolbar__spacer" />
              <button type="button" className="button button--small button--danger" onClick={onCloseLogin} disabled={claudeBusy !== null}>
                <Icon name="x" />
                {claudeBusy === 'stop' ? 'Closing…' : 'Close login terminal'}
              </button>
            </div>
            {desktop ? (
              <>
                <Suspense fallback={<Skeleton lines={6} />}>
                  <TerminalPane terminalId={loginTerminal} onExit={onLoginExit} />
                </Suspense>
                <ol className="steps steps--plain steps--compact">
                  <li className="step">
                    <span className="step__marker">1</span>
                    <span className="step__body">Select the URL the terminal prints, copy it with Ctrl+Shift+C, open it in a new tab.</span>
                  </li>
                  <li className="step">
                    <span className="step__marker">2</span>
                    <span className="step__body">Approve the request and copy the code Claude gives back.</span>
                  </li>
                  <li className="step">
                    <span className="step__marker">3</span>
                    <span className="step__body">Paste it into the terminal with Ctrl+Shift+V, press Enter, then close the terminal.</span>
                  </li>
                </ol>
              </>
            ) : (
              <Notice kind="info">
                <strong>Finish this sign-in on a desktop.</strong> The login is an interactive terminal: it prints a URL to
                open and waits for the code you get back, which needs a keyboard and a wider screen. The terminal is already
                running on the server, so opening this page on a desktop picks it up where it is — or close it here and start
                again there.
              </Notice>
            )}
          </div>
        )}
      </Panel>

      <form onSubmit={onSubmit} className="stack">
        <Panel
          title="GitHub"
          icon="git-pull-request"
          id="github"
          meta={stored.configured ? <Badge tone="done">token ····{stored.last4 ?? ''}</Badge> : <Badge tone="danger">no token</Badge>}
        >
          <div className="field">
            <label className="field__label" htmlFor="github-token">
              Personal access token
            </label>
            <div className="field__pair">
              <input
                id="github-token"
                name="github-token"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={stored.configured ? 'Leave blank to keep the current token' : 'ghp_… or github_pat_…'}
                value={token}
                onChange={(event) => setToken(event.target.value)}
                className="field__input mono"
              />
              <button type="button" className="button" onClick={onValidate} disabled={busy !== null || (token.trim() === '' && !stored.configured)}>
                {busy === 'validate' ? 'Validating…' : 'Validate'}
              </button>
              {stored.configured && (
                <button type="button" className="button button--quiet button--danger" onClick={onRemove} disabled={busy !== null}>
                  Remove
                </button>
              )}
            </div>
            <p className="field__hint">
              Opens pull requests on your behalf. A classic token needs <code className="mono">repo</code>; a fine-grained one needs Contents and Pull requests read/write on the repositories. Stored write-only.
            </p>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="pr-sync-interval">
              Sync every (minutes)
            </label>
            <input id="pr-sync-interval" name="pr-sync-interval" type="number" min={1} max={1440} step={1} value={prSyncInterval} onChange={(event) => setPrSyncInterval(event.target.value)} className="field__input field__input--narrow" />
            <p className="field__hint">How often delivered sessions are re-checked, so a merged pull request shows as merged here. Each open pull request costs one API request per interval; a change applies from the next sync.</p>
          </div>
        </Panel>

        <Panel title="Build loop" icon="pulse" id="build">
          <div className="field__row">
            <div className="field">
              <label className="field__label" htmlFor="max-sessions">
                Concurrent builds
              </label>
              <input id="max-sessions" name="max-sessions" type="number" min={1} max={50} step={1} value={maxSessions} onChange={(event) => setMaxSessions(event.target.value)} className="field__input field__input--narrow" />
              <p className="field__hint">Build slots. Sessions beyond the cap queue in the order they were started.</p>
            </div>
            <div className="field">
              <label className="field__label" htmlFor="agent-timeout">
                Minutes per story
              </label>
              <input id="agent-timeout" name="agent-timeout" type="number" min={1} max={720} step={1} value={agentTimeout} onChange={(event) => setAgentTimeout(event.target.value)} className="field__input field__input--narrow" />
              <p className="field__hint">One agent iteration is cut short after this; it counts as one of the three attempts a story gets.</p>
            </div>
          </div>
        </Panel>

        <Panel title="Models" icon="zap" id="models">
          <div className="field__row">
            <div className="field">
              <label className="field__label" htmlFor="planning-model">
                Planning
              </label>
              <select id="planning-model" name="planning-model" value={planningModel} onChange={(event) => setPlanningModel(event.target.value)} className="field__input">
                <option value="">Let Claude Code choose</option>
                {AGENT_MODELS.map((model) => (
                  <option key={model} value={model}>
                    {MODEL_LABELS[model]}
                  </option>
                ))}
              </select>
              <p className="field__hint">The interactive terminal. One conversation, so the best model is cheap here.</p>
            </div>
            <div className="field">
              <label className="field__label" htmlFor="build-model">
                Build
              </label>
              <select id="build-model" name="build-model" value={buildModel} onChange={(event) => setBuildModel(event.target.value)} className="field__input">
                <option value="">Let Claude Code choose</option>
                {AGENT_MODELS.map((model) => (
                  <option key={model} value={model}>
                    {MODEL_LABELS[model]}
                  </option>
                ))}
              </select>
              <p className="field__hint">Each headless story iteration. Read at the start of every iteration, so a change applies from the next story.</p>
            </div>
            <div className="field">
              <label className="field__label" htmlFor="review-model">
                Review
              </label>
              <select id="review-model" name="review-model" value={reviewModel} onChange={(event) => setReviewModel(event.target.value)} className="field__input">
                <option value="">Let Claude Code choose</option>
                {AGENT_MODELS.map((model) => (
                  <option key={model} value={model}>
                    {MODEL_LABELS[model]}
                  </option>
                ))}
              </select>
              <p className="field__hint">The code review left on a session's pull request. One pass over the finished branch.</p>
            </div>
          </div>

          <div className="field">
            <label className="checkbox">
              <input type="checkbox" checked={codeReviewDefault} onChange={(event) => setCodeReviewDefault(event.target.checked)} />
              Run code review on new sessions
            </label>
            <p className="field__hint">Only the starting value of the checkbox on a new session; sessions that already exist keep whatever they were created with.</p>
          </div>
        </Panel>

        <Panel title="Commit identity" icon="git-branch" id="identity">
          <div className="field__row">
            <div className="field">
              <label className="field__label" htmlFor="git-author-name">
                Author name
              </label>
              <input id="git-author-name" name="git-author-name" type="text" autoComplete="off" spellCheck={false} placeholder="chief-web" value={authorName} onChange={(event) => setAuthorName(event.target.value)} className="field__input" />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="git-author-email">
                Author email
              </label>
              <input id="git-author-email" name="git-author-email" type="email" autoComplete="off" spellCheck={false} placeholder="chief-web@localhost" value={authorEmail} onChange={(event) => setAuthorEmail(event.target.value)} className="field__input" />
            </div>
          </div>
          <p className="field__hint">What agents commit as inside session containers. Blank restores the defaults; use an address your GitHub account owns to link the commits to it.</p>
        </Panel>

        <div className={`savebar${dirty ? ' savebar--visible' : ''}`} aria-hidden={!dirty}>
          <span className="savebar__text">{dirty ? 'You have unsaved changes.' : 'Everything is saved.'}</span>
          <button type="button" className="button button--quiet" onClick={() => applyLoaded(settings)} disabled={busy !== null || !dirty} tabIndex={dirty ? 0 : -1}>
            Discard
          </button>
          <button type="submit" className="button button--primary" disabled={busy !== null || !dirty} tabIndex={dirty ? 0 : -1}>
            <Icon name="check" />
            {busy === 'save' ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </div>
  );
}
