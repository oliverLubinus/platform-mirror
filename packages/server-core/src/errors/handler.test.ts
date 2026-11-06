import { deepStrictEqual, strictEqual } from 'node:assert';
import { describe, it } from 'node:test';
import { ApiError } from './apiError.js';
import { classifyError, sanitizeDetailsForClient } from './handler.js';
import { defineErrorCodeRegistry } from './errorCodes.js';

describe('sanitizeDetailsForClient (client-strip list — security property)', () => {
  it('strips request material, tokens, and internal error text; keeps curated fields', () => {
    const out = sanitizeDetailsForClient({
      issues: [{ path: 'name', message: 'required' }],
      body: { password: 'x' },
      headers: { cookie: 'sid' },
      redactedBody: { password: '[REDACTED]' },
      ip: '127.0.0.1',
      url: '/a?code=z',
      refreshToken: 'KEEP_ME' // note: key NOT in the strip set (exact-match like auth-provider)
    }) as Record<string, unknown>;
    strictEqual('body' in out, false);
    strictEqual('headers' in out, false);
    strictEqual('redactedBody' in out, false);
    strictEqual('ip' in out, false);
    strictEqual('url' in out, false);
    deepStrictEqual(out['issues'], [{ path: 'name', message: 'required' }]);
  });

  it('returns non-object details as-is (Zod issue arrays pass through)', () => {
    const arr = [{ path: 'a', message: 'b' }];
    strictEqual(sanitizeDetailsForClient(arr), arr);
    strictEqual(sanitizeDetailsForClient(null), null);
    strictEqual(sanitizeDetailsForClient('text'), 'text');
  });
});

describe('classifyError — branch 1 (ApiError)', () => {
  it('uses the error status and emits the platform envelope incl. status', () => {
    const err = new ApiError('PM_PROJECT_NOT_FOUND', 'Project not found.', 404);
    const c = classifyError(err, { showStack: false });
    strictEqual(c.status, 404);
    deepStrictEqual(c.responseBody, {
      error: { code: 'PM_PROJECT_NOT_FOUND', message: 'Project not found.', status: 404 }
    });
    strictEqual(c.logLevel, 'info');
    strictEqual(c.logMessage, 'Project not found.');
  });

  it('maps VALIDATION_FAILED to warn; 5xx to error; other 4xx to info', () => {
    strictEqual(classifyError(new ApiError('VALIDATION_FAILED', 'bad', 422), { showStack: false }).logLevel, 'warn');
    strictEqual(classifyError(new ApiError('INTERNAL', 'boom'), { showStack: false }).logLevel, 'error');
    strictEqual(classifyError(new ApiError('FORBIDDEN', 'no', 403), { showStack: false }).logLevel, 'info');
  });

  it('client details are stripped, server logDetails keep the full (upstream-sanitized) set', () => {
    const err = new ApiError('VALIDATION_FAILED', 'bad', 422, {
      issues: [{ path: 'name', message: 'required' }],
      body: { password: 'x' }
    });
    const c = classifyError(err, { showStack: false });
    const clientDetails = c.responseBody.error.details as Record<string, unknown>;
    strictEqual('body' in clientDetails, false);
    deepStrictEqual(clientDetails['issues'], [{ path: 'name', message: 'required' }]);
    // server-side keeps body (it was already sanitized by buildErrorDetails upstream)
    strictEqual('body' in (c.logDetails as Record<string, unknown>), true);
  });

  it('stack reaches the classification only through the showStack gate', () => {
    const err = new ApiError('INTERNAL', 'boom');
    strictEqual('stack' in classifyError(err, { showStack: false }), false);
    strictEqual(typeof classifyError(err, { showStack: true }).stack, 'string');
  });
});

describe('classifyError — branch 2 (legacy apiError property)', () => {
  it('normalizes legacy shapes; registry status overrides for known codes', () => {
    const registry = defineErrorCodeRegistry({
      LLM_CONNECTION_ERROR: { code: 'LLM_CONNECTION_ERROR', status: 503, description: 'Upstream LLM unreachable.' }
    });
    const err = { apiError: { code: 'LLM_CONNECTION_ERROR', message: 'upstream down', status: 418 } };
    const c = classifyError(err, { showStack: false, registry });
    strictEqual(c.status, 503); // registry wins over the legacy object's 418
    deepStrictEqual(c.responseBody, {
      error: { code: 'LLM_CONNECTION_ERROR', message: 'upstream down', status: 503 }
    });
    strictEqual(c.logLevel, 'error');
  });

  it('unknown code without registry falls back to the extracted numeric status, else 500', () => {
    strictEqual(classifyError({ apiError: { message: 'x', status: 502 } }, { showStack: false }).status, 502);
    strictEqual(classifyError({ apiError: { message: 'x' } }, { showStack: false }).status, 500);
    const c = classifyError({ apiError: { message: 'x' } }, { showStack: false });
    strictEqual(c.responseBody.error.code, 'UNKNOWN_ERROR');
  });

  it('carries details to the log but strips them for the client', () => {
    const err = { apiError: { code: 'LEGACY', message: 'm', details: { token: 't', note: 'n' } } };
    const c = classifyError(err, { showStack: false });
    const clientDetails = c.responseBody.error.details as Record<string, unknown>;
    strictEqual(clientDetails['token'], undefined); // strip-set has exact 'token'
    strictEqual(clientDetails['note'], 'n');
    deepStrictEqual((c.logDetails as Record<string, unknown>)['token'], 't');
  });
});

describe('classifyError — branch 3 (uncaught Zod error)', () => {
  it('wraps as VALIDATION_FAILED/422 with issues kept for the client, request material stripped', () => {
    const zodErr = { issues: [{ path: ['email'], message: 'invalid' }] };
    const c = classifyError(zodErr, {
      showStack: false,
      url: '/api/users?state=s3cret',
      redactedBody: { email: 'a@b.c', password: '[REDACTED]' }
    });
    strictEqual(c.status, 422);
    deepStrictEqual(c.responseBody, {
      error: {
        code: 'VALIDATION_FAILED',
        message: 'The request payload failed validation.',
        status: 422,
        details: { issues: [{ path: ['email'], message: 'invalid' }] } // redactedBody + url stripped
      }
    });
    strictEqual(c.logLevel, 'warn');
    // server-side log keeps the redacted body + url for debugging
    const logDetails = c.logDetails as Record<string, unknown>;
    deepStrictEqual(logDetails['redactedBody'], { email: 'a@b.c', password: '[REDACTED]' });
    strictEqual(logDetails['url'], '/api/users?state=s3cret');
    strictEqual(c.cause, zodErr);
  });
});

describe('classifyError — branch 4 (fallback: never leak internals)', () => {
  it('maps Error names to stable codes and returns the GENERIC client message', () => {
    const c = classifyError(new TypeError('Cannot read properties of undefined (reading secretDbPath)'), {
      showStack: false
    });
    strictEqual(c.status, 500);
    deepStrictEqual(c.responseBody, {
      error: { code: 'TYPE_ERROR', message: 'An unexpected error occurred.', status: 500 }
    });
    // server-side log keeps the original message
    strictEqual(c.logMessage, 'Cannot read properties of undefined (reading secretDbPath)');
    strictEqual(c.logLevel, 'error');
  });

  it('string code on the error object becomes the client code (ported behavior)', () => {
    const c = classifyError(Object.assign(new Error('db down'), { code: 'ECONNREFUSED' }), { showStack: false });
    strictEqual(c.responseBody.error.code, 'ECONNREFUSED');
    strictEqual(c.responseBody.error.message, 'An unexpected error occurred.');
  });

  it('sanitizes the raw error for server-side logs', () => {
    const err = Object.assign(new Error('boom'), { body: { password: 'p' } });
    const c = classifyError(err, { showStack: false });
    const logDetails = c.logDetails as Record<string, unknown>;
    deepStrictEqual((logDetails['body'] as Record<string, unknown>)['password'], '[REDACTED]');
  });

  it('non-object, non-string throwables still classify (never throws)', () => {
    const c = classifyError(42, { showStack: false });
    strictEqual(c.status, 500);
    // Ported branch-4 behavior: no message property → the GENERIC message
    // (for both log and client) — numbers/booleans carry nothing better.
    strictEqual(c.logMessage, 'An unexpected error occurred.');
    deepStrictEqual(c.responseBody.error, { code: 'INTERNAL', message: 'An unexpected error occurred.', status: 500 });
  });
});
