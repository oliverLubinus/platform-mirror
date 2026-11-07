/**
 * @file client/src/hooks/useNotes.ts
 * @description
 *   Notes use-case hook - the ONLY place the client touches the api layer
 *   (layering guard, check-layering.js: components/pages stay presentational
 *   and reach data through hooks). The same pattern the ./react adapter
 *   will generalize: hooks own auth-aware data access (finding F1).
 */
import { useEffect, useState } from 'react';
import { createApi, ApiClientError, type Note } from '../api/client';
import { getAppAuth } from '../auth/authClient';

export type NotesState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; notes: Note[] }
  | { phase: 'unverified' }
  | { phase: 'error' };

export function useNotes(enabled: boolean): NotesState {
  const [state, setState] = useState<NotesState>({ phase: 'idle' });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState({ phase: 'loading' });
    // Notes load only once authenticated. The server enforces the REAL
    // verifier now (T1.5c); a surviving 401 surfaces honestly and NEVER
    // triggers a redirect (loop safety, finding F3).
    createApi((input, init) => getAppAuth().authedFetch(input, init))
      .notes()
      .then((res) => {
        if (!cancelled) setState({ phase: 'ready', notes: res.notes });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiClientError && err.code === 'UNAUTHENTICATED') {
          setState({ phase: 'unverified' });
        } else {
          setState({ phase: 'error' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return state;
}
