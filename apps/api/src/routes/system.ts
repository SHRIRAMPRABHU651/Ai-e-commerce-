import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Redis } from 'ioredis';
import { metrics, integrationStatus } from '@orvia/config';
import { dbReady, pingDb, Job, MockStore, Order } from '@orvia/database';
import { MockPaymentProvider } from '@orvia/payments';
import { MOCK_PROFILES, MockSupplierProvider } from '@orvia/suppliers';
import { MockAdProvider } from '@orvia/ads';
import { DomainError, MongoKVStore, handlePaymentWebhook, notFound } from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { route } from '../http';

export function systemRoutes(app: FastifyInstance, ctx: Ctx, redis: Redis | null): void {
  const started = Date.now();
  app.get('/live', { schema: { hide: true } }, async () => ({ status: 'alive', uptimeSec: Math.round((Date.now() - started) / 1000) }));
  app.get('/health', { schema: { hide: true } }, async () => ({ status: dbReady() ? 'ok' : 'degraded', env: ctx.cfg.APP_ENV, version: process.env.APP_VERSION ?? 'dev', uptimeSec: Math.round((Date.now() - started) / 1000) }));
  app.get('/ready', { schema: { hide: true } }, async (_req, reply) => {
    const db = await pingDb();
    let redisOk: boolean | null = null;
    if (redis) redisOk = await redis.ping().then(() => true).catch(() => false);
    const queue = db ? await ctx.queue.stats().catch(() => ({})) : {};
    // Redis is an optimisation (rate limiting): its absence degrades but never fails readiness. MongoDB is required.
    const body = { status: db ? (redisOk === false ? 'degraded' : 'ready') : 'not_ready', checks: { mongodb: db, redis: redisOk, queue }, integrations: Object.fromEntries(Object.entries(integrationStatus(ctx.cfg)).map(([k, v]) => [k, v.configured])) };
    return reply.status(db ? 200 : 503).send(body);
  });
  app.get('/metrics', { schema: { hide: true } }, async (req, reply) => {
    const token = ctx.cfg.METRICS_TOKEN;
    if (ctx.cfg.isProduction && !token) return reply.status(404).send();
    if (token && req.headers.authorization !== `Bearer ${token}`) return reply.status(401).send('unauthorized');
    metrics.setGauge('orvia_up', dbReady() ? 1 : 0);
    const q = await ctx.queue.stats().catch(() => ({} as Record<string, number>));
    for (const [k, v] of Object.entries(q)) metrics.setGauge('orvia_queue_jobs', v, { status: k });
    return reply.type('text/plain; version=0.0.4').send(metrics.render());
  });

  if (ctx.cfg.isProduction || ctx.cfg.APP_ENV === 'staging') return;

  // -------- development/test-only helpers (never registered in production/staging) --------
  const kv = new MongoKVStore();
  route(app, ctx, {
    method: 'POST', url: '/dev/payments/:intentId/simulate', summary: '[dev] Simulate the payment provider sending a signed webhook', tags: ['Dev'], body: z.object({ outcome: z.enum(['succeeded', 'failed']) }),
    handler: async ({ req, body }) => {
      if (ctx.cfg.PAYMENT_MODE !== 'mock') throw new DomainError('Only available with PAYMENT_MODE=mock', 'FORBIDDEN', 403);
      const intentId = (req.params as { intentId: string }).intentId;
      const provider = new MockPaymentProvider(ctx.cfg.MOCK_PAYMENT_WEBHOOK_SECRET, kv);
      const sim = await provider.simulate(intentId, body.outcome);
      // deliver through the same code path a real provider webhook uses (signature verified)
      const outcome = await handlePaymentWebhook(ctx, 'mock', sim.body, sim.headers);
      const order = await Order.findOne({ 'payment.intentId': intentId }).select('orderNumber status').lean();
      return { outcome, order };
    },
  });
  route(app, ctx, {
    method: 'POST', url: '/dev/suppliers/:code/fault', summary: '[dev] Inject supplier API failures', tags: ['Dev'], body: z.object({ remaining: z.number().int().min(0).max(50), kind: z.enum(['http500', 'timeout', 'unavailable', 'rate_limit']).default('http500') }),
    handler: async ({ req, body }) => {
      const profile = MOCK_PROFILES.find((p) => p.code === (req.params as { code: string }).code);
      if (!profile) throw notFound('Mock supplier');
      await new MockSupplierProvider(profile, kv).setFault(body.remaining ? body : null);
      return { ok: true };
    },
  });
  route(app, ctx, {
    method: 'POST', url: '/dev/suppliers/:code/override', summary: '[dev] Change a mock supplier’s stock/price for a product', tags: ['Dev'], body: z.object({ externalId: z.string(), stock: z.number().int().min(0).optional(), priceMult: z.number().min(0.1).max(10).optional(), unavailable: z.boolean().optional() }),
    handler: async ({ req, body }) => {
      const profile = MOCK_PROFILES.find((p) => p.code === (req.params as { code: string }).code);
      if (!profile) throw notFound('Mock supplier');
      const { externalId, ...o } = body;
      await new MockSupplierProvider(profile, kv).setOverride(externalId, o);
      return { ok: true };
    },
  });
  route(app, ctx, {
    method: 'POST', url: '/dev/ads/fault', summary: '[dev] Make the mock ad API fail N times', tags: ['Dev'], body: z.object({ remaining: z.number().int().min(0).max(20) }),
    handler: async ({ body }) => (await new MockAdProvider(kv).setFault(body.remaining ? body : null), { ok: true }),
  });
  route(app, ctx, {
    method: 'POST', url: '/dev/jobs/drain', summary: '[dev] Process due jobs inline (when no worker is running)', tags: ['Dev'], body: z.object({ max: z.number().int().min(1).max(500).default(100) }),
    handler: async ({ body }) => ({ processed: await ctx.queue.drain(body.max), queue: await ctx.queue.stats() }),
  });
  route(app, ctx, { method: 'GET', url: '/dev/state', summary: '[dev] Mock-store + queue snapshot', tags: ['Dev'], handler: async () => ({ jobs: await Job.countDocuments(), mockStore: await MockStore.countDocuments() }) });
}
