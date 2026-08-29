import { type JSX, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import './index.css';
import { Login } from './Login.tsx';
import { Settings } from './Settings.tsx';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');

// A handful of entry points, matched on the pathname; the server redirects
// unauthenticated navigations to `/login` and serves index.html for the rest,
// so a router library is still not warranted.
const PAGES: Record<string, () => JSX.Element> = {
  '/login': Login,
  '/settings': Settings,
};

const Page = PAGES[window.location.pathname] ?? App;

createRoot(container).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
