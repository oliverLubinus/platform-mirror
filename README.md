# Platform Monorepo

Shared `@platform/*` packages and shared infrastructure config
(ADR-012 §1). Apps live in their own repos and consume packages as
versioned npm packages from **GitHub Packages** (resolved 2026-11-05),
pinning majors (N/N-1 policy).

**Status: T1 seed (Phase 0 of the implementation plan — living DoD tracker
lives there).** server-core v0.1 and auth-client v0 are implemented and
tested; app-template remains a scoped placeholder. Release-train publish/consume
config is in place (T1.2); the first publish awaits the namespace
prerequisite recorded in docs/release-train.md. The T4.3 coordination
protocol (below) is active; the T4.1 hardening and T4.2 legal lanes are
opened (see the plan tracker for their living state).

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

## Coordination protocol (T4.3)

- **Single-owner lane for `@platform/*`.** Every package change lands HERE
  via reviewed PRs — apps never fork, patch, or vendor package code. An
  app-side finding becomes a platform issue/PR in this repo; the fix rides
  the release train, never a local hotfix. Contract-affecting changes cite
  a decision-record reference in the PR description.
- **Apps pin majors (N/N-1).** App manifests pin `@platform/*` with caret
  ranges (`^0.2.0` — within 0.x this pins the exact minor). N-1 keeps
  receiving fixes while N is current; apps upgrade on their own schedule
  through bump PRs, never by default. Local development before the first
  registry publish uses `link:` deps — a temporary measure flipped to
  registry versions at publish (T3.1 precedent in project-management).
- **Milestone tracker as living state.** The tracker lives in
  `architecture/planning/implementation-plan.md` and is updated IN THE SAME
  COMMIT as the work it tracks — every tick carries its evidence inline.
  This README's Status line mirrors the current plan phase.
- **Automated bump PRs (Renovate).** `renovate.json` ships in this repo and
  in the app-template payload. Platform minor/patch updates reach apps as
  automated, reviewable bump PRs (`rangeStrategy: bump`); majors — and 0.x
  minor-as-major — are never auto-merged: they are deliberate, reviewed
  upgrades.

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
