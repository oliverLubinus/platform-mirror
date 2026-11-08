# App Onboarding Runbook — {{APP_TITLE}}

The consolidated process for starting work on this app. It assembles the
rules that otherwise live in five places (platform plan conventions,
AGENTS.md, the scaffold README, the integration checklist, the plan
skeleton) into the sequence a fresh agent executes, with the governing
artifact and the proving gate named for every step.

Operating model: **one agent per repo** (ADR-012). This agent touches ONLY
this repo. The coordinator owns `architecture/` and `platform/`.

## Step 0 — Preconditions (coordinator, before you start)

- [ ] The app-template rehearsal is green (fresh app scaffolds + CI-equivalent checks pass)
- [ ] Registry publish state known: `@platform/*` deps are `link:` until the first publish, then caret-pinned (`^0.2.0`) — the T4.3 protocol
- [ ] Platform contract artifacts exist and are importable (`@platform/server-core`: verifier, error registry, `PLATFORM_ERROR_SCHEMA`, consumer template)

## Step 1 — Scaffold (done if you are reading this)

- [ ] `node scripts/scaffold.mjs --name {{APP_SLUG}} …` + `git init && pnpm install`
- [ ] All gates green on the fresh tree (typecheck, test incl. the drift/conformance/permission/error-code gates, build)
- Governing artifact: template README "Scaffold a new app"; proof: the rehearsal procedure

## Step 2 — Make AGENTS.md concrete

- [ ] Fill mission, the app's requirement-ID map, and the HARD never-build list (auth-provider's hosted UI screens → R-PKG-04; own token storage → ADR-005; local platform-library copies — they exist as packages)
- Governing artifact: `AGENTS.md` (this repo's constitution); it stays authoritative for the app's lifetime

## Step 3 — Instantiate the integration checklist

- [ ] Fill `INTEGRATION-CHECKLIST.md` with THIS app's values: OIDC client id + redirect URIs + allowed origins (dev + future staging rows), branding decision, event-subscription decision, metrics/log conventions
- [ ] Execute everything offline-executable; rows needing the auth-provider DB stay marked **PENDING (DB)** with the exact prepared command — absence is explicit, never silent
- Governing artifact: interface inventory rows 1/5/8/9; the registration tool: `auth-provider/backend/prisma/register-client.ts`

## Step 4 — Contract-first: commit the seam

- [ ] The OpenAPI spec (`server/openapi.yaml`) lands FIRST — before implementation — then grows WITH `server/src/routes.ts` (manifest), `permissions/catalog.ts`, and `errors/errorCodes.ts` in the same commits
- [ ] The drift gates (`openapi.test.ts`), the conformance gate (`contract-conformance.test.ts` — the spec must deep-equal platform truth, never restate it), the permission lint, and the error-code lint make contract mismatch unmergeable from commit one
- Governing artifact: R-PKG-11 (contract-first), integration contract §3 (error envelope)

## Step 5 — Instantiate the implementation plan

- [ ] Fill `planning/implementation-plan.md`: epics → requirement IDs → program milestones → DoD per epic, plus a platform-dependencies section
- [ ] Living-state rule from now on: a checkbox is updated IN THE SAME COMMIT as the work it tracks, evidence inline (commit hash, gate result)
- Governing artifact: the architecture plan's planning-layer convention; T4.3

## Step 6 — Create the requirements registry

- [ ] Create `docs/requirements.md` — the LIVING, spec-rooted layer this agent owns: refinements + `proposed` new entries, one ID per requirement, minted `R-{{APP_SLUG_UPPER}}-<n>` (app-namespaced)
- [ ] The DECIDED requirements of record live centrally (`architecture/requirements/{{APP_SLUG}}/`) and are READ-ONLY; never restate their content — reference by ID
- Change tiers: refinement → locally, immediately; new requirement → mint `proposed` here, the coordinator ratifies centrally; contract-meaning change (de-scope, supersede) → STOP and escalate (AGENTS.md rule)
- Governing artifact: architecture plan "Architecture layering + requirements evolution"

## Interacting with platform docs — the four pathways

| Pathway | Direction | Mechanism |
| --- | --- | --- |
| READ | architecture/ → this agent | requirements of record, ADRs, interface inventory, integration contract — read-only, always |
| CONSUME | packages → this app's code | `@platform/*` artifacts (`createTokenVerifier`, `PLATFORM_ERROR_SCHEMA`, registry, consumer template) — import, never restate |
| WRITE-BACK | this agent → coordinator | platform findings → platform-repo issue/PR (single-owner lane); requirement proposals → `proposed` in-repo → ratification; contract-meaning changes → escalation |
| PULL | platform releases → this repo | Renovate bump PRs; majors (and 0.x minor-as-major) always reviewed (N/N-1) |

## End state — when is onboarding DONE

All steps checked, every gate green, and the scaffold rehearsal equivalent
passes for THIS app. From then on the RECURRING process is the task workflow in AGENTS.md
(the eight-step loop with blocker check, escalation checkpoint, and done state).
Plan ticks ride
their commits, requirements evolve through the two-layer model, and platform
truth arrives only via packages and bump PRs.
