# Platform Integration Checklist — {{APP_TITLE}}

Executed **at skeleton time** (T3.3, per the platform interface inventory).
Every platform app runs this BEFORE building features, so integration is a
skeleton-time activity, not a launch-eve surprise. One checklist per app;
rows stay visible even when the answer is "none yet" — absence is explicit.

Interface inventory rows covered: #1 (OIDC client, redirects, origins),
#5 (event subscription — optional), #8 (gateway origin registry),
#9 (metrics/log conventions).

## 1. OIDC client registration (row 1 — ADR-004 §2, R-AUTH-15/16)

- [ ] Client registered in auth-provider (`pnpm --dir auth-provider/backend exec ts-node prisma/register-client.ts ...`)
  - client id: `{{APP_SLUG}}`
  - type: `--public` (SPA → Authorization Code + PKCE; confidential only with a backend-held secret)
  - allowed scopes: `openid profile email` (the registration default; extend only with justification)
- [ ] Redirect URI(s) registered — pathname must match the SPA callback route EXACTLY:

| Environment | Redirect URI | Registered |
| --- | --- | --- |
| dev | `http://localhost:{{DEV_PORT}}/auth/callback` | ☐ |
| staging | `https://{{APP_SLUG}}.<staging-domain>/auth/callback` | ☐ (deploy time) |
| prod | `https://{{APP_SLUG}}.<prod-domain>/auth/callback` | ☐ (deploy time) |

- [ ] App env mirrors the registration (`.env`: `AUTH_AUDIENCE`, `VITE_AUTH_CLIENT_ID`, `VITE_AUTH_REDIRECT_URI`) — never a second source of truth
- [ ] `ISSUER_URL` points at the environment's auth-provider issuer

## 2. Allowed origins (rows 1 + 8 — ADR-004 origin model, gateway CORS registry)

- [ ] SPA dev origin `http://localhost:{{DEV_PORT}}` — auth-provider CORS + silent-refresh cookie domain implications checked
- [ ] Gateway origin registry (nginx per-app vhost CORS) lists the same origins — deploy-time row, kept explicit:

| Environment | SPA origin | In gateway origin registry |
| --- | --- | --- |
| dev | `http://localhost:{{DEV_PORT}}` | ☐ |
| staging | `https://{{APP_SLUG}}.<staging-domain>` | ☐ (deploy time) |

- [ ] Legacy/retrofit frontends (if any) have their origins listed or an explicit "not needed" note

## 3. Branding config (row 1 — auth-provider hosted UI)

- [ ] Decision recorded: platform-default branding (default at skeleton time) or app-specific `BrandingConfig` (appName/logo/colors) — revisit at first UI increment. App-specific branding is a data row in auth-provider, NOT app-side theming.

## 4. Event subscription (row 5 — ADR-016; OPTIONAL)

- [ ] Decision recorded: which lifecycle events (if any) this app subscribes to. Default at skeleton: **none** — revisit when a feature needs user/org lifecycle signals. The consumer template (`createEventConsumer` + `verifyEventSignature`, `@platform/server-core`) is the ONLY way to consume events — never a hand-rolled webhook listener.

## 5. Metrics / log conventions (row 9 — R-OBS-01…10, ADR-011)

- [ ] All logs flow through the platform logger (`createLogger`) — structured, sanitized (no query secrets), no `console.*` in app code
- [ ] Trace-ID propagation: requests carry the trace context; downstream calls propagate it (interface, not implementation detail)
- [ ] `/metrics` exposure for the loopback scrape — deploy-time wiring, but the app must not BLOCK it (no auth on the metrics endpoint)
- [ ] Audit-relevant actions (auth-relevant state changes) emit audit-hook events (R-PKG-08 audit spine)

## 6. Execution evidence

Record here: the exact registration command(s) run, the environment(s), and
the date. A row checked without evidence is a lie the next agent inherits.
