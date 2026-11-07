# Platform Monorepo

Shared `@platform/*` packages and shared infrastructure config
(ADR-012 §1). Apps live in their own repos and consume packages as
versioned npm packages from **GitHub Packages** (resolved 2026-11-05),
pinning majors (N/N-1 policy).

**Status: T1 seed (Phase 0 of the implementation plan — living DoD tracker
lives there).** server-core v0.1 and auth-client v0 are implemented and
tested; app-template remains a scoped placeholder. Release-train publish/consume
config is in place (T1.2); the first publish awaits the namespace
prerequisite recorded in docs/release-train.md.

## Structure (ADR-012 §1)

```
packages/
  server-core/     error contract, sanitization, event-consumer template,
                   secretProvider engine (v0.1 — ported from live auth-provider)
  auth-client/     frontend auth SDK (T1.4 — implemented: OIDC Auth Code + PKCE core, port audit in its README)
  app-template/    reference scaffold (T1.5 — in progress - T1.5a skeleton landed)
infra/
  gateway/         nginx config per environment (T1.6 migration target)
  monitoring/      Prometheus/Loki/Grafana config (T1.6 migration target)
```

Future: `ui`, `chat-embed`, `api-client`, `integration` (extraction order
follows the first consumer needing each — ADR-010 §4 discipline).

## Governance (ADR-012 §2/§5)

- **Owner lane:** package changes land via reviewed PRs; the platform
  architecture owner reviews contract-affecting changes. Apps never
  fork package code locally — needs go through this repo.
- **Release train:** coordinated `@platform/*` releases (Changesets);
  every release gets a changelog; breaking changes require a major bump
  and a decision-record reference. Runbook: docs/release-train.md.
- **Dependency direction:** apps depend on `@platform/*` and platform
  services' APIs — never the reverse (enforced via layering checks as
  they materialize).

## Commands

```
pnpm install          # workspace install (frozen lockfile in CI)
pnpm typecheck        # tsc --noEmit per package
pnpm test             # node:test per package
pnpm build            # tsc emit per package
pnpm changeset        # add a changeset (required for any package version change)
pnpm release          # changeset publish (CI does this; local use = manual)
```

Requires Node ≥ 24 (native TS type-stripping runs the tests; builds emit
clean `dist/` with declarations).
