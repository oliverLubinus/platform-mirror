import { strictEqual, throws, match } from 'node:assert';
import { describe, it } from 'node:test';
import { AuthError, OAuthError } from './errors.js';

describe('AuthError (flow errors)', () => {
  it('carries code + message and is identifiable', () => {
    const err = new AuthError('STORAGE_UNAVAILABLE', 'window.sessionStorage is unavailable');
    strictEqual(err.name, 'AuthError');
    strictEqual(err.code, 'STORAGE_UNAVAILABLE');
    strictEqual(err.cause, undefined);
    strictEqual(err instanceof Error, true);
  });

  it('keeps the original failure as cause (never swallows it)', () => {
    const boom = new Error('storage quota exceeded');
    const err = new AuthError('STORAGE_UNAVAILABLE', 'sessionStorage write failed', { cause: boom });
    strictEqual(err.cause, boom);
  });

  it('exposes the documented codes as the exhaustiveness check', () => {
    const KNOWN: string[] = [
      'STORAGE_UNAVAILABLE',
      'STATE_MISMATCH',
      'VERIFIER_MISSING',
      'MISSING_CODE',
      'USER_CANCELLED',
      'PKCE_GENERATION_FAILED',
      'NETWORK_FAILURE',
      'TIMEOUT',
      'CONFIG_INVALID',
      'SERVER_MISCONFIGURED',
      'UNKNOWN',
    ];
    for (const code of KNOWN) {
      const err = new AuthError(code as never, 'test');
      strictEqual(err.code, code);
    }
  });
});

describe('OAuthError (protocol errors from /auth/token + /auth/authorize)', () => {
  it('parses RFC 6749 §5.2 error responses verbatim', () => {
    const err = OAuthError.fromResponse(400, '{"error":"invalid_grant","error_description":"code expired"}');
    strictEqual(err.name, 'OAuthError');
    strictEqual(err.code, 'invalid_grant');
    strictEqual(err.description, 'code expired');
    strictEqual(err.httpStatus, 400);
  });

  it('keeps the raw body when parsing fails — evidence beats a guess', () => {
    const err = OAuthError.fromResponse(403, '<html>proxy error</html>');
    strictEqual(err.code, 'unknown_error');
    match(err.rawBody ?? '', /proxy error/);
    strictEqual(err.httpStatus, 403);
  });

  it('re-auth redirection codes are distinguishable from retry codes', () => {
    const redirect = new OAuthError('invalid_grant', 'expired', 400, null);
    const retry = new OAuthError('server_error', 'boom', 503, null);
    strictEqual(redirect.requiresReauth, true);
    strictEqual(retry.requiresReauth, false);
  });

  it('fromResponse handles missing body (network-style status only)', () => {
    const err = OAuthError.fromResponse(502, null);
    strictEqual(err.code, 'unknown_error');
    strictEqual(err.httpStatus, 502);
  });
});

describe('error portability (R-ARCH-11 independent compilation)', () => {
  it('errors render without being constructed by a specific framework', () => {
    // Errors must survive logging/serialization paths without custom frames.
    const err = new AuthError('STATE_MISMATCH', 'state param mismatch');
    throws(
      () => {
        throw err;
      },
      (thrown: unknown) => thrown === err
    );
    match(String(err), /STATE_MISMATCH/);
  });
});
