/**
 * @file server/src/contract-conformance.test.ts
 * @description
 *   The PLATFORM drift gate (R-PKG-11 extended one level up): the app's
 *   OpenAPI spec must CONFORM to platform truth — never restate it.
 *
 *   The platform contract ships as importable artifacts in
 *   `@platform/server-core` (PLATFORM_ERROR_SCHEMA today; the OIDC security
 *   scheme and ADR-016 event envelope follow the same pattern as they gain
 *   machine-checkable forms). This test asserts:
 *
 *     1. the spec's PlatformError schema is DEEP-EQUAL to the platform
 *        constant — a platform envelope change fails THIS gate in the same
 *        bump (continuous inter-app operability, no two truths),
 *     2. every error code documented in the spec belongs to the platform
 *        registry (base map + this app's contributions).
 */
import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { PLATFORM_ERROR_CODES, PLATFORM_ERROR_SCHEMA } from '@platform/server-core';
import { errorCodes } from './errors/errorCodes.js';

const here = dirname(fileURLToPath(import.meta.url));
const specPath = join(here, '..', 'openapi.yaml');
const doc = parseYaml(readFileSync(specPath, 'utf8')) as {
  components?: { schemas?: Record<string, unknown> };
};

describe('platform contract conformance (R-PKG-11: import, never restate)', () => {
  it('the spec PlatformError schema is deep-equal to the platform constant', () => {
    const appSchema = doc.components?.schemas?.PlatformError;
    strictEqual(appSchema !== undefined, true, 'spec is missing the PlatformError schema');
    deepStrictEqual(appSchema, PLATFORM_ERROR_SCHEMA,
      'PlatformError schema drift — update the spec FROM the platform constant, never by hand');
  });

  it('every error code documented in the spec is registered (platform registry §3)', () => {
    const text = readFileSync(specPath, 'utf8');
    const offenders: string[] = [];
    for (const m of text.matchAll(/example:\s*([A-Z][A-Z0-9_]*)/g)) {
      const code = m[1]!;
      if (!(code in errorCodes)) offenders.push(code);
    }
    strictEqual(offenders.length, 0,
      `spec documents unregistered error codes: ${[...new Set(offenders)].join(', ')}`);
  });

  it('the platform base map is intact inside the app registry (sanity, T3.2)', () => {
    for (const code of Object.values(PLATFORM_ERROR_CODES)) {
      strictEqual(code.code in errorCodes, true, `base code ${code.code} missing`);
    }
  });
});
