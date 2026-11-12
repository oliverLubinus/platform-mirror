import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { describe, it } from 'node:test';
import { createLogger, type Logger, type StructuredLogEvent } from '../logging/logger.js';
import { cspReportHandler } from './cspReport.js';

type RecordedCall = { message: string; meta?: Record<string, unknown> | undefined };

function mockLogger() {
  const calls: RecordedCall[] = [];
  const logger: Logger = {
    debug: (message, meta) => calls.push({ message, meta }),
    info: (message, meta) => calls.push({ message, meta }),
    warn: (message, meta) => calls.push({ message, meta }),
    error: (message, meta) => calls.push({ message, meta })
  };
  return { calls, logger };
}

function mockReq(overrides: Partial<{ method: string; contentType: string; body: unknown }> = {}) {
  return {
    method: overrides.method ?? 'POST',
    headers: overrides.contentType === undefined ? {} : { 'content-type': overrides.contentType },
    body: overrides.body ?? undefined
  } as never;
}

function mockRes() {
  const state = { statusCode: 0, ended: false };
  const res = {
    setHeader() {
      return res;
    },
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    end() {
      state.ended = true;
      return res;
    }
  };
  return { res: res as never, state };
}

const VALID_REPORT = {
  'document-uri': 'https://pm.staging.agentic-dna.cloud/reports',
  'effective-directive': 'script-src',
  'blocked-uri': 'https://evil.example/evil.js',
  'status-code': '200',
  'source-file': 'https://pm.staging.agentic-dna.cloud/assets/app-abc123.js',
  'line-number': 12,
  'column-number': 34,
  sample: 'eval("x")'
};

function handle(req: { method: string; headers: Record<string, string>; body: unknown }, logger: Logger) {
  const { res, state } = mockRes();
  cspReportHandler({ logger })(req as never, res, (() => undefined) as never);
  return state;
}

describe('cspReportHandler (ADR-021 §3 report-uri drain)', () => {
  it('valid legacy report → 204 + one warn event with normalized fields', () => {
    const { calls, logger } = mockLogger();
    const state = handle(
      { method: 'POST', headers: { 'content-type': 'application/csp-report' }, body: { 'csp-report': VALID_REPORT } },
      logger
    );
    strictEqual(state.statusCode, 204);
    strictEqual(state.ended, true);
    strictEqual(calls.length, 1);
    strictEqual(calls[0]?.message, 'csp-violation');
    deepStrictEqual(calls[0]?.meta, {
      documentUri: 'https://pm.staging.agentic-dna.cloud/reports',
      effectiveDirective: 'script-src',
      blockedUri: 'https://evil.example/evil.js',
      statusCode: '200',
      sourceFile: 'https://pm.staging.agentic-dna.cloud/assets/app-abc123.js',
      lineNumber: 12,
      columnNumber: 34,
      sample: 'eval("x")'
    });
  });

  it('valid flat Reporting-API style JSON → 204 + logged', () => {
    const { calls, logger } = mockLogger();
    const state = handle(
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: { 'document-uri': 'https://pm.staging.agentic-dna.cloud/', 'effective-directive': 'style-src' }
      },
      logger
    );
    strictEqual(state.statusCode, 204);
    strictEqual(calls.length, 1);
    strictEqual(calls[0]?.message, 'csp-violation');
    strictEqual(calls[0]?.meta?.documentUri, 'https://pm.staging.agentic-dna.cloud/');
  });

  it('malformed body (no string document-uri) → 400, nothing logged', () => {
    for (const body of [undefined, null, 'not-an-object', 42, [], {}, { 'csp-report': {} }, { 'document-uri': 7 }]) {
      const { calls, logger } = mockLogger();
      const state = handle({ method: 'POST', headers: { 'content-type': 'application/json' }, body }, logger);
      strictEqual(state.statusCode, 400, `body=${JSON.stringify(body)}`);
      strictEqual(calls.length, 0);
    }
  });

  it('wrong content type → 415, body never logged', () => {
    for (const contentType of ['text/plain', 'application/xml', undefined]) {
      const { calls, logger } = mockLogger();
      const state = handle(
        { method: 'POST', headers: contentType === undefined ? {} : { 'content-type': contentType }, body: VALID_REPORT },
        logger
      );
      strictEqual(state.statusCode, 415, `content-type=${contentType}`);
      strictEqual(calls.length, 0);
    }
    // charset parameter on an accepted type is fine
    const { calls, logger } = mockLogger();
    const state = handle(
      {
        method: 'POST',
        headers: { 'content-type': 'application/csp-report; charset=utf-8' },
        body: { 'csp-report': VALID_REPORT }
      },
      logger
    );
    strictEqual(state.statusCode, 204);
    strictEqual(calls.length, 1);
  });

  it('non-POST methods → 405, nothing logged', () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const { calls, logger } = mockLogger();
      const state = handle({ method, headers: { 'content-type': 'application/json' }, body: {} }, logger);
      strictEqual(state.statusCode, 405, method);
      strictEqual(calls.length, 0);
    }
  });

  it('oversize report → 413 + bounded marker log; report content NOT logged', () => {
    const { calls, logger } = mockLogger();
    const bigSample = 'x'.repeat(20 * 1024);
    const state = handle(
      {
        method: 'POST',
        headers: { 'content-type': 'application/csp-report' },
        body: { 'csp-report': { ...VALID_REPORT, sample: bigSample } }
      },
      logger
    );
    strictEqual(state.statusCode, 413);
    strictEqual(calls.length, 1);
    strictEqual(calls[0]?.message, 'csp-violation-rejected-oversize');
    ok(typeof calls[0]?.meta?.bytes === 'number');
    strictEqual(JSON.stringify(calls).includes(bigSample), false);
  });

  it('long string fields are capped before logging', () => {
    const { calls, logger } = mockLogger();
    const longSample = 'a'.repeat(5000);
    const state = handle(
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: { 'document-uri': 'https://x.test/', sample: longSample }
      },
      logger
    );
    strictEqual(state.statusCode, 204);
    strictEqual((calls[0]?.meta?.sample as string).length, 512);
  });

  it('integrates with the real createLogger contract (ADR-011 pipe shape)', () => {
    const events: StructuredLogEvent[] = [];
    const logger = createLogger({ enableConsole: false, sinks: [(event) => events.push(event)] });
    const state = handle(
      { method: 'POST', headers: { 'content-type': 'application/csp-report' }, body: { 'csp-report': VALID_REPORT } },
      logger
    );
    strictEqual(state.statusCode, 204);
    strictEqual(events.length, 1);
    strictEqual(events[0]?.message, 'csp-violation');
    ok(typeof events[0]?.timestamp === 'string');
  });
});
