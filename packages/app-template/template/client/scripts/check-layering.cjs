#!/usr/bin/env node
/**
 * Layering guard (engineering-standards G1) — ported from auth-provider
 * (T1.5c, R-PKG-10 copy → generalize; Next App Router references replaced
 * with the Vite SPA equivalents).
 *
 * Fails when a runtime UI file imports the api layer directly. Components
 * and pages must stay presentational: data access goes through use-case
 * hooks (src/hooks/**), which are the single owners of src/api/** imports.
 *
 * Allowed:
 *   - *.test.tsx / *.test.ts / *.spec.* files (they mock the api modules to
 *     pin the boundary contract - that IS the layering test).
 *   - src/hooks/** (the owners).
 *   - src/api/**, src/auth/**, src/i18n/**, src/styles/** (infrastructure,
 *     not UI presentation; auth wires api via the SDK, i18n owns copy).
 *
 * Ratchet semantics (mirrors scripts/check-design-tokens.js): files listed
 * in layering-baseline.json are legacy tolerances; new violations fail
 * hard. The baseline must only ever shrink.
 */

const fs = require('fs');
const path = require('path');

// scripts/check-layering.js -> template/client
const ROOT = path.resolve(__dirname, '..');
// Vite SPA surface: every runtime UI file under src (the hook/api/auth/i18n
// infrastructure dirs are exempt — they own the boundary, not the layout).
const SCAN_DIR = path.join(ROOT, 'src');
const EXEMPT_DIRS = ['hooks', 'api', 'auth', 'i18n', 'styles'];
const BASELINE_PATH = path.join(__dirname, 'layering-baseline.json');

// Matches any import from the api layer, including path-alias forms.
const API_IMPORT_RE = /from\s+['"](?:@\/api\/|\.{1,2}(?:\/\.{1,2})*\/api\/)/;

function listFilesRecursively(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursively(full));
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function isExempt(relPath) {
  return EXEMPT_DIRS.some((d) => relPath.startsWith(`src/${d}/`));
}

function isTestFile(file) {
  return /\.(test|spec)\.[jt]sx?$/.test(file);
}

function loadBaseline() {
  try {
    const raw = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    return Array.isArray(raw.files) ? raw.files : [];
  } catch {
    // Missing baseline file == ratchet fully closed (no legacy tolerance).
    return [];
  }
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function main() {
  const baseline = loadBaseline();
  const baselineSet = new Set(baseline);
  const files = listFilesRecursively(SCAN_DIR);

  const violations = [];
  const notices = [];

  for (const file of files) {
    const relPath = rel(file);
    if (isExempt(relPath)) continue;
    if (isTestFile(file)) continue; // tests mock the api modules by design
    const content = fs.readFileSync(file, 'utf8');
    if (API_IMPORT_RE.test(content)) {
      if (baselineSet.has(relPath)) {
        notices.push(relPath + ' (baseline legacy - still allowed, prune when migrated)');
      } else {
        violations.push(relPath);
      }
    } else if (baselineSet.has(relPath)) {
      notices.push(relPath + ' (no longer violates - REMOVE from baseline)');
    }
  }

  if (violations.length > 0) {
    console.error('Layering check FAILED - runtime UI files importing src/api:');
    for (const v of violations) {
      console.error('  ' + v);
    }
    console.error('');
    console.error('Move the API orchestration into a use-case hook (src/hooks/) and keep');
    console.error('the component presentational (render + local UI state only).');
    process.exit(1);
  }

  if (notices.length > 0) {
    console.log('Layering baseline notices:');
    for (const s of notices) {
      console.log('  ' + s);
    }
  }

  console.log(
    `Layering check passed - scanned ${files.length} UI files, ` +
      `0 new violations, ${baseline.length} baseline (legacy) entries.`
  );
}

main();
