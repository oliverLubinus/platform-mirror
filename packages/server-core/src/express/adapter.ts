/**
 * Express adapter for the platform error classifier (T1.3c).
 *
 * Import via the `@platform/server-core/express` subpath. This module has
 * NO express runtime dependency — it only uses express types (consumers
 * already have express; `@types/express` is a dev-time concern for this
 * package). The middleware delegates every decision to `classifyError`
 * (the tested, framework-agnostic core) and only performs the framework
 * wiring: extract request context, compute the stack gate, log, respond.
 *
 * Mount as the LAST middleware:
 *   app.use(globalErrorHandler({ logger, registry: ERROR_CODES }));
 *
 * Correlation/observability metadata (ADR-011: `getCorrelationMeta`,
 * `getOutcome`) is injectable — the observability module ports separately.
 */

import type { NextFunction, Request, Response } from 'express';
import type { Logger } from '../logging/logger.js';
import { classifyError } from '../errors/handler.js';
import { sanitizeRequestValue } from '../errors/sanitize.js';
import type { ErrorCodeDescriptor } from '../errors/errorCodes.js';

export interface GlobalErrorHandlerOptions {
  /** Any platform `Logger` (e.g. from `createLogger`). */
  logger: Logger;
  /** Stack-trace gate for server-side logs (default 'dev-only'). */
  stackTraceMode?: 'always' | 'never' | 'dev-only';
  /** App error-code registry — enables registry-driven status lookup. */
  registry?: Readonly<Record<string, ErrorCodeDescriptor>>;
  /** Injected correlation metadata (ADR-011 observability seam). */
  getCorrelationMeta?: (req: Request, res: Response) => Record<string, unknown>;
  /** Custom response formatter; receives the envelope's error object. */
  formatErrorResponse?: (
    errorObj: Record<string, unknown>,
    status: number,
    req: Request
  ) => Record<string, unknown>;
  /** Optional localization hook for client-facing messages. */
  localizeErrorMessage?: (message: string, req: Request) => string;
  /** Injectable environment for the dev-only default (test determinism). */
  nodeEnv?: string;
}

/**
 * Express error-handling middleware factory — same ergonomic shape as
 * auth-provider's, backed by the tested platform classifier.
 */
export function globalErrorHandler(options: GlobalErrorHandlerOptions) {
  const {
    logger,
    stackTraceMode = 'dev-only',
    registry,
    getCorrelationMeta,
    formatErrorResponse,
    localizeErrorMessage,
    nodeEnv = process.env.NODE_ENV || 'development'
  } = options;
  const showStack =
    stackTraceMode === 'always' ? true : stackTraceMode === 'never' ? false : nodeEnv === 'development';

  return function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
    const correlationMeta = getCorrelationMeta ? getCorrelationMeta(req, res) : {};
    const classification = classifyError(err, {
      method: req.method,
      url: req.originalUrl,
      redactedBody: sanitizeRequestValue((req as { body?: unknown }).body),
      showStack,
      ...(registry ? { registry } : {})
    });

    let logMessage = classification.logMessage;
    let responseBody = classification.responseBody;
    if (localizeErrorMessage) {
      logMessage = localizeErrorMessage(logMessage, req);
      responseBody = {
        error: { ...responseBody.error, message: localizeErrorMessage(responseBody.error.message, req) }
      };
    }

    const logMeta: Record<string, unknown> = {
      ...correlationMeta,
      method: req.method,
      url: req.originalUrl,
      statusCode: classification.status,
      ...(classification.stack ? { stack: classification.stack } : {}),
      ...(classification.logDetails !== undefined ? { details: classification.logDetails } : {}),
      ...(classification.cause !== undefined ? { cause: classification.cause } : {})
    };
    logger[classification.logLevel](logMessage, logMeta);

    const response = formatErrorResponse
      ? formatErrorResponse(responseBody.error as unknown as Record<string, unknown>, classification.status, req)
      : responseBody;
    res.status(classification.status).json(response);
  };
}
