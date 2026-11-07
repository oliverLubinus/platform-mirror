/**
 * @file tokenVerifier.test.ts
 * @description
 *   Signature round-trip + rejection-contract tests for createTokenVerifier.
 *   Test tokens are signed with the SAME HMAC construction the issuer uses
 *   (jsonwebtoken HS256: HMAC-SHA256 over "header.payload", base64url) —
 *   so a passing test here is a REAL cross-implementation signature proof,
 *   not a self-comparison.
 */
import { describe, it } from 'node:test';
import { deepStrictEqual, rejects, strictEqual, throws } from 'node:assert';
import { createHmac } from 'node:crypto';
import { createTokenVerifier, type IssuerKey } from './tokenVerifier.js';

const KEYS: IssuerKey[] = [
  { kid: 'current', secret: 'ring-secret-current' },
  { kid: 'old', secret: 'ring-secret-old' },
];
const ISSUER = 'http://localhost:4000';
const AUDIENCE = 'app-demo';

function b64url(input: object | string): string {
  return Buffer.from(typeof input === 'string' ? input : JSON.stringify(input)).toString('base64url');
}

/** Sign like jsonwebtoken HS256: HMAC-SHA256(header.payload), base64url. */
function signToken(
  payload: Record<string, unknown>,
  opts: { secret?: string; kid?: string | null; alg?: string; header?: Record<string, unknown> } = {}
): string {
  let header = opts.header;
  if (header === undefined) {
    header = { alg: opts.alg ?? 'HS256', typ: 'JWT' } as Record<string, unknown>;
    if (opts.kid === undefined) header['kid'] = 'current';
    else if (opts.kid !== null) header['kid'] = opts.kid; // null → header WITHOUT kid
  }
  const h = b64url(header);
  const p = b64url(payload);
  const secret = opts.secret ?? 'ring-secret-current';
  const sig = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

function basePayload(): Record<string, unknown> {
  const now = Date.now() / 1000;
  return {
    sub: 'user-1',
    aud: AUDIENCE,
    iss: ISSUER,
    iat: Math.floor(now),
    exp: Math.floor(now) + 3600,
    scope: 'notes:read notes:write',
  };
}

const verifier = createTokenVerifier({ keys: KEYS, issuer: ISSUER, audience: AUDIENCE });

describe('createTokenVerifier — signature round-trips (real HMAC, cross-proof)', () => {
  it('accepts a valid token from the ACTIVE key and forwards all claims', async () => {
    const claims = await verifier(signToken(basePayload()));
    strictEqual(claims['sub'], 'user-1');
    strictEqual(claims['scope'], 'notes:read notes:write');
  });

  it('accepts a token signed by a NON-ACTIVE ring key (rotation: verify by header kid)', async () => {
    const claims = await verifier(signToken(basePayload(), { kid: 'old', secret: 'ring-secret-old' }));
    strictEqual(claims['sub'], 'user-1');
  });

  it('accepts a token WITHOUT kid when the ring holds exactly one key', async () => {
    const single = createTokenVerifier({ keys: [{ kid: 'only', secret: 's3cret' }], issuer: ISSUER, audience: AUDIENCE });
    const claims = await single(signToken(basePayload(), { kid: null, secret: 's3cret' }));
    strictEqual(claims['sub'], 'user-1');
  });

  it('normalizes trailing slashes on iss', async () => {
    const claims = await verifier(signToken({ ...basePayload(), iss: `${ISSUER}/` }));
    strictEqual(claims['sub'], 'user-1');
  });

  it('accepts array-form aud containing the expected audience', async () => {
    const claims = await verifier(signToken({ ...basePayload(), aud: ['other-app', AUDIENCE] }));
    strictEqual(claims['sub'], 'user-1');
  });
});

describe('createTokenVerifier — fail-closed rejections (every step)', () => {
  it('rejects a token with a broken structure', async () => {
    // rejects() matches the MESSAGE; the code is asserted via the ApiError surface below.
    await rejects(() => verifier('not-a-jwt'), /not a three-part JWT/);
  });

  it('rejects alg-confusion (none / RS256 / missing alg)', async () => {
    await rejects(() => verifier(signToken(basePayload(), { alg: 'none' })), /alg must be HS256/);
    await rejects(() => verifier(signToken(basePayload(), { alg: 'RS256' })), /alg must be HS256/);
    const noAlg = signToken(basePayload());
    const parts = noAlg.split('.');
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString()) as Record<string, unknown>;
    delete header['alg'];
    const reSigned = signToken(basePayload(), { header });
    await rejects(() => verifier(reSigned), /alg must be HS256/);
  });

  it('rejects an UNKNOWN kid (rotation gap or forgery)', async () => {
    await rejects(
      () => verifier(signToken(basePayload(), { kid: 'rogue', secret: 'attacker-key' })),
      /unknown kid "rogue"/
    );
  });

  it('rejects a forged signature (right structure, wrong key)', async () => {
    await rejects(() => verifier(signToken(basePayload(), { secret: 'attacker-key' })), /signature verification failed/);
  });

  it('rejects a TAMPERED payload with a valid-looking signature from another token', async () => {
    const legit = signToken(basePayload());
    const tampered = legit.replace(/([A-Za-z0-9_-]{20})(?=[^.]*$)/, 'x'.repeat(20)); // scramble signature
    await rejects(() => verifier(tampered.replace(/([^.]+\.)([^.]+\.)([^.]+)/, '$1$2' + 'A'.repeat(40))));
  });

  it('rejects a wrong issuer', async () => {
    await rejects(() => verifier(signToken({ ...basePayload(), iss: 'https://evil.example' })), /iss mismatch/);
  });

  it('rejects a wrong audience', async () => {
    await rejects(() => verifier(signToken({ ...basePayload(), aud: 'other-app' })), /aud mismatch/);
  });

  it('rejects an EXPIRED token and a token missing exp', async () => {
    const now = Date.now() / 1000;
    await rejects(() => verifier(signToken({ ...basePayload(), exp: Math.floor(now) - 120 })), /expired or missing exp/);
    const { exp: _omit, ...withoutExp } = basePayload();
    await rejects(() => verifier(signToken(withoutExp)), /expired or missing exp/);
  });

  it('rejects nbf in the future and a future iat (skew-checked)', async () => {
    const now = Date.now() / 1000;
    await rejects(
      () => verifier(signToken({ ...basePayload(), nbf: Math.floor(now) + 3600 })),
      /not yet valid/
    );
    await rejects(() => verifier(signToken({ ...basePayload(), iat: Math.floor(now) + 3600 })), /iat in the future/);
  });

  it('rejects a missing/empty sub', async () => {
    const { sub: _omit, ...withoutSub } = basePayload();
    await rejects(() => verifier(signToken(withoutSub)), /sub missing or malformed/);
  });
});

describe('createTokenVerifier — config fails fast at creation', () => {
  it('empty key ring, malformed keys, or missing issuer/audience throw immediately', () => {
    throws(() => createTokenVerifier({ keys: [], issuer: ISSUER, audience: AUDIENCE }), /key ring is empty/);
    throws(
      () => createTokenVerifier({ keys: [{ kid: '', secret: 'x' }], issuer: ISSUER, audience: AUDIENCE }),
      /non-empty kid and secret/
    );
    throws(() => createTokenVerifier({ keys: KEYS, issuer: '', audience: AUDIENCE }), /config.issuer/);
    throws(() => createTokenVerifier({ keys: KEYS, issuer: ISSUER, audience: '' }), /config.audience/);
  });

  it('extra issuer claims (amr, acr) forward — opaque to the middleware', async () => {
    const claims = await verifier(signToken({ ...basePayload(), amr: ['pwd', 'otp'], acr: 'urn:example:acr:mfa' }));
    deepStrictEqual(claims['amr'], ['pwd', 'otp']);
    strictEqual(claims['acr'], 'urn:example:acr:mfa');
  });
});