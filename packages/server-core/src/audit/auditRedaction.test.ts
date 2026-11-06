import { deepStrictEqual, strictEqual } from 'node:assert';
import { describe, it } from 'node:test';
import { redactAuditDetails } from './auditRedaction.js';

describe('redactAuditDetails (ABE-5 port — verbatim regex contract)', () => {
  it('redacts key=value secrets, keeps benign context', () => {
    const input = 'ip=1.2.3.4, user_id=u1, password=hunter2, action=login_success';
    const out = redactAuditDetails(input);
    strictEqual(out, 'ip=1.2.3.4, user_id=u1, password=[REDACTED], action=login_success');
  });

  it('redacts JSON-style "key": "value" pairs', () => {
    const out = redactAuditDetails('"ip": "1.2.3.4", "access_token": "abc123"');
    strictEqual(out, '"ip": "1.2.3.4", "access_token": [REDACTED]');
  });

  it('covers the full sensitive-key set incl. api_key/api-key variants and case-insensitivity', () => {
    for (const fragment of [
      'apiKey=xyz',
      'api_key=xyz',
      'api-key=xyz',
      'API_KEY=xyz',
      'secret=xyz',
      'code_verifier=xyz',
      'cookie=sid',
      'authorization=Bearer abc'
    ]) {
      const out = redactAuditDetails(fragment);
      strictEqual(out?.includes('[REDACTED]'), true, `failed for: ${fragment}`);
    }
  });

  it('leaves benign keys untouched', () => {
    const input = 'admin_id=a1, q=projects, pkce=plain, scope=read';
    strictEqual(redactAuditDetails(input), input);
  });

  it('VERBATIM boundary: underscore-prefixed keys are NOT matched (client_secret keeps its value)', () => {
    // The ported pattern requires a word boundary before the key; in
    // client_secret the preceding underscore is itself a word character, so
    // the bare `secret` alternative cannot fire. Pinned as-is: this is the
    // live auth-provider contract (the deeper protection is the logging
    // policy that forbids writing secrets into audit details at all).
    strictEqual(redactAuditDetails('client_secret=xyz'), 'client_secret=xyz');
  });

  it('VERBATIM value consumption stops at whitespace: multi-token values are partially redacted', () => {
    // `authorization=Bearer abc` → the value pattern stops at the space, so
    // only the first token is replaced. Pinned as-is (live behavior).
    strictEqual(redactAuditDetails('authorization=Bearer abc'), 'authorization=[REDACTED] abc');
  });

  it('pass-through for empty/undefined', () => {
    strictEqual(redactAuditDetails(undefined), undefined);
    strictEqual(redactAuditDetails(''), '');
  });

  it('multi-value flat string: only secret values replaced', () => {
    const out = redactAuditDetails('user_id=u1, token=abc, email=a@b.c');
    strictEqual(out, 'user_id=u1, token=[REDACTED], email=a@b.c');
  });
});
