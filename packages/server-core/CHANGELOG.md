# @agentic-dna/server-core

## 0.3.0

### Minor Changes

- c983a5f: feat(express): CSP violation-report drain endpoint (ADR-021 groundwork, landed
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

## 0.2.1

### Patch Changes

- 85459b4: fix(express/auth): normalize the verified token subject to id in requireAuth — the
  VerifiedToken contract always documented "token subject — attached as req.user.id",
  but the implementation attached the raw claims, so getUserId (which reads
  req.user.id) returned undefined for EVERY verified request and audit rows carried
  no real subject (found live by the PM pilot's B5 audit spine, 2026-11-12; the fix
  had been applied only to the dev-VPS platform clone and never landed upstream —
  this changeset lands it in the repo). The verified sub is normalized to id at the
  single requireAuth choke point: sub is preserved verbatim, and a token-level id
  claim (untrusted if present) is overridden by the verified sub — id is always
  authoritative-from-sub. Regression guards in express/auth.test.ts pin the
  getUserId-after-requireAuth round-trip, the forged-id-override, and zero claim loss.

## 0.2.0

### Minor Changes

- ab630b3: New public API: createTokenVerifier(config) - the real HS256 access-token
  verifier for auth-provider-issued JWTs (key-ring rotation by header kid,
  alg pinning, iss/aud/exp/nbf/iat/sub contract, constant-time signature
  check, zero dependencies). requireAuth({ verify }) now has a production
  implementation to wire; the fail-closed default remains for unconfigured
  apps. RS256 + JWKS endpoint is the documented T4.1 upgrade path and will
  be added as a fetch mode without changing the TokenVerifier contract.
