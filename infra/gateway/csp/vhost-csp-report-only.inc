# ADR-021 §3 CSP baseline — per-app vhost include, REPORT-ONLY posture.
#
# Status: draft template (platform repo); NOT applied to any host nginx.
# First consumer: the PM staging vhost (drafted for review in the PM repo,
# deploy/staging/pm.vhost.conf). At the PM cutover (ADR-021 §4) the same
# policy flips to enforced by renaming the header directive — see FLIP below.
#
# Usage (in the app's server block, BEFORE any location that adds headers —
# nginx add_header inheritance: a location with its own add_header drops the
# entire inherited set, so re-include this snippet there):
#
#     set $csp_connect_src "'self' https://auth.staging.agentic-dna.cloud";
#     include snippets/csp-baseline-report-only.inc;
#
# The consuming vhost sets $csp_connect_src to the app's per-environment
# origin list (its own API origin, auth-provider, chat-node, app-specific
# third parties) — kept in sync with the ADR-004 CORS registry. The origin
# drift guard (check-origin-drift.mjs) asserts the superset property at
# deploy; ADR-021 §8.
#
# VIOLATION SINK: report-uri /csp-report. The gateway proxies that path to
# the app backend, which mounts the platform drain endpoint
# (@agentic-dna/server-core/express `cspReportHandler`) — reports are logged
# through the platform logger into the ADR-011 stack (Loki + Grafana panel).

# --- FLIP (PM cutover): Content-Security-Policy-Report-Only → Content-Security-Policy
add_header Content-Security-Policy-Report-Only "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src $csp_connect_src; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; upgrade-insecure-requests; report-uri /csp-report" always;

# frame-ancestors has a legacy companion (X-Frame-Options: DENY) — emitted
# by the vhost's uniform baseline header set (ADR-021 §5), not here.
# NEVER add script-src 'unsafe-inline' (ADR-021 §3: Vite emits external
# hashed module scripts, no inline bootstrap). style-src 'unsafe-inline' is
# the documented, deliberate weakness — apps may tighten per app, never
# weaken (floor rule).
