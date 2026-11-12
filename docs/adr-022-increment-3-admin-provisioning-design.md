# ADR-022 Increment 3 — Admin Provisioning Surface (Design Notes)

**Status**: DRAFT for implementation — owner approved the six design decisions
below with the stated recommendations (2026-11-12)
**Prerequisite**: none blocking; may start while PM B6/staging continues
**Authority chain**: ADR-017 §org-admin (delegation boundary) → ADR-022 §2 (app
memberships resolve through the OIDC client registry) → ADR-022 §3 (claims
contract, proven live — see `auth-provider/project-plans/adr-022-increment-2-handoff.md`)

---

## 1. Problem

The full org/membership data model and claims contract are live (increments 1–2),
but there is no authority surface to operate them: `Client.orgRequired`, org
creation, `OrgMembership` and `AppMembership` rows are all managed by direct
superuser SQL today. This blocks:
- Every new fan-out app (needs client registration + role-key namespace + provisioning).
- Org-scoped workflows beyond the seeded PM pilot.
- Auditability (no record of who granted what, when).

## 2. Approved design decisions (the six)

| # | Decision | Rationale |
|---|---|---|
| 1 | **`org:admin` manages `AppMembership`s for members of their own org**; global admins additionally manage cross-org cases and the client registry. No per-client "client-admin" concept in v1. | The org boundary is the trust boundary ADR-017 already established; per-client admin is over-engineering for the pilot phase. |
| 2 | **v1 = direct add of existing users only** (org:admin searches by email, target must have an account). The `invited` status lifecycle stays in the schema for a later email-invitation flow. | Invitation machinery (hashed lookup, CAS single-use, TTL) doubles the surface; mailer has outage history (F-043). Direct-add delivers provisioning value immediately. |
| 3 | **Global admin creates orgs; `org:admin` manages members; archive/30-day-grace delete deferred.** | ADR-017 lifecycle is already in the data model; the surface grows into it later. Scope discipline: fix the fan-out blocker first. |
| 4 | **`Client.orgRequired` becomes a global-admin toggle** on the client detail view + audit event. | This is the one flag with no UI; it's what turned PM onboarding into SQL surgery. |
| 5 | **JIT provisioning (ADR-022 §7) stays explicitly deferred.** | Recorded in the open-items list rather than half-built. |
| 6 | **Backend API-first with audit events on every mutation**; minimal admin-FE wiring (orgRequired toggle + membership list) only. | Full admin-dashboard integration can follow without contract change. |

## 3. API surface (backend-first)

All routes behind the established chain: `requireAdmin → requireAdmin2FA → adminLimiter`.

### Orgs
| Method | Path | Body | Effect |
|---|---|---|---|
| GET | `/admin/orgs` | — | List orgs (paginated) |
| POST | `/admin/orgs` | `name`, `slug` | Create org (global admin only) |
| GET | `/admin/orgs/:id` | — | Org detail incl. members + app-memberships |
| PATCH | `/admin/orgs/:id` | `name?`, `slug?` | Rename (archive/delete deferred per decision 3) |

### Org memberships
| Method | Path | Body | Effect |
|---|---|---|---|
| POST | `/admin/orgs/:id/members` | `email`, `role` | Direct-add existing user as `org:admin` or `org:member` |
| PATCH | `/admin/orgs/:id/members/:membershipId` | `role` | Change org role |
| DELETE | `/admin/orgs/:id/members/:membershipId` | — | Remove member (fails-closed if last `org:admin`, mirrors F-024 pattern) |

### App memberships (per client, org-scoped)
| Method | Path | Body | Effect |
|---|---|---|---|
| POST | `/admin/clients/:clientId/members` | `email`, `organizationId`, `roles[]` | Grant app membership (org:admin grants within own org; global admin anywhere) |
| PATCH | `/admin/clients/:clientId/members/:membershipId` | `roles[]` | Update app roles (next token refresh re-resolves, ≤10 min) |
| DELETE | `/admin/clients/:clientId/members/:membershipId` | — | Revoke (next grant drops the role; zero-permissions ≠ error) |

### Client registry
| Method | Path | Body | Effect |
|---|---|---|---|
| PATCH | `/admin/clients/:clientId` | `orgRequired?` | Flip the org-scoping flag |

## 4. Audit events (the single choke point, ADR-022 §4)

Every mutation writes through `createAuditLogger` (the same choke point PM B5
just adopted server-side):
`org_created`, `org_renamed`, `org_member_added`, `org_member_role_changed`,
`org_member_removed`, `app_membership_granted`, `app_membership_roles_changed`,
`app_membership_revoked`, `client_org_required_changed`.

Details redact emails to the established pattern (the audit-redaction layer
already handles this server-core-side).

## 5. Validation & fail-closed rules

- `slug` unique, `^[a-z0-9][a-z0-9-]{1,62}$` (kebab, no leading/trailing dash).
- `roles[]` entries must match `^<app-ns>:[a-z0-9-]+$` per ADR-007 §3 — the
  app-namespace prefix is derived from the client's registered namespace, not
  free-form (prevents cross-app role-key injection).
- `AppMembership` uniqueness already enforced by schema: unique
  `(userId, clientId, organizationId)` including the NULL-org case.
- Removing the last `org:admin` of an org → 409 `LAST_ADMIN_PROTECTED`
  (mirrors F-024's last-admin guard).
- Direct-add targets must be `isVerified = true` and not `banned` (parity with
  the login prerequisites; prevents provisioning to dead accounts).

## 6. Frontend (minimal)

- Admin client-detail page: `orgRequired` toggle (decision 4) + the app-membership list with grant/revoke.
- Admin org page: member list + add-by-email + role change.
- Everything else (org create UI, cross-org admin views) deferred to the full admin-dashboard work.

## 7. Out of scope (recorded, not forgotten)

- Email invitations (`invited` → `active` lifecycle) — decision 2.
- Org archive / 30-day-grace deletion — decision 3.
- JIT provisioning — decision 5.
- Multi-org user picker (FE `/org-picker` page) — tracked separately in the handoff backlog; increment 3 does not change its priority.

## 8. Test plan

- Service layer: fail-closed branches per §5 (slug/role-key/verified/banned/last-admin).
- Integration: the full authorize → token flow picks up a newly-granted
  `AppMembership` without any server restart (roles resolve fresh per grant, ≤10 min).
- Ratchet: every new endpoint writes exactly one audit event on success and
  none on failure (mirrors the PM B5 manifest pattern).
