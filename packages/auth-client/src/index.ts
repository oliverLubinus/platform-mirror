/**
 * @agentic-dna/auth-client — public surface (R-PKG-03, ADR-009 §1).
 *
 * Framework-agnostic core: OIDC Authorization Code + PKCE, in-memory access
 * tokens, silent refresh, authenticated fetch. The React adapter (session
 * provider/hooks, ProtectedRoute, role-gated rendering, "no access" page)
 * ships as a `./react` subpath with the first real consumer (ADR-020 Phase 2).
 */

export { createAuthClient } from './client.js';
export type {
  AuthClient,
  AuthSession,
  CallbackResult,
  LoginOptions,
  UserInfoClaims,
} from './client.js';
export { AuthError, OAuthError } from './errors.js';
export type { AuthErrorCode } from './errors.js';
export {
  bytesToBase64Url,
  clearOidcState,
  clearPkceVerifier,
  clearReturnTo,
  generateCodeChallenge,
  generateCodeVerifier,
  generateOidcState,
  getOidcState,
  getPkceVerifier,
  getReturnTo,
  pkceKeysFor,
  storeOidcState,
  storePkceVerifier,
  storeReturnTo,
} from './pkce.js';
export { TokenStore } from './tokenStore.js';
export type { AuthSession as StoredSession, SessionListener, TokenStoreOptions } from './tokenStore.js';
export { isRawTokenResponse } from './tokenEndpoint.js';
export type { RawTokenResponse } from './tokenEndpoint.js';
export { resolveAuthClientConfig, defaultStorage, MissingBrowserStorageError } from './config.js';
export type {
  AuthClientConfig,
  RefreshCredential,
  ResolvedAuthClientConfig,
} from './config.js';
export { memoryStorage } from './storage.js';
export type { MemoryStorage, StorageAdapter } from './storage.js';