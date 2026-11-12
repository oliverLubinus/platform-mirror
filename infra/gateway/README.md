# infra/gateway/

Gateway-owned security policy per ADR-004 (gateway owns headers) and
ADR-021 (SPA hosting, CSP baseline). **Do not confuse this with the live
host nginx** — the VPS `/etc/nginx` tree is operator-owned and is NOT
configured from this repo directly; applying anything here to the host is
an owner-gated step (see `docs/csp-reporting.md`).

The full nginx vhost migration from auth-provider `deploy/` is T1.6 scope
(infra README). Until it lands, this directory holds the ADR-021 CSP scope
only:

| Path | Content | Status |
|---|---|---|
| `csp/vhost-csp-report-only.inc` | ADR-021 §3 CSP baseline as an include-able snippet, Report-Only (staging posture per ADR-021 §4) | draft for review — first consumer is the PM staging vhost (drafted in the PM repo `deploy/staging/pm.vhost.conf`; not applied anywhere) |
| `csp/check-origin-drift.mjs` | ADR-021 §8 origin drift guard: asserts every vhost `connect-src` is a superset of the app's registered origins (registry manifest, single source of truth per ADR-004 Q6) | runnable; fails the deploy check on drift |

Conventions:

- The vhost include is **policy text, not applied config**. Per-vhost
  variables (`$csp_connect_src`) are set by the consuming vhost before
  including.
- The drift guard runs at staging deploy (operator) and in CI on the
  manifest + template pairs: `node infra/gateway/csp/check-origin-drift.mjs <vhost-file> <origins-manifest.json>`.
- `connect-src` must be a **superset** of the registered origins — extra
  origins are allowed (logged as a warning), missing ones fail.
