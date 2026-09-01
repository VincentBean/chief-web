import { type FormEvent, useState } from 'react';

import { ApiError, login } from '../api.ts';
import { Mark } from '../AppShell.tsx';
import { Icon } from '../Icon.tsx';

/**
 * The one unauthenticated page. There are no accounts — a single shared
 * password guards the whole app (US-003).
 */
export function Login() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = (event: FormEvent): void => {
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
    <main className="login">
      <form className="login__card" onSubmit={onSubmit}>
        <div className="login__brand">
          <Mark />
          <span className="login__name">chief</span>
        </div>
        <h1 className="login__title">Sign in</h1>
        <p className="muted">The shared operator password.</p>
        <div className="field">
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
            aria-invalid={error !== null}
            aria-describedby={error === null ? undefined : 'login-error'}
          />
        </div>
        {error !== null && (
          <p className="login__error" id="login-error" role="alert">
            <Icon name="x-circle" />
            {error}
          </p>
        )}
        <button type="submit" className="button button--primary button--block" disabled={submitting || password === ''}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}

/**
 * The server answers `429` once too many sign-ins have failed, and its message
 * carries the wait — show that rather than a generic failure.
 */
function describeFailure(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 401) return 'Incorrect password.';
  if (cause instanceof ApiError && cause.status === 429) {
    return cause.detail ?? 'Too many failed sign-in attempts. Try again later.';
  }
  return `Could not sign in: ${String(cause)}`;
}
