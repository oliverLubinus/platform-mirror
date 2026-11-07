import { strictEqual, throws } from 'node:assert';
import { describe, it } from 'node:test';
import { TokenStore } from './tokenStore.js';
import { OAuthError } from './errors.js';

const NOW = 1_000_000_000_000;
const clock = (): number => NOW;

function tokens(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: 'at-1',
    token_type: 'Bearer',
    expires_in: 3600,
    ...overrides,
  };
}

describe('TokenStore (R-PKG-03: tokens in memory only)', () => {
  it('stores and reads the active session in memory', () => {
    const store = new TokenStore(clock);
    const session = store.storeTokens(tokens() as never);
    strictEqual(session.accessToken, 'at-1');
    strictEqual(store.getAccessToken(), 'at-1');
  });

  it('computes expiresAt with the safety skew applied (default 30s)', () => {
    const store = new TokenStore(clock, { skewSeconds: 30 });
    const session = store.storeTokens(tokens({ expires_in: 100 }) as never);
    strictEqual(session.expiresAt, NOW + 70_000);
  });

  it('marks tokens expired at skew-adjusted time', () => {
    const store = new TokenStore(clock, { skewSeconds: 30 });
    store.storeTokens(tokens({ expires_in: 100 }) as never);
    strictEqual(store.isExpired(NOW + 69_000), false);
    strictEqual(store.isExpired(NOW + 70_000), true);
  });

  it('treats a session without refresh_token as non-refreshable', () => {
    const store = new TokenStore(clock);
    store.storeTokens(tokens() as never);
    strictEqual(store.canRefresh(), false);
    store.storeTokens(tokens({ refresh_token: 'rt-1' }) as never);
    strictEqual(store.canRefresh(), true);
  });

  it('clear() wipes the session — logout leaves nothing in memory', () => {
    const store = new TokenStore(clock);
    store.storeTokens(tokens() as never);
    store.clear();
    strictEqual(store.getAccessToken(), null);
    strictEqual(store.getSession(), null);
  });

  it('listener fires on store and clear (React adapter re-render trigger)', () => {
    const store = new TokenStore(clock);
    const events: (string | null)[] = [];
    store.subscribe((s) => events.push(s ? s.accessToken : null));
    store.storeTokens(tokens() as never);
    store.clear();
    strictEqual(events.length, 2);
    strictEqual(events[0], 'at-1');
    strictEqual(events[1], null);
  });

  it('unsubscribe stops listener notifications', () => {
    const store = new TokenStore(clock);
    const events: (string | null)[] = [];
    const unsub = store.subscribe((s) => events.push(s ? s.accessToken : null));
    store.storeTokens(tokens() as never);
    unsub();
    store.clear();
    strictEqual(events.length, 1);
  });

  it('refresh scheduling: claim() hands out the refresh token once and forgets it', () => {
    const store = new TokenStore(clock);
    store.storeTokens(tokens({ refresh_token: 'rt-1' }) as never);
    strictEqual(store.claimRefreshToken(), 'rt-1');
    strictEqual(store.claimRefreshToken(), null);
  });

  it('restoreRefreshToken() re-arms silent refresh after a failed attempt', () => {
    const store = new TokenStore(clock);
    store.storeTokens(tokens({ refresh_token: 'rt-1' }) as never);
    const claimed = store.claimRefreshToken();
    strictEqual(claimed, 'rt-1');
    store.restoreRefreshToken('rt-1');
    strictEqual(store.claimRefreshToken(), 'rt-1');
  });

  it('refresh failure clears the session (fail-closed, errors.test.ts parity)', () => {
    const store = new TokenStore(clock);
    store.storeTokens(tokens({ refresh_token: 'rt-1' }) as never);
    const err = OAuthError.fromResponse(400, '{"error":"invalid_grant"}');
    store.onRefreshFailed(err);
    strictEqual(store.getSession(), null);
    strictEqual(store.getAccessToken(), null);
  });

  it('throws on storing a malformed grant (contract with isRawTokenResponse)', () => {
    const store = new TokenStore(clock);
    throws(() => store.storeTokens({ nope: true } as never), /access_token/);
  });
});
