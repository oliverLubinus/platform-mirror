/**
 * @file config.ts
 * @description
 *   Client configuration for `@agentic-dna/auth-client` (R-PKG-03).
 *
 *   All endpoints derive from ONE base URL: auth-provider's API origin
 *   (`auth-api.<env>.agentic-dna.cloud`) — the same origin that serves
 *   `/auth/token`, `/auth/authorize`, `/auth/userinfo`, `/auth/logout`,
 *   `/api/csrf-token` (consumer-integration guide §3, code-verified against
 *   the live backend). The hosted login UI is reached via redirects issued
 *   by that API — apps never hardcode its URL (R-PKG-04: one audited
 *   hosted UI).
 *
 *   Hard rules (R-PKG-03): this module carries no secrets — public clients
 *   authenticate with PKCE only (consumer guide §9.1); there is nothing to
 *   keep out of the bundle.
 */

// Storage surface lives in storage.ts (StorageAdapter, defaultStorage,
// MissingBrowserStorageError, memoryStorage for tests). Re-exported here so
// the documented import path stays `./config.js` (see index.ts).
//
// The persisted payload is the OIDC flow's short-lived, non-token state:
// the PKCE `code_verifier`, the login-CSRF `state`, and the app's
// `returnTo` target. These are NOT auth tokens (R-PKG-03 forbids tokens in
// storage; the access token lives in memory only — see tokenStore.ts).
import { defaultStorage, type StorageAdapter } from './storage.js';
import { AuthError } from './errors.js';

export type { StorageAdapter } from './storage.js';

/** How the silent-refresh credential reaches `/auth/token` (ADR-004 §2). */
export type RefreshCredential = 'auto' | 'memory' | 'cookie';

export interface AuthClientConfig {
  /** auth-provider API origin, e.g. `https://auth-api.staging.agentic-dna.cloud`. */
  authApiBaseUrl: string;
  /** Registered OIDC client id. Public client: no secret exists (PKCE only). */
  clientId: string;
  /** Pre-registered callback URL of this app (must match the client registration exactly). */
  redirectUri: string;
  /** Space-joined at request time. Default: `openid profile email`. */
  scopes?: string[];
  /**
   * Silent-refresh credential strategy:
   * - `auto` (default): use the in-memory refresh token when the exchange
   *   returned one (live auth-provider behavior); otherwise attempt the
   *   cookie-backed grant (target behavior — the parent-domain refresh
   *   cookie mechanism is an auth-provider follow-up, see ADR-004 §4).
   * - `cookie`: omit `refresh_token` from the body, rely on the
   *   parent-domain cookie (fails against the current backend — recorded).
   * - `memory`: require the in-memory credential, never send an empty body.
   */
  refreshCredential?: RefreshCredential;
  /** Token-endpoint timeout in ms. Default 10_000. */
  timeoutMs?: number;
  /** Expiry safety skew in seconds (default 30): tokens count as expired this much early. */
  skewSeconds?: number;
  /** Storage for flow state (default: `window.sessionStorage`, fail-fast when absent). */
  storage?: StorageAdapter;
  /** Navigation for `login()` / re-auth redirects (default: `window.location.assign`). */
  navigate?: (url: string) => void;
  /** HTTP fetch for token/userinfo/logout calls (default: global `fetch`). Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (epoch ms). Default `Date.now`. */
  now?: () => number;
}

export interface ResolvedAuthClientConfig {
  authApiBaseUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  refreshCredential: RefreshCredential;
  timeoutMs: number;
  skewSeconds: number;
  storage: StorageAdapter;
  navigate: (url: string) => void;
  fetchImpl: typeof fetch;
  now: () => number;
  /** Derived endpoints (trailing slash trimmed once). */
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  logoutUrl: string;
  csrfTokenUrl: string;
}

export { defaultStorage, MissingBrowserStorageError } from './storage.js';

function defaultNavigate(url: string): void {
  window.location.assign(url);
}

export function resolveAuthClientConfig(config: AuthClientConfig): ResolvedAuthClientConfig {
  if (typeof config.authApiBaseUrl !== 'string' || config.authApiBaseUrl.length === 0) {
    throw new AuthError('CONFIG_INVALID', 'authApiBaseUrl is required (auth-provider API origin).');
  }
  if (typeof config.clientId !== 'string' || config.clientId.length === 0) {
    throw new AuthError('CONFIG_INVALID', 'clientId is required (registered OIDC client id).');
  }
  if (typeof config.redirectUri !== 'string' || config.redirectUri.length === 0) {
    throw new AuthError('CONFIG_INVALID', 'redirectUri is required (pre-registered callback URL).');
  }

  const base = config.authApiBaseUrl.replace(/\/+$/, '');
  return {
    authApiBaseUrl: config.authApiBaseUrl,
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    scopes: config.scopes ?? ['openid', 'profile', 'email'],
    refreshCredential: config.refreshCredential ?? 'auto',
    timeoutMs: config.timeoutMs ?? 10_000,
    skewSeconds: config.skewSeconds ?? 30,
    storage: config.storage ?? defaultStorage(),
    navigate: config.navigate ?? defaultNavigate,
    // Bound AT CONFIG TIME: the SDK invokes fetchImpl method-style
    // (`cfg.fetchImpl(...)`), and in a browser the native fetch requires the
    // global receiver — an unbound global fetch throws "Illegal invocation"
    // in strict-mode ESM (first consumer: PM pilot A2, 2026-11-11, worked
    // around app-side with fetchImpl: fetch.bind(globalThis) until this fix;
    // regression guards: config.test.ts). Binding here covers BOTH the
    // default and injected implementations — the SDK's invocation stays
    // receiver-independent.
    fetchImpl: (config.fetchImpl ?? fetch).bind(globalThis),
    now: config.now ?? Date.now,
    authorizeUrl: `${base}/auth/authorize`,
    tokenUrl: `${base}/auth/token`,
    userinfoUrl: `${base}/auth/userinfo`,
    logoutUrl: `${base}/auth/logout`,
    csrfTokenUrl: `${base}/api/csrf-token`,
  };
}
