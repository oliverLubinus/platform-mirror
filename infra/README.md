# infra/

Shared infrastructure configuration per ADR-012 §1. Owned by the
platform/ops owner (ADR-012 §5).

| Directory | Content | Status |
|---|---|---|
| `gateway/` | nginx config per environment (ADR-004 + ADR-021 header floor) | T1.6 scope — migration from auth-provider `deploy/` (guard-tested templates move here; the nginx template guard test travels with them) |
| `monitoring/` | Prometheus/Loki/Grafana provisioned configs + dashboards (ADR-011) | T1.6 scope — backlog item 12 (trigger fired; **own careful step with the monitoring runbook**, not bundled into skeleton work — the stack is live + drilled) |
