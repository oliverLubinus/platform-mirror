import { useEffect, useState } from 'react';
import { api, ApiClientError } from './api/client';
import { t } from './i18n/strings';

type HealthState = 'checking' | 'ok' | 'down';

export default function App() {
  const [health, setHealth] = useState<HealthState>('checking');
  const [notesBlocked, setNotesBlocked] = useState(false);

  useEffect(() => {
    api
      .health()
      .then(() => setHealth('ok'))
      .catch(() => setHealth('down'));
    // The template's DB route is fail-closed by design: unauthenticated calls
    // get 401 UNAUTHENTICATED. The auth-client wiring (T1.5b) turns this
    // state into a login redirect; until then it renders the honest message.
    api
      .notes()
      .then(() => setNotesBlocked(false))
      .catch((err: unknown) => setNotesBlocked(err instanceof ApiClientError && err.code === 'UNAUTHENTICATED'));
  }, []);

  return (
    <main>
      <h1>{t('app.title')}</h1>
      <p>{t('app.subtitle')}</p>
      <p data-testid="health">{health === 'checking' ? t('health.checking') : health === 'ok' ? t('health.ok') : t('health.down')}</p>
      <h2>{t('notes.title')}</h2>
      {notesBlocked ? <p data-testid="notes-blocked">{t('notes.authRequired')}</p> : <p>{t('notes.empty')}</p>}
    </main>
  );
}