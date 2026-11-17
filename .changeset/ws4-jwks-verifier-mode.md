---
'@agentic-dna/server-core': minor
---

`createTokenVerifier` gains the `jwksUri` fetch-cache mode — the WS-4 gate 1 consumer half (R-AUTH-76/77). RS256 verification against the issuer's published JWKS with `max-age`-capped caching (≤300s), a single-flight TTL-bypassing refetch on an unknown `kid` (rotation: publish-before-flip), an explicit per-key-kind alg allowlist (oct keys verify HS256 only, RSA keys verify RS256 only — the alg-confusion family is structurally impossible), `kid`-mandatory for RS256, and fail-closed JWKS fetch handling (HTTP errors, malformed JSON, and zero usable keys all reject; failures are never cached). `keys` becomes optional: jwks-only mode drops the issuer's shared secret entirely; oct+jwks dual mode implements the documented overlap window. The `TokenVerifier` contract itself is unchanged — `requireAuth` and every existing call site keep working without modification.
