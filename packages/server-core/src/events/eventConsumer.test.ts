import { deepStrictEqual, strictEqual, rejects } from 'node:assert';
import { describe, it } from 'node:test';
import { createHmac } from 'node:crypto';
import { createEventConsumer, verifyEventSignature, isPlatformEventEnvelope } from './eventConsumer.js';
import type { PlatformEventEnvelope } from './eventConsumer.js';

const SECRET = 'test-webhook-secret-32-bytes-aaaa';
// Freshness is relative to the REAL clock (replay protection) — tests must
// sign deliveries "now", not at a frozen past timestamp.
const NOW = Math.floor(Date.now() / 1000);

function envelopeOf(eventId: string, type = 'identity.created'): string {
  const envelope: PlatformEventEnvelope = {
    eventId,
    type,
    occurredAt: new Date(NOW * 1000).toISOString(),
    data: { userId: 'u1' },
    origin: 'auth-provider'
  };
  return JSON.stringify(envelope);
}

function signedHeaders(rawBody: string, timestamp: number, secret = SECRET): Record<string, string> {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return { 'x-signature': `sha256=${signature}`, 'x-timestamp': String(timestamp) };
}

function memorySeen() {
  const seen = new Set<string>();
  return {
    hasSeen: async (id: string) => seen.has(id),
    markSeen: async (id: string) => {
      seen.add(id);
    }
  };
}

function makeConsumer(handlerCalls: string[] = []) {
  const seen = memorySeen();
  return createEventConsumer({
    secretProvider: { getSecret: async () => SECRET },
    secretName: 'test',
    seenEvents: seen,
    onEvent: async (event) => {
      handlerCalls.push(event.eventId);
      return { committed: true };
    }
  });
}

describe('verifyEventSignature', () => {
  it('accepts a valid HMAC over timestamp + raw body', () => {
    const raw = envelopeOf('e1');
    strictEqual(verifyEventSignature(raw, signedHeaders(raw, NOW), SECRET).valid, true);
  });

  it('rejects missing/malformed headers, wrong secret, and stale timestamps', () => {
    const raw = envelopeOf('e1');
    deepStrictEqual(verifyEventSignature(raw, {}, SECRET), {
      valid: false,
      reason: 'missing-headers'
    });
    deepStrictEqual(verifyEventSignature(raw, signedHeaders(raw, NOW, 'wrong'), SECRET), {
      valid: false,
      reason: 'bad-signature'
    });
    deepStrictEqual(verifyEventSignature(raw, signedHeaders(raw, NOW - 3600), SECRET), {
      valid: false,
      reason: 'stale-timestamp'
    });
  });

  it('rejects tampered bodies', () => {
    deepStrictEqual(verifyEventSignature(envelopeOf('e2'), signedHeaders(envelopeOf('e1'), NOW), SECRET), {
      valid: false,
      reason: 'bad-signature'
    });
  });
});

describe('isPlatformEventEnvelope', () => {
  it('validates shape and rejects malformed envelopes', () => {
    const valid = JSON.parse(envelopeOf('e1')) as PlatformEventEnvelope;
    strictEqual(isPlatformEventEnvelope(valid), true);
    strictEqual(isPlatformEventEnvelope({ eventId: 'x' }), false);
    strictEqual(isPlatformEventEnvelope({ ...valid, occurredAt: 'not-a-date' }), false);
    strictEqual(isPlatformEventEnvelope(null), false);
  });
});

describe('createEventConsumer (ADR-016 consumer contract)', () => {
  it('processes a valid delivery: 200 + handler runs + eventId marked seen', async () => {
    const calls: string[] = [];
    const consumer = makeConsumer(calls);
    const raw = envelopeOf('evt-1');
    const res = await consumer.handle(raw, signedHeaders(raw, NOW));
    strictEqual(res.status, 200);
    deepStrictEqual(calls, ['evt-1']);
  });

  it('duplicate eventId: 200, handler NOT re-run (at-least-once safety)', async () => {
    const calls: string[] = [];
    const consumer = makeConsumer(calls);
    const raw = envelopeOf('evt-dup');
    await consumer.handle(raw, signedHeaders(raw, NOW));
    const second = await consumer.handle(raw, signedHeaders(raw, NOW));
    strictEqual(second.status, 200);
    deepStrictEqual(calls, ['evt-dup']);
  });

  it('bad signature → 401 without touching the handler', async () => {
    const calls: string[] = [];
    const consumer = makeConsumer(calls);
    const raw = envelopeOf('evt-x');
    const res = await consumer.handle(raw, signedHeaders(raw, NOW, 'wrong-secret'));
    strictEqual(res.status, 401);
    deepStrictEqual(calls, []);
  });

  it('malformed JSON with valid signature → 422', async () => {
    const consumer = makeConsumer();
    const res = await consumer.handle('{not-json', signedHeaders('{not-json', NOW));
    strictEqual(res.status, 422);
  });

  it('handler that does not commit → 500 (2xx only after local commit)', async () => {
    const consumer = createEventConsumer({
      secretProvider: { getSecret: async () => SECRET },
      secretName: 'test',
      seenEvents: memorySeen(),
      onEvent: async () => ({ committed: false })
    });
    const raw = envelopeOf('evt-nc');
    const res = await consumer.handle(raw, signedHeaders(raw, NOW));
    strictEqual(res.status, 500);
  });

  it('handler errors propagate to the adapter (retry loop re-drives)', async () => {
    const consumer = createEventConsumer({
      secretProvider: { getSecret: async () => SECRET },
      secretName: 'test',
      seenEvents: memorySeen(),
      onEvent: async () => {
        throw new Error('db down');
      }
    });
    const raw = envelopeOf('evt-throw');
    await rejects(consumer.handle(raw, signedHeaders(raw, NOW)), /db down/);
  });

  it('missing declared secret → throws (fail-closed, never 2xx)', async () => {
    const consumer = createEventConsumer({
      secretProvider: { getSecret: async () => undefined },
      secretName: 'test',
      seenEvents: memorySeen(),
      onEvent: async () => ({ committed: true })
    });
    const raw = envelopeOf('evt-nosecret');
    await rejects(consumer.handle(raw, signedHeaders(raw, NOW)), /not declared/);
  });
});
