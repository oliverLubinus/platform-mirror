/**
 * @file errors.ts
 * @description
 *   Typed errors for `@agentic-dna/auth-client` (R-PKG-03).
 *
 *   Message discipline (R-PKG-03 hard rule "no secrets/tokens in logs"):
 *   - error messages are curated strings; they never interpolate protocol
 *     values (tokens, verifiers, raw payloads).
 *   - `error_description` from auth-provider is carried verbatim in
 *     `description` (server-curated text, safe to render) but never
 *     concatenated into `message`.
 *   - the SDK performs no logging at all — the sourceRules test enforces
 *     this structurally (no `console.*` in src/).
 */

/** Stable error codes — apps switch on these for UX (curated copy lives app-side). */
export type AuthErrorCode =
  /** Storage used where it cannot exist (SSR, headless). Fail fast, never degrade silently. */
  | 'STORAGE_UNAVAILABLE'
  /** Callback `state` missing/mismatched — login CSRF; fail closed. */
  | 'STATE_MISMATCH'
  /** PKCE verifier lost between redirect and callback (storage cleared mid-flow). */
  | 'VERIFIER_MISSING'
  /** Callback had no `code` to exchange. */
  | 'MISSING_CODE'
  /** User denied consent at the hosted UI (`error=access_denied` carries the detail). */
  | 'USER_CANCELLED'
  /** crypto.getRandomValues/subtle unavailable (SSR or insecure context). */
  | 'PKCE_GENERATION_FAILED'
  /** Network-level failure reaching an auth endpoint. */
  | 'NETWORK_FAILURE'
  /** Token/userinfo/logout request timed out. */
  | 'TIMEOUT'
  /** Configuration failed validation at construction time. */
  | 'CONFIG_INVALID'
  /** Backend answered in a way that indicates a server-side misconfiguration. */
  | 'SERVER_MISCONFIGURED'
  /** Token response / userinfo response failed its shape guard. */
  | 'MALFORMED_TOKEN_RESPONSE'
  /** No silent-refresh credential available for the configured strategy. */
  | 'REFRESH_UNAVAILABLE'
  /** Logout endpoint unreachable — local state is cleared regardless. */
  | 'LOGOUT_FAILED'
  /** Redirect to the hosted login flow was initiated (never returns normally). */
  | 'REAUTH_REDIRECT'
  /** Anything unexpected — inspect `cause`. */
  | 'UNKNOWN';

/**
 * SDK flow failure (our side): state, storage, timeouts, malformed responses.
 * `cause` carries the original failure — never swallowed.
 */
export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string, options?: { cause?: unknown }) {
    // The string form carries the code (debuggability: `String(err)` and
    // stack traces identify the failure class without extra plumbing).
    super(`[${code}] ${message}`, options);
    this.name = 'AuthError';
    this.code = code;
  }
}

/**
 * auth-provider answered with an OAuth2 protocol error (RFC 6749 §5.2 shape
 * `{ error, error_description }`) or one had to be synthesized from a
 * non-JSON body. `code` is the RFC error string itself (`invalid_grant`,
 * `access_denied`, …); OAuthErrors are protocol-level, while `AuthError`
 * failures are flow-level — apps that only care about UX can handle both
 * via the shared `name`/message contract.
 */
export class OAuthError extends Error {
  /** RFC 6749 §5.2 code, e.g. `invalid_grant`, `invalid_client`, `access_denied`. */
  readonly code: string;
  /** Server-curated description verbatim (when the body provided one). */
  readonly description: string | null;
  readonly httpStatus: number;
  /** Raw body when it was NOT parseable as the RFC shape (evidence, not a guess). */
  readonly rawBody: string | null;

  constructor(
    code: string,
    description: string | null,
    httpStatus: number,
    rawBody: string | null
  ) {
    super(`token endpoint error: ${code}`);
    this.name = 'OAuthError';
    this.code = code;
    this.description = description;
    this.httpStatus = httpStatus;
    this.rawBody = rawBody;
  }

  /**
   * Parse an HTTP response body into an OAuthError. Branches on JSON
   * parseability FIRST (unknown paths answer HTML — consumer guide §8);
   * unparseable bodies keep the raw text as evidence under
   * `code = 'unknown_error'`.
   */
  static fromResponse(status: number, body: string | null): OAuthError {
    if (body !== null) {
      try {
        const parsed: unknown = JSON.parse(body);
        if (typeof parsed === 'object' && parsed !== null) {
          const r = parsed as Record<string, unknown>;
          const error = r['error'];
          if (typeof error === 'string' && error.length > 0) {
            const description = r['error_description'];
            return new OAuthError(
              error,
              typeof description === 'string' ? description : null,
              status,
              null
            );
          }
        }
      } catch {
        // fall through — HTML/garbage bodies keep their raw text below
      }
    }
    return new OAuthError('unknown_error', null, status, body);
  }

  /**
   * True when the refresh credential (or the whole session) is dead and a
   * re-authentication is the only way forward: `invalid_grant` (rotated
   * away / expired / replayed / consent revoked / banned), `invalid_client`,
   * `unauthorized_client`, `invalid_scope`. Everything else
   * (`server_error`, `temporarily_unavailable`, timeouts) may succeed on a
   * later attempt and must NOT clear the session.
   */
  get requiresReauth(): boolean {
    return ['invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_scope'].includes(
      this.code
    );
  }
}