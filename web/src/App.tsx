import { useEffect, useState } from 'react';

type HealthState = { status: 'loading' } | { status: 'ok' } | { status: 'error'; message: string };

export function App() {
  const [health, setHealth] = useState<HealthState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();

    fetch('/api/health', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { status?: string };
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

    return () => controller.abort();
  }, []);

  return (
    <main className="shell">
      <h1>chief-web</h1>
      <p className="tagline">Autonomous PRD-driven coding agent, in your browser.</p>
      <p className={`health health--${health.status}`}>
        API: {health.status === 'error' ? `unreachable (${health.message})` : health.status}
      </p>
    </main>
  );
}
