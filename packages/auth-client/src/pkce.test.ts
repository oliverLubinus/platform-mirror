import { strictEqual, notStrictEqual, match, throws, rejects } from 'node:assert';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  bytesToBase64Url,
  clearOidcState,
  clearPkceVerifier,
  generateCodeChallenge,
  generateCodeVerifier,
  generateOidcState,
  getOidcState,
  getPkceVerifier,
  getReturnTo,
  pkceKeysFor,
  storeReturnTo,
  buildAuthorizeUrl,
} from './pkce.js';
import { memoryStorage } from './storage.js';

const UNRESERVED = /^[A-Za-z0-9\-._~]+$/;

/** Temporarily hide globalThis.crypto to prove the fail-closed guards. */
async function withoutCrypto(fn: () => void | Promise<void>): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  try {
    await fn();
  } finally {
    if (original) Object.defineProperty(globalThis, 'crypto', original);
  }
}

describe('PKCE (RFC 7636) port', () => {
  it('code_verifier: 43 chars, unreserved charset, fresh per call', () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    strictEqual(a.length, 43);
    match(a, UNRESERVED);
    notStrictEqual(a, b);
  });

  it('code_challenge: BASE64URL(SHA256(verifier)) — cross-checked against node:crypto', async () => {
    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    const expected = createHash('sha256').update(verifier).digest('base64url');
    strictEqual(challenge, expected);
    strictEqual(challenge.length, 43);
  });

  it('oidc state: 32 chars base64url, fresh per call', () => {
    const a = generateOidcState();
    const b = generateOidcState();
    strictEqual(a.length, 32);
    match(a, UNRESERVED);
    notStrictEqual(a, b);
  });

  it('bytesToBase64Url is unpadded and URL-safe', () => {
    strictEqual(bytesToBase64Url(new Uint8Array([0xfb, 0xff, 0xbf])), '-_-_');
  });

  it('fails closed when crypto.getRandomValues is unavailable (SSR/insecure context)', async () => {
    await withoutCrypto(() => {
      throws(() => generateCodeVerifier());
      throws(() => generateOidcState());
    });
  });

  it('code_challenge throws when crypto.subtle is unavailable', async () => {
    await withoutCrypto(async () => {
      await rejects(generateCodeChallenge('verifier'), /crypto\.subtle/);
    });
  });

  it('storage keys are clientId-namespaced', () => {
    const a = pkceKeysFor('client-a');
    const b = pkceKeysFor('client-b');
    notStrictEqual(a.verifier, b.verifier);
    notStrictEqual(a.state, b.state);
    match(a.state, /platform-auth:state:client-a$/);
  });
});

describe('buildAuthorizeUrl', () => {
  it('carries the full public-client parameter set and persists state+verifier', async () => {
    const storage = memoryStorage();
    const keys = pkceKeysFor('test-app');
    const url = await buildAuthorizeUrl('https://auth-api.example.test/auth/authorize', storage, keys, {
      clientId: 'test-app',
      redirectUri: 'https://app.example.test/auth/callback',
      scopes: ['openid', 'profile'],
    });
    const parsed = new URL(url);
    strictEqual(parsed.origin + parsed.pathname, 'https://auth-api.example.test/auth/authorize');
    strictEqual(parsed.searchParams.get('client_id'), 'test-app');
    strictEqual(parsed.searchParams.get('redirect_uri'), 'https://app.example.test/auth/callback');
    strictEqual(parsed.searchParams.get('response_type'), 'code');
    strictEqual(parsed.searchParams.get('scope'), 'openid profile');
    strictEqual(parsed.searchParams.get('code_challenge_method'), 'S256');
    strictEqual(parsed.searchParams.get('client_secret'), null);
    strictEqual(parsed.searchParams.get('prompt'), null);

    const state = parsed.searchParams.get('state');
    const challenge = parsed.searchParams.get('code_challenge');
    strictEqual(state, getOidcState(storage, keys));
    const verifier = getPkceVerifier(storage, keys);
    strictEqual(verifier !== null, true);
    strictEqual(challenge, await generateCodeChallenge(verifier as string));
  });

  it('stores returnTo app-side only — never in the URL', async () => {
    const storage = memoryStorage();
    const keys = pkceKeysFor('test-app');
    const url = await buildAuthorizeUrl('https://auth-api.example.test/auth/authorize', storage, keys, {
      clientId: 'test-app',
      redirectUri: 'https://app.example.test/auth/callback',
      scopes: ['openid'],
      returnTo: '/projects/42',
    });
    strictEqual(url.includes('returnTo'), false);
    strictEqual(getReturnTo(storage, keys), '/projects/42');
  });

  it('fails closed when storage is unavailable — never redirects challenge-less', async () => {
    const failing = memoryStorage();
    failing.throwOnWrite = true;
    await rejects(
      buildAuthorizeUrl('https://auth-api.example.test/auth/authorize', failing, pkceKeysFor('test-app'), {
        clientId: 'test-app',
        redirectUri: 'https://app.example.test/auth/callback',
        scopes: ['openid'],
      })
    );
  });

  it('clear helpers remove exactly their own key', async () => {
    const storage = memoryStorage();
    const keys = pkceKeysFor('test-app');
    await buildAuthorizeUrl('https://auth-api.example.test/auth/authorize', storage, keys, {
      clientId: 'test-app',
      redirectUri: 'https://app.example.test/auth/callback',
      scopes: ['openid'],
    });
    strictEqual(getPkceVerifier(storage, keys) !== null, true);
    clearPkceVerifier(storage, keys);
    strictEqual(getPkceVerifier(storage, keys), null);
    clearOidcState(storage, keys);
    strictEqual(getOidcState(storage, keys), null);
  });
});