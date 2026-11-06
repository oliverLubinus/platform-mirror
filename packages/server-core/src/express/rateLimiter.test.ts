import { deepStrictEqual, strictEqual } from 'node:assert';
import { describe, it } from 'node:test';
import type { Request } from 'express';
import { createRateLimiter, rateLimitHandler } from './rateLimiter.js';

/** Minimal req for buildErrorDetails (fail-closed upstream sanitizer). */
function mockReq(): Request {
  return {
    method: 'POST',
    originalUrl: '/api/login',
    ip: '10.0.0.1',
    headers: { 'user-agent': 'test' },
    query: {},
    body: { email: 'a@b.c', password: 'hunter2' },
    // express internals probed by express-rate-limit (req.ip getter uses trust proxy fn)
    app: { get: () => () => false, enabled: () => false },
    socket: { remoteAddress: '10.0.0.1' }
  } as unknown as Request;
}

interface MockResState {
  statusCode?: number;
  body?: unknown;
  headers: Record<string, unknown>;
}

/** Typed surface of the evented res mock (status/json/setHeader/getHeader/on). */
interface MockRes {
  /** express reads res.statusCode directly (e.g. skipSuccessfulRequests). */
  statusCode?: number;
  status(code: number): MockRes;
  json(payload: unknown): MockRes;
  setHeader(name: string, value: unknown): MockRes;
  getHeader(name: string): unknown;
  on(event: string, handler: () => void): MockRes;
  once(event: string, handler: () => void): MockRes;
}

/** Evented res mock: setHeader/getHeader/status/json/on('finish'). */
function mockRes(): { state: MockResState; res: MockRes; finish(): void } {
  const state: MockResState = { headers: {} };
  const finishHandlers: Array<() => void> = [];
  const res: MockRes = {
    status(code: number) {
      state.statusCode = code;
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      state.body = payload;
      return res;
    },
    setHeader(name: string, value: unknown) {
      state.headers[name.toLowerCase()] = value;
      return res;
    },
    getHeader(name: string) {
      return state.headers[name.toLowerCase()];
    },
    on(event: string, handler: () => void) {
      if (event === 'finish') finishHandlers.push(handler);
      return res;
    },
    once(event: string, handler: () => void) {
      if (event === 'finish') finishHandlers.push(handler);
      return res;
    }
  };
  return {
    state,
    res,
    finish() {
      for (const handler of finishHandlers) handler();
    }
  };
}

describe('rateLimitHandler (envelope contract, unit-level)', () => {
  it('emits the platform envelope with code/message/status and buildErrorDetails output', () => {
    const { state, res } = mockRes();
    rateLimitHandler(
      mockReq(),
      res as never,
      () => {},
      { limit: 20, windowMs: 60000, statusCode: 429 },
      { code: 'RATE_LIMITED', message: 'Too many requests' }
    );
    strictEqual(state.statusCode, 429);
    const body = state.body as { error: Record<string, unknown> };
    strictEqual(body.error['code'], 'RATE_LIMITED');
    strictEqual(body.error['message'], 'Too many requests');
    strictEqual(body.error['status'], 429);
    const details = body.error['details'] as Record<string, unknown>;
    deepStrictEqual(details['current'], 20);
    deepStrictEqual(details['windowMs'], 60000);
  });
});

describe('createRateLimiter (integration through the real express-rate-limit)', () => {
  it('allows requests under the limit (next called) and blocks beyond it (429 envelope)', async () => {
    const limiter = createRateLimiter({
      windowMs: 60000,
      max: 3,
      message: 'Too many attempts',
      code: 'RATE_LIMITED'
    });
    const seenNext: boolean[] = [];
    let blocked: MockResState | undefined;
    for (let i = 0; i < 3; i++) {
      const { state, res } = mockRes();
      let called = false;
      limiter(mockReq(), res as never, () => {
        called = true;
      });
      await new Promise((r) => setTimeout(r, 5));
      seenNext.push(called);
    }
    const { state, res } = mockRes();
    limiter(mockReq(), res as never, () => {});
    await new Promise((r) => setTimeout(r, 5));
    blocked = state;

    deepStrictEqual(seenNext, [true, true, true]);
    strictEqual(blocked.statusCode, 429);
    strictEqual((blocked.body as { error: { code: string } }).error.code, 'RATE_LIMITED');
    // standardHeaders: true → RateLimit-* header present, legacy absent
    strictEqual(blocked.headers['ratelimit-limit'] !== undefined, true);
    strictEqual(blocked.headers['x-ratelimit-limit'], undefined);
  });

  it('GDR-4: skipSuccessfulRequests — successful responses never consume the budget', async () => {
    const limiter = createRateLimiter({
      windowMs: 60000,
      max: 2,
      message: 'Too many attempts',
      code: 'RATE_LIMITED',
      skipSuccessfulRequests: true
    });
    // 5 requests, each "completing" as a 2xx — the counter decrements on every
    // finish, so NONE of them may ever be blocked.
    for (let i = 0; i < 5; i++) {
      const { res, finish } = mockRes();
      let called = false;
      limiter(mockReq(), res as never, () => {
        called = true;
      });
      await new Promise((r) => setTimeout(r, 5));
      strictEqual(called, true, `request ${i + 1} should pass under a success-only counter`);
      // simulate express finishing a successful response
      res['status'](200);
      finish();
    }
  });

  it('without skipSuccessfulRequests, every request counts (historical behavior)', async () => {
    const limiter = createRateLimiter({
      windowMs: 60000,
      max: 2,
      message: 'Too many attempts',
      code: 'RATE_LIMITED'
    });
    for (let i = 0; i < 2; i++) {
      const { res } = mockRes();
      limiter(mockReq(), res as never, () => {});
      await new Promise((r) => setTimeout(r, 5));
    }
    const blocked = mockRes();
    limiter(mockReq(), blocked.res as never, () => {});
    await new Promise((r) => setTimeout(r, 5));
    strictEqual(blocked.state.statusCode, 429);
  });

  it('accepts a custom keyGenerator (ported option surface)', () => {
    const limiter = createRateLimiter({
      windowMs: 60000,
      max: 1,
      message: 'Too many attempts',
      code: 'RATE_LIMITED',
      keyGenerator: (req) => String((req as unknown as { headers: Record<string, string> }).headers['x-key'] ?? 'anon')
    });
    strictEqual(typeof limiter, 'function');
  });
});
