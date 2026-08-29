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
        setError(
          cause instanceof ApiError && cause.status === 401
            ? 'Incorrect password.'
            : `Could not sign in: ${String(cause)}`,
        );
      });
  };

  return (
    <main className="shell shell--narrow">
      <h1>chief-web</h1>
      <p className="tagline">Enter the shared password to continue.</p>

      <form className="login" onSubmit={onSubmit}>
        <label className="login__label" htmlFor="password">
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
          className="login__input"
        />
        <button type="submit" className="button" disabled={submitting || password === ''}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
        {error !== null && (
          <p className="login__error" role="alert">
            {error}
          </p>
        )}
      </form>
    </main>
  );
}
