#!/usr/bin/env node
/**
 * Installs the pre-commit guardrail into .git/hooks/pre-commit.
 * Ported from auth-provider (T1.5c, R-PKG-10).
 *
 * Copies scripts/hooks/pre-commit.cjs into the git hooks dir to avoid
 * depending on husky/lint-staged (zero new dependencies).
 * Re-run after cloning or after `git init` in a fresh checkout.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// scripts/hooks/install-hooks.cjs -> template/client
const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'scripts', 'hooks', 'pre-commit.cjs');

// Prefer the git dir from `git rev-parse` (works for worktrees), else default.
function gitDir() {
  try {
    const out = execSync('git rev-parse --git-dir', { cwd: ROOT, encoding: 'utf8' }).trim();
    return path.resolve(ROOT, out);
  } catch {
    return path.join(ROOT, '..', '..', '.git');
  }
}

const GIT_DIR = gitDir();
const HOOKS_DIR = path.join(GIT_DIR, 'hooks');
const DEST = path.join(HOOKS_DIR, 'pre-commit');

if (!fs.existsSync(SRC)) {
  console.error(`Pre-commit script not found at ${path.relative(ROOT, SRC)}`);
  process.exit(1);
}

fs.mkdirSync(HOOKS_DIR, { recursive: true });
fs.copyFileSync(SRC, DEST);

// Make executable (best-effort; on Windows chmod is a no-op).
try {
  fs.chmodSync(DEST, 0o755);
} catch {
  /* ignore */
}

console.log('Installed pre-commit guardrail ->', path.relative(ROOT, DEST));
