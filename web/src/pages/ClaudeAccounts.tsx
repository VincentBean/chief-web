import { type KeyboardEvent, lazy, Suspense, useEffect, useState } from 'react';

import {
  addClaudeAccount,
  checkClaudeAccount,
  type ClaudeAccountBindings,
  type ClaudeAccountStatus,
  claudeAccountStatus,
  claudeNeedsSignIn,
  type ClaudeState,
  type ClaudeUsageWindow,
  fetchClaudeAccountBindings,
  fetchClaudeState,
  makeDefaultClaudeAccount,
  removeClaudeAccount,
  renameClaudeAccount,
  startClaudeLogin,
  stopClaudeLogin,
} from '../api.ts';
import { ConfirmDialog } from '../ConfirmDialog.tsx';
import { DESKTOP_QUERY, describeError, useAppData, useMediaQuery } from '../data.tsx';
import { Icon } from '../Icon.tsx';
import { resetsIn } from '../schedule.ts';
import { useToast } from '../toast.tsx';
import { Badge, EmptyState, Gauge, Notice, Panel, Skeleton } from '../ui.tsx';

// xterm.js only matters once an operator actually signs an account in.
const TerminalPane = lazy(() => import('../TerminalPane.tsx').then((module) => ({ default: module.TerminalPane })));

type Action = 'add' | 'login' | 'stop' | 'check' | 'check-all' | 'default' | 'rename' | 'remove';

/** What is running, and for which account (`null` for panel-wide actions). */
interface Busy {
  readonly action: Action;
  readonly accountId: string | null;
}

/** The account the Remove dialog is open for, with what is bound to it once known. */
interface Removing {
  readonly account: ClaudeAccountStatus;
  readonly bindings: ClaudeAccountBindings | null;
}

/** The nickname, else the email, else the bare id of an account never signed in. */
export function claudeAccountName(account: Pick<ClaudeAccountStatus, 'id' | 'nickname' | 'email'>): string {
  return account.nickname ?? account.email ?? `Account ${account.id.slice(0, 8)}`;
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Settings → Claude Code (multiple accounts US-006): one row per account with
 * its status, profile and plan usage, and the actions that add, rename, sign
 * in again, make default, check again and remove an account. The login
 * terminal of an add or a re-login opens inline below the list.
 *
 * Every change is pushed through `setClaude`, so the sidebar and the overview
 * follow without waiting for their own poll.
 */
export function ClaudeAccountsPanel() {
  const toast = useToast();
  const { claude, setClaude } = useAppData();
  const [busy, setBusy] = useState<Busy | null>(null);
  // Kept apart from `claude.login.active` so the pane stays on screen (and
  // readable) after the login process itself has exited.
  const [loginTerminal, setLoginTerminal] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ readonly id: string; readonly draft: string } | null>(null);
  const [removing, setRemoving] = useState<Removing | null>(null);
  // Below `lg` the login terminal is not rendered at all: mounting it would
  // open a WebSocket onto a PTY too narrow to read and impossible to paste
  // a code into. The login itself keeps running on the server.
  const desktop = useMediaQuery(DESKTOP_QUERY);

  useEffect(() => {
    const controller = new AbortController();
    // A login terminal survives a page reload, so an in-progress one is picked
    // back up rather than started again.
    fetchClaudeState({ signal: controller.signal })
      .then((state) => {
        setClaude(state);
        if (state.login.terminalId !== null) setLoginTerminal(state.login.terminalId);
      })
      .catch(() => {
        // The panel says "checking" until it can say more.
      });
    return () => controller.abort();
  }, [setClaude]);

  const run = (
    action: Action,
    accountId: string | null,
    work: () => Promise<{ ok: boolean; text: string } | null>,
  ): void => {
    setBusy({ action, accountId });
    work()
      .then((result) => {
        if (result !== null) toast.push(result.ok ? 'ok' : 'error', result.text);
      })
      .catch((error: unknown) => toast.error(describeError(error)))
      .finally(() => setBusy(null));
  };

  const isBusy = (action: Action, accountId: string | null = null): boolean =>
    busy?.action === action && busy.accountId === accountId;

  const withAccount = (state: ClaudeState, view: ClaudeAccountStatus): ClaudeState => ({
    ...state,
    accounts: state.accounts.map((account) => (account.id === view.id ? view : account)),
  });

  const onAdd = (): void => {
    run('add', null, async () => {
      const started = await addClaudeAccount();
      setClaude(await fetchClaudeState());
      setLoginTerminal(started.login.terminalId);
      return { ok: true, text: 'Login terminal ready. Open the URL it prints, then paste the code back.' };
    });
  };

  const onSignInAgain = (account: ClaudeAccountStatus): void => {
    run('login', account.id, async () => {
      const started = await startClaudeLogin(account.id);
      setClaude(await fetchClaudeState());
      setLoginTerminal(started.login.terminalId);
      return { ok: true, text: `Login terminal ready for ${claudeAccountName(account)}.` };
    });
  };

  const onCloseLogin = (): void => {
    run('stop', null, async () => {
      const accountId = claude?.login.accountId ?? null;
      const stopped = accountId === null ? null : await stopClaudeLogin(accountId);
      const state = await fetchClaudeState({ refresh: stopped === null });
      setClaude(state);
      setLoginTerminal(null);
      if (stopped !== null && stopped.account === null) {
        return { ok: false, text: 'The login was closed before it signed in; the account was not added.' };
      }
      return (stopped?.status ?? claudeAccountStatus(state, accountId))?.authenticated === true
        ? { ok: true, text: 'Claude Code is signed in.' }
        : { ok: false, text: 'The account is still not signed in.' };
    });
  };

  const onLoginExit = (): void => {
    fetchClaudeState({ refresh: true })
      .then((state) => {
        setClaude(state);
        const signedIn = claudeAccountStatus(state, state.login.accountId)?.authenticated === true;
        toast.push(
          signedIn ? 'ok' : 'error',
          signedIn
            ? 'Claude Code is signed in. Close the terminal to clean up.'
            : 'The login ended without signing in. Close the terminal and try again.',
        );
      })
      .catch((error: unknown) => toast.error(describeError(error)));
  };

  const onCheck = (account: ClaudeAccountStatus): void => {
    run('check', account.id, async () => {
      const view = await checkClaudeAccount(account.id);
      if (claude !== null) setClaude(withAccount(claude, view));
      return view.authenticated
        ? { ok: true, text: `${claudeAccountName(view)} is signed in.` }
        : { ok: false, text: view.error ?? `${claudeAccountName(view)} is not signed in.` };
    });
  };

  const onCheckAll = (): void => {
    run('check-all', null, async () => {
      setClaude(await fetchClaudeState({ refresh: true }));
      return null;
    });
  };

  const onMakeDefault = (account: ClaudeAccountStatus): void => {
    run('default', account.id, async () => {
      const { defaultAccountId } = await makeDefaultClaudeAccount(account.id);
      if (claude !== null) setClaude({ ...claude, defaultAccountId, defaultIsExplicit: true });
      return { ok: true, text: `${claudeAccountName(account)} is now the default account.` };
    });
  };

  const saveRename = (account: ClaudeAccountStatus): void => {
    if (renaming?.id !== account.id) return;
    const nickname = renaming.draft.trim() === '' ? null : renaming.draft.trim();
    setRenaming(null);
    if (nickname === account.nickname) return;
    run('rename', account.id, async () => {
      const saved = await renameClaudeAccount(account.id, nickname);
      if (claude !== null) setClaude(withAccount(claude, { ...account, nickname: saved.nickname }));
      return null;
    });
  };

  const onRenameKey = (event: KeyboardEvent<HTMLInputElement>, account: ClaudeAccountStatus): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveRename(account);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setRenaming(null);
    }
  };

  const onRemove = (account: ClaudeAccountStatus): void => {
    setRemoving({ account, bindings: null });
    fetchClaudeAccountBindings(account.id)
      .then((bindings) =>
        setRemoving((current) => (current?.account.id === account.id ? { account, bindings } : current)),
      )
      .catch((error: unknown) => {
        setRemoving(null);
        toast.error(describeError(error));
      });
  };

  const confirmRemove = (): void => {
    if (removing === null) return;
    const { account } = removing;
    run('remove', account.id, async () => {
      try {
        await removeClaudeAccount(account.id);
      } finally {
        setRemoving(null);
      }
      if (claude?.login.accountId === account.id) setLoginTerminal(null);
      setClaude(await fetchClaudeState());
      return { ok: true, text: `${claudeAccountName(account)} was removed.` };
    });
  };

  const accounts = claude?.accounts ?? null;
  const signedIn = accounts?.filter((account) => account.authenticated).length ?? 0;
  const loginAccount = claude === null ? null : claudeAccountStatus(claude, claude.login.accountId);
  const loginOpen = loginTerminal !== null;

  const addButton = (primary: boolean) => (
    <button
      type="button"
      className={primary ? 'button button--small button--primary' : 'button button--small'}
      onClick={onAdd}
      disabled={busy !== null || loginOpen}
    >
      <Icon name="plus" />
      {isBusy('add') ? 'Starting…' : 'Add account'}
    </button>
  );

  const usageWindow = (label: string, usage: ClaudeUsageWindow | null) =>
    usage === null ? null : (
      <span className="row__line">
        <span className="mono muted">{label}</span>
        <Gauge value={usage.utilization / 100} label={`${label} usage`} />
        <span>{`${String(Math.round(usage.utilization))}%`}</span>
        {usage.resetsAt !== null && <span className="muted">{resetsIn(usage.resetsAt)}</span>}
      </span>
    );

  return (
    <Panel
      title="Claude Code"
      icon="zap"
      id="claude"
      meta={
        accounts === null ? (
          <Badge>checking…</Badge>
        ) : accounts.length === 0 ? (
          <Badge tone="danger">no account</Badge>
        ) : (
          <Badge tone={signedIn > 0 ? 'done' : 'danger'}>{`${String(signedIn)} of ${plural(accounts.length, 'account')} signed in`}</Badge>
        )
      }
      actions={
        accounts !== null && accounts.length > 0 ? (
          <>
            {addButton(false)}
            <button type="button" className="button button--small button--quiet" onClick={onCheckAll} disabled={busy !== null}>
              <Icon name="sync" />
              {isBusy('check-all') ? 'Checking…' : 'Re-check all'}
            </button>
          </>
        ) : undefined
      }
    >
      {accounts === null ? (
        <Skeleton lines={3} />
      ) : accounts.length === 0 ? (
        !loginOpen && (
          <EmptyState icon="key" title="No Claude account" action={addButton(true)}>
            Sessions cannot be created until a Claude account is signed in. It is a browser login; the credentials are
            kept on the data volume and survive restarts.
          </EmptyState>
        )
      ) : (
        <ul className="rows rows--divided">
          {accounts.map((account) => {
            const isDefault = account.id === claude?.defaultAccountId;
            const expired = claudeNeedsSignIn(account.usage);
            const tone = account.error !== null ? 'wait' : account.authenticated && !expired ? 'done' : 'danger';
            const name = claudeAccountName(account);
            const profile = [account.email, account.organization, account.subscription].filter(
              (part): part is string => part !== null && part !== '',
            );
            const otherAccounts = accounts.length > 1;
            return (
              <li className="row row--stacked" key={account.id}>
                <div className="row__line">
                  <span className={`dot dot--${tone}`} title={account.authenticated ? 'signed in' : 'not signed in'} />
                  <div className="row__main">
                    {renaming?.id === account.id ? (
                      <input
                        className="field__input"
                        aria-label={`Nickname of ${name}`}
                        placeholder={account.email ?? 'Nickname'}
                        maxLength={100}
                        value={renaming.draft}
                        // Focus follows the operator's own click on Rename.
                        autoFocus
                        onChange={(event) => setRenaming({ id: account.id, draft: event.target.value })}
                        onBlur={() => saveRename(account)}
                        onKeyDown={(event) => onRenameKey(event, account)}
                      />
                    ) : (
                      <span className="row__title">
                        {name}
                        {isDefault && <Badge tone="active">{claude?.defaultIsExplicit === true ? 'Default' : 'Default (automatic)'}</Badge>}
                        {!account.authenticated && account.error === null && <Badge tone="danger">not signed in</Badge>}
                        {expired && <Badge tone="danger">sign in again</Badge>}
                      </span>
                    )}
                    {profile.length > 0 && <span className="row__meta">{profile.join(' · ')}</span>}
                  </div>
                  <div className="row__actions">
                    <button
                      type="button"
                      className="button button--small button--quiet"
                      onClick={() => setRenaming({ id: account.id, draft: account.nickname ?? '' })}
                      disabled={busy !== null || renaming?.id === account.id}
                    >
                      <Icon name="pencil" />
                      {isBusy('rename', account.id) ? 'Saving…' : 'Rename'}
                    </button>
                    <button
                      type="button"
                      className={account.authenticated && !expired ? 'button button--small' : 'button button--small button--primary'}
                      onClick={() => onSignInAgain(account)}
                      disabled={busy !== null || loginOpen}
                    >
                      <Icon name="key" />
                      {isBusy('login', account.id) ? 'Starting…' : 'Sign in again'}
                    </button>
                    {(!isDefault || claude?.defaultIsExplicit === false) && (
                      <button
                        type="button"
                        className="button button--small"
                        onClick={() => onMakeDefault(account)}
                        disabled={busy !== null}
                      >
                        <Icon name="check" />
                        {isBusy('default', account.id) ? 'Saving…' : 'Make default'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="button button--small button--quiet button--danger"
                      onClick={() => onRemove(account)}
                      disabled={busy !== null || (isDefault && otherAccounts)}
                      title={isDefault && otherAccounts ? 'Make another account the default first' : undefined}
                    >
                      <Icon name="trash" />
                      Remove
                    </button>
                  </div>
                </div>
                {account.error !== null && (
                  <div className="row__line">
                    <p className="field__hint">Status check failed: {account.error}</p>
                    <span className="toolbar__spacer" />
                    <button type="button" className="button button--small" onClick={() => onCheck(account)} disabled={busy !== null}>
                      <Icon name="sync" />
                      {isBusy('check', account.id) ? 'Checking…' : 'Check again'}
                    </button>
                  </div>
                )}
                {expired ? (
                  <p className="field__hint">The login has expired and could not be refreshed: sign in again.</p>
                ) : (
                  account.usage !== null &&
                  (account.usage.fiveHour !== null || account.usage.sevenDay !== null) && (
                    <div className="row__meta row__line">
                      {usageWindow('5h', account.usage.fiveHour)}
                      {usageWindow('7d', account.usage.sevenDay)}
                    </div>
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}

      {loginOpen && (
        <div className="stack stack--tight">
          <div className="row__line">
            <span className="mono muted">
              {loginAccount === null ? (claude?.login.containerName ?? 'claude login') : `Signing in ${claudeAccountName(loginAccount)}`}
            </span>
            <span className="toolbar__spacer" />
            <button type="button" className="button button--small button--danger" onClick={onCloseLogin} disabled={busy !== null}>
              <Icon name="x" />
              {isBusy('stop') ? 'Closing…' : 'Close login terminal'}
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

      <ConfirmDialog
        open={removing !== null}
        title={removing === null ? 'Remove account' : `Remove ${claudeAccountName(removing.account)}?`}
        confirmLabel="Remove account"
        busyLabel="Removing…"
        busy={removing !== null && isBusy('remove', removing.account.id)}
        confirmDisabled={removing?.bindings === null}
        danger
        onConfirm={confirmRemove}
        onCancel={() => setRemoving(null)}
      >
        {removing === null ? null : removing.bindings === null ? (
          <p className="muted">Counting what runs on this account…</p>
        ) : (
          <>
            <p>
              {plural(removing.bindings.sessions, 'session')} and {plural(removing.bindings.recurringTasks, 'recurring task')}{' '}
              {removing.bindings.sessions + removing.bindings.recurringTasks === 1 ? 'is' : 'are'} bound to this account.
              {removing.bindings.sessions + removing.bindings.recurringTasks > 0 && ' They will run on the default account instead.'}
            </p>
            <p className="muted">Its stored login is deleted; adding it again means signing in again.</p>
          </>
        )}
      </ConfirmDialog>
    </Panel>
  );
}
