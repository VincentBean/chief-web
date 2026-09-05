import { type ComponentType, lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';

import { AppShell } from './AppShell.tsx';
import { AppDataProvider } from './data.tsx';
import './index.css';
import { Login } from './pages/Login.tsx';
import { Overview } from './pages/Overview.tsx';
import { Sessions } from './pages/Sessions.tsx';
import { editedRecurringTaskIdFromPath, sessionIdFromPath, useLocation } from './router.tsx';
import { ToastProvider } from './toast.tsx';
import { Skeleton } from './ui.tsx';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');

// xterm.js is by far the largest dependency and only the pages with a
// terminal need it; loading those separately keeps the first paint small.
const Terminals = lazy(() => import('./pages/Terminals.tsx').then((m) => ({ default: m.Terminals })));
const Session = lazy(() => import('./pages/Session.tsx').then((m) => ({ default: m.Session })));
const Settings = lazy(() => import('./pages/Settings.tsx').then((m) => ({ default: m.Settings })));
const PullRequests = lazy(() => import('./pages/PullRequests.tsx').then((m) => ({ default: m.PullRequests })));
const Repositories = lazy(() => import('./pages/Repositories.tsx').then((m) => ({ default: m.Repositories })));
const NewSession = lazy(() => import('./pages/NewSession.tsx').then((m) => ({ default: m.NewSession })));
const RecurringTasks = lazy(() => import('./pages/RecurringTasks.tsx').then((m) => ({ default: m.RecurringTasks })));
const RecurringTaskForm = lazy(() =>
  import('./pages/RecurringTaskForm.tsx').then((m) => ({ default: m.RecurringTaskForm })),
);

/**
 * The entry points, matched on the pathname. The server redirects
 * unauthenticated navigations to `/login` and serves index.html for the rest,
 * so every path here survives a reload.
 */
const PAGES: Record<string, ComponentType> = {
  '/': Overview,
  '/pull-requests': PullRequests,
  '/recurring-tasks': RecurringTasks,
  '/recurring-tasks/new': RecurringTaskForm,
  '/repositories': Repositories,
  '/sessions': Sessions,
  '/sessions/new': NewSession,
  '/settings': Settings,
  '/terminal': Terminals,
  '/terminals': Terminals,
};

function resolve(pathname: string): ComponentType {
  const trimmed = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const page = PAGES[trimmed];
  if (page !== undefined) return page;
  if (sessionIdFromPath(trimmed) !== null) return Session;
  if (editedRecurringTaskIdFromPath(trimmed) !== null) return RecurringTaskForm;
  // An unknown URL lands on the overview rather than on a blank screen.
  return Overview;
}

function App() {
  const { pathname } = useLocation();
  if (pathname === '/login') return <Login />;
  const Page = resolve(pathname);
  return (
    <AppDataProvider>
      <AppShell>
        <Suspense
          fallback={
            <div className="page">
              <div className="panel">
                <div className="panel__body">
                  <Skeleton lines={5} />
                </div>
              </div>
            </div>
          }
        >
          <Page />
        </Suspense>
      </AppShell>
    </AppDataProvider>
  );
}

createRoot(container).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
