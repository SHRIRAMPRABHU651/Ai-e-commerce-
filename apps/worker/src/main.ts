import { createServer } from 'node:http';
import { loadConfig, loadDotEnv, metrics } from '@orvia/config';
import { connectDb, disconnectDb, dbReady } from '@orvia/database';
import { buildCtx, createScheduler, ensureCategories, registerJobs } from '@orvia/core';

loadDotEnv();
const cfg = loadConfig();
const ctx = buildCtx({ cfg, service: 'worker' });
await connectDb({ uri: cfg.MONGODB_URI, autoIndex: !cfg.isProduction });
await ensureCategories();
registerJobs(ctx);
ctx.queue.start({ concurrency: cfg.WORKER_CONCURRENCY, pollMs: 1000 });
const scheduler = createScheduler(ctx);
if (cfg.SCHEDULER_ENABLED) scheduler.start(15_000);

// Minimal health/metrics endpoint for container orchestrators.
const port = Number(process.env.WORKER_PORT ?? 4100);
const http = createServer((req, res) => {
  if (req.url === '/health' || req.url === '/live') {
    res.writeHead(dbReady() ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify({ status: dbReady() ? 'ok' : 'degraded', worker: ctx.queue.workerId }));
  } else if (req.url === '/metrics' && (!cfg.METRICS_TOKEN || req.headers.authorization === `Bearer ${cfg.METRICS_TOKEN}`)) {
    res.writeHead(200, { 'content-type': 'text/plain' }).end(metrics.render());
  } else res.writeHead(404).end();
});
http.listen(port, () => ctx.log.info({ channel: 'app', port, env: cfg.APP_ENV, scheduler: cfg.SCHEDULER_ENABLED, concurrency: cfg.WORKER_CONCURRENCY }, 'orvia worker started'));

const shutdown = async (sig: string) => {
  ctx.log.info({ channel: 'app', sig }, 'worker shutting down');
  scheduler.stop();
  await ctx.queue.stop();
  http.close();
  await disconnectDb();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
