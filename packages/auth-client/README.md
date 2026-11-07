# @platform/auth-client

One audited OIDC client for every platform SPA (T1.4, ADR-009 §1). Framework-agnostic — no React/Next/Vite imports; the React adapter (session provider, hooks, `ProtectedRoute`, role-gated rendering, "no access" page) ships as a `./react` subpath with the first real consumer (app-template / PM retrofit, ADR-020 Phase 2 — findings feed back into the adapter design).

## What it does

Standard **Authorization Code + PKCE (S256)** against auth-provider's hosted login UI. The SDK owns the protocol, not the pixels: it never renders login screens and never sees credentials (R-PKG-04 — one audited hosted UI). It is a **public client**: PKCE only, no secrets exist client-side (R-PKG-03).

```ts
import { createAuthClient } from '@platform/auth-client';

export const auth = createAuthClient({
  authApiBaseUrl: 'https://auth-api.staging.agentic-dna.cloud',
  clientId: 'app-planning',
  redirectUri: 'https://app-planning.staging.agentic-dna.cloud/auth/callback',
});
```

## The five entry points

| Call | Behavior |
| --- | --- |
| `login({ returnTo })` | Persists PKCE state + verifier + `returnTo` (sessionStorage) and redirects to `/auth/authorize`. Throws `REAUTH_REDIRECT` after navigation starts. |
| `handleCallback(searchParams?)` | State compare (fail closed, single-use) → code exchange with the verifier → tokens in memory. Returns `{ session, returnTo }`, clears flow state, strips the query from the address bar. |
| `ensureSession()` | Fresh token → silent refresh → redirect re-auth. The redirect is **silent** while the hosted-UI session lives and lands on hosted login when it does not (page reloads always pass through here — memory tokens die with the tab). |
| `authenticatedFetch(input, init)` | Adds `Authorization: Bearer <access token>`. On 401: one silent refresh, one retry (string/URL inputs; a consumed `Request` body is returned as-is). The original 401 always surfaces to the app — global redirect handling is yours. |
| `logout()` | GET `/api/csrf-token` → POST `/auth/logout` with `x-csrf-token`. Destroys the auth-provider session ("log out everywhere"); local state clears even if the endpoint is unreachable. |

Also available: `buildLoginUrl()`, `refresh()`, `getSession()`, `isSessionExpired()`, `fetchUserInfo()`, `clearLocalSession()`, `subscribe()` (session-change notifications — the adapter's re-render trigger).

## Endpoints (code-verified against the live backend, 2026-11-06)

| Endpoint | Method | Auth | Used for |
| --- | --- | --- | --- |
| `/auth/authorize` | redirect | none (PKCE + state in query) | Start the hosted login flow |
| `/auth/token` | POST, `x-www-form-urlencoded` | none (public client) | Code exchange, refresh grant. CSRF-exempt server-side |
| `/auth/userinfo` | GET | `Authorization: Bearer` | Verified profile claims (also used by the backend) |
| `/auth/logout` | POST | session cookie + `x-csrf-token` | Destroy provider session |
| `/api/csrf-token` | GET | session cookie | CSRF token for the logout POST |

All endpoints derive from ONE configured base URL — apps never hardcode hosted-UI URLs.

## Security invariants (R-PKG-01…04)

- **Tokens in memory only.** No localStorage. No sessionStorage for tokens. The package has a structural test (`sourceRules`) that scans the source for forbidden storage access, `console.*`, and dynamic code execution — the invariant cannot regress silently.
- **State is login CSRF protection.** Compared before anything else, cleared on match *and* mismatch — a replayed callback always aborts (`STATE_MISMATCH`).
- **Verifier is single-use.** Wiped the moment it is consumed, exchanged or failed.
- **Fail fast over silent degradation.** Without browser storage (SSR, headless), login throws `STORAGE_UNAVAILABLE` — a lost verifier is a flow failure, not a degraded mode.
- **No logging.** Error messages are curated strings; `error_description` from the server is carried verbatim in `OAuthError.description` (server-curated text, safe to render) but never interpolated into messages.
- **ID tokens are never trusted client-side.** No JWKS validation exists in the browser (the backend signs HS256; its secret must not ship to clients). `session.idToken` exists solely to forward to your backend, which owns validation (ADR-004 second fence).

## Silent-refresh credential strategy

`refreshCredential` selects how the refresh grant reaches `/auth/token`:

- `'auto'` (default) — use the in-memory refresh token returned by the exchange (matches the **live** backend today). After a page reload there is no credential, so `ensureSession()` redirects instead of probing.
- `'cookie'` — omit `refresh_token` from the body; the credential rides a parent-domain httpOnly cookie. This is the **target** backend behavior (ADR-004 §2); against the current backend it fails with `invalid_grant`. Flip this when auth-provider ships the cookie mechanism — no SDK release needed.
- `'memory'` — like `'auto'`, but never sends a body-less grant (strictest against the live backend).

Silent refresh is **single-flight** (concurrent callers share one request) with **claim-once** credential semantics — concurrent 401 recoveries cannot replay the same refresh token, so F-030 replay detection never fires from SDK behavior. Terminal failures (`invalid_grant`, `invalid_client`, `unauthorized_client`, `invalid_scope` — exposed as `OAuthError.requiresReauth`) clear the session; transient ones (`server_error`, timeouts) keep it and re-arm the credential.

## Errors

- `AuthError` — flow-level failures with stable `code` (`STORAGE_UNAVAILABLE`, `STATE_MISMATCH`, `VERIFIER_MISSING`, `MISSING_CODE`, `PKCE_GENERATION_FAILED`, `NETWORK_FAILURE`, `TIMEOUT`, `MALFORMED_TOKEN_RESPONSE`, `REFRESH_UNAVAILABLE`, `LOGOUT_FAILED`, `REAUTH_REDIRECT`, `CONFIG_INVALID`, …). The `cause` preserves the original failure.
- `OAuthError` — the backend answered with an RFC 6749 §5.2 error: `code` is the RFC string verbatim (`invalid_grant`, `access_denied`, …), `description` is the server-curated text, `httpStatus` the response status. Non-JSON bodies (unknown paths answer HTML) keep their raw text as evidence under `code: 'unknown_error'`.

Curated user-facing copy per error class lives app-side — the SDK intentionally ships no UI text.

## Configuration

| Option | Default | Notes |
| --- | --- | --- |
| `authApiBaseUrl` | — | auth-provider API origin |
| `clientId` | — | registered public client id |
| `redirectUri` | — | pre-registered callback URL (must match the registration exactly) |
| `scopes` | `openid profile email` | space-joined at authorize |
| `refreshCredential` | `'auto'` | see above |
| `timeoutMs` | `10000` | token/userinfo/logout timeout |
| `skewSeconds` | `30` | tokens count as expired this much early |
| `storage` | `window.sessionStorage` (fail-fast) | for PKCE/state/`returnTo` only — **not** tokens |
| `navigate` | `window.location.assign` | inject for tests |
| `fetchImpl` | `fetch` | inject for tests |
| `now` | `Date.now` | injectable clock (expiry math) |

## Port audit (source-of-truth mapping)

Reference basis: auth-provider's frontend modules, audited against the same repo state as the server-core T1.3d port audit (`1cc2f64`); the endpoint contract was re-verified against the live staging backend on 2026-11-06.

| Platform module | Auth-provider source (frontend) | What moved / changed |
| --- | --- | --- |
| `pkce.ts` | `frontend/src/utils/pkce.ts` | Crypto core verbatim (RFC 7636 vectors tested). Adaptations: injected `StorageAdapter` with fail-fast semantics (no silent no-ops — a lost verifier/state is a flow failure); `clientId`-namespaced storage keys (multi-client pages cannot cross-wire); public-client only — a PKCE generation failure throws instead of the reference's confidential challenge-less fallback; no upstream-state adoption (the reference's proxy oidc-init flow is host-specific — the SDK always mints its own state nonce). |
| `tokenStore.ts` | `frontend/src/utils/tokenManager.ts` | In-memory token lifecycle, expiry math with skew, rotation on refresh. Platform hardening: claim-once refresh credential + single-flight grant (concurrent recoveries cannot replay a rotated token — F-030), `onRefreshFailed` terminal/transient policy, subscription surface for the React adapter. |
| `tokenEndpoint.ts` | reference token-endpoint client | Grant bodies code-verified live (2026-11-06): form-encoded, no `client_secret`, PKCE required; the `refreshCredential` strategy switch pre-wires the parent-domain-cookie target (ADR-004 §2) so the backend change is a config flip, not a release. |
| `client.ts` | reference FE login/callback flow | Orchestrator restructured over the ported primitives: state compare fail-closed and single-use (replayed callbacks abort), verifier wiped on consumption, callback URL stripped, `authenticatedFetch` 401-retry contract (ADR-004 §4 pattern), logout CSRF double-submit. |
| `storage.ts` | reference sessionStorage usage | Platform abstraction: non-token flow state only; fail-fast `MissingBrowserStorageError` so SSR cannot silently degrade; `memoryStorage` test hook. |
| `errors.ts` | reference error mapping | New typed taxonomy (`AuthErrorCode`) + `OAuthError` carrying the RFC 6749 §5.2 code verbatim, `requiresReauth` terminal/transient classification, raw-body evidence for non-JSON responses. |
| `config.ts`, `sourceRules.test.ts` | — | New (platform): single-base-URL config with injectable `fetch`/`navigate`/`now`/`storage`; structural scans enforcing R-PKG-03 (no `console.*`, no localStorage, no direct sessionStorage outside the adapter, no dynamic code execution). |
## Deviations & known limits (pre-release ledger, per ADR-009 §6)

1. **In-memory refresh credential (interim).** The target is a parent-domain httpOnly refresh cookie so page reloads can silently refresh without a redirect. The backend does not ship the cookie mechanism yet; until then the SDK stores the rotating refresh token in memory (`'auto'`) and reloads go through the (silent-when-alive) redirect. `refreshCredential: 'cookie'` is pre-wired.
2. **ID token unvalidated client-side.** Same fence as above — validation belongs to the backend; no client JWKS.
3. **Userinfo claims are a typed subset** (`sub`, `name`, `email`, `email_verified`, `amr`, `acr`). Unknown claims are ignored; never branch on unlisted `acr` values.
4. **No proactive token refresh.** `authenticatedFetch` refreshes reactively on 401; `ensureSession` on navigation. A timer-based proactive refresh is a later enhancement.
5. **`Request` inputs skip the 401 retry** — their body stream is consumed after the first send.

## Testing

`pnpm --filter @platform/auth-client test` — 80 tests: PKCE RFC vectors (cross-checked against `node:crypto`), flow-state persistence/cleanup, callback hardening (state replay, missing code/verifier, `error=` redirects), refresh strategy bodies + rotation + claim-once concurrency, 401 retry semantics, logout CSRF double-submit, and the source-rule scans.

## Build

`tsc` per workspace config; `dist/` carries ESM + type declarations (`exports` map: `.`; `./react` is reserved for the first app consumer).