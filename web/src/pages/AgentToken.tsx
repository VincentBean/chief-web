import { useEffect, useRef, useState } from 'react';

import {
  type AgentTokenStatus,
  fetchAgentToken,
  generateAgentToken,
  type GeneratedAgentToken,
  revokeAgentToken,
} from '../api.ts';
import { ConfirmDialog } from '../ConfirmDialog.tsx';
import { describeError, redirectIfUnauthorised } from '../data.tsx';
import { Icon } from '../Icon.tsx';
import { localTime } from '../schedule.ts';
import { useToast } from '../toast.tsx';
import { Badge, Notice, Panel, Skeleton } from '../ui.tsx';

const DOCS_URL = 'https://github.com/VincentBean/chief-web/blob/main/docs/send-to-chief.md';

/** The two lines a project's `.env` needs to reach this instance. */
export function envSnippet(token: string, publicUrl: string, origin: string): string {
  return `CHIEF_WEB_URL=${publicUrl === '' ? origin : publicUrl}\nCHIEF_WEB_API_TOKEN=${token}`;
}

/**
 * Settings → API token (send-to-chief US-003): the bearer token a local coding
 * agent's `/send-to-chief` skill uses.
 *
 * The plaintext lives in this component's state only — the server keeps a
 * hash — so leaving the page or reloading it loses it for good, which is the
 * point. Regenerate and revoke both kill the current token at once, so both
 * go through a confirmation.
 */
export function AgentTokenPanel() {
  const toast = useToast();
  const [status, setStatus] = useState<AgentTokenStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [generated, setGenerated] = useState<GeneratedAgentToken | null>(null);
  const [confirming, setConfirming] = useState<'regenerate' | 'revoke' | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const snippetRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchAgentToken(controller.signal)
      .then(setStatus)
      .catch((error: unknown) => {
        if (controller.signal.aborted || redirectIfUnauthorised(error)) return;
        setLoadError(describeError(error));
      });
    return () => controller.abort();
  }, []);

  const onGenerate = (): void => {
    const replacing = status?.configured === true;
    setBusy(true);
    generateAgentToken()
      .then((result) => {
        setGenerated(result);
        setCopied(false);
        setStatus({ configured: true, createdAt: result.createdAt, lastUsedAt: null });
        toast.ok(replacing ? 'Token regenerated. The previous token no longer works.' : 'Token generated.');
      })
      .catch((error: unknown) => toast.error(describeError(error)))
      .finally(() => {
        setBusy(false);
        setConfirming(null);
      });
  };

  const onRevoke = (): void => {
    setBusy(true);
    revokeAgentToken()
      .then(() => {
        setGenerated(null);
        setStatus({ configured: false, createdAt: null, lastUsedAt: null });
        toast.ok('Token revoked.');
      })
      .catch((error: unknown) => toast.error(describeError(error)))
      .finally(() => {
        setBusy(false);
        setConfirming(null);
      });
  };

  const snippet = generated === null ? '' : envSnippet(generated.token, generated.publicUrl, window.location.origin);

  // No clipboard API outside a secure context (plain HTTP to a LAN address):
  // select the lines instead, so a Ctrl+C is all that is left to do.
  const onCopy = (): void => {
    const fallback = (): void => {
      snippetRef.current?.select();
      toast.warn('The browser blocked the clipboard. The lines are selected: copy them by hand.');
    };
    if (navigator.clipboard === undefined) {
      fallback();
      return;
    }
    navigator.clipboard
      .writeText(snippet)
      .then(() => {
        setCopied(true);
        toast.ok('Copied the two .env lines.');
        window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(fallback);
  };

  const meta =
    status === null ? undefined : status.configured ? <Badge tone="done">configured</Badge> : <Badge tone="neutral">no token</Badge>;

  return (
    <Panel title="API token" icon="key" id="api-token" meta={meta}>
      <p className="field__hint">
        Lets a local coding agent send work to chief-web with the <code>/send-to-chief</code> skill. See{' '}
        <a className="link" href={DOCS_URL} target="_blank" rel="noreferrer">
          docs/send-to-chief.md
        </a>{' '}
        for setting it up in a project.
      </p>

      {loadError !== null && <Notice kind="error">Could not load the token status: {loadError}</Notice>}
      {loadError === null && status === null && <Skeleton lines={2} />}

      {generated !== null && (
        <div className="field">
          <label className="field__label" htmlFor="agent-token-value">
            New token
          </label>
          <input id="agent-token-value" className="field__input mono" readOnly value={generated.token} onFocus={(event) => event.target.select()} />
          <Notice kind="warn">This token is shown only once. Store it as CHIEF_WEB_API_TOKEN in your project's .env.</Notice>
          <label className="field__label" htmlFor="agent-token-env">
            Lines for <code>.env</code>
          </label>
          <textarea
            id="agent-token-env"
            ref={snippetRef}
            className="field__input field__textarea"
            readOnly
            rows={2}
            wrap="off"
            spellCheck={false}
            value={snippet}
            onFocus={(event) => event.target.select()}
          />
          <div className="field__actions">
            <button type="button" className="button button--primary" onClick={onCopy}>
              <Icon name={copied ? 'check' : 'copy'} />
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      {status !== null && !status.configured && (
        <div className="field__actions">
          <span className="field__hint">No token</span>
          <button type="button" className="button button--primary" onClick={onGenerate} disabled={busy}>
            <Icon name="key" />
            {busy ? 'Generating…' : 'Generate token'}
          </button>
        </div>
      )}

      {status !== null && status.configured && (
        <>
          <p className="field__hint">
            {status.createdAt === null ? 'Created at an unknown time' : `Created ${localTime(status.createdAt)}`} ·{' '}
            {status.lastUsedAt === null ? 'Never used' : `Last used ${localTime(status.lastUsedAt)}`}
          </p>
          <div className="field__actions">
            <button type="button" className="button" onClick={() => setConfirming('regenerate')} disabled={busy}>
              <Icon name="sync" />
              Regenerate
            </button>
            <button type="button" className="button button--quiet button--danger" onClick={() => setConfirming('revoke')} disabled={busy}>
              Revoke
            </button>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirming !== null}
        title={confirming === 'revoke' ? 'Revoke the API token?' : 'Regenerate the API token?'}
        confirmLabel={confirming === 'revoke' ? 'Revoke' : 'Regenerate'}
        busyLabel={confirming === 'revoke' ? 'Revoking…' : 'Regenerating…'}
        busy={busy}
        danger
        onConfirm={confirming === 'revoke' ? onRevoke : onGenerate}
        onCancel={() => setConfirming(null)}
      >
        <p>
          The current token stops working immediately: any agent still using it is refused until its <code>.env</code> has{' '}
          {confirming === 'revoke' ? 'a newly generated token' : 'the new token'}.
        </p>
      </ConfirmDialog>
    </Panel>
  );
}
