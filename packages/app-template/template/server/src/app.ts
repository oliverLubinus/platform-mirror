/**
 * @file server/src/app.ts
 * @description
 *   The platform-wired Express app factory (R-PKG-09: server-core
 *   PRE-WIRED — a new app starts with the audited baseline, not blank).
 *
 *   Wiring order matters and is a contract:
 *     securityHeaders → noStore → json → requestLogger → rateLimiter →
 *     routes (requireAuth per protected route) → 404 → globalErrorHandler.
 */
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import {
  createAuditLogger,
  createLogger,
  sanitizeUrlQuery,
  type Logger,
} from '@platform/server-core';
import {
  createRateLimiter,
  globalErrorHandler,
  noStore,
  requireAuth,
  securityHeaders,
} from '@platform/server-core/express';
import type { AppConfig } from './config.js';
import { errorCodes } from './errors/errorCodes.js';
import { healthRouter } from './routes/health.js';
import { getPrisma } from './db.js';

export interface CreateAppOptions {
  config: AppConfig;
  /** Inject a logger (tests); default: the platform logger contract. */
  logger?: Logger;
}

export function createApp({ config, logger }: CreateAppOptions): Express {
  const log = logger ?? createLogger({ level: config.logLevel });
  const app = express();
  app.disable('x-powered-by');

  // Audit hook (ADR-011): single choke point. Persistence is INJECTED —
  // the demo sink logs the entry; swap in a Prisma insert when the app's
  // audit table exists. Secrets/tokens are redacted by server-core before
  // any sink sees them (R-PKG-08).
  const audit = createAuditLogger({
    hmacKey: config.auditHmacKey,
    persist: async (entry) => log.info('audit', { id: entry.id, action: entry.action }),
    logger: log,
    failureMode: config.nodeEnv === 'production' ? 'fail-closed' : 'fail-open',
  });
  void audit; // pass into routes as they mutate state; see README §Audit

  // --- platform middleware floor (H-04 headers, no-store on APIs) ---
  app.use(securityHeaders);
  app.use(noStore);
  app.use(express.json({ limit: '1mb' }));

  // --- request logging: URLs pass sanitizeUrlQuery BEFORE any sink (R-PKG-08) ---
  app.use((req: Request, res: Response, next: NextFunction) => {
    log.info('http_request', { method: req.method, url: sanitizeUrlQuery(req.url) });
    res.on('finish', () =>
      log.info('http_response', {
        method: req.method,
        url: sanitizeUrlQuery(req.url),
        status: res.statusCode,
      })
    );
    next();
  });

  // --- rate limiting (platform policy wrapper; envelope on 429) ---
  app.use(
    createRateLimiter({
      windowMs: config.rateLimitWindowMs,
      max: config.rateLimitMax,
      code: 'RATE_LIMITED',
      message: 'Too many requests',
    })
  );

  // --- routes ---
  app.use(healthRouter());

  // DB-backed example (Prisma = the platform DB standard, backlog item 4).
  // Behind requireAuth with the FAIL-CLOSED default verifier: until the real
  // JWKS verifier lands (T1.5c), no token passes — by design, not omission.
  app.get('/api/notes', requireAuth(), async (_req: Request, res: Response) => {
    const prisma = await getPrisma();
    const notes = await prisma.note.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
    res.json({ notes });
  });

  // --- 404 (platform envelope) + global error handler LAST ---
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resource not found', status: 404 } });
  });
  app.use(globalErrorHandler({ logger: log, registry: errorCodes, nodeEnv: config.nodeEnv }));

  return app;
}