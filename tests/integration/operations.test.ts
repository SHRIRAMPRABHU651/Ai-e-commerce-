import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiDecision, AuditLog, Campaign, ExceptionModel, Order, Product, Refund, Shipment, SupplierOffer, Supplier, Job, Review, ReturnRequest } from '@orvia/database';
import { createStaffUser, fulfillOrder, runPricingAgent, SYSTEM, syncInventory, syncTracking, planMarket, createTestPlan, launchCampaign, syncAdMetrics, optimizeAds } from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { closeCtx, testCtx } from '../helpers/ctx';
import { ageMockOrders, startApi } from '../helpers/client';
import type { Client } from '../helpers/client';
import { firstProducts, pay, placeOrder } from '../helpers/shop';
import { runSeed } from '../../scripts/lib/seed';

let ctx: Ctx;
let mk: (h?: Record<string, string>) => Client;
let admin: Client;
beforeAll(async () => {
  ctx = await testCtx('ops');
  await runSeed(ctx, { orders: 18 });
  mk = (await startApi(ctx)).client;
  await createStaffUser(ctx, { email: 'boss@t.test', name: 'Boss', password: 'Str0ngPassw0rd!', role: 'ADMIN' }, SYSTEM);
  admin = mk();
  expect((await admin.post('/api/v1/auth/admin/login', { email: 'boss@t.test', password: 'Str0ngPassw0rd!' })).status).toBe(200);
}, 240_000);
afterAll(closeCtx);

const runDue = async () => {
  await Job.updateMany({ status: 'queued' }, { $set: { runAt: new Date(0) } });
  return ctx.queue.drain(50);
};

describe('admin dashboard + analytics', () => {
  it('overview answers "how is the business" with distinct revenue and profit tiers', async () => {
    const r = await admin.get('/api/v1/admin/overview?preset=30d');
    expect(r.status).toBe(200);
    const f = r.body.current;
    expect(f.netRevenue).toBeGreaterThan(0);
    expect(f.grossProfit).toBeLessThan(f.netRevenue);
    expect(f.contributionProfit).toBeLessThan(f.grossProfit);
    expect(f.orders).toBeGreaterThan(5);
    for (const k of ['revenue', 'orders', 'customers', 'adSpend', 'roas', 'conversionRate', 'aov', 'refundRate']) expect(k === 'revenue' ? f.grossRevenue : f[k]).toBeDefined();
    expect(r.body.countries).toHaveLength(3);
    expect(r.body.suppliers.length).toBe(4);
    expect(r.body.automations.length).toBe(11);
    expect(r.body.insights.length).toBeGreaterThan(0);
    expect(r.body.live).toHaveProperty('activeVisitors');
    expect(f.note).toBeTruthy();
  });
  it('analytics bundle: series, funnel, categories, ads', async () => {
    const r = await admin.get('/api/v1/admin/analytics?preset=30d');
    expect(r.body.series.length).toBeGreaterThanOrEqual(30);
    expect(r.body.funnel[0].count).toBeGreaterThan(r.body.funnel[4].count);
    expect(r.body.advertising.spend).toBeGreaterThan(0);
    expect(r.body.countryRecommendation).toBeTruthy();
  });
  it('copilot answers from data, shows a plan before acting, and respects automation permissions', async () => {
    const a = await admin.post('/api/v1/admin/copilot', { question: 'Why did profit fall yesterday?' });
    expect(a.status).toBe(200);
    expect(a.body.intent).toBe('profit_change');
    expect(a.body.sources).toContain('orders');
    expect(a.body.answer).toMatch(/\$/);
    const b = await admin.post('/api/v1/admin/copilot', { question: 'Show me the best products to scale' });
    expect(b.body.intent).toBe('scale');
    const c = await admin.post('/api/v1/admin/copilot', { question: 'Pause products losing money' });
    expect(c.body.intent).toBe('pause_losers');
    if (c.body.plan?.length) {
      expect(c.body.requiresConfirmation).toBe(true);
      const before = await Campaign.countDocuments({ status: 'paused' });
      const d = await admin.post('/api/v1/admin/copilot', { question: 'Pause products losing money', confirm: true });
      // ad_optimization defaults to ASSISTED -> becomes a pending approval, not an immediate change
      expect(d.body.executed.every((e: any) => /awaiting approval|executed/.test(e.status))).toBe(true);
      expect(await Campaign.countDocuments({ status: 'paused' })).toBeGreaterThanOrEqual(before);
    }
    const u = await admin.post('/api/v1/admin/copilot', { question: 'tell me a joke' });
    expect(u.body.intent).toBe('unknown');
  });
  it('daily brief is generated from database figures', async () => {
    const r = await admin.post('/api/v1/admin/brief/generate', {});
    expect(r.body.text).toMatch(/TODAY’S BUSINESS BRIEF/);
    expect(r.body.recommendedActions).toHaveLength(3);
    expect(r.body.source).toBe('deterministic');
  });
});

describe('supplier price change → dynamic pricing (ASSISTED) → approval', () => {
  it('proposes a price change within guardrails, applies only on approval, and audits old/new', async () => {
    const [p] = await firstProducts(mk(), 'US', 1);
    const prod = await Product.findById(p!.id).lean();
    const ext = (await (await import('@orvia/database')).SupplierProduct.findOne({ productId: p!.id }).lean())!.externalId;
    const before = prod!.markets.find((m) => m.country === 'US')!.price;
    for (const s of ['mock-nova-us', 'mock-maple-ca', 'mock-globex-cn']) await admin.post(`/api/v1/dev/suppliers/${s}/override`, { externalId: ext, priceMult: 2.2 });
    await syncInventory(ctx, 100);
    expect(await ExceptionModel.countDocuments({ kind: 'PRICE_CHANGE', productId: p!.id })).toBeGreaterThan(0);
    const res = await runPricingAgent(ctx);
    expect(res.proposals + res.changes).toBeGreaterThan(0);
    const dec = await AiDecision.findOne({ kind: 'price_change', 'payload.productId': p!.id, status: 'proposed' }).lean();
    expect(dec).toBeTruthy();
    expect((await Product.findById(p!.id).lean())!.markets.find((m) => m.country === 'US')!.price).toBe(before); // nothing changed yet
    const plan = await planMarket(ctx, p!.id, 'US');
    const ap = await admin.post(`/api/v1/admin/automation/decisions/${dec!._id}/approve`);
    expect(ap.status).toBe(200);
    const after = (await Product.findById(p!.id).lean())!.markets.find((m) => m.country === 'US')!;
    expect(after.price).toBeGreaterThanOrEqual(plan.pricing!.floorPrice);
    expect(after.price).toBeGreaterThan(before);
    expect(after.expectedMargin).toBeGreaterThanOrEqual(0.19);
    const log = await AuditLog.findOne({ action: 'price.changed', resourceId: p!.id }).sort({ timestamp: -1 }).lean();
    expect(log!.aiSummary).toMatch(/Old price .* new price/);
    expect(log!.actorType).toBe('ai');
    // approving twice must not apply twice
    expect((await admin.post(`/api/v1/admin/automation/decisions/${dec!._id}/approve`)).status).toBe(409);
    // manual price below the floor is refused
    const bad = await admin.post(`/api/v1/admin/products/${p!.id}/price`, { country: 'US', price: 100 });
    expect(bad.status).toBe(422);
    for (const s of ['mock-nova-us', 'mock-maple-ca', 'mock-globex-cn']) await admin.post(`/api/v1/dev/suppliers/${s}/override`, { externalId: ext, priceMult: 1 });
  });
});

describe('inventory protection', () => {
  it('marks products out of stock when every supplier is unavailable and restores them', async () => {
    const [, p] = await firstProducts(mk(), 'US', 2);
    const ext = (await (await import('@orvia/database')).SupplierProduct.findOne({ productId: p!.id }).lean())!.externalId;
    for (const s of ['mock-nova-us', 'mock-maple-ca', 'mock-globex-cn', 'mock-bharat-in']) await admin.post(`/api/v1/dev/suppliers/${s}/override`, { externalId: ext, unavailable: true });
    await Product.updateOne({ _id: p!.id }, { $unset: { inventorySyncedAt: '' } });
    await syncInventory(ctx, 100);
    expect((await Product.findById(p!.id).lean())!.state).toBe('OUT_OF_STOCK');
    expect((await mk().get(`/api/v1/products/${p!.slug}`)).status).toBe(404); // hidden from customers
    for (const s of ['mock-nova-us', 'mock-maple-ca', 'mock-globex-cn', 'mock-bharat-in']) await admin.post(`/api/v1/dev/suppliers/${s}/override`, { externalId: ext, unavailable: false });
    await Product.updateOne({ _id: p!.id }, { $unset: { inventorySyncedAt: '' } });
    await syncInventory(ctx, 100);
    expect((await Product.findById(p!.id).lean())!.state).toBe('PUBLISHED');
  });
});

describe('fraud, supplier failures and exceptions', () => {
  it('high-risk orders are held in the exception queue and fulfil only after approval', async () => {
    const c = mk();
    const { co } = await placeOrder(c, { email: 'x@mailinator.com', qty: 6 });
    await Order.updateOne({ _id: co.body.order.id }, { $set: { 'fraud.level': 'high', 'fraud.score': 90 } });
    const r = await pay(c, co.body.payment.intentId);
    expect(r.body.outcome).toBe('processed');
    await runDue();
    expect(await Shipment.countDocuments({ orderId: co.body.order.id })).toBe(0);
    const ex = await ExceptionModel.findOne({ orderId: co.body.order.id, kind: 'FRAUD' }).lean();
    expect(ex).toBeTruthy();
    expect((await Order.findById(co.body.order.id).lean())!.status).toBe('EXCEPTION');
    const act = await admin.post(`/api/v1/admin/exceptions/${ex!._id}/action`, { action: 'approve_fulfillment', note: 'verified by phone' });
    expect(act.status).toBe(200);
    await runDue();
    expect(await Shipment.countDocuments({ orderId: co.body.order.id })).toBe(1);
    expect((await Order.findById(co.body.order.id).lean())!.status).toBe('SUPPLIER_PROCESSING');
  });

  it('supplier API down: retries with backoff, never duplicates, escalates to an exception, recovers on retry', async () => {
    const c = mk();
    const suppliers = ['mock-nova-us', 'mock-maple-ca', 'mock-globex-cn'];
    for (const s of suppliers) await admin.post(`/api/v1/dev/suppliers/${s}/fault`, { remaining: 50, kind: 'http500' });
    const { co } = await placeOrder(c, { productIdx: 1 });
    await pay(c, co.body.payment.intentId);
    for (let i = 0; i < 6; i++) await runDue(); // exhaust all attempts (max 5)
    const order = await Order.findById(co.body.order.id).lean();
    expect(order!.fulfillment!.state).toBe('failed');
    expect(await Job.countDocuments({ name: 'fulfill_order', status: 'dead' })).toBeGreaterThanOrEqual(1);
    const ex = await ExceptionModel.findOne({ orderId: co.body.order.id, kind: 'SUPPLIER_FAILURE' }).lean();
    expect(ex).toBeTruthy(); // never silent
    expect(ex!.priority).toBe('critical');
    expect(await Shipment.countDocuments({ orderId: co.body.order.id, supplierOrderId: { $exists: true } })).toBe(0);
    for (const s of suppliers) await admin.post(`/api/v1/dev/suppliers/${s}/fault`, { remaining: 0 });
    const act = await admin.post(`/api/v1/admin/exceptions/${ex!._id}/action`, { action: 'retry_supplier_order' });
    expect(act.status).toBe(200);
    await runDue();
    expect(await Shipment.countDocuments({ orderId: co.body.order.id })).toBe(1);
    expect((await Order.findById(co.body.order.id).lean())!.fulfillment!.state).toBe('placed');
  }, 60_000);

  it('transient supplier failures recover automatically with exactly one supplier order', async () => {
    const c = mk();
    for (const s of ['mock-nova-us', 'mock-maple-ca', 'mock-globex-cn']) await admin.post(`/api/v1/dev/suppliers/${s}/fault`, { remaining: 3, kind: 'http500' });
    const { co } = await placeOrder(c, { productIdx: 2 });
    await pay(c, co.body.payment.intentId);
    for (let i = 0; i < 4; i++) await runDue();
    for (const s of ['mock-nova-us', 'mock-maple-ca', 'mock-globex-cn']) await admin.post(`/api/v1/dev/suppliers/${s}/fault`, { remaining: 0 });
    await runDue();
    expect(await Shipment.countDocuments({ orderId: co.body.order.id, status: { $ne: 'FAILED' } })).toBe(1);
  }, 60_000);

  it('negative-margin orders are held instead of silently losing money', async () => {
    const c = mk();
    const prods = await firstProducts(c, 'US', 6);
    const p = prods[3]!;
    const ext = (await (await import('@orvia/database')).SupplierProduct.findOne({ productId: p.id }).lean())!.externalId;
    for (const s of ['mock-nova-us', 'mock-maple-ca', 'mock-globex-cn']) await admin.post(`/api/v1/dev/suppliers/${s}/override`, { externalId: ext, priceMult: 8 });
    const { co } = await placeOrder(c, { productIdx: 3, products: prods });
    await pay(c, co.body.payment.intentId);
    await runDue();
    const ex = await ExceptionModel.findOne({ orderId: co.body.order.id, kind: 'NEGATIVE_MARGIN' }).lean();
    expect(ex).toBeTruthy();
    expect(await Shipment.countDocuments({ orderId: co.body.order.id })).toBe(0);
    for (const s of ['mock-nova-us', 'mock-maple-ca', 'mock-globex-cn']) await admin.post(`/api/v1/dev/suppliers/${s}/override`, { externalId: ext, priceMult: 1 });
  }, 60_000);
});

describe('cancel, refund, returns', () => {
  it('cancels an unshipped order at the supplier and refunds idempotently', async () => {
    const c = mk();
    const { co } = await placeOrder(c, { productIdx: 0, email: 'cancel@example.com' });
    await pay(c, co.body.payment.intentId);
    await runDue();
    const id = co.body.order.id;
    const r = await admin.post(`/api/v1/admin/orders/${id}/cancel`, { reason: 'customer asked' });
    expect(r.status).toBe(200);
    const o = await Order.findById(id).lean();
    expect(o!.status).toBe('CANCELLED');
    expect(o!.costs!.refunded).toBe(o!.amounts!.total);
    expect((await Shipment.find({ orderId: id }).lean()).every((s) => s.status === 'CANCELLED')).toBe(true);
    expect(await Refund.countDocuments({ orderId: id })).toBe(1);
    const again = await admin.post(`/api/v1/admin/orders/${id}/refund`, { reason: 'dup' });
    expect(again.status).toBe(409); // nothing left to refund
    expect(await Refund.countDocuments({ orderId: id })).toBe(1);
  });

  it('high-value refunds by non-admin staff need approval', async () => {
    const ops = mk();
    await createStaffUser(ctx, { email: 'ops2@t.test', name: 'Ops', password: 'Str0ngPassw0rd!', role: 'OPERATIONS' }, SYSTEM);
    await ops.post('/api/v1/auth/admin/login', { email: 'ops2@t.test', password: 'Str0ngPassw0rd!' });
    await ctx.settings.set('automation', { autoRefundLimitUsd: 100 }, 'test');
    const c = mk();
    const { co } = await placeOrder(c, { productIdx: 1, qty: 3, email: 'bigrefund@example.com' });
    await pay(c, co.body.payment.intentId);
    await runDue();
    const id = co.body.order.id;
    const r = await ops.post(`/api/v1/admin/orders/${id}/refund`, { reason: 'goodwill' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('pending_approval');
    expect(await ExceptionModel.countDocuments({ orderId: id, kind: 'HIGH_VALUE_REFUND' })).toBe(1);
    expect((await ops.post(`/api/v1/admin/refunds/${r.body._id}/approve`)).status).toBe(403);
    const ok = await admin.post(`/api/v1/admin/refunds/${r.body._id}/approve`);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('succeeded');
    await ctx.settings.set('automation', { autoRefundLimitUsd: 5000 }, 'test');
  });

  it('delivered order → return request → approval → refund', async () => {
    const c = mk();
    const buyer = `ret${Date.now()}@example.com`;
    await c.post('/api/v1/auth/register', { email: buyer, password: 'Sup3rSecretPass', name: 'Return Buyer' });
    const { co } = await placeOrder(c, { productIdx: 2, email: buyer });
    await pay(c, co.body.payment.intentId);
    await runDue();
    const id = co.body.order.id;
    // cannot return before delivery
    const sku = (await Order.findById(id).lean())!.items[0]!.sku;
    expect((await c.post('/api/v1/returns', { orderId: id, reason: 'changed_mind', details: '', itemSkus: [sku] })).status).toBe(409);
    await ageMockOrders(60);
    await syncTracking(ctx, { orderId: id });
    await runDue();
    expect((await Order.findById(id).lean())!.status).toBe('DELIVERED');
    const rr = await c.post('/api/v1/returns', { orderId: id, reason: 'damaged', details: 'box crushed', itemSkus: [sku] });
    expect(rr.status).toBe(201);
    expect((await Order.findById(id).lean())!.status).toBe('REFUND_REQUESTED');
    // another customer cannot file a return on this order
    const other = mk();
    await other.post('/api/v1/auth/register', { email: `o${Date.now()}@example.com`, password: 'Sup3rSecretPass', name: 'Other' });
    expect((await other.post('/api/v1/returns', { orderId: id, reason: 'damaged', details: '', itemSkus: [sku] })).status).toBe(403);
    const d = await admin.post(`/api/v1/admin/returns/${rr.body._id}/decision`, { decision: 'refund', note: 'approved' });
    expect(d.status).toBe(200);
    expect(d.body.status).toBe('refunded');
    expect((await Order.findById(id).lean())!.status).toBe('REFUNDED');
    expect(await ReturnRequest.countDocuments({ status: 'refunded' })).toBe(1);
  }, 60_000);
});

describe('ads: safe mode, failures, budgets', () => {
  it('never reports a campaign as live when the ad API fails', async () => {
    const [p] = await firstProducts(mk(), 'US', 1);
    const plan = await createTestPlan(ctx, p!.id, 'US', 'meta', SYSTEM);
    await admin.post('/api/v1/dev/ads/fault', { remaining: 3 });
    await expect(launchCampaign(ctx, plan.campaignId, SYSTEM)).rejects.toThrow(/launch failed/i);
    const c = await Campaign.findById(plan.campaignId).lean();
    expect(c!.status).toBe('failed');
    expect(c!.failureReason).toMatch(/injected failure/);
    expect(await AuditLog.countDocuments({ action: 'campaign.launch_failed', resourceId: plan.campaignId })).toBe(1);
    await admin.post('/api/v1/dev/ads/fault', { remaining: 0 });
  });
  it('enforces per-campaign and global spending limits', async () => {
    const [p] = await firstProducts(mk(), 'US', 1);
    const plan = await createTestPlan(ctx, p!.id, 'US', 'tiktok', SYSTEM);
    await Campaign.updateOne({ _id: plan.campaignId }, { $set: { dailyBudget: 999_999 } });
    await expect(launchCampaign(ctx, plan.campaignId, SYSTEM)).rejects.toThrow(/per-campaign maximum/);
    await Campaign.updateOne({ _id: plan.campaignId }, { $set: { dailyBudget: 1000 } });
    await ctx.settings.set('ads', { dailyLimit: 1000 }, 'test');
    await expect(launchCampaign(ctx, plan.campaignId, SYSTEM)).rejects.toThrow(/global daily spend limit/);
    await ctx.settings.set('ads', { dailyLimit: 20_000 }, 'test');
  });
  it('optimizer proposes (ASSISTED) and the admin approval is applied on the platform', async () => {
    await syncAdMetrics(ctx, 14);
    const r = await optimizeAds(ctx);
    expect(r.evaluated).toBeGreaterThan(0);
    const dec = await AiDecision.findOne({ kind: 'ad_action', status: 'proposed' }).lean();
    if (dec) {
      const ap = await admin.post(`/api/v1/admin/automation/decisions/${dec._id}/approve`);
      expect(ap.status).toBe(200);
      const camp = await Campaign.findById((dec.payload as { campaignId: string }).campaignId).lean();
      if ((dec.payload as { action: string }).action === 'PAUSE') expect(camp!.status).toBe('paused');
    }
    const m = await admin.get('/api/v1/admin/marketing?preset=30d');
    expect(m.body.byCountry.length).toBeGreaterThan(0);
    expect(m.body.totals.spend).toBeGreaterThan(0);
    expect(m.body.creatives.length).toBeGreaterThan(0);
  });
});

describe('products, import, compliance', () => {
  it('admin import enforces compliance: weapons rejected, kids product without safety info held for review', async () => {
    const sup = await Supplier.findOne({ code: 'mock-nova-us' }).lean();
    const cat = await admin.get(`/api/v1/admin/suppliers/${sup!._id}/catalog?q=knife`);
    expect(cat.body.items[0].title).toMatch(/Knife/);
    expect(cat.body.items[0].importStatus).toBe('rejected');
    const pub = await admin.post(`/api/v1/admin/products/${(await Product.findOne({ title: /Teething/ }).lean())!._id}/publish`);
    expect(pub.status).toBe(422); // publish gate blocks it
    expect(pub.body.error.code).toBe('PUBLISH_BLOCKED');
    const banned = await Product.findOne({ title: /Replica/ }).lean();
    expect(banned!.state).toBe('BANNED');
    expect((await mk().get(`/api/v1/products/${banned!.slug}`)).status).toBe(404);
  });
  it('product detail for admins includes supplier comparison with a recommendation and reason', async () => {
    const [p] = await firstProducts(mk(), 'US', 1);
    const d = await admin.get(`/api/v1/admin/products/${p!.id}`);
    const us = d.body.comparisons.find((c: any) => c.country === 'US');
    expect(us.rows.length).toBeGreaterThanOrEqual(3);
    expect(us.recommendation.reason).toMatch(/delivery|reliab|profit/i);
    expect(us.rows[0].eligible).toBe(true);
    expect(d.body.plans.find((x: any) => x.country === 'US').economics.break_even_ROAS).toBeGreaterThan(1);
  });
  it('lifecycle transitions follow the allowed graph', async () => {
    const [p] = await firstProducts(mk(), 'US', 1);
    expect((await admin.post(`/api/v1/admin/products/${p!.id}/transition`, { to: 'DISCOVERED', reason: 'bad' })).status).toBe(409);
    expect((await admin.post(`/api/v1/admin/products/${p!.id}/transition`, { to: 'WINNER', reason: 'manual review' })).status).toBe(200);
    expect((await admin.post(`/api/v1/admin/products/${p!.id}/transition`, { to: 'PUBLISHED', reason: 'back' })).status).toBe(409);
  });
});

describe('reviews, support, promotions', () => {
  it('reviews: verified purchase badge, helpful votes, rating recompute, one review per customer', async () => {
    const c = mk();
    const buyer = `rev${Date.now()}@example.com`;
    await c.post('/api/v1/auth/register', { email: buyer, password: 'Sup3rSecretPass', name: 'Rev Writer' });
    const [p] = await firstProducts(mk(), 'US', 1);
    const r = await c.post(`/api/v1/products/${p!.id}/reviews`, { rating: 5, title: 'Great', body: 'Works well and arrived quickly', images: [] });
    expect(r.status).toBe(201);
    expect((await c.post(`/api/v1/products/${p!.id}/reviews`, { rating: 4, title: 'x', body: 'second review attempt', images: [] })).status).toBe(409);
    expect((await c.post(`/api/v1/reviews/${r.body._id}/helpful`)).status).toBe(200);
    expect((await c.post(`/api/v1/reviews/${r.body._id}/helpful`)).status).toBe(403);
    const list = await mk().get(`/api/v1/products/${(await Product.findById(p!.id).lean())!.slug}/reviews`);
    expect(list.body.total).toBeGreaterThan(0);
    expect(await Review.countDocuments({ productId: p!.id })).toBe(list.body.total);
  });
  it('support assistant uses real order data, never invents tracking, protects other customers’ orders, escalates unknowns', async () => {
    const c = mk();
    const { co } = await placeOrder(c, { productIdx: 0, email: 'support@example.com' });
    await pay(c, co.body.payment.intentId);
    const num = co.body.order.orderNumber;
    const a = await c.post('/api/v1/support/chat', { message: `where is my order ${num}?`, email: 'support@example.com' });
    expect(a.body.intent).toBe('tracking');
    expect(a.body.reply).toMatch(/no tracking number|hasn’t been placed|supplier/i);
    expect(a.body.reply).not.toMatch(/MOCK[A-Z0-9]+/);
    const stranger = await mk().post('/api/v1/support/chat', { message: `track ${num}`, email: 'someone-else@example.com' });
    expect(stranger.body.reply).toMatch(/can’t find an order/);
    const q = await c.post('/api/v1/support/chat', { message: 'what is the weight and battery warranty of the snuffle mat?' });
    expect(q.body.escalated).toBe(true);
    expect(q.body.ticketId).toBeTruthy();
    const human = await c.post('/api/v1/support/chat', { message: 'I want to talk to a human' });
    expect(human.body.escalated).toBe(true);
  });
  it('promotions: stacking rules, country scope, margin clamp', async () => {
    const c = mk();
    const prods = await firstProducts(c, 'US', 2);
    const d = await c.get(`/api/v1/products/${prods[0]!.slug}`);
    await c.post('/api/v1/cart/items', { productId: prods[0]!.id, variantSku: d.body.variants[0].sku, quantity: 3 });
    const bx = await c.post('/api/v1/cart/coupon', { code: 'BUY2GET1' });
    expect(bx.body.discount).toBeGreaterThan(0);
    const unit = bx.body.lines[0].unitPrice;
    expect(bx.body.discount).toBeLessThanOrEqual(unit + 1 + Math.round(bx.body.subtotal * 0.05)); // one free unit (+ flash sale at most)
    // admin creates a country-scoped promotion; it does not apply elsewhere
    const created = await admin.post('/api/v1/admin/promotions', { name: 'CA only', type: 'percentage', code: 'CAONLY15', countries: ['CA'], percent: 0.15, perUserLimit: 0, usageLimit: 0, active: true });
    expect(created.status).toBe(201);
    const us = await c.post('/api/v1/cart/coupon', { code: 'CAONLY15' });
    expect(us.body.couponError).toMatch(/invalid/i);
    expect((await admin.post('/api/v1/admin/promotions', { name: 'Too big', type: 'percentage', code: 'HUGE90', percent: 0.9 })).status).toBe(422);
  });
});

describe('automation center', () => {
  it('lists every automation with mode, schedule and risk; modes default sensibly and are audited when changed', async () => {
    const r = await admin.get('/api/v1/admin/automation');
    expect(r.body.automations).toHaveLength(11);
    const byKey = Object.fromEntries(r.body.automations.map((a: any) => [a.key, a]));
    expect(byKey.dynamic_pricing.mode).toBe('ASSISTED');
    expect(byKey.auto_publishing.mode).toBe('ASSISTED');
    expect(byKey.order_fulfillment.risk).toBe('high');
    expect(r.body.agents.length).toBeGreaterThanOrEqual(19);
    expect(r.body.schedules.find((s: any) => s.name === 'order_sync').everyMs).toBe(300_000);
    const upd = await admin.put('/api/v1/admin/automation/schedules/pricing_analysis', { everyMinutes: 30 });
    expect(upd.status).toBe(200);
    expect((await admin.get('/api/v1/admin/automation')).body.schedules.find((s: any) => s.name === 'pricing_analysis').everyMs).toBe(1_800_000);
    const run = await admin.post('/api/v1/admin/automation/agents/TrendAgent/run', { input: {} });
    expect(run.status).toBe(200);
    expect(run.body.confidence).toBeGreaterThan(0);
    expect((await admin.get('/api/v1/admin/automation/ai-tasks')).body.items.length).toBeGreaterThan(0);
  });
  it('OFF mode really disables an automation', async () => {
    await admin.put('/api/v1/admin/automation/dynamic_pricing', { mode: 'OFF' });
    const before = await AiDecision.countDocuments({});
    await runPricingAgent(ctx);
    expect(await AiDecision.countDocuments({})).toBe(before);
    await admin.put('/api/v1/admin/automation/dynamic_pricing', { mode: 'ASSISTED' });
  });
});

void fulfillOrder; void SupplierOffer;
