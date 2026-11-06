/**
 * The audit hook (T1.3d — ported from auth-provider's live
 * `backend/src/utils/auditLog.ts` + GDR-2 integrity stamping, copy →
 * generalize).
 *
 * What carries over unchanged:
 *  - THE SINGLE CHOKE POINT: every audit row is stamped with a row-integrity
 *    digest here, covering the whole audit trail. The digest is computed over
 *    the same values being persisted (id + timestamp generated here so a
 *    single write carries a verifiable digest — no second UPDATE per row).
 *  - fail-open (default) vs fail-closed failure modes (env-influenced in the
 *    live module; injectable + env-influenced here).
 *  - belt-and-braces redaction of `details` (auditRedaction) at the choke
 *    point — the logging policy already forbids writing secrets, this is the
 *    second layer.
 *
 * Generalization from the live module: PERSISTENCE IS INJECTED. The live
 * module writes via Prisma directly; the platform version takes a `persist`
 * callback (Prisma insert in app-template, or any append-only store per
 * app). Everything security-relevant — digest stamping, redaction, failure
 * mode, entry shape — stays in this module, so apps can never fork the
 * contract (R-PKG-08 discipline).
 */

import { randomUUID } from 'crypto';
import { createRowIntegrity, type RowIntegrity } from './rowIntegrity.js';
import { redactAuditDetails } from './auditRedaction.js';
import type { Logger } from '../logging/logger.js';

export type AuditFailureMode = 'fail-open' | 'fail-closed';

/** The exact row shape handed to the injected persistence sink. */
export interface AuditEntry {
  id: string;
  action: string;
  userId: string | null;
  /** Redacted by the choke point before persist. */
  details: string;
  /** ISO timestamp (also covered by the integrity digest). */
  timestamp: string;
  /** HMAC-SHA-256 row-integrity digest (GDR-2). */
  integrityHmac: string;
}

export interface AuditLoggerOptions {
  /** HMAC key for row-integrity digests (from the app's secretProvider). */
  hmacKey: string;
  /** Persistence sink — append-only by contract (Prisma insert, file, ...). */
  persist: (entry: AuditEntry) => Promise<void>;
  /** Platform logger for failure reporting. */
  logger: Logger;
  /** Default 'fail-open'; explicit value wins over the env fallback. */
  failureMode?: AuditFailureMode;
}

function resolveFailureMode(explicit?: AuditFailureMode): AuditFailureMode {
  if (explicit) return explicit;
  return process.env.AUDIT_LOG_FAILURE_MODE?.toLowerCase() === 'fail-closed' ? 'fail-closed' : 'fail-open';
}

export interface AuditLogger {
  /**
   * Write one audit entry through the single choke point: redact details,
   * generate id + timestamp, stamp the integrity digest, persist.
   * @param action - Action name (e.g. 'login_success')
   * @param details - Flat `key=value` string (redacted here, not by callers)
   * @param userId - Optional subject id
   */
  logAudit(action: string, details: string, userId?: string): Promise<void>;
}

export function createAuditLogger(options: AuditLoggerOptions): AuditLogger {
  const { hmacKey, persist, logger } = options;
  const integrity: RowIntegrity = createRowIntegrity(hmacKey);

  async function logAudit(action: string, details: string, userId?: string): Promise<void> {
    try {
      const logId = randomUUID();
      const timestamp = new Date();
      const timestampIso = timestamp.toISOString();
      // Belt-and-braces: redact BEFORE the digest is computed so the stored
      // digest always covers the value that is actually persisted.
      const safeDetails = redactAuditDetails(details) ?? '';
      const integrityHmac = integrity.computeRowIntegrity('log', logId, {
        action,
        userId: userId ?? null,
        details: safeDetails,
        timestamp: timestampIso
      });
      await persist({
        id: logId,
        action,
        userId: userId ?? null,
        details: safeDetails,
        timestamp: timestampIso,
        integrityHmac
      });
    } catch (error) {
      const mode = resolveFailureMode(options.failureMode);
      const errorMessage = error instanceof Error ? error.message : 'unknown';
      const meta = {
        action,
        userId,
        mode,
        error: errorMessage,
        // Keep preview short to avoid noisy logs while still aiding diagnosis.
        detailsPreview: details.slice(0, 120)
      };
      if (mode === 'fail-closed') {
        logger.error('Audit log write failed (fail-closed)', meta);
        throw error;
      }
      logger.warn('Audit log write failed; continuing request (fail-open)', meta);
    }
  }

  return { logAudit };
}
