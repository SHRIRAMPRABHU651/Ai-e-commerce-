// Stores a production-check result (JSON on stdin or .certification.json) so /admin/launch-readiness can show it.
import { readFileSync } from 'node:fs';
import { loadConfig, loadDotEnv } from '@orvia/config';
import { connectDb, disconnectDb } from '@orvia/database';
import { buildCtx } from '@orvia/core';

loadDotEnv();
const cfg = loadConfig();
const rec = JSON.parse(readFileSync('.certification.json', 'utf8')) as { at: string; commit?: string; checks: Record<string, string> };
await connectDb({ uri: cfg.MONGODB_URI });
const ctx = buildCtx({ cfg, service: 'certify' });
await ctx.settings.set('launch', { certification: rec } as never, 'production-check');
console.log(`[certify] recorded ${Object.keys(rec.checks).length} checks @ ${rec.commit ?? 'unknown commit'}`);
await disconnectDb();
