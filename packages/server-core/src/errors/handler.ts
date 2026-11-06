/**
 * Error classifier core (T1.3c — ported from auth-provider's live
 * `backend/src/shared/globalErrorHandler.ts`, copy → generalize).
 *
 * This module is the FRAMEWORK-AGNOSTIC decision half: given an unknown
 * thrown value and request context, it decides the HTTP status, the log
 * level, the client response body (platform envelope, integration contract
 * §3) and the server-side log payload. The Express adapter lives in
 * `src/express/adapter.ts` (`@platform/server-core/express` subpath).
 *
 * Ported branch logic (auth-provider's four shapes):
 *   1. `ApiError` instance — structured, full context
 *   2. legacy/external error with an `apiError` property — normalized
 *   3. uncaught Zod validation error — wrapped, issues extracted safely
 *   4. fallback — generic internal error, never leaks internals to clients
 *
 * Deliberate divergences (documented):
 *  - Branch 2's hardcoded LLM status mappings (LLM_CONNECTION_ERROR → 503
 *    etc.) are NOT ported: status comes from the app's error-code registry
 *    (`ctx.registry`), which is the whole point of the open-world registry.
 *  - The Zod branch maps to the platform `VALIDATION_FAILED`/422 (integration
 *    contract §3), not auth-provider's `INVALID_REQUEST`/400.
 *  - The response envelope ALWAYS includes `status` (platform shape).
 *  - Stack traces are NOT included in client responses (auth-provider
 *    included them in dev). Stacks go to server-side logs via the adapter's
 *    `showStack` gate only — a deliberate tightening of the leak surface.
 */

import { ApiError, getErrorStatusAndMessage } from './apiError.js';
import type { PlatformErrorBody } from './apiError.js';
import type { ErrorCodeDescriptor } from './errorCodes.js';
import { sanitizeErrorDetails } from './sanitize.js';

/**
 * Fields in error `details` that must NEVER be sent to the client.
 * Ported verbatim from auth-provider's globalErrorHandler — a security
 * property (request material, secrets, session cookies, CSRF tokens may be
 * safe for server-side logs but must not leak to the browser).
 */
const SENSITIVE_DETAIL_KEYS: ReadonlySet<string> = new Set([
  'body',
  'headers',
  'query',
  'redactedBody',
  'ip',
  'userAgent',
  'method',
  'url',
  'contentType',
  'timestamp',
  // Defense-in-depth: token values and internal security state that
  // controllers may pass as extra details.
  'refresh_token',
  'code',
  'code_verifier',
  'code_challenge',
  'client_secret',
  'token',
  'tokenStatus',
  'password',
  'redirect_uri',
  // Staging 2026-10-14 (auth-provider): controllers embed the RAW library
  // error text under `details.error` — useful for the server-side log, but
  // backend internals that must never reach the browser.
  'error'
]);

/**
 * Strip sensitive fields from error details before sending to the client.
 * Ported verbatim: shallow copy with sensitive keys removed; non-object
 * details (e.g. Zod issue arrays) returned as-is.
 */
export function sanitizeDetailsForClient(details: unknown): unknown {
  if (details == null || typeof details !== 'object' || Array.isArray(details)) {
    return details;
  }
  const sanitized: Record<string, unknown> = {};
  for (const key of Object.keys(details)) {
    if (!SENSITIVE_DETAIL_KEYS.has(key)) {
      sanitized[key] = (details as Record<string, unknown>)[key];
    }
  }
  return sanitized;
}

/** Request context the classifier needs — computed by the adapter. */
export interface ErrorHandlerContext {
  method?: string;
  url?: string;
  /**
   * The request body ALREADY passed through `sanitizeRequestValue` by the
   * adapter — the classifier never touches raw request material.
   */
  redactedBody?: unknown;
  /** Dev-only stack-trace gate (computed by the adapter from stackTraceMode). */
  showStack: boolean;
  /**
   * The app's error-code registry — for known codes, the registered status
   * takes precedence over whatever a legacy error object claims.
   */
  registry?: Readonly<Record<string, ErrorCodeDescriptor>>;
}

/** The decision the framework adapter executes. */
export interface ErrorClassification {
  status: number;
  logLevel: 'info' | 'warn' | 'error';
  /** Platform envelope for the client (integration contract §3). */
  responseBody: PlatformErrorBody;
  /** Server-side log message (may be more specific than the client's). */
  logMessage: string;
  /** Server-side log details — full (already sanitized upstream); client copy is stripped. */
  logDetails?: unknown;
  stack?: string;
  cause?: unknown;
}

/**
 * Classify an unknown thrown value into the platform error decision.
 * Never throws — the adapter feeds this from inside an error handler.
 */
export function classifyError(err: unknown, ctx: ErrorHandlerContext): ErrorClassification {
  // ---- Branch 1: ApiError instance -------------------------------------
  if (err instanceof ApiError) {
    const status = typeof err.status === 'number' && err.status ? err.status : 500;
    const logLevel: ErrorClassification['logLevel'] =
      err.code === 'VALIDATION_FAILED' ? 'warn' : status >= 500 ? 'error' : 'info';
    const clientDetails = err.details != null ? sanitizeDetailsForClient(err.details) : undefined;
    return {
      status,
      logLevel,
      responseBody: {
        error: {
          code: err.code,
          message: err.message,
          status,
          ...(clientDetails != null ? { details: clientDetails } : {})
        }
      },
      logMessage: err.message,
      // Server-side log gets the FULL details (they were fail-closed
      // sanitized upstream by buildErrorDetails — body/headers carry no
      // secrets there). The client copy above is stripped separately.
      logDetails: err.details,
      ...(ctx.showStack && err.stack ? { stack: err.stack } : {})
    };
  }

  // ---- Branch 2: legacy/external error with an `apiError` property ------
  if (
    typeof err === 'object' &&
    err !== null &&
    'apiError' in err &&
    typeof (err as { apiError?: unknown }).apiError !== 'undefined'
  ) {
    const apiErrorRaw = (err as { apiError: unknown }).apiError;
    const { status: extractedStatus, message: extractedMessage } = getErrorStatusAndMessage(apiErrorRaw);
    let code = 'UNKNOWN_ERROR';
    if (typeof apiErrorRaw === 'object' && apiErrorRaw !== null && 'code' in apiErrorRaw) {
      const rawCode = (apiErrorRaw as { code?: unknown }).code;
      if (typeof rawCode === 'string' && rawCode.length > 0) {
        code = rawCode;
      }
    }
    // Registry-driven status lookup (replaces the ported hardcoded mappings).
    const descriptor = ctx.registry?.[code];
    const status =
      descriptor !== undefined
        ? descriptor.status
        : typeof extractedStatus === 'number'
          ? extractedStatus
          : 500;
    let details: unknown;
    if (typeof apiErrorRaw === 'object' && apiErrorRaw !== null && 'details' in apiErrorRaw) {
      const rawDetails = (apiErrorRaw as { details?: unknown }).details;
      if (rawDetails !== undefined) {
        details = rawDetails;
      }
    }
    const clientDetails = details != null ? sanitizeDetailsForClient(details) : undefined;
    return {
      status,
      logLevel: 'error',
      responseBody: {
        error: {
          code,
          message: extractedMessage,
          status,
          ...(clientDetails != null ? { details: clientDetails } : {})
        }
      },
      logMessage: extractedMessage,
      logDetails: details,
      ...(ctx.showStack && typeof err === 'object' && err !== null && 'stack' in err
        ? typeof (err as { stack?: unknown }).stack === 'string'
          ? { stack: (err as { stack: string }).stack }
          : {}
        : {})
    };
  }

  // ---- Branch 3: uncaught Zod validation error --------------------------
  if (
    typeof err === 'object' &&
    err !== null &&
    'issues' in err &&
    Array.isArray((err as { issues?: unknown }).issues)
  ) {
    const issues = (err as { issues: unknown[] }).issues;
    // Fail-closed: request body reaches logs only redacted (via ctx).
    const details: Record<string, unknown> = {
      issues,
      ...(ctx.redactedBody !== undefined ? { redactedBody: ctx.redactedBody } : {}),
      ...(ctx.url !== undefined ? { url: ctx.url } : {})
    };
    return {
      status: 422,
      logLevel: 'warn',
      responseBody: {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'The request payload failed validation.',
          status: 422,
          details: sanitizeDetailsForClient(details)
        }
      },
      logMessage: 'The request payload failed validation.',
      // Server-side: full details (redactedBody is redacted; issues intact).
      logDetails: details,
      cause: err
    };
  }

  // ---- Branch 4: fallback — never leak internals to the client ----------
  let fallbackCode = 'INTERNAL';
  if (typeof err === 'object' && err !== null) {
    if ('name' in err && typeof (err as { name?: unknown }).name === 'string') {
      const name = (err as { name: string }).name;
      if (name === 'TypeError') fallbackCode = 'TYPE_ERROR';
      else if (name === 'ReferenceError') fallbackCode = 'REFERENCE_ERROR';
      else if (name === 'SyntaxError') fallbackCode = 'SYNTAX_ERROR';
      else if (name === 'RangeError') fallbackCode = 'RANGE_ERROR';
      else if (name === 'UnhandledPromiseRejection') fallbackCode = 'UNHANDLED_PROMISE_REJECTION';
    }
    if ('code' in err && typeof (err as { code?: unknown }).code === 'string') {
      fallbackCode = (err as { code: string }).code;
    }
  }
  const originalMessage =
    typeof err === 'object' && err !== null && 'message' in err && typeof (err as { message?: unknown }).message === 'string'
      ? (err as { message: string }).message
      : 'An unexpected error occurred.';
  return {
    status: 500,
    logLevel: 'error',
    responseBody: {
      error: {
        code: fallbackCode,
        // The client NEVER sees the raw message (DB strings, file paths,
        // library internals) — in ANY environment.
        message: 'An unexpected error occurred.',
        status: 500
      }
    },
    logMessage: originalMessage,
    // Server-side log: whole error object, sanitized (a thrown object could
    // embed request bodies/session material).
    logDetails: sanitizeErrorDetails(err)
  };
}
