import { strictEqual, deepStrictEqual, throws } from 'node:assert';
import { describe, it } from 'node:test';
import { ApiError, getErrorStatusAndMessage, buildErrorDetails, hasNestedProperty } from './apiError.js';

describe('ApiError', () => {
  it('defaults to status 500 and carries code/message', () => {
    const e = new ApiError('INTERNAL', 'boom');
    strictEqual(e.code, 'INTERNAL');
    strictEqual(e.status, 500);
    strictEqual(e.message, 'boom');
    strictEqual(e instanceof Error, true);
    strictEqual(e instanceof ApiError, true);
  });

  it('toResponseBody emits the platform envelope incl. status (integration contract §3)', () => {
    const e = new ApiError('PM_PROJECT_NOT_FOUND', 'Project not found.', 404);
    deepStrictEqual(e.toResponseBody(), {
      error: { code: 'PM_PROJECT_NOT_FOUND', message: 'Project not found.', status: 404 }
    });
  });

  it('toResponseBody omits details when absent, includes when present', () => {
    const without = new ApiError('FORBIDDEN', 'no', 403).toResponseBody();
    strictEqual('details' in without.error, false);

    const withDetails = new ApiError('VALIDATION_FAILED', 'bad', 422, { field: 'name' }).toResponseBody();
    deepStrictEqual(withDetails.error.details, { field: 'name' });
  });

  it('formatDetails shapes Zod-issue arrays into {path, message}', () => {
    const shaped = ApiError.formatDetails([
      { path: ['user', 'email'], message: 'invalid' },
      { path: 'age', message: 'required' }
    ]);
    deepStrictEqual(shaped, [
      { path: 'user.email', message: 'invalid' },
      { path: 'age', message: 'required' }
    ]);
  });

  it('formatDetails passes non-Zod details through unchanged', () => {
    deepStrictEqual(ApiError.formatDetails(undefined), undefined);
    deepStrictEqual(ApiError.formatDetails({ any: 'thing' }), { any: 'thing' });
    deepStrictEqual(ApiError.formatDetails([]), []);
  });
});

describe('getErrorStatusAndMessage', () => {
  it('extracts from native Error', () => {
    deepStrictEqual(getErrorStatusAndMessage(new Error('plain')), { status: undefined, message: 'plain' });
  });

  it('extracts from axios-style response nesting', () => {
    const result = getErrorStatusAndMessage({
      response: { status: 503, data: { error: { message: 'upstream down' } } }
    });
    strictEqual(result.status, 503);
    strictEqual(result.message, 'upstream down');
  });

  it('falls back to JSON for opaque objects and strings for strings', () => {
    const opaque = getErrorStatusAndMessage({ weird: true });
    strictEqual(opaque.message, JSON.stringify({ weird: true }));
    strictEqual(getErrorStatusAndMessage('plain string').message, 'plain string');
  });
});

describe('buildErrorDetails (fail-closed sanitization)', () => {
  const fakeReq = {
    get: (name: string) => (name === 'user-agent' ? 'test-agent' : 'application/json'),
    method: 'POST',
    originalUrl: '/api/projects?state=abc123',
    ip: '127.0.0.1',
    body: { title: 'ok', password: 'hunter2' },
    query: { state: 'abc123' },
    headers: { cookie: 'sid=secret', 'content-type': 'application/json' }
  };

  it('redacts secrets in body, query, and headers by default', () => {
    const details = buildErrorDetails(fakeReq);
    const body = details['body'] as Record<string, unknown>;
    const headers = details['headers'] as Record<string, unknown>;
    strictEqual(body['title'], 'ok');
    strictEqual(body['password'], '[REDACTED]');
    strictEqual(headers['cookie'], '[REDACTED]');
    strictEqual(headers['content-type'], 'application/json');
  });

  it('sanitizes URL query (OAuth code/state/reset tokens) in url fields', () => {
    const details = buildErrorDetails(fakeReq);
    strictEqual(String(details['url']).includes('state=%5BREDACTED%5D'), true);
  });

  it('redacts caller-supplied secret keys in extraDetails', () => {
    const details = buildErrorDetails(fakeReq, { refreshToken: 'leak' });
    strictEqual(details['refreshToken'], '[REDACTED]');
  });
});

describe('hasNestedProperty', () => {
  it('navigates nested paths and rejects missing ones', () => {
    const obj = { response: { data: { error: { code: 42 } } } };
    strictEqual(hasNestedProperty<{ code: number }>(obj, ['response', 'data', 'error']), true);
    strictEqual(hasNestedProperty(obj, ['response', 'data', 'missing']), false);
    strictEqual(hasNestedProperty(null, ['a']), false);
  });
});

describe('throws', () => {
  it('ApiError instances are throwable and carry cause', () => {
    const cause = new Error('root');
    throws(() => {
      throw new ApiError('INTERNAL', 'wrapped', 500, undefined, cause);
    }, /wrapped/);
  });
});
