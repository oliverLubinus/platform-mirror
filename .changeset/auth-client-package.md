---
'@agentic-dna/auth-client': minor
---

New `@agentic-dna/auth-client` package (T1.4 / ADR-009 §1): one audited OIDC client for all platform SPAs.

- Authorization Code + PKCE S256 against auth-provider's hosted login UI (`/auth/authorize` → callback → `/auth/token` exchange); the SDK never renders login screens (R-PKG-04) and holds no secrets — public client only (R-PKG-03).
- Tokens (access/refresh/ID) live in memory only — structurally enforced: the package source has no localStorage access, no direct sessionStorage calls outside the non-token flow-state adapter, and no `console.*` (sourceRules test).
- Flow hardening: state compare is fail-closed and single-use (replayed callbacks abort); PKCE verifier is wiped after its single exchange; storage/crypto unavailability fails fast (SSR cannot silently degrade).
- `ensureSession()`: fresh token → silent refresh (`/auth/token`, `grant_type=refresh_token`) → redirect re-auth; the silent-refresh credential strategy is configurable (`auto` = in-memory rotating token against the live backend, `cookie` = body-less grant for the target parent-domain-cookie backend, ADR-004 §2).
- Silent refresh is single-flight with claim-once semantics — concurrent 401 recoveries can never replay a refresh token (F-030 replay detection stays untriggered).
- Terminal refresh failures (`invalid_grant` et al.) clear the session (ADR-005); transient ones keep it and re-arm the credential for retry.
- `authenticatedFetch()`: Bearer injection, one 401 → refresh → retry (string/URL inputs; a consumed `Request` body is returned as-is with the original 401).
- `logout()`: GET `/api/csrf-token` → POST `/auth/logout` with the `x-csrf-token` header (destroys the auth-provider session — "log out everywhere"); local state clears even when the endpoint is unreachable.
- Errors are typed and curated: `AuthError` (flow-level, stable codes) and `OAuthError` (RFC 6749 §5.2 verbatim, `requiresReauth` classification, raw-body evidence for non-JSON responses). The SDK logs nothing.
