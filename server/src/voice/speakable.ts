/**
 * Agent replies turned into text worth reading aloud (voice US-003, docs/voice-plan.md §8.2).
 *
 * The transcript on screen keeps the original markdown; only the copy that goes
 * to the TTS engine passes through here. {@link SentenceChunker} cuts a stream
 * of deltas into speakable segments as they arrive, and {@link toSpeakable}
 * runs a whole text through the same chunker, so both paths agree.
 *
 * The six rules:
 * 1. A code fence is never read; once it closes, "I've put the code on screen."
 * 2. Inline code keeps its content, but a path is shortened to its last
 *    segment: `server/src/sessions/service.ts` → "the sessions service".
 * 3. Markdown markers go (`**`, `__`, `#`, `>`, list markers, rules); a table
 *    becomes "I've put a table on screen."
 * 4. A URL becomes "a link on screen".
 * 5. `->`, `&`, `e.g.` and `i.e.` are spelled out, then the operator's
 *    `voice_pronunciations` map applies: whole words, case-sensitive.
 * 6. Numbers are left to the TTS engine.
 */

export type Pronunciations = Readonly<Record<string, string>>;

export const CODE_ON_SCREEN = "I've put the code on screen.";
export const TABLE_ON_SCREEN = "I've put a table on screen.";
const LINK_ON_SCREEN = 'a link on screen';

/** The first segment goes out early, on any pause, so speech starts quickly. */
const FIRST_MIN_CHARS = 40;
/** Later segments wait for a full sentence of at least this length. */
const NEXT_MIN_CHARS = 60;
/** A sentence that never ends is cut here, on the last space if there is one. */
const FORCE_CHARS = 280;

/** Extensions that make an inline-code word a file name rather than `obj.prop`. */
const FILE_EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonl', 'md', 'mdx',
  'yml', 'yaml', 'toml', 'ini', 'env', 'lock', 'css', 'scss', 'html', 'svg', 'png',
  'jpg', 'sql', 'sh', 'py', 'go', 'rs', 'php', 'rb', 'java', 'kt', 'swift', 'c', 'h',
  'cpp', 'txt', 'xml', 'log', 'vue', 'svelte', 'blade',
]);
const EXTENSION_PATTERN = [...FILE_EXTENSIONS].join('|');

/** Directories that say nothing about a file, skipped when naming its parent. */
const GENERIC_DIRS = new Set(['', '.', '..', '~', 'src', 'lib', 'dist', 'build', 'out']);

/** A fence opener or closer: up to three spaces, then three or more ``` or ~~~. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Runs a whole reply through the chunker and joins the segments. */
export function toSpeakable(text: string, pronunciations: Pronunciations = {}): string {
  const parts: string[] = [];
  const chunker = new SentenceChunker((segment) => parts.push(segment), pronunciations);
  chunker.push(text);
  chunker.flush();
  return parts.join(' ');
}

/**
 * Cuts streamed agent text into speakable segments. It reads its deltas and
 * never changes them; the transcript keeps the original text.
 *
 * Block structure (fences, tables) is recognised line by line, so a fence that
 * spans many deltas yields one "code on screen" sentence. Prose flows straight
 * into the sentence buffer; only the start of a line that could still turn into
 * a fence or a table row is held back until it can be classified.
 */
export class SentenceChunker {
  /** Raw text not yet classified. Starts at a line start when `atLineStart`. */
  private pending = '';
  private atLineStart = true;
  private mode: 'prose' | 'fence' | 'table' = 'prose';
  /** The fence marker that opened the current code block. */
  private fence = '';
  /** Prose waiting for a sentence boundary. */
  private buf = '';
  private bufAtLineStart = true;
  private first = true;
  private readonly pronounce: (text: string) => string;

  constructor(
    private readonly emit: (text: string) => void,
    pronunciations: Pronunciations = {},
  ) {
    this.pronounce = pronouncer(pronunciations);
  }

  push(delta: string): void {
    this.pending += delta;
    this.classify();
    this.scan();
  }

  /** Emits whatever is left: the end of the turn. */
  flush(): void {
    // A newline completes a half line, so it is classified like any other.
    this.push('\n');
    this.endBlock();
    this.out(this.buf, this.bufAtLineStart);
    this.pending = '';
    this.atLineStart = true;
    this.buf = '';
    this.bufAtLineStart = true;
    this.first = true;
  }

  /** Moves `pending` into the buffer, a block, or leaves it to wait for more. */
  private classify(): void {
    while (this.pending !== '') {
      const nl = this.pending.indexOf('\n');
      const line = nl === -1 ? null : this.pending.slice(0, nl + 1);

      if (this.mode === 'fence') {
        if (line === null) return;
        this.pending = this.pending.slice(line.length);
        if (closesFence(line, this.fence)) this.endBlock();
        continue;
      }

      if (this.mode === 'table') {
        const head = this.pending.trimStart();
        if (line === null && (head === '' || head.startsWith('|'))) return;
        if (line !== null && line.trim().startsWith('|')) {
          this.pending = this.pending.slice(line.length);
          continue;
        }
        this.endBlock();
        continue;
      }

      if (this.atLineStart) {
        const upToLine = line ?? this.pending;
        const head = upToLine.replace(/^[ \t]+/, '');
        const opener = FENCE.exec(upToLine);
        if (opener !== null || head.startsWith('|')) {
          this.out(this.buf, this.bufAtLineStart);
          this.buf = '';
          this.bufAtLineStart = true;
          if (opener === null) {
            this.mode = 'table';
            continue;
          }
          // The opener's info string (```ts) must be complete before the body.
          if (line === null) return;
          this.mode = 'fence';
          this.fence = opener[1] ?? '```';
          this.pending = this.pending.slice(line.length);
          continue;
        }
        // Too short to tell yet: blank so far, or a partial ``` / ~~~.
        if (line === null && (head === '' || /^(`{1,2}|~{1,2})$/.test(head))) return;
      }

      const taken = line ?? this.pending;
      if (this.buf === '') this.bufAtLineStart = this.atLineStart;
      this.buf += taken;
      this.pending = this.pending.slice(taken.length);
      this.atLineStart = taken.endsWith('\n');
    }
  }

  /** Leaves a fence or table, saying what went on screen instead. */
  private endBlock(): void {
    if (this.mode === 'prose') return;
    const sentence = this.mode === 'fence' ? CODE_ON_SCREEN : TABLE_ON_SCREEN;
    this.mode = 'prose';
    this.fence = '';
    this.atLineStart = true;
    this.say(sentence);
  }

  /** Emits every complete segment in the buffer. */
  private scan(): void {
    for (;;) {
      const end = boundary(this.buf, this.first ? FIRST_MIN_CHARS : NEXT_MIN_CHARS, this.first);
      if (end === null) break;
      this.cut(end);
    }
    while (this.buf.length >= FORCE_CHARS) {
      const space = this.buf.slice(0, FORCE_CHARS).search(/\s\S*$/);
      this.cut(space > 0 ? space + 1 : FORCE_CHARS);
    }
  }

  private cut(end: number): void {
    const segment = this.buf.slice(0, end);
    this.out(segment, this.bufAtLineStart);
    this.buf = this.buf.slice(end);
    this.bufAtLineStart = segment.endsWith('\n');
  }

  private out(raw: string, atLineStart: boolean): void {
    this.say(speakProse(raw, atLineStart, this.pronounce));
  }

  private say(text: string): void {
    const trimmed = text.trim();
    if (trimmed === '') return;
    this.first = false;
    this.emit(trimmed);
  }
}

/**
 * Where the first segment in `buf` ends (after its punctuation and the
 * whitespace behind it), or null to wait for more text. The punctuation must
 * sit at index `min` or later. A `.` followed by a lowercase letter or digit
 * (after optional spaces), or closing a dotted abbreviation, is no boundary;
 * a `.` with nothing after it yet waits, because the next delta decides.
 */
function boundary(buf: string, min: number, first: boolean): number | null {
  for (let i = min; i < buf.length; i++) {
    const c = buf[i] ?? '';
    if (c === '\n' && buf[i + 1] === '\n') return skipSpace(buf, i + 2);
    const pause = first ? ',;:—.!?' : '.!?';
    if (!pause.includes(c)) continue;
    const next = buf[i + 1];
    if (next === undefined) return null;
    if (!/\s/.test(next)) continue;
    if (c === '.') {
      const after = /\S/.exec(buf.slice(i + 1));
      if (after === null) return null;
      if (/[a-z0-9]/.test(after[0])) continue;
      if (/(?:^|[^\w.])(?:[A-Za-z]\.){2,}$/.test(buf.slice(0, i + 1))) continue;
    }
    return skipSpace(buf, i + 1);
  }
  return null;
}

function skipSpace(buf: string, from: number): number {
  let end = from;
  while (end < buf.length && /\s/.test(buf[end] ?? '')) end++;
  return end;
}

function closesFence(line: string, fence: string): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  const marker = m?.[1];
  return marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length;
}

/** Rules 2 to 5 on a piece of prose (no fences or tables left in it). */
function speakProse(raw: string, atLineStart: boolean, pronounce: (text: string) => string): string {
  const lines = raw
    .split('\n')
    .map((line, i) => (i > 0 || atLineStart ? stripLineMarkers(line) : line))
    .map((line) => pronounce(spellSymbols(stripInline(line))).replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '');
  // A line break without punctuation (a heading, a list item) is still a pause.
  return lines
    .map((line, i) => (i < lines.length - 1 && !/[.!?,;:]$/.test(line) ? `${line}.` : line))
    .join(' ');
}

function stripLineMarkers(line: string): string {
  if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) return '';
  return line
    .replace(/^\s{0,3}#{1,6}(?:\s+|$)/, '')
    .replace(/\s+#+\s*$/, '')
    .replace(/^\s*(?:>\s?)+/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '');
}

function stripInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<(?:https?:\/\/|www\.)[^>\s]*>/g, LINK_ON_SCREEN)
    .replace(/(?:https?:\/\/|www\.)[^\s<>()[\]`]*[^\s<>()[\]`.,;:!?'"]/g, LINK_ON_SCREEN)
    .replace(/(`+)([^`]+?)\1/g, (_match, _ticks: string, code: string) => speakCode(code.trim()))
    .replace(/`/g, '')
    .replace(new RegExp(`(?<![\\w/])(?:[\\w.-]+/)+[\\w.-]+\\.(?:${EXTENSION_PATTERN})\\b`, 'g'), shortenPath)
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(?<![\w*])\*(?=\S)([^*]*?\S)\*(?![\w*])/g, '$1')
    .replace(/(?<![\w_])_(?=\S)([^_]*?\S)_(?![\w_])/g, '$1')
    .replace(/\*\*|__|~~/g, '');
}

/** Inline code: a lone path or file name is shortened, anything else kept. */
function speakCode(code: string): string {
  return !/\s/.test(code) && looksLikePath(code) ? shortenPath(code) : code;
}

function looksLikePath(code: string): boolean {
  if (/[/\\]/.test(code) && /[A-Za-z]/.test(code)) return true;
  const dot = code.lastIndexOf('.');
  return dot > 0 && FILE_EXTENSIONS.has(code.slice(dot + 1).toLowerCase());
}

/** `server/src/sessions/service.ts` → "the sessions service". */
function shortenPath(path: string): string {
  const segments = path.split(/[/\\]/).filter((s) => s !== '');
  const last = segments.at(-1) ?? path;
  const dot = last.lastIndexOf('.');
  const hasExtension = dot > 0 && FILE_EXTENSIONS.has(last.slice(dot + 1).toLowerCase());
  const name = words(hasExtension ? last.slice(0, dot) : last);
  const parent = segments.at(-2);
  if (!hasExtension || parent === undefined || GENERIC_DIRS.has(parent)) return name;
  return `the ${words(parent)} ${name}`;
}

function words(segment: string): string {
  return segment.replace(/[._-]+/g, ' ').trim();
}

function spellSymbols(text: string): string {
  return text
    .replace(/\s*->\s*/g, ' to ')
    .replace(/\s+&\s+/g, ' and ')
    .replace(/(?<![\w.])e\.g\.(?![\w])/gi, 'for example')
    .replace(/(?<![\w.])i\.e\.(?![\w])/gi, 'that is');
}

/**
 * The operator's pronunciation map as one replace. A term matches as a whole
 * word, case-sensitively: an edge that is a word character must not touch
 * another word character, nor a `.` or `/` joining it to one (`prd.md`). The
 * longest term wins where two start at the same place (`PRD` over `PR`), and
 * replacements are never matched again.
 */
function pronouncer(pronunciations: Pronunciations): (text: string) => string {
  const terms = Object.keys(pronunciations)
    .filter((term) => term !== '')
    .sort((a, b) => b.length - a.length);
  if (terms.length === 0) return (text) => text;
  const alternatives = terms.map((term) => {
    const lead = /^\w/.test(term) ? '(?<!\\w|\\w[./])' : '';
    const trail = /\w$/.test(term) ? '(?!\\w|[./]\\w)' : '';
    return `${lead}${escapeRegExp(term)}${trail}`;
  });
  const re = new RegExp(alternatives.join('|'), 'g');
  return (text) => text.replace(re, (term) => pronunciations[term] ?? term);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A planning session as {@link waitingSummary} names it (US-009). */
export interface WaitingSession {
  readonly sessionName: string;
  readonly repositoryName: string;
  readonly state: 'briefing' | 'drafting' | 'waiting' | 'done' | 'failed';
  readonly openQuestions: number;
}

/**
 * One sentence on the other planning sessions (US-009): "Billing export on
 * shop-api is waiting with 4 open questions, and search on webshop is done."
 * Sessions still briefing or drafting are named only when none is waiting,
 * done or failed; `''` when there is nothing to say. Names are left as they
 * are, so the pronunciation map still matches them when the line is spoken.
 */
export function waitingSummary(language: string, sessions: readonly WaitingSession[]): string {
  const nl = language === 'nl';
  const on = (session: WaitingSession): string => `${session.sessionName} ${nl ? 'op' : 'on'} ${session.repositoryName}`;
  const settled = sessions.filter((session) => session.state === 'waiting' || session.state === 'done' || session.state === 'failed');
  if (settled.length > 0) {
    const clauses = settled.map((session) => {
      const count = session.openQuestions;
      switch (session.state) {
        case 'waiting':
          if (count <= 0) return nl ? `${on(session)} wacht op je` : `${on(session)} is waiting`;
          return nl
            ? `${on(session)} wacht met ${String(count)} ${count === 1 ? 'open vraag' : 'open vragen'}`
            : `${on(session)} is waiting with ${String(count)} open ${count === 1 ? 'question' : 'questions'}`;
        case 'failed':
          return nl ? `${on(session)} is vastgelopen` : `${on(session)} has failed`;
        default:
          return nl ? `${on(session)} is klaar` : `${on(session)} is done`;
      }
    });
    return `${joinList(clauses, nl, true)}.`;
  }
  const drafting = sessions.filter((session) => session.state === 'briefing' || session.state === 'drafting');
  if (drafting.length === 0) return '';
  const names = joinList(drafting.map(on), nl, false);
  if (nl) return `${names} ${drafting.length === 1 ? 'is' : 'zijn'} nog aan het schrijven.`;
  return `${names} ${drafting.length === 1 ? 'is' : 'are'} still drafting.`;
}

/** "a and b", "a, b and c"; whole clauses take a comma before the English "and" too. */
function joinList(parts: readonly string[], nl: boolean, clauses: boolean): string {
  const and = nl ? 'en' : 'and';
  if (parts.length <= 1) return parts.join('');
  const head = parts.slice(0, -1).join(', ');
  const last = parts[parts.length - 1] as string;
  return !nl && clauses ? `${head}, ${and} ${last}` : `${head} ${and} ${last}`;
}
