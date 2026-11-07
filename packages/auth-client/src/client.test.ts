import { deepStrictEqual, rejects, strictEqual } from 'node:assert';
import { describe, it } from 'node:test';
import { createAuthClient, type AuthClient } from './client.js';
import { AuthError, OAuthError } from './errors.js';
import { memoryStorage, type MemoryStorage } from './storage.js';
import type { AuthClientConfig } from './config.js';

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function jsonResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

const TOKEN_OK = JSON.stringify({
  access_token: 'at-1',
  id_token: 'id-1',
  refresh_token: 'rt-1',
  token_type: 'Bearer',
  expires_in: 900,
});

interface Harness {
  client: AuthClient;
  storage: MemoryStorage;
  fetchCalls: CapturedRequest[];
  navigated: string[];
  respondWith: (make: (url: string, init: RequestInit) => Response) => void;
  nowMs: { value: number };
}

function makeHarness(overrides?: Partial<AuthClientConfig>): Harness {
  const storage = memoryStorage();
  const fetchCalls: CapturedRequest[] = [];
  const navigated: string[] = [];
  const nowMs = { value: 1_000_000_000_000 };
  let responder: (url: string, init: RequestInit) => Response = () =>
    jsonResponse(200, TOKEN_OK);

  const cfg: AuthClientConfig = {
    authApiBaseUrl: 'https://auth-api.example.test',
    clientId: 'test-app',
    redirectUri: 'https://app.example.test/auth/callback',
    scopes: ['openid', 'profile'],
    storage,
    navigate: (url) => navigated.push(url),
    fetchImpl: (url, init) => {
      const r = { url: String(url), init: init ?? {} };
      fetchCalls.push(r);
      return Promise.resolve(responder(r.url, r.init));
    },
    now: () => nowMs.value,
    ...overrides,
  };
  const client = createAuthClient(cfg);
  return {
    client,
    storage,
    fetchCalls,
    navigated,
    respondWith: (make) => {
      responder = make;
    },
    nowMs,
  };
}

/** Drive login → callback with a matching state, returning the harness. */
async function loginAndCallback(
  h: Harness,
  options?: { returnTo?: string; tokenBody?: string }
): Promise<void> {
  if (options?.tokenBody !== undefined) {
    h.respondWith(() => jsonResponse(200, options.tokenBody as string));
  }
  await h.client.buildLoginUrl(options);
  const state = h.storage.getItem('platform-auth:state:test-app') as string;
  const params = new URLSearchParams(`code=cb-code&state=${encodeURIComponent(state)}`);
  await h.client.handleCallback(params);
}

describe('login / buildLoginUrl', () => {
  it('builds the authorize URL, persists PKCE state + verifier + returnTo, no fetch', async () => {
    const h = makeHarness();
    const url = await h.client.buildLoginUrl({ returnTo: '/app/settings' });
    const parsed = new URL(url);
    strictEqual(parsed.origin + parsed.pathname, 'https://auth-api.example.test/auth/authorize');
    strictEqual(parsed.searchParams.get('client_id'), 'test-app');
    strictEqual(parsed.searchParams.get('response_type'), 'code');
    strictEqual(parsed.searchParams.get('scope'), 'openid profile');
    strictEqual(parsed.searchParams.get('code_challenge_method'), 'S256');
    strictEqual(parsed.searchParams.get('client_secret'), null);
    strictEqual(h.storage.getItem('platform-auth:state:test-app'), parsed.searchParams.get('state'));
    strictEqual(h.storage.getItem('platform-auth:returnTo:test-app'), '/app/settings');
    strictEqual((h.storage.getItem('platform-auth:pkce:test-app') as string).length >= 43, true);
    strictEqual(h.fetchCalls.length, 0);
    strictEqual(h.navigated.length, 0);
  });

  it('login() navigates and throws REAUTH_REDIRECT (never returns normally)', async () => {
    const h = makeHarness();
    await rejects(h.client.login({ returnTo: '/x' }), (err: unknown) => {
      return err instanceof AuthError && err.code === 'REAUTH_REDIRECT';
    });
    strictEqual(h.navigated.length, 1);
    strictEqual(h.navigated[0]?.startsWith('https://auth-api.example.test/auth/authorize?'), true);
  });

  it('storage-unavailable (SSR) → STORAGE_UNAVAILABLE, no navigation', async () => {
    const failing = memoryStorage();
    failing.throwOnWrite = true;
    const h = makeHarness({ storage: failing });
    await rejects(h.client.login());
    strictEqual(h.navigated.length, 0);
    strictEqual(h.fetchCalls.length, 0);
  });
});

describe('handleCallback', () => {
  it('happy path: state validated, code exchanged with verifier, session in memory, flow state consumed', async () => {
    const h = makeHarness();
    await h.client.buildLoginUrl({ returnTo: '/app/home' });
    const state = h.storage.getItem('platform-auth:state:test-app') as string;
    const verifier = h.storage.getItem('platform-auth:pkce:test-app') as string;
    const params = new URLSearchParams(`code=cb-code&state=${encodeURIComponent(state)}`);
    const result = await h.client.handleCallback(params);

    strictEqual(result.session.accessToken, 'at-1');
    strictEqual(result.session.idToken, 'id-1');
    strictEqual(result.returnTo, '/app/home');
    strictEqual(h.storage.getItem('platform-auth:pkce:test-app'), null);
    strictEqual(h.storage.getItem('platform-auth:state:test-app'), null);
    strictEqual(h.storage.getItem('platform-auth:returnTo:test-app'), null);
    strictEqual(h.client.getSession()?.accessToken, 'at-1');

    const body = new URLSearchParams(h.fetchCalls[0]?.init?.body as string);
    deepStrictEqual([...body.entries()], [
      ['grant_type', 'authorization_code'],
      ['code', 'cb-code'],
      ['redirect_uri', 'https://app.example.test/auth/callback'],
      ['client_id', 'test-app'],
      ['code_verifier', verifier],
    ]);
  });

  it('state mismatch → STATE_MISMATCH, NO token request, flow state wiped (fail closed)', async () => {
    const h = makeHarness();
    await h.client.buildLoginUrl();
    h.fetchCalls.length = 0;
    const params = new URLSearchParams('code=cb-code&state=WRONG');
    await rejects(h.client.handleCallback(params), (err: unknown) => {
      return err instanceof AuthError && err.code === 'STATE_MISMATCH';
    });
    strictEqual(h.fetchCalls.length, 0);
    strictEqual(h.storage.getItem('platform-auth:state:test-app'), null);
    strictEqual(h.storage.getItem('platform-auth:pkce:test-app'), null);
  });

  it('stored state is single-use: a replayed callback fails STATE_MISMATCH', async () => {
    const h = makeHarness();
    await loginAndCallback(h);
    const params = new URLSearchParams('code=cb-code&state=anything');
    await rejects(h.client.handleCallback(params), (err: unknown) => {
      return err instanceof AuthError && err.code === 'STATE_MISMATCH';
    });
  });

  it('authorize redirect error=access_denied → OAuthError with the RFC code', async () => {
    const h = makeHarness();
    await h.client.buildLoginUrl();
    const state = h.storage.getItem('platform-auth:state:test-app') as string;
    const params = new URLSearchParams(
      `error=access_denied&error_description=${encodeURIComponent('User denied consent')}&state=${encodeURIComponent(state)}`
    );
    await rejects(h.client.handleCallback(params), (err: unknown) => {
      return (
        err instanceof OAuthError &&
        err.code === 'access_denied' &&
        err.description === 'User denied consent'
      );
    });
    strictEqual(h.fetchCalls.length, 0);
  });

  it('missing code → MISSING_CODE', async () => {
    const h = makeHarness();
    await h.client.buildLoginUrl();
    const state = h.storage.getItem('platform-auth:state:test-app') as string;
    await rejects(
      h.client.handleCallback(new URLSearchParams(`state=${encodeURIComponent(state)}`)),
      (err: unknown) => err instanceof AuthError && err.code === 'MISSING_CODE'
    );
  });

  it('missing verifier (storage wiped mid-flow) → VERIFIER_MISSING, no exchange', async () => {
    const h = makeHarness();
    await h.client.buildLoginUrl();
    const state = h.storage.getItem('platform-auth:state:test-app') as string;
    h.storage.removeItem('platform-auth:pkce:test-app');
    h.fetchCalls.length = 0;
    await rejects(
      h.client.handleCallback(new URLSearchParams(`code=x&state=${encodeURIComponent(state)}`)),
      (err: unknown) => err instanceof AuthError && err.code === 'VERIFIER_MISSING'
    );
    strictEqual(h.fetchCalls.length, 0);
  });
});

describe('ensureSession / refresh', () => {
  it('valid token → session returned, zero network calls', async () => {
    const h = makeHarness();
    await loginAndCallback(h);
    h.fetchCalls.length = 0;
    const s = await h.client.ensureSession();
    strictEqual(s.accessToken, 'at-1');
    strictEqual(h.fetchCalls.length, 0);
    strictEqual(h.navigated.length, 0);
  });

  it('expired token + credential → silent refresh (memory leg), rotation lands', async () => {
    const h = makeHarness();
    await loginAndCallback(h); // exchange: TOKEN_OK (at-1/rt-1)
    h.fetchCalls.length = 0;
    h.respondWith(() =>
      jsonResponse(
        200,
        JSON.stringify({
          access_token: 'at-2',
          id_token: 'id-2',
          refresh_token: 'rt-2',
          token_type: 'Bearer',
          expires_in: 900,
        })
      )
    );
    h.nowMs.value += 1000 * 900; // past expiry (+skew)
    const s = await h.client.ensureSession();
    strictEqual(s.accessToken, 'at-2');
    const body = new URLSearchParams(h.fetchCalls[0]?.init?.body as string);
    strictEqual(body.get('grant_type'), 'refresh_token');
    strictEqual(body.get('refresh_token'), 'rt-1');
    strictEqual(h.navigated.length, 0);
  });

  it('expired token, no credential (auto) → redirect re-auth, NO token request', async () => {
    const h = makeHarness();
    await loginAndCallback(h);
    h.client.clearLocalSession(); // page reload loses ALL in-memory state
    h.fetchCalls.length = 0;
    await rejects(h.client.ensureSession(), (err: unknown) => {
      return err instanceof AuthError && err.code === 'REAUTH_REDIRECT';
    });
    strictEqual(h.fetchCalls.length, 0);
    strictEqual(h.navigated.length, 1);
    // The redirect re-auth starts a NEW flow state.
    strictEqual(h.storage.getItem('platform-auth:state:test-app') !== null, true);
  });

  it("cookie strategy: body omits refresh_token (target backend contract)", async () => {
    const h = makeHarness({ refreshCredential: 'cookie' });
    // Simulate the cookie-mode backend: exchange returns NO refresh_token.
    await loginAndCallback(h, {
      tokenBody: JSON.stringify({ access_token: 'at-1', token_type: 'Bearer', expires_in: 900 }),
    });
    h.fetchCalls.length = 0;
    h.respondWith(() =>
      jsonResponse(
        200,
        JSON.stringify({ access_token: 'at-2', token_type: 'Bearer', expires_in: 900 })
      )
    );
    h.nowMs.value += 1000 * 900;
    const s = await h.client.ensureSession();
    strictEqual(s.accessToken, 'at-2');
    const body = new URLSearchParams(h.fetchCalls[0]?.init?.body as string);
    strictEqual(body.has('refresh_token'), false);
  });

  it('terminal refresh failure (invalid_grant) → session cleared, ensureSession redirects', async () => {
    const h = makeHarness();
    let phase = 0;
    h.respondWith(() => {
      phase++;
      if (phase === 1) return jsonResponse(200, TOKEN_OK); // exchange
      return jsonResponse(400, JSON.stringify({ error: 'invalid_grant' })); // refresh
    });
    await loginAndCallback(h);
    h.nowMs.value += 1000 * 900;
    await rejects(h.client.ensureSession(), (err: unknown) => {
      return err instanceof AuthError && err.code === 'REAUTH_REDIRECT';
    });
    strictEqual(h.client.getSession(), null);
  });

  it('transient refresh failure (server_error) → session KEPT, credential re-armed for retry', async () => {
    const h = makeHarness();
    let phase = 0;
    h.respondWith(() => {
      phase++;
      if (phase <= 1) return jsonResponse(200, TOKEN_OK); // exchange
      if (phase === 2) return jsonResponse(503, JSON.stringify({ error: 'server_error' })); // refresh fails
      return jsonResponse(
        200,
        JSON.stringify({ access_token: 'at-2', token_type: 'Bearer', expires_in: 900, refresh_token: 'rt-2' })
      ); // refresh succeeds
    });
    await loginAndCallback(h);
    h.nowMs.value += 1000 * 900;
    await rejects(h.client.refresh(), (err: unknown) => {
      return err instanceof OAuthError && err.code === 'server_error';
    });
    // Session survives a transient failure.
    strictEqual(h.client.getSession()?.accessToken, 'at-1');
    // The SAME credential is retried (rotation never happened server-side).
    h.nowMs.value += 1000;
    const s = await h.client.refresh();
    strictEqual(s.accessToken, 'at-2');
    const retryBody = new URLSearchParams(h.fetchCalls[2]?.init?.body as string);
    strictEqual(retryBody.get('refresh_token'), 'rt-1');
  });

  it('concurrent refresh callers share one flight (claim-once prevents replay)', async () => {
    const h = makeHarness();
    let refreshCalls = 0;
    h.respondWith((_url, _init) => {
      const body = new URLSearchParams((_init?.body as string) ?? '');
      if (body.get('grant_type') === 'refresh_token') refreshCalls++;
      return jsonResponse(
        200,
        JSON.stringify({ access_token: `at-${refreshCalls}`, token_type: 'Bearer', expires_in: 900, refresh_token: `rt-${refreshCalls}` })
      );
    });
    await loginAndCallback(h);
    h.nowMs.value += 1000 * 900;
    const [a, b] = await Promise.all([h.client.refresh(), h.client.refresh()]);
    strictEqual(refreshCalls, 1);
    strictEqual(a.accessToken, b.accessToken);
  });
});

describe('authenticatedFetch', () => {
  it('attaches Bearer; on 401 refreshes once and retries with the NEW token', async () => {
    const h = makeHarness();
    await loginAndCallback(h); // exchange: at-1/rt-1
    h.fetchCalls.length = 0;
    h.respondWith((url, init) => {
      if (url.includes('/auth/token')) {
        return jsonResponse(
          200,
          JSON.stringify({ access_token: 'at-2', token_type: 'Bearer', expires_in: 900, refresh_token: 'rt-2' })
        );
      }
      const auth = (init.headers as Headers).get('authorization');
      if (auth === 'Bearer at-1') return jsonResponse(401, '{"error":{"code":"UNAUTHORIZED"}}');
      return jsonResponse(200, '{"ok":true}');
    });

    const res = await h.client.authenticatedFetch('https://api.example.test/v1/things');
    strictEqual(res.status, 200);
    // call 1: API 401, call 2: token refresh, call 3: API retry
    strictEqual(h.fetchCalls.length, 3);
    const apiAuth1 = (h.fetchCalls[0]?.init?.headers as Headers).get('authorization');
    const apiAuth2 = (h.fetchCalls[2]?.init?.headers as Headers).get('authorization');
    strictEqual(apiAuth1, 'Bearer at-1');
    strictEqual(apiAuth2, 'Bearer at-2');
  });

  it('refresh still 401-bound → original 401 returned, no infinite loop', async () => {
    const h = makeHarness();
    let phase = 0;
    h.respondWith((url) => {
      phase++;
      if (phase === 1) return jsonResponse(200, TOKEN_OK); // exchange
      if (url.includes('/auth/token')) {
        return jsonResponse(400, JSON.stringify({ error: 'invalid_grant' })); // refresh dead
      }
      return jsonResponse(401, '{"error":{"code":"UNAUTHORIZED"}}');
    });
    await loginAndCallback(h);
    h.nowMs.value += 1000 * 900; // force refresh on 401
    h.fetchCalls.length = 0;
    const res = await h.client.authenticatedFetch('https://api.example.test/v1/things');
    strictEqual(res.status, 401);
    strictEqual(h.fetchCalls.length, 2); // API + one refresh, NO second API call
    strictEqual(h.client.getSession(), null); // terminal → cleared
  });

  it('Request-object input: 401 returned as-is (a consumed body cannot be re-sent)', async () => {
    const h = makeHarness();
    h.respondWith((url) => {
      if (url.includes('/auth/token')) return jsonResponse(200, TOKEN_OK);
      return jsonResponse(401, '{"error":{"code":"UNAUTHORIZED"}}');
    });
    await loginAndCallback(h);
    h.fetchCalls.length = 0;
    const req = new Request('https://api.example.test/v1/things');
    const res = await h.client.authenticatedFetch(req);
    strictEqual(res.status, 401);
    strictEqual(h.fetchCalls.length, 1);
  });
});

describe('fetchUserInfo', () => {
  it('returns typed claims on 200', async () => {
    const h = makeHarness();
    h.respondWith((url) => {
      if (url.includes('/auth/userinfo')) {
        return jsonResponse(
          200,
          JSON.stringify({ sub: 'u-1', email: 'u@example.test', amr: ['pwd', 'otp'] })
        );
      }
      return jsonResponse(200, TOKEN_OK);
    });
    await loginAndCallback(h);
    const claims = await h.client.fetchUserInfo();
    strictEqual(claims.sub, 'u-1');
    deepStrictEqual(claims.amr, ['pwd', 'otp']);
  });

  it('no session → REFRESH_UNAVAILABLE without a network call', async () => {
    const h = makeHarness();
    await rejects(h.client.fetchUserInfo(), (err: unknown) => {
      return err instanceof AuthError && err.code === 'REFRESH_UNAVAILABLE';
    });
    strictEqual(h.fetchCalls.length, 0);
  });
});

describe('logout', () => {
  it('CSRF double-submit: GET /api/csrf-token then POST /auth/logout with x-csrf-token', async () => {
    const h = makeHarness();
    h.respondWith((url) => {
      if (url.includes('/api/csrf-token')) return jsonResponse(200, JSON.stringify({ csrfToken: 'csrf-1' }));
      if (url.includes('/auth/token')) return jsonResponse(200, TOKEN_OK);
      return jsonResponse(200, '{}');
    });
    await loginAndCallback(h);
    h.fetchCalls.length = 0;
    await h.client.logout();
    strictEqual(h.fetchCalls.length, 2);
    strictEqual(h.fetchCalls[0]?.url.includes('/api/csrf-token'), true);
    strictEqual(h.fetchCalls[1]?.url.includes('/auth/logout'), true);
    strictEqual((h.fetchCalls[1]?.init?.headers as Headers).get('x-csrf-token'), 'csrf-1');
    strictEqual((h.fetchCalls[1]?.init?.headers as Headers).get('x-csrf-token'), 'csrf-1');
    strictEqual(h.client.getSession(), null);
  });

  it('logout endpoint unreachable → LOGOUT_FAILED, local state STILL cleared', async () => {
    const h = makeHarness();
    h.respondWith((url) => {
      if (url.includes('/api/csrf-token')) return jsonResponse(200, JSON.stringify({ csrfToken: 'csrf-1' }));
      if (url.includes('/auth/token')) return jsonResponse(200, TOKEN_OK);
      throw new Error('conn refused');
    });
    await loginAndCallback(h);
    await rejects(h.client.logout(), (err: unknown) => {
      return err instanceof AuthError && err.code === 'LOGOUT_FAILED';
    });
    strictEqual(h.client.getSession(), null);
  });
});

describe('default storage is fail-fast without a browser (SSR)', () => {
  it('no injected storage + no window → STORAGE_UNAVAILABLE on login', async () => {
    // Node test env has no `window`: defaultStorage() resolves to the
    // fail-fast adapter, proving SSR hosts cannot silently lose PKCE state.
    const client = createAuthClient({
      authApiBaseUrl: 'https://auth-api.example.test',
      clientId: 'test-app',
      redirectUri: 'https://app.example.test/auth/callback',
      fetchImpl: () => Promise.resolve(jsonResponse(200, TOKEN_OK)),
      navigate: () => {},
    });
    await rejects(client.login(), (err: unknown) => {
      return err instanceof AuthError && err.code === 'STORAGE_UNAVAILABLE';
    });
  });
});

describe('expiry skew + subscribe', () => {
  it('token counts as expired inside the skew window', async () => {
    const h = makeHarness();
    // TOKEN_OK has expires_in 900, skew 30 → expiresAt = now + 870s
    await loginAndCallback(h);
    strictEqual(h.client.isSessionExpired(), false);
    h.nowMs.value += 1000 * 871;
    strictEqual(h.client.isSessionExpired(), true);
  });

  it('subscribe fires with the session on store and with null on clear', async () => {
    const h = makeHarness();
    const seen: (string | null)[] = [];
    h.client.subscribe((s) => seen.push(s?.accessToken ?? null));
    await loginAndCallback(h);
    h.client.clearLocalSession();
    deepStrictEqual(seen, ['at-1', null]);
  });
});

describe('R-PKG-03 hard rules (behavioral)', () => {
  it('after a full flow, storage holds only flow-state keys — no token material', async () => {
    const h = makeHarness();
    await loginAndCallback(h);
    for (const [key, value] of h.storage) {
      strictEqual(key.startsWith('platform-auth:'), true, `unexpected storage key ${key}`);
      strictEqual(value.includes('at-1'), false);
      strictEqual(value.includes('rt-1'), false);
      strictEqual(value.includes('id-1'), false);
    }
  });
});
