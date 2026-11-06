/**
 * Row-integrity digests — ported from auth-provider's live
 * `backend/src/utils/rowIntegrity.ts` (GDR-2 / H-12: tamper evidence, not
 * access control), copy → generalize.
 *
 * Every privileged write stamps a keyed digest (HMAC-SHA-256 over a canonical
 * serialization of the row's security-relevant fields) into the row itself.
 * Readers recompute and compare: any out-of-app edit (direct SQL, rogue
 * script, restored-but-modified backup) no longer matches and is detectable.
 *
 * Generalization from the live module: the HMAC key is INJECTED via the
 * factory instead of imported from config constants — the secretProvider
 * convention (ADR-010 §3) is the standing decision: config composition
 * belongs to the app, the platform module receives the key material.
 *
 * NOT covered (documented residual, as in the live module): deletion-based
 * revocations (row HMACs cannot detect deletion) and plaintext registration/
 * profile fields without privilege semantics. The HMAC key lives outside the
 * DB by construction — a tamperer with DB access cannot forge digests. This
 * buys DETECTION; prevention is delivered by hash-keyed lookups and
 * authenticated encryption in the app layer.
 *
 * Canonicalization: v1 payload — a version tag + table + row id + covered
 * fields, keys serialized in deterministic (sorted) order. Property order can
 * never change the digest; the id is inside the payload so a digest cannot be
 * transplanted between rows; the version tag lets a future field-set change
 * be introduced as v2 with the same semantics as key rotation.
 */

import { createHmac, timingSafeEqual } from 'crypto';

export type IntegrityTable = 'user' | 'log' | 'anchor';
export type IntegrityStatus = 'verified' | 'tampered' | 'unstamped';

/** Privilege fields covered on User rows. */
export interface UserIntegrityFields {
  isAdmin: boolean;
  banned: boolean;
}

/** Fields covered on audit Log rows (timestamp serialized as ISO string). */
export interface LogIntegrityFields {
  action: string;
  userId: string | null;
  details: string | null;
  timestamp: string;
}

/** Fields covered on IntegrityAnchor rows (the audit-trail watermark). */
export interface AnchorIntegrityFields {
  name: string;
  rowCount: number;
  maxTimestamp: string | null;
}

export type RowIntegrityFields = UserIntegrityFields | LogIntegrityFields | AnchorIntegrityFields;

export interface RowIntegrity {
  /** Compute the row-integrity digest for a covered row. */
  computeRowIntegrity(table: IntegrityTable, id: string, fields: RowIntegrityFields): string;
  /**
   * Verify a stored digest against recomputed expectations:
   *  - 'verified': digest present and matches.
   *  - 'tampered': digest present but does NOT match (or is malformed) — the
   *    row's covered fields were changed outside the app (or the key changed).
   *  - 'unstamped': no digest stored (legacy row not yet backfilled) — NOT an
   *    alarm; soft-fail everywhere and let the app's backfill close it.
   */
  verifyRowIntegrity(
    table: IntegrityTable,
    id: string,
    fields: RowIntegrityFields,
    storedDigest: string | null | undefined
  ): IntegrityStatus;
}

/**
 * Deterministic serialization: keys sorted so property order can never
 * change the digest (JSON.stringify with a key-order array).
 */
function canonicalPayload(table: IntegrityTable, id: string, fields: RowIntegrityFields): string {
  const payload: Record<string, unknown> = { id, table, v: 1, ...fields };
  const sortedKeys = Object.keys(payload).sort();
  return JSON.stringify(payload, sortedKeys);
}

/**
 * Build the row-integrity functions bound to one HMAC key material
 * (hex/base64/utf8 secret — from the app's secretProvider).
 */
export function createRowIntegrity(hmacKey: string): RowIntegrity {
  function computeRowIntegrity(table: IntegrityTable, id: string, fields: RowIntegrityFields): string {
    return createHmac('sha256', hmacKey).update(canonicalPayload(table, id, fields)).digest('hex');
  }

  function verifyRowIntegrity(
    table: IntegrityTable,
    id: string,
    fields: RowIntegrityFields,
    storedDigest: string | null | undefined
  ): IntegrityStatus {
    if (storedDigest == null || storedDigest === '') return 'unstamped';
    if (!/^[0-9a-f]{64}$/i.test(storedDigest)) return 'tampered';
    const expected = Buffer.from(computeRowIntegrity(table, id, fields), 'hex');
    const stored = Buffer.from(storedDigest, 'hex');
    if (stored.length !== expected.length) return 'tampered';
    return timingSafeEqual(stored, expected) ? 'verified' : 'tampered';
  }

  return { computeRowIntegrity, verifyRowIntegrity };
}
