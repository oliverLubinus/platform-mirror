/**
 * Event-consumer contract template — the single platform-conformant way to
 * consume ADR-016 webhooks (R-PKG-08). Derived requirements
 * (R-CHAT-21, R-AG-12, R-PM-19) explicitly bind to this template:
 * "no hand-rolled consumers".
 *
 * Contract semantics implemented:
 *  - HMAC-SHA256 signature verification over `timestamp + '.' + rawBody`
 *    (constant-time compare), with ±5-minute freshness window and stale-
 *    timestamp rejection (replay protection),
 *  - `eventId` idempotency (at-least-once delivery → duplicate suppression),
 *  - 2xx returned ONLY after the handler has committed locally
 *    (transactional-outbox coupling; retries re-drive the handler),
 *  - envelope validation against the ADR-016 self-contained event shape.
 *
 * The host app supplies `secretProvider` (per-app secret declaration, ADR-010)
 * — the consumer never hardcodes or reads process.env directly.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** ADR-016 event envelope — self-contained, no lookups required to process. */
export interface PlatformEventEnvelope<T = unknown> {
  readonly eventId: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly data: T;
  readonly origin: string;
}

/** Result of signature + freshness verification. */
export type SignatureVerification =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: 'missing-headers' | 'bad-signature' | 'stale-timestamp' };

/** Max skew between the signature timestamp and now (replay window). */
const TIMESTAMP_FRESHNESS_SECONDS = 5 * 60;

/** Verifies `X-Signature`/`X-Timestamp` against the raw body (constant-time). */
export function verifyEventSignature(
  rawBody: string,
  headers: Record<string, string | undefined>,
  secret: string
): SignatureVerification {
  const signature = headers['x-signature'];
  const timestampHeader = headers['x-timestamp'];
  if (typeof signature !== 'string' || signature.length === 0 || typeof timestampHeader !== 'string') {
    return { valid: false, reason: 'missing-headers' };
  }
  const timestamp = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(timestamp)) {
    return { valid: false, reason: 'stale-timestamp' };
  }
  const skew = Math.abs(Date.now() / 1000 - timestamp);
  if (skew > TIMESTAMP_FRESHNESS_SECONDS) {
    return { valid: false, reason: 'stale-timestamp' };
  }
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const received = signature.replace(/^sha256=/i, '').trim().toLowerCase();
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: 'bad-signature' };
  }
  return { valid: true };
}

/** Minimal envelope validation (shape + types — data payload is app-domain). */
export function isPlatformEventEnvelope(value: unknown): value is PlatformEventEnvelope {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.eventId === 'string' &&
    v.eventId.length > 0 &&
    typeof v.type === 'string' &&
    v.type.length > 0 &&
    typeof v.occurredAt === 'string' &&
    !Number.isNaN(Date.parse(v.occurredAt)) &&
    'data' in v &&
    typeof v.origin === 'string'
  );
}

/**
 * The processing result a handler must return. `committed` gates the HTTP
 * response: the consumer responds 2xx only when the handler reports a local
 * commit (ADR-016: delivery is at-least-once; the DLQ/retry loop re-drives
 * the handler otherwise).
 */
export interface EventProcessResult {
  readonly committed: boolean;
  /** True when the event was already processed (idempotent duplicate). */
  readonly duplicate?: boolean;
}

export type EventHandler = (
  event: PlatformEventEnvelope
) => Promise<EventProcessResult> | EventProcessResult;

/** Minimal secret store contract — apps bind their secretProvider here. */
export interface EventSecretProvider {
  getSecret(name: string): Promise<string | undefined>;
}

/** HTTP result the framework adapter should send for a processed event. */
export interface ConsumerHttpResponse {
  readonly status: number;
  readonly body?: string;
}

export const EVENT_CONSUMER_RESPONSE = {
  OK: { status: 200, body: '{"handled":true}' },
  DUPLICATE: { status: 200, body: '{"handled":true,"duplicate":true}' },
  BAD_SIGNATURE: { status: 401, body: '{"error":{"code":"UNAUTHENTICATED","message":"Invalid event signature.","status":401}}' },
  INVALID_ENVELOPE: { status: 422, body: '{"error":{"code":"VALIDATION_FAILED","message":"Malformed event envelope.","status":422}}' },
  NOT_COMMITTED: { status: 500, body: '{"error":{"code":"INTERNAL","message":"Event handler did not commit.","status":500}}' }
} as const satisfies Record<string, ConsumerHttpResponse>;

/**
 * Create the platform-conformant consumer. The returned `handle` takes the
 * RAW body string (signature covers bytes, not parsed JSON), headers and a
 * freshness/idempotency store callback, and returns the exact HTTP response
 * the route must send. Any thrown handler error propagates — the adapter
 * maps it to 500 and the ADR-016 retry loop re-drives.
 *
 * @param opts.secretProvider - per-app secret store (secret name → webhook secret)
 * @param opts.secretName - secret declared by this app for webhook signing
 * @param opts.seenEvents - idempotency check + mark (e.g. a Prisma unique
 *   table upsert); must be atomic enough that concurrent delivery of the
 *   same eventId converges on exactly one `committed: true` result.
 * @param opts.onEvent - the app's business handler; must commit locally
 *   before returning (DB transaction committed, side effects durable).
 */
export function createEventConsumer(opts: {
  secretProvider: EventSecretProvider;
  secretName: string;
  seenEvents: {
    hasSeen(eventId: string): Promise<boolean>;
    markSeen(eventId: string): Promise<void>;
  };
  onEvent: EventHandler;
}): {
  handle(rawBody: string, headers: Record<string, string | undefined>): Promise<ConsumerHttpResponse>;
} {
  return {
    async handle(rawBody, headers): Promise<ConsumerHttpResponse> {
      const secret = await opts.secretProvider.getSecret(opts.secretName);
      if (secret === undefined || secret.length === 0) {
        throw new Error(`Event consumer secret "${opts.secretName}" not declared in secretProvider inventory.`);
      }
      const verification = verifyEventSignature(rawBody, headers, secret);
      if (!verification.valid) {
        return EVENT_CONSUMER_RESPONSE.BAD_SIGNATURE;
      }
      let envelope: PlatformEventEnvelope;
      try {
        envelope = JSON.parse(rawBody) as PlatformEventEnvelope;
      } catch {
        return EVENT_CONSUMER_RESPONSE.INVALID_ENVELOPE;
      }
      if (!isPlatformEventEnvelope(envelope)) {
        return EVENT_CONSUMER_RESPONSE.INVALID_ENVELOPE;
      }
      if (await opts.seenEvents.hasSeen(envelope.eventId)) {
        return EVENT_CONSUMER_RESPONSE.DUPLICATE;
      }
      const result = await opts.onEvent(envelope);
      if (!result.committed) {
        return EVENT_CONSUMER_RESPONSE.NOT_COMMITTED;
      }
      await opts.seenEvents.markSeen(envelope.eventId);
      return result.duplicate ? EVENT_CONSUMER_RESPONSE.DUPLICATE : EVENT_CONSUMER_RESPONSE.OK;
    }
  };
}
