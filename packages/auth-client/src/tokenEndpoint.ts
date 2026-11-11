/**
 * @file tokenEndpoint.ts
 * @description
 *   Direct token-endpoint client for `@agentic-dna/auth-client`.
 *
 *   Contract is CODE-VERIFIED against the live auth-provider backend
 *   (2026-11-06): `POST /auth/token` (backend `tokenHandler` +
 *   `validateTokenRequest` middleware; consumer-integration guide §3/§4.1):
 *   - body is `application/x-www-form-urlencoded` (the guide's canonical
 *     form; the backend mounts `express.urlencoded` for this route and
 *     accepts JSON only via the hosted UI's server-side exchange proxy —
 *     public SPAs use the direct form POST).
 *   - authorization_code grant: `grant_type, code, redirect_uri, client_id,
 *     code_verifier` — public clients send NO `client_secret` (rejected as
 *     invalid_client if they do) and PKCE is REQUIRED.
 *   - refresh_token grant: `grant_type, client_id` + `refresh_token` in the
 *     body (live behavior). The target ADR-004 §2 behavior (credential from
 *     the parent-domain httpOnly cookie, body omits it) is NOT implemented
 *     server-side yet — this client supports both shapes so the backend
 *     change is a config flip, not an SDK release.
 *   - success response (RFC 6749 §5.1): `{ access_token, id_token,
 *     refresh_token, token_type, expires_in }` — shape-validated by the
 *     token store (single validation point).
 *   - error response (RFC 6749 §5.2): `{ error, error_description? }` as
 *     `application/json`. Unknown paths answer HTML — bodies are parsed
 *     defensively (status first, JSON only when parseable; OAuthError keeps
 *     unparseable bodies as raw evidence).
 *   - `/auth/token` is CSRF-exempt (validateCsrfToken exempt list) — no
 *     CSRF header needed.
 *
 *   NO automatic retry: the exchange code is single-use and the refresh
 *   token rotates on every use — blind retries of a lost response risk
 *   triggering replay detection (family revocation, F-030). A timeout
 *   surfaces as a clean TIMEOUT error.
 */

import type { ResolvedAuthClientConfig } from './config.js';
import { AuthError, OAuthError } from './errors.js';

/** Raw RFC 6749 §5.1 token response (snake_case over the wire). */
export interface RawTokenResponse {
  access_token: string;
  token_type: string;
  /** Optional in the SDK's view: always present from the live backend;
   *  its ABSENCE is the signal of a cookie-backed backend (target state). */
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
}

/** Strict shape guard — fail closed on anything unexpected. */
export function isRawTokenResponse(value: unknown): value is RawTokenResponse {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r['access_token'] === 'string' &&
    r['access_token'].length > 0 &&
    typeof r['token_type'] === 'string' &&
    r['token_type'].length > 0 &&
    typeof r['expires_in'] === 'number' &&
    Number.isFinite(r['expires_in']) &&
    r['expires_in'] > 0 &&
    (r['refresh_token'] === undefined || typeof r['refresh_token'] === 'string') &&
    (r['id_token'] === undefined || typeof r['id_token'] === 'string')
  );
}

async function postTokenEndpoint(
  config: ResolvedAuthClientConfig,
  body: URLSearchParams
): Promise<unknown> {
  const signal = AbortSignal.timeout(config.timeoutMs);
  let response: Response;
  try {
    response = await config.fetchImpl(config.tokenUrl, {
      method: 'POST',

      headers: new Headers({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      credentials: 'include', // rides the parent-domain refresh cookie when one exists
      body: body.toString(),
      signal,
    });
  } catch (err) {
    // Timeout / network failure — no internals, no token material in messages.
    const timedOut =
      signal.aborted &&
      (signal as AbortSignal & { reason?: { name?: string } }).reason?.name === 'TimeoutError';
    throw new AuthError(timedOut ? 'TIMEOUT' : 'NETWORK_FAILURE', 'The token endpoint could not be reached.', {
      cause: err,
    });
  }

  if (!response.ok) {
    const text = await response.text().catch(() => null);
    throw OAuthError.fromResponse(response.status, text);
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new AuthError(
      'MALFORMED_TOKEN_RESPONSE',
      'The token endpoint returned a non-JSON success response.'
    );
  }
  return parsed;
}

/**
 * Exchange an authorization code for tokens (public client, PKCE).
 * The code is single-use: a second attempt fails with `invalid_grant`.
 *
 * @returns the raw token response — the token store performs the shape
 *   validation (single validation point) and maps it to the session.
 */
export async function exchangeAuthorizationCode(
  config: ResolvedAuthClientConfig,
  code: string,
  codeVerifier: string
): Promise<unknown> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    code_verifier: codeVerifier,
  });
  return postTokenEndpoint(config, body);
}

/**
 * Refresh grant. `refreshToken` is the in-memory rotating credential
 * (interim) or `null` for the cookie-backed mode (body omits the token —
 * the credential rides the parent-domain cookie when the backend ships it).
 *
 * @throws AuthError('REFRESH_UNAVAILABLE') in `memory`/`auto` mode when no
 *   in-memory credential exists (e.g. after a page reload — the reload path
 *   is a redirect re-auth, see client.ensureSession).
 * @throws OAuthError('invalid_grant') when the credential was rotated away,
 *   expired, revoked, or replayed — the app must re-authenticate (ADR-005).
 */
export async function refreshTokens(
  config: ResolvedAuthClientConfig,
  refreshToken: string | null
): Promise<unknown> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.clientId,
  });
  if (refreshToken !== null) {
    body.set('refresh_token', refreshToken);
  }
  return postTokenEndpoint(config, body);
}

/** Raw GET /auth/userinfo — status/shape handling stays with the caller. */
export async function fetchUserInfoResponse(
  config: ResolvedAuthClientConfig,
  accessToken: string
): Promise<Response> {
  const signal = AbortSignal.timeout(config.timeoutMs);
  try {
    return await config.fetchImpl(config.userinfoUrl, {
      headers: new Headers({ Authorization: `Bearer ${accessToken}` }),
      credentials: 'include',
      signal,
    });
  } catch (err) {
    const timedOut =
      signal.aborted &&
      (signal as AbortSignal & { reason?: { name?: string } }).reason?.name === 'TimeoutError';
    throw new AuthError(timedOut ? 'TIMEOUT' : 'NETWORK_FAILURE', 'The userinfo endpoint could not be reached.', {
      cause: err,
    });
  }
}