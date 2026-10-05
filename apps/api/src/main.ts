import { Redis } from 'ioredis';
import { loadConfig, loadDotEnv } from '@orvia/config';
import { connectDb, disconnectDb } from '@orvia/database';
import { buildCtx, ensureCategories } from '@orvia/core';
import { buildServer } from './server';

loadDotEnv();
const cfg = loadConfig();
const ctx = buildCtx({ cfg, service: 'api' });
await connectDb({ uri: cfg.MONGODB_URI, autoIndex: !cfg.isProduction });
await ensureCategories();

let redis: Redis | null = null;
if (cfg.REDIS_URL) {
  redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2000, retryStrategy: (n) => Math.min(n * 500, 5000) });
  redis.on('error', (e) => ctx.log.warn({ channel: 'app', err: e.message }, 'redis unavailable (continuing without it)'));
}

// In dev/test the API can also process jobs so a single `npm run dev:api` is self-sufficient.
const inline = process.env.API_INLINE_WORKER === 'true' && !cfg.isProduction;
const app = await buildServer(ctx, { redis, withJobHandlers: inline });
if (inline) ctx.queue.start({ concurrency: 2, pollMs: 1000 });
await app.listen({ port: cfg.API_PORT, host: cfg.API_HOST });
ctx.log.info({ channel: 'app', port: cfg.API_PORT, env: cfg.APP_ENV, inlineWorker: inline }, 'orvia api listening');

const shutdown = async (sig: string) => {
  ctx.log.info({ channel: 'app', sig }, 'shutting down');
  await app.close();
  if (inline) await ctx.queue.stop();
  redis?.disconnect();
  await disconnectDb();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
