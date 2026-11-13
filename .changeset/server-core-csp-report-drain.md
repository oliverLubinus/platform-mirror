---
'@agentic-dna/server-core': minor
---

feat(express): CSP violation-report drain endpoint (ADR-021 groundwork, landed
from the dev-VPS CSP lane commit 2d87f36 via the owner review channel). New
export `cspReportHandler` (and `CspReportHandlerOptions`) from the
`@agentic-dna/server-core/express` subpath: mounts `POST /csp-report` to drain
gateway CSP violation reports into the platform Logger seam (the ADR-011 pipe —
stdout → Alloy → Loki, no new infra). Accepts both wire formats (legacy
`application/csp-report` envelope and flat Reporting-API JSON), bare statuses
(204/400/405/413/415 — machine traffic, not an ADR-016 app surface), 16KiB
serialized-body cap with a bounded rejection marker (report content never
logged on rejection), per-field 512-char caps before logging, and minimal shape
validation (string `document-uri` is the one mandatory field). Attacker-influenced
fields ride the logger's `sanitizeLogMeta` redaction choke point (ABE-5). Eight
node:test cases pin the contract; the repo's infra guard suite
(`pnpm test:infra`) covers the Report-Only vhost baseline and the ADR-021 §8
origin drift guard that consume this endpoint.
