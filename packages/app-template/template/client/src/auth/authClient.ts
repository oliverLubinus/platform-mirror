/**
 * @file client/src/auth/authClient.ts
 * @description
 *   The template's auth wiring — the FIRST REAL CONSUMER of
 *   `@agentic-dna/auth-client` (T1.5b). Deliberately thin: it owns only the
 *   app-facing state machine (boot / sign-in / sign-out) around the SDK's
 *   framework-agnostic core. Everything learned here feeds the `./react`
 *   adapter design (ADR-020 Phase 2) — see README "First-consumer findings".
 *
 *   Boot model (ADR-004 s2): every cold load passes `ensureSession()` — the
 *   redirect is SILENT while the hosted-UI session lives and lands on hosted
 *   login when it does not. Apps never render login screens (R-PKG-04);
 *   "signed out" exists only as an explicit post-logout in-SPA state.
 *
 *   Loop safety: boot drives redirects; API-level 401s NEVER do (the SDK
 *   surfaces them after one refresh+retry). A backend that rejects
 *   otherwise-valid tokens would otherwise loop against the silent redirect.
 */
import {
  createAuthClient,
  AuthError,
  OAuthError,
  type AuthClient,
  type AuthClientConfig,
  type AuthSession,
} from '@agentic-dna/auth-client';

export interface AppAuthConfig {
  /** auth-provider API origin (single base URL). */
  authApiBaseUrl: string;
  /** Registered public client id. */
  clientId: string;
  /** Pre-registered callback URL, e.g. https://app.example/auth/callback. */
  redirectUri: string;
  /** The SPA path matching `redirectUri`'s pathname (routing is app-owned). */
  callbackPath: string;
}

/** App-facing session state — the exact surface a `./react` provider owns. */
export type BootState =
  | { state: 'authenticated'; session: AuthSession }
  | { state: 'redirecting' }
  | { state: 'signedOut' }
  | { state: 'error'; code: string; message: string };

export interface AppAuth {
  /**
   * Cold-boot gate. SINGLE-FLIGHT: concurrent callers (React StrictMode
   * double-invoke!) share one boot — a second redirect dance must never
   * start while one is in flight.
   */
  bootSession(): Promise<BootState>;
  /** Top-level redirect to the hosted login flow (R-PKG-04). Never resolves normally. */
  signIn(returnTo?: string): Promise<void>;
  /** "Log out everywhere" + local clear; resolves even when endpoints fail. */
  signOut(): Promise<void>;
  /** Bearer-injecting fetch (one silent refresh + one retry on 401). */
  authedFetch(input: string | URL, init?: RequestInit): Promise<Response>;
  /** Validate the OIDC code exchange on the callback route. */
  completeCallback(searchParams?: URLSearchParams): Promise<{ session: AuthSession; returnTo: string | null }>;
  /** Routing helper: does this pathname belong to the callback route? */
  isCallbackPath(pathname: string): boolean;
}

export function createAppAuth(config: AppAuthConfig, overrides: Partial<AuthClientConfig> = {}): AppAuth {
  const client: AuthClient = createAuthClient({
    authApiBaseUrl: config.authApiBaseUrl,
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    ...overrides,
  });

  let bootPromise: Promise<BootState> | null = null;

  const runBoot = async (): Promise<BootState> => {
    try {
      const session = await client.ensureSession();
      return { state: 'authenticated', session };
    } catch (err) {
      if (err instanceof AuthError && err.code === 'REAUTH_REDIRECT') {
        return { state: 'redirecting' };
      }
      // Curated, honest failure: OAuthError carries the RFC code
      // (e.g. access_denied), AuthError the flow code (e.g. TIMEOUT).
      const code = err instanceof OAuthError ? err.code : err instanceof AuthError ? err.code : 'UNKNOWN';
      const message = err instanceof Error ? err.message : 'Sign-in could not be completed.';
      return { state: 'error', code, message };
    }
  };

  return {
    bootSession() {
      bootPromise ??= runBoot();
      return bootPromise;
    },
    async signIn(returnTo) {
      bootPromise = null; // a fresh sign-in invalidates any previous boot
      try {
        await client.login({ returnTo });
      } catch (err) {
        // login() ALWAYS ends in REAUTH_REDIRECT on the success path;
        // anything else is a real failure (e.g. STORAGE_UNAVAILABLE).
        if (!(err instanceof AuthError && err.code === 'REAUTH_REDIRECT')) throw err;
      }
    },
    async signOut() {
      try {
        await client.logout();
      } catch {
        // The SDK clears local state in its finally block even when the
        // endpoints fail (LOGOUT_FAILED) — locally we ARE signed out; the
        // hosted session, if it survived, is handled by the next boot's
        // redirect dance (silent-while-alive).
      }
      bootPromise = null;
    },
    authedFetch(input, init) {
      return client.authenticatedFetch(input, init);
    },
    completeCallback(searchParams) {
      return client.handleCallback(searchParams);
    },
    isCallbackPath(pathname) {
      return pathname === config.callbackPath;
    },
  };
}

/**
 * Browser default instance (lazy — module import must stay safe in node
 * test runs, which never call this). Fail-fast on missing Vite env vars:
 * a half-configured auth client is a flow failure, not a degraded mode.
 */
let instance: AppAuth | null = null;

export function getAppAuth(): AppAuth {
  if (instance === null) {
    const env = import.meta.env ?? {};
    const missing = (['VITE_AUTH_API_BASE_URL', 'VITE_AUTH_CLIENT_ID', 'VITE_AUTH_REDIRECT_URI'] as const).filter(
      (key) => !env[key]
    );
    if (missing.length > 0) {
      throw new Error(`CONFIG_INVALID: missing Vite env vars for auth: ${missing.join(', ')}`);
    }
    const callbackPath = new URL(env['VITE_AUTH_REDIRECT_URI']).pathname;
    instance = createAppAuth({
      authApiBaseUrl: env['VITE_AUTH_API_BASE_URL'],
      clientId: env['VITE_AUTH_CLIENT_ID'],
      redirectUri: env['VITE_AUTH_REDIRECT_URI'],
      callbackPath,
    });
  }
  return instance;
}
