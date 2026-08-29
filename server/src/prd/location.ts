/**
 * Where a session's PRD lives inside its clone (US-011, moved here by US-012).
 *
 * The path is part of chief's format, not of the planning prompt, so it lives
 * next to the parser: the planning prompt names it, the readiness check reads
 * it, and neither has to know about the other.
 */

/** Directory holding every PRD of a repository, relative to the clone. */
export const PRD_ROOT = '.chief/prds';

/** `.chief/prds/<session name>`, relative to the repository root. */
export function prdDirFor(sessionName: string): string {
  return `${PRD_ROOT}/${sessionName}`;
}

/** `.chief/prds/<session name>/prd.md`, relative to the repository root. */
export function prdPathFor(sessionName: string): string {
  return `${prdDirFor(sessionName)}/prd.md`;
}

/**
 * `.chief/prds/<session name>/progress.md`, relative to the repository root.
 *
 * chief's own `prd.ProgressPath` is "next to the PRD"; the build loop (US-013)
 * inlines this file into every prompt and the agent appends its learnings to it,
 * so the path is part of the format exactly like `prd.md` is.
 */
export function progressPathFor(sessionName: string): string {
  return `${prdDirFor(sessionName)}/progress.md`;
}
