# @platform/server-core

Platform-wide backend baseline (ADR-010 extraction; R-PKG-10 copy →
generalize → test → version). **Ported from the live auth-provider
implementation** — not re-invented.

## Modules

| Module | Source | Contract |
|---|---|---|
| `errors` (ApiError, envelope, registry) | `auth-provider/backend/src/shared/errors.ts` + `utils/errorCodes.ts` | Integration contract §3 — envelope `{error:{code,message,status,details?}}` incl. `status` (documented divergence: auth-provider omits it; new apps use this shape) |
| `errors/sanitize` | `auth-provider/backend/src/shared/sanitizeLogMeta.ts` (verbatim port) | R-PKG-08: no secrets/tokens/PII in logs — fail-closed redaction |
| `events/eventConsumer` | Derived from ADR-016 §3 + R-CHAT-21/22/23/24 | The only platform-conformant consumer; R-CHAT-21: "no hand-rolled consumers" |
| `config/provider` (secretProvider convention) | `auth-provider/backend/src/config/secretProvider.ts` pattern | ADR-010; R-ENV-03 env-file conventions; Q9: interface is the decision, product deferred |
| `logging/logger` | `auth-provider/backend/src/shared/logger.ts` | T1.3b; interface + zero-dep impl; ONE redaction via `sanitizeLogMeta`; transport wiring stays app-side |
| `errors/handler` + `express/adapter` | `auth-provider/backend/src/shared/globalErrorHandler.ts` | T1.3c; classifier core (zero-dep) + `@platform/server-core/express` subpath (types-only, express optional peer) |

## Port audit (drift verification — 2026-11-06)

Source snapshot: **auth-provider @ `1cc2f64`**. Status per module: `errors/sanitize.ts`
verbatim; `apiError.ts` ported + defect fixes; `errorCodes.ts` generalized to the
open-world registry; `handler.ts`/`adapter.ts` generalized; `logger.ts` restructured;
`eventConsumer.ts` spec-first template (ADR-016); `config/provider.ts` pattern port.

Verified divergences (each documented in the module's header comment):

1. **Envelope**: live `toApiErrorObject()` returns `{code, message, details?}` — no
   `status` (verified against `1cc2f64`). Platform envelope includes `status`
   (integration contract §3); auth-provider keeps its shape.
2. **Redaction drift, fixed at the source**: live `logger.ts` carries its own
   redaction copy (lowercase matching, key set lacking `email`/`apiKey`) alongside
   `sanitizeLogMeta.ts` (which redacts `email`). The platform logger redacts
   through the ported `sanitizeLogMeta` only — one implementation, one key set.
3. **Port fixes**: live `getErrorStatusAndMessage` throws on `{response: undefined}`,
   `{response: null}` and circular structures (reproduced 2026-11-06); the platform
   version null-guards and uses a safe stringify fallback.
4. **Error handler**: branch-2 status comes from the app registry (the live handler
   hardcodes LLM mappings); Zod → `VALIDATION_FAILED`/422 (live: `INVALID_REQUEST`/400);
   stacks go to server-side logs only — the live handler echoed dev stacks to clients.

## Deliberately NOT ported (stay app-side)

- LLM error mapping (`getLlmErrorCode`, `LlmErrorContext`) — auth-provider
  retains it; generalization awaits a second consumer (ADR-010 discipline).
- auth-provider's specific secret inventory — apps declare their own
  (`AppSecretSpec[]`); the engine is here, the inventory is per-app.
- Transport wiring for the logger (winston + daily rotation) and app route
  wiring — land with `@platform/app-template` (T1.5). The Express error
  adapter itself DID land as a types-only subpath (`@platform/server-core/express`)
  with express as an optional peer — no runtime dependency enters this package.

## Usage sketch (new platform backend)

```ts
import { ApiError, defineErrorCodeRegistry, loadAppSecrets, createEventConsumer } from '@platform/server-core';

// 1. App error codes (platform base map + contributions, collision-checked)
export const ERROR_CODES = defineErrorCodeRegistry({
  PM_PROJECT_NOT_FOUND: { code: 'PM_PROJECT_NOT_FOUND', status: 404, description: 'Project not found.' }
});

// 2. Boot: declared secrets or no server
const secrets = loadAppSecrets(
  [{ name: 'WEBHOOK_SECRET', description: 'ADR-016 webhook HMAC key' }],
  process.env.SECRETS_FILE ?? '.credentials',
  process.env.NODE_ENV === 'production' ? 'production' : 'staging'
);

// 3. Throwing
throw new ApiError(ERROR_CODES.PM_PROJECT_NOT_FOUND.code, 'Project not found.', 404);

// 4. ADR-016 event consumption (see eventConsumer.ts JSDoc)
```

## Conventions

- Node ≥ 24 (native TS type-stripping for tests; `tsc` emits `dist/`).
- Zero runtime dependencies; dev-only: `typescript`, `tsx`, `@types/node`.
- Tests: `node:test` (`pnpm --filter @platform/server-core test`).
- Versioning: coordinated release train (ADR-012 §2); apps pin majors.
