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

## Deliberately NOT ported (stay app-side)

- LLM error mapping (`getLlmErrorCode`, `LlmErrorContext`) — auth-provider
  retains it; generalization awaits a second consumer (ADR-010 discipline).
- auth-provider's specific secret inventory — apps declare their own
  (`AppSecretSpec[]`); the engine is here, the inventory is per-app.
- Express adapters (error-handler middleware, route wiring) — land with
  `@platform/app-template` (T1.5), keeping this package framework-agnostic.

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
