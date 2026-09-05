/**
 * Sentry slug helpers.
 *
 * A repository is linked to Sentry by an org slug plus a project slug (US-003).
 * Sentry slugifies both when they are created, so the stored value is always
 * lowercase letters, digits and hyphens — the same spirit as
 * `isValidGithubSlug` in `git-url.ts`, only stricter because Sentry leaves us
 * no room for case or dots.
 */

/** Org and project slugs, as they appear in a Sentry URL. */
export const SENTRY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Sentry caps slugs well below this; the limit only stops absurd input. */
export const MAX_SENTRY_SLUG_LENGTH = 100;

export function isValidSentrySlug(slug: string): boolean {
  return slug.length <= MAX_SENTRY_SLUG_LENGTH && SENTRY_SLUG_PATTERN.test(slug);
}
