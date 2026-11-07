#!/usr/bin/env node
/**
 * Bundle secret scanner (T1.5c — ported from auth-provider, R-PKG-10 copy
 * → generalized). Runs AFTER the production build and scans the built
 * bundle for high-entropy strings that look like secrets. This is the
 * client-side complement of the server-side forbidden-key scan (T1.5a):
 * server secrets must never reach the client bundle, and OAuth client
 * secrets must never exist at all (public PKCE clients).
 *
 * Usage: node scripts/check-bundle-secrets.js [distDir]
 * Default dist dir: dist. Exit 1 on any finding.
 */

const fs = require('fs');
const path = require('path');

const distDir = path.resolve(process.cwd(), process.argv[2] || 'dist');

/** Shannon entropy of a string (bits per character). */
function entropy(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  let e = 0;
  for (const count of counts.values()) {
    const p = count / s.length;
    e -= p * Math.log2(p);
  }
  return e;
}

// ---------------------------------------------------------------------------
// Detection patterns
// ---------------------------------------------------------------------------
const ASSIGNMENT_PATTERNS = [
  // Server secret keys (must never be in the client bundle - T1.5a pairing)
  /(?:^|[^A-Za-z])(?:clientSecret|client_secret|apiSecret|api_secret|authSecret|auth_secret|secretKey|secret_key|privateKey|private_key|signingKey|signing_key|jwtSecret|jwt_secret|sessionSecret|session_secret|encryptionKey|encryption_key|apiKey|api_key|accessKey|access_key)\s*[:=]/gi,
  // Authorization headers carrying literal secrets
  /Bearer\s+[A-Za-z0-9\-_]{16,}/g,
  // AWS access keys
  /AKIA[0-9A-Z]{16}/g,
  // Private key blocks
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
];

// High-entropy token: >= 24 chars, mixed classes, entropy >= 4.2, no spaces.
// FALSE-POSITIVE HANDLING (platform review answer): minified framework
// internals (React "unstable_*" priority constants, dunder namespaces,
// tool identifiers) also score high entropy - they are allowlisted below.
// Everything else high-entropy and digit-bearing is reported; a real secret
// in a bundle looks exactly like a random token, which is the point.
const HIGH_ENTROPY = /[A-Za-z0-9\-_+/=]{24,}/g;

const BENIGN_TOKEN_PATTERNS = [
  /^unstable_/, // React internal API constants (e.g. unstable_UserBlockingPriority)
  /^__/, // dunder internals (e.g. __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED)
  /^react(-|\.|$)/i, // framework identifiers
  /^react-dom/i,
  /^vite(-|:|$)/i, // tooling identifiers
  /^sourcemap/i, // build metadata
];

function scanFile(filePath) {
  const findings = [];
  const rel = path.relative(process.cwd(), filePath).replace(/\\/g, '/');
  const content = fs.readFileSync(filePath, 'utf8');

  for (const pattern of ASSIGNMENT_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let m;
    while ((m = re.exec(content)) !== null) {
      findings.push(`  ${rel}: secret-key pattern near "${m[0].slice(0, 60)}"`);
    }
  }

  let m;
  const seen = new Set();
  while ((m = HIGH_ENTROPY.exec(content)) !== null) {
    const token = m[0];
    if (seen.has(token)) continue;
    seen.add(token);
    if (BENIGN_TOKEN_PATTERNS.some((re) => re.test(token))) continue;
    const hasUpper = /[A-Z]/.test(token);
    const hasLower = /[a-z]/.test(token);
    const hasDigit = /[0-9]/.test(token);
    if (hasUpper && hasLower && hasDigit && entropy(token) >= 4.2) {
      findings.push(`  ${rel}: high-entropy token "${token.slice(0, 40)}..."`);
    }
  }
  return findings;
}

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(js|css|html|map|json)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function main() {
  const files = walk(distDir);
  if (files.length === 0) {
    console.error(`Bundle secret scan: no files found in ${distDir} - run the build first.`);
    process.exit(1);
  }
  const findings = [];
  for (const file of files) {
    findings.push(...scanFile(file));
  }

  if (findings.length) {
    console.error(`Bundle secret scan FAILED (${findings.length} finding(s)):\n`);
    for (const f of findings) console.error(f);
    console.error(
      '\nClient bundles must never contain server secrets. Verify:\n' +
        '  - only VITE_-prefixed vars are referenced client-side,\n' +
        '  - no server .env value is imported into client code,\n' +
        '  - the OAuth client is a public PKCE client (no client secret).'
    );
    process.exit(1);
  }
  console.log(`Bundle secret scan passed - ${files.length} files scanned, 0 findings.`);
}

main();
