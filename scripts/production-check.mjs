// Release gate. Exits non-zero unless everything that can be verified locally actually passes.
// Usage: npm run production-check [-- --skip-e2e]
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const skipE2e = process.argv.includes('--skip-e2e') || process.argv.includes('--scan-only');
const scanOnly = process.argv.includes('--scan-only'); // assumes lint/test/build already ran (CI)
const results = [];
const step = (name, fn) => {
  const t = Date.now();
  let ok = false, note = '';
  try { const r = fn(); ok = r === undefined || r === true || r?.ok; note = r?.note ?? ''; } catch (e) { note = e.message; }
  results.push({ name, ok, note, s: ((Date.now() - t) / 1000).toFixed(1) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? ` — ${note}` : ''}`);
};
const sh = (cmd, args, env = {}) => spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } }).status === 0;

if (!scanOnly) {
  step('lint', () => sh('npm', ['run', 'lint']));
  step('typecheck', () => sh('npm', ['run', 'typecheck']));
  step('unit + integration + failure + security tests', () => sh('npm', ['test']));
  step('production build', () => sh('npm', ['run', 'build']));
}

// Production configuration must refuse mock providers and weak secrets (proves the guard is live).
step('production config guard rejects mock providers', () => {
  const r = spawnSync('node', ['--input-type=module', '-e', "import('./apps/api/dist/main.js')"], { env: { PATH: process.env.PATH, NODE_ENV: 'production', MONGODB_URI: 'mongodb://127.0.0.1:1/x' }, encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`;
  return { ok: r.status !== 0 && /Unsafe production configuration/.test(out), note: /Unsafe production configuration/.test(out) ? 'refused to start as expected' : 'API started with unsafe production config!' };
});

// Secrets must never reach the browser bundle or the repo.
const SECRET_NAMES = ['GEMINI_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'RAZORPAY_KEY_SECRET', 'CJ_API_KEY', 'META_ACCESS_TOKEN', 'JWT_SECRET', 'TWILIO_AUTH_TOKEN', 'GOOGLE_ADS_DEVELOPER_TOKEN'];
const walk = (dir, out = []) => { for (const f of readdirSync(dir)) { const p = join(dir, f); const st = statSync(p); if (st.isDirectory()) walk(p, out); else out.push(p); } return out; };
// Variable *names* may appear as admin UI hints; what must never ship is a read of the variable or a key-shaped value.
step('no secret values or env reads in browser bundle', () => {
  const files = walk('apps/web/.next/static').filter((f) => /\.(js|css|html)$/.test(f));
  const names = SECRET_NAMES.join('|');
  const rx = new RegExp(`process\\.env\\.(${names})|(${names})["']?\\s*[:=]\\s*["'][^"']{8,}|sk_live_[0-9a-zA-Z]{10,}|sk_test_[0-9a-zA-Z]{10,}|whsec_[0-9a-zA-Z]{10,}|AIza[0-9A-Za-z_-]{35}|AKIA[0-9A-Z]{16}`);
  const hits = files.filter((f) => rx.test(readFileSync(f, 'utf8')));
  return { ok: hits.length === 0, note: hits.length ? `found in ${hits.slice(0, 3).join(', ')}` : `${files.length} files scanned` };
});
step('no NEXT_PUBLIC_ variable carries a secret', () => {
  const files = walk('apps/web/src').concat(['.env.example']);
  const bad = files.filter((f) => /NEXT_PUBLIC_\w*(SECRET|API_KEY|TOKEN)/i.test(readFileSync(f, 'utf8')));
  return { ok: bad.length === 0, note: bad.join(', ') };
});
step('.env is not tracked by git', () => {
  const r = spawnSync('git', ['ls-files', '.env', '.env.production'], { encoding: 'utf8' });
  return { ok: r.stdout.trim() === '', note: r.stdout.trim() };
});
step('no committed credentials (key patterns)', () => {
  const r = spawnSync('git', ['ls-files'], { encoding: 'utf8' });
  const rx = /(sk_live_[0-9a-zA-Z]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|-----BEGIN (RSA |EC )?PRIVATE KEY-----)/;
  const bad = r.stdout.split('\n').filter((f) => f && !f.endsWith('package-lock.json') && (() => { try { return rx.test(readFileSync(f, 'utf8')); } catch { return false; } })());
  return { ok: bad.length === 0, note: bad.join(', ') };
});
step('terraform static structure (not terraform validate)', () => { const r = spawnSync('node', ['scripts/terraform-static-check.mjs'], { encoding: 'utf8' }); return { ok: r.status === 0, note: r.status === 0 ? 'structure ok; run terraform validate separately' : r.stdout.trim().split('\n').slice(1).join('; ') }; });
if (!skipE2e) step('end-to-end (Playwright desktop + mobile)', () => sh('npm', ['run', 'e2e']));

const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
writeFileSync('.certification.json', JSON.stringify({ at: new Date().toISOString(), commit, checks: Object.fromEntries(results.map((r) => [r.name, r.ok ? 'PASS' : 'FAIL'])), partial: skipE2e || scanOnly }, null, 2));
console.log('Wrote .certification.json (store it with: npx tsx scripts/record-certification.ts)');
const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? 'ALL CHECKS PASSED' : `${failed.length} CHECK(S) FAILED: ${failed.map((f) => f.name).join('; ')}`}`);
console.log('Note: passing checks do not prove live-provider integrations (Stripe, Razorpay, CJ, Meta, TikTok, Google) — verify those in staging with real sandbox credentials.');
process.exit(failed.length ? 1 : 0);
