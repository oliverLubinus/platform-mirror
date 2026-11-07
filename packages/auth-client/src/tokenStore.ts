/**
 * @file tokenStore.ts
 * @description
 *   In-memory token store (R-PKG-03: tokens never in localStorage/
 *   sessionStorage). Port of auth-provider's `frontend/src/utils/
 *   tokenManager.ts`, hardened for the platform:
 *
 *   - Shape guard at the boundary: `storeTokens` validates the raw RFC 6749
 *     §5.1 response and throws on anything unexpected (fail closed).
 *   - Expiry with safety skew, computed once at store time.
 *   - Claim-once refresh semantics: `claimRefreshToken()` hands the
 *     credential to exactly one in-flight refresh and forgets it until
 *     `restoreRefreshToken()` re-arms it. Two concurrent 401 recoveries can
 *     therefore never send the same refresh token twice — the second use
 *     would be a replay and would revoke the whole token family (F-030).
 *   - Terminal-refresh-failure policy lives here (`onRefreshFailed`):
 *     `requiresReauth` OAuthErrors clear the session; transient ones do not.
 *   - Subscription surface for the future React adapter.
 *
 *   Structural guarantee: this module has NO storage parameter and no
 *   reference to any persistence API — tokens cannot outlive the JS realm.
 *   The sourceRules test scans the package for forbidden storage access.
 */

import { isRawTokenResponse, type RawTokenResponse } from './tokenEndpoint.js';
import { OAuthError } from './errors.js';

/** In-memory session. Token values never leave their holders' memory. */
export interface AuthSession {
  accessToken: string;
  /**
   * Raw ID token — UNVALIDATED client-side (no JWKS yet; HS256 secret must
   * not live in the browser). Exposed only so apps can forward it to their
   * backend, which owns validation (ADR-004 second fence). Never authorize
   * on it client-side.
   */
  idToken: string | null;
  /** Rotating silent-refresh credential (interim, in-memory — see README). */
  refreshToken: string | null;
  /** Epoch ms at which the access token expires (server TTL minus skew). */
  expiresAt: number;
}

export type SessionListener = (session: AuthSession | null) => void;

export interface TokenStoreOptions {
  /** Expiry safety skew in seconds (default 30). */
  skewSeconds?: number;
}

export class TokenStore {
  private session: AuthSession | null = null;
  private readonly listeners = new Set<SessionListener>();
  private readonly skewSeconds: number;
  private readonly now: () => number;

  constructor(now: () => number = Date.now, options?: TokenStoreOptions) {
    this.now = now;
    this.skewSeconds = options?.skewSeconds ?? 30;
  }

  /**
   * Validate and store a raw RFC 6749 §5.1 token response.
   *
   * @throws AuthError('MALFORMED_TOKEN_RESPONSE') on any shape deviation —
   *   a malformed grant is a contract violation, never "best effort".
   */
  storeTokens(raw: unknown): AuthSession {
    if (!isRawTokenResponse(raw)) {
      throw new Error('MALFORMED_TOKEN_RESPONSE: token response is missing access_token/expires_in');
    }
    const grant = raw as RawTokenResponse;
    this.session = {
      accessToken: grant.access_token,
      idToken: grant.id_token ?? null,
      refreshToken: grant.refresh_token ?? null,
      expiresAt: this.now() + (grant.expires_in - this.skewSeconds) * 1000,
    };
    this.emit();
    return this.session;
  }

  getAccessToken(): string | null {
    return this.session?.accessToken ?? null;
  }

  getSession(): AuthSession | null {
    return this.session;
  }

  clear(): void {
    this.session = null;
    this.emit();
  }

  /** Whether a silent-refresh credential is currently available. */
  canRefresh(): boolean {
    return this.session?.refreshToken != null;
  }

  /**
   * Hand the refresh credential to one in-flight refresh and forget it
   * (claim-once). Returns null when no credential is available (including
   * while a refresh is already in flight).
   */
  claimRefreshToken(): string | null {
    const token = this.session?.refreshToken ?? null;
    if (token !== null && this.session) {
      this.session = { ...this.session, refreshToken: null };
    }
    return token;
  }

  /**
   * Re-arm the credential after a FAILED refresh attempt (the server-side
   * rotation never happened, so the token is still valid).
   */
  restoreRefreshToken(refreshToken: string): void {
    if (this.session) {
      this.session = { ...this.session, refreshToken };
    }
  }

  /**
   * Refresh-failure policy: terminal OAuth errors (`requiresReauth`) clear
   * the session — the credential, and with replay detection possibly the
   * whole family, is dead server-side (ADR-005). Transient failures keep
   * the session.
   */
  onRefreshFailed(err: unknown): void {
    if (err instanceof OAuthError && err.requiresReauth) {
      this.clear();
    }
  }

  isExpired(nowMs: number): boolean {
    return this.session === null || this.session.expiresAt <= nowMs;
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.session);
    }
  }
}