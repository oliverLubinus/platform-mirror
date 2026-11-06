import { strictEqual } from 'node:assert';
import { describe, it } from 'node:test';
import {
  sanitizeLogMeta,
  sanitizeRequestValue,
  sanitizeRequestHeaders,
  sanitizeUrlQuery,
  sanitizeErrorDetails,
  REQUEST_REDACTED
} from './sanitize.js';

describe('sanitizeLogMeta', () => {
  it('redacts sensitive keys at any depth, preserves benign keys', () => {
    const out = sanitizeLogMeta({
      userId: 'u1',
      meta: { email: 'a@b.c', note: 'fine', nested: { accessToken: 'tok' } }
    }) as Record<string, unknown>;
    strictEqual(out['userId'], 'u1');
    const meta = out['meta'] as Record<string, unknown>;
    strictEqual(meta['email'], REQUEST_REDACTED);
    strictEqual(meta['note'], 'fine');
    strictEqual((meta['nested'] as Record<string, unknown>)['accessToken'], REQUEST_REDACTED);
  });

  it('handles arrays and primitives; caps recursion depth', () => {
    const arr = sanitizeLogMeta([{ password: 'x' }, 'plain']) as Array<Record<string, unknown>>;
    strictEqual(arr[0]?.['password'], REQUEST_REDACTED);
    strictEqual(arr[1], 'plain');
    strictEqual(sanitizeLogMeta(42), 42);

    let deep: unknown = { token: 't' };
    for (let i = 0; i < 10; i++) {
      deep = { nested: deep };
    }
    // Depth cap: [MAX_DEPTH] appears somewhere deep in the structure
    strictEqual(JSON.stringify(sanitizeLogMeta(deep)).includes('[MAX_DEPTH]'), true);
  });
});

describe('sanitizeRequestValue', () => {
  it('redacts short-lived request secrets (code/state/verifier/passwords)', () => {
    const out = sanitizeRequestValue({
      username: 'alice',
      password: 'p',
      code: 'oauth-code',
      state: 'st'
    }) as Record<string, unknown>;
    strictEqual(out['username'], 'alice');
    strictEqual(out['password'], REQUEST_REDACTED);
    strictEqual(out['code'], REQUEST_REDACTED);
    strictEqual(out['state'], REQUEST_REDACTED);
  });
});

describe('sanitizeRequestHeaders', () => {
  it('redacts cookie/authorization/csrf headers, preserves benign ones', () => {
    const out = sanitizeRequestHeaders({
      cookie: 'sid=secret',
      authorization: 'Bearer x',
      'x-csrf-token': 't',
      'content-type': 'application/json'
    }) as Record<string, unknown>;
    strictEqual(out['cookie'], REQUEST_REDACTED);
    strictEqual(out['authorization'], REQUEST_REDACTED);
    strictEqual(out['x-csrf-token'], REQUEST_REDACTED);
    strictEqual(out['content-type'], 'application/json');
  });
});

describe('sanitizeUrlQuery', () => {
  it('redacts sensitive query params, preserves path and benign params', () => {
    strictEqual(
      sanitizeUrlQuery('/callback?code=abc&state=xyz&keep=1'),
      '/callback?code=%5BREDACTED%5D&state=%5BREDACTED%5D&keep=1'
    );
    strictEqual(sanitizeUrlQuery('/plain'), '/plain');
    strictEqual(sanitizeUrlQuery(null), null);
  });
});

describe('sanitizeErrorDetails (fail-closed for buildErrorDetails)', () => {
  it('sanitizes body/query/headers/url EVEN when passed as extraDetails', () => {
    const out = sanitizeErrorDetails({
      originalError: 'x',
      body: { password: 'p', title: 't' },
      headers: { cookie: 'c' },
      url: '/a?code=z',
      state: 'direct-secret'
    }) as Record<string, unknown>;
    const body = out['body'] as Record<string, unknown>;
    const headers = out['headers'] as Record<string, unknown>;
    strictEqual(body['password'], REQUEST_REDACTED);
    strictEqual(body['title'], 't');
    strictEqual(headers['cookie'], REQUEST_REDACTED);
    strictEqual(String(out['url']).includes('code=%5BREDACTED%5D'), true);
    // extraDetails set is deliberately NARROWER than the request set: benign
    // debug keys (code/state/email) are preserved so callers can debug.
    strictEqual(out['state'], 'direct-secret');
    strictEqual(out['originalError'], 'x');
  });

  it('caps recursion depth at 6', () => {
    let deep: unknown = { secret: 's' };
    for (let i = 0; i < 10; i++) {
      deep = { nested: deep };
    }
    strictEqual(JSON.stringify(sanitizeErrorDetails(deep)).includes('[MAX_DEPTH]'), true);
  });
});
