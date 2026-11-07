#!/usr/bin/env node
/**
 * Whitespace integrity check — ported from auth-provider (T1.5c, R-PKG-10
 * copy → generalize). Classifies whitespace issues into:
 *
 *  HARD errors (exit 1, should block commits/CI):
 *    - Mixed CRLF/LF line endings within a single file (can corrupt builds/git)
 *    - Missing trailing newline at EOF for staged files
 *
 *  WARNINGS (informational, repo-wide convention today - do NOT block):
 *    - Trailing whitespace
 *    - Runs of 2+ consecutive blank lines
 *
 * Usage:
 *   node scripts/check-whitespace.js                 # scan client src files
 *   node scripts/check-whitespace.js --staged        # scan staged files only (git)
 *   node scripts/check-whitespace.js <file> [file..] # explicit files
 *
 * Exit 0 = no hard errors (warnings may exist). Exit 1 = hard errors found.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// scripts/check-whitespace.js -> template/client
const ROOT = path.resolve(__dirname, '..');

const STAGED_MODE = process.argv.includes('--staged');
const fileArgs = process.argv.slice(2).filter((a) => a !== '--staged');

function collectFiles(dir, extensions) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath, extensions));
    } else if (entry.isFile() && extensions.some((ext) => fullPath.endsWith(ext))) {
      files.push(fullPath);
    }
  }
  return files;
}

function targetFiles() {
  if (STAGED_MODE) {
    try {
      const top = execSync('git rev-parse --show-toplevel', { cwd: ROOT, encoding: 'utf8' }).trim();
      const out = execSync('git diff --cached --name-only --diff-filter=ACM', { cwd: ROOT, encoding: 'utf8' });
      return out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .filter((f) => /\.(ts|tsx|js|jsx|mjs|css)$/.test(f))
        .map((f) => path.resolve(top, f))
        .filter((f) => fs.existsSync(f));
    } catch {
      console.error('  (skipped: not a git repo or git unavailable)');
      return [];
    }
  }
  if (fileArgs.length > 0) {
    return fileArgs.map((a) => path.resolve(ROOT, a));
  }
  return collectFiles(path.join(ROOT, 'src'), ['.ts', '.tsx', '.js', '.jsx', '.css']);
}

function toRel(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function checkFile(filePath) {
  const warnings = [];
  const errors = [];
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r\n|\r|\n/);
  const rel = toRel(filePath);

  // WARN: trailing whitespace
  lines.forEach((line, i) => {
    if (/[ \t]+$/.test(line)) {
      warnings.push({ file: rel, line: i + 1, detail: 'Trailing whitespace' });
    }
  });

  // WARN: runs of 2+ consecutive blank lines
  let blankRun = 0;
  lines.forEach((line, i) => {
    if (line.trim() === '') {
      blankRun += 1;
      if (blankRun === 2) {
        warnings.push({ file: rel, line: i + 1, detail: 'Multiple consecutive blank lines' });
      }
    } else {
      blankRun = 0;
    }
  });

  // ERROR: mixed line endings
  const crlf = (content.match(/\r\n/g) || []).length;
  const lfOnly = (content.match(/(?<!\r)\n/g) || []).length;
  if (crlf > 0 && lfOnly > 0) {
    errors.push({ file: rel, line: 0, detail: `Mixed line endings (CRLF x${crlf}, LF x${lfOnly})` });
  }

  // ERROR: missing trailing newline at EOF
  const hasTrailingNewline = /\r\n$|\n$|\r$/.test(content);
  if (!hasTrailingNewline && content.length > 0) {
    errors.push({ file: rel, line: lines.length, detail: 'Missing trailing newline at EOF' });
  }

  return { warnings, errors };
}

function main() {
  const files = targetFiles();
  const allWarnings = [];
  const allErrors = [];

  for (const file of files) {
    const { warnings, errors } = checkFile(file);
    allWarnings.push(...warnings);
    allErrors.push(...errors);
  }

  if (allWarnings.length > 0) {
    console.warn('\nWhitespace integrity check - WARNINGS (non-blocking):');
    for (const w of allWarnings.slice(0, 25)) {
      console.warn(`  [${w.line > 0 ? `line ${w.line}` : 'file'}] ${w.file} - ${w.detail}`);
    }
    if (allWarnings.length > 25) {
      console.warn(`  ...and ${allWarnings.length - 25} more warnings`);
    }
  }

  if (allErrors.length > 0) {
    console.error('\nWhitespace integrity check FAILED (hard errors):');
    for (const e of allErrors) {
      console.error(`  [${e.line > 0 ? `line ${e.line}` : 'file'}] ${e.file} - ${e.detail}`);
    }
    console.error(`Total hard errors: ${allErrors.length}`);
    process.exit(1);
  }

  console.log(
    `Whitespace integrity check passed (hard) - scanned ${files.length} files, ` +
      `${allWarnings.length} warnings, 0 hard errors.`
  );
}

main();
