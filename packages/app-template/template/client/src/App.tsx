/**
 * App shell with the boot gate (the exact surface the ./react adapter will
 * own as an AuthProvider + useAuth pair — finding F1).
 *
 *   authenticated → content (notes via the useNotes hook)
 *   redirecting   → nothing (navigation in flight)
 *   signedOut     → explicit post-logout screen with a Sign in action
 *   error         → curated copy; no login screen is ever rendered (R-PKG-04)
 *
 * Presentational only: data access lives in src/hooks (layering guard,
 * check-layering.js), styling lives in src/styles (token guard).
 */
import { useEffect, useMemo, useState } from 'react';
import { getAppAuth, type BootState } from './auth/authClient';
import { useNotes } from './hooks/useNotes';
import { t } from './i18n/strings';
import { formatDate } from './i18n/format';

export default function App() {
  const auth = useMemo(() => getAppAuth(), []);
  const [boot, setBoot] = useState<BootState>({ state: 'redirecting' });
  const notes = useNotes(boot.state === 'authenticated');

  // Boot gate. Single-flight inside the wiring module (StrictMode-safe).
  useEffect(() => {
    let cancelled = false;
    auth
      .bootSession()
      .then((result) => {
        if (!cancelled) setBoot(result);
      })
      .catch(() => {
        if (!cancelled) setBoot({ state: 'error', code: 'UNKNOWN', message: t('auth.error.generic') });
      });
    return () => {
      cancelled = true;
    };
  }, [auth]);

  if (boot.state === 'redirecting') return null;
  if (boot.state === 'error') {
    return (
      <main>
        <h1>{t('app.title')}</h1>
        <p>{t('auth.error.generic')}</p>
        <button type="button" onClick={() => void auth.signIn(window.location.pathname)}>
          {t('callback.retry')}
        </button>
      </main>
    );
  }
  if (boot.state === 'signedOut') {
    return (
      <main>
        <h1>{t('app.title')}</h1>
        <p>{t('auth.signedOut.title')}</p>
        <button type="button" onClick={() => void auth.signIn(window.location.pathname)}>
          {t('auth.signedOut.action')}
        </button>
      </main>
    );
  }

  return (
    <main>
      <h1>{t('app.title')}</h1>
      <p>{t('app.subtitle')}</p>
      <button
        type="button"
        onClick={() => {
          void auth.signOut().then(() => setBoot({ state: 'signedOut' }));
        }}
      >
        {t('auth.signOut')}
      </button>
      <h2>{t('notes.title')}</h2>
      {notes.phase === 'loading' && <p>{t('notes.loading')}</p>}
      {notes.phase === 'unverified' && <p>{t('notes.unverified')}</p>}
      {notes.phase === 'error' && <p>{t('notes.error')}</p>}
      {notes.phase === 'ready' &&
        (notes.notes.length === 0 ? (
          <p>{t('notes.empty')}</p>
        ) : (
          <ul>
            {notes.notes.map((note) => (
              <li key={note.id}>
                <strong>{note.title}</strong> — {formatDate(note.createdAt)}
              </li>
            ))}
          </ul>
        ))}
    </main>
  );
}
