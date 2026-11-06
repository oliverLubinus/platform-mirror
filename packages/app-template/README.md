# @platform/app-template

**Status: NOT YET IMPLEMENTED (T1.5 — see implementation plan Phase 0).**

The **agent onboarding kit**: the reference scaffold every platform app
starts from. This package is the single most important parallelization
enabler — its DoD:

- server-core pre-wired (error contract, sanitization, rate limiting, audit)
- i18n skeleton per backlog item 6 decision (centralized strings, no
  hardcoded literals, `Intl` formatting; English-only content)
- Prisma standard codified (backlog item 4)
- local docker-compose dev environment (R-ENV-01)
- OpenAPI contract-first CI job (spec drift fails build — R-PKG-11)
- pre-commit suite ported from auth-provider (whitespace, design tokens,
  contrast, eslint, tsc, layering ratchet)
- `AGENTS.md` scaffold (T2.1: mission, never-build list, escalation rule)

**Definition of done (T1.5): a fresh app scaffolds from the template and
CI is green in under a day.**
