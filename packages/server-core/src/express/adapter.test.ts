import { deepStrictEqual, strictEqual } from 'node:assert';
import { describe, it } from 'node:test';
import { globalErrorHandler } from './adapter.js';
import { createLogger, type LogMeta, type LogLevel, type Logger } from '../logging/logger.js';
import { ApiError } from '../errors/apiError.js';
import { defineErrorCodeRegistry } from '../errors/errorCodes.js';

/** Minimal mock req/res (no express at runtime — the adapter is types-only). */
interface MockRes {
  statusCode?: number | undefined;
  body?: unknown;
  status(code: number): MockRes;
  json(payload: unknown): MockRes;
}

function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: undefined,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    }
  };
  return res;
}

const req = {
  method: 'POST',
  originalUrl: '/api/projects?state=s3cret',
  body: { title: 'ok', password: 'hunter2' }
} as never;

interface CapturedCall {
  level: LogLevel;
  message: string;
  meta?: LogMeta | undefined;
}

function capturingLogger(): { logger: Logger; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const logger: Logger = {
    debug: (m, meta) => calls.push({ level: 'debug', message: m, meta }),
    info: (m, meta) => calls.push({ level: 'info', message: m, meta }),
    warn: (m, meta) => calls.push({ level: 'warn', message: m, meta }),
    error: (m, meta) => calls.push({ level: 'error', message: m, meta })
  };
  return { logger, calls };
}

const registry = defineErrorCodeRegistry({});

describe('globalErrorHandler (Express adapter)', () => {
  it('branch 1: ApiError → status, platform envelope, level chosen by the classifier', () => {
    const { logger, calls } = capturingLogger();
    const handler = globalErrorHandler({ logger, registry, nodeEnv: 'production' });
    const res = mockRes();
    handler(new ApiError('PM_PROJECT_NOT_FOUND', 'Project not found.', 404), req, res as never, (() => {}) as never);
    strictEqual(res.statusCode, 404);
    deepStrictEqual(res.body, {
      error: { code: 'PM_PROJECT_NOT_FOUND', message: 'Project not found.', status: 404 }
    });
    strictEqual(calls[0]?.level, 'info');
    strictEqual(calls[0]?.meta?.['statusCode'], 404);
    strictEqual(calls[0]?.meta?.['url'], '/api/projects?state=s3cret');
  });

  it('redactedBody flows into the classifier (request body never raw in logs)', () => {
    const { logger, calls } = capturingLogger();
    const handler = globalErrorHandler({ logger, registry, nodeEnv: 'production' });
    const res = mockRes();
    const zodErr = { issues: [{ path: ['name'], message: 'required' }] };
    handler(zodErr, req, res as never, (() => {}) as never);
    strictEqual(res.statusCode, 422);
    strictEqual((res.body as { error: { code: string } }).error.code, 'VALIDATION_FAILED');
    // client details: issues only
    deepStrictEqual((res.body as { error: { details: unknown } }).error.details, {
      issues: [{ path: ['name'], message: 'required' }]
    });
    // server log: redacted body (password stripped), url, cause preserved
    const meta = calls[0]?.meta as Record<string, unknown>;
    const details = meta['details'] as Record<string, unknown>;
    deepStrictEqual(details['redactedBody'], { title: 'ok', password: '[REDACTED]' });
    strictEqual(details['url'], '/api/projects?state=s3cret');
    strictEqual(meta['cause'], zodErr);
    strictEqual(calls[0]?.level, 'warn');
  });

  it('branch 4: fallback never leaks the internal message to the client', () => {
    const { logger, calls } = capturingLogger();
    const handler = globalErrorHandler({ logger, registry, nodeEnv: 'production' });
    const res = mockRes();
    handler(new TypeError('secret db path leaked'), req, res as never, (() => {}) as never);
    strictEqual(res.statusCode, 500);
    deepStrictEqual(res.body, {
      error: { code: 'TYPE_ERROR', message: 'An unexpected error occurred.', status: 500 }
    });
    strictEqual(calls[0]?.level, 'error');
    strictEqual((calls[0]?.message as string).includes('secret db path'), true);
  });

  it('stackTraceMode dev-only: stack in logMeta in development, absent in production', () => {
    const dev = capturingLogger();
    globalErrorHandler({ logger: dev.logger, registry, nodeEnv: 'development' })(
      new ApiError('INTERNAL', 'boom'),
      req,
      mockRes() as never,
      (() => {}) as never
    );
    strictEqual(typeof dev.calls[0]?.meta?.['stack'], 'string');

    const prod = capturingLogger();
    globalErrorHandler({ logger: prod.logger, registry, nodeEnv: 'production' })(
      new ApiError('INTERNAL', 'boom'),
      req,
      mockRes() as never,
      (() => {}) as never
    );
    strictEqual('stack' in (prod.calls[0]?.meta as Record<string, unknown>), false);

    const always = capturingLogger();
    globalErrorHandler({ logger: always.logger, registry, stackTraceMode: 'always' })(
      new ApiError('INTERNAL', 'boom'),
      req,
      mockRes() as never,
      (() => {}) as never
    );
    strictEqual(typeof always.calls[0]?.meta?.['stack'], 'string');
  });

  it('correlation metadata and custom formatters are applied', () => {
    const { logger, calls } = capturingLogger();
    const handler = globalErrorHandler({
      logger,
      registry,
      nodeEnv: 'production',
      getCorrelationMeta: () => ({ requestId: 'r-42' }),
      formatErrorResponse: (errorObj) => ({ error: { ...errorObj, traceId: 't-1' } })
    });
    const res = mockRes();
    handler(new ApiError('FORBIDDEN', 'no', 403), req, res as never, (() => {}) as never);
    strictEqual(calls[0]?.meta?.['requestId'], 'r-42');
    deepStrictEqual(res.body, {
      error: { code: 'FORBIDDEN', message: 'no', status: 403, traceId: 't-1' }
    });
  });

  it('localizeErrorMessage applies to both the log and the client message', () => {
    const { logger, calls } = capturingLogger();
    const handler = globalErrorHandler({
      logger,
      registry,
      nodeEnv: 'production',
      localizeErrorMessage: (message) => `L10N: ${message}`
    });
    const res = mockRes();
    handler(new ApiError('NOT_FOUND', 'not found', 404), req, res as never, (() => {}) as never);
    strictEqual((res.body as { error: { message: string } }).error.message, 'L10N: not found');
    strictEqual(calls[0]?.message, 'L10N: not found');
  });

  it('branch 2 legacy object works end-to-end through the adapter', () => {
    const { logger, calls } = capturingLogger();
    const handler = globalErrorHandler({ logger, registry, nodeEnv: 'production' });
    const res = mockRes();
    handler({ apiError: { code: 'LEGACY_THING', message: 'legacy failure', status: 502 } }, req, res as never, (() => {}) as never);
    strictEqual(res.statusCode, 502);
    deepStrictEqual(res.body, {
      error: { code: 'LEGACY_THING', message: 'legacy failure', status: 502 }
    });
    strictEqual(calls[0]?.level, 'error');
  });
});
