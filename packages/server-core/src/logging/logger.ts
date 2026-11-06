/**
 * Platform logging contract (T1.3b — ported from auth-provider's live
 * `backend/src/shared/logger.ts`, copy → generalize).
 *
 * What carries over unchanged:
 *  - level model (debug/info/warn/error) with level filtering,
 *  - structured JSON events ({timestamp, level, message, meta}),
 *  - dev defaults (debug in development, info otherwise),
 *  - fail-safe: logging must never be able to break the request.
 *
 * What is deliberately DIFFERENT (documented):
 *  1. **One redaction implementation.** auth-provider's logger carried its
 *     own copy of the redaction logic with a DIFFERENT key set (it lacked
 *     `email`/`apiKey`, matched keys case-insensitively) — drift already
 *     realized inside a single app. Here `sanitizeLogMeta` (the ported
 *     module in `errors/sanitize.js`) is the single choke point. Net
 *     effect: `email` is now redacted in server logs too, consistent with
 *     the sensitive-data policy the module implements.
 *  2. **Transport is injectable, not bundled.** server-core stays zero-dep
 *     (AGENTS.md rule): the default logger writes structured JSON to the
 *     console and to any caller-supplied sinks. The winston + daily-rotate
 *     transport wiring from auth-provider lands in `@platform/app-template`
 *     (ops concern), not in this package.
 */

import { sanitizeLogMeta } from '../errors/sanitize.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured log metadata. Values are sanitized before any sink sees them. */
export type LogMeta = Record<string, unknown>;

/** A structured log event — the stable wire shape across all sinks. */
export interface StructuredLogEvent {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly meta?: LogMeta;
}

/**
 * The logging seam every platform module depends on (the error handler
 * takes this, never a concrete implementation). ADR-010 §3 pattern: the
 * interface is the decision; swapping the transport changes only the factory.
 */
export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

export interface LoggerOptions {
  /** Minimum level (default: debug in development, info otherwise). */
  level?: LogLevel;
  /** Console output (default true). Written as one JSON line per event. */
  enableConsole?: boolean;
  /**
   * Additional sinks — e.g. a file appender or an external log system.
   * Each receives the ALREADY-REDACTED structured event. A throwing sink
   * is swallowed: log delivery must never break the request.
   */
  sinks?: ReadonlyArray<(event: StructuredLogEvent) => void>;
}

/**
 * Default zero-dependency logger: level-filtered, structured JSON,
 * redacted through `sanitizeLogMeta` before any output.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const level: LogLevel = options.level ?? (nodeEnv === 'development' ? 'debug' : 'info');
  const enableConsole = options.enableConsole ?? true;
  const sinks = options.sinks ?? [];
  const minOrder = LEVEL_ORDER[level];

  function write(logLevel: LogLevel, message: string, meta?: LogMeta): void {
    if (LEVEL_ORDER[logLevel] < minOrder) {
      return;
    }
    const event: StructuredLogEvent = {
      timestamp: new Date().toISOString(),
      level: logLevel,
      message,
      ...(meta ? { meta: sanitizeLogMeta(meta) as LogMeta } : {})
    };
    if (enableConsole) {
      const line = JSON.stringify(event);
      if (logLevel === 'error') {
        console.error(line);
      } else if (logLevel === 'warn') {
        console.warn(line);
      } else {
        console.log(line);
      }
    }
    for (const sink of sinks) {
      try {
        sink(event);
      } catch {
        // Sink failures are swallowed by design (fail-safe logging).
      }
    }
  }

  return {
    debug: (message, meta) => write('debug', message, meta),
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta)
  };
}
