/**
 * Security headers — ported verbatim from auth-provider's live
 * `backend/src/middleware/securityHeaders.ts` (H-04), copy → generalize.
 *
 * securityHeaders — applied APP-WIDE (every platform app surface is an API
 * or app-flow endpoint, so there is no "innocent" route to exclude):
 *  - X-Frame-Options: DENY + CSP frame-ancestors 'none'  → login/consent/2FA
 *    flows cannot be clickjacked (legacy + modern engines respectively).
 *  - Referrer-Policy: no-referrer → single-use codes/challenges in URLs can
 *    never leak into a downstream Referer header.
 *  - X-Content-Type-Options: nosniff → baseline MIME-confusion hardening.
 *
 * noStore — applied per route to responses carrying SINGLE-USE credentials:
 * token grants (access/refresh tokens), authorize redirects carrying codes,
 * login responses carrying the 2FA challenge (and the session-establishing
 * completion), and revocation endpoints (RFC 7009 requires no-store). Keeps
 * them out of shared caches and browser back/forward caches.
 */

import type { Request, Response, NextFunction } from 'express';

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}

export function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}
