/**
 * `@agentic-dna/server-core/express` — the Express-facing platform middleware.
 *
 * Types-only module surface: express itself is an OPTIONAL peerDependency
 * (consumers are Express apps by definition); express-rate-limit is an
 * optional peer ONLY for the rate-limiter module. No runtime dependency
 * enters @agentic-dna/server-core itself.
 */

// Error-handler adapter (T1.3c)
export { globalErrorHandler } from './adapter.js';
export type { GlobalErrorHandlerOptions } from './adapter.js';

// Rate-limiting policy wrapper (T1.3d) — express-rate-limit is the audited
// implementation (R-PKG-08); this module owns the platform policy.
export { createRateLimiter, rateLimitHandler } from './rateLimiter.js';
export type { RateLimiterConfig } from './rateLimiter.js';

// Security headers (T1.3d) — ported verbatim from auth-provider H-04.
export { securityHeaders, noStore } from './securityHeaders.js';

// Auth plumbing + requireAuth (T1.3d)
export {
  extractAccessToken,
  getUserId,
  getUserIdOrThrow,
  requireAuth,
  failClosedVerifier
} from './auth.js';
export type { TokenVerifier, VerifiedToken, RequireAuthOptions } from './auth.js';
