/**
 * @file server/src/app.ts
 * @description
 *   The platform-wired Express app factory (R-PKG-09: server-core
 *   PRE-WIRED - a new app starts with the audited baseline, not blank).
 *
 *   Wiring order matters and is a contract:
 *     securityHeaders -> noStore -> json -> requestLogger -> rateLimiter ->
 *     routes (requireAuth per protected route, manifest-driven) -> 404 ->
 *     globalErrorHandler.
 *
 *   T1.5c: routes mount FROM the manifest (routes.ts) - implementation,
 *   OpenAPI spec, and permission catalog can never drift apart; the real
 *   HS256 token verifier (server-core createTokenVerifier) replaces the
 *   fail-closed stub, and the notes store is injected for DB-free tests.
 */
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import {
  createAuditLogger,
  createLogger,
  createTokenVerifier,
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
import { routeManifest, type RouteSpec } from './routes.js';
import { healthHandler } from './routes/health.js';
import {
  createNoteHandler,
  createPrismaNotesStore,
  listNotesHandler,
  type NotesStore,
} from './routes/notes.js';

export interface CreateAppOptions {
  config: AppConfig;
  /** Inject a logger (tests); default: the platform logger contract. */
  logger?: Logger;
  /** Inject the notes store (tests); default: the lazy Prisma-backed store. */
  db?: NotesStore;
}

export function createApp({ config, logger, db }: CreateAppOptions): Express {
  const log = logger ?? createLogger({ level: config.logLevel });
  const app = express();
  app.disable('x-powered-by');

  // Audit hook (ADR-011): single choke point. Persistence is INJECTED -
  // the demo sink logs the entry; swap in a Prisma insert when the app's
  // audit table exists. Secrets/tokens are redacted by server-core before
  // any sink sees them (R-PKG-08).
  const audit = createAuditLogger({
    hmacKey: config.auditHmacKey,
    persist: async (entry) => log.info('audit', { id: entry.id, action: entry.action }),
    logger: log,
    failureMode: config.nodeEnv === 'production' ? 'fail-closed' : 'fail-open',
  });
  void audit; // pass into routes as they mutate state; see README Audit section

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

  // --- the REAL token verifier (T1.5c) ---
  // HS256 key-ring verification of auth-provider-issued JWTs (iss/aud/exp
  // contract). Config problems throw at creation (fail fast). The key ring
  // is the issuer JWT_SIGNING_KEYS, shared per environment.
  const verify = createTokenVerifier({
    keys: config.jwtSigningKeys,
    issuer: config.issuerUrl,
    audience: config.audience,
  });

  // --- routes: mounted FROM the manifest (implementation <-> spec <-> catalog) ---
  const notesStore: NotesStore = db ?? createPrismaNotesStore();
  const handlers: Record<string, RequestHandler> = {
    getHealth: healthHandler(),
    listNotes: listNotesHandler(notesStore),
    createNote: createNoteHandler(notesStore),
  };

  const mount = (spec: RouteSpec): void => {
    const handler = handlers[spec.operationId];
    if (handler === undefined) {
      throw new Error(`CONFIG_INVALID: manifest operation "${spec.operationId}" has no handler`);
    }
    const chain: RequestHandler[] = spec.auth === 'bearer' ? [requireAuth({ verify })] : [];
    app[spec.method](spec.path, ...chain, handler);
  };
  routeManifest.forEach(mount);

  // --- 404 (platform envelope) + global error handler LAST ---
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resource not found', status: 404 } });
  });
  app.use(globalErrorHandler({ logger: log, registry: errorCodes, nodeEnv: config.nodeEnv }));

  return app;
}