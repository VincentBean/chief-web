/**
 * Spoken start times for `schedule_start` (voice US-012): an ISO timestamp or
 * a phrase ("tonight at 2", "in 3 hours", "morgen om 9 uur") read in the
 * operator's `voice_timezone`. Anything that could mean two different moments
 * is refused as `ambiguous_time` rather than guessed, so chief asks again; the
 * confirmation prompt then reads the resolved time back.
 *
 * No date library: wall-clock times are converted with `Intl.DateTimeFormat`.
 */

export type TimeParse =
  | { readonly ok: true; readonly at: string }
  | { readonly ok: false; readonly reason: 'ambiguous_time' | 'past_time'; readonly message: string };

export interface TimeContext {
  readonly now: Date;
  readonly timeZone: string;
}

interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/* --------------------------------------------------------- zone arithmetic */

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The wall clock of `ms` in `timeZone`, as a UTC timestamp of those fields. */
function wallClock(ms: number, timeZone: string): number {
  let format = formatters.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, format);
  }
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return Date.UTC(
    parts['year'] as number,
    (parts['month'] as number) - 1,
    parts['day'] as number,
    parts['hour'] as number,
    parts['minute'] as number,
    parts['second'] as number,
  );
}

/** The instant a wall-clock time in `timeZone` names; two passes cover a DST edge. */
export function zonedToUtc(date: LocalDate, hour: number, minute: number, timeZone: string): Date {
  const wanted = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  let instant = wanted - (wallClock(wanted, timeZone) - wanted);
  instant += wanted - wallClock(instant, timeZone);
  return new Date(instant);
}

function localDate(at: Date, timeZone: string): LocalDate {
  const wall = new Date(wallClock(at.getTime(), timeZone));
  return { year: wall.getUTCFullYear(), month: wall.getUTCMonth() + 1, day: wall.getUTCDate() };
}

function addDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function weekday(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** "Saturday 26 September at 02:00" in `timeZone`, for reading a time back. */
export function speakTime(at: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long', day: 'numeric', month: 'long' }).format(at);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  return `${day} at ${time}`;
}

/* ------------------------------------------------------------ vocabulary */

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  a: 1, an: 1, one: 1, een: 1, 'één': 1,
  two: 2, twee: 2, three: 3, drie: 3, four: 4, vier: 4, five: 5, vijf: 5,
  six: 6, zes: 6, seven: 7, zeven: 7, eight: 8, acht: 8, nine: 9, negen: 9,
  ten: 10, tien: 10, eleven: 11, elf: 11, twelve: 12, twaalf: 12,
};

const WEEKDAYS: Readonly<Record<string, number>> = {
  sunday: 0, zondag: 0, monday: 1, maandag: 1, tuesday: 2, dinsdag: 2, wednesday: 3, woensdag: 3,
  thursday: 4, donderdag: 4, friday: 5, vrijdag: 5, saturday: 6, zaterdag: 6,
};

/** Which half of the clock a day-part word points at. */
type Period = 'morning' | 'afternoon' | 'evening' | 'night';

/** Day words: an offset from today, and the period they imply. */
const DAY_WORDS: readonly { readonly pattern: RegExp; readonly days: number; readonly period?: Period }[] = [
  { pattern: /\bovermorgen\b|\bday after tomorrow\b/, days: 2 },
  { pattern: /\bmorgenochtend\b|\btomorrow morning\b/, days: 1, period: 'morning' },
  { pattern: /\bmorgenmiddag\b|\btomorrow afternoon\b/, days: 1, period: 'afternoon' },
  { pattern: /\bmorgenavond\b|\btomorrow (?:evening|night)\b/, days: 1, period: 'evening' },
  { pattern: /\btomorrow\b|\bmorgen\b/, days: 1 },
  { pattern: /\btonight\b|\bvannacht\b/, days: 0, period: 'night' },
  { pattern: /\bvanavond\b|\bthis evening\b/, days: 0, period: 'evening' },
  { pattern: /\bvanochtend\b|\bvanmorgen\b|\bthis morning\b/, days: 0, period: 'morning' },
  { pattern: /\bvanmiddag\b|\bthis afternoon\b/, days: 0, period: 'afternoon' },
  { pattern: /\btoday\b|\bvandaag\b/, days: 0 },
  { pattern: /\byesterday\b|\bgisteren\b/, days: -1 },
];

const PERIOD_WORDS: readonly { readonly pattern: RegExp; readonly period: Period }[] = [
  { pattern: /\bin the morning\b|'s ?ochtends\b|'s ?morgens\b/, period: 'morning' },
  { pattern: /\bin the afternoon\b|'s ?middags\b/, period: 'afternoon' },
  { pattern: /\bin the evening\b|\bat night\b|'s ?avonds\b/, period: 'evening' },
  { pattern: /'s ?nachts\b/, period: 'night' },
];

function ambiguous(message: string): TimeParse {
  return { ok: false, reason: 'ambiguous_time', message };
}

/* ----------------------------------------------------------------- parse */

/**
 * `input` as an instant, relative to `ctx.now` in `ctx.timeZone`.
 *
 * - ISO: with an offset (`Z`, `+02:00`) it is taken as is; without one it is
 *   a wall-clock time in the zone.
 * - "in 3 hours", "in 20 minutes", "over 2 uur", "in half an hour".
 * - A day ("today", "tomorrow", "morgen", a weekday, "tonight") and/or a
 *   time ("at 2", "2:30 pm", "14:00", "om 9 uur", "half 3" = 02:30/14:30).
 *   A 1–12 o'clock time without am/pm or a day part is read on the 24-hour
 *   clock when it is Dutch ("9 uur") or written as "09:00"; otherwise it is
 *   ambiguous unless only one of its two readings is still ahead. A day with
 *   no time is ambiguous; a time with no day is the next time it comes round.
 */
export function parseStartTime(input: string, ctx: TimeContext): TimeParse {
  const text = input.trim().toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').replace(/[.,!?]+$/, '');
  if (text === '') return ambiguous('No time was given.');

  const iso = parseIso(text, ctx);
  if (iso !== null) return future(iso, ctx);

  const relative = /^(?:in|over|within) (?:(?:an? |een )?(half) (?:an? |een )?(?:hour|uur)|(\d+|[a-zé]+)(?: and a half| en een half|½)? (minutes?|mins?|minuten|minuut|hours?|hrs?|uur|uren))$/.exec(text);
  if (relative !== null) {
    if (relative[1] !== undefined) return future(new Date(ctx.now.getTime() + 30 * MINUTE), ctx);
    const amount = numberOf(relative[2] as string);
    if (amount === null) return ambiguous(`"${input}" is not a time I understand.`);
    const unit = (relative[3] as string).startsWith('m') ? MINUTE : HOUR;
    const half = /and a half|en een half|½/.test(text) ? 0.5 : 0;
    return future(new Date(ctx.now.getTime() + (amount + half) * unit), ctx);
  }

  const today = localDate(ctx.now, ctx.timeZone);
  let day: LocalDate | null = null;
  let period: Period | null = null;
  for (const word of DAY_WORDS) {
    if (word.pattern.test(text)) {
      day = addDays(today, word.days);
      period = word.period ?? null;
      break;
    }
  }
  if (day === null) {
    const name = Object.keys(WEEKDAYS).find((key) => new RegExp(`\\b${key}\\b`).test(text));
    if (name !== undefined) {
      const ahead = ((WEEKDAYS[name] as number) - weekday(today) + 7) % 7;
      if (ahead === 0) return ambiguous(`Today is ${name}: today or next week?`);
      day = addDays(today, ahead);
    }
  }
  for (const word of PERIOD_WORDS) if (word.pattern.test(text)) period = word.period;

  const clock = parseClock(text);
  if (clock === 'invalid') return ambiguous(`"${input}" is not a time I understand.`);
  if (clock === null) return ambiguous(day === null ? `"${input}" is not a time I understand.` : 'At what time?');

  let hours: number[];
  if (clock.meridiem !== null) {
    if (clock.hour < 1 || clock.hour > 12) return ambiguous(`"${input}" is not a time I understand.`);
    hours = [(clock.hour % 12) + (clock.meridiem === 'pm' ? 12 : 0)];
  } else if (period !== null && clock.hour <= 12) {
    hours = [byPeriod(clock.hour, period)];
  } else if (clock.hour === 0 || clock.hour > 12 || clock.literal) {
    hours = [clock.hour % 24];
  } else {
    hours = clock.hour === 12 ? [12, 0] : [clock.hour, clock.hour + 12];
  }

  // "tonight at 2" is 02:00 after midnight: the night belongs to the day it starts on.
  const candidates: Date[] = [];
  for (const hour of hours) {
    if (day !== null) {
      const onDay = period === 'night' && hour < 12 ? addDays(day, 1) : day;
      candidates.push(zonedToUtc(onDay, hour, clock.minute, ctx.timeZone));
    } else {
      const first = zonedToUtc(today, hour, clock.minute, ctx.timeZone);
      candidates.push(first.getTime() > ctx.now.getTime() ? first : zonedToUtc(addDays(today, 1), hour, clock.minute, ctx.timeZone));
    }
  }
  const ahead = candidates.filter((at) => at.getTime() > ctx.now.getTime());
  if (ahead.length > 1) {
    const [a, b] = ahead as [Date, Date];
    return ambiguous(`Do you mean ${speakTime(a, ctx.timeZone)} or ${speakTime(b, ctx.timeZone)}?`);
  }
  return future(ahead[0] ?? (candidates[0] as Date), ctx);
}

function future(at: Date, ctx: TimeContext): TimeParse {
  if (Number.isNaN(at.getTime())) return ambiguous('That is not a valid time.');
  if (at.getTime() <= ctx.now.getTime()) {
    return { ok: false, reason: 'past_time', message: `${speakTime(at, ctx.timeZone)} has already passed.` };
  }
  return { ok: true, at: at.toISOString() };
}

function numberOf(word: string): number | null {
  if (/^\d+$/.test(word)) return Number(word);
  return NUMBER_WORDS[word] ?? null;
}

function byPeriod(hour: number, period: Period): number {
  switch (period) {
    case 'morning':
      return hour % 12;
    case 'afternoon':
      return hour === 12 ? 12 : hour + 12;
    case 'evening':
      return hour === 12 ? 0 : hour < 6 ? hour : hour + 12;
    case 'night':
      // 1–5 is after midnight; 6–11 is still the evening before it.
      return hour === 12 ? 0 : hour <= 5 ? hour : hour + 12;
  }
}

function parseIso(text: string, ctx: TimeContext): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(z|[+-]\d{2}:?\d{2})?$/.exec(text);
  if (match === null) return null;
  const [, y, mo, d, h, mi, , zone] = match;
  if (h === undefined) return new Date(Number.NaN);
  if (zone !== undefined) return new Date(text.toUpperCase().replace(' ', 'T'));
  return zonedToUtc({ year: Number(y), month: Number(mo), day: Number(d) }, Number(h), Number(mi), ctx.timeZone);
}

interface Clock {
  readonly hour: number;
  readonly minute: number;
  readonly meridiem: 'am' | 'pm' | null;
  /** Said on the 24-hour clock: Dutch "uur", or a leading zero. */
  readonly literal: boolean;
}

function parseClock(text: string): Clock | 'invalid' | null {
  if (/\b(?:midnight|middernacht)\b/.test(text)) return { hour: 0, minute: 0, meridiem: null, literal: true };
  if (/\b(?:noon|midday)\b|\b12 uur 's middags\b/.test(text)) return { hour: 12, minute: 0, meridiem: null, literal: true };

  // Dutch "half 3" is half past two.
  const half = /\bhalf (\d{1,2}|[a-zé]+)\b/.exec(text);
  if (half !== null) {
    const next = numberOf(half[1] as string);
    if (next === null || next < 1 || next > 24) return 'invalid';
    return { hour: next - 1, minute: 30, meridiem: null, literal: /\buur\b/.test(text) };
  }

  const match = /(?:\b(?:at|om|by|rond) )?\b(\d{1,2})(?:[:.h](\d{2}))? ?(a\.?m\.?|p\.?m\.?)?(?= |$)( uur)?/.exec(text);
  if (match === null) {
    const word = /\b(?:at|om) ([a-zé]+)\b( uur)?/.exec(text);
    const hour = word === null ? null : numberOf(word[1] as string);
    if (word === null || hour === null) return null;
    return { hour, minute: 0, meridiem: null, literal: word[2] !== undefined };
  }
  const [, h, m, ampm, uur] = match;
  const hour = Number(h);
  const minute = m === undefined ? 0 : Number(m);
  if (hour > 24 || minute > 59) return 'invalid';
  return {
    hour,
    minute,
    meridiem: ampm === undefined ? null : ampm.startsWith('a') ? 'am' : 'pm',
    literal: uur !== undefined || (h as string).startsWith('0'),
  };
}
