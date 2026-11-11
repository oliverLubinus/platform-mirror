---
'@agentic-dna/server-core': minor
---

New public API: createTokenVerifier(config) - the real HS256 access-token
verifier for auth-provider-issued JWTs (key-ring rotation by header kid,
alg pinning, iss/aud/exp/nbf/iat/sub contract, constant-time signature
check, zero dependencies). requireAuth({ verify }) now has a production
implementation to wire; the fail-closed default remains for unconfigured
apps. RS256 + JWKS endpoint is the documented T4.1 upgrade path and will
be added as a fetch mode without changing the TokenVerifier contract.
