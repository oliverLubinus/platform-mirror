#!/usr/bin/env node
/**
 * Onboarding rehearsal (T1.5d DoD: "fresh app scaffolds + CI green in under
 * a day"). This is the scripted, repeatable proof — not a one-off manual
 * run. It exercises the EXACT first-hour journey a new agent takes:
 *
 *   1. scaffold a fresh app from the template (placeholders + dep linking)
 *   2. pnpm install in the fresh repo (link: deps resolve from the platform)
 *   3. typecheck + test (DB-free by design — no compose needed)
 *   4. the guardrail fast checks + eslint
 *   5. production build + bundle-secret scan
 *
 * Green at the end = the template's onboarding promise holds. Red = fix the
 * template, not the rehearsal. The DoD budget is a full workday; this script
 * prints its own elapsed time, which is minutes.
 *
 * Usage:
 *   node scripts/rehearse-onboarding.mjs            # clean up afterwards
 *   node scripts/rehearse-onboarding.mjs --keep     # keep the app for inspection
 */
import { execSync } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const started = Date.now();
const keep = process.argv.includes('--keep');
const scriptsDir = fileURLToPath(new URL('.', import.meta.url));
const appTemplateRoot = resolve(scriptsDir, '..');
const target = resolve(appTemplateRoot, '.rehearsal', 'demo-app');
const scaffold = resolve(scriptsDir, 'scaffold.mjs');

function run(step, cmd, cwd) {
  console.log(`\n[rehearsal] ${step}`);
  try {
    execSync(cmd, { cwd, stdio: 'inherit', env: process.env });
  } catch {
    console.error(`\n[rehearsal] FAILED at: ${step}`);
    console.error('[rehearsal] Fix the TEMPLATE (or this script), not the symptom.');
    process.exit(1);
  }
}

if (existsSync(target)) {
  rmSync(target, { recursive: true, force: true });
}

run('1/6 scaffold', `node ${JSON.stringify(scaffold)} --name demo-app --title "Rehearsal Demo App" --target ${JSON.stringify(target)}`, appTemplateRoot);
run('2/6 install (platform deps via link:)', 'pnpm install', target);
run('3/6 typecheck', 'pnpm typecheck', target);
run('3/6 tests (DB-free)', 'pnpm test', target);
run('4/6 guardrails (whitespace, tokens, contrast, layering)', 'pnpm check:whitespace && pnpm check:design-tokens && pnpm check:contrast && pnpm check:layering', target);
run('4/6 eslint', 'pnpm lint', target);
run('5/6 production build', 'pnpm build', target);
run('5/6 bundle-secret scan', 'node client/scripts/check-bundle-secrets.cjs client/dist', target);

const minutes = ((Date.now() - started) / 60000).toFixed(1);
console.log(`\n[rehearsal] PASSED - fresh app scaffolded + CI-equivalent checks green in ${minutes} min (DoD budget: a workday).`);
if (!keep) {
  rmSync(target, { recursive: true, force: true });
  console.log('[rehearsal] rehearsal app removed (pass --keep to inspect it).');
}
