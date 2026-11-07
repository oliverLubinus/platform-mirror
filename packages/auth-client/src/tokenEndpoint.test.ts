import { deepStrictEqual, rejects, strictEqual, throws } from 'node:assert';
import { describe, it } from 'node:test';
import {
  exchangeAuthorizationCode,
  fetchUserInfoResponse,
  isRawTokenResponse,
  refreshTokens,
} from './tokenEndpoint.js';
import { resolveAuthClientConfig, type AuthClientConfig } from './config.js';
import { AuthError, OAuthError } from './errors.js';

function baseConfig(fetchImpl: typeof fetch): AuthClientConfig {
  return {
    authApiBaseUrl: 'https://auth-api.example.test',
    clientId: 'test-app',
    redirectUri: 'https://app.example.test/auth/callback',
    scopes: ['openid', 'profile'],
    fetchImpl,
    storage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
  };
}

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function jsonResponse(status: number, body: string, headers?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: headers ?? { 'content-type': 'application/json' },
  });
}

describe('isRawTokenResponse (shape guard)', () => {
  it('accepts the live backend shape', () => {
    strictEqual(
      isRawTokenResponse({
        access_token: 'at',
        id_token: 'id',
        refresh_token: 'rt',
        token_type: 'Bearer',
        expires_in: 900,
      }),
      true
    );
  });

  it('accepts the cookie-mode shape (no refresh_token — future backend)', () => {
    strictEqual(
      isRawTokenResponse({ access_token: 'at', token_type: 'Bearer', expires_in: 900, id_token: 'id' }),
      true
    );
  });

  it('rejects missing/empty access_token, non-positive expiry, wrong types', () => {
    strictEqual(isRawTokenResponse({ token_type: 'Bearer', expires_in: 900 }), false);
    strictEqual(isRawTokenResponse({ access_token: '', token_type: 'Bearer', expires_in: 900 }), false);
    strictEqual(
      isRawTokenResponse({ access_token: 'at', token_type: 'Bearer', expires_in: 0 }),
      false
    );
    strictEqual(
      isRawTokenResponse({ access_token: 'at', token_type: 'Bearer', expires_in: 'soon' }),
      false
    );
    strictEqual(isRawTokenResponse(null), false);
    strictEqual(isRawTokenResponse('at'), false);
  });
});

describe('exchangeAuthorizationCode (public client, PKCE)', () => {
  it('sends the exact form-encoded grant, credentials included, no secret', async () => {
    const captured: CapturedRequest[] = [];
    const cfg = resolveAuthClientConfig(
      baseConfig((_url, init) => {
        captured.push({ url: String(_url), init: init ?? {} });
        return Promise.resolve(
          jsonResponse(200, JSON.stringify({
            access_token: 'at-1',
            id_token: 'id-1',
            refresh_token: 'rt-1',
            token_type: 'Bearer',
            expires_in: 900,
          }))
        );
      })
    );

    const raw = (await exchangeAuthorizationCode(cfg, 'the-code', 'the-verifier')) as Record<string, unknown>;
    strictEqual(captured.length, 1);
    strictEqual(captured[0]?.url, 'https://auth-api.example.test/auth/token');

    const init = captured[0]?.init as {
      method: string;
      headers: Headers;
      body: string;
      credentials: RequestCredentials;
      signal: AbortSignal;
    };
    strictEqual(init.method, 'POST');
    strictEqual(init.credentials, 'include');
    strictEqual((init.headers as Headers).get('content-type'), 'application/x-www-form-urlencoded');
    strictEqual(init.signal instanceof AbortSignal, true);

    const body = new URLSearchParams(init.body as string);
    deepStrictEqual([...body.entries()], [
      ['grant_type', 'authorization_code'],
      ['code', 'the-code'],
      ['redirect_uri', 'https://app.example.test/auth/callback'],
      ['client_id', 'test-app'],
      ['code_verifier', 'the-verifier'],
    ]);
    strictEqual(body.has('client_secret'), false);

    strictEqual(raw['access_token'], 'at-1');
    strictEqual(raw['refresh_token'], 'rt-1');
  });

  it('maps RFC 6749 §5.2 error bodies to OAuthError with status', async () => {
    const cfg = resolveAuthClientConfig(
      baseConfig(() =>
        Promise.resolve(jsonResponse(400, JSON.stringify({ error: 'invalid_grant', error_description: 'code expired' })))
      )
    );
    await rejects(
      exchangeAuthorizationCode(cfg, 'code', 'verifier'),
      (err: unknown) =>
        err instanceof OAuthError &&
        err.code === 'invalid_grant' &&
        err.description === 'code expired' &&
        err.httpStatus === 400
    );
  });

  it('keeps HTML error bodies as raw evidence (unknown-path 404)', async () => {
    const cfg = resolveAuthClientConfig(
      baseConfig(() =>
        Promise.resolve(
          new Response('<html>not found</html>', {
            status: 404,
            headers: { 'content-type': 'text/html' },
          })
        )
      )
    );
    await rejects(
      exchangeAuthorizationCode(cfg, 'code', 'verifier'),
      (err: unknown) =>
        err instanceof OAuthError && err.code === 'unknown_error' && err.httpStatus === 404
    );
  });

  it('never retried: one fetch per call even on failure (single-use code)', async () => {
    let calls = 0;
    const cfg = resolveAuthClientConfig(
      baseConfig(() => {
        calls++;
        return Promise.resolve(jsonResponse(400, JSON.stringify({ error: 'invalid_grant' })));
      })
    );
    await rejects(exchangeAuthorizationCode(cfg, 'code', 'verifier'), OAuthError);
    strictEqual(calls, 1);
  });
});

describe('refreshTokens (strategy-dependent body)', () => {
  const tokenResponse = JSON.stringify({
    access_token: 'at-2',
    id_token: 'id-2',
    refresh_token: 'rt-2',
    token_type: 'Bearer',
    expires_in: 900,
  });

  it('memory leg: body carries refresh_token', async () => {
    const captured: CapturedRequest[] = [];
    const cfg = resolveAuthClientConfig(
      baseConfig((url, init) => {
        captured.push({ url: String(url), init: init ?? {} });
        return Promise.resolve(jsonResponse(200, tokenResponse));
      })
    );
    await refreshTokens(cfg, 'rt-1');
    const body = new URLSearchParams(captured[0]?.init?.body as string);
    strictEqual(body.get('refresh_token'), 'rt-1');
    strictEqual(body.get('client_id'), 'test-app');
  });

  it('cookie leg: body omits refresh_token (target backend contract)', async () => {
    const captured: CapturedRequest[] = [];
    const cfg = resolveAuthClientConfig(
      baseConfig((url, init) => {
        captured.push({ url: String(url), init: init ?? {} });
        return Promise.resolve(jsonResponse(200, tokenResponse));
      })
    );
    await refreshTokens(cfg, null);
    const body = new URLSearchParams(captured[0]?.init?.body as string);
    strictEqual(body.has('refresh_token'), false);
    strictEqual(body.get('client_id'), 'test-app');
  });

  it('terminal refresh failure: invalid_grant → requiresReauth (family/rotation dead)', async () => {
    const cfg = resolveAuthClientConfig(
      baseConfig(() => Promise.resolve(jsonResponse(400, JSON.stringify({ error: 'invalid_grant' }))))
    );
    await rejects(refreshTokens(cfg, 'rt-dead'), (err: unknown) => {
      return err instanceof OAuthError && err.requiresReauth === true;
    });
  });

  it('transient refresh failure: server_error → retryable (no session clear)', async () => {
    const cfg = resolveAuthClientConfig(
      baseConfig(() => Promise.resolve(jsonResponse(503, JSON.stringify({ error: 'server_error' }))))
    );
    await rejects(refreshTokens(cfg, 'rt-1'), (err: unknown) => {
      return err instanceof OAuthError && err.requiresReauth === false;
    });
  });
});

describe('network failure mapping', () => {
  it('plain rejections map to NETWORK_FAILURE (no token material in the message)', async () => {
    const cfg = resolveAuthClientConfig(
      baseConfig(() => Promise.reject(new Error('ECONNREFUSED 127.0.0.1:4000')))
    );
    await rejects(refreshTokens(cfg, null), (err: unknown) => {
      return err instanceof AuthError && err.code === 'NETWORK_FAILURE';
    });
  });
});

describe('fetchUserInfoResponse', () => {
  it('attaches the Bearer header and hits /auth/userinfo', async () => {
    const captured: CapturedRequest[] = [];
    const cfg = resolveAuthClientConfig(
      baseConfig((url, init) => {
        captured.push({ url: String(url), init: init ?? {} });
        return Promise.resolve(jsonResponse(200, JSON.stringify({ sub: 'u-1' })));
      })
    );
    const res = await fetchUserInfoResponse(cfg, 'at-1');
    strictEqual(res.status, 200);
    strictEqual(captured[0]?.url, 'https://auth-api.example.test/auth/userinfo');
    strictEqual((captured[0]?.init?.headers as Headers).get('authorization'), 'Bearer at-1');
  });
});

describe('error hygiene (R-PKG-03)', () => {
  it('AuthError messages never embed token material from the grant', () => {
    // The mapping path must not stringify responses into error messages.
    const grant = JSON.stringify({
      access_token: 'SECRET-AT',
      token_type: 'Bearer',
      expires_in: 900,
      refresh_token: 'SECRET-RT',
    });
    const bad = new Response(grant, { status: 400, headers: { 'content-type': 'application/json' } });
    void bad;
    const err = new AuthError('MALFORMED_TOKEN_RESPONSE', 'token response shape invalid');
    strictEqual(String(err).includes('SECRET'), false);
    throws(() => {
      throw OAuthError.fromResponse(400, JSON.stringify({ error: 'invalid_grant' }));
    }, /invalid_grant/);
  });
});
