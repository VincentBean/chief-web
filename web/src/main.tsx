import { type ComponentType, lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';

import { Dashboard } from './Dashboard.tsx';
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
// The session page embeds the planning terminal (US-011), so it pays the same
// xterm.js cost and is loaded the same way.
const Session = lazy(() =>
  import('./Session.tsx').then((module) => ({ default: module.Session })),
);
// The pull requests page pulls in the comment renderer and is not on the path
// to anything else, so it loads only when someone goes there.
const PullRequests = lazy(() =>
  import('./PullRequests.tsx').then((module) => ({ default: module.PullRequests })),
);

// A handful of entry points, matched on the pathname; the server redirects
// unauthenticated navigations to `/login` and serves index.html for the rest,
// so a router library is still not warranted.
const PAGES: Record<string, ComponentType> = {
  '/login': Login,
  '/pull-requests': PullRequests,
  '/repositories': Repositories,
  '/sessions': Dashboard,
  '/settings': Settings,
  '/terminal': Terminals,
};

/** `/sessions/<id>`: one session, with its PRD state and planning terminal. */
const SESSION_PATH = /^\/sessions\/[^/]+\/?$/;

// The dashboard (US-015) is the home page, and the fallback: the server serves
// index.html for every non-`/api` path, so an unknown URL lands on the list of
// sessions rather than on a blank screen.
const pathname = window.location.pathname;
const Page = PAGES[pathname] ?? (SESSION_PATH.test(pathname) ? Session : Dashboard);

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
