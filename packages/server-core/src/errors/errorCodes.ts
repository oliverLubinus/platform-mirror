/**
 * Platform error-code registry.
 *
 * Evolved from auth-provider's `backend/src/utils/errorCodes.ts` closed
 * union into an open-world registry: the platform ships the base map from
 * the integration contract (§3 "Errors" — codes EVERY app must support),
 * and each app contributes its own codes via `defineErrorCodeRegistry`.
 *
 * R-PKG-07: "platform base map + app contributions" — the duplicate check
 * here is the runtime foundation of the T3.2 CI lint (collision between
 * app codes must fail loudly, never silently alias).
 *
 * LLM-specific error mapping (getLlmErrorCode / LlmErrorContext) is
 * deliberately NOT ported: per ADR-010/R-PKG-10 extraction discipline it
 * stays app-side until a second consumer justifies generalization.
 */

/** Descriptor for one error code: stable code string + HTTP status + user-facing description. */
export interface ErrorCodeDescriptor {
  readonly code: string;
  readonly status: number;
  readonly description: string;
}

/**
 * Platform base map — the codes every platform app must support
 * (integration contract §3). Consumers may rely on these existing and
 * carrying these statuses.
 */
export const PLATFORM_ERROR_CODES = {
  UNAUTHENTICATED: { code: 'UNAUTHENTICATED', status: 401, description: 'Authentication required or failed.' },
  FORBIDDEN: { code: 'FORBIDDEN', status: 403, description: 'The caller lacks the required permission.' },
  NOT_FOUND: { code: 'NOT_FOUND', status: 404, description: 'The requested resource does not exist.' },
  VALIDATION_FAILED: { code: 'VALIDATION_FAILED', status: 422, description: 'The request payload failed validation.' },
  RATE_LIMITED: { code: 'RATE_LIMITED', status: 429, description: 'Too many requests — slow down.' },
  INTERNAL: { code: 'INTERNAL', status: 500, description: 'Internal server error.' }
} as const satisfies Record<string, ErrorCodeDescriptor>;

export type PlatformErrorCode = (typeof PLATFORM_ERROR_CODES)[keyof typeof PLATFORM_ERROR_CODES]['code'];

/** Thrown by `defineErrorCodeRegistry` on any registration problem (fail-fast, CI-visible). */
export class ErrorCodeRegistryError extends Error {}

/**
 * Merge app-specific codes with the platform base map into a frozen,
 * collision-checked registry.
 *
 * Rules:
 * - A code string may exist only ONCE across base + contributions.
 * - Codes must be UPPER_SNAKE (naming discipline for the cross-app catalog).
 * - Statuses must be valid HTTP statuses (400–599).
 *
 * @param appContributions - the app's own codes (e.g. PM_PROJECT_NOT_FOUND)
 * @returns frozen merged registry keyed by the CONSTANT name
 */
export function defineErrorCodeRegistry(
  appContributions: Record<string, ErrorCodeDescriptor>
): Readonly<Record<string, ErrorCodeDescriptor>> {
  const merged: Record<string, ErrorCodeDescriptor> = { ...PLATFORM_ERROR_CODES };
  const seenCodes = new Set<string>(Object.values(PLATFORM_ERROR_CODES).map((d) => d.code));

  for (const [key, descriptor] of Object.entries(appContributions)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(descriptor.code)) {
      throw new ErrorCodeRegistryError(
        `Error code "${descriptor.code}" (key ${key}) must be UPPER_SNAKE_CASE.`
      );
    }
    if (!Number.isInteger(descriptor.status) || descriptor.status < 400 || descriptor.status > 599) {
      throw new ErrorCodeRegistryError(
        `Error code "${descriptor.code}" has invalid HTTP status ${String(descriptor.status)} (expected 400–599).`
      );
    }
    if (seenCodes.has(descriptor.code)) {
      throw new ErrorCodeRegistryError(
        `Duplicate error code "${descriptor.code}" (key ${key}) — codes must be unique across the platform base map and app contributions.`
      );
    }
    seenCodes.add(descriptor.code);
    merged[key] = descriptor;
  }

  return Object.freeze(merged);
}
