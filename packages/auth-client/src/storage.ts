/**
 * @file storage.ts
 * @description
 *   Storage surface for `@platform/auth-client`'s non-token flow state
 *   (PKCE verifier, OIDC state, returnTo). NEVER used for tokens
 *   (R-PKG-03: tokens live in memory only — see tokenStore.ts).
 *
 *   The default adapter is `window.sessionStorage` and FAILS FAST when it
 *   is unavailable (SSR, headless runs): a lost code_verifier/state is a
 *   flow failure, and silent degradation would surface later as a
 *   confusing callback abort. SSR hosts inject their own adapter or gate
 *   these calls client-side.
 */

export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

import { AuthError } from './errors.js';

export class MissingBrowserStorageError extends AuthError {
  constructor() {
    super(
      'STORAGE_UNAVAILABLE',
      'window.sessionStorage is unavailable. The OIDC flow needs browser storage for its ' +
        'PKCE code_verifier and state. Run the flow client-side or inject a StorageAdapter.'
    );
    this.name = 'MissingBrowserStorageError';
  }

  getItem(): string | null {
    throw this;
  }
  setItem(): void {
    throw this;
  }
  removeItem(): void {
    throw this;
  }
}

/** Default storage: `window.sessionStorage` when present, else fail-fast. */
export function defaultStorage(): StorageAdapter {
  if (typeof window === 'undefined' || window.sessionStorage === undefined) {
    return new MissingBrowserStorageError();
  }
  const s = window.sessionStorage;
  return {
    getItem: (key) => s.getItem(key),
    setItem: (key, value) => s.setItem(key, value),
    removeItem: (key) => s.removeItem(key),
  };
}

export interface MemoryStorage extends StorageAdapter {
  /** Test hook: make every write throw (fail-closed behavior checks). */
  throwOnWrite: boolean;
  /** Test/inspection hook: iterate stored [key, value] pairs. */
  entries(): IterableIterator<[string, string]>;
  [Symbol.iterator](): IterableIterator<[string, string]>;
}

export function memoryStorage(): MemoryStorage {
  const map = new Map<string, string>();
  const store: MemoryStorage = {
    throwOnWrite: false,
    getItem(key) {
      return map.get(key) ?? null;
    },
    setItem(key, value) {
      if (store.throwOnWrite) throw new Error('storage writes disabled (test)');
      map.set(key, value);
    },
    removeItem(key) {
      if (store.throwOnWrite) throw new Error('storage writes disabled (test)');
      map.delete(key);
    },
    entries: () => map.entries(),
    [Symbol.iterator]: () => map.entries(),
  };
  return store;
}
