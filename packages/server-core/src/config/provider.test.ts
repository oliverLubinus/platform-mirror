import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { describe, it } from 'node:test';
import { writeFileSync, mkdtempSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSecretFile, loadAppSecrets, SecretProviderError } from './provider.js';
import type { AppSecretSpec } from './provider.js';

function tempFileWith(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'platform-secrets-'));
  const filePath = join(dir, 'app.credentials');
  writeFileSync(filePath, contents, 'utf8');
  // POSIX only: NTFS ACLs don't map to POSIX bits; the loader skips the
  // strict mode check on win32 (see provider.ts).
  if (process.platform !== 'win32') {
    chmodSync(filePath, 0o600);
  }
  return filePath;
}

describe('loadSecretFile', () => {
  it('parses KEY=value lines, comments, and export prefixes; trims whitespace', () => {
    const filePath = tempFileWith(
      [
        '# comment line',
        '  KEY_ONE=value-one  ',
        'export KEY_TWO=value-two',
        '',
        '#another comment',
        'KEY_THREE=with=equals'
      ].join('\n')
    );
    deepStrictEqual(loadSecretFile(filePath), {
      KEY_ONE: 'value-one',
      KEY_TWO: 'value-two',
      KEY_THREE: 'with=equals'
    });
  });

  it('throws fail-closed on missing file', () => {
    throws(() => loadSecretFile(join(tmpdir(), 'does-not-exist-xyz')), SecretProviderError);
  });

  it('throws on malformed lines (no "=") and malformed keys', () => {
    throws(() => loadSecretFile(tempFileWith('NO_EQUALS_HERE')), SecretProviderError);
    throws(() => loadSecretFile(tempFileWith('lowercase_key=x')), SecretProviderError);
  });

  it('enforces POSIX mode 600 (skipped on win32 by design)', () => {
    if (process.platform === 'win32') {
      return; // NTFS ACLs — mode check intentionally skipped, see provider.ts
    }
    const dir = mkdtempSync(join(tmpdir(), 'platform-secrets-'));
    const filePath = join(dir, 'loose.credentials');
    writeFileSync(filePath, 'KEY=v\n', 'utf8');
    chmodSync(filePath, 0o644);
    throws(() => loadSecretFile(filePath), SecretProviderError);
  });
});

describe('loadAppSecrets (per-app declaration, fail-closed boot)', () => {
  const SPECS = [
    { name: 'WEBHOOK_SECRET', description: 'ADR-016 webhook HMAC key' },
    { name: 'INTERNAL_ONLY', description: 'prod-only credential', environments: ['production'] as const }
  ] satisfies ReadonlyArray<AppSecretSpec>;

  it('loads all declared credentials present in the file', () => {
    const filePath = tempFileWith('WEBHOOK_SECRET=abc123\nINTERNAL_ONLY=prod-only\n');
    const secrets = loadAppSecrets(SPECS, filePath, 'production');
    strictEqual(secrets.WEBHOOK_SECRET, 'abc123');
    strictEqual(secrets.INTERNAL_ONLY, 'prod-only');
  });

  it('stage-limited declarations are enforced only for their stages', () => {
    const filePath = tempFileWith('WEBHOOK_SECRET=abc123\n');
    // staging: INTERNAL_ONLY is production-only → not required
    const stagingSecrets = loadAppSecrets(SPECS, filePath, 'staging');
    strictEqual(stagingSecrets.WEBHOOK_SECRET, 'abc123');
    // production: missing → hard fail
    throws(
      () => loadAppSecrets(SPECS, filePath, 'production'),
      (err: unknown) => err instanceof SecretProviderError && /INTERNAL_ONLY/.test(String(err))
    );
  });

  it('fails closed when a required declared credential is absent or empty', () => {
    throws(
      () => loadAppSecrets(SPECS, tempFileWith('WEBHOOK_SECRET=\n'), 'production'),
      /missing or empty/
    );
    throws(
      () => loadAppSecrets(SPECS, tempFileWith('# only comments\n'), 'staging'),
      /WEBHOOK_SECRET/
    );
  });

  it('fails closed when the credentials file itself is missing', () => {
    throws(
      () => loadAppSecrets(SPECS, join(tmpdir(), 'no-such-file-abc'), 'staging'),
      SecretProviderError
    );
  });
});
