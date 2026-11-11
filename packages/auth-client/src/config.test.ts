/**
 * Regression guards: fetchImpl is bound to the global receiver AT CONFIG TIME.
 *
 * The SDK invokes fetchImpl method-style (`cfg.fetchImpl(input, init)`), and
 * resolveAuthClientConfig used to store the global `fetch` UNBOUND. In a
 * browser, strict-mode ESM makes that a receiver mismatch: the native fetch
 * requires the global receiver and throws "Illegal invocation" the moment a
 * real app calls the SDK (first consumer: PM pilot A2, 2026-11-11 — worked
 * around app-side with the documented `fetchImpl: fetch.bind(globalThis)`
 * config until this fix). Node's fetch does not enforce a receiver, which is
 * why the Node suite never caught it — so these tests inject a
 * RECEIVER-STRICT fetch that mimics the WebIDL contract: any receiver other
 * than the global object must reject.
 */

import { deepStrictEqual, rejects, strictEqual } from 'node:assert';
import { describe, it } from 'node:test';
import { resolveAuthClientConfig, type AuthClientConfig } from './config.js';

function baseConfig(fetchImpl?: typeof fetch): AuthClientConfig {
  return {
    authApiBaseUrl: 'https://auth-api.example.test',
    clientId: 'test-app',
    redirectUri: 'https://app.example.test/auth/callback',
    storage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  };
}

interface FetchCall {
  thisArg: unknown;
  url: string;
}

let fetchCalls: FetchCall[] = [];

/**
 * Mimics the browser's native fetch receiver contract: invoking it with any
 * receiver other than the global object rejects with the exact browser
 * failure mode ("Illegal invocation").
 */
async function receiverStrictFetch(this: unknown, input: RequestInfo | URL): Promise<Response> {
  fetchCalls.push({ thisArg: this, url: String(input) });
  if (this !== globalThis) {
    throw new TypeError('Illegal invocation');
  }
  return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
}

/** Runs `fn` with the GLOBAL fetch replaced by the receiver-strict spy. */
async function withGlobalFetchPatched(fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = receiverStrictFetch as typeof fetch;
  try {
    await fn();
  } finally {
    (globalThis as { fetch: typeof fetch }).fetch = original;
    fetchCalls = [];
  }
}

describe('fetchImpl receiver binding (config-time bind)', () => {
  it('binds the DEFAULT global fetch at config time — method-style and fully detached calls both reach the global receiver', async () => {
    await withGlobalFetchPatched(async () => {
      const cfg = resolveAuthClientConfig(baseConfig());
      // Method-style, exactly how client.ts invokes it (this === cfg pre-fix).
      await cfg.fetchImpl(cfg.userinfoUrl);
      // Fully detached — the harshest call form.
      const detached = cfg.fetchImpl;
      await detached(cfg.userinfoUrl);
      deepStrictEqual(
        fetchCalls.map((c) => c.thisArg === globalThis),
        [true, true],
      );
    });
  });

  it('binds an INJECTED fetchImpl at config time — the SDK stays receiver-independent for custom implementations', async () => {
    await withGlobalFetchPatched(async () => {
      const cfg = resolveAuthClientConfig(baseConfig(receiverStrictFetch as typeof fetch));
      await cfg.fetchImpl(cfg.userinfoUrl);
      const detached = cfg.fetchImpl;
      await detached(cfg.userinfoUrl);
      deepStrictEqual(
        fetchCalls.map((c) => c.thisArg === globalThis),
        [true, true],
      );
    });
  });

  it('the receiver-strict spy rejects on a receiver mismatch (discriminator sanity — the guards keep their teeth)', () => {
    fetchCalls = [];
    const holder = { fetchImpl: receiverStrictFetch as typeof fetch };
    // Method-style on a plain object: this === holder !== globalThis.
    return rejects(() => holder.fetchImpl('https://auth-api.example.test/auth/userinfo'), TypeError).then(() => {
      strictEqual(fetchCalls[0]?.thisArg === holder, true);
    });
  });
});
