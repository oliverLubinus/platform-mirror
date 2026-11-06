/**
 * PII / secret sanitization for logs and error details.
 *
 * Full port of auth-provider's live `backend/src/shared/sanitizeLogMeta.ts`
 * (R-PKG-10 copy → generalize — unchanged logic, relocated so every platform
 * backend inherits it). Covers two layers:
 *
 * 1. `sanitizeLogMeta` — defense-in-depth filter for log metadata received
 *    from frontend callers (frontend bugs must not leak PII into logs).
 * 2. Request-context redaction helpers for `buildErrorDetails` /
 *    global error handler / request logger — request bodies, query strings
 *    and headers never leak passwords, tokens or session cookies into
 *    server-side logs.
 *
 * Standards reference (auth-provider source):
 *   - logging-strategy-policy.md (Sensitive Data Policy)
 *   - engineering-coding-standards.md (Security and Privacy Rules)
 */

/** Keys that must never appear in log metadata (frontend-origin payloads). */
const SENSITIVE_META_KEYS: ReadonlySet<string> = new Set([
  'email',
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'idToken',
  'id_token',
  'authorization',
  'cookie',
  'set-cookie',
  'clientSecret',
  'client_secret',
  'secret',
  'apiKey',
  'api_key'
]);

const REDACTED = '[REDACTED]';

/** Recursively redact sensitive keys in arbitrary log metadata. */
export function sanitizeLogMeta(meta: unknown, depth = 0): unknown {
  if (meta === null || typeof meta !== 'object') {
    return meta;
  }
  if (depth > 5) {
    return '[MAX_DEPTH]';
  }
  if (Array.isArray(meta)) {
    return meta.map((item) => sanitizeLogMeta(item, depth + 1));
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
    sanitized[key] = SENSITIVE_META_KEYS.has(key) ? REDACTED : sanitizeLogMeta(value, depth + 1);
  }
  return sanitized;
}

/** Marker for redacted request values. */
export const REQUEST_REDACTED = '[REDACTED]';

/** Full-request-payload key set — superset of SENSITIVE_META_KEYS incl. short-lived OAuth/CSRF/MFA secrets. */
const SENSITIVE_REQUEST_KEYS: ReadonlySet<string> = new Set([
  ...SENSITIVE_META_KEYS,
  'currentPassword',
  'newPassword',
  'current_password',
  'new_password',
  'oldPassword',
  'old_password',
  'passwordConfirmation',
  'confirmPassword',
  'confirm_password',
  'code',
  'state',
  'codeVerifier',
  'code_verifier',
  'codeChallenge',
  'code_challenge',
  'csrf',
  'csrfToken',
  'csrf_token',
  'twoFactorCode',
  'totp',
  'otp',
  'mfaCode',
  'resetToken',
  'reset_token',
  'verificationToken',
  'verification_token'
]);

/** Narrower set for caller-supplied `extraDetails` — preserves benign debug keys. */
const SENSITIVE_EXTRA_KEYS: ReadonlySet<string> = new Set([
  ...SENSITIVE_META_KEYS,
  'currentPassword',
  'newPassword',
  'current_password',
  'new_password',
  'oldPassword',
  'old_password',
  'passwordConfirmation',
  'confirmPassword',
  'confirm_password',
  'csrf',
  'csrfToken',
  'csrf_token',
  'codeVerifier',
  'code_verifier',
  'codeChallenge',
  'code_challenge',
  'twoFactorCode',
  'totp',
  'otp',
  'mfaCode',
  'resetToken',
  'reset_token',
  'verificationToken',
  'verification_token'
]);

/** Header keys whose values are never legitimate in logs. */
const SENSITIVE_HEADER_PATTERNS: RegExp[] = [
  /^authorization$/i,
  /^proxy-authorization$/i,
  /^cookie/i,
  /^set-cookie$/i,
  /csrf/i,
  /api-?key/i
];

/** Recursively redact sensitive keys in a request payload (body/query). */
export function sanitizeRequestValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth > 5) {
    return '[MAX_DEPTH]';
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeRequestValue(item, depth + 1));
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    sanitized[key] = SENSITIVE_REQUEST_KEYS.has(key)
      ? REQUEST_REDACTED
      : sanitizeRequestValue(val, depth + 1);
  }
  return sanitized;
}

/** Redact sensitive header values (cookies, authorization, CSRF, API keys). */
export function sanitizeRequestHeaders(headers: unknown): unknown {
  if (headers == null || typeof headers !== 'object' || Array.isArray(headers)) {
    return headers;
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    sanitized[key] = SENSITIVE_HEADER_PATTERNS.some((pattern) => pattern.test(lower))
      ? REQUEST_REDACTED
      : value;
  }
  return sanitized;
}

/** Redact sensitive query parameters (OAuth code/state, reset tokens, …) in URLs. */
export function sanitizeUrlQuery(rawUrl: unknown): unknown {
  if (typeof rawUrl !== 'string') return rawUrl;
  const queryIndex = rawUrl.indexOf('?');
  if (queryIndex === -1) return rawUrl;
  const path = rawUrl.slice(0, queryIndex);
  const params = new URLSearchParams(rawUrl.slice(queryIndex + 1));
  let changed = false;
  for (const key of Array.from(params.keys())) {
    if (SENSITIVE_REQUEST_KEYS.has(key)) {
      params.set(key, REQUEST_REDACTED);
      changed = true;
    }
  }
  return changed ? `${path}?${params.toString()}` : rawUrl;
}

/**
 * Fail-closed sanitizer for the error-details object produced by
 * `buildErrorDetails`: request-shaped fields (body/query/headers/url) are
 * redacted EVEN when callers pass them as extraDetails, and clearly-secret
 * keys are stripped anywhere in the object while preserving benign context.
 */
export function sanitizeErrorDetails(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth > 6) {
    return '[MAX_DEPTH]';
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeErrorDetails(item, depth + 1));
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'body' || key === 'query') {
      sanitized[key] = sanitizeRequestValue(val);
    } else if (key === 'headers') {
      sanitized[key] = sanitizeRequestHeaders(val);
    } else if (key === 'url' || key === 'originalUrl' || key === 'route') {
      sanitized[key] = sanitizeUrlQuery(val);
    } else if (SENSITIVE_EXTRA_KEYS.has(key)) {
      sanitized[key] = REQUEST_REDACTED;
    } else {
      sanitized[key] = sanitizeErrorDetails(val, depth + 1);
    }
  }
  return sanitized;
}
