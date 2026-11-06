/**
 * Rate limiting policy — ported from auth-provider's live
 * `backend/src/shared/RateLimiterNode.ts`, copy → generalize.
 *
 * R-PKG-08 discipline: apps must never hand-roll rate limiting. The audited
 * implementation is `express-rate-limit` (a third-party, security-audited
 * library) — this module is the platform POLICY wrapper around it, exactly
 * like the live module. `express-rate-limit` is an optional peerDependency:
 * apps that mount this middleware already run Express.
 *
 * Carried over from the live module:
 *  - standardHeaders: true / legacyHeaders: false (RateLimit-* headers),
 *  - the handler override emitting a structured error response,
 *  - GDR-4: `skipSuccessfulRequests` counts FAILED attempts only — a
 *    successful (proved) verification never consumes the brute-force
 *    budget. Omitted → every request counts (historical behavior).
 *
 * Divergence: the response body is the PLATFORM envelope —
 * `{ error: { code, message, status, details } }` — built via `buildErrorDetails`
 * (fail-closed request sanitization), not the legacy flat shape.
 */

import rateLimit, { type Options } from 'express-rate-limit';
import type { Request, Response, NextFunction } from 'express';
import { buildErrorDetails } from '../errors/apiError.js';

export interface RateLimiterConfig {
  max: number;
  windowMs: number;
  message: string;
  /** Stable error code for the platform envelope (e.g. 'RATE_LIMITED'). */
  code: string;
  handler?: Options['handler'];
  keyGenerator?: Options['keyGenerator'];
  /**
   * GDR-4: count FAILED attempts only — express-rate-limit decrements the
   * counter when the response finishes with a non-error status, so a
   * successful (proved) verification never consumes the brute-force
   * budget. Omitted → every request counts (historical behavior).
   */
  skipSuccessfulRequests?: boolean;
}

/**
 * The default limit handler, exported separately so the envelope shape is
 * unit-testable without driving a full express-rate-limit store cycle.
 */
export function rateLimitHandler(
  req: Request,
  res: Response,
  _next: NextFunction,
  options: Pick<Options, 'limit' | 'windowMs' | 'statusCode'>,
  config: { code: string; message: string }
): void {
  // express-rate-limit types statusCode as optional; the library always
  // resolves it (default 429) before invoking the handler — mirror that.
  const status = options.statusCode ?? 429;
  const current = typeof options.limit === 'number' ? options.limit : 0;
  const windowMs = options.windowMs ?? 60000;
  const details = buildErrorDetails(req, { current, windowMs });
  res.status(status).json({
    error: {
      code: config.code || 'RATE_LIMITED',
      message: config.message || 'Too many requests',
      status,
      details
    }
  });
}

/**
 * Create a rate limiter middleware with the platform policy defaults.
 *
 * Example:
 *   router.use(createRateLimiter({ windowMs: 60000, max: 20, message: '…', code: 'RATE_LIMITED' }));
 */
export function createRateLimiter(config: RateLimiterConfig): ReturnType<typeof rateLimit> {
  return rateLimit({
    max: config.max,
    windowMs: config.windowMs,
    message: config.message,
    standardHeaders: true,
    legacyHeaders: false,
    ...(config.skipSuccessfulRequests ? { skipSuccessfulRequests: true } : {}),
    ...(config.keyGenerator ? { keyGenerator: config.keyGenerator } : {}),
    handler:
      config.handler ??
      ((req: Request, res: Response, next: NextFunction, options) => {
        rateLimitHandler(req, res, next, options, config);
      })
  });
}
