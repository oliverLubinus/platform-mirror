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
import { createHmac, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
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

  it('rejects alg-confusion (none / RS256 in oct-only mode / missing alg)', async () => {
    // Per-kind alg allowlist (R-AUTH-76): with an OCT ring only, `none` and
    // a missing alg hit the allowlist itself; an RS256 alg routes to the
    // jwks path, which is UNCONFIGURED here — also fail-closed, with its
    // own reason. Either way: rejected, never cross-kind verified.
    await rejects(() => verifier(signToken(basePayload(), { alg: 'none' })), /alg must be HS256/);
    await rejects(() => verifier(signToken(basePayload(), { alg: 'RS256' })), /no jwksUri is configured/);
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
  it('empty key material (no ring, no jwksUri), malformed keys, or missing issuer/audience throw immediately', () => {
    throws(() => createTokenVerifier({ keys: [], issuer: ISSUER, audience: AUDIENCE }), /no key material configured/);
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

// ---------------------------------------------------------------------------
// WS-4 gate 1 consumer half (R-AUTH-76/77): the jwksUri fetch-cache mode.
// A REAL local JWKS server (node:http) serves generated RSA keys — every
// round-trip here is a true cross-implementation proof of the same RS256
// semantics the issuer-side drill (auth-provider scripts/ws4-rotation-drill.ts)
// exercises from the signing side.
// ---------------------------------------------------------------------------

interface JwksServer {
  url: string;
  state: {
    fetches: number;
    maxAge: string | null;
    keys: Record<string, unknown>[];
    status: number;
    raw: string | null;
  };
  close: () => Promise<void>;
}

async function startJwksServer(): Promise<JwksServer> {
  const state = {
    fetches: 0,
    maxAge: 'max-age=300' as string | null,
    keys: [] as Record<string, unknown>[],
    status: 200,
    raw: null as string | null,
  };
  const server = createServer((_req, res) => {
    state.fetches += 1;
    res.statusCode = state.status;
    if (state.maxAge !== null) res.setHeader('cache-control', state.maxAge);
    // connection: close — fetch must not hold a keep-alive socket past close()
    res.setHeader('connection', 'close');
    res.setHeader('content-type', 'application/json');
    res.end(state.raw ?? JSON.stringify({ keys: state.keys }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}/.well-known/jwks.json`,
    state,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function rsaJwk(publicKey: KeyObject, kid: string): Record<string, unknown> {
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  return { ...jwk, kid, use: 'sig', alg: 'RS256' };
}

/** Sign RS256 exactly like the issuer: RSA-SHA256 (PKCS#1 v1.5) over header.payload. */
function signRs256(
  payload: Record<string, unknown>,
  privateKey: KeyObject,
  kid: string | null,
  headerOverride?: Record<string, unknown>
): string {
  const header = headerOverride ?? { alg: 'RS256', typ: 'JWT', ...(kid !== null ? { kid } : {}) };
  const h = b64url(header);
  const p = b64url(payload);
  const signer = createSign('RSA-SHA256');
  signer.update(`${h}.${p}`);
  const sig = signer.sign(privateKey).toString('base64url');
  return `${h}.${p}.${sig}`;
}

function newRsaKeypair(): { publicKey: KeyObject; privateKey: KeyObject } {
  return generateKeyPairSync('rsa', { modulusLength: 2048 });
}

describe('createTokenVerifier — jwksUri mode (WS-4 gate 1 consumer half, R-AUTH-76/77)', () => {
  it('verifies an RS256 token against the published JWKS (real RSA round-trip)', async () => {
    const jwks = await startJwksServer();
    try {
      const { publicKey, privateKey } = newRsaKeypair();
      jwks.state.keys = [rsaJwk(publicKey, 'rsa-2026-11')];
      const jwksVerifier = createTokenVerifier({ jwksUri: jwks.url, issuer: ISSUER, audience: AUDIENCE });
      const claims = await jwksVerifier(signRs256(basePayload(), privateKey, 'rsa-2026-11'));
      strictEqual(claims['sub'], 'user-1');
      strictEqual(claims['scope'], 'notes:read notes:write');
    } finally {
      await jwks.close();
    }
  });

  it('caches the JWKS: repeated verifications within max-age do ONE fetch', async () => {
    const jwks = await startJwksServer();
    try {
      const { publicKey, privateKey } = newRsaKeypair();
      jwks.state.keys = [rsaJwk(publicKey, 'rsa-2026-11')];
      const jwksVerifier = createTokenVerifier({ jwksUri: jwks.url, issuer: ISSUER, audience: AUDIENCE });
      await jwksVerifier(signRs256(basePayload(), privateKey, 'rsa-2026-11'));
      await jwksVerifier(signRs256(basePayload(), privateKey, 'rsa-2026-11'));
      strictEqual(jwks.state.fetches, 1);
    } finally {
      await jwks.close();
    }
  });

  it('refetches on an unknown kid (rotation: publish-before-flip), then accepts', async () => {
    const jwks = await startJwksServer();
    try {
      const first = newRsaKeypair();
      const second = newRsaKeypair();
      jwks.state.keys = [rsaJwk(first.publicKey, 'rsa-2026-10')];
      const jwksVerifier = createTokenVerifier({ jwksUri: jwks.url, issuer: ISSUER, audience: AUDIENCE });
      // the old key verifies from the cache
      await jwksVerifier(signRs256(basePayload(), first.privateKey, 'rsa-2026-10'));
      strictEqual(jwks.state.fetches, 1);
      // the issuer rotates: the NEW key appears in the JWKS; a token signed
      // with it is unknown to the cache → one TTL-bypassing refetch
      jwks.state.keys = [rsaJwk(first.publicKey, 'rsa-2026-10'), rsaJwk(second.publicKey, 'rsa-2026-11')];
      const claims = await jwksVerifier(signRs256(basePayload(), second.privateKey, 'rsa-2026-11'));
      strictEqual(claims['sub'], 'user-1');
      strictEqual(jwks.state.fetches, 2);
    } finally {
      await jwks.close();
    }
  });

  it('rejects a kid unknown even after the refresh (forgery; two fetches total)', async () => {
    const jwks = await startJwksServer();
    try {
      const { publicKey, privateKey } = newRsaKeypair();
      const rogue = newRsaKeypair();
      jwks.state.keys = [rsaJwk(publicKey, 'rsa-2026-11')];
      const jwksVerifier = createTokenVerifier({ jwksUri: jwks.url, issuer: ISSUER, audience: AUDIENCE });
      await rejects(
        () => jwksVerifier(signRs256(basePayload(), rogue.privateKey, 'rogue-kid')),
        /unknown kid "rogue-kid"/
      );
      strictEqual(jwks.state.fetches, 2);
    } finally {
      await jwks.close();
    }
  });

  it('honors max-age (0 = refetch per verify; huge values capped at the 300s contract)', async () => {
    const { publicKey, privateKey } = newRsaKeypair();
    const zero = await startJwksServer();
    try {
      zero.state.maxAge = 'max-age=0';
      zero.state.keys = [rsaJwk(publicKey, 'rsa-2026-11')];
      const v = createTokenVerifier({ jwksUri: zero.url, issuer: ISSUER, audience: AUDIENCE });
      await v(signRs256(basePayload(), privateKey, 'rsa-2026-11'));
      await v(signRs256(basePayload(), privateKey, 'rsa-2026-11'));
      strictEqual(zero.state.fetches, 2);
    } finally {
      await zero.close();
    }
    const huge = await startJwksServer();
    try {
      huge.state.maxAge = 'max-age=9999';
      huge.state.keys = [rsaJwk(publicKey, 'rsa-2026-11')];
      const v = createTokenVerifier({ jwksUri: huge.url, issuer: ISSUER, audience: AUDIENCE });
      await v(signRs256(basePayload(), privateKey, 'rsa-2026-11'));
      await v(signRs256(basePayload(), privateKey, 'rsa-2026-11'));
      strictEqual(huge.state.fetches, 1);
    } finally {
      await huge.close();
    }
  });

  it('fail-closed: JWKS 500, malformed JSON, and zero usable keys all reject', async () => {
    const { privateKey } = newRsaKeypair();
    const server500 = await startJwksServer();
    try {
      server500.state.status = 500;
      const v = createTokenVerifier({ jwksUri: server500.url, issuer: ISSUER, audience: AUDIENCE });
      await rejects(() => v(signRs256(basePayload(), privateKey, 'rsa-2026-11')), /JWKS fetch failed \(HTTP 500\)/);
    } finally {
      await server500.close();
    }
    const malformed = await startJwksServer();
    try {
      malformed.state.raw = '<html>not json</html>';
      const v = createTokenVerifier({ jwksUri: malformed.url, issuer: ISSUER, audience: AUDIENCE });
      await rejects(() => v(signRs256(basePayload(), privateKey, 'rsa-2026-11')), /not valid JSON/);
    } finally {
      await malformed.close();
    }
    const unusable = await startJwksServer();
    try {
      unusable.state.keys = [{ kty: 'oct', kid: 'shared', k: 'ignored' }];
      const v = createTokenVerifier({ jwksUri: unusable.url, issuer: ISSUER, audience: AUDIENCE });
      await rejects(() => v(signRs256(basePayload(), privateKey, 'rsa-2026-11')), /no usable RSA signing keys/);
    } finally {
      await unusable.close();
    }
  });

  it('skips non-RSA / non-sig / wrong-alg keys; accepts the usable one', async () => {
    const jwks = await startJwksServer();
    try {
      const { publicKey, privateKey } = newRsaKeypair();
      jwks.state.keys = [
        { kty: 'oct', kid: 'shared', k: 'ignored' },
        { ...rsaJwk(publicKey, 'enc-key'), use: 'enc' },
        { ...rsaJwk(publicKey, 'wrong-alg'), alg: 'RS512' },
        rsaJwk(publicKey, 'rsa-2026-11'),
      ];
      const v = createTokenVerifier({ jwksUri: jwks.url, issuer: ISSUER, audience: AUDIENCE });
      const claims = await v(signRs256(basePayload(), privateKey, 'rsa-2026-11'));
      strictEqual(claims['sub'], 'user-1');
    } finally {
      await jwks.close();
    }
  });

  it('kid-mandatory on the RS256 path: a token without kid rejects (R-AUTH-74)', async () => {
    const jwks = await startJwksServer();
    try {
      const { publicKey, privateKey } = newRsaKeypair();
      jwks.state.keys = [rsaJwk(publicKey, 'rsa-2026-11')];
      const v = createTokenVerifier({ jwksUri: jwks.url, issuer: ISSUER, audience: AUDIENCE });
      await rejects(() => v(signRs256(basePayload(), privateKey, null)), /must carry a kid/);
    } finally {
      await jwks.close();
    }
  });

  it('alg allowlist holds in jwks mode: HS256 tokens reject when no oct ring is configured', async () => {
    const jwks = await startJwksServer();
    try {
      const { publicKey } = newRsaKeypair();
      jwks.state.keys = [rsaJwk(publicKey, 'rsa-2026-11')];
      const v = createTokenVerifier({ jwksUri: jwks.url, issuer: ISSUER, audience: AUDIENCE });
      await rejects(() => v(signToken(basePayload())), /no oct key ring is configured/);
    } finally {
      await jwks.close();
    }
  });

  it('dual mode (the overlap window): HS256 ring tokens AND RS256 jwks tokens both verify', async () => {
    const jwks = await startJwksServer();
    try {
      const { publicKey, privateKey } = newRsaKeypair();
      jwks.state.keys = [rsaJwk(publicKey, 'rsa-2026-11')];
      const v = createTokenVerifier({ keys: KEYS, jwksUri: jwks.url, issuer: ISSUER, audience: AUDIENCE });
      const octClaims = await v(signToken(basePayload()));
      strictEqual(octClaims['sub'], 'user-1');
      const rsClaims = await v(signRs256(basePayload(), privateKey, 'rsa-2026-11'));
      strictEqual(rsClaims['sub'], 'user-1');
    } finally {
      await jwks.close();
    }
  });

  it('the claim contract is identical on the jwks path (iss/aud/exp enforced)', async () => {
    const jwks = await startJwksServer();
    try {
      const { publicKey, privateKey } = newRsaKeypair();
      jwks.state.keys = [rsaJwk(publicKey, 'rsa-2026-11')];
      const v = createTokenVerifier({ jwksUri: jwks.url, issuer: ISSUER, audience: AUDIENCE });
      await rejects(
        () => v(signRs256({ ...basePayload(), aud: 'other-app' }, privateKey, 'rsa-2026-11')),
        /aud mismatch/
      );
      await rejects(
        () => v(signRs256({ ...basePayload(), iss: 'https://evil.example' }, privateKey, 'rsa-2026-11')),
        /iss mismatch/
      );
      const now = Date.now() / 1000;
      await rejects(
        () => v(signRs256({ ...basePayload(), exp: Math.floor(now) - 120 }, privateKey, 'rsa-2026-11')),
        /expired or missing exp/
      );
    } finally {
      await jwks.close();
    }
  });

  it('confusion attacks are structurally impossible: RS256 token against an oct-only ring rejects', async () => {
    const { privateKey } = newRsaKeypair();
    const v = createTokenVerifier({ keys: KEYS, issuer: ISSUER, audience: AUDIENCE });
    await rejects(() => v(signRs256(basePayload(), privateKey, 'rsa-2026-11')), /no jwksUri is configured/);
  });

  it('config fails fast: non-loopback http jwksUri invalid; loopback http valid; neither source invalid', () => {
    throws(
      () => createTokenVerifier({ jwksUri: 'http://evil.example/.well-known/jwks.json', issuer: ISSUER, audience: AUDIENCE }),
      /must be https/
    );
    const loopback = createTokenVerifier({
      jwksUri: 'http://127.0.0.1:4000/.well-known/jwks.json',
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    strictEqual(typeof loopback, 'function');
    throws(() => createTokenVerifier({ issuer: ISSUER, audience: AUDIENCE }), /no key material configured/);
  });
});
