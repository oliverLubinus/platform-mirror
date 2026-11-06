/**
 * @platform/server-core — platform backend baseline (ADR-010 extraction).
 *
 * Ported from the live auth-provider implementation (R-PKG-10: copy →
 * generalize → test → version). LLM-specific mappings stay app-side.
 */

// Error contract
export { ApiError, getErrorStatusAndMessage, buildErrorDetails, hasNestedProperty } from './errors/apiError.js';
export type { ErrorWithStatus, PlatformErrorBody } from './errors/apiError.js';
export {
  PLATFORM_ERROR_CODES,
  defineErrorCodeRegistry,
  ErrorCodeRegistryError
} from './errors/errorCodes.js';
export type { ErrorCodeDescriptor, PlatformErrorCode } from './errors/errorCodes.js';

// Sanitization (no-secrets/tokens/PII in logs — R-PKG-08)
export {
  sanitizeLogMeta,
  sanitizeRequestValue,
  sanitizeRequestHeaders,
  sanitizeUrlQuery,
  sanitizeErrorDetails,
  REQUEST_REDACTED
} from './errors/sanitize.js';

// Event-consumer contract template (ADR-016; referenced by R-CHAT-21, R-AG-12, R-PM-19)
export {
  verifyEventSignature,
  isPlatformEventEnvelope,
  createEventConsumer,
  EVENT_CONSUMER_RESPONSE
} from './events/eventConsumer.js';
export type {
  PlatformEventEnvelope,
  SignatureVerification,
  EventProcessResult,
  EventHandler,
  EventSecretProvider,
  ConsumerHttpResponse
} from './events/eventConsumer.js';

// secretProvider convention (ADR-010 / R-ENV-03)
export { loadSecretFile, loadAppSecrets, SecretProviderError } from './config/provider.js';
export type { AppSecretSpec, AppSecrets } from './config/provider.js';

// Logging contract + zero-dep default implementation (T1.3b)
export { createLogger } from './logging/logger.js';
export type { Logger, LogLevel, LogMeta, StructuredLogEvent, LoggerOptions } from './logging/logger.js';

// Error classifier core (T1.3c) — the Express adapter lives at the
// `@platform/server-core/express` subpath, NOT in this barrel.
export { classifyError, sanitizeDetailsForClient } from './errors/handler.js';
export type { ErrorHandlerContext, ErrorClassification } from './errors/handler.js';
