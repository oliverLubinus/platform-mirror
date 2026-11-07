/**
 * @file server/src/permissions/catalog.ts
 * @description
 *   The app's PERMISSION CATALOG (ADR-007): the atomic permission units this
 *   app enforces, in the canonical format `<app>.<resource>:<action>`.
 *
 *   ADR-002 clarified the layering: OIDC scopes (openid/profile/email) are
 *   IDENTITY scopes issued by auth-provider; PERMISSIONS are app-defined
 *   and enforced app-side (roles map to permissions inside the app). This
 *   catalog is the app's declaration of that fine-grained surface.
 *
 *   Enforcement today: bearer auth (requireAuth) only — the membership
 *   source that maps roles to permissions is not wired yet (needs the
 *   app→auth-provider membership lookup; see README). The catalog is still
 *   declared NOW so every route documents its intended permission and the
 *   lint check (permissions.test.ts) holds the invariant from day one.
 */
export const APP_KEY = 'app-template' as const;

export interface PermissionSpec {
  /** Canonical ADR-007 format: <app>.<resource>:<action>. */
  id: string;
  description: string;
}

export const permissionCatalog: readonly PermissionSpec[] = [
  { id: 'app-template.notes:read', description: 'List notes.' },
  { id: 'app-template.notes:write', description: 'Create and update notes.' },
  { id: 'app-template.notes:delete', description: 'Delete notes (reserved until delete exists).' },
] as const;
