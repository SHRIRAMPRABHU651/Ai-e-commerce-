// Applies the e2e-only fixtures (supplier-portal user + shipment) on top of `scripts/seed.ts`. Called by scripts/e2e.mjs. DEV ONLY.
import { connectDb, disconnectDb } from '@orvia/database';
import { buildCtx, registerJobs } from '@orvia/core';
import { loadConfig, loadDotEnv } from '@orvia/config';
import { E2E_SUPPLIER, seedE2eFixtures } from './lib/e2e-fixtures';

loadDotEnv();
const cfg = loadConfig();
await connectDb({ uri: cfg.MONGODB_URI, autoIndex: true });
const ctx = buildCtx({ cfg, service: 'seed' });
registerJobs(ctx);
const r = await seedE2eFixtures(ctx);
console.log(`[e2e-seed] supplier portal user ${E2E_SUPPLIER.email} → supplier ${E2E_SUPPLIER.code} (${r.supplierId}), shipment ${r.shipmentId} waiting to ship`);
await disconnectDb();
process.exit(0);
