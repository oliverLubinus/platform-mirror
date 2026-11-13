// Guard tests for the ADR-021 gateway CSP scope (guard-test culture — see
// auth-provider's nginx template guard for the pattern).
//
// Run: node --test infra/gateway/csp/check-origin-drift.test.mjs
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

// fileURLToPath (not .pathname): .pathname yields "/C:/..." on Windows and
// readFileSync throws ENOENT — found live on the owner's Windows dev machine
// during the 2d87f36 review landing (the VPS/CI never saw it).
import { fileURLToPath } from 'node:url';
const GUARD = fileURLToPath(new URL('./check-origin-drift.mjs', import.meta.url));
const TEMPLATE = fileURLToPath(new URL('./vhost-csp-report-only.inc', import.meta.url));
const WORK = mkdtempSync(join(tmpdir(), 'csp-guard-'));

function runGuard(vhost, manifest, args) {
  try {
    const { status, stdout, stderr } = spawnSync(process.execPath, [GUARD, vhost, manifest, ...args], {
      encoding: 'utf8'
    });
    return { code: status, stdout: stdout ?? '', stderr: stderr ?? '' };
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

after(() => rmSync(WORK, { recursive: true, force: true }));

const MANIFEST = {
  pm: { staging: ['https://pm.staging.agentic-dna.cloud', 'https://auth.staging.agentic-dna.cloud'] }
};
const manifestPath = join(WORK, 'origins.json');
writeFileSync(manifestPath, JSON.stringify(MANIFEST));

describe('ADR-021 §8 origin drift guard (check-origin-drift.mjs)', () => {
  it('superset connect-src passes (PM staging draft shape, Report-Only header)', () => {
    const vhost = join(WORK, 'ok.vhost.conf');
    writeFileSync(
      vhost,
      `add_header Content-Security-Policy-Report-Only "default-src 'self'; connect-src 'self' https://auth.staging.agentic-dna.cloud; report-uri /csp-report" always;`
    );
    const { code, stdout } = runGuard(vhost, manifestPath, ['pm', 'staging']);
    strictEqual(code, 0);
    ok(stdout.includes('OK pm/staging'));
  });

  it('missing registered origin → exit 1 with the missing origin named', () => {
    const vhost = join(WORK, 'drift.vhost.conf');
    writeFileSync(
      vhost,
      `add_header Content-Security-Policy "connect-src 'self'" always;`
    );
    const { code, stderr } = runGuard(vhost, manifestPath, ['pm', 'staging']);
    strictEqual(code, 1);
    ok(stderr.includes('https://auth.staging.agentic-dna.cloud'));
  });

  it('extra origin is a warning, not a failure (superset is allowed)', () => {
    const vhost = join(WORK, 'extra.vhost.conf');
    writeFileSync(
      vhost,
      `add_header Content-Security-Policy "connect-src 'self' https://auth.staging.agentic-dna.cloud https://chat.staging.agentic-dna.cloud" always;`
    );
    const { code, stderr } = runGuard(vhost, manifestPath, ['pm', 'staging']);
    strictEqual(code, 0);
    ok(stderr.includes('WARN'));
  });

  it('checks BOTH enforced and Report-Only headers (drift cannot hide behind Report-Only)', () => {
    const vhost = join(WORK, 'ro.vhost.conf');
    writeFileSync(
      vhost,
      `add_header Content-Security-Policy-Report-Only "connect-src 'self'" always;`
    );
    const { code } = runGuard(vhost, manifestPath, ['pm', 'staging']);
    strictEqual(code, 1);
  });

  it('no connect-src at all → fail; unknown app/env → fail', () => {
    const empty = join(WORK, 'empty.conf');
    writeFileSync(empty, 'server { listen 443; }');
    strictEqual(runGuard(empty, manifestPath, ['pm', 'staging']).code, 1);
    strictEqual(runGuard(empty, manifestPath, ['ghost', 'staging']).code, 1);
  });
});

describe('ADR-021 §3 CSP baseline template guard (vhost-csp-report-only.inc)', () => {
  const template = () => readFileSync(TEMPLATE, 'utf8');

  it('emits the Report-Only header (enforcement flips at PM cutover, documented)', () => {
    ok(template().includes('Content-Security-Policy-Report-Only'));
    ok(template().includes('FLIP'));
  });

  it('contains the full ADR-021 §3 baseline directive set', () => {
    const csp = template().match(/Content-Security-Policy-Report-Only "([^"]*)"/)?.[1] ?? '';
    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      'connect-src $csp_connect_src',
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      'upgrade-insecure-requests',
      'report-uri /csp-report'
    ]) {
      ok(csp.includes(directive), `baseline must contain: ${directive}`);
    }
    deepStrictEqual(csp.split(';').length, 12);
  });

  it('script-src never carries unsafe-inline (ADR-021 §3: never, for scripts)', () => {
    const scriptSrc = template().match(/script-src ([^;]*);/)?.[1] ?? '';
    ok(!scriptSrc.includes('unsafe-inline'), `script-src must stay strict, got: ${scriptSrc}`);
  });
});
