import { deepStrictEqual, strictEqual, throws, doesNotThrow } from 'node:assert';
import { describe, it } from 'node:test';
import { PLATFORM_ERROR_CODES, defineErrorCodeRegistry, ErrorCodeRegistryError } from './errorCodes.js';

describe('PLATFORM_ERROR_CODES (integration contract §3)', () => {
  it('contains the six platform base codes with correct statuses', () => {
    const expected: Array<[string, number]> = [
      ['UNAUTHENTICATED', 401],
      ['FORBIDDEN', 403],
      ['NOT_FOUND', 404],
      ['VALIDATION_FAILED', 422],
      ['RATE_LIMITED', 429],
      ['INTERNAL', 500]
    ];
    for (const [name, status] of expected) {
      const descriptor = PLATFORM_ERROR_CODES[name as keyof typeof PLATFORM_ERROR_CODES];
      strictEqual(descriptor.code, name);
      strictEqual(descriptor.status, status);
    }
  });
});

describe('defineErrorCodeRegistry', () => {
  it('merges app contributions with the base map and freezes the result', () => {
    const registry = defineErrorCodeRegistry({
      PM_PROJECT_NOT_FOUND: { code: 'PM_PROJECT_NOT_FOUND', status: 404, description: 'Project not found.' }
    });
    strictEqual(registry['PM_PROJECT_NOT_FOUND']?.code, 'PM_PROJECT_NOT_FOUND');
    strictEqual(registry['UNAUTHENTICATED']?.status, 401);
    strictEqual(Object.isFrozen(registry), true);
  });

  it('rejects duplicate codes across base + contributions (R-PKG-07 collision check)', () => {
    throws(
      () =>
        defineErrorCodeRegistry({
          PM_ALIAS: { code: 'UNAUTHENTICATED', status: 401, description: 'alias attempt' }
        }),
      (err: unknown) => err instanceof ErrorCodeRegistryError && /Duplicate error code/.test(String(err))
    );
  });

  it('rejects duplicate codes WITHIN app contributions', () => {
    throws(
      () =>
        defineErrorCodeRegistry({
          A_ONE: { code: 'PM_SAME', status: 400, description: 'a' },
          A_TWO: { code: 'PM_SAME', status: 400, description: 'b' }
        }),
      ErrorCodeRegistryError
    );
  });

  it('enforces UPPER_SNAKE code naming', () => {
    throws(
      () =>
        defineErrorCodeRegistry({
          bad: { code: 'lowercase_code', status: 400, description: 'x' }
        }),
      (err: unknown) => err instanceof ErrorCodeRegistryError && /UPPER_SNAKE/.test(String(err))
    );
  });

  it('enforces valid HTTP error statuses (400–599)', () => {
    throws(
      () =>
        defineErrorCodeRegistry({
          WEIRD: { code: 'WEIRD_STATUS', status: 302, description: 'x' }
        }),
      ErrorCodeRegistryError
    );
    doesNotThrow(() =>
      defineErrorCodeRegistry({ OK_STATUS: { code: 'OK_STATUS', status: 503, description: 'x' } })
    );
  });

  it('preserves the base-map immutability contract', () => {
    deepStrictEqual(Object.keys(PLATFORM_ERROR_CODES).length, 6);
  });
});
