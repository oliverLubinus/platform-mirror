#!/usr/bin/env node
/**
 * Pre-commit guardrail for the template client (Node version - works on
 * Windows without relying on WSL bash path handling). Ported from
 * auth-provider (T1.5c, R-PKG-10).
 *
 * Runs the FAST checks only (seconds, not minutes):
 *   1. Whitespace hard-errors on staged files (mixed EOL / missing EOF newline)
 *   2. Design-token guard (staged files): no raw palette/hex/inline styles
 *   3. WCAG AA contrast audit for both schemes (token values)
 *   4. ESLint over the client source
 *   5. TypeScript typecheck (tsc --noEmit)
 *   6. Layering ratchet: runtime UI must not import src/api directly
 *
 * The full quality gate (tests + build + bundle-secret scan) is
 * intentionally NOT here - it takes minutes and belongs in CI:
 *   pnpm check:quality-gate
 *
 * Install:  pnpm hooks:install   (copies this to .git/hooks/pre-commit)
 */

const { execSync } = require('child_process');
const path = require('path');

// The hook may be installed at .git/hooks/pre-commit, so derive the client
// root from the git top-level at runtime rather than from __dirname.
const REPO_ROOT = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
// Hook path: <repo>/template/client/scripts/hooks/pre-commit.cjs
const ROOT = path.join(REPO_ROOT, 'template', 'client');

function run(step, cmd) {
  console.log(`[pre-commit] ${step}: ${cmd}`);
  try {
    execSync(cmd, { cwd: ROOT, stdio: 'inherit', shell: true });
  } catch {
    console.error(`[pre-commit] ${step} FAILED.`);
    process.exit(1);
  }
}

run('stage 1/6 whitespace integrity (staged files)', 'node scripts/check-whitespace.cjs --staged');
run('stage 2/6 design tokens (staged files)', 'node scripts/check-design-tokens.cjs --staged');
run('stage 3/6 WCAG AA contrast (both schemes)', 'node scripts/check-contrast.cjs');
run('stage 4/6 eslint', 'npx eslint .');
run('stage 5/6 typecheck', 'npx tsc --noEmit');
run('stage 6/6 layering ratchet (UI -> hooks)', 'node scripts/check-layering.cjs');

console.log('[pre-commit] all fast checks passed.');
