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
  'health.checking': 'Checking API health…',
  'health.ok': 'API is healthy',
  'health.down': 'API unreachable',
  'notes.title': 'Notes',
  'notes.authRequired': 'Sign in to view your notes (the API is fail-closed until you authenticate).',
  'notes.empty': 'No notes yet.',
  'error.generic': 'Something went wrong. Please try again.',
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