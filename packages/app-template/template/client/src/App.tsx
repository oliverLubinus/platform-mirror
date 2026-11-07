/**
 * App shell with the boot gate (the exact surface the `./react` adapter
 * will own as an AuthProvider + useAuth pair — finding F1).
 *
 *   authenticated → content (notes via authedFetch)
 *   redirecting   → nothing (navigation in flight)
 *   signedOut     → explicit post-logout screen with a Sign in action
 *   error         → curated copy; no login screen is ever rendered (R-PKG-04)
 */
import { useEffect, useMemo, useState } from 'react';
import { getAppAuth, type BootState } from './auth/authClient';
import { createApi, ApiClientError } from './api/client';
import { t } from './i18n/strings';
import { formatDate } from './i18n/format';
import type { Note } from './api/client';

type NotesState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; notes: Note[] }
  | { phase: 'unverified' }
  | { phase: 'error' };

export default function App() {
  const auth = useMemo(() => getAppAuth(), []);
  const api = useMemo(() => createApi((input, init) => auth.authedFetch(input, init)), [auth]);
  const [boot, setBoot] = useState<BootState>({ state: 'redirecting' });
  const [notes, setNotes] = useState<NotesState>({ phase: 'idle' });

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

  // Notes load only once authenticated. The server is fail-closed until the
  // real token verifier lands (T1.5c) — a surviving 401 surfaces honestly
  // and NEVER triggers a redirect (loop safety).
  useEffect(() => {
    if (boot.state !== 'authenticated' || notes.phase !== 'idle') return;
    setNotes({ phase: 'loading' });
    api
      .notes()
      .then((res) => setNotes({ phase: 'ready', notes: res.notes }))
      .catch((err: unknown) => {
        if (err instanceof ApiClientError && err.code === 'UNAUTHENTICATED') {
          setNotes({ phase: 'unverified' });
        } else {
          setNotes({ phase: 'error' });
        }
      });
  }, [boot, notes.phase, api]);

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
          setNotes({ phase: 'idle' });
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