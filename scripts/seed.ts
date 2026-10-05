import { connectDb, disconnectDb } from '@orvia/database';
import { buildCtx, registerJobs } from '@orvia/core';
import { loadConfig, loadDotEnv } from '@orvia/config';
import { runSeed, SEED_PASSWORD } from './lib/seed';

loadDotEnv();
const cfg = loadConfig();
await connectDb({ uri: cfg.MONGODB_URI, autoIndex: true });
const ctx = buildCtx({ cfg, service: 'seed' });
registerJobs(ctx);
const started = Date.now();
const res = await runSeed(ctx, { log: (m) => console.log(`[seed] ${m}`) });
console.log(`[seed] done in ${((Date.now() - started) / 1000).toFixed(1)}s`, res);
console.log(`[seed] staff logins (password: ${SEED_PASSWORD}): owner@ / admin@ / marketing@ / ops@ / support@ / analyst@orvia.test; customers customer1..12@demo.orvia.test`);
await disconnectDb();
process.exit(0);
