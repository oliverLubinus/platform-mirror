/**
 * @file server/src/errors/errorCodes.ts
 * @description
 *   The app's error-code registry. `defineErrorCodeRegistry` takes
 *   APP-ONLY contributions — it merges the platform base map
 *   (PLATFORM_ERROR_CODES, integration contract §3) internally and
 *   REJECTS duplicates. Clients may rely on base codes existing with
 *   their documented statuses; add new codes here as the app grows.
 */
import { defineErrorCodeRegistry } from '@agentic-dna/server-core';

export const errorCodes = defineErrorCodeRegistry({
  // App-specific codes ONLY — the base map already covers
  // UNAUTHENTICATED/FORBIDDEN/NOT_FOUND/VALIDATION_ERROR/RATE_LIMITED etc.
  NOTE_NOT_FOUND: {
    code: 'NOTE_NOT_FOUND',
    status: 404,
    description: 'The requested note does not exist.',
  },
});