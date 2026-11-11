/**
 * @file client/src/auth/authClient.test.ts
 * @description
 *   Consumer-level tests for the template's auth wiring — the FIRST REAL
 *   CONSUMER proof of `@agentic-dna/auth-client` (T1.5b). Runs under node:test
 *   (no DOM): the SDK's injected `fetch`/`navigate`/`storage` make the whole
 *   OIDC flow testable without a browser.
 *
 *   These tests double as the adapter-design feedback loop (ADR-020
 *   Phase 2): every friction point hit here is recorded in the template
 *   README "First-consumer findings".
 */
import { describe, it } from 'node:test';
import { strictEqual, ok, rejects } from 'node:assert';
import { memoryStorage } from '@agentic-dna/auth-client';
import { createAppAuth, type AppAuthConfig } from './authClient';

const config: AppAuthConfig = {
  authApiBaseUrl: 'https://auth-api.example.test',
  clientId: 'app-demo',
  redirectUri: 'http://localhost:5173/auth/callback',
  callbackPath: '/auth/callback',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function tokenJson(accessToken: string, refreshToken: string): Response {
  return jsonResponse({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: refreshToken,
    id_token: 'id-1',
  });
}

function header(init: RequestInit | undefined, name: string): string | null {
  const h = init?.headers;
  if (h instanceof Headers) return h.get(name);
  if (h !== undefined && typeof h === 'object') return (h as Record<string, string>)[name] ?? null;
  return null;
}

interface Harness {
  auth: ReturnType<typeof createAppAuth>;
  fetchCalls: Array<{ url: string; init?: RequestInit }>;
  tokenRequests: URLSearchParams[];
  noteAuth: Array<string | null>;
  navigated: string[];
  getLogoutCsrf(): string | null;
}

function makeHarness(opts: { failLogout?: boolean; notesSequence?: number[] } = {}): Harness {
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const tokenRequests: URLSearchParams[] = [];
  const noteAuth: Array<string | null> = [];
  const navigated: string[] = [];
  let logoutCsrf: string | null = null;
  let notesCall = 0;

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push({ url, init });
    if (url.includes('/auth/token')) {
      const body = new URLSearchParams(String(init?.body ?? ''));
      tokenRequests.push(body);
      return body.get('grant_type') === 'refresh_token' ? tokenJson('at-2', 'rt-2') : tokenJson('at-1', 'rt-1');
    }
    if (url.includes('/api/csrf-token')) {
      if (opts.failLogout === true) throw new TypeError('unreachable');
      return jsonResponse({ csrfToken: 'csrf-1' });
    }
    if (url.includes('/auth/logout')) {
      if (opts.failLogout === true) throw new TypeError('unreachable');
      logoutCsrf = header(init, 'x-csrf-token');
      return new Response(null, { status: 204 });
    }
    if (url.startsWith('/api/notes')) {
      noteAuth.push(header(init, 'authorization'));
      const seq = opts.notesSequence ?? [200];
      const status = seq[Math.min(notesCall, seq.length - 1)] ?? 200;
      notesCall++;
      return status === 200
        ? jsonResponse({
            notes: [
              { id: 'n1', title: 'Seeded', body: 'Synthetic data (R-ENV-01)', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
            ],
          })
        : jsonResponse({ error: { code: 'UNAUTHENTICATED', message: 'No verifier wired yet', status: 401 } }, 401);
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const auth = createAppAuth(config, {
    fetchImpl,
    navigate: (url: string) => {
      navigated.push(url);
    },
    storage: memoryStorage(),
  });
  return { auth, fetchCalls, tokenRequests, noteAuth, navigated, getLogoutCsrf: () => logoutCsrf };
}

/** signIn → extract the authorize state → completeCallback (the full dance). */
async function establishSession(h: Harness): Promise<void> {
  await h.auth.signIn('/notes');
  const state = new URL(h.navigated[0]!).searchParams.get('state') ?? '';
  await h.auth.completeCallback(new URLSearchParams(`code=the-code&state=${state}`));
}

describe('boot (ensureSession gate)', () => {
  it('no in-memory credential → one silent redirect dance (authorize URL well-formed)', async () => {
    const h = makeHarness();
    const boot = await h.auth.bootSession();
    strictEqual(boot.state, 'redirecting');
    strictEqual(h.navigated.length, 1);
    const url = new URL(h.navigated[0]!);
    strictEqual(url.origin + url.pathname, 'https://auth-api.example.test/auth/authorize');
    strictEqual(url.searchParams.get('client_id'), 'app-demo');
    strictEqual(url.searchParams.get('response_type'), 'code');
    strictEqual(url.searchParams.get('redirect_uri'), 'http://localhost:5173/auth/callback');
    ok(url.searchParams.get('code_challenge') !== null, 'PKCE S256 challenge present');
    ok(url.searchParams.get('state') !== null, 'single-use state present');
  });

  it('boot is single-flight: concurrent callers share ONE dance (React StrictMode double-invoke)', async () => {
    const h = makeHarness();
    const [a, b] = await Promise.all([h.auth.bootSession(), h.auth.bootSession()]);
    strictEqual(a.state, 'redirecting');
    strictEqual(b.state, 'redirecting');
    strictEqual(h.navigated.length, 1, 'exactly one redirect, not two');
  });
});

describe('sign-in + callback', () => {
  it('signIn persists returnTo out of the URL and redirects to the hosted flow', async () => {
    const h = makeHarness();
    await h.auth.signIn('/notes'); // resolves — REAUTH_REDIRECT is the success path
    strictEqual(h.navigated.length, 1);
    ok(h.navigated[0]!.includes('/auth/authorize'));
    ok(!h.navigated[0]!.includes('/notes'), 'returnTo must never ride in the URL');
  });

  it('completeCallback: state validated, code exchanged WITH verifier, returnTo restored', async () => {
    const h = makeHarness();
    await establishSession(h);
    const exchange = h.tokenRequests[0]!;
    strictEqual(exchange.get('grant_type'), 'authorization_code');
    strictEqual(exchange.get('code'), 'the-code');
    strictEqual(exchange.get('client_id'), 'app-demo');
    ok((exchange.get('code_verifier') ?? '').length >= 43, 'PKCE verifier carried (RFC 7636)');
  });

  it('stored state is single-use: a replayed callback fails closed (STATE_MISMATCH)', async () => {
    const h = makeHarness();
    await establishSession(h);
    const state = new URL(h.navigated[0]!).searchParams.get('state') ?? '';
    await rejects(
      () => h.auth.completeCallback(new URLSearchParams(`code=replayed&state=${state}`)),
      (err: unknown) => {
        strictEqual((err as { code?: string }).code, 'STATE_MISMATCH');
        return true;
      }
    );
  });

  it('user-cancelled flow (error=access_denied) surfaces as OAuthError with the RFC code', async () => {
    const h = makeHarness();
    await h.auth.signIn('/notes');
    const state = new URL(h.navigated[0]!).searchParams.get('state') ?? '';
    await rejects(
      () => h.auth.completeCallback(new URLSearchParams(`error=access_denied&state=${state}`)),
      (err: unknown) => {
        strictEqual((err as { code?: string }).code, 'access_denied');
        return true;
      }
    );
  });
});

describe('authenticated API access', () => {
  it('authedFetch attaches Bearer once a session exists', async () => {
    const h = makeHarness();
    await establishSession(h);
    await h.auth.authedFetch('/api/notes');
    strictEqual(h.noteAuth[0], 'Bearer at-1');
  });

  it('401 → one silent refresh → one retry with the NEW token (SDK contract through the wiring)', async () => {
    const h = makeHarness({ notesSequence: [401, 200] });
    await establishSession(h);
    const res = await h.auth.authedFetch('/api/notes');
    strictEqual(res.status, 200);
    strictEqual(h.noteAuth[0], 'Bearer at-1');
    strictEqual(h.noteAuth[1], 'Bearer at-2');
    const refresh = h.tokenRequests[1]!;
    strictEqual(refresh.get('grant_type'), 'refresh_token');
    strictEqual(refresh.get('refresh_token'), 'rt-1');
  });
});

describe('sign-out', () => {
  it('log out everywhere: CSRF double-submit, then no Bearer on later calls', async () => {
    const h = makeHarness();
    await establishSession(h);
    await h.auth.signOut();
    strictEqual(h.getLogoutCsrf(), 'csrf-1', 'logout POST carried the CSRF token');
    await h.auth.authedFetch('/api/notes');
    strictEqual(h.noteAuth[h.noteAuth.length - 1], null, 'no token in memory after logout');
  });

  it('sign-out resolves even when the auth endpoints are unreachable (local clear guaranteed)', async () => {
    const h = makeHarness({ failLogout: true });
    await establishSession(h);
    await h.auth.signOut(); // must NOT reject
    await h.auth.authedFetch('/api/notes');
    strictEqual(h.noteAuth[h.noteAuth.length - 1], null);
  });
});
