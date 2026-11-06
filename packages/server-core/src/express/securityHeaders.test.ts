import { deepStrictEqual, strictEqual } from 'node:assert';
import { describe, it } from 'node:test';
import { securityHeaders, noStore } from './securityHeaders.js';

function mockRes() {
  const headers: Record<string, unknown> = {};
  let nextCalled = false;
  const res = {
    setHeader(name: string, value: string) {
      headers[name] = value;
      return res;
    },
    getHeader(name: string) {
      return headers[name];
    }
  };
  return { headers, next: () => (nextCalled = true), nextCalled: () => nextCalled, res };
}

describe('securityHeaders (H-04 port — verbatim)', () => {
  it('sets the four security headers and chains to next() exactly once', () => {
    const { headers, next, nextCalled, res } = mockRes();
    securityHeaders({} as never, res as never, next as never);
    strictEqual(Object.keys(headers).length, 4);
    strictEqual(nextCalled(), true);
  });

  it('exact header values', () => {
    const { headers, next, nextCalled, res } = mockRes();
    securityHeaders({} as never, res as never, next as never);
    deepStrictEqual(headers, {
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff'
    });
    strictEqual(nextCalled(), true);
  });

  it('noStore sets Cache-Control and Pragma', () => {
    const { headers, next, nextCalled, res } = mockRes();
    noStore({} as never, res as never, next as never);
    deepStrictEqual(headers, { 'Cache-Control': 'no-store', Pragma: 'no-cache' });
    strictEqual(nextCalled(), true);
  });
});
