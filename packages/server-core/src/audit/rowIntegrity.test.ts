import { deepStrictEqual, notStrictEqual, strictEqual } from 'node:assert';
import { describe, it } from 'node:test';
import { createRowIntegrity, type LogIntegrityFields } from './rowIntegrity.js';

const integrity = createRowIntegrity('test-hmac-key-material');

describe('createRowIntegrity (GDR-2 port)', () => {
  it('computes a deterministic 64-char hex digest', () => {
    const fields: LogIntegrityFields = {
      action: 'login_success',
      userId: 'u1',
      details: 'ip=1.2.3.4',
      timestamp: '2026-11-06T12:00:00.000Z'
    };
    const digest1 = integrity.computeRowIntegrity('log', 'row-1', fields);
    const digest2 = integrity.computeRowIntegrity('log', 'row-1', fields);
    strictEqual(digest1, digest2);
    strictEqual(digest1.length, 64);
    strictEqual(/^[0-9a-f]{64}$/.test(digest1), true);
  });

  it('field order never changes the digest (sorted-key canonicalization)', () => {
    const a = integrity.computeRowIntegrity('log', 'row-1', {
      action: 'x',
      userId: 'u',
      details: 'd',
      timestamp: 't'
    });
    const b = integrity.computeRowIntegrity('log', 'row-1', {
      details: 'd',
      timestamp: 't',
      userId: 'u',
      action: 'x'
    });
    strictEqual(a, b);
  });

  it('row id inside the payload — a digest cannot be transplanted between rows', () => {
    const fields: LogIntegrityFields = { action: 'x', userId: null, details: 'd', timestamp: 't' };
    const digestRow1 = integrity.computeRowIntegrity('log', 'row-1', fields);
    const digestRow2 = integrity.computeRowIntegrity('log', 'row-2', fields);
    notStrictEqual(digestRow1, digestRow2);
  });

  it('any covered-field change breaks the digest', () => {
    const fields: LogIntegrityFields = { action: 'x', userId: null, details: 'd', timestamp: 't' };
    const original = integrity.computeRowIntegrity('log', 'row-1', fields);
    const changed = integrity.computeRowIntegrity('log', 'row-1', { ...fields, details: 'CHANGED' });
    notStrictEqual(original, changed);
  });

  it('different keys produce different digests (key material matters)', () => {
    const other = createRowIntegrity('different-key');
    const fields: LogIntegrityFields = { action: 'x', userId: null, details: 'd', timestamp: 't' };
    notStrictEqual(integrity.computeRowIntegrity('log', 'row-1', fields), other.computeRowIntegrity('log', 'row-1', fields));
  });
});

describe('verifyRowIntegrity (three-state contract)', () => {
  const fields: LogIntegrityFields = {
    action: 'login_success',
    userId: 'u1',
    details: 'ip=1.2.3.4',
    timestamp: '2026-11-06T12:00:00.000Z'
  };

  it("returns 'verified' when the stored digest matches", () => {
    const digest = integrity.computeRowIntegrity('log', 'row-1', fields);
    strictEqual(integrity.verifyRowIntegrity('log', 'row-1', fields, digest), 'verified');
  });

  it("returns 'tampered' when a covered field changed outside the app", () => {
    const digest = integrity.computeRowIntegrity('log', 'row-1', fields);
    const tamperedFields = { ...fields, details: 'EDITED' };
    strictEqual(integrity.verifyRowIntegrity('log', 'row-1', tamperedFields, digest), 'tampered');
  });

  it("returns 'tampered' for malformed digests", () => {
    strictEqual(integrity.verifyRowIntegrity('log', 'row-1', fields, 'not-hex'), 'tampered');
    strictEqual(integrity.verifyRowIntegrity('log', 'row-1', fields, 'zz'), 'tampered');
  });

  it("returns 'unstamped' for missing/empty digests — soft-fail, NOT an alarm", () => {
    strictEqual(integrity.verifyRowIntegrity('log', 'row-1', fields, null), 'unstamped');
    strictEqual(integrity.verifyRowIntegrity('log', 'row-1', fields, undefined), 'unstamped');
    strictEqual(integrity.verifyRowIntegrity('log', 'row-1', fields, ''), 'unstamped');
  });

  it('user-privilege fields verify the same way', () => {
    const digest = integrity.computeRowIntegrity('user', 'u1', { isAdmin: true, banned: false });
    strictEqual(integrity.verifyRowIntegrity('user', 'u1', { isAdmin: true, banned: false }, digest), 'verified');
    strictEqual(
      integrity.verifyRowIntegrity('user', 'u1', { isAdmin: false, banned: false }, digest),
      'tampered'
    );
  });
});
