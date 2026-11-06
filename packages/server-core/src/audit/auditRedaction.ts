/**
 * Audit `details` redaction (ABE-5) — ported verbatim from auth-provider's
 * live `backend/src/utils/auditRedaction.ts`.
 *
 * Audit `details` are stored as flat `key=value, key=value` strings (or
 * JSON-style `"key": "value"`). This helper rewrites the value of any
 * known-sensitive key to `[REDACTED]` while leaving benign context
 * (ip, admin_id, user_id, q, pkce, ...) untouched. It is a defensive,
 * belt-and-braces layer on top of the logging policy that already forbids
 * writing secrets into audit details in the first place.
 */

// Matches a sensitive key (optionally `api_key`/`apiKey` style) followed by `=` or `:`,
// tolerating optional surrounding quotes (JSON-style `"key": "value"`), and consumes the
// value up to a comma, whitespace, quote, brace, or end-of-string. The `\s*` after the
// separator is INSIDE the capture group so original spacing is preserved verbatim —
// only the value itself is rewritten.
const AUDIT_SECRET_PATTERN =
  /(["']?\b(?:password|passwords|access_token|refresh_token|token|secret|code_verifier|code_challenge|cookie|api[_-]?key|authorization)["']?\s*[=:]\s*)["']?[^,\s}"']+["']?/gi;

export function redactAuditDetails(details?: string): string | undefined {
  if (details == null || details === '') return details;
  return details.replace(AUDIT_SECRET_PATTERN, (_match, keyAndSep: string) => `${keyAndSep}[REDACTED]`);
}
