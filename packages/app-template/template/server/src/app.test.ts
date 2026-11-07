/**
 * @file server/src/app.test.ts
 * @description
 *   Platform-wiring tests for the app factory. DB-free - these prove the
 *   PLATFORM contract (headers, envelope, rate limiting, auth, manifest
 *   mounting), not business logic. DB-backed routes get integration tests
 *   against the compose Postgres (contract CI job, R-PKG-11).
 *
 *   T1.5c: the REAL HS256 verifier is exercised - a validly signed token
 *   from the issuer key ring passes; a bad signature, wrong issuer, or
 *   wrong audience fails closed with the platform envelope (no leak).
 */
import { describe, it, beforeEach } from 'node:test';
import { createHmac } from 'node:crypto';
import { strictEqual } from 'node:assert';
import express from 'express';
import request from 'supertest';
import { type AppConfig } from './config.js';
import { createApp } from './app.js';
import { createTokenVerifier } from '@platform/server-core';
import type { NotesStore } from './routes/notes.js';

const config: AppConfig = {
  nodeEnv: 'test',
  port: 8080,
  logLevel: 'error',
  databaseUrl: 'postgresql://app:app@localhost:54329/app',
  rateLimitMax: 300,
  rateLimitWindowMs: 60000,
  auditHmacKey: 'test-only-not-a-secret',
  issuerUrl: 'https://auth.example.com',
  audience: 'app-template',
  jwtSigningKeys: [{ kid: 'test-key-1', secret: 'test-only-signing-key-not-a-secret' }],
};

const memoryStore: NotesStore = {
  list: async () => [
    { id: 'note-1', title: 'First', body: 'Body', createdAt: new Date('2025-01-01T00:00:00Z'), updatedAt: new Date('2025-01-01T00:00:00Z') },
  ],
  create: async (input) => ({
    id: 'note-2',
    title: input.title,
    body: input.body,
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
};

const testVerifier = createTokenVerifier({
  keys: config.jwtSigningKeys,
  issuer: config.issuerUrl,
  audience: config.audience,
});

function b64url(input: object | string): string {
  return Buffer.from(typeof input === 'string' ? input : JSON.stringify(input)).toString('base64url');
}

function signToken(
  payload: Record<string, unknown>,
  kid: string,
  secret: string
): string {
  const header = { alg: 'HS256', typ: 'JWT', kid };
  const h = b64url(header);
  const p = b64url(payload);
  const sig = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

const bearer = (token: string): string => `Bearer ${token}`;

describe('platform wiring (server-core pre-wired, R-PKG-09)', () => {
  let app: express.Express;
  beforeEach(() => {
    app = createApp({ config, db: memoryStore });
  });

  it('GET /api/health -> 200, no-store, security headers present', async () => {
    const res = await request(app).get('/api/health');
    strictEqual(res.status, 200);
    strictEqual(res.body.ok, true);
    strictEqual(res.headers['x-content-type-options'], 'nosniff');
    strictEqual(res.headers['x-frame-options'], 'DENY');
    strictEqual(res.headers['cache-control'], 'no-store');
  });

  it('unknown route -> 404 in the platform envelope shape', async () => {
    const res = await request(app).get('/api/nope');
    strictEqual(res.status, 404);
    strictEqual(res.body.error.code, 'NOT_FOUND');
    strictEqual(res.body.error.status, 404);
  });

  it('protected route with NO token -> 401 envelope', async () => {
    const res = await request(app).get('/api/notes');
    strictEqual(res.status, 401);
    strictEqual(res.body.error.code, 'UNAUTHENTICATED');
  });

  it('protected route with a VALIDLY SIGNED token from the issuer key ring -> 200 (real verifier)', async () => {
    const token = signToken(
      { sub: 'user-1', iss: config.issuerUrl, aud: config.audience, exp: Math.floor(Date.now() / 1000) + 3600 },
      'test-key-1',
      config.jwtSigningKeys[0]!.secret
    );
    const claims = await testVerifier(token); // verifier accepts what the issuer signed
    strictEqual(claims.sub, 'user-1');
    const res = await request(app).get('/api/notes').set('authorization', bearer(token));
    strictEqual(res.status, 200);
    strictEqual(res.body.notes.length, 1);
    strictEqual(res.body.notes[0].title, 'First');
  });

  it('protected route with a WRONG SIGNATURE -> 401 fail-closed (no leak)', async () => {
    const token = signToken(
      { sub: 'user-1', iss: config.issuerUrl, aud: config.audience, exp: Math.floor(Date.now() / 1000) + 3600 },
      'test-key-1',
      'attacker-key-not-in-the-ring'
    );
    const res = await request(app).get('/api/notes').set('authorization', bearer(token));
    strictEqual(res.status, 401);
    strictEqual(res.body.error.code, 'UNAUTHENTICATED');
  });

  it('protected route with a WRONG ISSUER -> 401 fail-closed', async () => {
    const token = signToken(
      { sub: 'user-1', iss: 'https://evil.example', aud: config.audience, exp: Math.floor(Date.now() / 1000) + 3600 },
      'test-key-1',
      config.jwtSigningKeys[0]!.secret
    );
    const res = await request(app).get('/api/notes').set('authorization', bearer(token));
    strictEqual(res.status, 401);
    strictEqual(res.body.error.code, 'UNAUTHENTICATED');
  });

  it('protected route with a WRONG AUDIENCE -> 401 fail-closed', async () => {
    const token = signToken(
      { sub: 'user-1', iss: config.issuerUrl, aud: 'other-app', exp: Math.floor(Date.now() / 1000) + 3600 },
      'test-key-1',
      config.jwtSigningKeys[0]!.secret
    );
    const res = await request(app).get('/api/notes').set('authorization', bearer(token));
    strictEqual(res.status, 401);
    strictEqual(res.body.error.code, 'UNAUTHENTICATED');
  });

  it('protected route with a MALFORMED token -> 401 fail-closed (no leak)', async () => {
    const res = await request(app).get('/api/notes').set('authorization', bearer('not-a-jwt'));
    strictEqual(res.status, 401);
    strictEqual(res.body.error.code, 'UNAUTHENTICATED');
  });

  it('rate limiter is wired (429 envelope under load)', async () => {
    const tight = createApp({
      config: { ...config, rateLimitMax: 3, rateLimitWindowMs: 60000 },
      db: memoryStore,
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
      db: memoryStore,
    });
    await request(app2).get('/api/health?token=super-secret');
    const dumped = JSON.stringify(logs);
    strictEqual(dumped.includes('super-secret'), false);
    strictEqual(dumped.includes('/api/health'), true);
  });
});