import type { Session, Story } from './api.ts';

/**
 * Status to badge class.
 *
 * These used to be built by interpolation — `` `badge badge--${status}` `` —
 * which meant a state with no matching CSS rule rendered as a plain grey pill
 * that looked deliberate. That is exactly how `.badge--todo` came to be
 * missing: nothing failed, it just quietly lost its colour.
 *
 * As exhaustive `Record`s, adding a state to a union without giving it a look
 * is a `tsc --noEmit` error instead. Keep these in step with the variants in
 * `styles/feedback.css`.
 */

export const SESSION_BADGE: Record<Session['status'], string> = {
  pending: 'badge badge--pending',
  ready: 'badge badge--ready',
  building: 'badge badge--building',
  failed: 'badge badge--failed',
  finished: 'badge badge--finished',
};

export const STORY_BADGE: Record<Story['status'], string> = {
  todo: 'badge badge--todo',
  'in-progress': 'badge badge--in-progress',
  done: 'badge badge--done',
};
