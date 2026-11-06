# AGENTS.md — platform monorepo

Rules for AI agents (and humans) working in this repository. These are
binding; violating them is a review-rejection, not a style nit.

## Mission

Shared packages (`@platform/*`) and shared infra config for the
agentic-dna platform. Structure and governance per ADR-012
(`../architecture/design-decisions/ADR-012-governance-repos-deployment.md`).

## Hard rules (never do these)

1. **No secrets in code, tests, or CI variables beyond bootstrap** —
   secrets live in the tool-managed credentials file outside VCS
   (secretProvider convention, R-ENV-03). The `.gitignore` blocks
   `.env*`; never bypass it.
2. **No breaking changes to exported APIs without a major version bump**
   and a decision-record reference in the PR description. Apps pin
   majors (N/N-1) — silent breakage is a contract violation.
3. **No new runtime dependencies in server-core** without explicit
   architecture-owner approval — this package must stay
   framework-agnostic and dependency-light (it is the baseline every
   app inherits; every dependency is an attack surface and a version
   conflict multiplied by the number of apps).
4. **Never weaken sanitization or verification logic** (sanitize.ts,
   eventConsumer.ts). Changes there require a decision record and test
   updates proving the security property still holds (guard-test
   culture — see auth-provider's nginx template guard for the pattern).
5. **No app-specific logic in platform packages** (no LLM mappings, no
   auth-provider identity-domain types). Generalize only when a second
   consumer exists (ADR-010 copy→generalize discipline).

## Required workflow

1. Read the relevant ADR/requirement before implementing; cite IDs
   (R-PKG-*, ADR-0xx) in commit messages and PR descriptions — the
   evidence-based-history convention used across all platform repos.
2. Tests are mandatory for every exported function and every security
   property (`node:test`; run `pnpm --filter @platform/server-core test`).
3. Contract-affecting changes (integration contract, ADR-016 envelope,
   error envelope) → update `definitions/interface-inventory.md` in the
   architecture repo in the same pass (backlog item 15 rule).
4. **Decision escalation:** anything cross-cutting (new shared module,
   contract change, dependency introduction) gets a short decision
   record in the architecture repo (`decision-backlog.md` or a new
   ADR) — never a silent local choice.
5. CI must be green (typecheck + test + build) before requesting review;
   the lockfile is committed and CI installs `--frozen-lockfile`.

## Coordination (parallel-agent era)

- One agent per repo; this repo's package lane belongs to the
  platform-owner agent. App agents propose package changes via PR from
  their own fork/branch — they do not commit here directly.
- The implementation plan (`architecture/planning/implementation-plan.md`,
  Phase 0) is the DoD tracker: update checkboxes in the same commit
  that completes a T-item.
