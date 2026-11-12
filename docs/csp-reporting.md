# CSP Reporting — ADR-021 groundwork in this repo

Status: groundwork landed; **application to hosts is owner-gated.**
Governing decision: [ADR-021 — SPA hosting & content security]
(../architecture/design-decisions/ADR-021-spa-hosting-content-security.md).

## What lives here

| Piece | Where | Role |
|---|---|---|
| Violation-report drain endpoint | `packages/server-core/src/express/cspReport.ts` (`cspReportHandler`, `@agentic-dna/server-core/express` subpath) | Mounts `POST /csp-report` in each app backend; validates the report (legacy `application/csp-report` envelope and flat Reporting-API JSON), logs one structured `csp-violation` event through the platform `Logger`, answers `204` |
| CSP baseline include (Report-Only) | `infra/gateway/csp/vhost-csp-report-only.inc` | The ADR-021 §3 directive set as an include-able snippet; per-vhost `set $csp_connect_src ...` carries the app's per-environment origin list |
| Origin drift guard | `infra/gateway/csp/check-origin-drift.mjs` | ADR-021 §8: asserts each vhost `connect-src` ⊇ the app's registered origins (auth-provider registry export). Runs at staging deploy; extra origins warn, missing origins fail |

### Wiring the drain (no new infrastructure)

ADR-021 sends `report-uri /csp-report` from the gateway vhost; the PM
staging draft proxies that path to the app backend. The backend mounts:

```ts
import express from 'express';
import { cspReportHandler } from '@agentic-dna/server-core/express';
import { createLogger } from '@agentic-dna/server-core';

const logger = createLogger();
app.post(
  '/csp-report',
  express.json({ type: ['application/json', 'application/csp-report'], limit: '16kb' }),
  cspReportHandler({ logger })
);
```

The structured JSON events the logger already emits are the ADR-011 pipe
(container stdout → Alloy → Loki); a Grafana panel on
`{message="csp-violation"}` makes violations visible ops signals per
ADR-021 §3. Report handling is deliberately bare-status (`204/400/405/413/415`)
— machine-generated traffic, not an ADR-016 app API surface.

### Rollout posture (ADR-021 §4)

Staging runs `Content-Security-Policy-Report-Only` (the include ships that
posture); enforcement flips to `Content-Security-Policy` at the PM cutover
— PM is the enforcement pilot before every later app inherits the baseline.

## Owner-gated / NOT done in this repo

- **Applying any vhost to the live host nginx** (`/etc/nginx` on the VPS)
  is the operator's gated step — nothing in this repo touches host config.
- The **PM staging vhost itself** is drafted in the PM repo
  (`deploy/staging/pm.vhost.conf`, review + WS-6 decision on the sink
  route); this repo provides the baseline include it should consume.
- The full **gateway nginx migration** and `infra/monitoring/` provisioning
  (Loki/Grafana configs, the violations panel) remain T1.6 scope
  (infra README) — the Grafana panel is part of that, not of this pass.
- The drift guard needs the **registry manifest export** from auth-provider
  (ADR-004 Q6 source of truth) to run against real data; the manifest shape
  is documented in the script header.
