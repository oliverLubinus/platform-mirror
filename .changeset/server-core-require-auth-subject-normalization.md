---
'@agentic-dna/server-core': patch
---

fix(express/auth): normalize the verified token subject to id in requireAuth — the
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
