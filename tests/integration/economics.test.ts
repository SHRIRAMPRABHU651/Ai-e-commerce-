import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdMetric, AiDecision, ExceptionModel, MeasuredCpa, Order, Product, Shipment, Supplier } from '@orvia/database';
import { SYSTEM, canPublish, fulfillOrder, proposePublish, publishProduct, recordManualCpa, refreshMeasuredCpa, refreshMeasuredRefunds, measuredRefundRates, resolveCpa } from '@orvia/core';
import type { Actor, Ctx } from '@orvia/core';
import { closeCtx, testCtx } from '../helpers/ctx';
import { Client, startApi } from '../helpers/client';
import { pay, placeOrder } from '../helpers/shop';
import { runSeed } from '../../scripts/lib/seed';

let ctx: Ctx; let admin: Client; let n = 0;
const person: Actor = { id: 'owner', type: 'user' };
const oid = () => new mongoose.Types.ObjectId();
beforeAll(async () => {
  ctx = await testCtx('economics');
  await runSeed(ctx, { withHistory: false });
  admin = (await startApi(ctx)).client();
  expect((await admin.post('/api/v1/auth/admin/login', { email: 'owner@orvia.test', password: 'Orvia-Demo-2026!' })).status).toBe(200);
}, 180_000);
afterAll(closeCtx);

/** US market at price 10 000 with fully specified provenance. Pre-CAC margin = (10000 − landed − 320 − 500) / 10000 with a 5% refund rate. */
async function mk(landedCost: number, market: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  n++;
  return Product.create({
    slug: `eco-${n}`, sku: `ECO-${n}`, title: `Economics product ${n}`, description: 'A test product with a sufficiently long description.', state: 'DRAFT',
    images: [{ url: `/art/eco-${n}?v=1` }], imageStatus: 'READY', compliance: { status: 'passed', flags: [] }, category: `cat-${n}`,
    markets: [{ country: 'US', enabled: true, currency: 'USD', price: 10_000, stock: 50, landedCost, refundRate: 0.05, refundSource: 'estimated', ...market }], ...extra,
  });
}

describe('publish gate: contribution at three CAC levels', () => {
  it('rejects when the EXPECTED-case margin is below the minimum (landed 55% of price → 10.8% at 26% CAC)', async () => {
    const p = await mk(5_500, { cpaSource: 'measured', cpa: 2_600, cpaSampleSize: 30 });
    // measured CAC equals the expected 26% here; pre-CAC margin 36.8% → 10.8% < 20%
    const g = await canPublish(ctx, String(p._id), { humanApproved: true });
    expect(g.ok).toBe(false);
    expect(g.hardProblems.join(' ')).toMatch(/Expected-case margin 10\.8% is below the 20\.0% minimum in US/);
    await expect(publishProduct(ctx, String(p._id), person, 'x')).rejects.toMatchObject({ code: 'PUBLISH_BLOCKED' });
  });

  it('passes at 15% CAC, passes at the expected 26%, fails at 40% → publishable but FLAGGED, never silent', async () => {
    const p = await mk(4_500, { cpaSource: 'measured', cpa: 2_600, cpaSampleSize: 30 }); // expected 20.8%
    const g = await canPublish(ctx, String(p._id));
    const s = g.scenarios[0]!.scenarios;
    expect(s.optimistic.margin).toBeGreaterThanOrEqual(0.2);
    expect(s.expected.margin).toBeGreaterThanOrEqual(0.2);
    expect(s.pessimistic.margin).toBeLessThan(0.2);
    expect(g.ok).toBe(true);
    expect(g.warnings.join(' ')).toMatch(/Below the 20\.0% minimum at pessimistic CAC in US: 6\.8% at CAC 40\.0% of price/);
  });

  it('warns loudly when the product LOSES money at pessimistic CAC', async () => {
    const p = await mk(5_000, { cpaSource: 'measured', cpa: 1_500, cpaSampleSize: 30 }); // pre-CAC 41.8%; measured 15% → 26.8% ok; pessimistic 40% → 1.8% (still positive)
    expect((await canPublish(ctx, String(p._id))).warnings.join(' ')).toMatch(/Below the 20\.0% minimum at pessimistic/);
    const q = await mk(6_000, { cpaSource: 'measured', cpa: 1_000, cpaSampleSize: 30 }); // pre-CAC 31.8%; measured 10% → 21.8% ok; pessimistic 40% → −8.2%
    const g = await canPublish(ctx, String(q._id));
    expect(g.ok).toBe(true);
    expect(g.warnings.join(' ')).toMatch(/Loses money at pessimistic CAC in US: -8\.2%/);
  });

  it('assumed acquisition cost can NOT be auto-published; only a person can approve it', async () => {
    const p = await mk(4_500); // cpaSource defaults to "assumed"
    const g = await canPublish(ctx, String(p._id));
    expect(g.needsHumanApproval).toBe(true);
    expect(g.hardProblems).toEqual([]);
    expect(g.ok).toBe(false);
    expect(g.problems.join(' ')).toMatch(/assumed, not measured/);
    for (const actor of [SYSTEM, { id: 'PricingAgent', type: 'ai' } as Actor, { id: 'hook', type: 'webhook' } as Actor]) {
      await expect(publishProduct(ctx, String(p._id), actor, 'auto')).rejects.toMatchObject({ code: 'PUBLISH_BLOCKED' });
    }
    expect((await Product.findById(p._id).lean())!.state).toBe('DRAFT');
    await publishProduct(ctx, String(p._id), person, 'human approval');
    expect((await Product.findById(p._id).lean())!.state).toBe('PUBLISHED');
  });

  it('AUTOMATIC mode still routes assumed-CAC products to a human, and approving publishes', async () => {
    await ctx.settings.setAutomationMode('auto_publishing', 'AUTOMATIC', 'test');
    try {
      const assumed = await mk(4_500);
      const out = await proposePublish(ctx, String(assumed._id), assumed.title, 1, await canPublish(ctx, String(assumed._id)));
      expect(out?.outcome).toBe('proposed');
      expect((await Product.findById(assumed._id).lean())!.state).toBe('DRAFT');
      const dec = await AiDecision.findOne({ resourceId: String(assumed._id), kind: 'publish_product' }).lean();
      expect(dec!.status).toBe('proposed');
      expect(dec!.summary).toMatch(/acquisition cost is ASSUMED/);
      expect((await admin.post(`/api/v1/admin/automation/decisions/${dec!._id}/approve`)).status).toBe(200);
      expect((await Product.findById(assumed._id).lean())!.state).toBe('PUBLISHED');

      const measured = await mk(4_500, { cpaSource: 'measured', cpa: 2_600, cpaSampleSize: 30 });
      const out2 = await proposePublish(ctx, String(measured._id), measured.title, 1, await canPublish(ctx, String(measured._id)));
      expect(out2?.outcome).toBe('published'); // measured data: automation is allowed
    } finally {
      await ctx.settings.setAutomationMode('auto_publishing', 'ASSISTED', 'test');
    }
  });
});

describe('measured CPA store', () => {
  const usd = { country: 'US' as const, currency: 'USD' as const };
  it('resolves product → category → store → assumed and ignores thin samples', async () => {
    const p = await mk(4_500);
    const id = String(p._id);
    const cat = p.category!;
    expect(await resolveCpa(ctx, { productId: id, category: cat, ...usd })).toEqual({ perOrder: null, source: 'assumed', sampleSize: 0 });
    await recordManualCpa(ctx, { scope: 'store', key: 'store', country: '*', spend: 100_000, orders: 50 }, person); // $20.00/order
    expect(await resolveCpa(ctx, { productId: id, category: cat, ...usd })).toEqual({ perOrder: 2_000, source: 'store', sampleSize: 50 });
    await recordManualCpa(ctx, { scope: 'category', key: cat, country: 'US', spend: 30_000, orders: 10 }, person); // $30.00
    expect(await resolveCpa(ctx, { productId: id, category: cat, ...usd })).toMatchObject({ perOrder: 3_000, source: 'category', sampleSize: 10 });
    await recordManualCpa(ctx, { scope: 'product', key: id, country: 'US', spend: 4_000, orders: 4 }, person); // 4 orders < minCpaSample (5): ignored
    expect((await resolveCpa(ctx, { productId: id, category: cat, ...usd })).source).toBe('category');
    await recordManualCpa(ctx, { scope: 'product', key: id, country: 'US', spend: 6_000, orders: 6 }, person); // $10.00
    expect(await resolveCpa(ctx, { productId: id, category: cat, ...usd })).toEqual({ perOrder: 1_000, source: 'measured', sampleSize: 6 });
  });

  it('manual entries validate their inputs', async () => {
    await expect(recordManualCpa(ctx, { scope: 'store', key: 'store', country: 'US', spend: 0, orders: 3 }, person)).rejects.toMatchObject({ code: 'INVALID' });
    await expect(recordManualCpa(ctx, { scope: 'product', key: 'nope', country: 'US', spend: 10, orders: 3 }, person)).rejects.toMatchObject({ code: 'INVALID' });
  });

  /** n real, paid, non-demo orders for product p in the US. */
  async function realOrders(p: { _id: unknown }, n: number) {
    for (let i = 0; i < n; i++) {
      await Order.create({ orderNumber: `RO-${Math.random().toString(36).slice(2, 10)}`, idempotencyKey: `ro-${Math.random()}`, email: `ro${i}@example.com`, country: 'US', currency: 'USD', isDemo: false, items: [{ productId: p._id, sku: 'S', title: 'x', quantity: 1, unitPrice: 10_000, lineKey: 'l1' }], amounts: { subtotal: 10_000, total: 10_000 }, payment: { status: 'succeeded' } });
    }
  }

  it('is rebuilt from REAL ad metrics only (demo rows excluded) and never overwrites manual entries', async () => {
    const p = await mk(4_500);
    const day = new Date(ctx.now().getTime() - 2 * 86_400_000);
    await AdMetric.create([
      { campaignId: oid(), productId: p._id, platform: 'meta', country: 'US', date: day, spend: 12_000, purchases: 8, isDemo: false },
      { campaignId: oid(), productId: p._id, platform: 'tiktok', country: 'US', date: day, spend: 6_000, purchases: 4, isDemo: false },
      { campaignId: oid(), productId: p._id, platform: 'meta', country: 'US', date: day, spend: 999_999, purchases: 1, isDemo: true }, // ignored
    ]);
    await realOrders(p, 12);
    const manual = await mk(4_500);
    await recordManualCpa(ctx, { scope: 'product', key: String(manual._id), country: 'US', spend: 7_000, orders: 7, note: 'phase 2' }, person);
    await refreshMeasuredCpa(ctx);
    const all = await MeasuredCpa.findOne({ scope: 'product', key: String(p._id), country: 'US', channel: 'all' }).lean();
    expect(all).toMatchObject({ spend: 18_000, orders: 12, source: 'ad_metrics' });
    expect((await MeasuredCpa.findOne({ scope: 'product', key: String(p._id), country: 'US', channel: 'meta' }).lean())!.orders).toBe(8);
    expect((await resolveCpa(ctx, { productId: String(p._id), category: p.category!, country: 'US', currency: 'USD' }))).toEqual({ perOrder: 1_500, source: 'measured', sampleSize: 12 });
    const kept = await MeasuredCpa.findOne({ scope: 'product', key: String(manual._id), country: 'US', channel: 'all' }).lean();
    expect(kept).toMatchObject({ source: 'manual', spend: 7_000, orders: 7 });
  });

  it('platform-claimed purchases are capped at real orders: two platforms claiming the same customers cannot understate CPA, and no real orders means no measurement', async () => {
    const p = await mk(4_500);
    const day = new Date(ctx.now().getTime() - 86_400_000);
    await AdMetric.create([
      { campaignId: oid(), productId: p._id, platform: 'meta', country: 'US', date: day, spend: 10_000, purchases: 10, isDemo: false },
      { campaignId: oid(), productId: p._id, platform: 'tiktok', country: 'US', date: day, spend: 10_000, purchases: 10, isDemo: false },
    ]);
    await refreshMeasuredCpa(ctx);
    const none = await MeasuredCpa.findOne({ scope: 'product', key: String(p._id), country: 'US', channel: 'all' }).lean();
    expect(none!.orders).toBe(0); // 20 claimed, 0 real
    expect((await resolveCpa(ctx, { productId: String(p._id), category: p.category!, country: 'US', currency: 'USD' })).source).not.toBe('measured');
    await realOrders(p, 8); // both platforms claim ~all of 8 real orders → 20 claimed, 8 real
    await refreshMeasuredCpa(ctx);
    const capped = await MeasuredCpa.findOne({ scope: 'product', key: String(p._id), country: 'US', channel: 'all' }).lean();
    expect(capped).toMatchObject({ spend: 20_000, orders: 8 }); // CPA $25.00, not the $10.00 the platforms' 20 purchases imply
    expect((await resolveCpa(ctx, { productId: String(p._id), category: p.category!, country: 'US', currency: 'USD' }))).toEqual({ perOrder: 2_500, source: 'measured', sampleSize: 8 });
  });
});

describe('measured refund rate per product–supplier–destination', () => {
  it('replaces the estimate only with enough real orders, and is prorated across suppliers', async () => {
    const p = await mk(4_500);
    const sup = (await Supplier.findOne({ provider: 'mock' }))!;
    for (let i = 0; i < 10; i++) {
      const o = await Order.create({
        orderNumber: `ECO-${n}-${i}`, idempotencyKey: `eco-${n}-${i}-${Math.random()}`, email: `r${i}@example.com`, country: 'US', currency: 'USD', isDemo: false,
        items: [{ productId: p._id, sku: `ECO-${n}`, title: 'x', quantity: 1, unitPrice: 10_000, lineKey: 'l1' }], amounts: { subtotal: 10_000, total: 10_000 },
        payment: { status: i < 2 ? 'refunded' : 'succeeded' }, costs: { refunded: i < 2 ? 10_000 : 0 },
      });
      await Shipment.create({ orderId: o._id, lineKey: 'l1', productId: p._id, supplierId: sup._id, idempotencyKey: `sh-${n}-${i}-${Math.random()}`, status: 'DELIVERED' });
    }
    expect((await refreshMeasuredRefunds(ctx)).written).toBeGreaterThan(0);
    const rates = await measuredRefundRates(ctx, String(p._id), 'US');
    expect(rates.get(String(sup._id))).toEqual({ rate: 0.2, sample: 10 }); // 2 of 10 orders refunded in full
    const thin = await mk(4_500);
    await Order.create({ orderNumber: `ECO-T-${n}`, idempotencyKey: `eco-t-${n}`, email: 't@example.com', country: 'US', currency: 'USD', items: [{ productId: thin._id, sku: 's', title: 'x', quantity: 1, unitPrice: 100, lineKey: 'l1' }], amounts: { subtotal: 100, total: 100 }, payment: { status: 'succeeded' } });
    await refreshMeasuredRefunds(ctx);
    expect((await measuredRefundRates(ctx, String(thin._id), 'US')).size).toBe(0); // below minRefundSample
  });
});

describe('measured zero refund rate is a measurement, not missing data', () => {
  it('a market with 0% measured refunds over enough orders is evaluated at 0%, labelled measured; without a sample it falls back to the estimate', async () => {
    const measured = await mk(4_500, { cpaSource: 'measured', cpa: 2_600, cpaSampleSize: 30, refundRate: 0, refundSource: 'measured', refundSampleSize: 25 });
    const g = await canPublish(ctx, String(measured._id));
    expect(g.scenarios[0]).toMatchObject({ refundSource: 'measured', refundRate: 0 });
    // pre-CAC margin with zero refunds = (10000-4500-320)/10000 = 51.8% → expected (CAC 26%) = 25.8%, 5 points better than at the 5% base rate
    expect(g.scenarios[0]!.scenarios.expected.margin).toBeCloseTo(0.258, 3);
    const estimated = await mk(4_500, { cpaSource: 'measured', cpa: 2_600, cpaSampleSize: 30, refundRate: 0, refundSource: 'estimated', refundSampleSize: 0 });
    const e = (await canPublish(ctx, String(estimated._id))).scenarios[0]!;
    expect(e).toMatchObject({ refundSource: 'estimated', refundRate: 0.05 });
    expect(e.scenarios.expected.margin).toBeCloseTo(0.208, 3);
  });
});

describe('decision sheet API and CSV', () => {
  beforeAll(async () => { await MeasuredCpa.deleteMany({}); });
  it('every cell carries a basis; assumed CAC is ESTIMATED and needs human approval; CSV carries basis columns', async () => {
    const r = await admin.get('/api/v1/admin/economics?limit=100');
    expect(r.status).toBe(200);
    expect(r.body.rows.length).toBeGreaterThan(3);
    const row = r.body.rows.find((x: any) => x.supplier) ;
    for (const c of [row.sellingPrice, row.productCost, row.shipping, row.duties, row.paymentFee, row.refundAllowance, row.cac.optimistic, row.cac.expected, row.cac.pessimistic, row.contribution.expected, row.marginPct.expected, row.breakEvenCacPct]) {
      expect(['measured', 'quoted', 'set', 'estimated']).toContain(c.basis);
    }
    const assumed = r.body.rows.find((x: any) => x.cpaSource === 'assumed' && x.supplier);
    expect(assumed.cac.expected.basis).toBe('estimated');
    expect(assumed.marginPct.expected.basis).toBe('estimated');
    expect(assumed.needsHumanApproval).toBe(true);
    expect(assumed.cac.expected.value).toBe(Math.round(assumed.sellingPrice.value * 0.26));
    expect(r.body.cacScenarios).toEqual({ optimistic: 0.15, expected: 0.26, pessimistic: 0.4 });

    await Product.updateOne({ _id: assumed.productId }, { $set: { title: '=HYPERLINK("http://evil","x")' } });
    const csv = await admin.get('/api/v1/admin/economics/export');
    expect(csv.status).toBe(200);
    expect(csv.body.filename).toMatch(/^orvia-economics-\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = (csv.body.csv as string).trim().split('\n');
    expect(lines[0]).toMatch(/selling_price,selling_price_basis,/);
    expect(lines[0]).toMatch(/cac_expected,cac_expected_basis/);
    expect(csv.body.csv).toMatch(/,estimated,/);
    expect(csv.body.csv).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`); // formula injection neutralised
  });

  it('a measured CPA flips the expected-case basis to measured', async () => {
    const r0 = await admin.get('/api/v1/admin/economics?limit=100');
    const target = r0.body.rows.find((x: any) => x.supplier && x.cpaSource === 'assumed');
    const post = await admin.post('/api/v1/admin/economics/cpa', { scope: 'product', key: target.productId, country: target.country, spend: 60_000, orders: 20 });
    expect(post.status).toBe(200);
    const r1 = await admin.get('/api/v1/admin/economics?limit=100');
    const row = r1.body.rows.find((x: any) => x.productId === target.productId && x.country === target.country);
    expect(row.cpaSource).toBe('measured');
    expect(row.cpaSampleSize).toBe(20);
    expect(row.cac.expected.basis).toBe('measured');
    expect(row.needsHumanApproval).toBe(false);
  });

  it('is permission-gated', async () => {
    expect((await (await startApi(ctx)).client().get('/api/v1/admin/economics')).status).toBe(401);
  });
});

describe('export / destination attestation hard gate', () => {
  it('blocks publishing and fulfilment per destination until a person attests, with an audit trail', async () => {
    const a = await mk(4_500, { cpaSource: 'measured', cpa: 2_600, cpaSampleSize: 30 });
    const { co } = await placeOrder(admin, { country: 'US' }); // placed while the gate is off (dev default)
    await ctx.settings.set('legal', { requireExportAttestation: true }, 'test');
    try {
      const g = await canPublish(ctx, String(a._id));
      expect(g.ok).toBe(false);
      expect(g.hardProblems.join(' ')).toMatch(/No export \/ destination-market attestation recorded for US/);
      await expect(publishProduct(ctx, String(a._id), person, 'x', { humanApproved: true })).rejects.toMatchObject({ code: 'PUBLISH_BLOCKED' });

      await pay(admin, co.body.payment.intentId);
      await ctx.queue.drain(40);
      const order = (await Order.findOne({ orderNumber: co.body.order.orderNumber }).lean())!;
      expect(await Shipment.countDocuments({ orderId: order._id })).toBe(0);
      expect(await ExceptionModel.countDocuments({ kind: 'EXPORT_ATTESTATION', orderId: order._id })).toBe(1);
      expect((await fulfillOrder(ctx, String(order._id))).state).toBe('held');

      expect((await admin.put('/api/v1/admin/compliance/export/US', { reference: 'x' })).status).toBe(400); // reference required
      expect((await admin.put('/api/v1/admin/compliance/export/US', { reference: 'Adviser opinion 2026-10-20, ref EX-114' })).status).toBe(200);
      const status = await admin.get('/api/v1/admin/compliance/export');
      expect(status.body.items.find((i: any) => i.country === 'US')).toMatchObject({ required: true, attested: true });
      expect(status.body.items.find((i: any) => i.country === 'CA').attested).toBe(false); // per destination

      expect((await canPublish(ctx, String(a._id))).hardProblems).toEqual([]);
      // attesting released the held order: its exception is resolved and fulfilment re-queued
      expect(await ExceptionModel.countDocuments({ kind: 'EXPORT_ATTESTATION', orderId: order._id, status: 'open' })).toBe(0);
      await ctx.queue.drain(40);
      expect(await Shipment.countDocuments({ orderId: order._id })).toBeGreaterThan(0);

      expect((await admin.del('/api/v1/admin/compliance/export/US')).status).toBe(200);
      expect((await canPublish(ctx, String(a._id))).hardProblems.join(' ')).toMatch(/attestation/);
    } finally {
      await ctx.settings.set('legal', { requireExportAttestation: false }, 'test');
    }
  });
});
