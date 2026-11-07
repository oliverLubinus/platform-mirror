/**
 * @file server/src/config.ts
 * @description
 *   Fail-fast environment parsing. The server refuses to start with missing
 *   or malformed configuration — silent fallbacks are how misconfigurations
 *   reach staging (the platform rule: a feature is "done" when it works in
 *   staging, R-ENV-01).
 */

export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  databaseUrl: string;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  auditHmacKey: string;
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
    auditHmacKey: required(env, 'AUDIT_HMAC_KEY'),
  };
}