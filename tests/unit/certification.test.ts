import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { certificationStatus } from '@orvia/core';

describe('certification status: an unrun check is never a PASS', () => {
  const ok = { lint: 'PASS', typecheck: 'PASS', 'terraform validate': 'PASS' };
  it('is PASS only when every check passed and the run was not partial', () => {
    expect(certificationStatus({ checks: ok }).status).toBe('PASS');
  });
  it('a SKIP makes it INCOMPLETE (WARN), naming the skipped check', () => {
    const r = certificationStatus({ checks: { ...ok, 'terraform validate': 'SKIP' } });
    expect(r.status).toBe('WARN');
    expect(r.reason).toMatch(/INCOMPLETE.*terraform validate \(SKIP\)/);
  });
  it('a partial run, an unknown value or a missing record can never be PASS; any FAIL fails', () => {
    expect(certificationStatus({ checks: ok, partial: true }).status).toBe('WARN');
    expect(certificationStatus({ checks: { ...ok, lint: 'MAYBE' } }).status).toBe('WARN');
    expect(certificationStatus(undefined).status).toBe('WARN');
    expect(certificationStatus({ checks: { ...ok, lint: 'FAIL', 'terraform validate': 'SKIP' } }).status).toBe('FAIL');
  });
});

describe('production-check records a skipped Terraform step as SKIP, not PASS', () => {
  it('writes SKIP + partial=true to .certification.json when the terraform binary is absent, and that record cannot certify', () => {
    const has = spawnSync('terraform', ['version']);
    if (has.status === 0) return; // binary present: the step really runs; the SKIP path is covered by the pure tests above
    const backup = existsSync('.certification.json') ? '.certification.json.bak' : null;
    if (backup) renameSync('.certification.json', backup);
    try {
      const env = { ...process.env, PATH: process.env.PATH ?? '' } as NodeJS.ProcessEnv;
      delete env.CI;
      const r = spawnSync('node', ['scripts/production-check.mjs', '--only', 'terraform validate'], { env, encoding: 'utf8' });
      expect(r.stdout).toMatch(/SKIP\s+terraform validate/);
      expect(r.stdout).toMatch(/NOT A FULL CERTIFICATION/);
      expect(r.stdout).not.toMatch(/ALL CHECKS PASSED/);
      const cert = JSON.parse(readFileSync('.certification.json', 'utf8'));
      expect(cert.checks['terraform validate']).toBe('SKIP');
      expect(cert.partial).toBe(true);
      expect(Object.keys(cert.checks)).toEqual(['terraform validate']);
      expect(Object.values(cert.checks)).not.toContain('FAIL');
      expect(certificationStatus(cert).status).toBe('WARN');
      // and on a CI runner without the binary it is a hard failure
      const ci = spawnSync('node', ['scripts/production-check.mjs', '--only', 'terraform validate'], { env: { ...env, CI: 'true' }, encoding: 'utf8' });
      expect(ci.status).toBe(1);
      expect(ci.stdout).toMatch(/FAIL\s+terraform validate/);
    } finally {
      rmSync('.certification.json', { force: true });
      if (backup) renameSync(backup, '.certification.json');
    }
  }, 120_000);
});
