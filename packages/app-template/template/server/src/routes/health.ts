/**
 * @file server/src/routes/health.ts
 * @description
 *   Liveness probe. DB-free by design - a dead database must not fail the
 *   container health check (that is what readiness checks are for).
 *   Expressed as a manifest handler (routes.ts is the single source of
 *   truth; the drift gate verifies the OpenAPI spec against it).
 */
import type { Request, RequestHandler, Response } from 'express';

export function healthHandler(): RequestHandler {
  return (_req: Request, res: Response) => {
    res.json({ ok: true, uptime: process.uptime() });
  };
}