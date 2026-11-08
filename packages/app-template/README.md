# @platform/app-template

**Status: T1.5 COMPLETE (skeleton + consumers + verifier/CI/guardrails + AGENTS.md harness + rehearsal — see the build order below).**

The **agent onboarding kit**: the reference scaffold every platform app starts from (R-PKG-09). One agent per repo (ADR-012): scaffold a new repo from here, never fork an existing app.

## What is pre-wired

| Concern | Mechanism |
| --- | --- |
| Error contract | `@platform/server-core` global error handler + platform envelope (`{ error: { code, message, status } }`); app registry extends `PLATFORM_ERROR_CODES` |
| Security | H-04 security headers, `no-store` on APIs, rate limiting with envelope 429, `requireAuth` with the **real HS256 verifier** (server-core `createTokenVerifier`: key-ring rotation, alg pinning, iss/aud/exp contract) |
| Logging hygiene | URLs pass `sanitizeUrlQuery` before any sink; secrets/tokens never logged (R-PKG-08) |
| Audit | `createAuditLogger` wired at the factory; persistence is injected per app (ADR-011) |
| DB standard | **Prisma** (backlog item 4, codified in `server/prisma/schema.prisma` header): migrations are the only path to a schema change; synthetic seed (R-ENV-01) |
| i18n | Strings centralized in `client/src/i18n/strings.ts` — no hardcoded literals (backlog item 6, resolved); `Intl` formatting |
| Dev env | `docker compose up -d db` (R-ENV-01); server/client run on the host via pnpm |

## Layout

```
app-template/
  template/            ← the future app repo payload (copied verbatim)
    client/            ← Vite + React 19 + TS
    server/            ← Express 5 + Prisma + server-core wiring
    docker-compose.yml ← dev Postgres (host port 54329)
    .github/workflows/ ← mirrors the platform CI gates
    AGENTS.md          ← the T2.1 implementation harness (mission, requirement-ID map,
                         never-build list, commit-evidence convention, escalation rule)
  scripts/scaffold.mjs ← copy + rename placeholders ({{APP_SLUG}}, {{APP_TITLE}});
                         links @platform/* deps to the platform checkout (registry pending)
  scripts/rehearse-onboarding.mjs ← scripted T1.5d DoD proof: fresh app scaffolds
                         + CI-equivalent checks green (minutes, not a workday)
```

The payload lives under `template/` so the scaffold procedure is explicit and testable — what ships in a fresh app is exactly this directory, nothing platform-specific hidden alongside it.

## First-consumer findings (ADR-020 Phase 2 feedback)

T1.5b made this template the first real consumer of `@platform/auth-client`.
The findings below are the adapter-design input for the `./react` subpath —
each one is pinned by a test in `template/client/src/auth/authClient.test.ts`.

- **F1 — The adapter owns a boot state machine, and it MUST be single-flight.**
  Boot states: `authenticated | redirecting | signedOut | error`. React
  StrictMode double-invokes effects, so concurrent `bootSession()` calls are
  the NORM, not an edge case — two concurrent redirect dances would race on
  single-use OIDC state. The wiring memoizes the boot promise; the adapter
  must too (pinned: "boot is single-flight" test).
- **F2 — SPA navigation after `handleCallback` is a CORRECTNESS requirement.**
  A full page reload after the callback drops the in-memory tokens and
  re-triggers the boot redirect dance — a loop. The callback page uses
  `history.replaceState` and re-renders; the adapter must map returnTo to
  router navigation, never `location.assign`.
- **F3 — API-level 401s must NEVER trigger redirects.** The SDK does one
  silent refresh + one retry, then SURFACES the 401. If the app (or a
  naive ProtectedRoute) redirects on it, a backend that rejects
  otherwise-valid tokens loops against the silent hosted-UI session. This
  template's fail-closed server (until the T1.5c verifier) is exactly that
  case — the honest surface + no-redirect policy is pinned by the wiring.
- **F4 — `signOut()` resolves-signed-out even when endpoints fail.** The SDK
  rejects with `LOGOUT_FAILED` but guarantees the local clear in its
  `finally` block. The wiring catches and proceeds; the adapter should too.
- **F5 — Config fails fast at instance creation.** Missing `VITE_*` auth
  vars throw `CONFIG_INVALID` before any flow starts — a half-configured
  client is a flow failure, not a degraded mode.

## Dev prerequisites for the auth flow

1. Register a dev client with auth-provider (`VITE_AUTH_CLIENT_ID`,
   redirect URI `http://localhost:5173/auth/callback` — must match the
   registration exactly). An unknown client is rejected at
   `/auth/authorize`.
2. `cp template/.env.example template/.env` and fill the three `VITE_*`
   vars. Cold loads then pass through the hosted-UI redirect dance: silent
   while the staging session lives, hosted login when it does not.
3. The server verifies tokens with the ISSUER key ring (T1.5c): set
   `ISSUER_URL`, `AUTH_AUDIENCE`, and `JWT_SIGNING_KEYS` (the same key-ring
   JSON the issuer deploys with — shared per environment, rotation-aware
   via `kid`). Authenticated users see their notes; tampered/stale tokens
   get the generic 401 envelope with no reason leakage.
## Scaffold a new app

```bash
cd packages/app-template
node scripts/scaffold.mjs --name my-app --title "My App" --target ../../my-app
cd ../../my-app && git init && pnpm install   # AGENTS.md ships with the payload
cp .env.example .env
pnpm db:up && pnpm db:migrate && pnpm db:seed
pnpm dev:server   # terminal 1 (:8080)
pnpm dev:client   # terminal 2 (:5173, /api proxied to :8080)
```

After scaffolding, follow **`docs/APP-ONBOARDING.md`** in the fresh app —
the consolidated runbook (six steps: harness → checklist → seam → plan →
requirements registry, each with its governing artifact and proving gate).

## T1.5 build order (DoD: fresh app scaffolds + CI green in under a day)

- [x] **T1.5a** skeleton: client/server layout, server-core pre-wired, Prisma standard, compose dev env, CI mirror, scaffold script
- [x] **T1.5b** i18n skeleton completion + auth-client as first real consumer (login/callback/ensureSession/authenticatedFetch) — feeds the `./react` adapter design (ADR-020 Phase 2) *(done: the wiring owns a single-flight boot state machine + the loop-safe 401 policy; 15 consumer tests pin the full OIDC dance through the SDK - single-flight boot, returnTo-out-of-URL, PKCE verifier on the exchange, single-use state, access_denied surfacing, refresh+retry with the new Bearer, CSRF double-submit logout, local-clear-guaranteed sign-out; findings F1-F5 recorded in the README as the adapter-design input; no hardcoded literals - every auth/callback string centralized per backlog item 6)*
- [x] **T1.5c** OpenAPI contract-first CI (R-PKG-11), permission-catalog check (ADR-007), pre-commit suite port (whitespace, design tokens, contrast, layering, bundle-secrets), real token verifier (replaces the fail-closed stub) *(done: the REAL verifier is server-core `createTokenVerifier` — reality-check divergence: the live issuer signs HS256 with a shared key ring and deliberately omits `jwks_uri` from discovery, so the verifier consumes the issuer key ring (`JWT_SIGNING_KEYS` + `kid` rotation) instead of a JWKS endpoint; RS256+JWKS stays the T4.1 upgrade path as a drop-in fetch mode on the same `TokenVerifier` contract. 17 verifier tests incl. signature round-trips; routes mount FROM a manifest that binds implementation ↔ `openapi.yaml` ↔ permission catalog, with a bidirectional spec-drift gate (6 tests) and the ADR-007 catalog lint (5 tests) failing the build on any of the three; the pre-commit guardrail suite (5 scripts + eslint flat config + quality-gate composition + hook installer) is ported and generalized to Vite — the hooks layer (src/hooks owns api imports) and the audited token palette (19 pairs × 2 schemes WCAG AA) are seeded so the ratchets start fully closed; `pnpm check:quality-gate` runs all nine stages green)*
- [x] **T1.5d** AGENTS.md scaffold (T2.1: mission, requirement-ID map, never-build list, escalation rule) + onboarding rehearsal *(done: template/AGENTS.md carries the full harness — mission, the requirement-ID map to the enforced platform docs, an 8-item hard never-build list (hosted-UI screens R-PKG-04, token storage ADR-004/005, own crypto/rate-limiting/redaction R-PKG-08, own JWT verification, raw colors ADR-009, direct DB access from UI, new envelope shapes, identity data duplication), the commit-evidence convention (subject/body/refs/CI-or-revert), and the 5-clause decision-escalation rule (platform packages, never-build pressure, security surfaces, non-additive migrations, unattributable red CI). The rehearsal is SCRIPTED (scripts/rehearse-onboarding.mjs), not a one-off: scaffold -> install -> typecheck -> 31 tests -> 4 guardrails -> eslint -> build -> bundle-secret scan. It caught two real template bugs on its first run: (1) platform deps could not resolve in a fresh repo (workspace:^ versions -> now link:-ed to the platform checkout until a registry exists), (2) pnpm 12 strictDepBuilds blocked esbuild/prisma postinstalls (allowBuilds mirrored into the payload pnpm-workspace.yaml). Green end-to-end in 0.4 min)*

## Development (inside the platform monorepo)

The template is a normal workspace package while it evolves: `pnpm --filter @platform/app-template typecheck|test|build`. Server unit tests are DB-free by design (lazy Prisma import + injected store); DB-backed integration tests arrive with the contract CI job. Run the local guardrails: `pnpm check:quality-gate` (whitespace, tokens, contrast, layering, lint, typecheck, tests, build, bundle-secret scan) and `pnpm hooks:install` for the pre-commit fast path.