import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import './index.css';
import { Login } from './Login.tsx';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');

// The app has exactly two entry points today; the server redirects
// unauthenticated navigations to `/login`, so a router is not warranted yet.
const page = window.location.pathname === '/login' ? <Login /> : <App />;

createRoot(container).render(<StrictMode>{page}</StrictMode>);
