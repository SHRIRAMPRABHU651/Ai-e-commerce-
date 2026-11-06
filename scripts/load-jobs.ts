/**
 * Job-throughput measurement, IN PROCESS (no HTTP load generator): how fast does ORVIA itself drain the work that orders create?
 *   1. order intake      : cart → checkout → (mock) payment, N orders through the real API handlers (fastify inject)
 *   2. fulfilment drain  : the queued jobs that place supplier orders for those orders
 *   3. tracking update   : syncTracking() over every active shipment (mock suppliers advanced by ageMockOrders), then the follow-up jobs
 *   4. supplier sync     : syncProductOffers() over published products (the offer/price/stock refresh a supplier-sync job runs)
 *
 * Usage:  MONGODB_URI=mongodb://127.0.0.1:27017/orvia_load npm run load:jobs -- --orders 100 --products 30
 *
 * SAFETY: the script DROPS the database it connects to and seeds it. It therefore refuses any database whose name does not end in `_load` or `_perf`.
 * MOCK suppliers answer in-process, so this measures ORVIA's own overhead (domain logic + MongoDB), NOT real supplier API latency, which is network-bound
 * and rate limited per supplier. Treat the numbers as an upper bound on what the worker can sustain, never as an end-to-end claim.
 * Writes perf-results.json (key `jobs`, merged into an existing file). Targets are hypotheses to be validated, not results.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import mongoose from 'mongoose';
import { loadConfig } from '@orvia/config';
import { Job, Product, connectDb, disconnectDb, syncIndexes } from '@orvia/database';
import { buildCtx, registerJobs, syncProductOffers, syncTracking } from '@orvia/core';
import { ageMockOrders, startApi } from '../tests/helpers/client';
import { firstProducts, pay, placeOrder } from '../tests/helpers/shop';
import { runSeed } from './lib/seed';

const argv = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i > -1 && argv[i + 1] ? argv[i + 1]! : d; };
const ORDERS = Number(opt('orders', '60'));
const PRODUCTS = Number(opt('products', '30'));
const OUT = opt('out', 'perf-results.json');
const uri = opt('uri', process.env['MONGODB_URI'] ?? '');
const dbName = uri.replace(/\?.*$/, '').split('/').pop() ?? '';
if (!/_(load|perf)$/.test(dbName)) {
  console.error(`Refusing to run: this script drops the database, and "${dbName || '(none)'}" does not end in _load or _perf.\nExample: MONGODB_URI=mongodb://127.0.0.1:27017/orvia_load npm run load:jobs`);
  process.exit(2);
}

/** Hypotheses to validate on real hardware. Rates are per second on the measuring host. */
const TARGETS = {
  orderIntake: { perSec: 10, note: 'checkout + payment confirmation through API handlers' },
  fulfilmentDrain: { perSec: 10, note: 'jobs that place mock-supplier orders (excludes real supplier latency)' },
  trackingUpdate: { perSec: 25, note: 'shipments polled + persisted by syncTracking (mock suppliers)' },
  supplierSync: { perSec: 5, note: 'products whose offers are refreshed by syncProductOffers (mock suppliers)' },
};

const cfg = loadConfig({ NODE_ENV: 'test', MONGODB_URI: uri, LOG_LEVEL: 'silent', MOCK_TIME_SCALE: '60' } as NodeJS.ProcessEnv);
await connectDb({ uri, autoIndex: true });
await mongoose.connection.dropDatabase();
await syncIndexes();
const ctx = buildCtx({ cfg, service: 'load' });
registerJobs(ctx);

const timed = async <T>(fn: () => Promise<T>): Promise<{ value: T; seconds: number }> => { const t = process.hrtime.bigint(); const value = await fn(); return { value, seconds: Number(process.hrtime.bigint() - t) / 1e9 }; };
const runDue = async () => { await Job.updateMany({ status: 'queued' }, { $set: { runAt: new Date(0) } }); let total = 0; for (;;) { const n = await ctx.queue.drain(200); total += n; if (!n) break; } return total; };
const rate = (n: number, s: number) => (s > 0 ? Number((n / s).toFixed(2)) : 0);
const rows: { phase: string; units: string; count: number; seconds: number; perSec: number; target: number; note: string; verdict: string }[] = [];
const record = (phase: keyof typeof TARGETS, units: string, count: number, seconds: number) => {
  const perSec = rate(count, seconds);
  const t = TARGETS[phase];
  rows.push({ phase, units, count, seconds: Number(seconds.toFixed(2)), perSec, target: t.perSec, note: t.note, verdict: count === 0 ? 'NO DATA' : perSec >= t.perSec ? 'within target (unvalidated)' : 'MISSES target' });
};

let exit = 0;
try {
  console.log(`[load-jobs] seeding ${dbName}…`);
  await runSeed(ctx, { withHistory: false, orders: 0 });
  const { client } = await startApi(ctx);
  const probe = client();
  const products = await firstProducts(probe, 'US', 8);
  if (products.length < 2) throw new Error('seed produced fewer than 2 available products');
  await runDue(); // clear seed-time jobs so the measured drain only contains work created below

  // 1. order intake
  const orderIds: string[] = [];
  const intake = await timed(async () => {
    let ok = 0;
    for (let i = 0; i < ORDERS; i++) {
      const c = client();
      c.remoteAddress = `10.${(i >> 8) & 255}.${i & 255}.${(i % 250) + 1}`; // distinct client IP per shopper: the per-IP checkout limit stays on
      const { co } = await placeOrder(c, { products, productIdx: i % products.length });
      if (co.status !== 201) throw new Error(`checkout failed: ${JSON.stringify(co.body)}`);
      const paid = await pay(c, co.body.payment.intentId);
      if (paid.status === 200) { ok++; orderIds.push(String(co.body.order.id)); }
    }
    return ok;
  });
  record('orderIntake', 'orders paid', intake.value, intake.seconds);

  // 2. fulfilment drain (supplier order placement jobs created by the paid orders)
  const drain = await timed(runDue);
  record('fulfilmentDrain', 'jobs', drain.value, drain.seconds);

  // 3. tracking update: advance the mock suppliers' clocks, then poll + persist every active shipment
  await ageMockOrders(60);
  const track = await timed(() => syncTracking(ctx, { limit: ORDERS * 3 }));
  record('trackingUpdate', 'shipments checked', track.value.checked, track.seconds);
  const follow = await timed(runDue); // notifications and status recomputation jobs triggered by the tracking updates
  console.log(`[load-jobs] tracking: checked ${track.value.checked}, updated ${track.value.updated}, failures ${track.value.failures}; follow-up jobs drained: ${follow.value} in ${follow.seconds.toFixed(2)}s`);

  // 4. supplier sync (offer/price/stock refresh)
  const ids = (await Product.find({ state: 'PUBLISHED' }).select('_id').limit(PRODUCTS).lean()).map((p) => String(p._id));
  const sync = await timed(async () => { let n = 0; for (const id of ids) { await syncProductOffers(ctx, id); n++; } return n; });
  record('supplierSync', 'products synced', sync.value, sync.seconds);

  const doc = (() => { try { return JSON.parse(readFileSync(OUT, 'utf8')) as Record<string, unknown>; } catch { return {}; } })();
  doc['jobs'] = {
    at: new Date().toISOString(), tool: 'scripts/load-jobs.ts', status: 'MEASURED ON THIS RUN ONLY: in-process, mock suppliers, same host as MongoDB; not an end-to-end or capacity claim',
    host: { cpus: cpus().length, model: cpus()[0]?.model, memGB: Math.round(totalmem() / 1e9), node: process.version }, database: dbName, orders: ORDERS, products: ids.length, results: rows,
  };
  writeFileSync(OUT, JSON.stringify(doc, null, 2));
  console.table(rows.map(({ phase, count, seconds, perSec, target, verdict }) => ({ phase, count, 'seconds': seconds, 'per sec': perSec, 'target /s': target, verdict })));
  console.log(`[load-jobs] wrote ${OUT}`);
} catch (e) {
  console.error('[load-jobs]', (e as Error).message);
  exit = 1;
} finally {
  await mongoose.connection.dropDatabase().catch(() => undefined);
  await disconnectDb();
}
process.exit(exit);
