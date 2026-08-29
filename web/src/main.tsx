import { type ComponentType, lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import './index.css';
import { Login } from './Login.tsx';
import { Repositories } from './Repositories.tsx';
import { Sessions } from './Sessions.tsx';
import { Settings } from './Settings.tsx';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');

// xterm.js is by far the largest dependency and only the terminal page needs
// it; loading it separately keeps the login page small.
const Terminals = lazy(() =>
  import('./Terminals.tsx').then((module) => ({ default: module.Terminals })),
);
// The session page embeds the planning terminal (US-011), so it pays the same
// xterm.js cost and is loaded the same way.
const Session = lazy(() =>
  import('./Session.tsx').then((module) => ({ default: module.Session })),
);

// A handful of entry points, matched on the pathname; the server redirects
// unauthenticated navigations to `/login` and serves index.html for the rest,
// so a router library is still not warranted.
const PAGES: Record<string, ComponentType> = {
  '/login': Login,
  '/repositories': Repositories,
  '/sessions': Sessions,
  '/settings': Settings,
  '/terminal': Terminals,
};

/** `/sessions/<id>`: one session, with its PRD state and planning terminal. */
const SESSION_PATH = /^\/sessions\/[^/]+\/?$/;

const pathname = window.location.pathname;
const Page = PAGES[pathname] ?? (SESSION_PATH.test(pathname) ? Session : App);

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
