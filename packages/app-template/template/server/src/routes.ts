/**
 * @file server/src/routes.ts
 * @description
 *   The route MANIFEST — single source of truth binding implementation,
 *   OpenAPI spec (contract-first, R-PKG-11), and the permission catalog
 *   (ADR-007). app.ts mounts FROM this manifest; openapi.test.ts verifies
 *   the spec against it (spec drift fails the build); permissions.test.ts
 *   verifies every referenced permission exists in the catalog.
 *
 *   Adding a route = add it here, implement its handler, add the spec
 *   operation, add the catalog permission. Forgetting any of the three
 *   fails CI — that is the point.
 */
export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface RouteSpec {
  method: HttpMethod;
  path: string;
  /** 'bearer' routes get requireAuth and MUST declare security in the spec. */
  auth: 'public' | 'bearer';
  /** ADR-007 permission (format <app>.<resource>:<action>); must exist in the catalog. */
  permission?: string;
  operationId: string;
}

export const routeManifest: readonly RouteSpec[] = [
  { method: 'get', path: '/api/health', auth: 'public', operationId: 'getHealth' },
  { method: 'get', path: '/api/notes', auth: 'bearer', permission: 'app-template.notes:read', operationId: 'listNotes' },
  { method: 'post', path: '/api/notes', auth: 'bearer', permission: 'app-template.notes:write', operationId: 'createNote' },
] as const;
