import { type FormEvent, useState } from 'react';

import { ApiError, login } from './api.ts';

/**
 * The one unauthenticated page. There are no accounts — a single shared
 * password guards the whole app (US-003).
 */
export function Login() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    login(password)
      .then(() => {
        // A full navigation so the server re-serves the app with the cookie set.
        window.location.replace('/');
      })
      .catch((cause: unknown) => {
        setSubmitting(false);
        setError(describeFailure(cause));
      });
  };

  return (
    <main className="shell shell--narrow">
      <h1>chief-web</h1>
      <p className="tagline">Enter the shared password to continue.</p>

      <form className="form" onSubmit={onSubmit}>
        <section className="field">
          <label className="field__label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="field__input"
          />
        </section>
        <button
          type="submit"
          className="button button--primary"
          disabled={submitting || password === ''}
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
        {error !== null && (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        )}
      </form>
    </main>
  );
}

/**
 * The server answers `429` once too many sign-ins have failed, and its message
 * carries the wait — show that rather than a generic failure, so a locked-out
 * operator knows to wait instead of retrying harder.
 */
function describeFailure(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 401) return 'Incorrect password.';
  if (cause instanceof ApiError && cause.status === 429) {
    return cause.detail ?? 'Too many failed sign-in attempts. Try again later.';
  }
  return `Could not sign in: ${String(cause)}`;
}
