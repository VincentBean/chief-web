/**
 * chief's PRD markdown format (US-011; extended by US-012).
 *
 * The file the planning agent writes is the contract between chief and
 * chief-web, so this parser follows chief's own `internal/prd/markdown.go`
 * rather than inventing a dialect:
 *
 *   ### US-001: Title
 *   **Status:** todo | in-progress | done
 *   **Priority:** 1
 *   **Description:** As a …, I want … so that …
 *
 *   **Acceptance Criteria:**
 *   - [ ] something verifiable
 *   - [x] something already true
 *
 * chief is forgiving — it never rejects a file — but chief-web has to tell an
 * operator *why* a PRD is not usable yet, so anything ambiguous is collected as
 * an error with the line it was found on instead of being silently dropped.
 */

/** Story lifecycle, as `**Status:**` spells it. A missing status is `todo`. */
export type StoryStatus = 'todo' | 'in-progress' | 'done';

export interface PrdAcceptanceCriterion {
  readonly text: string;
  /** `- [x]` rather than `- [ ]`. */
  readonly done: boolean;
}

export interface PrdStory {
  /** `US-001`, exactly as written. */
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Lower runs first. Assigned in file order when the story omits it. */
  readonly priority: number;
  readonly status: StoryStatus;
  readonly acceptanceCriteria: readonly PrdAcceptanceCriterion[];
  /** 1-based line of the story's heading, for error messages. */
  readonly line: number;
}

export interface PrdParseError {
  /** 1-based; `0` when the problem is the file as a whole. */
  readonly line: number;
  readonly message: string;
}

export interface ParsedPrd {
  /** `# PRD: Name` or `# Name`, when the file has one. */
  readonly project: string | null;
  readonly description: string | null;
  readonly stories: readonly PrdStory[];
  readonly errors: readonly PrdParseError[];
}

/** `### US-001: Title`, also accepting `####` like chief does. */
const STORY_HEADING = /^#{3,4}\s+([A-Za-z]+-\d+):\s+(.+)$/;
const STATUS_LINE = /^\*\*Status:\*\*\s*(.+)$/;
const PRIORITY_LINE = /^\*\*Priority:\*\*\s*(.+)$/;
const DESCRIPTION_LINE = /^\*\*Description:\*\*\s*(.+)$/;
const CHECKBOX = /^-\s+\[([ xX])\]\s+(.+)$/;
const PROJECT_HEADING = /^#\s+(?:PRD:\s+)?(.+)$/;

const DONE_STATUSES = new Set(['done', 'complete', 'completed', 'passed']);
const IN_PROGRESS_STATUSES = new Set(['in-progress', 'in progress', 'started']);
const TODO_STATUSES = new Set(['todo', 'to-do', 'to do', 'pending', 'not started', 'open']);

interface StoryDraft {
  id: string;
  title: string;
  description: string;
  descriptionLines: string[];
  priority: number | null;
  status: StoryStatus;
  acceptanceCriteria: PrdAcceptanceCriterion[];
  line: number;
}

/**
 * Parses a PRD. Never throws: a file that cannot be used produces errors, which
 * is what the session page shows next to "does not parse".
 */
export function parsePrd(content: string): ParsedPrd {
  const lines = content.split('\n');
  const stories: PrdStory[] = [];
  const errors: PrdParseError[] = [];
  const seen = new Map<string, number>();

  let project: string | null = null;
  let description: string | null = null;
  let introStarted = false;
  let introDone = false;
  let current: StoryDraft | null = null;
  /** Highest priority seen so far, so an omitted one continues the sequence. */
  let autoPriority = 0;

  const flush = (): void => {
    if (current === null) return;
    const draft = current;
    current = null;

    if (draft.description === '' && draft.descriptionLines.length > 0) {
      draft.description = draft.descriptionLines.join(' ');
    }
    let priority = draft.priority;
    if (priority === null) {
      autoPriority += 1;
      priority = autoPriority;
    } else if (priority > autoPriority) {
      autoPriority = priority;
    }
    if (draft.acceptanceCriteria.length === 0) {
      errors.push({
        line: draft.line,
        message: `${draft.id} has no acceptance criteria; add a "- [ ] …" checklist.`,
      });
    }
    stories.push({
      id: draft.id,
      title: draft.title,
      description: draft.description,
      priority,
      status: draft.status,
      acceptanceCriteria: draft.acceptanceCriteria,
      line: draft.line,
    });
  };

  lines.forEach((raw, index) => {
    const lineNumber = index + 1;
    const trimmed = raw.trim();

    // A story heading first: `### US-001: …` also matches the generic `### `
    // section test below, and only one of them may win.
    const heading = STORY_HEADING.exec(trimmed);
    if (heading !== null) {
      flush();
      introDone = true;
      const id = heading[1] ?? '';
      const previous = seen.get(id);
      if (previous !== undefined) {
        errors.push({
          line: lineNumber,
          message: `${id} is defined twice (also on line ${previous}); story ids must be unique.`,
        });
      } else {
        seen.set(id, lineNumber);
      }
      current = {
        id,
        title: (heading[2] ?? '').trim(),
        description: '',
        descriptionLines: [],
        priority: null,
        status: 'todo',
        acceptanceCriteria: [],
        line: lineNumber,
      };
      return;
    }

    if (raw.startsWith('# ') && !raw.startsWith('## ')) {
      const match = PROJECT_HEADING.exec(trimmed);
      if (match !== null) {
        project ??= (match[1] ?? '').trim();
        introStarted = true;
        return;
      }
    }

    // Any other `##`/`###` heading closes the story block it follows.
    if (raw.startsWith('## ') || raw.startsWith('### ')) {
      flush();
      const title = trimmed.replace(/^#+/, '').trim().toLowerCase();
      if (title === 'introduction' || title === 'overview') {
        introStarted = true;
        introDone = false;
      } else {
        introDone = true;
      }
      return;
    }

    if (current !== null) {
      readStoryLine(current, trimmed, lineNumber, errors);
      return;
    }

    if (introStarted && !introDone && description === null && trimmed !== '' && !trimmed.startsWith('#')) {
      description = trimmed;
    }
  });

  flush();

  if (stories.length === 0) {
    errors.push({
      line: 0,
      message: 'No user stories found. Each one needs a "### US-001: Title" heading.',
    });
  }

  return { project, description, stories, errors };
}

/** True when the file is usable as it stands. */
export function prdParses(parsed: ParsedPrd): boolean {
  return parsed.errors.length === 0;
}

function readStoryLine(
  story: StoryDraft,
  trimmed: string,
  lineNumber: number,
  errors: PrdParseError[],
): void {
  const status = STATUS_LINE.exec(trimmed);
  if (status !== null) {
    const value = (status[1] ?? '').trim().toLowerCase();
    const parsed = parseStatus(value);
    if (parsed === null) {
      errors.push({
        line: lineNumber,
        message: `${story.id} has an unknown status "${(status[1] ?? '').trim()}"; expected todo, in-progress or done.`,
      });
      return;
    }
    story.status = parsed;
    return;
  }

  const priority = PRIORITY_LINE.exec(trimmed);
  if (priority !== null) {
    const value = (priority[1] ?? '').trim();
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      errors.push({
        line: lineNumber,
        message: `${story.id} has an invalid priority "${value}"; expected a number greater than 0.`,
      });
      return;
    }
    story.priority = parsed;
    return;
  }

  const description = DESCRIPTION_LINE.exec(trimmed);
  if (description !== null) {
    story.description = (description[1] ?? '').trim();
    return;
  }

  const checkbox = CHECKBOX.exec(trimmed);
  if (checkbox !== null) {
    story.acceptanceCriteria.push({
      text: (checkbox[2] ?? '').trim(),
      done: (checkbox[1] ?? ' ').toLowerCase() === 'x',
    });
    return;
  }

  // Prose before an explicit `**Description:**` is the description, exactly as
  // chief treats it.
  if (trimmed !== '' && story.description === '' && !trimmed.startsWith('**') && !trimmed.startsWith('- ')) {
    story.descriptionLines.push(trimmed);
  }
}

function parseStatus(value: string): StoryStatus | null {
  if (value === '') return 'todo';
  if (DONE_STATUSES.has(value)) return 'done';
  if (IN_PROGRESS_STATUSES.has(value)) return 'in-progress';
  if (TODO_STATUSES.has(value)) return 'todo';
  return null;
}
