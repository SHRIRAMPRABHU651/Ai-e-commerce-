// Idempotent "migration": make sure every collection exists with the indexes the code declares.
// Mongoose never drops indexes silently here; stale indexes are reported so an operator can decide.
import mongoose from 'mongoose';
import { loadConfig, loadDotEnv } from '@orvia/config';
import { connectDb, disconnectDb } from '@orvia/database';
import { buildCtx, ensureCategories } from '@orvia/core';

loadDotEnv();
const cfg = loadConfig();
await connectDb({ uri: cfg.MONGODB_URI, autoIndex: false });
buildCtx({ cfg, service: 'migrate' });
let created = 0;
for (const name of mongoose.modelNames()) {
  const model = mongoose.model(name);
  await model.createCollection().catch(() => undefined);
  const before = (await model.collection.indexes().catch(() => [])).length;
  await model.createIndexes();
  const after = (await model.collection.indexes()).length;
  created += Math.max(0, after - before);
  const stale = (await model.diffIndexes()).toDrop;
  console.log(`[migrate] ${name}: ${after} indexes${stale.length ? ` (stale, not dropped: ${stale.join(', ')})` : ''}`);
}
await ensureCategories();
console.log(`[migrate] done — ${created} index(es) created`);
await disconnectDb();
process.exit(0);
