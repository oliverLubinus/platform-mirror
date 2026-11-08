/**
 * @file server/src/errorCodes.test.ts
 * @description
 *   T3.2: the error-code registry LINT (R-PKG-07) — CI enforcement that
 *   grows from T1.3's runtime check. `defineErrorCodeRegistry` already
 *   throws on collisions/UPPER_SNAKE/status violations at construction
 *   (the runtime foundation); this test extends the invariant to the API
 *   surface: every error code EMITTED by app source must exist in the
 *   merged registry (platform base map + app contributions), and every
 *   emitted envelope status must match the registry. A typo'd code (e.g.
 *   VALIDATION_ERROR vs the base VALIDATION_FAILED) can no longer ship.
 *
 *   Scan scope: every TypeScript file under server/src EXCLUDING test files
 *   and the generated Prisma client — app surface only, exactly what the
 *   registry governs.
 */
import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORM_ERROR_CODES } from '@platform/server-core';
import { errorCodes } from './errors/errorCodes.js';

const here = join(fileURLToPath(import.meta.url), '..');

/** Collect app-source files (not tests, not the generated Prisma client). */
function collect(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === 'generated') continue; // generated client is NOT app surface
      collect(p, acc);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      acc.push(p);
    }
  }
  return acc;
}

const sources = collect(here);

describe('error-code registry lint (T3.2: R-PKG-07 collision check in CI)', () => {
  it('the app registry builds against the platform base map (runtime collision check, T1.3)', () => {
    // Construction itself throws on UPPER_SNAKE violations, invalid statuses,
    // and duplicates vs the base map — importing errorCodes IS the check.
    ok(Object.isFrozen(errorCodes), 'the merged registry must be frozen');
    for (const [key, descriptor] of Object.entries(PLATFORM_ERROR_CODES)) {
      const merged = errorCodes[key];
      ok(merged, `platform base code ${key} missing from the merged registry`);
      strictEqual(merged.code, descriptor.code, `base code drift on ${key}`);
      strictEqual(merged.status, descriptor.status, `base status drift on ${key}`);
    }
  });

  it('every error code emitted in app source is registered (no silent typos)', () => {
    const offenders: string[] = [];
    // envelope literal: code: 'SOME_CODE'   |   throw new ApiError('SOME_CODE', ...)
    const codeRe = /(?:code:\s*|ApiError\(\s*)'([A-Z][A-Z0-9_]*)'/g;
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(codeRe)) {
        const code = m[1]!;
        if (!(code in errorCodes)) offenders.push(`${code} in ${file.replace(here, 'server/src')}`);
      }
    }
    strictEqual(offenders.length, 0, `unregistered error codes (add to server/src/errors/errorCodes.ts or use the platform base map):\n  ${offenders.join('\n  ')}`);
  });

  it('emitted envelope statuses match the registry (no silent status drift)', () => {
    const offenders: string[] = [];
    // single-line envelope shape used by the handlers:
    // { error: { code: 'X', message: '...', status: NNN } }
    const envRe = /code:\s*'([A-Z][A-Z0-9_]*)',\s*message:[^}]*?status:\s*(\d{3})/g;
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(envRe)) {
        const descriptor = errorCodes[m[1]!];
        if (descriptor && descriptor.status !== Number(m[2])) {
          offenders.push(
            `${m[1]} emitted with status ${m[2]}, registry says ${descriptor.status} (${file.replace(here, 'server/src')})`
          );
        }
      }
    }
    strictEqual(offenders.length, 0, offenders.length ? offenders.join('; ') : 'placeholder-never-empty');
  });
});
