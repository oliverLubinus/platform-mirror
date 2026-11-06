# @platform/auth-client

**Status: NOT YET IMPLEMENTED (T1.4 — see implementation plan Phase 0).**

The frontend auth SDK (ADR-009 / ADR-004 §2). Every platform SPA gets the
same audited implementation; PM retrofit and all future apps use this
package — never a bespoke auth integration.

## Planned contract (v0)

- OIDC **Authorization Code + PKCE (S256 only)** public-client flow.
- Access token **in memory only** (never localStorage/sessionStorage).
- Silent refresh via **direct credentialed fetch** (`credentials: 'include'`)
  to auth-provider's `/auth/token` (`grant_type=refresh_token`) — the
  parent-domain refresh cookie rides along; no iframes, no
  third-party-cookie dependence (ADR-004 §2, deployed-pattern-verified).
- Expiry-aware token getter + authenticated fetch wrapper (`ApiError`
  envelope aware via the integration contract §3 shape).
- 401 handling contract: single silent-refresh attempt → hosted-login
  redirect.

## Before implementation

The API surface must be **code-verified against auth-provider's actual
behavior** (the ADR-004 §4 pattern) — the live repo is the reference, not
the docs. Framework-agnostic core + thin React adapter per ADR-009.

Placeholders in `src/` exist only so the workspace resolves; replace them.
