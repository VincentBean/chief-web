import { type ComponentType, lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import './index.css';
import { Login } from './Login.tsx';
import { Repositories } from './Repositories.tsx';
import { Settings } from './Settings.tsx';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');

// xterm.js is by far the largest dependency and only the terminal page needs
// it; loading it separately keeps the login page small.
const Terminals = lazy(() =>
  import('./Terminals.tsx').then((module) => ({ default: module.Terminals })),
);

// A handful of entry points, matched on the pathname; the server redirects
// unauthenticated navigations to `/login` and serves index.html for the rest,
// so a router library is still not warranted.
const PAGES: Record<string, ComponentType> = {
  '/login': Login,
  '/repositories': Repositories,
  '/settings': Settings,
  '/terminal': Terminals,
};

const Page = PAGES[window.location.pathname] ?? App;

createRoot(container).render(
  <StrictMode>
    <Suspense
      fallback={
        <main className="shell">
          <p className="tagline">Loading…</p>
        </main>
      }
    >
      <Page />
    </Suspense>
  </StrictMode>,
);
