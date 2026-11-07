/**
 * Intl formatting helpers (backlog item 6: no hand-rolled date/number/currency
 * formatting — the browser Intl engine is the i18n-correct path).
 */
const locale = 'en-US'; // English-only content for v1 (backlog item 6)

export function formatDate(date: Date | string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
    typeof date === 'string' ? new Date(date) : date
  );
}