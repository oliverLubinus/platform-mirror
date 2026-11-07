/**
 * @file server/src/config.ts
 * @description
 *   Fail-fast environment parsing. The server refuses to start with missing
 *   or malformed configuration — silent fallbacks are how misconfigurations
 *   reach staging (the platform rule: a feature is "done" when it works in
 *   staging, R-ENV-01).
 */

import type { IssuerKey } from '@platform/server-core';

/**
 * Parse the issuer key ring (JWT_SIGNING_KEYS env - the SAME value the
 * issuer deploys with). Fail closed on malformed JSON: a hand-edited or
 * truncated key ring must refuse to start, not degrade to a broken
 * verifier (same discipline as the issuer own parseJwtSigningKeys).
 */
function parseSigningKeys(raw: string | undefined): IssuerKey[] {
  const value = raw ?? process.env['JWT_SIGNING_KEYS'];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('CONFIG_INVALID: JWT_SIGNING_KEYS is required (JSON array of { kid, secret })');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('CONFIG_INVALID: JWT_SIGNING_KEYS is not valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('CONFIG_INVALID: JWT_SIGNING_KEYS must be a non-empty array');
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`CONFIG_INVALID: JWT_SIGNING_KEYS[${index}] is not an object`);
    }
    const { kid, secret } = entry as { kid?: unknown; secret?: unknown };
    if (typeof kid !== 'string' || kid.length === 0 || typeof secret !== 'string' || secret.length === 0) {
      throw new Error(`CONFIG_INVALID: JWT_SIGNING_KEYS[${index}] needs non-empty kid and secret`);
    }
    return { kid, secret };
  });
}

export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  databaseUrl: string;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  auditHmacKey: string;
  /** OIDC issuer URL (ISSUER_URL) - expected iss claim, normalized. */
  issuerUrl: string;
  /** Registered client id - expected aud claim on access tokens. */
  audience: string;
  /** The issuer signing key ring (rotation-aware; shared per environment). */
  jwtSigningKeys: IssuerKey[];
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value === '') {
    throw new Error(`CONFIG_INVALID: missing required environment variable ${key}`);
  }
  return value;
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`CONFIG_INVALID: ${key} must be a positive integer (got ${raw})`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env['NODE_ENV'] ?? 'development';
  if (nodeEnv !== 'development' && nodeEnv !== 'production' && nodeEnv !== 'test') {
    throw new Error(`CONFIG_INVALID: NODE_ENV must be development|production|test (got ${nodeEnv})`);
  }
  return {
    nodeEnv,
    port: int(env, 'PORT', 8080),
    logLevel: (env['LOG_LEVEL'] as AppConfig['logLevel']) ?? 'info',
    databaseUrl: required(env, 'DATABASE_URL'),
    rateLimitMax: int(env, 'RATE_LIMIT_MAX', 300),
    rateLimitWindowMs: int(env, 'RATE_LIMIT_WINDOW_MS', 60000),
    // Dev-only interim; real deploys read the key via the secretProvider
    // convention (R-ENV-03, loadAppSecrets) — see README §Secrets.
    issuerUrl: required(env, 'ISSUER_URL'),
    audience: required(env, 'AUTH_AUDIENCE'),
    jwtSigningKeys: parseSigningKeys(env['JWT_SIGNING_KEYS']),
    auditHmacKey: required(env, 'AUDIT_HMAC_KEY'),
  };
}