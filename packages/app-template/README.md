# @platform/app-template

**Status: T1.5 in progress (skeleton phase landed — see the build order below).**

The **agent onboarding kit**: the reference scaffold every platform app starts from (R-PKG-09). One agent per repo (ADR-012): scaffold a new repo from here, never fork an existing app.

## What is pre-wired

| Concern | Mechanism |
| --- | --- |
| Error contract | `@platform/server-core` global error handler + platform envelope (`{ error: { code, message, status } }`); app registry extends `PLATFORM_ERROR_CODES` |
| Security | H-04 security headers, `no-store` on APIs, rate limiting with envelope 429, `requireAuth` **fail-closed** (real JWKS verifier = T1.5c) |
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
  scripts/scaffold.mjs ← copy + rename placeholders ({{APP_SLUG}}, {{APP_TITLE}})
```

The payload lives under `template/` so the scaffold procedure is explicit and testable — what ships in a fresh app is exactly this directory, nothing platform-specific hidden alongside it.

## Scaffold a new app

```bash
cd packages/app-template
node scripts/scaffold.mjs --name my-app --title "My App" --target ../../my-app
cd ../../my-app && git init && pnpm install
cp .env.example .env
pnpm db:up && pnpm db:migrate && pnpm db:seed
pnpm dev:server   # terminal 1 (:8080)
pnpm dev:client   # terminal 2 (:5173, /api proxied to :8080)
```

## T1.5 build order (DoD: fresh app scaffolds + CI green in under a day)

- [x] **T1.5a** skeleton: client/server layout, server-core pre-wired, Prisma standard, compose dev env, CI mirror, scaffold script
- [ ] **T1.5b** i18n skeleton completion + auth-client as first real consumer (login/callback/ensureSession/authenticatedFetch) — feeds the `./react` adapter design (ADR-020 Phase 2)
- [ ] **T1.5c** OpenAPI contract-first CI (R-PKG-11), permission-catalog check (ADR-007), pre-commit suite port (whitespace, design tokens, contrast, layering, bundle-secrets), real JWKS verifier (replaces the fail-closed stub in server-core)
- [ ] **T1.5d** AGENTS.md scaffold (T2.1: mission, requirement-ID map, never-build list, escalation rule) + onboarding rehearsal

## Development (inside the platform monorepo)

The template is a normal workspace package while it evolves: `pnpm --filter @platform/app-template typecheck|test|build`. Server unit tests are DB-free by design (lazy Prisma import); DB-backed integration tests arrive with the contract CI job (T1.5c).