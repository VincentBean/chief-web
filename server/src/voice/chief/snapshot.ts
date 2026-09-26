import {
  countStories,
  failureStageLabel,
  findPrConflictFix,
  findPrReview,
  findPrRun,
  listPrConflictFixes,
  listPrReviews,
  listPrRuns,
  listRecurringTasks,
  listRepositories,
  listSessions,
  listStories,
  type Session,
} from '../../db/index.js';
import { getVoiceSettings } from '../../settings/index.js';
import type { CallFocus } from '../protocol.js';
import { type ChiefServices, orderActiveFirst, prNumberOf } from './tools.js';

/**
 * The STATE block of chief's system prompt (docs/voice-plan.md §9.3), rebuilt for every
 * request. Everything here is SQLite plus the pull request list the service
 * already has cached: nothing on the hot path asks GitHub or Docker. With it
 * in the prompt, "what's building?" and "anything need me?" need no tool.
 */

/** Sessions listed by name; the rest are counted. */
export const SNAPSHOT_MAX_SESSIONS = 15;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `2026-09-25 14:02` in `timeZone`. */
export function formatLocal(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}

/** A moment relative to `now`: `15:10` today, `2026-09-26 02:00` otherwise. */
function when(iso: string, now: Date, timeZone: string): string {
  const local = formatLocal(new Date(iso), timeZone);
  const today = formatLocal(now, timeZone).slice(0, 10);
  return local.startsWith(today) ? local.slice(11) : local;
}

function ago(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function describeSession(services: ChiefServices, session: Session, now: Date, timeZone: string): string {
  const { db } = services;
  const counts = countStories(db, session.id);
  const pr = prNumberOf(session.prUrl);
  const prText = pr === null ? '' : `, PR #${pr}`;
  switch (session.status) {
    case 'building': {
      const current = listStories(db, session.id).find((story) => story.status === 'in-progress');
      const story = current === undefined ? '' : ` (${current.storyId} "${oneLine(current.title, 60)}")`;
      return `building story ${Math.min(counts.done + 1, counts.total)}/${counts.total}${story}, updated ${ago(session.updatedAt, now)}`;
    }
    case 'waiting':
      return `waiting (usage limit)${session.waitingUntil === null ? '' : ` until ${when(session.waitingUntil, now, timeZone)}`}, ${counts.done}/${counts.total} stories done`;
    case 'pending':
      return counts.total === 0 ? 'pending, planning' : `pending, planning (${counts.total} stories so far)`;
    case 'ready':
      return `ready to build, ${counts.total} stories${session.scheduledStartAt === null ? '' : `, scheduled for ${when(session.scheduledStartAt, now, timeZone)}`}`;
    case 'failed': {
      const stage = session.failureStage === null ? '' : ` at ${failureStageLabel(session.failureStage)}`;
      const error = session.lastError === null ? '' : `: ${oneLine(session.lastError, 80)}`;
      return `failed${stage}${error}`;
    }
    case 'reviewing':
      return `code review running${prText}`;
    case 'fixing':
      return `fixing review feedback${prText}`;
    case 'pr-open':
      return `finished${prText} open`;
    case 'finished':
      return `finished, ${counts.done}/${counts.total} stories, no PR`;
    case 'merged':
      return `merged${prText}`;
  }
}

export interface SnapshotInput {
  readonly focus: CallFocus;
  readonly now: Date;
}

/** The STATE block, one fact per line. */
export function buildSnapshot(services: ChiefServices, input: SnapshotInput): string {
  const { db } = services;
  const { now } = input;
  const timeZone = getVoiceSettings(db).timezone;
  const lines: string[] = [];
  lines.push(`NOW ${formatLocal(now, timeZone)} ${timeZone}`);

  const repositories = listRepositories(db);
  const repoNames = new Map(repositories.map((repository) => [repository.id, repository.name]));
  lines.push(
    `REPOS: ${repositories.length === 0 ? 'none' : repositories.map((repository) => `${repository.name} (base ${repository.defaultBaseBranch})`).join(', ')}`,
  );

  const sessions = orderActiveFirst(listSessions(db));
  lines.push(`SESSIONS (active first, max ${SNAPSHOT_MAX_SESSIONS}):`);
  if (sessions.length === 0) lines.push('- none');
  for (const session of sessions.slice(0, SNAPSHOT_MAX_SESSIONS)) {
    const repo = repoNames.get(session.repositoryId) ?? '?';
    lines.push(`- ${session.name} [${repo}] ${describeSession(services, session, now, timeZone)}`);
  }
  if (sessions.length > SNAPSHOT_MAX_SESSIONS) lines.push(`- and ${sessions.length - SNAPSHOT_MAX_SESSIONS} older`);
  lines.push(...planningSessions(services));

  const pool = services.builds.pool();
  const queued = pool.queue.map((entry) => entry.label);
  lines.push(
    `QUEUE: ${pool.queued} queued${queued.length === 0 ? '' : ` (${queued.join(', ')})`}  SLOTS: ${pool.active}/${pool.max} busy${pool.slots.length === 0 ? '' : ` (${pool.slots.map((slot) => slot.label).join(', ')})`}`,
  );
  const hold = services.hold.until();
  if (hold !== null) lines.push(`USAGE LIMIT: Claude is on hold, builds resume at ${when(hold, now, timeZone)}`);

  lines.push(`NEEDS YOU: ${needsYou(services, sessions).join(', ') || 'nothing'}`);
  lines.push(...pullRequests(services, repoNames));
  lines.push(...recurring(services, repoNames, now, timeZone));

  const focus = input.focus;
  if (focus.kind === 'chief') lines.push('FOCUS: chief');
  else lines.push(`FOCUS: ${sessions.find((session) => session.id === focus.sessionId)?.name ?? focus.sessionId}`);
  return lines.join('\n');
}

/**
 * The planning sessions (voice multi-planning US-010): whether each is still
 * being briefed, drafting on its own, waiting on the operator, done or stuck,
 * and how many open questions its PRD has. Read off disk and the registry on
 * every request, so a session left waiting in an earlier call is here from
 * the first turn of the next one.
 */
function planningSessions(services: ChiefServices): string[] {
  if (services.planningStates === undefined) return [];
  const states = services.planningStates.listPlanningSessions();
  if (states.length === 0) return ['PLANNING SESSIONS: none'];
  const lines = [`PLANNING SESSIONS (latest first, max ${SNAPSHOT_MAX_SESSIONS}):`];
  for (const state of states.slice(0, SNAPSHOT_MAX_SESSIONS)) {
    const count = state.openQuestions.length;
    lines.push(`- ${state.sessionName} [${state.repositoryName}] ${state.state}, ${count} open question${count === 1 ? '' : 's'}`);
  }
  if (states.length > SNAPSHOT_MAX_SESSIONS) lines.push(`- and ${states.length - SNAPSHOT_MAX_SESSIONS} older`);
  return lines;
}

function needsYou(services: ChiefServices, sessions: readonly Session[]): string[] {
  const items: string[] = [];
  for (const session of sessions) {
    if (session.status === 'pending') items.push(`${session.name} (pending)`);
    else if (session.status === 'failed') items.push(`${session.name} (failed)`);
  }
  const { db } = services;
  for (const run of listPrRuns(db)) if (run.status === 'failed') items.push(`PR #${run.prNumber} feedback run failed`);
  for (const review of listPrReviews(db)) if (review.status === 'failed') items.push(`PR #${review.prNumber} review failed`);
  for (const fix of listPrConflictFixes(db)) if (fix.status === 'failed') items.push(`PR #${fix.prNumber} conflict fix failed`);
  return items;
}

function pullRequests(services: ChiefServices, repoNames: ReadonlyMap<string, string>): string[] {
  const list = services.pullRequests.cached();
  if (list === null) return ['PULL REQUESTS: not loaded yet'];
  const { db } = services;
  const lines: string[] = [];
  for (const repository of list.repositories) {
    for (const pull of repository.pullRequests) {
      const run = findPrRun(db, repository.repositoryId, pull.number);
      const review = findPrReview(db, repository.repositoryId, pull.number);
      const fix = findPrConflictFix(db, repository.repositoryId, pull.number);
      const extras = [
        pull.draft ? 'draft' : null,
        run === null ? null : `feedback run ${run.status}`,
        review === null ? null : `review ${review.status}`,
        fix === null ? null : `conflict fix ${fix.status}`,
      ].filter((extra): extra is string => extra !== null);
      const repo = repoNames.get(repository.repositoryId) ?? repository.repositoryName;
      lines.push(`- #${pull.number} [${repo}] "${oneLine(pull.title, 60)}"${extras.length === 0 ? '' : ` ${extras.join(', ')}`}`);
    }
  }
  return [`PULL REQUESTS (open, as of ${list.fetchedAt.slice(11, 16)} UTC): ${lines.length === 0 ? 'none' : ''}`.trimEnd(), ...lines];
}

function recurring(
  services: ChiefServices,
  repoNames: ReadonlyMap<string, string>,
  now: Date,
  timeZone: string,
): string[] {
  const horizon = now.getTime() + DAY_MS;
  const lines: string[] = [];
  for (const task of listRecurringTasks(services.db)) {
    const failed = task.lastOutcome === 'failed' || task.lastOutcome === 'fire-failed';
    const due = !task.paused && task.nextRunAt !== null && Date.parse(task.nextRunAt) <= horizon;
    if (!failed && !due) continue;
    const parts = [
      due && task.nextRunAt !== null ? `next run ${when(task.nextRunAt, now, timeZone)}` : null,
      task.paused ? 'paused' : null,
      failed ? 'last run failed' : null,
    ].filter((part): part is string => part !== null);
    lines.push(`- ${task.name} [${repoNames.get(task.repositoryId) ?? '?'}] ${parts.join(', ')}`);
  }
  return lines.length === 0 ? [] : ['RECURRING TASKS (due within 24h or failing):', ...lines];
}
