// Staging verification: runs the launch gate with LIVE read-only provider checks and supplier health.
// Never places real orders or charges. Exits non-zero when any blocker remains. Results are stored for /admin/launch-readiness.
import { loadConfig, loadDotEnv } from '@orvia/config';
import { connectDb, disconnectDb } from '@orvia/database';
import { buildCtx, launchReadiness, runSupplierHealthChecks } from '@orvia/core';

loadDotEnv();
const cfg = loadConfig();
await connectDb({ uri: cfg.MONGODB_URI });
const ctx = buildCtx({ cfg, service: 'verify-staging' });
try {
  await runSupplierHealthChecks(ctx).catch((e: Error) => console.warn(`[verify:staging] supplier health: ${e.message}`));
  const r = await launchReadiness(ctx, { live: true });
  for (const [area, a] of Object.entries(r.areas)) {
    console.log(`\n${a.status.padEnd(5)} ${area}`);
    for (const c of a.checks) console.log(`  ${c.status.padEnd(5)} ${c.title}${c.status === 'PASS' ? '' : ` — ${c.detail}`}`);
  }
  console.log(`\nVerdict: ${r.verdict === 'GO' ? 'GO' : 'NO-GO'}  (${r.summary.blockers} blocker(s), ${r.summary.warn} warning(s), ${r.summary.pass} pass)`);
  for (const b of r.blockers) console.log(`  BLOCKER [${b.area}] ${b.title}: ${b.detail}`);
  process.exitCode = r.verdict === 'GO' ? 0 : 1;
} finally {
  await disconnectDb();
}
