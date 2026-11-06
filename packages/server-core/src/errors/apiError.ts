/**
 * ApiError — the platform error contract.
 *
 * Ported from auth-provider's live `backend/src/shared/errors.ts`
 * (copy → generalize, ADR-010 §4 / R-PKG-10): LLM-specific mappings and the
 * closed ERROR_CODES union are NOT ported (see errorCodes.ts for the
 * open-world registry rationale).
 *
 * DELIBERATE DIVERGENCE (documented, per the interface inventory):
 * the platform response envelope INCLUDES the HTTP status inside the error
 * object, matching the integration contract §3:
 *
 *   { "error": { "code": "PM_PROJECT_NOT_FOUND", "message": "…", "status": 404 } }
 *
 * auth-provider's current envelope omits `status` (the HTTP status carries
 * it). auth-provider keeps its own shape; all NEW platform apps use the
 * envelope from this module. Consumers must not depend on the old shape.
 *
 * @see sanitizeErrorDetails — buildErrorDetails output is fail-closed
 *      redacted before it ever reaches a log or a response.
 */

import { sanitizeErrorDetails } from './sanitize.js';

/**
 * Broad interface for extracting status/message from unknown error shapes
 * (native Error, Axios-style errors, third-party libs). Ported verbatim in
 * spirit from auth-provider.
 */
export interface ErrorWithStatus {
  status?: number | string;
  message?: string;
  code?: number | string;
  response?: {
    status?: number | string;
    data?: {
      error?: {
        message?: string;
      };
    };
  };
}

/** The platform error envelope — the shape every platform API returns on failure. */
export interface PlatformErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly status: number;
    readonly details?: unknown;
  };
}

/**
 * API error with a stable code, HTTP status, and optional (sanitized-safe)
 * details. Designed for use with a shared global error handler.
 *
 * Example:
 *   throw new ApiError('PM_PROJECT_NOT_FOUND', 'Project not found.', 404);
 */
export class ApiError extends Error {
  /** Stable error code string (see the registry for known codes). */
  code: string;
  /** HTTP status code. */
  status: number;
  /** Optional error details (e.g. Zod issues) — never logged unsanitized. */
  details?: unknown;
  /** Optional error cause (for error chaining). */
  cause?: Error | undefined;

  constructor(code: string, message: string, status: number = 500, details?: unknown, cause?: Error) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = ApiError.formatDetails(details);
    this.cause = cause;
    Object.setPrototypeOf(this, ApiError.prototype);
  }

  /**
   * Formats error details, converting Zod-issue-shaped arrays to a
   * user-friendly {path, message} form. Ported from auth-provider.
   */
  static formatDetails(details: unknown): unknown {
    if (
      Array.isArray(details) &&
      details.length > 0 &&
      typeof details[0] === 'object' &&
      details[0] !== null &&
      'message' in details[0] &&
      'path' in details[0]
    ) {
      return details.map((issue: { path: unknown; message: string }) => ({
        path: Array.isArray(issue.path) ? issue.path.join('.') : String(issue.path),
        message: issue.message
      }));
    }
    return details;
  }

  /**
   * Platform response envelope — integration contract §3 shape
   * (`status` included inside the error object).
   */
  toResponseBody(): PlatformErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        status: this.status,
        ...(this.details != null ? { details: this.details } : {})
      }
    };
  }
}

/**
 * Safely extract status and message from unknown error objects.
 * Ported from auth-provider (exactOptionalPropertyTypes-aware).
 */
export function getErrorStatusAndMessage(err: unknown): {
  status: number | string | undefined;
  message: string;
} {
  let status: number | string | undefined;
  let message = '';
  if (typeof err === 'object' && err !== null) {
    const e = err as ErrorWithStatus;
    // `in` checks pass even when the key holds undefined/null — access must
    // be null-guarded or this "robust extraction" helper itself throws
    // (error-in-error-handler). Port fix: e.response null-guards added.
    if ('status' in e && typeof e.status !== 'undefined') {
      status = e.status;
    } else if ('response' in e && e.response != null && typeof e.response.status !== 'undefined') {
      status = e.response.status;
    } else if ('code' in e && typeof e.code !== 'undefined') {
      status = e.code;
    }
    if ('message' in e && typeof e.message === 'string') {
      message = e.message;
    } else if ('response' in e && e.response != null && e.response.data?.error?.message) {
      message = e.response.data.error.message ?? '';
    } else {
      message = stringifySafely(err);
    }
  } else if (typeof err === 'string') {
    message = err;
  } else {
    message = stringifySafely(err);
  }
  return { status, message };
}

/**
 * JSON.stringify that never throws (circular structures) and never yields
 * `undefined` (functions/symbols serialize to undefined). Port fix: the
 * original fell back to a bare `JSON.stringify(err)`.
 */
function stringifySafely(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Builds sanitized error details with request context. Ported from
 * auth-provider: request-shaped fields (body/query/headers/url) are
 * redacted fail-closed by `sanitizeErrorDetails` — passwords, tokens and
 * session cookies can never leak into server-side logs, even when callers
 * pass the raw body as an extra detail.
 *
 * @param req - Express-like request (accessed via unknown-record guards)
 * @param extraDetails - additional error-specific fields
 */
export function buildErrorDetails(req: unknown, extraDetails?: Record<string, unknown>): Record<string, unknown> {
  const r = req as Record<string, unknown>;
  const getHeader =
    typeof r.get === 'function' ? (r.get as (name: string) => string | undefined).bind(r) : undefined;
  const raw: Record<string, unknown> = {
    ip: r.ip,
    timestamp: new Date().toISOString(),
    userAgent: getHeader?.('user-agent'),
    method: r.method,
    url: r.originalUrl,
    contentType: getHeader?.('content-type'),
    body: r.body,
    query: r.query,
    headers: r.headers,
    ...(extraDetails ?? {})
  };
  return sanitizeErrorDetails(raw) as Record<string, unknown>;
}

/** Type guard for nested property existence (ported from auth-provider). */
export function hasNestedProperty<T = unknown>(obj: unknown, path: string[]): obj is T {
  let current: unknown = obj;
  for (const key of path) {
    if (typeof current !== 'object' || current === null || !(key in current)) {
      return false;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return true;
}
