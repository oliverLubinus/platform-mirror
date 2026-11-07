#!/usr/bin/env node
/**
 * WCAG AA contrast audit — ported from auth-provider (T1.5c, R-PKG-10
 * copy → generalize; provider brand pairs dropped — the template's token
 * set is the semantic core).
 *
 * Parses the semantic token values out of src/styles/tokens.css (both
 * schemes) and verifies every canonical foreground/background pair the
 * design system relies on. Text pairs must reach >= 4.5:1, UI pairs
 * (borders, rings) >= 3:1 per WCAG. Alpha colors (soft fills) are
 * composited over the scheme background before the ratio is computed.
 *
 * Usage: node scripts/check-contrast.js
 * Exit 1 on any failing pair (blocks the quality gate).
 */

const fs = require('fs');
const path = require('path');

// scripts/check-contrast.js -> template/client
const CSS_PATH = path.resolve(__dirname, '..', 'src', 'styles', 'tokens.css');

// ---------------------------------------------------------------------------
// Color math (WCAG 2.x)
// ---------------------------------------------------------------------------
function parseColor(value) {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+))?\s*\)$/.exec(value.trim());
  if (rgb) {
    return { r: +rgb[1], g: +rgb[2], b: +rgb[3], a: rgb[4] !== undefined ? +rgb[4] : 1 };
  }
  return null;
}

function compositeOver(top, bottom) {
  const a = top.a;
  return {
    r: Math.round(top.r * a + bottom.r * (1 - a)),
    g: Math.round(top.g * a + bottom.g * (1 - a)),
    b: Math.round(top.b * a + bottom.b * (1 - a)),
  };
}

function luminance({ r, g, b }) {
  const channel = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function formatRgb({ r, g, b }) {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

// ---------------------------------------------------------------------------
// Parse the two scheme blocks out of tokens.css
// ---------------------------------------------------------------------------
function parseSchemeBlock(css, selector) {
  const re = new RegExp(`${selector}\\s*\\{([\\s\\S]*?)\\n\\}`);
  const m = re.exec(css);
  if (!m) return {};
  const vars = {};
  const declRe = /--([\w-]+)\s*:\s*([^;]+);/g;
  let d;
  while ((d = declRe.exec(m[1])) !== null) {
    vars[d[1]] = d[2].trim();
  }
  return vars;
}

function resolveToken(name, scheme, root, depth = 0) {
  if (depth > 4) return null;
  const raw = scheme[name] !== undefined ? scheme[name] : root[name];
  if (raw === undefined) return null;
  // Follow var(--x, fallback) indirection to the concrete value.
  const varRe = /^var\(\s*--([\w-]+)\s*(?:,\s*([^)]+))?\)$/;
  const v = varRe.exec(raw);
  if (v) {
    const varName = v[1];
    const schemeHas = scheme[varName] !== undefined;
    if (schemeHas) return resolveToken(varName, scheme, root, depth + 1);
    if (v[2]) return v[2].trim();
    if (root[varName] !== undefined) return resolveToken(varName, { ...root }, root, depth + 1);
    return null;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Required pairs (semantic core; UI boundary floor per WCAG 1.4.11)
// ---------------------------------------------------------------------------
const TEXT_PAIRS = [
  ['foreground', 'background'],
  ['foreground', 'surface'],
  ['foreground', 'surface-hover'],
  ['foreground', 'input-bg'],
  ['muted-foreground', 'background'],
  ['muted-foreground', 'surface'],
  ['on-primary', 'primary'],
  ['on-secondary', 'secondary'],
  ['primary', 'background'], // text-primary links on the page
  ['success', 'background'],
  ['success', 'success-soft'],
  ['warning', 'background'],
  ['warning', 'warning-soft'],
  ['error', 'background'],
  ['error', 'error-soft'],
];

const UI_PAIRS = [
  // WCAG 1.4.11 applies 3:1 to component BOUNDARIES (inputs, focus rings,
  // outline-button borders -> border-strong). Plain --border is a decorative
  // separator; the audited baseline sets a 1.4 visibility floor for it.
  ['border', 'background', 1.4],
  ['border-strong', 'surface', 3.0],
  ['border-strong', 'input-bg', 3.0],
  ['ring', 'input-bg', 3.0],
];

function main() {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  const root = parseSchemeBlock(css, ':root');
  const dark = parseSchemeBlock(css, '\\.dark');
  const failures = [];

  const checkScheme = (label, scheme) => {
    const resolve = (name) => {
      const raw = resolveToken(name, scheme, root);
      if (!raw) return null;
      return parseColor(raw);
    };
    const background = resolve('background');
    if (!background) {
      failures.push(`[${label}] cannot resolve --background`);
      return;
    }
    const evalPair = ([fgName, bgName], min) => {
      let fg = resolve(fgName);
      let bg = resolve(bgName);
      if (!fg || !bg) {
        failures.push(`[${label}] ${fgName} on ${bgName}: unresolvable token`);
        return;
      }
      if (bg.a < 1) bg = compositeOver(bg, background);
      if (fg.a < 1) fg = compositeOver(fg, background);
      const ratio = contrast(fg, bg);
      if (ratio < min) {
        failures.push(
          `[${label}] ${fgName} on ${bgName}: ${ratio.toFixed(2)}:1 (min ${min}:1) ` +
            `[${formatRgb(fg)} on ${formatRgb(bg)}]`
        );
      }
    };
    for (const pair of TEXT_PAIRS) evalPair(pair, 4.5);
    for (const [fgName, bgName, min] of UI_PAIRS) evalPair([fgName, bgName], min);
  };

  checkScheme('light', {});
  checkScheme('dark', dark);

  if (failures.length) {
    console.error(`Contrast audit FAILED (${failures.length} pair(s)):\n`);
    for (const f of failures) console.error(`  ${f}`);
    console.error(
      '\nEvery token pair used by the design system must meet WCAG AA\n' +
        '(>= 4.5:1 text, >= 3:1 UI). Fix the token values in src/styles/tokens.css,\n' +
        'not the components.'
    );
    process.exit(1);
  }
  console.log(`Contrast audit passed - ${TEXT_PAIRS.length + UI_PAIRS.length} pairs x 2 schemes, all WCAG AA.`);
}

main();
