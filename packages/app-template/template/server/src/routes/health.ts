/**
 * @file server/src/routes/health.ts
 * @description
 *   Liveness probe. DB-free by design — a dead database must not fail the
 *   container health check (that is what readiness checks are for).
 */
import { Router } from 'express';

export function healthRouter(): Router {
  const router = Router();
  router.get('/api/health', (_req, res) => {
    res.json({ ok: true, uptime: process.uptime() });
  });
  return router;
}