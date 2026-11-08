# AGENTS.md — {{APP_TITLE}} implementation harness

This repository is a **platform app** scaffolded from `@platform/app-template` (R-PKG-09).
It is worked by **one agent per repo** (ADR-012): implementation happens here, platform
packages (`@platform/server-core`, `@platform/auth-client`) are consumed, not forked.
Findings, friction, and missing platform capabilities flow back through the platform
feedback loop (ADR-020 Phase 2) — never as local re-implementations.

## Mission

{{APP_TITLE}} (`{{APP_SLUG}}`) is a platform application: it stores its own domain data
in its own PostgreSQL database (Prisma), serves a React SPA + Express API, delegates
identity completely to auth-provider, and enforces its own fine-grained permissions
app-side (ADR-007). The agent's job is to grow THIS app's domain surface on the platform
rails — not to touch identity, platform libraries, or infrastructure conventions.

## Required standards (requirement-ID map)

Before writing or modifying code, read and apply the platform baseline. The canonical
documents live in the platform monorepo (`architecture/`); the IDs below are the ones
this repo's code and CI actively enforce. **Living plan:** `planning/implementation-plan.md`
— the task-level tracker, updated IN THE SAME COMMIT as the work it tracks with evidence
inline (T4.3 rule). Per-app plans live in-repo by platform convention; this repo is
read-only on `architecture/` inputs.

| ID | Concern | What it means for this repo |
| --- | --- | --- |
| R-PKG-09 | Pre-wired scaffold | This app STARTS with the audited baseline (headers, envelopes, rate limiting, auth, audit hook). Never strip platform wiring to make a test pass. |
| R-PKG-11 | Contract-first API | Every HTTP endpoint has an operation in `server/openapi.yaml` AND an entry in `server/src/routes.ts`. The drift gate (`openapi.test.ts`) fails the build on mismatch — add both or neither. |
| R-PKG-04 | Curated auth UX | No login UI in this repo. Identity screens are auth-provider's hosted UI; this app renders only curated boot states (authenticated / redirecting / signedOut / error) — see `client/src/App.tsx`. |
| ADR-004 / ADR-005 | Auth & tokens | All OIDC flows, token storage, refresh, and Bearer injection go through `@platform/auth-client` (`client/src/auth/authClient.ts`). The server verifies tokens with `createTokenVerifier` from `@platform/server-core` — key ring via `JWT_SIGNING_KEYS`, never hand-rolled. |
| ADR-007 | Permissions | Permissions are `<app>.<resource>:<action>` strings declared in `server/src/permissions/catalog.ts` and lint-checked (`permissions.test.ts`). Routes declare their permission in the manifest. Enforcement wiring (membership source) is a platform backlog item — do not invent a local substitute. |
| ADR-009 / design system | Styling | All colors come from the semantic tokens in `client/src/styles/tokens.css`. The guard (`client/scripts/check-design-tokens.cjs`) rejects raw palette classes, inline styles, and raw hex outside that file. Contrast (`check-contrast.cjs`) must stay WCAG AA (≥ 4.5:1 text, ≥ 3:1 UI). |
| G1 layering | Client data flow | UI files never import `src/api/**` directly — use-case hooks in `src/hooks/**` own data access. Enforced by `check-layering.cjs` with a shrink-only baseline. |
| R-PKG-08 | Secrets & logging | No secret ever reaches the client bundle (`check-bundle-secrets.cjs` after every build; only `VITE_*` vars client-side). URLs pass `sanitizeUrlQuery` before any log sink; the audit hook is the single audit choke point. |
| ADR-011 | Audit | Mutations that matter go through the injected audit logger — no parallel audit writes. |
| §3 error registry | Errors | Errors use the platform envelope `{ error: { code, message, status, details? } }` with stable codes from the app registry (`server/src/errors/errorCodes.ts`). No ad-hoc error shapes. |
| Backlog item 4 (DB) | Schema | Prisma migrations are the ONLY path to a schema change (`pnpm db:migrate`); synthetic seed data only (`pnpm db:seed`, R-ENV-01). |

## Requirements evolution & architecture layering

Two layers, no duplication:
- **Central (architecture repo — read-only for this agent):** DECIDED
  requirements of record, ADRs, inter-app contracts. Never restate platform
  truth in app docs or code — IMPORT it (`@platform/*` artifacts) or
  reference it by ID.
- **This repo (agent-owned):** `docs/requirements.md` — the living
  spec-rooted registry: refinements and PROPOSED new requirements, updated
  under the same-commit rule. IDs are app-namespaced (`R-{{APP_SLUG_UPPER}}-*`),
  so minting locally is collision-free.

Change types: **refinement** (detail, acceptance criteria) — do it locally;
**new requirement** — mint locally as `proposed`, the coordinator ratifies
it into the central registry; **contract-meaning change** (de-scope,
supersede) — STOP and escalate (see the decision-escalation rule).
Conformance sync: the gate asserts this repo's spec conforms to the platform
contract artifacts (`server/src/contract-conformance.test.ts`) — platform
truth changes arrive as red gates + Renovate bump PRs, never as hand-synced
copies.

## Hard never-build list

Do not build these, even if asked in-app. Each exists as a platform service; a local
copy is a platform fork by another name:

1. **Hosted-UI login screens** (→ R-PKG-04). No sign-in/sign-up/mfa pages here, ever.
2. **Own token storage or lifecycle** (→ ADR-004/005). No localStorage tokens, no manual
   refresh logic, no cookie sessions for identity — `@platform/auth-client` owns it.
3. **Own crypto, rate limiting, or log-redaction** (→ R-PKG-08). Server-core primitives only.
4. **Own JWT/JWKS verification** (→ ADR-004). `createTokenVerifier` from server-core only.
5. **Raw palette colors / inline styles** (→ ADR-009). Tokens in `tokens.css` only; need a
   new color? Add a token (light + dark), then use it.
6. **Direct DB access from UI components** (→ G1 layering). Components → hooks → api.
7. **New error envelope shapes** (→ §3 registry). Extend the app registry, don't reshape.
8. **Identity data duplication** (→ ADR-001/ADR-002). No local user tables, password
   columns, or role tables; membership comes from auth-provider's API (integration contract).

## Commit-evidence convention

Every commit that changes behavior carries its evidence inline — reviewers and future
agents must be able to audit without re-running anything:

- **Subject**: `<area>: <what> (<context>)` — area is `client`, `server`, `platform`,
  `guardrails`, `deps`, `docs`.
- **Body**: the decision, the divergence-from-plan if any (with the reason, like
  "plan said JWKS; live issuer omits jwks_uri — key ring instead"), and the test
  evidence (e.g. `256 tests green (80 auth-client, 145 server-core, 31 template)`).
- **References**: requirement IDs from the map above in the body, not the subject.
- CI runs `pnpm check:quality-gate` (whitespace, design tokens, contrast, layering,
  lint, typecheck, tests, build, bundle-secret scan). Red CI with no evidence = revert,
  not debug-forward.

## Decision-escalation rule

The agent decides freely inside this app's negative space: domain logic, components,
hooks, routes, catalog entries, copy, migrations (additive), tests.

**STOP and escalate to the platform owner (do not implement locally) when:**

1. The change would touch `@platform/server-core`, `@platform/auth-client`, or the
   platform repo in any way — that is a platform decision (ADR-012 governance).
2. A never-build item seems necessary to solve the task. That is a signal the platform
   is missing a capability — raise it through the ADR-020 feedback channel with the
   use case, and ship the app feature behind a stub or wait.
3. A security-relevant surface changes: new trust boundary, new external input sink,
   auth flow change, permission model change beyond adding catalog entries.
4. A migration would be non-additive (drop/rename/column-type change) or would touch
   rows seeded by `db:seed` semantics.
5. The CI gate is red for reasons the agent cannot attribute to its own change.

Escalation format: state the task, the blocking rule (cite the ID), the options
considered, and the recommendation. One message, no partial workarounds.

## Quality gate expectation

Implementation is not complete until `pnpm check:quality-gate` passes locally and in CI.
Fast inner loop: `pnpm hooks:install` once, then the pre-commit guardrail runs the six
fast stages on every commit.
