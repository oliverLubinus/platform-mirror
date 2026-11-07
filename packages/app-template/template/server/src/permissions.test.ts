/**
 * @file permissions.test.ts
 * @description
 *   The ADR-007 permission-catalog lint/consistency check (the ADR's open
 *   item, resolved here): the catalog is validated for canonical format and
 *   uniqueness, and the route MANIFEST's permission references are checked
 *   against it — a route may never require a permission the catalog does
 *   not declare (fail-closed authorization hygiene).
 */
import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { APP_KEY, permissionCatalog } from './permissions/catalog.js';
import { routeManifest } from './routes.js';

/**
 * ADR-007 canonical format: <app>.<resource>:<action>
 *  - app: registered app key, lowercase + hyphen
 *  - resource: resource family, lowercase (plural by convention)
 *  - action: verb (platform-reserved: read, write, delete, admin; custom verbs allowed)
 */
const PERMISSION_FORMAT = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9]*:[a-z][a-z0-9-]*$/;
const RESERVED_ACTIONS = new Set(['read', 'write', 'delete', 'admin']);

describe('permission catalog (ADR-007 lint/consistency)', () => {
  it('every catalog entry is canonically formatted and namespaced under the app key', () => {
    for (const permission of permissionCatalog) {
      ok(
        PERMISSION_FORMAT.test(permission.id),
        `permission "${permission.id}" violates the ADR-007 format <app>.<resource>:<action>`
      );
      ok(
        permission.id.startsWith(`${APP_KEY}.`),
        `permission "${permission.id}" must be namespaced under the app key "${APP_KEY}"`
      );
      ok(permission.description.length > 0, `permission "${permission.id}" needs a description`);
    }
  });

  it('catalog entries are unique', () => {
    const ids = permissionCatalog.map((p) => p.id);
    strictEqual(new Set(ids).size, ids.length, 'duplicate permission ids in the catalog');
  });

  it('every route permission exists in the catalog (fail-closed direction)', () => {
    const catalogIds = new Set(permissionCatalog.map((p) => p.id));
    for (const route of routeManifest) {
      if (route.permission === undefined) continue;
      ok(
        catalogIds.has(route.permission),
        `route ${route.method.toUpperCase()} ${route.path} requires "${route.permission}", which is NOT in the catalog`
      );
    }
  });

  it('every protected route documents its intended permission (authorization is explicit)', () => {
    for (const route of routeManifest) {
      if (route.auth === 'bearer') {
        ok(route.permission !== undefined, `protected route ${route.path} must declare its ADR-007 permission`);
      }
    }
  });

  it('reserved actions are used with documented meaning (platform verbs stay stable)', () => {
    for (const permission of permissionCatalog) {
      const action = permission.id.split(':')[1] ?? '';
      if (RESERVED_ACTIONS.has(action)) {
        ok(
          permission.description.length > 0,
          `reserved action "${action}" in "${permission.id}" must have a documented description`
        );
      }
    }
  });
});
