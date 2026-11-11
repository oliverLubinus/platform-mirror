/**
 * @file client.ts
 * @description
 *   `@agentic-dna/auth-client` core — one audited OIDC implementation for every
 *   platform SPA (ADR-009 §1). Framework-agnostic: no React, no Next, no Vite
 *   imports (R-PKG-02); the React adapter (session provider/hooks,
 *   ProtectedRoute, role-gated rendering, "no access" page) is a subpath on
 *   top of this core and lands with the first real consumer (ADR-020 Phase 2 — the PM retrofit feeds findings back into the adapter design).
 *
 *   Flow (ADR-004 §2, code-verified against the live backend — see README):
 *   1. `login()`      → top-level redirect to `/auth/authorize` (PKCE S256 +
 *                       state). The hosted UI owns all login screens (R-PKG-04).
 *   2. `handleCallback()` → state compare (fail closed, single-use), exchange
 *                       the code (public client, no secret), tokens in memory.
 *   3. `ensureSession()` → fresh token | silent refresh | redirect re-auth
 *                       (page reloads lose memory tokens; the redirect is
 *                       silent while the hosted-UI session lives, and lands
 *                       on hosted login when it does not — ADR-004 §2).
 *   4. `authenticatedFetch()` → Bearer injection; 401 → one refresh → one
 *                       retry → the 401 surfaces app-side (global redirect
 *                       handling is the adapter's job).
 *   5. `logout()`     → destroys the auth-provider session ("log out
 *                       everywhere") + clears local state.
 *
 *   Hard rules (R-PKG-03): tokens live in memory only; nothing but the OIDC
 *   protocol parameters ever touches a URL; the SDK logs nothing.
 */

import {
  resolveAuthClientConfig,
  type AuthClientConfig,
  type ResolvedAuthClientConfig,
} from './config.js';
import { AuthError, OAuthError } from './errors.js';
import {
  buildAuthorizeUrl,
  clearOidcState,
  clearPkceVerifier,
  clearReturnTo,
  getOidcState,
  getPkceVerifier,
  getReturnTo,
  pkceKeysFor,
  type PkceKeys,
} from './pkce.js';
import {
  exchangeAuthorizationCode,
  fetchUserInfoResponse,
  refreshTokens,
} from './tokenEndpoint.js';
import { TokenStore, type AuthSession } from './tokenStore.js';

export type { AuthSession } from './tokenStore.js';

export interface LoginOptions {
  /** Where to send the user after the callback (app state, stored — never in the URL). */
  returnTo?: string;
}

export interface CallbackResult {
  session: AuthSession;
  /** App navigation target supplied to `login({ returnTo })`, restored here. */
  returnTo: string | null;
}

/** GET /auth/userinfo claims (consumer-integration guide §5, code-verified). */
export interface UserInfoClaims {
  sub: string;
  name?: string;
  email?: string;
  email_verified?: boolean;
  /** RFC 8176 method list — second-factor completion = contains `otp`. */
  amr?: string[];
  /** Opaque context class URI — never branch on unlisted values. */
  acr?: string;
}

function isUserInfoClaims(value: unknown): value is UserInfoClaims {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r['sub'] === 'string' && r['sub'].length > 0;
}

export interface AuthClient {
  /** Build (and persist state for) the authorize URL without navigating. */
  buildLoginUrl(options?: LoginOptions): Promise<string>;
  /** Persist state and redirect to the hosted login flow (throws REAUTH_REDIRECT). */
  login(options?: LoginOptions): Promise<never>;
  /** Validate state, exchange the code, store tokens, clean the URL. */
  handleCallback(searchParams?: URLSearchParams): Promise<CallbackResult>;
  /** Fresh token | silent refresh | redirect re-auth (redirects throw REAUTH_REDIRECT). */
  ensureSession(): Promise<AuthSession>;
  /** One silent-refresh attempt; rotates the credential. Concurrent callers share one flight. */
  refresh(): Promise<AuthSession>;
  /**
   * Fetch with the access token. On 401: one refresh attempt, then one retry
   * (string/URL inputs only — a consumed Request body cannot be re-sent).
   * Terminal refresh failures clear the local session; the ORIGINAL 401
   * response is returned either way.
   */
  authenticatedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  /** Current session snapshot, or null. Non-throwing. */
  getSession(): AuthSession | null;
  /** Whether the current token is expired (within the safety skew). */
  isSessionExpired(): boolean;
  /** GET /auth/userinfo with the current Bearer token. */
  fetchUserInfo(): Promise<UserInfoClaims>;
  /** Destroy the auth-provider session (log out everywhere) + clear local state. */
  logout(): Promise<void>;
  /** Clear local state only (the hosted-UI session keeps living). */
  clearLocalSession(): void;
  /** Subscribe to session changes (store/clear) — React adapter building block. */
  subscribe(listener: (session: AuthSession | null) => void): () => void;
}

export function createAuthClient(config: AuthClientConfig): AuthClient {
  const cfg: ResolvedAuthClientConfig = resolveAuthClientConfig(config);
  const keys: PkceKeys = pkceKeysFor(cfg.clientId);
  const store = new TokenStore(cfg.now, { skewSeconds: cfg.skewSeconds });
  let refreshInFlight: Promise<AuthSession> | null = null;

  function loginParams(options?: LoginOptions) {
    return {
      clientId: cfg.clientId,
      redirectUri: cfg.redirectUri,
      scopes: cfg.scopes,
      ...(options?.returnTo !== undefined ? { returnTo: options.returnTo } : {}),
    };
  }

  async function doLoginAndThrow(options?: LoginOptions): Promise<never> {
    // Real failures (storage, crypto) propagate as themselves — they must
    // not be masked by the navigation signal below.
    const url = await buildAuthorizeUrl(cfg.authorizeUrl, cfg.storage, keys, loginParams(options));
    cfg.navigate(url);
    // The redirect is in flight — callers must stop rendering (the adapter
    // turns this into a "loading" state). Test hosts inject `navigate`.
    throw new AuthError('REAUTH_REDIRECT', 'Redirect to the hosted login flow was initiated.');
  }

  /**
   * Credential for the refresh grant per strategy:
   * - `cookie` → null (body omits the token; the parent-domain cookie rides).
   * - `memory`/`auto` with a stored credential → that credential.
   * - `memory`/`auto` without → REFRESH_UNAVAILABLE (page reloads land here;
   *   the re-auth redirect is the documented path, not a body-less probe).
   */
  function refreshCredentialOrNull(): string | null {
    if (cfg.refreshCredential === 'cookie') return null;
    const claimed = store.claimRefreshToken();
    if (claimed === null) {
      throw new AuthError(
        'REFRESH_UNAVAILABLE',
        'No silent-refresh credential in memory; re-authenticate via redirect.'
      );
    }
    return claimed;
  }

  /** Single-flight silent refresh: concurrent callers share one grant. */
  function refreshSession(): Promise<AuthSession> {
    if (refreshInFlight !== null) return refreshInFlight;
    const claimed = refreshCredentialOrNull();
    refreshInFlight = refreshTokens(cfg, claimed)
      .then((raw) => store.storeTokens(raw))
      .catch((err: unknown) => {
        // Claim/restore dance: a TRANSIENT failure means the server-side
        // rotation never happened — re-arm the credential. A terminal one
        // (requiresReauth) cleared the session via onRefreshFailed; the
        // credential must NOT be resurrected.
        const terminal = err instanceof OAuthError && err.requiresReauth;
        if (claimed !== null && !terminal) {
          store.restoreRefreshToken(claimed);
        }
        store.onRefreshFailed(err);
        throw err;
      })
      .finally(() => {
        refreshInFlight = null;
      });
    return refreshInFlight;
  }

  function clearUrlQuery(): void {
    // Strips code/state (and error params) from the address bar. Guarded for
    // hosts that patch history out or run the callback headlessly.
    if (typeof window !== 'undefined' && typeof window.history?.replaceState === 'function') {
      window.history.replaceState(null, '', window.location.pathname + window.location.hash);
    }
  }

  function clearFlowState(): void {
    clearPkceVerifier(cfg.storage, keys);
    clearReturnTo(cfg.storage, keys);
  }

  return {
    async buildLoginUrl(options?: LoginOptions): Promise<string> {
      return buildAuthorizeUrl(cfg.authorizeUrl, cfg.storage, keys, loginParams(options));
    },

    login(options?: LoginOptions): Promise<never> {
      return doLoginAndThrow(options);
    },

    async handleCallback(searchParams?: URLSearchParams): Promise<CallbackResult> {
      const params =
        searchParams ??
        (typeof window === 'undefined'
          ? new URLSearchParams()
          : new URLSearchParams(window.location.search));

      // State compare BEFORE anything else; the stored value is single-use
      // (cleared on match AND mismatch — never reusable for a second exchange).
      const storedState = getOidcState(cfg.storage, keys);
      const callbackState = params.get('state');
      clearOidcState(cfg.storage, keys);
      if (storedState === null || callbackState === null || callbackState !== storedState) {
        clearFlowState();
        clearUrlQuery();
        throw new AuthError(
          'STATE_MISMATCH',
          'The callback state did not match the stored login state.'
        );
      }

      // RFC 6749 §4.1.2.1: the backend redirects with error params when the
      // user denies consent or the request was rejected there.
      const oauthError = params.get('error');
      if (oauthError !== null) {
        clearFlowState();
        clearUrlQuery();
        throw new OAuthError(oauthError, params.get('error_description'), 0, null);
      }

      const code = params.get('code');
      if (code === null || code.length === 0) {
        clearFlowState();
        clearUrlQuery();
        throw new AuthError('MISSING_CODE', 'The callback carried no authorization code.');
      }

      const verifier = getPkceVerifier(cfg.storage, keys);
      clearPkceVerifier(cfg.storage, keys); // single-use — exchanged or failed
      if (verifier === null) {
        clearUrlQuery();
        throw new AuthError('VERIFIER_MISSING', 'The PKCE code_verifier was not found.');
      }

      const raw = await exchangeAuthorizationCode(cfg, code, verifier);
      const session = store.storeTokens(raw);

      const returnTo = getReturnTo(cfg.storage, keys);
      clearReturnTo(cfg.storage, keys);
      clearUrlQuery();
      return { session, returnTo };
    },

    async ensureSession(): Promise<AuthSession> {
      const session = store.getSession();
      if (session !== null && !store.isExpired(cfg.now())) {
        return session;
      }
      try {
        return await refreshSession();
      } catch (err) {
        // Terminal failures already cleared the store (refreshSession policy).
        store.onRefreshFailed(err);
        // No credential (or refresh failed) → redirect re-auth: silent while
        // the hosted-UI session lives, hosted login otherwise (ADR-004 §2).
        await doLoginAndThrow();
        throw new AuthError('REAUTH_REDIRECT', 'unreachable'); // doLoginAndThrow always throws
      }
    },

    refresh(): Promise<AuthSession> {
      return refreshSession();
    },

    async authenticatedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const current = store.getAccessToken();
      const headers = new Headers(init?.headers);
      if (current !== null) {
        headers.set('Authorization', `Bearer ${current}`);
      }
      const response = await cfg.fetchImpl(input, {
        ...init,
        headers,
        credentials: init?.credentials ?? 'include',
      });
      if (response.status !== 401 || current === null) {
        return response;
      }

      // One silent-refresh attempt, then one retry (string/URL inputs only —
      // a consumed Request body cannot be re-sent).
      if (typeof input !== 'string' && !(input instanceof URL)) {
        return response;
      }
      try {
        const refreshed = await refreshSession();
        const retryHeaders = new Headers(init?.headers);
        retryHeaders.set('Authorization', `Bearer ${refreshed.accessToken}`);
        return await cfg.fetchImpl(input, {
          ...init,
          headers: retryHeaders,
          credentials: init?.credentials ?? 'include',
        });
      } catch {
        // Refresh failure policy already applied inside refreshSession
        // (terminal → session cleared). The ORIGINAL 401 surfaces — global
        // redirect handling is the app's call.
        return response;
      }
    },

    getSession(): AuthSession | null {
      return store.getSession();
    },

    isSessionExpired(): boolean {
      return store.isExpired(cfg.now());
    },

    async fetchUserInfo(): Promise<UserInfoClaims> {
      const current = store.getAccessToken();
      if (current === null) {
        throw new AuthError('REFRESH_UNAVAILABLE', 'No active session in memory.');
      }
      const response = await fetchUserInfoResponse(cfg, current);
      if (!response.ok) {
        const text = await response.text().catch(() => null);
        throw OAuthError.fromResponse(response.status, text);
      }
      const parsed: unknown = await response.json();
      if (!isUserInfoClaims(parsed)) {
        throw new AuthError(
          'MALFORMED_TOKEN_RESPONSE',
          'The userinfo response did not match the expected shape.'
        );
      }
      return parsed;
    },

    async logout(): Promise<void> {
      try {
        const csrfResponse = await cfg.fetchImpl(cfg.csrfTokenUrl, {
          credentials: 'include',
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
        if (!csrfResponse.ok) {
          throw new AuthError('LOGOUT_FAILED', 'Could not obtain the CSRF token for logout.');
        }
        const csrfBody: unknown = await csrfResponse.json();
        const csrfToken =
          typeof csrfBody === 'object' && csrfBody !== null
            ? (csrfBody as Record<string, unknown>)['csrfToken']
            : undefined;
        if (typeof csrfToken !== 'string' || csrfToken.length === 0) {
          throw new AuthError('LOGOUT_FAILED', 'The CSRF token response was malformed.');
        }
        await cfg.fetchImpl(cfg.logoutUrl, {
          method: 'POST',
          credentials: 'include',
          headers: new Headers({ 'x-csrf-token': csrfToken }),
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
      } catch (err) {
        if (err instanceof AuthError && err.code === 'LOGOUT_FAILED') throw err;
        throw new AuthError('LOGOUT_FAILED', 'The logout endpoint could not be reached.', {
          cause: err,
        });
      } finally {
        store.clear();
      }
    },

    clearLocalSession(): void {
      store.clear();
    },

    subscribe(listener: (session: AuthSession | null) => void): () => void {
      return store.subscribe(listener);
    },
  };
}