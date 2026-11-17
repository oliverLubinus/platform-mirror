/**
 * @file tokenVerifier.ts
 * @description
 *   The REAL access-token verifier for auth-provider-issued JWTs (T1.5c,
 *   extended by WS-4 gate 1's consumer half — R-AUTH-76/77). Two
 *   verification sources, driven by the token's own alg header (per-key-kind
 *   alg allowlist, R-AUTH-76 — the classic alg-confusion family is
 *   structurally impossible):
 *
 *   - oct (HS256 shared-secret ring, `keys` config): the legacy interim.
 *     Verification only; the issuer stops distributing shared secrets after
 *     the documented overlap window.
 *   - jwks (RS256, `jwksUri` config): fetch the issuer's published JWKS
 *     (RFC 7517), cache it honoring `max-age` (capped at 300s per R-AUTH-77),
 *     single-flight refetch on an unknown kid (rotation: new keys appear in
 *     the JWKS BEFORE signing switches to them). Dependency-free — RSA
 *     verification via node:crypto (JWK import, no jose library), keeping
 *     @agentic-dna/server-core dependency-free.
 *
 *   Modes: `keys` only = oct-only (legacy), `jwksUri` only = jwks-only (the
 *   end state — the shared secret is dropped entirely), both = the documented
 *   overlap window (oct tokens verify against the ring while in-flight;
 *   new RS256 tokens verify against the JWKS).
 *
 *   Fail-closed order (every step rejects on the first mismatch):
 *     1. structural parse (3 dot-separated base64url parts),
 *     2. alg allowlist — HS256 (oct path) or RS256 (jwks path) ONLY; no
 *        `none`, no other algorithms, no cross-kind verification,
 *     3. kid → key lookup — oct: ring lookup (missing kid accepted only
 *        with a single-key ring, unchanged); jwks: kid MANDATORY (the
 *        issuer emits kid-mandatory headers, R-AUTH-74), unknown kid
 *        triggers one single-flight JWKS refetch before rejection,
 *     4. signature — HMAC-SHA256 + `crypto.timingSafeEqual` (oct) or
 *        RSA-SHA256 via node:crypto (jwks),
 *     5. claim contract: iss (trailing-slash normalized), aud (string or
 *        array containing the expected value), exp MANDATORY, nbf/iat
 *        skew-checked, sub non-empty — IDENTICAL for both paths.
 *
 *   JWKS fetch failures are fail-closed (UNAUTHENTICATED — never
 *   fail-open, never cached). jwksUri is validated AT CREATION: https, or
 *   http only for loopback hosts (the dev issuer convention).
 *
 *   Reasons are thrown as ApiError('UNAUTHENTICATED') — `requireAuth`
 *   converts every rejection to the same generic 401 envelope (no caller-
 *   visible reason leakage); the precise reason exists for server logs.
 */

import { createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { ApiError } from './errors/apiError.js';
import type { TokenVerifier, VerifiedToken } from './express/auth.js';

/** One issuer signing key — mirrors auth-provider's key ring entries. */
export interface IssuerKey {
  kid: string;
  secret: string;
}

/** The issuer's JWKS cache TTL is capped at 300s (R-AUTH-77 contract). */
const JWKS_MAX_AGE_CAP_SECONDS = 300;

export interface TokenVerifierConfig {
  /** The issuer's oct key ring (rotation-aware: verify by header kid).
   *  Optional once `jwksUri` is configured — drop it entirely when the
   *  issuer retires its shared secrets (R-AUTH-76 window end). */
  keys?: IssuerKey[];
  /** The issuer's published JWKS URL (RFC 7517). https, or http only for
   *  loopback hosts (dev convention). Enables the RS256 path. */
  jwksUri?: string;
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

interface JwksKeyEntry {
  kid: string;
  publicKey: KeyObject;
}

interface JwksCache {
  keys: Map<string, JwksKeyEntry>;
  fetchedAtMs: number;
  maxAgeSeconds: number;
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

/** jwksUri validation: https always; http only for loopback (dev issuer). */
function assertJwksUriAllowed(jwksUri: string): URL {
  let url: URL;
  try {
    url = new URL(jwksUri);
  } catch {
    throw new ApiError('CONFIG_INVALID', 'Token verifier: jwksUri is not a valid URL', 500);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'];
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && loopback.includes(url.hostname)) return url;
  throw new ApiError(
    'CONFIG_INVALID',
    'Token verifier: jwksUri must be https (http is allowed only for loopback hosts)',
    500
  );
}

function unauthenticated(reason: string): ApiError {
  return new ApiError('UNAUTHENTICATED', `Token rejected: ${reason}`, 401);
}

/**
 * Create a TokenVerifier bound to the issuer's key material and claim
 * contract. Config problems throw AT CREATION (fail fast — never degrade
 * to a silently-accepting or silently-rejecting verifier at request time).
 */
export function createTokenVerifier(config: TokenVerifierConfig): TokenVerifier {
  const keys = config.keys ?? [];
  for (const key of keys) {
    if (typeof key.kid !== 'string' || key.kid.length === 0 || typeof key.secret !== 'string' || key.secret.length === 0) {
      throw new ApiError('CONFIG_INVALID', 'Token verifier: every key needs a non-empty kid and secret', 500);
    }
  }
  if (keys.length === 0 && config.jwksUri === undefined) {
    throw new ApiError(
      'CONFIG_INVALID',
      'Token verifier: no key material configured (provide keys, jwksUri, or both)',
      500
    );
  }
  if (config.jwksUri !== undefined) {
    assertJwksUriAllowed(config.jwksUri);
  }
  const issuer = normalizeIssuer(requireString(config.issuer, 'config.issuer'));
  const audience = requireString(config.audience, 'config.audience');
  const skew = config.clockSkewSeconds ?? 30;
  const byKid = new Map(keys.map((k) => [k.kid, k.secret]));

  // ---- JWKS fetch-cache (R-AUTH-77) ---------------------------------------
  const jwksUri = config.jwksUri;
  let cache: JwksCache | null = null;
  let inflight: Promise<void> | null = null;

  async function fetchJwks(): Promise<void> {
    let res: Response;
    try {
      res = await fetch(jwksUri!);
    } catch (err) {
      throw unauthenticated(`JWKS fetch failed (${(err as Error).message}) — fail-closed`);
    }
    if (!res.ok) {
      throw unauthenticated(`JWKS fetch failed (HTTP ${res.status}) — fail-closed`);
    }
    const cacheControl = res.headers.get('cache-control') ?? '';
    const match = /max-age\s*=\s*(\d+)/i.exec(cacheControl);
    const maxAgeSeconds = Math.min(match ? Number(match[1]) : JWKS_MAX_AGE_CAP_SECONDS, JWKS_MAX_AGE_CAP_SECONDS);
    let body: { keys?: unknown };
    try {
      body = (await res.json()) as { keys?: unknown };
    } catch {
      throw unauthenticated('JWKS is not valid JSON — fail-closed');
    }
    const jwks = Array.isArray(body.keys) ? body.keys : null;
    if (jwks === null) {
      throw unauthenticated('JWKS payload has no keys array — fail-closed');
    }
    const entries = new Map<string, JwksKeyEntry>();
    for (const raw of jwks) {
      if (typeof raw !== 'object' || raw === null) continue;
      const jwk = raw as Record<string, unknown>;
      // Only RSA signing keys are verification material: skip kty=oct/EC,
      // use=enc, and non-RS256 algs (the issuer publishes RSA/RS256/sig).
      if (jwk['kty'] !== 'RSA' || (jwk['use'] !== undefined && jwk['use'] !== 'sig')) continue;
      if (jwk['alg'] !== undefined && jwk['alg'] !== 'RS256') continue;
      const kid = jwk['kid'];
      const n = jwk['n'];
      const e = jwk['e'];
      if (typeof kid !== 'string' || kid.length === 0 || typeof n !== 'string' || typeof e !== 'string') continue;
      let publicKey: KeyObject;
      try {
        publicKey = createPublicKey({ key: { kty: 'RSA', n, e }, format: 'jwk' });
      } catch {
        continue; // malformed key material — skip, never trust partially
      }
      entries.set(kid, { kid, publicKey });
    }
    if (entries.size === 0) {
      throw unauthenticated('JWKS carries no usable RSA signing keys — fail-closed');
    }
    cache = { keys: entries, fetchedAtMs: Date.now(), maxAgeSeconds };
  }

  function ensureFetched(): Promise<void> {
    if (cache !== null && Date.now() - cache.fetchedAtMs < cache.maxAgeSeconds * 1000) {
      return Promise.resolve();
    }
    return refresh();
  }

  /** Single-flight refresh: concurrent verifications share one fetch. */
  function refresh(): Promise<void> {
    if (inflight === null) {
      inflight = fetchJwks().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  async function resolveJwksKey(kid: string): Promise<JwksKeyEntry> {
    await ensureFetched();
    // cache is non-null after a resolved fetch (fail-closed throws otherwise)
    let entry = cache!.keys.get(kid);
    if (entry === undefined) {
      // Rotation gap: the kid is unknown to the cache — refetch ONCE
      // (single-flight, TTL-bypassing) before rejecting (R-AUTH-77).
      await refresh();
      entry = cache!.keys.get(kid);
    }
    if (entry === undefined) {
      throw unauthenticated(`unknown kid "${kid}" (rotation gap or forgery)`);
    }
    return entry;
  }

  // ---- claim contract (shared by both paths) ------------------------------
  function assertClaims(claims: JwtClaimsShape): void {
    const iss = requireString(claims['iss'], 'iss');
    if (normalizeIssuer(iss) !== issuer) {
      throw unauthenticated(`iss mismatch (got ${iss})`);
    }
    const aud = claims['aud'];
    const audOk =
      typeof aud === 'string' ? aud === audience : Array.isArray(aud) ? aud.includes(audience) : false;
    if (!audOk) {
      throw unauthenticated(`aud mismatch (got ${String(aud)})`);
    }
    const nowSeconds = Date.now() / 1000;
    const exp = claims['exp'];
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= nowSeconds - skew) {
      throw unauthenticated('expired or missing exp');
    }
    if (claims['nbf'] !== undefined) {
      const nbf = claims['nbf'];
      if (typeof nbf === 'number' && nbf > nowSeconds + skew) {
        throw unauthenticated('not yet valid (nbf)');
      }
    }
    if (claims['iat'] !== undefined) {
      const iat = claims['iat'];
      if (typeof iat === 'number' && iat > nowSeconds + skew) {
        throw unauthenticated('iat in the future');
      }
    }
    requireString(claims['sub'], 'sub');
  }

  return async (token: string): Promise<VerifiedToken> => {
    // 1. structural parse
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
      throw unauthenticated('not a three-part JWT');
    }
    const header = b64urlToJson(parts[0]!, 'header') as JwtHeaderShape;

    // 2. alg allowlist (per key kind — R-AUTH-76; cross-kind is impossible)
    const alg = header['alg'];
    if (alg !== 'HS256' && alg !== 'RS256') {
      throw unauthenticated(`alg must be HS256 or RS256 (got ${String(alg)})`);
    }
    const kid = typeof header['kid'] === 'string' ? header['kid'] : null;
    const signingInput = `${parts[0]}.${parts[1]}`;

    let claims: JwtClaimsShape;
    if (alg === 'HS256') {
      // ---- oct path: the shared-secret ring (the documented overlap interim)
      if (keys.length === 0) {
        throw unauthenticated('HS256 token but no oct key ring is configured');
      }
      let secret: string | undefined;
      if (kid === null) {
        if (keys.length !== 1) {
          throw unauthenticated('header kid missing and the key ring is ambiguous');
        }
        secret = keys[0]!.secret;
      } else {
        secret = byKid.get(kid);
        if (secret === undefined) {
          throw unauthenticated(`unknown kid "${kid}" (rotation gap or forgery)`);
        }
      }
      const expected = createHmac('sha256', secret).update(signingInput).digest();
      const provided = Buffer.from(parts[2]!, 'base64url');
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        throw unauthenticated('signature verification failed');
      }
      claims = b64urlToJson(parts[1]!, 'payload') as JwtClaimsShape;
    } else {
      // ---- jwks path: RS256 against the issuer's published keys
      if (jwksUri === undefined) {
        throw unauthenticated('RS256 token but no jwksUri is configured');
      }
      if (kid === null) {
        throw unauthenticated('RS256 tokens must carry a kid header (R-AUTH-74)');
      }
      const entry = await resolveJwksKey(kid);
      const provided = Buffer.from(parts[2]!, 'base64url');
      const ok = cryptoVerify('RSA-SHA256', Buffer.from(signingInput), entry.publicKey, provided);
      if (!ok) {
        throw unauthenticated('signature verification failed');
      }
      claims = b64urlToJson(parts[1]!, 'payload') as JwtClaimsShape;
    }

    // 5. claim contract
    assertClaims(claims);

    // All claims forward (scope, amr, acr, sid, ...) — opaque to the middleware.
    return claims as VerifiedToken;
  };
}