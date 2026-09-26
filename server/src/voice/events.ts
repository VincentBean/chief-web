import { EventEmitter } from 'node:events';

import { type Database, getRepository, listSessions } from '../db/index.js';
import { logger } from '../lib/logger.js';
import type { VOICE_EVENT_VERBOSITIES } from '../settings/index.js';

export type VoiceEventVerbosity = (typeof VOICE_EVENT_VERBOSITIES)[number];

/**
 * What happened in the background while a call may be running (voice US-015;
 * docs/voice-plan.md §12). Each source emits the facts; {@link describeEvent} is the one
 * place that turns them into the sentence the panel toasts and chief reads.
 */
export type VoiceBusEvent =
  | {
      readonly kind: 'session.setup';
      readonly sessionId: string;
      readonly name: string;
      readonly ok: boolean;
      /** Why setup failed; `null` when it succeeded. */
      readonly message: string | null;
    }
  | {
      readonly kind: 'build.story_done';
      readonly sessionId: string;
      readonly name: string;
      readonly storyId: string;
      readonly done: number;
      readonly total: number;
    }
  | { readonly kind: 'build.finished'; readonly sessionId: string; readonly name: string; readonly stories: number }
  | { readonly kind: 'build.failed'; readonly sessionId: string; readonly name: string; readonly message: string }
  | { readonly kind: 'build.waiting'; readonly sessionId: string; readonly name: string; readonly until: string }
  | {
      readonly kind: 'pr.opened';
      readonly sessionId: string;
      readonly name: string;
      readonly number: number;
      readonly adopted: boolean;
    }
  | { readonly kind: 'prd.valid'; readonly sessionId: string; readonly name: string; readonly stories: number }
  | { readonly kind: 'limits.hold'; readonly until: string }
  | {
      readonly kind: 'pr.run_finished' | 'pr.review_finished' | 'pr.conflict_fixed';
      /** The session whose pull request it is, when chief-web opened it. */
      readonly sessionId: string | null;
      readonly repository: string;
      readonly number: number;
      readonly ok: boolean;
      /** Why it failed; `null` when it succeeded. */
      readonly message: string | null;
    }
  | { readonly kind: 'task.fired'; readonly sessionId: string; readonly task: string; readonly name: string };

export type VoiceEventKind = VoiceBusEvent['kind'];

/** What a service needs to report on the bus; every source takes it optionally. */
export interface VoiceEventSink {
  publish(event: VoiceBusEvent): void;
}

/**
 * The bus between the services and the call (docs/voice-plan.md §12): a small
 * `EventEmitter` on one channel. Publishing never throws into the service
 * that reported, whatever a listener does.
 */
export class VoiceEventBus extends EventEmitter implements VoiceEventSink {
  publish(event: VoiceBusEvent): void {
    try {
      this.emit('event', event);
    } catch (cause) {
      logger.warn('a voice event listener failed', { kind: event.kind, error: String(cause) });
    }
  }

  /** Listens to every event; returns the unsubscribe. */
  subscribe(listener: (event: VoiceBusEvent) => void): () => void {
    this.on('event', listener);
    return () => {
      this.off('event', listener);
    };
  }
}

/**
 * Which verbosity first speaks each kind. `important` is the default setting;
 * `all` adds the rest. `pr.review_finished` and `prd.valid` are not named in
 * the story's `important` list, so they are `all`.
 */
export const EVENT_TIERS: Readonly<Record<VoiceEventKind, 'important' | 'all'>> = {
  'session.setup': 'important',
  'build.finished': 'important',
  'build.failed': 'important',
  'pr.opened': 'important',
  'pr.run_finished': 'important',
  'pr.conflict_fixed': 'important',
  'limits.hold': 'important',
  'build.story_done': 'all',
  'build.waiting': 'all',
  'task.fired': 'all',
  'pr.review_finished': 'all',
  'prd.valid': 'all',
};

/** Whether `voice_event_verbosity` lets chief speak this kind. */
export function isAnnounced(kind: VoiceEventKind, verbosity: VoiceEventVerbosity): boolean {
  if (verbosity === 'none') return false;
  return verbosity === 'all' || EVENT_TIERS[kind] === 'important';
}

/** The session an event is about, or `null` (a hold, a pull request nobody's session opened). */
export function eventSessionId(event: VoiceBusEvent): string | null {
  return 'sessionId' in event ? event.sessionId : null;
}

/** The one-line sentence the panel toasts and chief is handed as `[event] …`. */
export function describeEvent(event: VoiceBusEvent, timeZone?: string): string {
  switch (event.kind) {
    case 'session.setup':
      return event.ok
        ? `${event.name} is cloned and ready to plan.`
        : `Setup of ${event.name} failed: ${clip(event.message ?? 'unknown error')}`;
    case 'build.story_done':
      return `${event.name} finished story ${event.storyId} (${String(event.done)} of ${String(event.total)} done).`;
    case 'build.finished':
      return `${event.name} finished building all ${String(event.stories)} stories.`;
    case 'build.failed':
      return `The build of ${event.name} failed: ${clip(event.message)}`;
    case 'build.waiting':
      return `${event.name} is waiting for Claude's usage limit until ${clockTime(event.until, timeZone)}.`;
    case 'pr.opened':
      return event.adopted
        ? `Pull request ${String(event.number)} for ${event.name} was already open and is adopted.`
        : `Pull request ${String(event.number)} is open for ${event.name}.`;
    case 'prd.valid':
      return `The PRD for ${event.name} has ${String(event.stories)} ${event.stories === 1 ? 'story' : 'stories'} and parses cleanly.`;
    case 'limits.hold':
      return `Claude hit its usage limit; builds resume at ${clockTime(event.until, timeZone)}.`;
    case 'pr.run_finished':
      return event.ok
        ? `The feedback run on ${event.repository} pull request ${String(event.number)} finished.`
        : `The feedback run on ${event.repository} pull request ${String(event.number)} failed: ${clip(event.message ?? 'unknown error')}`;
    case 'pr.review_finished':
      return event.ok
        ? `The review of ${event.repository} pull request ${String(event.number)} finished.`
        : `The review of ${event.repository} pull request ${String(event.number)} failed: ${clip(event.message ?? 'unknown error')}`;
    case 'pr.conflict_fixed':
      return event.ok
        ? `The merge conflicts on ${event.repository} pull request ${String(event.number)} are fixed.`
        : `Fixing the merge conflicts on ${event.repository} pull request ${String(event.number)} failed: ${clip(event.message ?? 'unknown error')}`;
    case 'task.fired':
      return `Recurring task ${event.task} fired as ${event.name}.`;
  }
}

/** A background event waiting in the call for a quiet moment (docs/voice-plan.md §5 `queue`). */
export interface VoiceEvent {
  readonly kind: VoiceEventKind;
  readonly text: string;
  readonly sessionId: string | null;
}

/**
 * The session whose pull request `number` in `repositoryId` is, found by the
 * URL delivery stored on it; `null` for a pull request chief-web did not open.
 */
export function sessionIdForPullRequest(db: Database, repositoryId: string, number: number): string | null {
  const suffix = `/pull/${String(number)}`;
  return listSessions(db, { repositoryId }).find((session) => session.prUrl?.endsWith(suffix) === true)?.id ?? null;
}

/** An error's first line, short enough to toast and to read aloud. */
function clip(message: string): string {
  const line = message.split('\n', 1)[0]?.trim() ?? '';
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

function clockTime(iso: string, timeZone: string | undefined): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone === undefined ? {} : { timeZone }) }).format(date);
  } catch {
    return iso;
  }
}

/**
 * The event for a pull request run that just ended (a feedback run, a review
 * or a conflict fix), or `null` while it has not: a stopped run goes back to
 * `pending` and says nothing.
 */
export function pullRequestOutcome(
  db: Database,
  kind: 'pr.run_finished' | 'pr.review_finished' | 'pr.conflict_fixed',
  row: { readonly repositoryId: string; readonly prNumber: number; readonly status: string; readonly lastError: string | null },
  succeeded: string,
): VoiceBusEvent | null {
  if (row.status !== succeeded && row.status !== 'failed') return null;
  const ok = row.status === succeeded;
  return {
    kind,
    sessionId: sessionIdForPullRequest(db, row.repositoryId, row.prNumber),
    repository: getRepository(db, row.repositoryId)?.name ?? row.repositoryId,
    number: row.prNumber,
    ok,
    message: ok ? null : row.lastError,
  };
}
