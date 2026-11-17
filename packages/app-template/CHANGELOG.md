# @agentic-dna/app-template

## 0.4.0

### Patch Changes

- 0b9bc7f: Fix the M1 half-landing found by the company-platform scaffold fan-out (the
  first fresh template consumer): scaffold.mjs now defaults to REGISTRY deps
  (caret specs kept; `--link` preserves the legacy sibling mode for template
  development), rewrites the `{{APP_SLUG_UPPER}}` placeholder it previously
  missed, ships the registry-scoped `.npmrc` (scope mapping only, no token),
  and the template CI consumes npm.pkg.github.com via `PACKAGES_READ_TOKEN`
  instead of checking out the platform sibling.
- Updated dependencies [27ac9a6]
  - @agentic-dna/server-core@0.4.0
  - @agentic-dna/auth-client@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [c983a5f]
  - @agentic-dna/server-core@0.3.0
  - @agentic-dna/auth-client@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies [85459b4]
  - @agentic-dna/server-core@0.2.1
  - @agentic-dna/auth-client@0.2.1

## 0.2.0

### Patch Changes

- Updated dependencies [6860350]
- Updated dependencies [ab630b3]
  - @agentic-dna/auth-client@0.2.0
  - @agentic-dna/server-core@0.2.0
