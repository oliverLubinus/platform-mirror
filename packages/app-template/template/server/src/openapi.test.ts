/**
 * @file openapi.test.ts
 * @description
 *   The R-PKG-11 spec-drift gate: the OpenAPI spec is validated against the
 *   implementation's route MANIFEST (server/src/routes.ts), which app.ts
 *   mounts from. Both directions are checked:
 *
 *     1. every manifest route exists in the spec with the same method,
 *        operationId, and security mode (bearer ⇄ security declared),
 *     2. every spec path+method is covered by the manifest (no orphan
 *        documented endpoints),
 *     3. protected operations declare at least a 401 response.
 *
 *   Adding a route without the spec — or documenting an endpoint that does
 *   not exist — fails the build. That is the contract-first discipline.
 */
import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { routeManifest } from './routes.js';

const here = dirname(fileURLToPath(import.meta.url));
const specPath = join(here, '..', 'openapi.yaml');

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

interface OpenApiDoc {
  paths: Record<string, Record<string, { operationId?: unknown; security?: unknown; responses?: Record<string, unknown> } | undefined>>;
}

const doc = parseYaml(readFileSync(specPath, 'utf8')) as OpenApiDoc;

describe('openapi contract (R-PKG-11): spec ⇄ implementation drift gate', () => {
  it('the spec parses and is OpenAPI 3.x', () => {
    strictEqual((doc as unknown as { openapi?: string }).openapi?.startsWith('3.'), true);
  });

  it('every manifest route exists in the spec with matching method + operationId', () => {
    for (const route of routeManifest) {
      const pathItem = doc.paths[route.path];
      ok(pathItem !== undefined, `spec is missing the path ${route.path}`);
      const operation = pathItem[route.method];
      ok(operation !== undefined, `spec is missing ${route.method.toUpperCase()} ${route.path}`);
      strictEqual(operation.operationId, route.operationId, `operationId drift on ${route.method} ${route.path}`);
    }
  });

  it('security mode matches: bearer routes declare security, public routes do not', () => {
    for (const route of routeManifest) {
      const operation = doc.paths[route.path]![route.method]!;
      const hasSecurity = Array.isArray(operation.security) && operation.security.length > 0;
      if (route.auth === 'bearer') {
        strictEqual(hasSecurity, true, `${route.operationId} must declare bearerAuth security`);
      } else {
        strictEqual(hasSecurity, false, `${route.operationId} must NOT declare security`);
      }
    }
  });

  it('protected operations document the 401 response (envelope contract)', () => {
    for (const route of routeManifest) {
      if (route.auth !== 'bearer') continue;
      const responses = doc.paths[route.path]![route.method]!.responses ?? {};
      ok(
        responses['401'] !== undefined,
        `${route.operationId} must document a 401 response (platform envelope)`
      );
    }
  });

  it('every documented path+method is covered by the manifest (no orphan spec entries)', () => {
    const manifestKeys = new Set(routeManifest.map((r) => `${r.method} ${r.path}`));
    for (const [path, pathItem] of Object.entries(doc.paths)) {
      for (const method of HTTP_METHODS) {
        if (pathItem[method] !== undefined) {
          ok(
            manifestKeys.has(`${method} ${path}`),
            `spec documents ${method} ${path} but the manifest does not implement it`
          );
        }
      }
    }
  });

  it('the manifest is the complete surface (no undocumented implemented routes)', () => {
    // Sanity on the fixture itself: the two directions above together prove
    // bijection; this pins the expected count so silent route loss is loud.
    deepStrictEqual(routeManifest.length, 3);
  });
});
