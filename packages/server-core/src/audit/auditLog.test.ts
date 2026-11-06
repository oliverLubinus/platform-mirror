import { deepStrictEqual, strictEqual, rejects } from 'node:assert';
import { describe, it } from 'node:test';
import { createAuditLogger, type AuditEntry } from './auditLog.js';
import { createRowIntegrity } from './rowIntegrity.js';
import { createLogger } from '../logging/logger.js';

const HMAC_KEY = 'audit-test-key';
const integrity = createRowIntegrity(HMAC_KEY);

/** Logger that captures calls without console noise. */
function quietLogger() {
  const calls: Array<{ level: string; message: string; meta?: Record<string, unknown> | undefined }> = [];
  const logger = createLogger({
    enableConsole: false,
    sinks: [(event) => calls.push({ level: event.level, message: event.message, meta: event.meta })]
  });
  return { logger, calls };
}

describe('createAuditLogger (the single choke point — T1.3d port)', () => {
  it('stamps every row with a verifiable GDR-2 integrity digest', async () => {
    const persisted: AuditEntry[] = [];
    const { logger } = quietLogger();
    const audit = createAuditLogger({
      hmacKey: HMAC_KEY,
      persist: async (entry) => {
        persisted.push(entry);
      },
      logger
    });
    await audit.logAudit('login_success', 'ip=1.2.3.4', 'u1');
    strictEqual(persisted.length, 1);
    const entry = persisted[0] as AuditEntry;
    strictEqual(entry.action, 'login_success');
    strictEqual(entry.userId, 'u1');
    strictEqual(typeof entry.timestamp, 'string');
    // The stored digest recomputes against the SAME values persisted — a
    // single write carries a verifiable digest.
    strictEqual(
      integrity.verifyRowIntegrity('log', entry.id, {
        action: entry.action,
        userId: entry.userId,
        details: entry.details,
        timestamp: entry.timestamp
      }, entry.integrityHmac),
      'verified'
    );
  });

  it('redacts details BEFORE computing the digest (belt-and-braces, ABE-5)', async () => {
    const persisted: AuditEntry[] = [];
    const { logger } = quietLogger();
    const audit = createAuditLogger({
      hmacKey: HMAC_KEY,
      persist: async (entry) => {
        persisted.push(entry);
      },
      logger
    });
    await audit.logAudit('token_grant', 'user_id=u1, refresh_token=secret-value');
    const entry = persisted[0] as AuditEntry;
    strictEqual(entry.details.includes('secret-value'), false);
    deepStrictEqual(entry.details, 'user_id=u1, refresh_token=[REDACTED]');
    // The digest covers the REDACTED value actually persisted.
    strictEqual(
      integrity.verifyRowIntegrity('log', entry.id, {
        action: entry.action,
        userId: entry.userId,
        details: entry.details,
        timestamp: entry.timestamp
      }, entry.integrityHmac),
      'verified'
    );
  });

  it('fail-open (default): a persist failure warns and does NOT throw', async () => {
    const { logger, calls } = quietLogger();
    const audit = createAuditLogger({
      hmacKey: HMAC_KEY,
      persist: async () => {
        throw new Error('db down');
      },
      logger
    });
    // must not throw
    await audit.logAudit('login_success', 'ip=1.2.3.4', 'u1');
    const warn = calls.find((c) => c.level === 'warn');
    strictEqual(warn?.message, 'Audit log write failed; continuing request (fail-open)');
    deepStrictEqual(warn?.meta, {
      action: 'login_success',
      userId: 'u1',
      mode: 'fail-open',
      error: 'db down',
      detailsPreview: 'ip=1.2.3.4'
    });
  });

  it('fail-closed: a persist failure logs at error and RETHROWS', async () => {
    const { logger, calls } = quietLogger();
    const audit = createAuditLogger({
      hmacKey: HMAC_KEY,
      persist: async () => {
        throw new Error('db down');
      },
      logger,
      failureMode: 'fail-closed'
    });
    await rejects(() => audit.logAudit('login_success', 'x', 'u1'), /db down/);
    const err = calls.find((c) => c.level === 'error');
    strictEqual(err?.message, 'Audit log write failed (fail-closed)');
    strictEqual((err?.meta as Record<string, unknown>)['mode'], 'fail-closed');
  });

  it('AUDIT_LOG_FAILURE_MODE env: fail-closed wins over the default (ported env behavior)', async () => {
    const previous = process.env.AUDIT_LOG_FAILURE_MODE;
    try {
      process.env.AUDIT_LOG_FAILURE_MODE = 'fail-closed';
      const { logger } = quietLogger();
      const audit = createAuditLogger({
        hmacKey: HMAC_KEY,
        persist: async () => {
          throw new Error('boom');
        },
        logger
      });
      await rejects(() => audit.logAudit('a', 'b'), /boom/);
    } finally {
      if (previous === undefined) {
        delete process.env.AUDIT_LOG_FAILURE_MODE;
      } else {
        process.env.AUDIT_LOG_FAILURE_MODE = previous;
      }
    }
  });

  it('explicit failureMode wins over the env', async () => {
    const previous = process.env.AUDIT_LOG_FAILURE_MODE;
    try {
      process.env.AUDIT_LOG_FAILURE_MODE = 'fail-closed';
      const { logger } = quietLogger();
      const audit = createAuditLogger({
        hmacKey: HMAC_KEY,
        persist: async () => {
          throw new Error('boom');
        },
        logger,
        failureMode: 'fail-open'
      });
      await audit.logAudit('a', 'b'); // does not throw
    } finally {
      if (previous === undefined) {
        delete process.env.AUDIT_LOG_FAILURE_MODE;
      } else {
        process.env.AUDIT_LOG_FAILURE_MODE = previous;
      }
    }
  });

  it('generates a fresh UUID id per entry (no id reuse)', async () => {
    const persisted: AuditEntry[] = [];
    const { logger } = quietLogger();
    const audit = createAuditLogger({ hmacKey: HMAC_KEY, persist: async (e) => { persisted.push(e); }, logger });
    await audit.logAudit('a', 'b');
    await audit.logAudit('a', 'b');
    strictEqual(persisted[0]?.id !== persisted[1]?.id, true);
  });
});
