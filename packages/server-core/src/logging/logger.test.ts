import { deepStrictEqual, strictEqual } from 'node:assert';
import { describe, it } from 'node:test';
import { createLogger, type StructuredLogEvent } from './logger.js';

/** Captures events via an injected sink (console disabled for determinism). */
function capturingLogger(level?: 'debug' | 'info' | 'warn' | 'error') {
  const events: StructuredLogEvent[] = [];
  const logger = createLogger({
    ...(level ? { level } : {}),
    enableConsole: false,
    sinks: [(event) => events.push(event)]
  });
  return { logger, events };
}

describe('createLogger (level model + filtering)', () => {
  it('emits structured events {timestamp, level, message, meta}', () => {
    const { logger, events } = capturingLogger('debug');
    logger.info('hello', { requestId: 'r1' });
    strictEqual(events.length, 1);
    const event = events[0] as StructuredLogEvent;
    strictEqual(event.level, 'info');
    strictEqual(event.message, 'hello');
    deepStrictEqual(event.meta, { requestId: 'r1' });
    strictEqual(typeof event.timestamp, 'string');
    strictEqual(Number.isNaN(Date.parse(event.timestamp)), false);
  });

  it('filters below the configured level (error logger drops info)', () => {
    const { logger, events } = capturingLogger('error');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    deepStrictEqual(events.map((e) => e.message), ['e']);
  });

  it('level-order boundaries: warn-level logger passes warn and error', () => {
    const { logger, events } = capturingLogger('warn');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    deepStrictEqual(events.map((e) => e.level), ['warn', 'error']);
  });
});

describe('createLogger (NODE_ENV defaults — ported)', () => {
  it('development → debug default; production → info default', () => {
    const previous = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'development';
      const dev = capturingLogger();
      dev.logger.debug('visible-in-dev');
      strictEqual(dev.events.length, 1);

      process.env.NODE_ENV = 'production';
      const prod = capturingLogger();
      prod.logger.debug('hidden-in-prod');
      prod.logger.info('visible-in-prod');
      deepStrictEqual(prod.events.map((e) => e.message), ['visible-in-prod']);
    } finally {
      if (previous === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previous;
      }
    }
  });
});

describe('createLogger (single redaction choke point — T1.3b core change)', () => {
  it('meta is redacted through the ported sanitizeLogMeta before any sink', () => {
    const { logger, events } = capturingLogger('debug');
    logger.warn('attempt', {
      username: 'alice',
      password: 'hunter2',
      nested: { accessToken: 'tok', keep: 'me' }
    });
    const meta = events[0]?.meta as Record<string, unknown>;
    strictEqual(meta['username'], 'alice');
    strictEqual(meta['password'], '[REDACTED]');
    const nested = meta['nested'] as Record<string, unknown>;
    strictEqual(nested['accessToken'], '[REDACTED]');
    strictEqual(nested['keep'], 'me');
  });

  it('the unified key set covers email (tightening vs the auth-provider logger copy)', () => {
    const { logger, events } = capturingLogger('debug');
    logger.info('u', { email: 'a@b.c' });
    strictEqual((events[0]?.meta as Record<string, unknown>)['email'], '[REDACTED]');
  });
});

describe('createLogger (fail-safe sinks)', () => {
  it('a throwing sink never breaks logging or the caller', () => {
    const events: StructuredLogEvent[] = [];
    const logger = createLogger({
      level: 'info',
      enableConsole: false,
      sinks: [
        () => {
          throw new Error('sink down');
        },
        (event) => events.push(event)
      ]
    });
    // If the throwing sink could break the caller, this line itself throws.
    logger.error('still logged');
    strictEqual(events.length, 1);
  });
});

describe('createLogger (JSON line shape)', () => {
  it('console output is one JSON line per event', () => {
    const lines: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (line: string) => lines.push(line);
      const logger = createLogger({ level: 'info', enableConsole: true });
      logger.info('msg', { k: 'v' });
    } finally {
      console.log = originalLog;
    }
    strictEqual(lines.length, 1);
    const parsed = JSON.parse(lines[0] as string) as StructuredLogEvent;
    strictEqual(parsed.message, 'msg');
    deepStrictEqual(parsed.meta, { k: 'v' });
  });
});
