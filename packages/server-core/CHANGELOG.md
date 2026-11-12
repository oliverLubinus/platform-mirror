# @agentic-dna/server-core

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
