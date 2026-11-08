# Implementation Plan — {{APP_TITLE}}

The **living task tracker** for this app. Per the platform planning-layer
convention, per-app implementation plans live IN the app repo and obey the
architecture plan's discipline: **a checkbox is updated in the SAME commit
as the work it tracks, with evidence inline** (T4.3 rule).

- **Read-only inputs** (change via the owner lane only, never locally):
  requirements (`R-<APP>-*`), ADRs, the interface inventory, the integration
  contract, program milestones — all in `architecture/`.
- **This repo owns:** task-level epics, their DoD, and their evidence.
- **Escalation:** cross-repo or contract-affecting work goes through the
  AGENTS.md decision-escalation rule — never implemented locally.

## Epics

- [ ] **E1 — (first epic: replace this line).** DoD: …

<!--
Fill from: the app's requirements registry + ADR phases + the platform
plan's workstream rows this app serves (with milestone ids). Every epic
cites the requirement IDs it implements and the milestone it advances.
-->

## Platform dependencies

- Registry publish status: apps consume `@platform/*` via the release train;
  `link:` is only the pre-publish interim.
- OIDC client registration: INTEGRATION-CHECKLIST.md §1 (PENDING rows stay
  visible — absence is explicit).

## Status snapshot

(date — what exists, what's next)
