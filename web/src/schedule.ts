/**
 * Scheduled starts, as the browser has to show them (US-017).
 *
 * The server stores an instant in UTC and knows nothing about where the
 * operator is; everything here is the translation to and from the one timezone
 * this browser is in. `datetime-local` has no timezone at all, so it is read
 * and written as wall-clock time and converted at the boundary.
 */

const SECOND = 1;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Times are shown on a 24-hour clock, whatever the browser's locale would
 * otherwise pick.
 *
 * The date keeps the visitor's own ordering — that is genuinely local
 * convention and getting it wrong is confusing — but the clock does not:
 * "starts at 7:30" is ambiguous on a page whose whole subject is when an
 * unattended build will run, and `h23` is the cycle that writes midnight as
 * `00:00` rather than `24:00`.
 */
const CLOCK: Intl.DateTimeFormatOptions = {
  dateStyle: 'medium',
  timeStyle: 'short',
  hourCycle: 'h23',
};

/** A stored UTC instant, shown in the visitor's own timezone, on a 24h clock. */
export function localTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, CLOCK);
}

/** The same clock, without the date: for things that happened today. */
export function localClock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString(undefined, { timeStyle: 'medium', hourCycle: 'h23' });
}

/**
 * The value a `datetime-local` input wants: `YYYY-MM-DDTHH:mm` in local time.
 * Empty for a timestamp that cannot be read, so a broken value clears the
 * field rather than wedging the form.
 */
export function toLocalInputValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** The two fields the schedule form shows, from a stored instant. */
export function toLocalInputParts(iso: string): { day: string; time: string } {
  const [day = '', time = ''] = toLocalInputValue(iso).split('T');
  return { day, time };
}

/**
 * `7:30` typed into the time box, as `07:30`; `null` for anything that is not
 * a time of day.
 *
 * The box is plain text rather than `<input type="time">` because a native
 * time control renders on whatever clock the *browser's* locale uses, and no
 * attribute a page can set overrides that — `lang` is honoured for it by some
 * engines and ignored by Chromium. A field whose whole purpose is to say when
 * an unattended build starts cannot be left to render as `7:30 PM` on one
 * machine and `19:30` on another, so this one is parsed here instead.
 */
export function normaliseTime(value: string): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  const pad = (part: number): string => String(part).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}`;
}

/** The UTC instant the day and time boxes mean here; null if either cannot be read. */
export function fromLocalParts(day: string, time: string): string | null {
  const normalised = normaliseTime(time);
  if (day === '' || normalised === null) return null;
  return fromLocalInputValue(`${day}T${normalised}`);
}

/** The UTC instant a `datetime-local` value means here; null if unreadable. */
export function fromLocalInputValue(value: string): string | null {
  if (value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * "starts in 3 h 12 min", or "overdue by 5 min" once the moment has passed.
 * Re-rendered by the pages' three-second poll rather than by a timer of its
 * own — a countdown that is at most three seconds stale is close enough, and
 * it costs nothing.
 */
export function startsIn(iso: string, now: number = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (Number.isNaN(ms)) return 'unknown';
  return ms >= 0 ? `starts in ${formatDuration(ms)}` : `overdue by ${formatDuration(-ms)}`;
}

/**
 * How long ago something happened, e.g. "2 h ago" — how stale a pull request
 * is. Reuses the same buckets as the scheduling copy so the two never disagree
 * about what "3 d" means.
 */
export function since(iso: string, now: number = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  if (Number.isNaN(ms)) return 'unknown';
  return ms < 60_000 ? 'just now' : `${formatDuration(ms)} ago`;
}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  if (total < MINUTE) return `${String(total)} s`;
  if (total < HOUR) return `${String(Math.floor(total / MINUTE))} min`;
  if (total < DAY) {
    const hours = Math.floor(total / HOUR);
    const minutes = Math.floor((total % HOUR) / MINUTE);
    return minutes === 0
      ? `${String(hours)} h`
      : `${String(hours)} h ${String(minutes)} min`;
  }
  const days = Math.floor(total / DAY);
  const hours = Math.floor((total % DAY) / HOUR);
  return hours === 0 ? `${String(days)} d` : `${String(days)} d ${String(hours)} h`;
}
