/**
 * Auth request helpers + the `requireAuth` middleware (T1.3d).
 *
 * Ported from auth-provider's live `backend/src/utils/auth.ts`
 * (copy → generalize): token extraction and user-id helpers are framework
 * plumbing, not auth logic — they belong to the platform.
 *
 * F-031 (carried over): the `?access_token=` query-parameter fallback is
 * FORBIDDEN — query strings land in server logs, browser history, and
 * Referer headers, which turns short-lived credentials into long-lived log
 * artifacts. Tokens travel via the Authorization header only.
 *
 * The JWKS verifier is SPEC-FIRST (like the event-consumer template):
 * consumer apps (PM/chat/agentic) verify tokens issued by the auth provider
 * against its JWKS. The interface below is the standing contract; the real
 * verifier (JWKS fetch + cache + signature/alg/kid checks) lands with the
 * app-template integration (T1.5) against the live provider. The default
 * verifier fails closed: it rejects everything rather than pretending to
 * verify.
 */

import type { Request, Response, NextFunction } from 'express';
import { ApiError } from '../errors/apiError.js';

/**
 * Extract the access token from the Authorization header ONLY.
 * F-031: no query-parameter fallback — relying parties must send tokens via
 * the Authorization header.
 */
export function extractAccessToken(req: Request): string | undefined {
  if (typeof req.headers.authorization === 'string') {
    const parts = req.headers.authorization.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      return parts[1];
    }
  }
  return undefined;
}

/**
 * Extract the authenticated subject's id from the request (type-safe view
 * over whatever the app's auth middleware has attached as req.user). Uses a
 * LOCAL cast — this module deliberately does NOT globally augment Express's
 * Request, so it can never conflict with an app's own user typing.
 */
export function getUserId(req: Request): string | undefined {
  const user = (req as { user?: unknown }).user as { id?: unknown } | undefined;
  return typeof user?.id === 'string' ? user.id : undefined;
}

/**
 * Extracts the authenticated subject's id from the request, or throws an
 * ApiError (platform envelope, 401 UNAUTHENTICATED) if not authenticated.
 *
 * Divergence from the live module (documented): the code is the platform
 * base `UNAUTHENTICATED` (integration contract §3) — auth-provider used its
 * own `UNAUTHORIZED`. auth-provider keeps its behavior; new platform apps
 * must not depend on the old code.
 */
export function getUserIdOrThrow(req: Request): string {
  const id = getUserId(req);
  if (id === undefined) {
    throw new ApiError('UNAUTHENTICATED', 'Not authenticated', 401);
  }
  return id;
}

/** Minimal verified-token claim set the middleware needs. */
export interface VerifiedToken {
  /** Token subject — attached as req.user.id. */
  sub: string;
  /** Extra claims forwarded onto req.user (opaque to the middleware). */
  [claim: string]: unknown;
}

/**
 * The token-verification contract consumer apps must satisfy. Implementations
 * MUST: fetch + cache the provider JWKS, verify signature AND algorithm
 * (whitelist — never trust the token header's alg blindly), check kid, and
 * enforce expiry/issuer/audience. Anything not provably verified must throw.
 */
export type TokenVerifier = (token: string) => Promise<VerifiedToken>;

/** The default verifier: fail closed (rejects everything, never verifies). */
export const failClosedVerifier: TokenVerifier = async () => {
  throw new ApiError('UNAUTHENTICATED', 'Token verifier not configured', 401);
};

export interface RequireAuthOptions {
  /** Token verifier — see TokenVerifier contract. Default: fail closed. */
  verify?: TokenVerifier;
}

/**
 * Express middleware: require a verifiable Bearer token. On success, attaches
 * the verified claims as req.user; on any failure, responds with the platform
 * envelope (401 UNAUTHENTICATED) and does NOT leak the reason to the caller
 * (401 bodies say "Not authenticated" whether the token was missing, stale,
 * or invalid — the precise reason goes to server logs via the error code).
 */
export function requireAuth(options: RequireAuthOptions = {}): (req: Request, res: Response, next: NextFunction) => void {
  const verify = options.verify ?? failClosedVerifier;
  return (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      const token = extractAccessToken(req);
      if (!token) {
        res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Not authenticated', status: 401 } });
        return;
      }
      try {
        const claims = await verify(token);
        // Local cast — no global Express augmentation (see getUserId).
        (req as { user?: unknown }).user = claims;
        next();
      } catch {
        // Fail closed, no reason leakage: same body for all rejection causes.
        res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Not authenticated', status: 401 } });
      }
    })();
  };
}
