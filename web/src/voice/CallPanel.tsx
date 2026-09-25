import { type FormEvent, useEffect, useRef, useState } from 'react';

import { isEnded, useAppData } from '../data.tsx';
import { Icon, type IconName } from '../Icon.tsx';
import { Segmented } from '../ui.tsx';
import { type CallStatus, HTTPS_DOCS_URL, type TranscriptEntry, useCall } from './CallProvider.tsx';
import type { CallFocus, CallPhase, ConfirmationOutcome, ToolStatus } from './protocol.ts';
import { bindHoldToTalkButton } from './ptt.ts';

/**
 * The call panel (voice US-010): docked bottom-right at `lg`, a bottom sheet
 * below it. The header says who is listening and what they are doing, the
 * body is the live transcript with tool cards and confirmation pills, and the
 * footer holds every control. All of it reads {@link useCall}; closing the
 * panel only hides it, the call goes on.
 */

const PHASE_LABEL: Record<CallPhase, string> = {
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  ended: 'Call ended',
};

function statusLabel(status: CallStatus, phase: CallPhase): string {
  switch (status) {
    case 'idle':
      return 'Not in a call';
    case 'connecting':
      return 'Connecting…';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'ended':
      return 'Call ended';
    case 'live':
      return PHASE_LABEL[phase];
  }
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}

/** A tool's icon from its name; the verbs chief's tools are named with. */
function toolIcon(name: string): IconName {
  if (name.includes('build')) return 'rocket';
  if (name.includes('pull_request') || name.includes('pr_')) return 'git-pull-request';
  if (name.includes('recurring')) return 'clock';
  if (name.includes('repositor')) return 'repo';
  if (name.includes('session')) return 'terminal';
  if (name === 'show' || name === 'overview') return 'link-external';
  if (name === 'end_call') return 'sign-out';
  return 'zap';
}

const TOOL_STATUS_LABEL: Record<ToolStatus, string> = { running: 'running', ok: 'done', error: 'failed' };
const CONFIRM_OUTCOME_LABEL: Record<ConfirmationOutcome, string> = { confirmed: 'Confirmed', cancelled: 'Cancelled', expired: 'Expired' };

function focusValue(focus: CallFocus): string {
  return focus.kind === 'chief' ? 'chief' : `session:${focus.sessionId}`;
}

export function CallPanel() {
  const call = useCall();
  const { sessions } = useAppData();
  const [draft, setDraft] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const body = useRef<HTMLOListElement | null>(null);
  const holdButton = useRef<HTMLButtonElement | null>(null);

  const live = call.status === 'live' || call.status === 'reconnecting';
  const inCall = live || call.status === 'connecting';

  useEffect(() => {
    if (call.startedAt === null || !live) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [call.startedAt, live]);

  // Follow the newest line unless the operator scrolled up to read.
  useEffect(() => {
    const list = body.current;
    if (list === null) return;
    if (list.scrollHeight - list.scrollTop - list.clientHeight < 80) list.scrollTop = list.scrollHeight;
  }, [call.transcript]);

  const { ptt } = call;
  useEffect(() => {
    const button = holdButton.current;
    if (button === null) return;
    return bindHoldToTalkButton(
      button,
      () => ptt(true),
      () => ptt(false),
    );
  }, [ptt, call.panelOpen, inCall]);

  if (!call.panelOpen) return null;

  const focused = call.focusedOn;
  const focusName =
    focused.kind === 'chief'
      ? 'Chief'
      : ((sessions ?? []).find((session) => session.id === focused.sessionId)?.name ?? 'Session');
  const focusOptions = (sessions ?? []).filter(
    (session) => !isEnded(session) || (focused.kind === 'session' && focused.sessionId === session.id),
  );
  const status = statusLabel(call.status, call.phase);

  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (draft.trim() === '') return;
    call.text(draft);
    setDraft('');
  };

  return (
    <section
      className="call-panel"
      ref={call.panelRef}
      tabIndex={-1}
      aria-label="Call with chief"
    >
      <header className="call-panel__head">
        <span
          className={`call-ring call-ring--${call.status === 'live' ? call.phase : call.status}`}
          aria-hidden="true"
        >
          <Icon name="broadcast" />
        </span>
        <div className="call-panel__who">
          <label className="call-chip" title="Who you are talking to">
            <span className="visually-hidden">Talk to</span>
            <select
              className="call-chip__select"
              value={focusValue(call.focusedOn)}
              disabled={call.status !== 'live'}
              onChange={(event) => {
                const value = event.target.value;
                call.focus(value === 'chief' ? 'chief' : { sessionId: value.slice('session:'.length) });
              }}
            >
              <option value="chief">Chief</option>
              {focusOptions.map((session) => (
                <option key={session.id} value={`session:${session.id}`}>
                  {session.name}
                </option>
              ))}
            </select>
            <span className="call-chip__label">{focusName}</span>
            <Icon name="chevron-down" />
          </label>
          <span className="call-panel__status">
            {call.micOpen && (
              <span className="call-mic" title="The microphone is open">
                <span className="visually-hidden">Microphone open</span>
              </span>
            )}
            {status}
          </span>
        </div>
        <span className="call-panel__timer mono" aria-label="Call duration">
          {call.startedAt === null ? '0:00' : clock(now - call.startedAt)}
        </span>
        <button
          type="button"
          className="button button--icon button--quiet"
          onClick={call.closePanel}
          aria-label={inCall ? 'Hide the call panel (the call continues)' : 'Close the call panel'}
          title={inCall ? 'Hide (the call continues)' : 'Close'}
        >
          <Icon name="x" />
        </button>
        <span className="visually-hidden" aria-live="polite">
          {call.status === 'live' ? `${focusName}: ${status}` : status}
        </span>
      </header>

      {call.problem !== null && (
        <div className="call-panel__problem" role="alert">
          <Icon name="alert" />
          {call.problem.kind === 'insecure' ? (
            <p>
              The microphone only works over HTTPS (or on localhost), and this page was opened over plain HTTP.{' '}
              <a href={HTTPS_DOCS_URL} target="_blank" rel="noreferrer">
                How to serve chief over HTTPS
              </a>
              .
            </p>
          ) : call.problem.kind === 'in-progress' ? (
            <p>
              A call is already open in another tab.{' '}
              <button type="button" className="call-panel__link" onClick={() => call.start({ takeover: true })}>
                Take it over here
              </button>
            </p>
          ) : (
            <p>{call.problem.message}</p>
          )}
        </div>
      )}

      <ol className="call-transcript" ref={body} aria-label="Transcript">
        {call.transcript.length === 0 && (
          <li className="call-transcript__empty">
            {inCall ? 'Say something, or type below.' : 'Start a call to talk to chief from any page.'}
          </li>
        )}
        {call.transcript.map((entry) => (
          <TranscriptLine key={entry.key} entry={entry} onResolve={call.resolve} />
        ))}
      </ol>

      <footer className="call-panel__foot">
        <form className="call-panel__text" onSubmit={send}>
          <input
            className="field__input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={call.status === 'live' ? 'Type to chief…' : 'Not in a call'}
            aria-label="Message"
            disabled={call.status !== 'live'}
          />
          <button type="submit" className="button" disabled={call.status !== 'live' || draft.trim() === ''}>
            Send
          </button>
        </form>
        <div className="call-panel__controls">
          <button
            type="button"
            ref={holdButton}
            className={`button call-panel__talk${call.talking ? ' call-panel__talk--held' : ''}`}
            disabled={!call.micOpen && !call.talking}
            aria-pressed={call.talking}
            title="Hold to talk (or hold Space while the panel has focus)"
          >
            <Icon name="broadcast" />
            Hold to talk
          </button>
          <button
            type="button"
            className="button button--icon"
            aria-pressed={call.micMuted}
            aria-label={call.micMuted ? 'Unmute microphone' : 'Mute microphone'}
            title={call.micMuted ? 'Unmute microphone' : 'Mute microphone'}
            disabled={!inCall}
            onClick={() => call.muteMic(!call.micMuted)}
          >
            <Icon name={call.micMuted ? 'x-circle' : 'broadcast'} />
          </button>
          <button
            type="button"
            className="button button--icon"
            aria-pressed={call.voiceMuted}
            aria-label={call.voiceMuted ? 'Unmute voice' : 'Mute voice (text only)'}
            title={call.voiceMuted ? 'Unmute voice' : 'Mute voice (text only)'}
            onClick={() => call.muteVoice(!call.voiceMuted)}
          >
            <Icon name={call.voiceMuted ? 'mute' : 'unmute'} />
          </button>
          {live && (call.phase === 'thinking' || call.phase === 'speaking') && (
            <button
              type="button"
              className="button button--icon"
              aria-label="Stop the agent"
              title="Stop the agent (or talk over it, or hold to talk)"
              onClick={call.stopAgent}
            >
              <Icon name="stop" />
            </button>
          )}
          <span className="call-panel__spacer" />
          {inCall ? (
            <button type="button" className="button button--danger-solid" onClick={call.hangup}>
              Hang up
            </button>
          ) : (
            <button type="button" className="button button--primary" onClick={() => call.start()}>
              {call.status === 'ended' ? 'Call again' : 'Call chief'}
            </button>
          )}
        </div>
        <div className="call-panel__meta">
          <Segmented
            ariaLabel="Talk mode"
            value={call.mode}
            onChange={call.setMode}
            options={[
              { value: 'hands-free', label: 'Hands-free' },
              { value: 'push-to-talk', label: 'Push to talk' },
            ]}
          />
          {/* The usage meter proper is US-023. */}
          <span className="call-usage" title="Cost of this call so far">
            {call.usage === null
              ? 'Usage —'
              : `$${call.usage.orCostUsd.toFixed(3)} · ${String(call.usage.elCreditsUsed)} chars`}
          </span>
        </div>
      </footer>
    </section>
  );
}

function TranscriptLine({
  entry,
  onResolve,
}: {
  readonly entry: TranscriptEntry;
  readonly onResolve: (id: string, confirm: boolean) => void;
}) {
  switch (entry.kind) {
    case 'user':
      return (
        <li className="call-line call-line--user">
          <span className="call-line__who">You</span>
          <span className="call-line__text">{entry.text}</span>
        </li>
      );
    case 'agent':
      return (
        <li className="call-line call-line--agent">
          <span className="call-line__who">{entry.agent === 'chief' ? 'Chief' : 'Session'}</span>
          <span className="call-line__text">
            {entry.text}
            {entry.interrupted && <span className="call-line__cut"> (interrupted)</span>}
          </span>
        </li>
      );
    case 'tool':
      return (
        <li className={`call-tool call-tool--${entry.status}`}>
          <Icon name={toolIcon(entry.name)} />
          <span className="call-tool__name mono">{entry.name}</span>
          <span className="call-tool__summary">{entry.summary}</span>
          <span className="call-tool__state" title={TOOL_STATUS_LABEL[entry.status]}>
            {entry.status === 'running' ? (
              <span className="call-spinner" aria-hidden="true" />
            ) : (
              <Icon name={entry.status === 'ok' ? 'check' : 'x'} />
            )}
            <span className="visually-hidden">{TOOL_STATUS_LABEL[entry.status]}</span>
          </span>
        </li>
      );
    case 'confirm':
      return (
        <li className="call-confirm">
          <span className="call-confirm__prompt">{entry.prompt}</span>
          {entry.resolution === null ? (
            <span className="call-confirm__actions">
              <button type="button" className="button button--small button--primary" onClick={() => onResolve(entry.id, true)}>
                Confirm
              </button>
              <button type="button" className="button button--small" onClick={() => onResolve(entry.id, false)}>
                Cancel
              </button>
            </span>
          ) : (
            <span className="call-confirm__done">{CONFIRM_OUTCOME_LABEL[entry.resolution]}</span>
          )}
        </li>
      );
    case 'notice':
      return (
        <li className="call-notice">
          <Icon name="alert" />
          <span>{entry.text}</span>
        </li>
      );
  }
}
