/**
 * Centralized UI strings (backlog item 6 decision: i18n-ready structure,
 * English-only content). NO hardcoded literals in components — every string
 * lives here so a translation workstream can extract them without refactors.
 * Dates/numbers/currencies go through Intl (see i18n/format.ts), never
 * hand-rolled formatting.
 */
export const strings = {
  'app.title': '{{APP_TITLE}}',
  'app.subtitle': 'Platform app scaffolded from @platform/app-template',
  'app.loading': 'Loading…',

  'health.checking': 'Checking API health…',
  'health.ok': 'API is healthy',
  'health.down': 'API unreachable',

  'auth.signingIn': 'Redirecting to sign in…',
  'auth.signOut': 'Sign out',
  'auth.signedOut.title': 'You are signed out',
  'auth.signedOut.action': 'Sign in',
  'auth.error.generic': 'Sign-in could not be completed.',

  'callback.working': 'Completing sign-in…',
  'callback.cancelled': 'Sign-in was cancelled.',
  'callback.retry': 'Try again',

  'notes.title': 'Notes',
  'notes.loading': 'Loading notes…',
  'notes.empty': 'No notes yet.',
  // The server-side token verifier lands with T1.5c; until then the
  // fail-closed API rejects even valid tokens — surface, never redirect
  // (a redirect here would loop against the silent hosted-UI session).
  'notes.unverified': 'The API could not verify your session yet (server-side token verification lands with the next milestone).',
  'notes.error': 'Notes are not available right now.',
} as const;

export type StringKey = keyof typeof strings;

/** Resolve a UI string. Params substitute {name} placeholders. */
export function t(key: StringKey, params?: Record<string, string | number>): string {
  let value: string = strings[key];
  if (params) {
    for (const [name, replacement] of Object.entries(params)) {
      value = value.replaceAll(`{${name}}`, String(replacement));
    }
  }
  return value;
}
