#!/usr/bin/env node
/**
 * Design-token guard — ported from auth-provider (T1.5c, R-PKG-10 copy →
 * generalize). Fails when raw palette classes, inline styles, or raw hex
 * colors appear in app source outside the allowlist. This keeps the design
 * system in control: all colors must come from the semantic tokens in
 * src/styles/tokens.css.
 *
 * Usage:
 *   node scripts/check-design-tokens.js           # scan src/
 *   node scripts/check-design-tokens.js --staged  # scan only staged files
 *
 * Allowlist (documented, narrow):
 *   - src/styles/tokens.css     -> the token definitions themselves
 *   - src/styles/**             -> the style layer (composes tokens)
 *   - *.test.tsx / __tests__    -> test fixtures
 *   - svg fill="#fff" etc.      -> brand MARKS in icon paths (exact hexes)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// scripts/check-design-tokens.js -> template/client
const ROOT = path.resolve(__dirname, '..');

const SCAN_DIRS = ['src'];

// Raw Tailwind palette prefixes (bg-blue-600, text-amber-700, dark:bg-zinc-900, ...)
const PALETTE_CLASS = new RegExp(
  "(?:bg|text|border|ring|divide|from|to|via|shadow|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|100|200|300|400|500|600|700|800|900|950)\\b" +
    "|(?:bg|text|border)-(?:white|black)\\b"
);

// Inline style objects (requirement: prefer token classes, avoid inline styles).
const INLINE_STYLE = /style=\{\{/;

// Raw hex colors in className/style strings. SVG fill/stroke attrs are
// handled via the allowlist strip below (brand marks keep exact brand hexes).
const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/;

const ALLOWED_FILE_PATTERNS = [
  /src[/\\]styles[/\\]tokens\.css$/,
  /src[/\\]styles[/\\]/,
  /__tests__[/\\]/,
  /\.test\.tsx?$/,
  /scripts[/\\]check-design-tokens\.js$/,
];

// In .tsx sources, hex is only tolerated inside SVG paint attributes
// (brand marks of icons); anywhere else it is a violation.
const SVG_PAINT_ATTR = /(?:fill|stroke)="#[0-9a-fA-F]{3,8}"/g;

function listStagedFiles() {
  try {
    const out = execSync('git diff --cached --name-only --diff-filter=ACM', { encoding: 'utf8', cwd: ROOT });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function listAllFiles() {
  const files = [];
  for (const dir of SCAN_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    const stack = [abs];
    while (stack.length) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          stack.push(full);
        } else if (/\.(tsx?|css)$/.test(entry.name)) {
          files.push(full);
        }
      }
    }
  }
  return files;
}

function isAllowed(relPath) {
  return ALLOWED_FILE_PATTERNS.some((re) => re.test(relPath));
}

function checkFile(absPath, relPath) {
  const errors = [];
  const content = fs.readFileSync(absPath, 'utf8');
  const lines = content.split(/\r?\n/);

  // Strip SVG paint attributes before the hex check so brand marks pass.
  // Comment lines are skipped: documentation may mention raw syntax.
  const stripped = lines.map((line) => {
    const noSvg = line.replace(SVG_PAINT_ATTR, (m) => ' '.repeat(m.length));
    return /^\s*(?:\*|\/\/)/.test(noSvg) ? ' '.repeat(noSvg.length) : noSvg;
  });

  lines.forEach((line, i) => {
    if (/^\s*(?:\*|\/\/)/.test(line)) return;
    const ln = String(i + 1);
    if (PALETTE_CLASS.test(line)) {
      errors.push(`  [${relPath}:${ln}] raw palette class: ${line.trim().slice(0, 120)}`);
    }
    if (INLINE_STYLE.test(line)) {
      errors.push(`  [${relPath}:${ln}] inline style (use token classes): ${line.trim().slice(0, 120)}`);
    }
  });

  stripped.forEach((line, i) => {
    if (/^\s*(?:\*|\/\/)/.test(line)) return;
    if (HEX_COLOR.test(line)) {
      errors.push(
        `  [${relPath}:${i + 1}] raw hex color (use a token in src/styles/tokens.css): ${line.trim().slice(0, 120)}`
      );
    }
  });

  return errors;
}

/**
 * Baseline ratchet: legacy files that predate the design system are listed
 * in design-token-baseline.json. Violations there are reported as debt
 * (non-fatal) and must be pruned by the migration; NEW files can never
 * introduce violations. The baseline only ever shrinks.
 */
function loadBaseline() {
  const file = path.join(__dirname, 'design-token-baseline.json');
  if (!fs.existsSync(file)) return new Set();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Set(raw.files || []);
  } catch (err) {
    // A baseline that exists but cannot be parsed is a configuration error:
    // fail loudly instead of silently treating it as empty.
    console.error(`Design-token check FAILED: ${path.basename(file)} is not valid JSON (${err.message}).`);
    process.exit(1);
  }
}

let stagedCache = null;
function listStagedFilesCached() {
  if (!stagedCache) stagedCache = listStagedFiles();
  return stagedCache;
}

function main() {
  const staged = process.argv.includes('--staged');
  const all = listAllFiles();
  const files = staged
    ? all.filter((f) => {
        const rel = path.relative(ROOT, f).replace(/\\/g, '/');
        return listStagedFilesCached().includes(rel);
      })
    : all;

  const baseline = loadBaseline();
  const debt = []; // tolerated legacy violations (baseline files)
  const errors = []; // new violations -> fatal
  const debtFilesSeen = new Set();

  for (const abs of files) {
    const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
    if (isAllowed(rel)) continue;
    const fileErrors = checkFile(abs, rel);
    if (!fileErrors.length) continue;
    if (baseline.has(rel)) {
      debtFilesSeen.add(rel);
      debt.push(...fileErrors);
    } else {
      errors.push(...fileErrors);
    }
  }

  if (debt.length) {
    console.warn(
      `Design-token check: ${debt.length} legacy violation(s) in ${debtFilesSeen.size} baseline ` +
        'file(s) - tolerated until the migration (scripts/design-token-baseline.json).'
    );
  }
  const prunable = [...baseline].filter((f) => !debtFilesSeen.has(f));
  if (prunable.length) {
    console.warn(`Baseline entries now clean (prune scripts/design-token-baseline.json): ${prunable.join(', ')}`);
  }

  if (errors.length) {
    console.error(`Design-token check FAILED (${errors.length} new violation(s) outside baseline):\n`);
    for (const e of errors) console.error(e);
    console.error(
      '\nAll colors must come from semantic tokens in src/styles/tokens.css.\n' +
        'Inline styles are not allowed; use token-driven classes.\n' +
        'Need a new color? Add a token (light + dark) instead of a raw value.\n' +
        'Legacy debt is tolerated ONLY in files listed in\n' +
        'scripts/design-token-baseline.json.'
    );
    process.exit(1);
  }
  console.log(
    `Design-token check passed - scanned ${files.length} files, 0 new violations, ${debt.length} baseline (legacy).`
  );
}

main();
