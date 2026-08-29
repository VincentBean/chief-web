import { useEffect, useState } from 'react';

import { api, ApiError, type ClaudeState, fetchClaudeState, logout } from './api.ts';

type HealthState = { status: 'loading' } | { status: 'ok' } | { status: 'error'; message: string };

export function App() {
  const [health, setHealth] = useState<HealthState>({ status: 'loading' });
  const [claude, setClaude] = useState<ClaudeState | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    api<{ status?: string }>('/api/health', { signal: controller.signal })
      .then((body) => {
        setHealth(
          body.status === 'ok'
            ? { status: 'ok' }
            : { status: 'error', message: `unexpected body: ${JSON.stringify(body)}` },
        );
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setHealth({ status: 'error', message: String(error) });
      });

    // Sessions need a signed-in Claude Code (US-008); saying so here beats
    // finding out when the first session refuses to be created.
    fetchClaudeState({ signal: controller.signal })
      .then(setClaude)
      .catch(() => {
        // The settings page reports why; the home page just stays quiet.
      });

    // The server already redirects page loads, but a session can expire while
    // the tab is open — this notices and sends the operator back to /login.
    api('/api/auth/session', { signal: controller.signal }).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 401) window.location.replace('/login');
    });

    return () => controller.abort();
  }, []);

  const onLogout = () => {
    logout().finally(() => window.location.replace('/login'));
  };

  return (
    <main className="shell">
      <header className="topbar">
        <h1>chief-web</h1>
        <nav className="topbar__nav">
          <a className="link" href="/sessions">
            Sessions
          </a>
          <a className="link" href="/repositories">
            Repositories
          </a>
          <a className="link" href="/terminal">
            Terminal
          </a>
          <a className="link" href="/settings">
            Settings
          </a>
          <button type="button" className="button button--quiet" onClick={onLogout}>
            Log out
          </button>
        </nav>
      </header>
      <p className="tagline">Autonomous PRD-driven coding agent, in your browser.</p>
      <p className={`health health--${health.status}`}>
        API: {health.status === 'error' ? `unreachable (${health.message})` : health.status}
      </p>
      {claude === null || claude.status.authenticated ? null : (
        <p className="notice notice--error" role="alert">
          Claude Code is not authenticated, so sessions cannot be created. Open{' '}
          <a className="link" href="/settings">
            Settings
          </a>{' '}
          and use “Set up Claude”.
        </p>
      )}
    </main>
  );
}
