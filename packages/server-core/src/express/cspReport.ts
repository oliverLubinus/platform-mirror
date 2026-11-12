/**
 * CSP violation-report drain endpoint (ADR-021 §3 decision 3 + §4).
 *
 * The gateway vhosts send CSP `report-uri /csp-report`; nginx proxies the
 * POST to the app backend, which mounts this handler (see the PM staging
 * draft: `proxy_pass http://pm-backend:8090/csp-report`). Violations are
 * logged as structured events through the platform `Logger` seam, which
 * lands in the ADR-011 stack (container JSON logs → Alloy → Loki; Grafana
 * panel on top). No new infrastructure — the logging contract IS the pipe.
 *
 * Contract (machine-generated traffic; bare statuses, no body):
 *   204 — valid report accepted and logged
 *   400 — body present but not a recognizable CSP report shape
 *   405 — not POST
 *   413 — serialized report over the size cap
 *   415 — content type is neither application/json nor application/csp-report
 *
 * Both wire formats are accepted:
 *  - legacy `Content-Security-Policy report-uri` payload:
 *      content-type application/csp-report, shape `{ "csp-report": {...} }`
 *  - Reporting-API style JSON (newer engines POST this to report-uri too):
 *      content-type application/json, flat `{ "document-uri": ..., ... }`
 *
 * Minimal shape validation only: `document-uri` (string) is the one field
 * every CSP violation report carries. Field values are length-capped before
 * logging and pass through `sanitizeLogMeta` (the single redaction choke
 * point) via the logger — a violation report is attacker-influenced input
 * (the violated page can be attacker content), so it is treated like any
 * other untrusted request body.
 */

import type { Request, Response, NextFunction } from 'express';
import type { Logger } from '../logging/logger.js';

/** application/csp-report legacy content type. */
const CSP_REPORT_CONTENT_TYPE = 'application/csp-report';

const ACCEPTED_CONTENT_TYPES = ['application/json', CSP_REPORT_CONTENT_TYPE] as const;

/** Hard cap on the serialized report we are willing to log (bytes). */
const DEFAULT_MAX_REPORT_BYTES = 16 * 1024;

/** Per-field log cap — keeps a hostile `sample`/`source-file` from bloat. */
const MAX_FIELD_CHARS = 512;

export interface CspReportHandlerOptions {
  /** Any platform `Logger` (e.g. from `createLogger`). */
  logger: Logger;
  /** Serialized-body size cap in bytes (default 16 KiB). */
  maxReportBytes?: number;
}

interface NormalizedReport {
  documentUri: string;
  effectiveDirective?: string;
  blockedUri?: string;
  statusCode?: string;
  sourceFile?: string;
  lineNumber?: number;
  columnNumber?: number;
  sample?: string;
  disposition?: string;
}

function contentTypeMatches(header: string | undefined): boolean {
  if (!header) return false;
  const base = (header.split(';')[0] ?? '').trim().toLowerCase();
  return (ACCEPTED_CONTENT_TYPES as readonly string[]).includes(base);
}

/** Minimal shape validation + normalization; null when not a CSP report. */
function parseReport(body: unknown): NormalizedReport | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  // Legacy wire format nests the report under "csp-report"; the Reporting
  // API style is flat. Either way `document-uri` must be a string.
  const report =
    raw['csp-report'] !== undefined && typeof raw['csp-report'] === 'object' && !Array.isArray(raw['csp-report'])
      ? (raw['csp-report'] as Record<string, unknown>)
      : raw;
  const documentUri = report['document-uri'];
  if (typeof documentUri !== 'string' || documentUri.length === 0) return null;

  const str = (key: string): string | undefined => {
    const value = report[key];
    return typeof value === 'string' ? value.slice(0, MAX_FIELD_CHARS) : undefined;
  };
  const num = (key: string): number | undefined => {
    const value = report[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  };
  const documentUriTrimmed = documentUri.slice(0, MAX_FIELD_CHARS);
  const effectiveDirective = str('effective-directive');
  const blockedUri = str('blocked-uri');
  const statusCode = str('status-code');
  const sourceFile = str('source-file');
  const lineNumber = num('line-number');
  const columnNumber = num('column-number');
  const sample = str('sample');
  const disposition = str('disposition');
  return {
    documentUri: documentUriTrimmed,
    ...(effectiveDirective !== undefined ? { effectiveDirective } : {}),
    ...(blockedUri !== undefined ? { blockedUri } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(sourceFile !== undefined ? { sourceFile } : {}),
    ...(lineNumber !== undefined ? { lineNumber } : {}),
    ...(columnNumber !== undefined ? { columnNumber } : {}),
    ...(sample !== undefined ? { sample } : {}),
    ...(disposition !== undefined ? { disposition } : {})
  };
}

/**
 * Express request handler factory. Mount the JSON body parser so it accepts
 * both content types BEFORE this handler:
 *   app.post('/csp-report',
 *     express.json({ type: ['application/json', 'application/csp-report'], limit: '16kb' }),
 *     cspReportHandler({ logger }));
 */
export function cspReportHandler(options: CspReportHandlerOptions) {
  const { logger } = options;
  const maxReportBytes = options.maxReportBytes ?? DEFAULT_MAX_REPORT_BYTES;

  return function cspReport(req: Request, res: Response, _next: NextFunction): void {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      res.status(405).end();
      return;
    }
    if (!contentTypeMatches(req.headers['content-type'])) {
      res.status(415).end();
      return;
    }

    const report = parseReport(req.body);
    if (!report) {
      res.status(400).end();
      return;
    }

    const serialized = JSON.stringify(req.body);
    if (serialized.length > maxReportBytes) {
      // Log a bounded marker so volume is still visible, reject the payload.
      logger.warn('csp-violation-rejected-oversize', { bytes: serialized.length });
      res.status(413).end();
      return;
    }

    logger.warn('csp-violation', {
      documentUri: report.documentUri,
      ...(report.effectiveDirective !== undefined ? { effectiveDirective: report.effectiveDirective } : {}),
      ...(report.blockedUri !== undefined ? { blockedUri: report.blockedUri } : {}),
      ...(report.statusCode !== undefined ? { statusCode: report.statusCode } : {}),
      ...(report.sourceFile !== undefined ? { sourceFile: report.sourceFile } : {}),
      ...(report.lineNumber !== undefined ? { lineNumber: report.lineNumber } : {}),
      ...(report.columnNumber !== undefined ? { columnNumber: report.columnNumber } : {}),
      ...(report.sample !== undefined ? { sample: report.sample } : {}),
      ...(report.disposition !== undefined ? { disposition: report.disposition } : {})
    });
    res.status(204).end();
  };
}
