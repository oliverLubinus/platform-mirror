import { strictEqual, match } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { MissingBrowserStorageError, memoryStorage } from './storage.js';
import { defaultStorage } from './config.js';

/**
 * R-PKG-03 hard rules, enforced STRUCTURALLY over the package source:
 * - no `console.*` (the SDK logs nothing — tokens can therefore never leak
 *   through logs);
 * - no localStorage access at all; no direct sessionStorage API calls
 *   outside storage.ts (the only sanctioned surface, which wraps
 *   `window.sessionStorage` for non-token flow state);
 * - no `document.cookie` access;
 * - no dynamic code execution (`eval`, `new Function`).
 */
const SRC_DIR = fileURLToPath(new URL('.', import.meta.url));
const FORBIDDEN: Array<{ pattern: RegExp; reason: string; allowedIn?: string[] }> = [
  { pattern: /\bconsole\s*\./, reason: 'the SDK must not log (R-PKG-03: no tokens/secrets in logs)' },
  { pattern: /\blocalStorage\b/, reason: 'tokens must never touch localStorage (R-PKG-03)' },
  {
    pattern: /sessionStorage\s*\./,
    reason: 'sessionStorage must only be touched through the storage adapter',
    allowedIn: ['storage.ts'],
  },
  { pattern: /document\s*\.\s*cookie/, reason: 'no direct cookie access from the SDK' },
  { pattern: /\beval\s*\(|new\s+Function\s*\(/, reason: 'no dynamic code execution in a security SDK' },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
}

/** Strip comments so prose mentions ("never in localStorage") don't trip the scan. */
function stripComments(source: string): string {
  return source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('R-PKG-03 source rules', () => {
  for (const rule of FORBIDDEN) {
    it(`forbidden: ${rule.pattern} (${rule.reason})`, () => {
      for (const file of sourceFiles(SRC_DIR)) {
        if (rule.allowedIn?.includes(file)) continue;
        const content = stripComments(readFileSync(join(SRC_DIR, file), 'utf8'));
        strictEqual(
          rule.pattern.test(content),
          false,
          `${file} must not contain ${rule.pattern}`
        );
      }
    });
  }

  it('storage.ts is the ONLY module referencing the sessionStorage surface', () => {
    const files = sourceFiles(SRC_DIR);
    const offenders = files.filter(
      (f) => f !== 'storage.ts' && /sessionStorage/.test(readFileSync(join(SRC_DIR, f), 'utf8'))
    );
    // config.ts mentions it in prose comments only — flag real API usage.
    const realUsage = offenders.filter((f) => {
      const content = stripComments(readFileSync(join(SRC_DIR, f), 'utf8'));
      return /sessionStorage\s*[\.\[]/.test(content);
    });
    strictEqual(realUsage.length, 0, `real sessionStorage usage outside storage.ts: ${realUsage.join(', ')}`);
  });
});

describe('storage fail-fast surface', () => {
  it('MissingBrowserStorageError is a typed AuthError (STORAGE_UNAVAILABLE)', () => {
    const err = new MissingBrowserStorageError();
    strictEqual(err.code, 'STORAGE_UNAVAILABLE');
    match(err.message, /sessionStorage/);
  });

  it('defaultStorage() fails fast without a browser instead of silently degrading', () => {
    // Node test env has no `window` — the default adapter must be the
    // throwing one, so SSR hosts cannot silently lose PKCE state.
    const adapter = defaultStorage();
    strictEqual(adapter instanceof MissingBrowserStorageError, true);
  });

  it('memoryStorage round-trips and its iterator exposes entries', () => {
    const s = memoryStorage();
    s.setItem('a', '1');
    s.setItem('b', '2');
    strictEqual(s.getItem('a'), '1');
    strictEqual(s.getItem('missing'), null);
    deepEqualEntries([...s], [
      ['a', '1'],
      ['b', '2'],
    ]);
    s.removeItem('a');
    strictEqual(s.getItem('a'), null);
  });
});

function deepEqualEntries(actual: [string, string][], expected: [string, string][]): void {
  strictEqual(
    JSON.stringify(actual.sort(([x], [y]) => (x < y ? -1 : 1))),
    JSON.stringify(expected.sort(([x], [y]) => (x < y ? -1 : 1)))
  );
}
