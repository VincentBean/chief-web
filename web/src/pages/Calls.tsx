import { useCallback, useEffect, useState } from 'react';

import {
  deleteVoiceCall,
  fetchVoiceCall,
  fetchVoiceCalls,
  type VoiceCallSummary,
  type VoiceTurn,
} from '../api.ts';
import { ConfirmDialog } from '../ConfirmDialog.tsx';
import { describeError, redirectIfUnauthorised } from '../data.tsx';
import { Icon } from '../Icon.tsx';
import { callIdFromPath, Link, navigate, useLocation } from '../router.tsx';
import { localTime } from '../schedule.ts';
import { useToast } from '../toast.tsx';
import { Badge, EmptyState, Notice, PageHeader, Skeleton } from '../ui.tsx';
import type { TranscriptEntry } from '../voice/CallProvider.tsx';
import { TranscriptLine } from '../voice/CallPanel.tsx';
import type { ToolStatus } from '../voice/protocol.ts';

/**
 * Call history (voice US-024): every stored call, newest first, and a
 * call's transcript rendered by the live panel's own {@link TranscriptLine}.
 * Audio is never stored, so the transcript is all there is; the retention
 * setting in Settings → Voice prunes it, and a call can be deleted here.
 */

const END_REASON_LABEL: Record<NonNullable<VoiceCallSummary['endReason']>, string> = {
  hangup: 'hung up',
  idle: 'idle',
  error: 'error',
  taken_over: 'taken over',
};

function duration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes === 0 ? `${String(rest)}s` : `${String(minutes)}m ${String(rest).padStart(2, '0')}s`;
}

function providers(call: VoiceCallSummary): string {
  return `${call.providers.stt} → ${call.providers.tts}`;
}

function cost(call: VoiceCallSummary): string {
  const parts = [`OR $${call.cost.orCostUsd.toFixed(2)}`];
  if (call.cost.elChars > 0) parts.push(`EL ${call.cost.elChars.toLocaleString()} chars`);
  if (call.cost.claudeTurns > 0) parts.push(`${String(call.cost.claudeTurns)} Claude turns`);
  return parts.join(' · ');
}

function callTitle(call: VoiceCallSummary): string {
  return `Call of ${localTime(call.startedAt)}`;
}

export function Calls() {
  const { pathname } = useLocation();
  const id = callIdFromPath(pathname);
  return id === null ? <CallList /> : <CallTranscript key={id} id={id} />;
}

/** The delete confirmation both views share. */
function useDeleteCall(onDeleted: (call: VoiceCallSummary) => void) {
  const toast = useToast();
  const [deleting, setDeleting] = useState<VoiceCallSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const confirm = (): void => {
    if (deleting === null) return;
    const call = deleting;
    setBusy(true);
    deleteVoiceCall(call.id)
      .then(() => {
        toast.ok(`Deleted the ${callTitle(call).toLowerCase()}.`);
        setDeleting(null);
        onDeleted(call);
      })
      .catch((error: unknown) => {
        if (redirectIfUnauthorised(error)) return;
        toast.error(describeError(error));
      })
      .finally(() => setBusy(false));
  };

  const dialog = (
    <ConfirmDialog
      open={deleting !== null}
      title={deleting === null ? '' : `Delete the ${callTitle(deleting).toLowerCase()}?`}
      confirmLabel="Delete call"
      busyLabel="Deleting…"
      busy={busy}
      danger
      onConfirm={confirm}
      onCancel={() => setDeleting(null)}
    >
      <p>Its transcript, tool calls and usage figures are removed for good. Nothing else changes.</p>
    </ConfirmDialog>
  );

  return { ask: setDeleting, dialog };
}

function CallList() {
  const [calls, setCalls] = useState<VoiceCallSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback((signal?: AbortSignal): void => {
    fetchVoiceCalls(100, signal)
      .then((loaded) => {
        setCalls(loaded);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (signal?.aborted === true) return;
        if (redirectIfUnauthorised(error)) return;
        setLoadError(describeError(error));
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const remove = useDeleteCall((call) =>
    setCalls((current) => (current ?? []).filter((candidate) => candidate.id !== call.id)),
  );

  return (
    <div className="page">
      <PageHeader
        title="Call history"
        subtitle="Past calls with chief and their transcripts. Audio is never stored; transcripts are kept for the days set in Settings → Voice."
      />

      {loadError !== null && <Notice kind="error">Could not read the call history: {loadError}</Notice>}

      {calls === null ? (
        <div className="panel">
          <div className="panel__body">
            <Skeleton lines={4} />
          </div>
        </div>
      ) : calls.length === 0 ? (
        <EmptyState icon="history" title="No calls yet">
          Calls you make to chief show up here with their transcript, until the retention period
          in Settings → Voice removes them.
        </EmptyState>
      ) : (
        <div className="table-wrap table-wrap--cards panel">
          <table className="table table--cards">
            <thead>
              <tr>
                <th>Started</th>
                <th>Duration</th>
                <th>Ended</th>
                <th>Providers</th>
                <th>Cost</th>
                <th className="table__actions">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {calls.map((call) => (
                <tr key={call.id}>
                  <td className="table__cell--lead">
                    <Link className="link link--strong" href={`/calls/${encodeURIComponent(call.id)}`}>
                      {localTime(call.startedAt)}
                    </Link>
                  </td>
                  <td data-label="Duration" className="mono">
                    {duration(call.durationSeconds)}
                  </td>
                  <td data-label="Ended">
                    <EndReason call={call} />
                  </td>
                  <td data-label="Providers" className="mono">
                    {providers(call)}
                  </td>
                  <td data-label="Cost">{cost(call)}</td>
                  <td className="table__actions table__cell--foot">
                    <div className="row__actions">
                      <button
                        type="button"
                        className="button button--small button--quiet button--danger button--icon"
                        onClick={() => remove.ask(call)}
                        disabled={call.active}
                        aria-label={`Delete the ${callTitle(call).toLowerCase()}`}
                        title={call.active ? 'Hang up before deleting this call' : 'Delete'}
                      >
                        <Icon name="trash" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {remove.dialog}
    </div>
  );
}

function EndReason({ call }: { readonly call: VoiceCallSummary }) {
  if (call.active) return <Badge tone="active" pulse>live</Badge>;
  if (call.endReason === null) return <span className="muted">—</span>;
  return call.endReason === 'error' ? (
    <Badge tone="danger">{END_REASON_LABEL.error}</Badge>
  ) : (
    <span>{END_REASON_LABEL[call.endReason]}</span>
  );
}

/** Milliseconds between two stored instants, or null when either is missing. */
function between(from: string | null | undefined, to: string | null | undefined): number | null {
  if (from == null || to == null) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** "first token 0.8 s · first audio 1.4 s" after the operator stopped talking. */
function latencyLine(turn: VoiceTurn, asked: VoiceTurn | undefined): string | null {
  const from = asked?.latency.speechEnd ?? asked?.latency.transcript ?? null;
  const parts: string[] = [];
  const token = between(from, turn.latency.firstToken);
  if (token !== null) parts.push(`first token ${seconds(token)}`);
  const audio = between(from, turn.latency.firstAudioPlayed ?? turn.latency.firstAudioSent);
  if (audio !== null) parts.push(`first audio ${seconds(audio)}`);
  return parts.length === 0 ? null : parts.join(' · ');
}

const TOOL_STATUSES: readonly ToolStatus[] = ['running', 'ok', 'error'];

interface HistoryLine {
  readonly entry: TranscriptEntry;
  readonly latency: string | null;
}

/** Stored turns as the live panel's entries; tool cards go before the reply they led to. */
function toEntries(turns: readonly VoiceTurn[]): HistoryLine[] {
  const asked = new Map<number, VoiceTurn>();
  for (const turn of turns) if (turn.speaker === 'user') asked.set(turn.turn, turn);

  return turns.flatMap((turn): HistoryLine[] => {
    const key = String(turn.id);
    switch (turn.speaker) {
      case 'user':
        return [{ entry: { kind: 'user', key: `u${key}`, turn: turn.turn, text: turn.text }, latency: null }];
      case 'event':
        return [{ entry: { kind: 'event', key: `e${key}`, text: eventText(turn) }, latency: null }];
      case 'chief':
      case 'session':
      case 'agent': {
        const tools = turn.tools.map((tool, i): HistoryLine => ({
          entry: {
            kind: 'tool' as const,
            key: `t${key}-${String(i)}`,
            id: `${key}-${String(i)}`,
            name: tool.name,
            status: TOOL_STATUSES.includes(tool.status as ToolStatus) ? (tool.status as ToolStatus) : 'ok',
            summary: tool.summary,
          },
          latency: null,
        }));
        if (turn.text === '') return tools;
        const who = turn.speaker === 'chief' ? undefined : (turn.sessionName ?? undefined);
        return [
          ...tools,
          {
            entry: {
              kind: 'agent' as const,
              key: `a${key}`,
              turn: turn.turn,
              // A detached turn is still the session's agent talking.
              agent: turn.speaker === 'agent' ? 'session' : turn.speaker,
              ...(who === undefined ? {} : { who }),
              text: turn.text,
              interrupted: turn.interrupted,
            },
            latency: latencyLine(turn, asked.get(turn.turn)),
          },
        ];
      }
    }
  });
}

/** `[focus] name` → "Now talking to name"; `[event] …` loses its tag. */
function eventText(turn: VoiceTurn): string {
  if (turn.text.startsWith('[focus] ')) return `Now talking to ${turn.text.slice('[focus] '.length)}`;
  return turn.text.replace(/^\[event\]\s*/, '');
}

function CallTranscript({ id }: { readonly id: string }) {
  const [call, setCall] = useState<VoiceCallSummary | null>(null);
  const [turns, setTurns] = useState<VoiceTurn[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchVoiceCall(id, controller.signal)
      .then((loaded) => {
        setCall(loaded.call);
        setTurns(loaded.turns);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (redirectIfUnauthorised(error)) return;
        setLoadError(describeError(error));
      });
    return () => controller.abort();
  }, [id]);

  const remove = useDeleteCall(() => navigate('/calls', { replace: true }));
  const entries = turns === null ? [] : toEntries(turns);

  return (
    <div className="page">
      <PageHeader
        back={{ href: '/calls', label: 'Call history' }}
        title={call === null ? 'Call' : callTitle(call)}
        subtitle={
          call === null
            ? undefined
            : `${duration(call.durationSeconds)} · ${providers(call)} · ${cost(call)}`
        }
        actions={
          call !== null && (
            <button
              type="button"
              className="button button--danger"
              onClick={() => remove.ask(call)}
              disabled={call.active}
              title={call.active ? 'Hang up before deleting this call' : undefined}
            >
              <Icon name="trash" />
              Delete
            </button>
          )
        }
      />

      {loadError !== null && <Notice kind="error">Could not read this call: {loadError}</Notice>}

      {turns === null ? (
        loadError === null && (
          <div className="panel">
            <div className="panel__body">
              <Skeleton lines={6} />
            </div>
          </div>
        )
      ) : (
        <div className="panel call-history__transcript">
          <ol className="call-transcript" aria-label="Transcript">
            {entries.length === 0 && <li className="call-transcript__empty">Nothing was said on this call.</li>}
            {entries.map(({ entry, latency }) => [
              <TranscriptLine key={entry.key} entry={entry} onResolve={() => undefined} />,
              latency !== null && (
                <li key={`${entry.key}-latency`} className="call-history__latency">
                  {latency}
                </li>
              ),
            ])}
          </ol>
        </div>
      )}

      {remove.dialog}
    </div>
  );
}
