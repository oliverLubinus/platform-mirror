import { deepStrictEqual, strictEqual } from 'node:assert';
import { describe, it } from 'node:test';
import type { Request } from 'express';
import { extractAccessToken, failClosedVerifier, getUserId, getUserIdOrThrow, requireAuth } from './auth.js';

function mockReq(headers: Record<string, string> = {}, query: Record<string, string> = {}): Request {
  return { headers, query, method: 'GET', originalUrl: '/' } as unknown as Request;
}

function mockRes() {
  const state: { statusCode?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      state.body = payload;
      return res;
    }
  };
  return { state, res };
}

describe('extractAccessToken (F-031 port — Authorization header only)', () => {
  it('Bearer + space → token', () =>
    strictEqual(extractAccessToken(mockReq({ authorization: 'Bearer abc.def' })), 'abc.def'));
  it('exact-match scheme: lowercase "bearer" → undefined (verbatim live behavior)', () =>
    strictEqual(extractAccessToken(mockReq({ authorization: 'bearer xyz' })), undefined));
  it('no scheme → undefined', () =>
    strictEqual(extractAccessToken(mockReq({ authorization: 'abc.def' })), undefined));
  it('empty header → undefined', () => strictEqual(extractAccessToken(mockReq({ authorization: '' })), undefined));
  it('missing header → undefined', () => strictEqual(extractAccessToken(mockReq()), undefined));
  it('Bearer with empty token → "" (falsy → requireAuth rejects)', () =>
    strictEqual(extractAccessToken(mockReq({ authorization: 'Bearer ' })), ''));
  it('F-031: query access_token is NOT consulted (header-only), even when present', () =>
    strictEqual(extractAccessToken(mockReq({}, { access_token: 'leak-me' })), undefined));
});

describe('getUserId / getUserIdOrThrow', () => {
  it('getUserId returns the id from req.user', () => {
    const req = mockReq() as unknown as { user?: { id?: string } };
    req.user = { id: 'u1' };
    strictEqual(getUserId(req as never), 'u1');
  });
  it('getUserId: user without an id → undefined', () => {
    const req = mockReq() as unknown as { user?: Record<string, unknown> };
    req.user = { sub: 'not-id' };
    strictEqual(getUserId(req as never), undefined);
  });
  it('getUserId: non-string id → undefined', () => {
    const req = mockReq() as unknown as { user?: { id?: unknown } };
    req.user = { id: 12345 };
    strictEqual(getUserId(req as never), undefined);
  });
  it('getUserId: unauthenticated → undefined', () => strictEqual(getUserId(mockReq() as never), undefined));
  it('getUserIdOrThrow returns the id when authenticated', () => {
    const req = mockReq() as unknown as { user?: { id?: string } };
    req.user = { id: 'u9' };
    strictEqual(getUserIdOrThrow(req as never), 'u9');
  });
  it('getUserIdOrThrow throws ApiError 401 UNAUTHENTICATED "Not authenticated"', () => {
    let thrown: unknown;
    try {
      getUserIdOrThrow(mockReq() as never);
    } catch (e) {
      thrown = e;
    }
    const err = thrown as { status?: number; code?: string; message?: string };
    strictEqual(err?.status, 401);
    strictEqual(err?.code, 'UNAUTHENTICATED');
    strictEqual(err?.message, 'Not authenticated');
  });
});

describe('requireAuth (Express middleware — envelope via res.status(401).json)', () => {
  it('no token → 401 UNAUTHENTICATED envelope, next NOT called, verifier NOT called', async () => {
    let nextCalled = false;
    let verifierCalled = false;
    const { state, res } = mockRes();
    requireAuth({
      verify: async () => {
        verifierCalled = true;
        return { sub: 'u1' };
      }
    })(mockReq(), res as never, () => (nextCalled = true));
    await new Promise((r) => setTimeout(r, 5));
    strictEqual(state.statusCode, 401);
    deepStrictEqual(state.body, {
      error: { code: 'UNAUTHENTICATED', message: 'Not authenticated', status: 401 }
    });
    strictEqual(nextCalled, false);
    strictEqual(verifierCalled, false);
  });

  it('valid verifier → next() called, req.user populated with the claims', async () => {
    let nextCalled = false;
    const { state, res } = mockRes();
    const req = mockReq({ authorization: 'Bearer tok' });
    requireAuth({
      verify: async (token: string) => {
        strictEqual(token, 'tok');
        return { sub: 'u1', scope: 'read' };
      }
    })(req, res as never, () => (nextCalled = true));
    await new Promise((r) => setTimeout(r, 5));
    strictEqual(nextCalled, true);
    deepStrictEqual((req as unknown as { user?: unknown }).user, { sub: 'u1', scope: 'read', id: 'u1' });
    strictEqual(state.statusCode, undefined);
  });

  it('verifier throws → same 401 UNAUTHENTICATED envelope (no reason leakage), next NOT called', async () => {
    let nextCalled = false;
    const { state, res } = mockRes();
    requireAuth({
      verify: async () => {
        throw new Error('token expired at 2024-01-01T00:00:00Z');
      }
    })(mockReq({ authorization: 'Bearer tok' }), res as never, () => (nextCalled = true));
    await new Promise((r) => setTimeout(r, 5));
    strictEqual(state.statusCode, 401);
    deepStrictEqual(state.body, {
      error: { code: 'UNAUTHENTICATED', message: 'Not authenticated', status: 401 }
    });
    strictEqual(nextCalled, false);
  });

  it('default verifier (failClosedVerifier) → 401 even with a well-formed token', async () => {
    let nextCalled = false;
    const { state, res } = mockRes();
    requireAuth()(mockReq({ authorization: 'Bearer anything' }), res as never, () => (nextCalled = true));
    await new Promise((r) => setTimeout(r, 5));
    strictEqual(state.statusCode, 401);
    strictEqual(nextCalled, false);
  });
});

describe('requireAuth subject normalization (PM B5 upstream finding — regression guards)', () => {
  /** Drives the middleware against mocks and awaits its async body. */
  async function drive(req: Request, res: unknown, next: () => void, verify: (token: string) => Promise<{ sub: string; [claim: string]: unknown }>) {
    requireAuth({ verify })(req, res as never, next);
    await new Promise((r) => setTimeout(r, 5));
  }

  it('getUserId resolves after requireAuth — the contract "sub attached as req.user.id" actually holds', async () => {
    let nextCalled = false;
    const { state, res } = mockRes();
    const req = mockReq({ authorization: 'Bearer tok' });
    await drive(req, res, () => (nextCalled = true), async () => ({ sub: 'subject-1', scope: 'read' }));
    strictEqual(nextCalled, true);
    // THE fix: getUserId reads req.user.id — it was undefined for every
    // verified request before normalization (PM B5 audit rows would have
    // carried no real subject).
    strictEqual(getUserId(req as never), 'subject-1');
    strictEqual(getUserIdOrThrow(req as never), 'subject-1');
    strictEqual(state.statusCode, undefined);
  });

  it('a token-level id claim (untrusted) is overridden by the verified sub — id is always authoritative-from-sub', async () => {
    let nextCalled = false;
    const { state, res } = mockRes();
    const req = mockReq({ authorization: 'Bearer tok' });
    await drive(req, res, () => (nextCalled = true), async () => ({ sub: 'u1', id: 'forged' }));
    strictEqual(nextCalled, true);
    strictEqual(getUserId(req as never), 'u1');
    strictEqual(getUserIdOrThrow(req as never), 'u1');
    strictEqual(state.statusCode, undefined);
  });

  it('normalization loses no claims — sub and app claims ride alongside id', async () => {
    let nextCalled = false;
    const { state, res } = mockRes();
    const req = mockReq({ authorization: 'Bearer tok' });
    await drive(req, res, () => (nextCalled = true), async () => ({ sub: 'u1', scope: 'read', amr: ['pwd'] }));
    strictEqual(nextCalled, true);
    const user = (req as unknown as { user?: Record<string, unknown> }).user as Record<string, unknown>;
    strictEqual(user.id, 'u1');
    strictEqual(user.sub, 'u1');
    strictEqual(user.scope, 'read');
    deepStrictEqual(user.amr, ['pwd']);
    strictEqual(state.statusCode, undefined);
  });
});

describe('failClosedVerifier (F-031 — monolith has no token verifier in the extracted slice)', () => {
  it('always rejects with ApiError 401 UNAUTHENTICATED "Token verifier not configured"', async () => {
    let thrown: unknown;
    try {
      await failClosedVerifier('some-token');
    } catch (e) {
      thrown = e;
    }
    const err = thrown as { status?: number; code?: string; message?: string };
    strictEqual(err?.status, 401);
    strictEqual(err?.code, 'UNAUTHENTICATED');
    strictEqual(err?.message, 'Token verifier not configured');
  });
});
