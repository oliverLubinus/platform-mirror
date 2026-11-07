/**
 * Callback route (redirectUri path). Validates state, exchanges the code,
 * then SPA-navigates to the restored returnTo.
 *
 * SPA navigation is a CORRECTNESS requirement, not a UX choice: a full page
 * reload after the callback would drop the in-memory tokens and re-trigger
 * the boot redirect dance — a loop. history.replaceState keeps the session
 * alive (finding F1 in the README).
 */
import { useEffect, useState } from 'react';
import { getAppAuth } from '../auth/authClient';
import { t } from '../i18n/strings';

type CallbackState =
  | { phase: 'working' }
  | { phase: 'done'; returnTo: string | null }
  | { phase: 'cancelled' }
  | { phase: 'error' };

export default function CallbackPage({ onNavigated }: { onNavigated: () => void }) {
  const [state, setState] = useState<CallbackState>({ phase: 'working' });

  useEffect(() => {
    let cancelled = false;
    getAppAuth()
      .completeCallback()
      .then((result) => {
        if (cancelled) return;
        // SPA-navigate: replace the history entry, no reload, tokens stay.
        window.history.replaceState(null, '', result.returnTo ?? '/');
        setState({ phase: 'done', returnTo: result.returnTo });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const code = (err as { code?: string }).code;
        // access_denied = the user declined on the hosted UI — curated copy.
        setState(code === 'access_denied' ? { phase: 'cancelled' } : { phase: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The 'done' phase re-renders the app at the new location on the next tick —
  // parent-owned (main.tsx re-checks the path).
  useEffect(() => {
    if (state.phase === 'done') {
      const id = window.setTimeout(onNavigated, 0);
      return () => window.clearTimeout(id);
    }
  }, [state.phase, onNavigated]);

  if (state.phase === 'done') return null;

  return (
    <main>
      <p>{state.phase === 'working' ? t('callback.working') : state.phase === 'cancelled' ? t('callback.cancelled') : t('auth.error.generic')}</p>
      {state.phase !== 'working' && (
        <button
          type="button"
          onClick={() => {
            void getAppAuth().signIn(window.location.pathname);
          }}
        >
          {t('callback.retry')}
        </button>
      )}
    </main>
  );
}
