import { StrictMode, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import CallbackPage from './pages/CallbackPage';
import { getAppAuth } from './auth/authClient';

/**
 * Minimal routing: the callback path is handled before the app shell. The
 * path state re-checks after the callback page SPA-navigates to returnTo —
 * apps bring their own router; the template stays dependency-lean.
 */
function Root() {
  const [path, setPath] = useState(() => window.location.pathname);
  const auth = getAppAuth();
  const onNavigated = useCallback(() => setPath(window.location.pathname), []);

  return auth.isCallbackPath(path) ? <CallbackPage onNavigated={onNavigated} /> : <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
