#!/usr/bin/env node
/**
 * Scaffold a new platform app from this template (R-PKG-09).
 *
 *   node scripts/scaffold.mjs --name my-app --title "My App" --target ../my-app
 *
 * Copies template/ to the target, rewrites the {{APP_SLUG}} / {{APP_TITLE}}
 * placeholders, and prints the next steps. The platform repo stays untouched.
 */
import { cpSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
function arg(flag) {
  const i = args.indexOf(flag);
  if (i === -1 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

const name = arg('--name');
const target = arg('--target');
if (!name || !target) {
  console.error('usage: node scripts/scaffold.mjs --name <slug> --target <dir> [--title "Title"]');
  process.exit(1);
}
const title = arg('--title') ?? name;
const slug = name.toLowerCase().replaceAll(/[^a-z0-9-]/g, '-');
const dest = resolve(target);

if (existsSync(dest)) {
  console.error(`refusing: target ${dest} already exists`);
  process.exit(1);
}

const source = new URL('../template/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
cpSync(source, dest, { recursive: true, filter: (src) => {
  const base = src.replaceAll('\\\\', '/').split('/').pop();
  // never copy build outputs or installed deps into a fresh app
  return base !== 'dist' && base !== 'node_modules' && base !== '.turbo';
} });

// Rewrite placeholders across text files (binary-safe: only .json/.md/.yml/.ts/.html/.example/.gitignore).
const textExts = new Set(['.json', '.md', '.yml', '.yaml', '.ts', '.tsx', '.html', '.example']);
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    const ext = entry.slice(entry.lastIndexOf('.'));
    if (!textExts.has(ext) && !entry.startsWith('.env')) continue;
    const content = readFileSync(full, 'utf8');
    writeFileSync(full, content.replaceAll('{{APP_SLUG}}', slug).replaceAll('{{APP_TITLE}}', title));
  }
}
walk(dest);

console.log(`scaffolded ${slug} -> ${dest}`);
console.log('next steps:');
console.log('  cd ' + dest);
console.log('  git init && pnpm install');
console.log('  cp .env.example .env  (then: pnpm db:up && pnpm db:migrate && pnpm db:seed)');
console.log('  pnpm dev:server   # terminal 1');
console.log('  pnpm dev:client   # terminal 2');