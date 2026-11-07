/**
 * @file server/src/app.test.ts
 * @description
 *   Platform-wiring tests for the app factory. DB-free — these prove the
 *   PLATFORM contract (headers, envelope, rate limiting, fail-closed auth),
 *   not business logic. DB-backed routes get integration tests against the
 *   compose Postgres (T1.5c CI job).
 */
import { describe, it, beforeEach } from 'node:test';
import { strictEqual } from 'node:assert';
import express from 'express';
import request from 'supertest';
import { type AppConfig } from './config.js';
import { createApp } from './app.js';

const config: AppConfig = {
  nodeEnv: 'test',
  port: 8080,
  logLevel: 'error',
  databaseUrl: 'postgresql://app:app@localhost:54329/app',
  rateLimitMax: 300,
  rateLimitWindowMs: 60000,
  auditHmacKey: 'test-only-not-a-secret',
};

describe('platform wiring (server-core pre-wired, R-PKG-09)', () => {
  let app: express.Express;
  beforeEach(() => {
    app = createApp({ config });
  });

  it('GET /api/health → 200, no-store, security headers present', async () => {
    const res = await request(app).get('/api/health');
    strictEqual(res.status, 200);
    strictEqual(res.body.ok, true);
    strictEqual(res.headers['x-content-type-options'], 'nosniff');
    strictEqual(res.headers['x-frame-options'], 'DENY');
    strictEqual(res.headers['cache-control'], 'no-store');
  });

  it('unknown route → 404 in the platform envelope shape', async () => {
    const res = await request(app).get('/api/nope');
    strictEqual(res.status, 404);
    strictEqual(res.body.error.code, 'NOT_FOUND');
    strictEqual(res.body.error.status, 404);
  });

  it('protected route with NO verifier → 401 fail-closed even with a well-formed token', async () => {
    const res = await request(app).get('/api/notes').set('authorization', 'Bearer anything');
    strictEqual(res.status, 401);
    strictEqual(res.body.error.code, 'UNAUTHENTICATED');
  });

  it('rate limiter is wired (429 envelope under load)', async () => {
    const tight = createApp({
      config: { ...config, rateLimitMax: 3, rateLimitWindowMs: 60000 },
    });
    for (let i = 0; i < 3; i++) await request(tight).get('/api/health');
    const res = await request(tight).get('/api/health');
    strictEqual(res.status, 429);
    strictEqual(res.body.error.code, 'RATE_LIMITED');
  });

  it('request logging never leaks query secrets (R-PKG-08: sanitizeUrlQuery first)', async () => {
    const logs: unknown[] = [];
    const app2 = createApp({
      config,
      logger: {
        debug: () => {},
        info: (msg: string, meta?: unknown) => logs.push({ msg, meta }),
        warn: () => {},
        error: () => {},
      },
    });
    await request(app2).get('/api/health?token=super-secret');
    const dumped = JSON.stringify(logs);
    strictEqual(dumped.includes('super-secret'), false);
    strictEqual(dumped.includes('/api/health'), true);
  });
});