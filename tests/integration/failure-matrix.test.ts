import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExceptionModel, Job, Order, Payment, Shipment, SupplierProduct, WebhookEvent } from '@orvia/database';
import { MockSupplierProvider, MOCK_PROFILES } from '@orvia/suppliers';
import { MockPaymentProvider, WebhookSignatureError } from '@orvia/payments';
import { MongoKVStore, SYSTEM, fulfillOrder, handlePaymentWebhook, refundOrder, runReconciliation } from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { closeCtx, testCtx } from '../helpers/ctx';
import { Client, startApi } from '../helpers/client';
import { pay, placeOrder } from '../helpers/shop';
import { runSeed } from '../../scripts/lib/seed';

/**
 * Phase 1.5 failure matrix. These run against the IN-REPO mock supplier and payment adapters, so they prove Orvia's
 * own handling of each failure. They do NOT prove the behaviour of any real provider (see docs/LIMITATIONS.md #1).
 */
let ctx: Ctx; let api: () => Client; const kv = new MongoKVStore();
beforeAll(async () => {
  ctx = await testCtx('fmatrix');
  await runSeed(ctx, { withHistory: false });
  api = (await startApi(ctx)).client;
}, 180_000);
afterAll(closeCtx);

const faultAll = (remaining: number | null) => Promise.all(MOCK_PROFILES.map((p) => new MockSupplierProvider(p, kv).setFault(remaining ? { remaining, kind: 'http500' } as never : null)));
const byNumber = (n: string) => Order.findOne({ orderNumber: n }).lean();

describe('failure matrix (mock adapters)', () => {
  it('payment captured, every supplier rejects: the order is held with an exception, nothing is lost or double-ordered, and a full refund settles it cleanly', async () => {
    const c = api();
    const { co } = await placeOrder(c, { country: 'US' });
    await faultAll(500);
    try {
      await pay(c, co.body.payment.intentId);
      for (let i = 0; i < 7; i++) { await Job.updateMany({ status: 'queued' }, { $set: { runAt: new Date(0) } }); await ctx.queue.drain(40); } // exhaust retries with backoff
    } finally { await faultAll(null); }
    const o = (await byNumber(co.body.order.orderNumber))!;
    expect(o.payment!.status).toBe('succeeded'); // money was captured
    expect(await Shipment.countDocuments({ orderId: o._id, status: { $nin: ['FAILED', 'CANCELLED'] } })).toBe(0);
    expect(o.exceptionOpen).toBe(true);
    expect(await ExceptionModel.countDocuments({ orderId: o._id, status: 'open' })).toBeGreaterThan(0);
    // NOTE: there is no automatic refund path — an operator refunds. Pinned here so a future auto-refund is a deliberate change.
    const refund = await refundOrder(ctx, String(o._id), { actor: SYSTEM, reason: 'supplier could not fulfil', bypassApproval: true });
    expect(['succeeded', 'processing']).toContain(refund.status);
    await ctx.queue.drain(20);
    const after = (await byNumber(co.body.order.orderNumber))!;
    expect(after.costs!.refunded).toBe(after.amounts!.total);
    const rec = await runReconciliation(ctx);
    expect(rec.findings.filter((f) => f.orderId === String(o._id)), JSON.stringify(rec.findings)).toEqual([]);
  });

  it('supplier ships, customer is then refunded in full → reconciliation raises an exception (once)', async () => {
    const c = api();
    const { co } = await placeOrder(c, { country: 'US' });
    await pay(c, co.body.payment.intentId);
    await ctx.queue.drain(40);
    const o = (await byNumber(co.body.order.orderNumber))!;
    await Shipment.updateMany({ orderId: o._id }, { $set: { status: 'IN_TRANSIT' } });
    await refundOrder(ctx, String(o._id), { actor: SYSTEM, reason: 'customer changed mind', bypassApproval: true });
    await ctx.queue.drain(20);
    const r = await runReconciliation(ctx);
    expect(r.findings.some((f) => f.kind === 'refunded_after_shipment' && f.orderId === String(o._id))).toBe(true);
    await runReconciliation(ctx);
    expect(await ExceptionModel.countDocuments({ kind: 'RECONCILIATION', orderId: o._id, issue: /fully refunded but/ })).toBe(1);
  });

  it('partial fulfilment: the line that can be sourced ships, the other is held with an exception, and a retry never duplicates the shipped line', async () => {
    const c = api();
    const { firstProducts } = await import('../helpers/shop');
    const prods = await firstProducts(c, 'US', 6);
    const a = prods[0]!; const b = prods[1]!;
    const d1 = await c.get(`/api/v1/products/${a.slug}?country=US`);
    const d2 = await c.get(`/api/v1/products/${b.slug}?country=US`);
    await c.post('/api/v1/cart/items?country=US', { productId: a.id, variantSku: d1.body.variants[0].sku, quantity: 1 });
    await c.post('/api/v1/cart/items?country=US', { productId: b.id, variantSku: d2.body.variants[0].sku, quantity: 1 });
    const { address } = await import('../helpers/client');
    const co = await c.post('/api/v1/checkout', { email: 'partial@example.com', address: address.US, shippingMethod: 'standard', idempotencyKey: `partial-${Date.now()}` });
    expect(co.status).toBe(201);
    const links = await SupplierProduct.find({ productId: b.id }).lean();
    await SupplierProduct.deleteMany({ productId: b.id }); // product B can no longer be sourced from anyone
    try {
      await pay(c, co.body.payment.intentId);
      await ctx.queue.drain(60);
      const o = (await byNumber(co.body.order.orderNumber))!;
      const active = await Shipment.find({ orderId: o._id, status: { $nin: ['FAILED', 'CANCELLED'] } }).lean();
      expect(active.map((s) => String(s.productId))).toEqual([a.id]);
      expect(o.fulfillment!.state).toBe('partial');
      expect(o.exceptionOpen).toBe(true);
      await fulfillOrder(ctx, String(o._id), { force: true });
      expect(await Shipment.countDocuments({ orderId: o._id, productId: a.id, status: { $nin: ['FAILED', 'CANCELLED'] } })).toBe(1);
    } finally { await SupplierProduct.insertMany(links); }
  });

  it('webhook replay: an identical delivery is a no-op, and a re-signed delivery outside the timestamp tolerance is rejected', async () => {
    const c = api();
    const { co } = await placeOrder(c, { country: 'US' });
    const provider = new MockPaymentProvider(ctx.cfg.MOCK_PAYMENT_WEBHOOK_SECRET, kv);
    const sim = await provider.simulate(co.body.payment.intentId, 'succeeded');
    expect(await handlePaymentWebhook(ctx, 'mock', sim.body, sim.headers)).toBe('processed');
    expect(await handlePaymentWebhook(ctx, 'mock', sim.body, sim.headers)).toBe('duplicate'); // same signature, replayed
    const order = (await byNumber(co.body.order.orderNumber))!;
    expect(order.timeline!.filter((t) => t.status === 'PAID')).toHaveLength(1);
    expect(await WebhookEvent.countDocuments({ provider: 'mock', eventId: JSON.parse(sim.body).id })).toBe(1);
    // an attacker replays a captured, validly-signed request much later with a NEW event id so dedupe cannot save us
    const body = JSON.stringify({ ...JSON.parse(sim.body), id: 'evt_replayed_later' });
    const t = String(Math.floor(Date.now() / 1000) - 3600);
    const sig = createHmac('sha256', ctx.cfg.MOCK_PAYMENT_WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex');
    await expect(handlePaymentWebhook(ctx, 'mock', body, { 'x-mock-signature': `t=${t},v1=${sig}` })).rejects.toBeInstanceOf(WebhookSignatureError);
    expect(await WebhookEvent.countDocuments({ provider: 'mock', eventId: 'evt_replayed_later' })).toBe(0);
  });

  it('currency mismatch between the provider payment and the order is rejected, never fulfilled, and raises an exception', async () => {
    const c = api();
    const { co } = await placeOrder(c, { country: 'US' });
    const provider = new MockPaymentProvider(ctx.cfg.MOCK_PAYMENT_WEBHOOK_SECRET, kv);
    const stored = await kv.get<Record<string, unknown>>('payment', co.body.payment.intentId);
    await kv.set('payment', co.body.payment.intentId, { ...stored, currency: 'CAD' });
    const sim = await provider.simulate(co.body.payment.intentId, 'succeeded');
    expect(await handlePaymentWebhook(ctx, 'mock', sim.body, sim.headers)).toBe('rejected');
    const o = (await byNumber(co.body.order.orderNumber))!;
    expect(o.status).not.toBe('PAID');
    expect(o.payment!.status).not.toBe('succeeded');
    expect(await Shipment.countDocuments({ orderId: o._id })).toBe(0);
    expect(await ExceptionModel.countDocuments({ orderId: o._id, kind: 'PAYMENT_FAILURE' })).toBe(1);
    expect((await Payment.findOne({ orderId: o._id }).lean())!.status).not.toBe('succeeded');
  });
});
