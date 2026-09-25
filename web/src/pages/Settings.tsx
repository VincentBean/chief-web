import { type FormEvent, lazy, Suspense, useCallback, useEffect, useState } from 'react';

import {
  ADVISOR_MODELS,
  type AdvisorModel,
  AGENT_MODELS,
  type AgentModel,
  ApiError,
  checkElevenLabsKey,
  checkOpenRouterKey,
  type ElevenLabsVoice,
  fetchClaudeState,
  fetchSettings,
  fetchVoiceVoices,
  type OpenRouterSlugs,
  saveSettings,
  type Settings as SettingsData,
  type SettingsUpdate,
  startClaudeLogin,
  stopClaudeLogin,
  testSpeechToText,
  validateGithubToken,
  VOICE_BARGE_IN_MODES,
  VOICE_EVENT_VERBOSITIES,
  VOICE_LIVE_CAPTIONS,
  VOICE_STT_PROVIDERS,
  VOICE_TTS_MODELS,
  type VoiceSettings,
} from '../api.ts';
import { DESKTOP_QUERY, describeError, redirectIfUnauthorised, useAppData, useMediaQuery } from '../data.tsx';
import { Icon } from '../Icon.tsx';
import { useToast } from '../toast.tsx';
import { Badge, Notice, PageHeader, Panel, Skeleton } from '../ui.tsx';
import { recordWav } from '../voice/wav.ts';

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

const asAdvisor = (value: string): AdvisorModel | null => (value === '' ? null : (value as AdvisorModel));

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
  const [conflictInterval, setConflictInterval] = useState('30');
  const [conflictFixEnabled, setConflictFixEnabled] = useState(true);
  const [planningModel, setPlanningModel] = useState('');
  const [buildModel, setBuildModel] = useState('');
  const [reviewModel, setReviewModel] = useState('');
  const [advisorModel, setAdvisorModel] = useState('');
  /**
   * The server's own words for an advisor Claude Code would refuse at launch
   * (US-006), shown under the advisor select. A toast is the wrong home for it:
   * the operator has to change that one field to get past it, and a message
   * that scrolls away does not say which.
   */
  const [advisorError, setAdvisorError] = useState<string | null>(null);
  const [codeReviewDefault, setCodeReviewDefault] = useState(false);
  const [authorName, setAuthorName] = useState('');
  const [authorEmail, setAuthorEmail] = useState('');
  const [sentryToken, setSentryToken] = useState('');
  const [sentryInterval, setSentryInterval] = useState('15');
  const [sentryModel, setSentryModel] = useState<AgentModel>('haiku');
  const [sentryPlans, setSentryPlans] = useState('2');
  const [sentryBaseUrl, setSentryBaseUrl] = useState('');
  const [voiceForm, setVoiceForm] = useState<VoiceForm | null>(null);
  const [openrouterKey, setOpenrouterKey] = useState('');
  const [elevenlabsKey, setElevenlabsKey] = useState('');
  /** OpenRouter's verdict on each model name, shown under its field. */
  const [slugProblems, setSlugProblems] = useState<Partial<Record<keyof OpenRouterSlugs, string>>>({});
  const [busy, setBusy] = useState<'save' | 'validate' | 'remove' | 'remove-sentry' | 'remove-voice-key' | null>(null);
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
    setConflictInterval(String(loaded.prConflictIntervalMinutes));
    setConflictFixEnabled(loaded.conflictFixEnabled);
    setPlanningModel(loaded.planningModel ?? '');
    setBuildModel(loaded.buildModel ?? '');
    setReviewModel(loaded.reviewModel ?? '');
    setAdvisorModel(loaded.advisorModel ?? '');
    setCodeReviewDefault(loaded.codeReviewDefault);
    setAuthorName(loaded.gitAuthorName);
    setAuthorEmail(loaded.gitAuthorEmail);
    setSentryInterval(String(loaded.sentryPollIntervalMinutes));
    setSentryModel(loaded.sentryModel);
    setSentryPlans(String(loaded.sentryPlansPerTick));
    setSentryBaseUrl(loaded.sentryBaseUrl);
    setVoiceForm(toVoiceForm(loaded.voice));
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
    const conflictScan = Number.parseInt(conflictInterval, 10);
    if (!Number.isInteger(conflictScan) || conflictScan < 1 || conflictScan > 1440) {
      toast.error(
        'The merge conflict scan interval must be a whole number of minutes between 1 and 1440.',
      );
      return;
    }
    const sentryPoll = Number.parseInt(sentryInterval, 10);
    if (!Number.isInteger(sentryPoll) || sentryPoll < 1 || sentryPoll > 1440) {
      toast.error('The Sentry poll interval must be a whole number of minutes between 1 and 1440.');
      return;
    }
    const plansPerTick = Number.parseInt(sentryPlans, 10);
    if (!Number.isInteger(plansPerTick) || plansPerTick < 1 || plansPerTick > 10) {
      toast.error('Plans per poll must be a whole number between 1 and 10.');
      return;
    }
    const baseUrl = sentryBaseUrl.trim();
    if (baseUrl !== '' && !/^https?:\/\//i.test(baseUrl)) {
      toast.error('The Sentry base URL must start with http:// or https://.');
      return;
    }
    const voice = voiceForm === null ? null : fromVoiceForm(voiceForm);
    if (voice !== null && 'error' in voice) {
      toast.error(voice.error);
      return;
    }
    const update: SettingsUpdate = {
      maxConcurrentSessions: parsed,
      agentTimeoutMinutes: timeout,
      prSyncIntervalMinutes: syncInterval,
      prConflictIntervalMinutes: conflictScan,
      conflictFixEnabled,
      planningModel: asModel(planningModel),
      buildModel: asModel(buildModel),
      reviewModel: asModel(reviewModel),
      advisorModel: asAdvisor(advisorModel),
      codeReviewDefault,
      gitAuthorName: authorName.trim() === '' ? null : authorName.trim(),
      gitAuthorEmail: authorEmail.trim() === '' ? null : authorEmail.trim(),
      sentryPollIntervalMinutes: sentryPoll,
      sentryModel,
      sentryPlansPerTick: plansPerTick,
      // Blank restores the hosted API, the same way a blank identity field
      // restores the built-in commit author.
      sentryBaseUrl: baseUrl === '' ? null : baseUrl,
    };
    // An untouched (empty) token field must not wipe the stored token.
    if (token.trim() !== '') update.githubToken = token.trim();
    if (sentryToken.trim() !== '') update.sentryToken = sentryToken.trim();
    if (openrouterKey.trim() !== '') update.openrouterApiKey = openrouterKey.trim();
    if (elevenlabsKey.trim() !== '') update.elevenlabsApiKey = elevenlabsKey.trim();
    if (voice !== null) update.voice = voice.voice;
    setAdvisorError(null);
    run('save', async () => {
      // The OpenRouter names are free text, so a changed one is checked against
      // OpenRouter's catalog before it is saved. Only a clear "no such model"
      // blocks the save: OpenRouter being unreachable is not the operator's
      // mistake, and the Check button can be pressed again later.
      if (voice !== null && settings !== null) {
        const typed = slugsOf(voice.voice);
        const saved = slugsOf(settings.voice);
        if ((Object.keys(typed) as (keyof OpenRouterSlugs)[]).some((field) => typed[field] !== saved[field])) {
          const result = await checkOpenRouterKey({ modelsOnly: true, models: typed }).catch(() => null);
          if (result !== null) {
            const problems: Partial<Record<keyof OpenRouterSlugs, string>> = {};
            for (const check of result.models) if (check.problem !== null) problems[check.field] = check.problem;
            setSlugProblems(problems);
            if (Object.keys(problems).length > 0) {
              throw new Error('A voice model name is not usable on OpenRouter; see the Voice section.');
            }
          }
        }
      }
      // One rejection names a single field rather than the save as a whole, so
      // it is caught here and re-thrown: the toast still fires, and the message
      // also stays put under the field the operator has to change.
      applyLoaded(
        await saveSettings(update).catch((error: unknown) => {
          if (error instanceof ApiError && error.code === 'invalid_advisor_model') {
            setAdvisorError(error.message);
          }
          throw error;
        }),
      );
      setToken('');
      setSentryToken('');
      setOpenrouterKey('');
      setElevenlabsKey('');
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

  const onRemoveSentryToken = (): void => {
    run('remove-sentry', async () => {
      applyLoaded(await saveSettings({ sentryToken: null }));
      setSentryToken('');
      return 'Sentry token removed.';
    });
  };

  const onRemoveVoiceKey = (provider: 'openrouter' | 'elevenlabs'): void => {
    run('remove-voice-key', async () => {
      if (provider === 'openrouter') {
        applyLoaded(await saveSettings({ openrouterApiKey: null }));
        setOpenrouterKey('');
        return 'OpenRouter key removed.';
      }
      applyLoaded(await saveSettings({ elevenlabsApiKey: null }));
      setElevenlabsKey('');
      return 'ElevenLabs key removed.';
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

  if (settings === null || voiceForm === null) {
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
  const storedSentry = settings.sentryToken;
  const dirty =
    token.trim() !== '' ||
    maxSessions !== String(settings.maxConcurrentSessions) ||
    agentTimeout !== String(settings.agentTimeoutMinutes) ||
    prSyncInterval !== String(settings.prSyncIntervalMinutes) ||
    conflictInterval !== String(settings.prConflictIntervalMinutes) ||
    conflictFixEnabled !== settings.conflictFixEnabled ||
    planningModel !== (settings.planningModel ?? '') ||
    buildModel !== (settings.buildModel ?? '') ||
    reviewModel !== (settings.reviewModel ?? '') ||
    advisorModel !== (settings.advisorModel ?? '') ||
    codeReviewDefault !== settings.codeReviewDefault ||
    authorName !== settings.gitAuthorName ||
    authorEmail !== settings.gitAuthorEmail ||
    sentryToken.trim() !== '' ||
    sentryInterval !== String(settings.sentryPollIntervalMinutes) ||
    sentryModel !== settings.sentryModel ||
    sentryPlans !== String(settings.sentryPlansPerTick) ||
    sentryBaseUrl !== settings.sentryBaseUrl ||
    openrouterKey.trim() !== '' ||
    elevenlabsKey.trim() !== '' ||
    JSON.stringify(voiceForm) !== JSON.stringify(toVoiceForm(settings.voice));
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

          <div className="field">
            <label className="field__label" htmlFor="conflict-interval">
              Scan for merge conflicts every (minutes)
            </label>
            <input id="conflict-interval" name="conflict-interval" type="number" min={1} max={1440} step={1} value={conflictInterval} onChange={(event) => setConflictInterval(event.target.value)} className="field__input field__input--narrow" />
            <p className="field__hint">How often open <code className="mono">chief/</code> pull requests are checked for merge conflicts. Each scan costs one API request per repository plus one per pull request it checks; a change applies from the next scan.</p>
          </div>

          <div className="field">
            <label className="checkbox">
              <input type="checkbox" checked={conflictFixEnabled} onChange={(event) => setConflictFixEnabled(event.target.checked)} />
              Fix merge conflicts automatically
            </label>
            <p className="field__hint">Off means no scan and no agent: nothing is pushed to your pull requests, and no API budget is spent on looking. A fix already running is left to finish.</p>
          </div>
        </Panel>

        <Panel title="Build loop" icon="pulse" id="build">
          <div className="field__row">
            <div className="field">
              <label className="field__label" htmlFor="max-sessions">
                Concurrent builds
              </label>
              <input id="max-sessions" name="max-sessions" type="number" min={1} max={50} step={1} value={maxSessions} onChange={(event) => setMaxSessions(event.target.value)} className="field__input field__input--narrow" />
              <p className="field__hint">
                Build slots. Sessions, PR reviews, PR feedback runs and merge-conflict fixes all share this one pool.
                Anything beyond the cap waits in a single queue, in the order it was asked for — except a conflict fix,
                which is never queued and simply retries on the next scan.
              </p>
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
              <select id="build-model" name="build-model" value={buildModel} onChange={(event) => { setBuildModel(event.target.value); setAdvisorError(null); }} className="field__input">
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
            <div className="field">
              <label className="field__label" htmlFor="advisor-model">
                Advisor
              </label>
              <select id="advisor-model" name="advisor-model" value={advisorModel} onChange={(event) => { setAdvisorModel(event.target.value); setAdvisorError(null); }} className="field__input">
                <option value="">No advisor</option>
                {ADVISOR_MODELS.map((model) => (
                  <option key={model} value={model}>
                    {MODEL_LABELS[model]}
                  </option>
                ))}
              </select>
              {advisorError !== null && <p className="field__error">{advisorError}</p>}
              <p className="field__hint">
                A second model consulted during build runs only — planning, review and Sentry never use it. It spends extra tokens at the advisor model's own
                rates, and it is an experimental Claude Code feature.
              </p>
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

        <Panel
          title="Sentry"
          icon="alert"
          id="sentry"
          meta={storedSentry.configured ? <Badge tone="done">token ····{storedSentry.last4 ?? ''}</Badge> : <Badge tone="danger">no token</Badge>}
        >
          <div className="field">
            <label className="field__label" htmlFor="sentry-token">
              Auth token
            </label>
            <div className="field__pair">
              <input
                id="sentry-token"
                name="sentry-token"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={storedSentry.configured ? 'Leave blank to keep the current token' : 'sntryu_…'}
                value={sentryToken}
                onChange={(event) => setSentryToken(event.target.value)}
                className="field__input mono"
              />
              {storedSentry.configured && (
                <button type="button" className="button button--quiet button--danger" onClick={onRemoveSentryToken} disabled={busy !== null}>
                  {busy === 'remove-sentry' ? 'Removing…' : 'Remove'}
                </button>
              )}
            </div>
            <p className="field__hint">
              Reads unresolved issues of linked projects and resolves them once a fix is merged. A user auth token needs <code className="mono">event:read</code> and <code className="mono">event:write</code>. Stored write-only. Without a token nothing is polled.
            </p>
          </div>

          <div className="field__row">
            <div className="field">
              <label className="field__label" htmlFor="sentry-interval">
                Poll every (minutes)
              </label>
              <input id="sentry-interval" name="sentry-interval" type="number" min={1} max={1440} step={1} value={sentryInterval} onChange={(event) => setSentryInterval(event.target.value)} className="field__input field__input--narrow" />
              <p className="field__hint">How often linked projects are checked for new unresolved issues; a change applies from the next poll.</p>
            </div>
            <div className="field">
              <label className="field__label" htmlFor="sentry-model">
                Planning model
              </label>
              <select id="sentry-model" name="sentry-model" value={sentryModel} onChange={(event) => setSentryModel(event.target.value as AgentModel)} className="field__input">
                {AGENT_MODELS.map((model) => (
                  <option key={model} value={model}>
                    {MODEL_LABELS[model]}
                  </option>
                ))}
              </select>
              <p className="field__hint">One short call per new issue: it triages whether the issue can be fixed with a code change and writes the fix plan you approve. The fix itself runs on the build model.</p>
            </div>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="sentry-plans">
              Plans per poll
            </label>
            <input id="sentry-plans" name="sentry-plans" type="number" min={1} max={10} step={1} value={sentryPlans} onChange={(event) => setSentryPlans(event.target.value)} className="field__input field__input--narrow" />
            <p className="field__hint">How many issues are planned per poll, across every repository. The rest wait for a later poll, oldest first. This is the only spend that happens without you: nothing is built until you approve a plan.</p>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="sentry-base-url">
              API base URL
            </label>
            <input id="sentry-base-url" name="sentry-base-url" type="text" autoComplete="off" spellCheck={false} placeholder="https://sentry.io/api/0/" value={sentryBaseUrl} onChange={(event) => setSentryBaseUrl(event.target.value)} className="field__input mono" />
            <p className="field__hint">Only for self-hosted Sentry. Blank restores the hosted API.</p>
          </div>
        </Panel>

        <VoicePanel
          settings={settings}
          form={voiceForm}
          setForm={(change) => setVoiceForm((current) => (current === null ? current : change(current)))}
          openrouterKey={openrouterKey}
          setOpenrouterKey={setOpenrouterKey}
          elevenlabsKey={elevenlabsKey}
          setElevenlabsKey={setElevenlabsKey}
          slugProblems={slugProblems}
          setSlugProblems={setSlugProblems}
          busy={busy !== null}
          onRemoveKey={onRemoveVoiceKey}
        />

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
          <button type="button" className="button button--quiet" onClick={() => { applyLoaded(settings); setOpenrouterKey(''); setElevenlabsKey(''); setSlugProblems({}); }} disabled={busy !== null || !dirty} tabIndex={dirty ? 0 : -1}>
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

/**
 * Settings → Voice as the form edits it (voice US-001): numbers as the text
 * the inputs hold, "none" as the empty string, and the pronunciation map as
 * the JSON the operator types.
 */
export interface VoiceForm {
  enabled: boolean;
  sttProvider: VoiceSettings['sttProvider'];
  orSttModel: string;
  language: string;
  secondaryLanguage: string;
  keytermsEnabled: boolean;
  ttsModel: VoiceSettings['ttsModel'];
  voiceId: string;
  orTtsModel: string;
  orTtsVoice: string;
  orTtsSampleRate: string;
  chiefModel: string;
  sessionModel: AgentModel;
  vadSilenceMs: string;
  bargeIn: VoiceSettings['bargeIn'];
  eventVerbosity: VoiceSettings['eventVerbosity'];
  timezone: string;
  pronunciations: string;
  transcriptRetentionDays: string;
  pttGlobal: boolean;
  liveCaptions: VoiceSettings['liveCaptions'];
}

export function toVoiceForm(voice: VoiceSettings): VoiceForm {
  return {
    ...voice,
    secondaryLanguage: voice.secondaryLanguage ?? '',
    voiceId: voice.voiceId ?? '',
    orTtsSampleRate: String(voice.orTtsSampleRate),
    vadSilenceMs: String(voice.vadSilenceMs),
    pronunciations: JSON.stringify(voice.pronunciations, null, 2),
    transcriptRetentionDays: String(voice.transcriptRetentionDays),
  };
}

/** The whole-number fields, with the bounds the server enforces. */
const VOICE_NUMBERS = [
  { field: 'vadSilenceMs', label: 'End of speech after', min: 400, max: 2000 },
  { field: 'transcriptRetentionDays', label: 'Keep transcripts for', min: 1, max: 365 },
  { field: 'orTtsSampleRate', label: 'Backup voice sample rate', min: 8000, max: 48000 },
] as const;

/**
 * The form turned back into a settings update, or the first reason it cannot
 * be. The server validates all of it again; this only catches what would
 * otherwise cost a round trip to say.
 */
export function fromVoiceForm(form: VoiceForm): { voice: VoiceSettings } | { error: string } {
  const numbers: Partial<Record<(typeof VOICE_NUMBERS)[number]['field'], number>> = {};
  for (const { field, label, min, max } of VOICE_NUMBERS) {
    const value = Number(form[field]);
    if (form[field].trim() === '' || !Number.isInteger(value) || value < min || value > max) {
      return { error: `${label} must be a whole number between ${min} and ${max}.` };
    }
    numbers[field] = value;
  }
  let pronunciations: unknown;
  try {
    pronunciations = form.pronunciations.trim() === '' ? {} : JSON.parse(form.pronunciations);
  } catch {
    return { error: 'Pronunciations must be valid JSON, for example {"PRD": "P R D"}.' };
  }
  if (
    typeof pronunciations !== 'object' ||
    pronunciations === null ||
    Array.isArray(pronunciations) ||
    Object.values(pronunciations).some((value) => typeof value !== 'string')
  ) {
    return { error: 'Pronunciations must be a JSON object of strings, for example {"PRD": "P R D"}.' };
  }
  return {
    voice: {
      ...form,
      orSttModel: form.orSttModel.trim(),
      chiefModel: form.chiefModel.trim(),
      orTtsModel: form.orTtsModel.trim(),
      orTtsVoice: form.orTtsVoice.trim(),
      language: form.language.trim(),
      secondaryLanguage: form.secondaryLanguage.trim() === '' ? null : form.secondaryLanguage.trim(),
      timezone: form.timezone.trim(),
      voiceId: form.voiceId === '' ? null : form.voiceId,
      orTtsSampleRate: numbers.orTtsSampleRate ?? 24000,
      vadSilenceMs: numbers.vadSilenceMs ?? 800,
      transcriptRetentionDays: numbers.transcriptRetentionDays ?? 30,
      pronunciations: pronunciations as Record<string, string>,
    },
  };
}

/** The four OpenRouter names, as they would be saved. */
export function slugsOf(voice: Pick<VoiceSettings, keyof OpenRouterSlugs>): OpenRouterSlugs {
  return { orSttModel: voice.orSttModel, chiefModel: voice.chiefModel, orTtsModel: voice.orTtsModel, orTtsVoice: voice.orTtsVoice };
}

const STT_PROVIDER_LABELS: Record<VoiceSettings['sttProvider'], string> = {
  openrouter: 'OpenRouter, one request per utterance',
  'elevenlabs-realtime': 'ElevenLabs Scribe realtime (live captions, uses credits)',
  browser: 'Browser speech recognition (development only)',
};

const TTS_MODEL_LABELS: Record<VoiceSettings['ttsModel'], string> = {
  eleven_flash_v2_5: 'Flash v2.5: fastest, half the credits',
  eleven_turbo_v2_5: 'Turbo v2.5: a little slower, a little richer',
  eleven_multilingual_v2: 'Multilingual v2: best quality, slowest',
};

const BARGE_IN_LABELS: Record<VoiceSettings['bargeIn'], string> = {
  on: 'On: any speech interrupts',
  careful: 'Careful: only clear speech interrupts',
  off: 'Off: wait for the agent to finish',
};

const VERBOSITY_LABELS: Record<VoiceSettings['eventVerbosity'], string> = {
  important: 'Important: finished builds, failures, questions',
  all: 'All events',
  none: 'None',
};

const CAPTION_LABELS: Record<VoiceSettings['liveCaptions'], string> = {
  off: 'Off',
  browser: 'Browser speech recognition, captions only',
};

/** A check button's outcome, shown under the key it checked. */
interface CheckResult {
  readonly ok: boolean;
  readonly text: string;
}

const credits = new Intl.NumberFormat();

const MIC_TEST_MS = 3_000;

function VoicePanel({
  settings,
  form,
  setForm,
  openrouterKey,
  setOpenrouterKey,
  elevenlabsKey,
  setElevenlabsKey,
  slugProblems,
  setSlugProblems,
  busy,
  onRemoveKey,
}: {
  readonly settings: SettingsData;
  readonly form: VoiceForm;
  readonly setForm: (update: (form: VoiceForm) => VoiceForm) => void;
  readonly openrouterKey: string;
  readonly setOpenrouterKey: (value: string) => void;
  readonly elevenlabsKey: string;
  readonly setElevenlabsKey: (value: string) => void;
  readonly slugProblems: Partial<Record<keyof OpenRouterSlugs, string>>;
  readonly setSlugProblems: (problems: Partial<Record<keyof OpenRouterSlugs, string>>) => void;
  readonly busy: boolean;
  readonly onRemoveKey: (provider: 'openrouter' | 'elevenlabs') => void;
}) {
  const storedOpenrouter = settings.openrouterApiKey;
  const storedElevenlabs = settings.elevenlabsApiKey;
  const [checking, setChecking] = useState<'openrouter' | 'elevenlabs' | null>(null);
  const [openrouterCheck, setOpenrouterCheck] = useState<CheckResult | null>(null);
  const [elevenlabsCheck, setElevenlabsCheck] = useState<CheckResult | null>(null);
  const [micTest, setMicTest] = useState<'recording' | 'transcribing' | null>(null);
  const [micCheck, setMicCheck] = useState<CheckResult | null>(null);
  const [voices, setVoices] = useState<ElevenLabsVoice[] | null>(null);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [voicesLoading, setVoicesLoading] = useState(false);

  const set = <K extends keyof VoiceForm>(field: K, value: VoiceForm[K]): void => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const setSlug = (field: keyof OpenRouterSlugs, value: string): void => {
    set(field, value);
    if (slugProblems[field] !== undefined) setSlugProblems({ ...slugProblems, [field]: undefined });
  };

  // The picker's options come from the server, which asks ElevenLabs with the
  // stored key; a key typed but not saved yet cannot list anything.
  const loadVoices = useCallback((signal?: AbortSignal): void => {
    setVoicesLoading(true);
    fetchVoiceVoices(signal)
      .then((list) => {
        setVoices(list);
        setVoicesError(null);
      })
      .catch((error: unknown) => {
        if (signal?.aborted === true) return;
        if (redirectIfUnauthorised(error)) return;
        setVoicesError(describeError(error));
      })
      .finally(() => {
        if (signal?.aborted !== true) setVoicesLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!storedElevenlabs.configured) {
      setVoices(null);
      setVoicesError(null);
      return;
    }
    const controller = new AbortController();
    loadVoices(controller.signal);
    return () => controller.abort();
  }, [storedElevenlabs.configured, storedElevenlabs.last4, loadVoices]);

  const onCheckOpenrouter = (): void => {
    setChecking('openrouter');
    setOpenrouterCheck(null);
    const key = openrouterKey.trim();
    checkOpenRouterKey({ ...(key === '' ? {} : { key }), models: slugsOf(form) })
      .then((result) => {
        const problems: Partial<Record<keyof OpenRouterSlugs, string>> = {};
        for (const check of result.models) if (check.problem !== null) problems[check.field] = check.problem;
        setSlugProblems(problems);
        const bad = Object.keys(problems).length;
        const info = result.key;
        const balance =
          info === null
            ? ''
            : info.limitRemaining !== null
              ? ` $${info.limitRemaining.toFixed(2)} of its $${(info.limit ?? 0).toFixed(2)} limit left.`
              : info.usage !== null
                ? ` $${info.usage.toFixed(2)} spent so far, no limit set.`
                : '';
        setOpenrouterCheck({
          ok: bad === 0,
          text:
            `Key works${info?.label != null ? ` (${info.label})` : ''}.${balance} ` +
            (bad === 0 ? 'All four model names are usable.' : `${bad} model ${bad === 1 ? 'name is' : 'names are'} not usable; see below.`),
        });
      })
      .catch((error: unknown) => {
        if (redirectIfUnauthorised(error)) return;
        setOpenrouterCheck({ ok: false, text: describeError(error) });
      })
      .finally(() => setChecking(null));
  };

  const onCheckElevenlabs = (): void => {
    setChecking('elevenlabs');
    setElevenlabsCheck(null);
    const key = elevenlabsKey.trim();
    checkElevenLabsKey(key === '' ? undefined : key)
      .then((result) => {
        const reset = result.resetsAt === null ? '' : `, resets ${new Date(result.resetsAt).toLocaleDateString()}`;
        setElevenlabsCheck({
          ok: true,
          text: `Key works${result.tier === null ? '' : ` (${result.tier})`}: ${credits.format(result.remaining)} of ${credits.format(result.characterLimit)} credits left${reset}.`,
        });
      })
      .catch((error: unknown) => {
        if (redirectIfUnauthorised(error)) return;
        setElevenlabsCheck({ ok: false, text: describeError(error) });
      })
      .finally(() => setChecking(null));
  };

  // Three seconds from the microphone, transcribed with the saved key and
  // model exactly as a call's utterance would be.
  const onTestMicrophone = (): void => {
    setMicTest('recording');
    setMicCheck(null);
    recordWav(MIC_TEST_MS)
      .then((wav) => {
        setMicTest('transcribing');
        return testSpeechToText(wav);
      })
      .then((result) => {
        setMicCheck({
          ok: true,
          text: result.text === '' ? `Heard nothing (${String(result.ms)} ms).` : `“${result.text}” (${String(result.ms)} ms)`,
        });
      })
      .catch((error: unknown) => {
        if (redirectIfUnauthorised(error)) return;
        setMicCheck({ ok: false, text: describeError(error) });
      })
      .finally(() => setMicTest(null));
  };

  const pickedMissing = form.voiceId !== '' && voices !== null && !voices.some((voice) => voice.voiceId === form.voiceId);

  const slugField = (field: keyof OpenRouterSlugs, id: string, label: string, hint: string) => (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <input id={id} name={id} type="text" autoComplete="off" spellCheck={false} value={form[field]} onChange={(event) => setSlug(field, event.target.value)} className="field__input mono" />
      {slugProblems[field] !== undefined && <p className="field__error">{slugProblems[field]}</p>}
      <p className="field__hint">{hint}</p>
    </div>
  );

  const checkLine = (result: CheckResult | null) =>
    result === null ? null : <p className={result.ok ? 'field__hint' : 'field__error'}>{result.text}</p>;

  return (
    <Panel
      title="Voice"
      icon="comment"
      id="voice"
      meta={form.enabled ? <Badge tone="done">on</Badge> : <Badge>off</Badge>}
    >
      <div className="field">
        <label className="checkbox">
          <input type="checkbox" checked={form.enabled} onChange={(event) => set('enabled', event.target.checked)} />
          Enable voice calls with chief
        </label>
        <p className="field__hint">Needs an OpenRouter key; the ElevenLabs key is optional, without it the backup voice below speaks.</p>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="openrouter-key">
          OpenRouter API key {storedOpenrouter.configured && <span className="muted mono">····{storedOpenrouter.last4 ?? ''}</span>}
        </label>
        <div className="field__pair">
          <input id="openrouter-key" name="openrouter-key" type="password" autoComplete="off" spellCheck={false} placeholder={storedOpenrouter.configured ? 'Leave blank to keep the current key' : 'sk-or-v1-…'} value={openrouterKey} onChange={(event) => setOpenrouterKey(event.target.value)} className="field__input mono" />
          <button type="button" className="button" onClick={onCheckOpenrouter} disabled={busy || checking !== null || (openrouterKey.trim() === '' && !storedOpenrouter.configured)}>
            {checking === 'openrouter' ? 'Checking…' : 'Check OpenRouter key'}
          </button>
          {storedOpenrouter.configured && (
            <button type="button" className="button button--quiet button--danger" onClick={() => onRemoveKey('openrouter')} disabled={busy}>
              Remove
            </button>
          )}
        </div>
        {checkLine(openrouterCheck)}
        <p className="field__hint">Speech-to-text, chief's brain and the backup voice. Stored write-only; the check also validates the four model names below against OpenRouter's catalog.</p>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="elevenlabs-key">
          ElevenLabs API key {storedElevenlabs.configured && <span className="muted mono">····{storedElevenlabs.last4 ?? ''}</span>}
        </label>
        <div className="field__pair">
          <input id="elevenlabs-key" name="elevenlabs-key" type="password" autoComplete="off" spellCheck={false} placeholder={storedElevenlabs.configured ? 'Leave blank to keep the current key' : 'sk_…'} value={elevenlabsKey} onChange={(event) => setElevenlabsKey(event.target.value)} className="field__input mono" />
          <button type="button" className="button" onClick={onCheckElevenlabs} disabled={busy || checking !== null || (elevenlabsKey.trim() === '' && !storedElevenlabs.configured)}>
            {checking === 'elevenlabs' ? 'Checking…' : 'Check ElevenLabs key'}
          </button>
          {storedElevenlabs.configured && (
            <button type="button" className="button button--quiet button--danger" onClick={() => onRemoveKey('elevenlabs')} disabled={busy}>
              Remove
            </button>
          )}
        </div>
        {checkLine(elevenlabsCheck)}
        <p className="field__hint">The agents' voice. Stored write-only; the key never reaches this browser, the voice list below is fetched by the server.</p>
      </div>

      <div className="field__row">
        <div className="field">
          <label className="field__label" htmlFor="voice-id">
            Voice
          </label>
          <div className="field__pair">
            <select id="voice-id" name="voice-id" value={form.voiceId} onChange={(event) => set('voiceId', event.target.value)} className="field__input" disabled={voices === null && form.voiceId === ''}>
              <option value="">{storedElevenlabs.configured ? 'Not chosen' : 'Save an ElevenLabs key first'}</option>
              {pickedMissing && <option value={form.voiceId}>{form.voiceId} (not in your library)</option>}
              {voices === null && form.voiceId !== '' && <option value={form.voiceId}>{form.voiceId}</option>}
              {(voices ?? []).map((voice) => (
                <option key={voice.voiceId} value={voice.voiceId}>
                  {voice.name}
                  {voice.labels['accent'] === undefined ? '' : ` — ${voice.labels['accent']}`}
                  {voice.category === null ? '' : ` (${voice.category})`}
                </option>
              ))}
            </select>
            {storedElevenlabs.configured && (
              <button type="button" className="button button--quiet" onClick={() => loadVoices()} disabled={voicesLoading}>
                <Icon name="sync" />
                {voicesLoading ? 'Loading…' : 'Reload'}
              </button>
            )}
          </div>
          {voicesError !== null && <p className="field__error">{voicesError}</p>}
          <p className="field__hint">One voice for chief and every session agent.</p>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="voice-tts-model">
            ElevenLabs model
          </label>
          <select id="voice-tts-model" name="voice-tts-model" value={form.ttsModel} onChange={(event) => set('ttsModel', event.target.value as VoiceSettings['ttsModel'])} className="field__input">
            {VOICE_TTS_MODELS.map((model) => (
              <option key={model} value={model}>
                {TTS_MODEL_LABELS[model]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="field__row">
        <div className="field">
          <label className="field__label" htmlFor="voice-language">
            Language
          </label>
          <input id="voice-language" name="voice-language" type="text" maxLength={2} autoComplete="off" spellCheck={false} placeholder="nl" value={form.language} onChange={(event) => set('language', event.target.value.toLowerCase())} className="field__input field__input--narrow mono" />
          <p className="field__hint">Two-letter ISO 639-1 code, e.g. nl.</p>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="voice-secondary-language">
            Second language
          </label>
          <input id="voice-secondary-language" name="voice-secondary-language" type="text" maxLength={2} autoComplete="off" spellCheck={false} placeholder="none" value={form.secondaryLanguage} onChange={(event) => set('secondaryLanguage', event.target.value.toLowerCase())} className="field__input field__input--narrow mono" />
          <p className="field__hint">Blank for none.</p>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="voice-timezone">
            Time zone
          </label>
          <input id="voice-timezone" name="voice-timezone" type="text" autoComplete="off" spellCheck={false} placeholder="Europe/Amsterdam" value={form.timezone} onChange={(event) => set('timezone', event.target.value)} className="field__input mono" />
          <p className="field__hint">IANA name; what "tonight" and "tomorrow at 9" mean.</p>
        </div>
      </div>

      <div className="field__row">
        <div className="field">
          <label className="field__label" htmlFor="voice-stt-provider">
            Speech to text
          </label>
          <select id="voice-stt-provider" name="voice-stt-provider" value={form.sttProvider} onChange={(event) => set('sttProvider', event.target.value as VoiceSettings['sttProvider'])} className="field__input">
            {VOICE_STT_PROVIDERS.map((provider) => (
              <option key={provider} value={provider}>
                {STT_PROVIDER_LABELS[provider]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="voice-live-captions">
            Live captions
          </label>
          <select id="voice-live-captions" name="voice-live-captions" value={form.liveCaptions} onChange={(event) => set('liveCaptions', event.target.value as VoiceSettings['liveCaptions'])} className="field__input">
            {VOICE_LIVE_CAPTIONS.map((mode) => (
              <option key={mode} value={mode}>
                {CAPTION_LABELS[mode]}
              </option>
            ))}
          </select>
          <p className="field__hint">OpenRouter has no partial transcripts; this shows rough captions while you speak. The OpenRouter transcript still counts.</p>
        </div>
      </div>

      <div className="field">
        <label className="checkbox">
          <input type="checkbox" checked={form.keytermsEnabled} onChange={(event) => set('keytermsEnabled', event.target.checked)} />
          Send key terms to Scribe
        </label>
        <p className="field__hint">Scribe realtime only: session and repository names are recognised better, for about 20% more credits.</p>
      </div>

      <div className="field__row">
        {slugField('orSttModel', 'voice-or-stt-model', 'OpenRouter speech-to-text model', 'Any OpenRouter transcription model slug.')}
        {slugField('chiefModel', 'voice-chief-model', 'Chief model', 'Any OpenRouter chat model that supports tool calling.')}
      </div>

      <div className="field">
        <div className="field__pair">
          <button type="button" className="button" onClick={onTestMicrophone} disabled={busy || micTest !== null || !storedOpenrouter.configured}>
            {micTest === 'recording' ? 'Listening for 3 s…' : micTest === 'transcribing' ? 'Transcribing…' : 'Test microphone'}
          </button>
        </div>
        {checkLine(micCheck)}
        <p className="field__hint">Records three seconds and transcribes them with the saved OpenRouter key and speech-to-text model; shows what was heard and how long it took.</p>
      </div>

      <div className="field__row">
        {slugField('orTtsModel', 'voice-or-tts-model', 'Backup voice model', 'OpenRouter text-to-speech, used when ElevenLabs is out of credits or unreachable.')}
        {slugField('orTtsVoice', 'voice-or-tts-voice', 'Backup voice', "One of the backup model's voices.")}
        <div className="field">
          <label className="field__label" htmlFor="voice-or-tts-sample-rate">
            Backup voice sample rate (Hz)
          </label>
          <input id="voice-or-tts-sample-rate" name="voice-or-tts-sample-rate" type="number" min={8000} max={48000} step={1} value={form.orTtsSampleRate} onChange={(event) => set('orTtsSampleRate', event.target.value)} className="field__input field__input--narrow" />
        </div>
      </div>

      <div className="field__row">
        <div className="field">
          <label className="field__label" htmlFor="voice-session-model">
            Session agent model
          </label>
          <select id="voice-session-model" name="voice-session-model" value={form.sessionModel} onChange={(event) => set('sessionModel', event.target.value as AgentModel)} className="field__input">
            {AGENT_MODELS.map((model) => (
              <option key={model} value={model}>
                {MODEL_LABELS[model]}
              </option>
            ))}
          </select>
          <p className="field__hint">The Claude Code agent chief hands a call to for planning inside a session.</p>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="voice-vad-silence">
            End of speech after (ms)
          </label>
          <input id="voice-vad-silence" name="voice-vad-silence" type="number" min={400} max={2000} step={50} value={form.vadSilenceMs} onChange={(event) => set('vadSilenceMs', event.target.value)} className="field__input field__input--narrow" />
          <p className="field__hint">How long a pause ends what you are saying. Shorter answers faster; longer lets you think mid-sentence.</p>
        </div>
      </div>

      <div className="field__row">
        <div className="field">
          <label className="field__label" htmlFor="voice-barge-in">
            Interrupting the agent
          </label>
          <select id="voice-barge-in" name="voice-barge-in" value={form.bargeIn} onChange={(event) => set('bargeIn', event.target.value as VoiceSettings['bargeIn'])} className="field__input">
            {VOICE_BARGE_IN_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {BARGE_IN_LABELS[mode]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="voice-event-verbosity">
            Events chief mentions during a call
          </label>
          <select id="voice-event-verbosity" name="voice-event-verbosity" value={form.eventVerbosity} onChange={(event) => set('eventVerbosity', event.target.value as VoiceSettings['eventVerbosity'])} className="field__input">
            {VOICE_EVENT_VERBOSITIES.map((level) => (
              <option key={level} value={level}>
                {VERBOSITY_LABELS[level]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="voice-retention">
            Keep transcripts for (days)
          </label>
          <input id="voice-retention" name="voice-retention" type="number" min={1} max={365} step={1} value={form.transcriptRetentionDays} onChange={(event) => set('transcriptRetentionDays', event.target.value)} className="field__input field__input--narrow" />
        </div>
      </div>

      <div className="field">
        <label className="checkbox">
          <input type="checkbox" checked={form.pttGlobal} onChange={(event) => set('pttGlobal', event.target.checked)} />
          Push-to-talk works on every page
        </label>
        <p className="field__hint">Off: the push-to-talk key only works while the call panel has focus.</p>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="voice-pronunciations">
          Pronunciations
        </label>
        <textarea id="voice-pronunciations" name="voice-pronunciations" rows={7} spellCheck={false} value={form.pronunciations} onChange={(event) => set('pronunciations', event.target.value)} className="field__input mono" />
        <p className="field__hint">A JSON object of term → how to say it, applied to everything the agents speak. Empty it to turn it off.</p>
      </div>
    </Panel>
  );
}
