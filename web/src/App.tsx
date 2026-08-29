import { useEffect, useState } from 'react';

import { api, ApiError, logout } from './api.ts';

type HealthState = { status: 'loading' } | { status: 'ok' } | { status: 'error'; message: string };

export function App() {
  const [health, setHealth] = useState<HealthState>({ status: 'loading' });

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
        <button type="button" className="button button--quiet" onClick={onLogout}>
          Log out
        </button>
      </header>
      <p className="tagline">Autonomous PRD-driven coding agent, in your browser.</p>
      <p className={`health health--${health.status}`}>
        API: {health.status === 'error' ? `unreachable (${health.message})` : health.status}
      </p>
    </main>
  );
}
