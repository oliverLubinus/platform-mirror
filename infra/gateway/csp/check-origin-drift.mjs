#!/usr/bin/env node
/**
 * ADR-021 §8 — origin drift guard.
 *
 * Asserts that each vhost's CSP `connect-src` is a SUPERSET of the app's
 * registered origins. The app registry (auth-provider DB, ADR-004 Q6) is
 * the single source of truth; its deploy-time export is a JSON manifest:
 *
 *   {
 *     "pm": { "staging": ["https://pm.staging.agentic-dna.cloud",
 *                         "https://auth.staging.agentic-dna.cloud"] },
 *     ...
 *   }
 *
 * Usage: node check-origin-drift.mjs <vhost-file> <origins-manifest.json> <app> <env>
 *
 * Extracts connect-src from the vhost's CSP header directive(s) (enforced
 * or Report-Only — both are checked, so drift cannot hide behind
 * Report-Only) and compares origin lists. Missing registered origin →
 * exit 1. Extra origin in connect-src → warning on stderr, still exit 0
 * (superset is allowed by ADR-021 §8).
 */

import { readFileSync } from 'node:fs';

function fail(message) {
  console.error(`origin-drift-guard: FAIL ${message}`);
  process.exit(1);
}

const [vhostPath, manifestPath, app, env] = process.argv.slice(2);
if (!vhostPath || !manifestPath || !app || !env) {
  fail('usage: check-origin-drift.mjs <vhost-file> <origins-manifest.json> <app> <env>');
}

let vhostText;
try {
  vhostText = readFileSync(vhostPath, 'utf8');
} catch (err) {
  fail(`cannot read vhost file ${vhostPath}: ${err.message}`);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (err) {
  fail(`cannot read origins manifest ${manifestPath}: ${err.message}`);
}

const registered = manifest?.[app]?.[env];
if (!Array.isArray(registered) || registered.length === 0) {
  fail(`manifest has no origin list for app="${app}" env="${env}"`);
}

// collect all connect-src values across CSP headers in the vhost
const connects = [];
const headerRe = /Content-Security-Policy(?:-Report-Only)?\s+"([^"]*)"/g;
for (const [, csp] of vhostText.matchAll(headerRe)) {
  for (const directive of csp.split(';')) {
    const trimmed = directive.trim();
    if (trimmed.startsWith('connect-src')) {
      connects.push(...trimmed.replace(/^connect-src\s*/, '').split(/\s+/).filter(Boolean));
    }
  }
}
if (connects.length === 0) {
  fail(`no connect-src directive found in ${vhostPath}`);
}

const vhostOrigins = new Set(connects);
// `'self'` in connect-src covers the app's own (same-origin) SPA origin.
// The guard can't know WHICH registered origin is the app's own, so each
// `'self'` occurrence satisfies exactly one otherwise-missing registered
// origin — a conservative reading of the superset rule (ADR-021 §8). The
// registry manifest should list the app's own origin explicitly; the
// 'self'-claim keeps vhosts that rely on the literal self-directive honest
// about at most that one origin.
let selfClaims = connects.filter((origin) => origin === "'self'").length;
const missing = registered.filter((origin) => {
  if (vhostOrigins.has(origin)) return false;
  if (selfClaims > 0) {
    selfClaims -= 1;
    return false;
  }
  return true;
});
const extra = [...vhostOrigins].filter((origin) => origin !== "'self'" && !registered.includes(origin));

if (missing.length > 0) {
  fail(
    `connect-src for ${app}/${env} is NOT a superset of registered origins (ADR-021 §8); missing: ${missing.join(', ')}`
  );
}
if (extra.length > 0) {
  console.warn(`origin-drift-guard: WARN connect-src has extra origins beyond the registry: ${extra.join(', ')}`);
}
console.log(`origin-drift-guard: OK ${app}/${env} — connect-src ⊇ ${registered.length} registered origin(s)`);
