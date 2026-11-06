/**
 * secretProvider convention — the per-app secrets-management interface
 * (ADR-010 / R-ENV-03). Module file is `config/provider.ts` (matching
 * auth-provider's live layout); the architectural name stays
 * "secretProvider" in docs/AGENTS.md.
 *
 * Ported from auth-provider's live secret-boot discipline (copy →
 * generalize). Three designs carry over:
 *
 *  1. **Fail-closed at process start** — a missing/unreadable/mis-permissioned
 *     credentials file aborts boot; nothing half-configured ever serves traffic.
 *  2. **Per-app secret declaration** (`loadAppSecrets` / `AppSecretSpec`) —
 *     services declare WHICH credentials they use; boot fails if any declared
 *     entry is absent, and code consumes only the typed map. The decision
 *     backlog (§3, Q9) deferred the *product* choice (Vault/etc.) — this
 *     interface is the decision that stands; swapping the backing store
 *     later changes only this module.
 *  3. **Single source of truth** — one tool-managed file outside VCS with
 *     mode 600; `.env`-style, one entry per line. Nothing else reads
 *     process.env for credential values.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';

/** Thrown when the credentials file is missing, unreadable, mis-permissioned, or a declared entry is absent. */
export class SecretProviderError extends Error {}

/** Declares one credential an app needs (machine-readable inventory). */
export interface AppSecretSpec {
  /** Credentials-file key (UPPER_SNAKE, e.g. `AUTH_PROVIDER_JWT_PRIVATE_KEY`). */
  readonly name: string;
  /** What the credential protects — never its value, only its purpose. */
  readonly description: string;
  /** Which environment stages require it (defaults to all). */
  readonly environments?: ReadonlyArray<'development' | 'staging' | 'production'>;
}

/** The typed credential map an app's boot code consumes. */
export type AppSecrets<TSpecs extends ReadonlyArray<AppSecretSpec>> = {
  readonly [K in TSpecs[number]['name']]: string;
};

/**
 * Standard credentials-file loader. Reads the given path, requires mode 600,
 * and parses one `KEY=value` per line (trim whitespace, ignore `#`
 * comments, accept `export KEY=`; no shell interpretation, no quote
 * stripping — values are taken literally).
 */
export function loadSecretFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) {
    throw new SecretProviderError(`Credentials file "${filePath}" does not exist — boot failed (fail-closed).`);
  }
  const mode = statSync(filePath).mode & 0o777;
  // POSIX-exact 600 enforcement; on win32 NTFS ACLs don't map to POSIX bits
  // (Node reports 0o666 for writable files), so the strict check would
  // misfire on Windows dev machines. Linux containers/CI enforce it fully.
  if (process.platform !== 'win32' && mode !== 0o600) {
    throw new SecretProviderError(
      `Credentials file "${filePath}" has mode ${mode.toString(8)} — must be 600. Fix permissions and re-run.`
    );
  }
  const secrets: Record<string, string> = {};
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = normalized.indexOf('=');
    if (eq === -1) {
      throw new SecretProviderError(`Malformed line (no "="): "${line.slice(0, 20)}…"`);
    }
    const key = normalized.slice(0, eq).trim();
    const value = normalized.slice(eq + 1);
    if (key.length === 0 || !/^[A-Z][A-Z0-9_]*$/.test(key)) {
      throw new SecretProviderError(`Malformed key: "${key}" (expected UPPER_SNAKE).`);
    }
    secrets[key] = value;
  }
  return secrets;
}

/**
 * Load the app's declared credentials from the credentials file, returning a
 * fully typed map. Boot fails closed if the file is absent, mis-permissioned,
 * or any entry declared for the current environment is missing.
 *
 * @param specs - the app's credential declaration (compile-time constant)
 * @param filePath - resolved credentials-file path (tool-managed, outside VCS)
 * @param environment - current stage; specs with `environments` limits are
 *   enforced only for listed stages
 */
export function loadAppSecrets<TSpecs extends ReadonlyArray<AppSecretSpec>>(
  specs: TSpecs,
  filePath: string,
  environment: 'development' | 'staging' | 'production'
): AppSecrets<TSpecs> {
  const raw = loadSecretFile(filePath);
  const result: Record<string, string> = {};
  for (const spec of specs) {
    const appliesToStage = spec.environments ? spec.environments.includes(environment) : true;
    if (!appliesToStage) {
      continue;
    }
    const value = raw[spec.name];
    if (value === undefined || value.length === 0) {
      throw new SecretProviderError(
        `Declared credential "${spec.name}" (${spec.description}) is missing or empty in "${filePath}" — boot failed (fail-closed).`
      );
    }
    result[spec.name] = value;
  }
  return result as AppSecrets<TSpecs>;
}
