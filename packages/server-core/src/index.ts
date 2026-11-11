/**
 * @agentic-dna/server-core — platform backend baseline (ADR-010 extraction).
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
// `@agentic-dna/server-core/express` subpath, NOT in this barrel.
export { classifyError, sanitizeDetailsForClient } from './errors/handler.js';
export type { ErrorHandlerContext, ErrorClassification } from './errors/handler.js';

// Audit hook (T1.3d): single choke point, GDR-2 row-integrity stamping,
// ABE-5 redaction, fail-open/fail-closed. Persistence is injected.
export { createAuditLogger } from './audit/auditLog.js';
export type { AuditEntry, AuditFailureMode, AuditLogger, AuditLoggerOptions } from './audit/auditLog.js';
export { createRowIntegrity } from './audit/rowIntegrity.js';
export type {
  RowIntegrity,
  IntegrityTable,
  IntegrityStatus,
  RowIntegrityFields,
  UserIntegrityFields,
  LogIntegrityFields,
  AnchorIntegrityFields
} from './audit/rowIntegrity.js';
export { redactAuditDetails } from './audit/auditRedaction.js';

// Real access-token verifier (T1.5c) - HS256 key-ring verification of
// auth-provider-issued JWTs; replaces the fail-closed default verifier.
export {
  createTokenVerifier
} from './tokenVerifier.js';
export type { IssuerKey, TokenVerifierConfig } from './tokenVerifier.js';

// Platform contract artifacts (machine-checkable platform truth). Apps
// ASSERT conformance against these — they never restate the contract
// (no two truths; drift fails the app's own gate at build time).
export { PLATFORM_ERROR_SCHEMA } from './errors/platformErrorSchema.js';


