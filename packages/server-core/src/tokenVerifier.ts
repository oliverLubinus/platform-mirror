/**
 * @file tokenVerifier.ts
 * @description
 *   The REAL access-token verifier for auth-provider-issued JWTs (T1.5c) —
 *   replaces the fail-closed `failClosedVerifier` stub for every platform
 *   app backend. Zero-dependency: HS256 verification is HMAC-SHA256 plus
 *   constant-time comparison, both in `node:crypto` — no jose, no JSON Web
 *   library, keeping @platform/server-core dependency-free.
 *
 *   Reality note (deliberate divergence from the plan's "JWKS" wording):
 *   the live issuer signs HS256 with a SHARED SECRET and deliberately omits
 *   `jwks_uri` from discovery (discoveryService.ts). So this verifier
 *   consumes the issuer's key RING (`JWT_SIGNING_KEYS` + `JWT_ACTIVE_KID`,
 *   rotation-aware) delivered per environment. RS256 + a JWKS endpoint is
 *   the auth-provider hardening path (T4.1); when it lands, this module
 *   gains a `jwks` fetch mode WITHOUT changing the TokenVerifier contract.
 *
 *   Fail-closed order (every step rejects on the first mismatch):
 *     1. structural parse (3 dot-separated base64url parts),
 *     2. alg pinning — HS256 ONLY (alg-confusion protection: no `none`,
 *        no RS/ES downgrade tricks),
 *     3. kid → key-ring lookup (unknown kid rejected; missing kid accepted
 *        only when the ring holds exactly one key),
 *     4. HMAC-SHA256 signature, `crypto.timingSafeEqual` (length-guarded),
 *     5. claim contract: iss (trailing-slash normalized), aud (string or
 *        array containing the expected value), exp MANDATORY, nbf/iat
 *        skew-checked, sub non-empty.
 *
 *   Reasons are thrown as ApiError('UNAUTHENTICATED') — `requireAuth`
 *   converts every rejection to the same generic 401 envelope (no caller-
 *   visible reason leakage); the precise reason exists for server logs.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from './errors/apiError.js';
import type { TokenVerifier, VerifiedToken } from './express/auth.js';

/** One issuer signing key — mirrors auth-provider's key ring entries. */
export interface IssuerKey {
  kid: string;
  secret: string;
}

export interface TokenVerifierConfig {
  /** The issuer's key ring (rotation-aware: verify by header kid). */
  keys: IssuerKey[];
  /** Expected `iss` claim (trailing slashes normalized on both sides). */
  issuer: string;
  /** Expected `aud` claim — the app's registered client id. */
  audience: string;
  /** Clock-skew tolerance in seconds for exp/nbf/iat (default 30). */
  clockSkewSeconds?: number;
}

interface JwtHeaderShape {
  alg?: unknown;
  kid?: unknown;
  [claim: string]: unknown;
}

interface JwtClaimsShape extends VerifiedToken {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  iat?: unknown;
  nbf?: unknown;
  scope?: unknown;
}

function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/+$/, '');
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError('UNAUTHENTICATED', `Token rejected: ${what} missing or malformed`, 401);
  }
  return value;
}

function b64urlToJson(part: string, what: string): Record<string, unknown> {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(part, 'base64url');
  } catch {
    throw new ApiError('UNAUTHENTICATED', `Token rejected: ${what} is not base64url`, 401);
  }
  try {
    const parsed: unknown = JSON.parse(decoded.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiError('UNAUTHENTICATED', `Token rejected: ${what} is not valid JSON`, 401);
  }
}

/**
 * Create a TokenVerifier bound to the issuer's key ring and claim contract.
 * Config problems throw AT CREATION (fail fast — never degrade to a
 * silently-accepting or silently-rejecting verifier at request time).
 */
export function createTokenVerifier(config: TokenVerifierConfig): TokenVerifier {
  if (config.keys.length === 0) {
    throw new ApiError('CONFIG_INVALID', 'Token verifier: the key ring is empty', 500);
  }
  for (const key of config.keys) {
    if (typeof key.kid !== 'string' || key.kid.length === 0 || typeof key.secret !== 'string' || key.secret.length === 0) {
      throw new ApiError('CONFIG_INVALID', 'Token verifier: every key needs a non-empty kid and secret', 500);
    }
  }
  const issuer = normalizeIssuer(requireString(config.issuer, 'config.issuer'));
  const audience = requireString(config.audience, 'config.audience');
  const skew = config.clockSkewSeconds ?? 30;
  const byKid = new Map(config.keys.map((k) => [k.kid, k.secret]));

  return async (token: string): Promise<VerifiedToken> => {
    // 1. structural parse
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
      throw new ApiError('UNAUTHENTICATED', 'Token rejected: not a three-part JWT', 401);
    }
    const header = b64urlToJson(parts[0]!, 'header') as JwtHeaderShape;

    // 2. alg pinning (fail closed against alg-confusion)
    if (header['alg'] !== 'HS256') {
      throw new ApiError('UNAUTHENTICATED', `Token rejected: alg must be HS256 (got ${String(header['alg'])})`, 401);
    }

    // 3. kid → key-ring lookup
    const kid = typeof header['kid'] === 'string' ? header['kid'] : null;
    let secret: string | undefined;
    if (kid === null) {
      if (config.keys.length !== 1) {
        throw new ApiError('UNAUTHENTICATED', 'Token rejected: header kid missing and the key ring is ambiguous', 401);
      }
      secret = config.keys[0]!.secret;
    } else {
      secret = byKid.get(kid);
      if (secret === undefined) {
        throw new ApiError('UNAUTHENTICATED', `Token rejected: unknown kid "${kid}" (rotation gap or forgery)`, 401);
      }
    }

    // 4. signature — constant-time compare
    const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
    const provided = Buffer.from(parts[2]!, 'base64url');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new ApiError('UNAUTHENTICATED', 'Token rejected: signature verification failed', 401);
    }

    // 5. claim contract
    const claims = b64urlToJson(parts[1]!, 'payload') as JwtClaimsShape;
    const iss = requireString(claims['iss'], 'iss');
    if (normalizeIssuer(iss) !== issuer) {
      throw new ApiError('UNAUTHENTICATED', `Token rejected: iss mismatch (got ${iss})`, 401);
    }
    const aud = claims['aud'];
    const audOk =
      typeof aud === 'string' ? aud === audience : Array.isArray(aud) ? aud.includes(audience) : false;
    if (!audOk) {
      throw new ApiError('UNAUTHENTICATED', `Token rejected: aud mismatch (got ${String(aud)})`, 401);
    }
    const nowSeconds = Date.now() / 1000;
    const exp = claims['exp'];
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= nowSeconds - skew) {
      throw new ApiError('UNAUTHENTICATED', 'Token rejected: expired or missing exp', 401);
    }
    if (claims['nbf'] !== undefined) {
      const nbf = claims['nbf'];
      if (typeof nbf === 'number' && nbf > nowSeconds + skew) {
        throw new ApiError('UNAUTHENTICATED', 'Token rejected: not yet valid (nbf)', 401);
      }
    }
    if (claims['iat'] !== undefined) {
      const iat = claims['iat'];
      if (typeof iat === 'number' && iat > nowSeconds + skew) {
        throw new ApiError('UNAUTHENTICATED', 'Token rejected: iat in the future', 401);
      }
    }
    requireString(claims['sub'], 'sub');

    // All claims forward (scope, amr, acr, sid, ...) — opaque to the middleware.
    return claims as VerifiedToken;
  };
}