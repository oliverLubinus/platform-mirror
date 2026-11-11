/**
 * @file pkce.ts
 * @description
 *   PKCE (RFC 7636) + OIDC state utilities for `@agentic-dna/auth-client`.
 *   Ported from auth-provider's `frontend/src/utils/pkce.ts` (the tested,
 *   audited reference implementation — ADR-009 §1 "reuse and generalize").
 *
 *   Port adaptations (documented in packages/auth-client/README.md):
 *   - Storage is the injected `StorageAdapter` (fail-fast when unavailable)
 *     instead of silent no-ops: a lost code_verifier/state is a flow
 *     failure, and the callback fails closed either way.
 *   - Storage keys are `clientId`-namespaced so a page hosting multiple
 *     clients cannot cross-wire flows.
 *   - Public-client only: a PKCE generation failure THROWS instead of
 *     silently building a challenge-less authorize URL (the confidential
 *     fallback of the reference implementation does not exist here).
 *   - No upstream-state adoption: the reference's proxy oidc-init flow is
 *     host-specific; this SDK always mints its own state nonce.
 *
 *   Only S256 is supported. The `plain` method is not used.
 *   The `code_verifier` and `state` are stored in `sessionStorage` —
 *   tab-scoped, cleared on tab close, survive the redirect to auth-provider
 *   and back. They are NOT auth tokens (R-PKG-03 forbids tokens in storage).
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7636
 */

import type { StorageAdapter } from './config.js';
import { AuthError } from './errors.js';

const VERIFIER_BYTES = 32; // → 43 base64url chars (RFC 7636 minimum entropy)
const STATE_BYTES = 24; // → 32 base64url chars (256-bit login-CSRF nonce)

export interface PkceKeys {
  verifier: string;
  state: string;
  returnTo: string;
}

/** `clientId`-namespaced storage keys — multi-client hosts cannot cross-wire flows. */
export function pkceKeysFor(clientId: string): PkceKeys {
  return {
    verifier: `platform-auth:pkce:${clientId}`,
    state: `platform-auth:state:${clientId}`,
    returnTo: `platform-auth:returnTo:${clientId}`,
  };
}

/** Convert bytes to unpadded base64url (only unreserved URI characters). */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    // noUncheckedIndexedAccess: `i < bytes.length` guarantees the element.
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function requireGetRandomValues(): void {
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
    throw new AuthError(
      'PKCE_GENERATION_FAILED',
      'crypto.getRandomValues is not available. PKCE requires a secure browser environment.'
    );
  }
}

/**
 * Generate a CSPRNG `code_verifier` per RFC 7636 §4.1: 43-character
 * base64url derived from 32 random bytes (256-bit entropy), using only
 * unreserved URI characters.
 *
 * @throws if `crypto.getRandomValues` is unavailable (SSR / insecure context).
 */
export function generateCodeVerifier(): string {
  requireGetRandomValues();
  const randomBytes = new Uint8Array(VERIFIER_BYTES);
  crypto.getRandomValues(randomBytes);
  return bytesToBase64Url(randomBytes);
}

/**
 * Compute the S256 `code_challenge`: `BASE64URL(SHA256(code_verifier))`.
 *
 * @throws if `crypto.subtle` is unavailable.
 */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  if (typeof crypto === 'undefined' || crypto.subtle === undefined) {
    throw new AuthError(
      'PKCE_GENERATION_FAILED',
      'crypto.subtle is not available. PKCE S256 requires a secure browser environment.'
    );
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return bytesToBase64Url(new Uint8Array(digest));
}

/**
 * Generate a CSPRNG `state` nonce (login-CSRF protection, F-037 pattern):
 * 24 bytes → 32-character base64url.
 *
 * @throws if `crypto.getRandomValues` is unavailable.
 */
export function generateOidcState(): string {
  requireGetRandomValues();
  const randomBytes = new Uint8Array(STATE_BYTES);
  crypto.getRandomValues(randomBytes);
  return bytesToBase64Url(randomBytes);
}

export function storePkceVerifier(storage: StorageAdapter, keys: PkceKeys, verifier: string): void {
  storage.setItem(keys.verifier, verifier);
}

/** @returns the stored verifier, or null when absent (callback then fails closed). */
export function getPkceVerifier(storage: StorageAdapter, keys: PkceKeys): string | null {
  return storage.getItem(keys.verifier);
}

export function clearPkceVerifier(storage: StorageAdapter, keys: PkceKeys): void {
  storage.removeItem(keys.verifier);
}

export function storeOidcState(storage: StorageAdapter, keys: PkceKeys, state: string): void {
  storage.setItem(keys.state, state);
}

/** @returns the stored state, or null when absent (callback then fails closed). */
export function getOidcState(storage: StorageAdapter, keys: PkceKeys): string | null {
  return storage.getItem(keys.state);
}

/**
 * Clear the stored state — called by the callback AFTER the comparison, on
 * match AND mismatch, so a state value can never be reused for a second
 * exchange (single-use, F-037 semantics).
 */
export function clearOidcState(storage: StorageAdapter, keys: PkceKeys): void {
  storage.removeItem(keys.state);
}

export function storeReturnTo(storage: StorageAdapter, keys: PkceKeys, returnTo: string): void {
  storage.setItem(keys.returnTo, returnTo);
}

/** @returns the stored returnTo target, or null when absent. */
export function getReturnTo(storage: StorageAdapter, keys: PkceKeys): string | null {
  return storage.getItem(keys.returnTo);
}

export function clearReturnTo(storage: StorageAdapter, keys: PkceKeys): void {
  storage.removeItem(keys.returnTo);
}

export interface AuthorizeUrlParams {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  /** App navigation target restored by the callback (stored, never put in the URL). */
  returnTo?: string;
}

/**
 * Build the OIDC authorize URL and persist the flow's short-lived state.
 *
 * Query parameters (consumer-integration guide §4.1, code-verified against
 * the live `validateAuthorizeRequest` middleware): `client_id`,
 * `redirect_uri`, `response_type=code`, `scope`, `state`,
 * `code_challenge`, `code_challenge_method=S256`. No `client_secret` —
 * the authorize endpoint is a browser redirect and never carries secrets.
 * No `prompt` — the backend supports only `consent` (H-14) and we want the
 * default behavior (auto-approve within the standing grant).
 *
 * @throws when PKCE/state generation or storage fails — fail closed, the
 *   caller never redirects to a challenge-less URL.
 */
export async function buildAuthorizeUrl(
  authorizeEndpointUrl: string,
  storage: StorageAdapter,
  keys: PkceKeys,
  params: AuthorizeUrlParams
): Promise<string> {
  const url = new URL(authorizeEndpointUrl);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', params.scopes.join(' '));

  // F-037: bind the redirect to a browser-held nonce, compared at the
  // callback BEFORE any token exchange.
  const state = generateOidcState();
  storeOidcState(storage, keys, state);
  url.searchParams.set('state', state);

  if (params.returnTo !== undefined) {
    // App navigation target rides in storage, never in the URL
    // (R-PKG-03: no tokens/secrets in URLs; returnTo is app state).
    storeReturnTo(storage, keys, params.returnTo);
  }

  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  storePkceVerifier(storage, keys, verifier);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');

  return url.toString();
}
