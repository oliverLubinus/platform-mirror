---
"@agentic-dna/app-template": patch
---

Fix the M1 half-landing found by the company-platform scaffold fan-out (the
first fresh template consumer): scaffold.mjs now defaults to REGISTRY deps
(caret specs kept; `--link` preserves the legacy sibling mode for template
development), rewrites the `{{APP_SLUG_UPPER}}` placeholder it previously
missed, ships the registry-scoped `.npmrc` (scope mapping only, no token),
and the template CI consumes npm.pkg.github.com via `PACKAGES_READ_TOKEN`
instead of checking out the platform sibling.
