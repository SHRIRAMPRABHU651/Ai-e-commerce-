import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import mongoose from 'mongoose';
import { Job, Order, Payment, SystemSetting } from '@orvia/database';
import { NonRetryableError, Scheduler, DEFAULT_SCHEDULES } from '@orvia/core';
import { ProviderError } from '@orvia/config';
import type { Ctx } from '@orvia/core';
import { closeCtx, testCtx } from '../helpers/ctx';
import { buildServer } from '../../apps/api/src/server';
import { Client, startApi } from '../helpers/client';
import { firstProducts, pay, placeOrder } from '../helpers/shop';
import { runSeed } from '../../scripts/lib/seed';

let ctx: Ctx;
let mk: (h?: Record<string, string>) => Client;
beforeAll(async () => {
  ctx = await testCtx('fail');
  await runSeed(ctx, { withHistory: false });
  mk = (await startApi(ctx)).client;
}, 180_000);
afterAll(closeCtx);

describe('durable queue', () => {
  it('de-duplicates, retries with backoff, dead-letters, and reclaims jobs from crashed workers', async () => {
    const q = ctx.queue;
    let runs = 0;
    q.register('flaky', async () => { if (++runs < 3) throw new Error('boom'); return 'done'; });
    const a = await q.enqueue('flaky', {}, { dedupeKey: 'one' });
    const b = await q.enqueue('flaky', {}, { dedupeKey: 'one' });
    expect(b.deduped).toBe(true);
    expect(b.id).toBe(a.id);
    await q.runOnce();
    let j = await Job.findById(a.id).lean();
    expect(j!.status).toBe('queued');
    expect(j!.runAt.getTime()).toBeGreaterThan(Date.now()); // exponential backoff scheduled
    await Job.updateOne({ _id: a.id }, { $set: { runAt: new Date(0) } });
    await q.runOnce();
    await Job.updateOne({ _id: a.id }, { $set: { runAt: new Date(0) } });
    await q.runOnce();
    j = await Job.findById(a.id).lean();
    expect(j!.status).toBe('completed');
    expect(j!.attempts).toBe(3);

    q.register('always-bad', async () => { throw new Error('nope'); });
    const dead: string[] = [];
    q.onDead = (job) => void dead.push(job.name);
    const d = await q.enqueue('always-bad', {}, { maxAttempts: 2 });
    for (let i = 0; i < 2; i++) { await Job.updateOne({ _id: d.id }, { $set: { runAt: new Date(0) } }); await q.runOnce(); }
    expect((await Job.findById(d.id).lean())!.status).toBe('dead');
    expect(dead).toEqual(['always-bad']);

    q.register('fatal', async () => { throw new NonRetryableError('never retry'); });
    const f = await q.enqueue('fatal', {});
    await q.runOnce();
    expect((await Job.findById(f.id).lean())!.status).toBe('dead');

    q.register('crashy', async () => 'recovered');
    const c = await q.enqueue('crashy', {});
    await Job.updateOne({ _id: c.id }, { $set: { status: 'active', lockedBy: 'dead-worker', lockedUntil: new Date(Date.now() - 1000) } });
    await q.runOnce();
    expect((await Job.findById(c.id).lean())!.status).toBe('completed');
    q.onDead = undefined;
  });

  it('scheduler fires each slot exactly once even with competing instances', async () => {
    await Job.deleteMany({});
    await SystemSetting.deleteMany({ key: /^schedule:/ });
    const defs = [{ name: 'tick-test', everyMs: 60_000, job: 'noop', description: 't' }];
    const s1 = new Scheduler(ctx.queue, defs, ctx.log);
    const s2 = new Scheduler(ctx.queue, defs, ctx.log);
    const now = Date.now();
    const r = await Promise.all([s1.tick(now), s2.tick(now), s1.tick(now)]);
    expect(r.flat()).toHaveLength(1);
    expect(await Job.countDocuments({ name: 'noop' })).toBe(1);
    expect((await s1.tick(now + 61_000)).length).toBe(1);
    expect(DEFAULT_SCHEDULES.find((x) => x.name === 'order_sync')!.everyMs).toBe(300_000);
  });
});

describe('payment failures', () => {
  it('payment timeout/provider outage: order is kept, no ghost charge, and a retry with the same key completes', async () => {
    const c = mk();
    const prods = await firstProducts(c, 'US', 2);
    const orig = ctx.payments.forCountry.bind(ctx.payments);
    let fail = true;
    ctx.payments.forCountry = ((pref: string[]) => {
      const p = orig(pref);
      return new Proxy(p, { get: (t, k, r) => (k === 'createPayment' && fail ? async () => { throw new ProviderError('payment provider timed out', { provider: 'mock', retryable: true }); } : Reflect.get(t, k, r)) });
    }) as typeof ctx.payments.forCountry;
    const key = `timeout-${Date.now()}`;
    const first = await placeOrder(c, { key, products: prods });
    expect(first.co.status).toBe(502);
    const order = await Order.findOne({ idempotencyKey: key }).lean();
    expect(order!.status).toBe('PENDING_PAYMENT');
    expect(await Payment.countDocuments({ orderId: order!._id })).toBe(0);
    fail = false;
    const retry = await c.post('/api/v1/checkout', { email: order!.email, address: order!.address, shippingMethod: 'standard', idempotencyKey: key });
    expect(retry.status).toBe(200);
    expect(retry.body.payment.intentId).toBeTruthy();
    expect(await Order.countDocuments({ idempotencyKey: key })).toBe(1);
    expect(await Payment.countDocuments({ orderId: order!._id })).toBe(1);
    ctx.payments.forCountry = orig;
  });

  it('failed payment leaves the order unpaid; a later success on the same intent is honoured exactly once', async () => {
    const c = mk();
    const { co } = await placeOrder(c, {});
    const failed = await c.post(`/api/v1/dev/payments/${co.body.payment.intentId}/simulate`, { outcome: 'failed' });
    expect(failed.body.outcome).toBe('processed');
    expect((await Order.findById(co.body.order.id).lean())!.payment!.status).toBe('failed');
    expect((await Order.findById(co.body.order.id).lean())!.status).toBe('PENDING_PAYMENT');
    const ok = await pay(c, co.body.payment.intentId);
    expect(ok.body.order.status).toBe('PAID');
  });

  it('payment verification job settles an order whose webhook was lost', async () => {
    const c = mk();
    const { co } = await placeOrder(c, {});
    const { MockPaymentProvider } = await import('@orvia/payments');
    const { MongoKVStore, verifyPendingPayments } = await import('@orvia/core');
    await new MockPaymentProvider(ctx.cfg.MOCK_PAYMENT_WEBHOOK_SECRET, new MongoKVStore()).simulate(co.body.payment.intentId, 'succeeded');
    await Order.collection.updateOne({ _id: new mongoose.Types.ObjectId(co.body.order.id) }, { $set: { createdAt: new Date(Date.now() - 10 * 60_000) } });
    const r = await verifyPendingPayments(ctx);
    expect(r.settled).toBeGreaterThanOrEqual(1);
    expect((await Order.findById(co.body.order.id).lean())!.status).toBe('PAID');
  });
});

describe('infrastructure failures', () => {
  it('Redis unavailable: API keeps serving (rate limiting falls back) and readiness reports degraded', async () => {
    const redis = new Redis({ host: '127.0.0.1', port: 6399, maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true, retryStrategy: () => null });
    redis.on('error', () => undefined);
    const app = await buildServer(ctx, { redis });
    const c = new Client(app);
    expect((await c.get('/api/v1/meta')).status).toBe(200);
    expect((await c.get('/api/v1/products?pageSize=2')).status).toBe(200);
    const ready = await c.get('/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('degraded');
    expect(ready.body.checks.redis).toBe(false);
    redis.disconnect();
  });

  it('MongoDB failure: readiness fails and requests fail safely (no hang, no crash)', async () => {
    const c = mk();
    await mongoose.connection.close();
    const ready = await c.get('/ready');
    expect(ready.status).toBe(503);
    expect(ready.body.checks.mongodb).toBe(false);
    expect((await c.get('/live')).status).toBe(200);
    const r = await c.post('/api/v1/auth/login', { email: 'a@b.co', password: 'whatever-123' });
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(r.body.error.code).toBeDefined();
    await mongoose.connect(process.env.TEST_MONGO_URI!.replace(/\/?$/, '/') + `orvia_fail_${process.pid}`);
  }, 60_000);
});
