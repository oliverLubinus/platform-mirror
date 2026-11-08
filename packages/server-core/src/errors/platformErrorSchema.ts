/**
 * Platform error-envelope schema — the MACHINE-CHECKABLE platform truth.
 *
 * The integration contract (§3 "Errors") describes the envelope in prose;
 * this constant is its executable form. Apps do NOT restate this shape in
 * their own words: their OpenAPI spec must contain EXACTLY this schema
 * (deep-equal), asserted by the app's contract-conformance gate. A platform
 * envelope change therefore lands as a package change — and every app's
 * gate goes red in the same bump — never as a hand-synced copy.
 *
 * This is the first conformance artifact; the same pattern extends to the
 * OIDC security scheme, the event envelope (ADR-016), and the DataSource
 * manifest as those gain machine-checkable forms.
 */
export const PLATFORM_ERROR_SCHEMA = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'status'],
      properties: {
        code: {
          type: 'string',
          description: 'Stable machine-readable error code (registry §3)',
          example: 'UNAUTHENTICATED'
        },
        message: { type: 'string' },
        status: { type: 'integer' },
        details: {
          description: 'Optional structured details (sanitized request context, validation info)'
        }
      }
    }
  }
} as const;
