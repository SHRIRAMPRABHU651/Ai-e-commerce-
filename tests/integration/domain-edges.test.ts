import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnalyticsEvent, Cart, Order, Product, Promotion, Shipment, Supplier, SupplierOffer, SupplierProduct } from '@orvia/database';
import { ManualSupplierProvider } from '@orvia/core';
import { SYSTEM, executeNow, refreshTrends, runAbandonedCarts, runDiscovery, trackEvent } from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { closeCtx, testCtx } from '../helpers/ctx';
import { runSeed } from '../../scripts/lib/seed';

let ctx: Ctx;
beforeAll(async () => { ctx = await testCtx('edges'); await runSeed(ctx, { withHistory: false }); }, 180_000);
afterAll(closeCtx);
const oid = () => new mongoose.Types.ObjectId();
const HOUR = 3_600_000;

describe('manual (API-less) supplier provider', () => {
  const code = 'edge-manual';
  let productId: mongoose.Types.ObjectId; let supplierId: mongoose.Types.ObjectId;
  const p = new ManualSupplierProvider(code, () => 72);
  beforeAll(async () => {
    const s = await Supplier.create({ code, name: 'Edge manual', provider: 'manual', servesCountries: ['US'], active: true });
    supplierId = s._id as mongoose.Types.ObjectId;
    productId = (await Product.findOne().select('_id').lean())!._id as mongoose.Types.ObjectId;
    await SupplierProduct.create({ supplierId, externalId: 'M-1', productId, title: 'Handmade ceramic mug', description: 'd', images: ['/a.jpg'], category: 'home', variants: [{ sku: 'M-1-A', label: 'Blue' }], cost: 8 });
    await SupplierOffer.create({ productId, supplierId, externalId: 'M-1', destination: 'US', warehouseCountry: 'US', currency: 'USD', productCost: 800, shippingCost: 300, fulfillmentFee: 50, stock: 7, source: 'manual', confirmedAt: new Date(), minDays: 3, maxDays: 6 });
    await SupplierOffer.create({ productId, supplierId, externalId: 'M-1', destination: 'CA', warehouseCountry: 'US', currency: 'USD', productCost: 800, shippingCost: 500, stock: 3, source: 'manual', confirmedAt: new Date(Date.now() - 100 * HOUR) });
  });

  it('serves products, variants, inventory, price and shipping from fresh operator-entered offers only', async () => {
    expect((await p.searchProducts({ limit: 5 })).items.map((i) => i.externalId)).toEqual(['M-1']);
    expect((await p.searchProducts({ limit: 5, query: 'ceramic' })).items).toHaveLength(1);
    expect((await p.searchProducts({ limit: 5, query: 'no.such(thing' })).items).toHaveLength(0);
    expect((await p.getProduct('M-1'))!.title).toBe('Handmade ceramic mug');
    expect(await p.getProduct('nope')).toBeNull();
    expect((await p.getVariants('M-1'))[0]!.sku).toBe('M-1-A');
    expect(await p.getVariants('nope')).toEqual([]);
    const inv = await p.getInventory('M-1', 'M-1-A');
    expect(inv.total).toBe(7); // the 100h-old CA offer is excluded
    const price = await p.getPrice('M-1', 'US');
    expect(price).toMatchObject({ productCost: 800, fulfillmentFee: 50, warehouseCountry: 'US' });
    expect(await p.getShippingQuote('M-1', 'US')).toMatchObject({ shippingCost: 300, minDays: 3, maxDays: 6, method: 'manual', available: true });
  });

  it('refuses stale, missing and unknown data instead of inventing it', async () => {
    await expect(p.getPrice('M-1', 'CA')).rejects.toMatchObject({ status: 410 });
    await expect(p.getShippingQuote('M-1', 'CA')).rejects.toMatchObject({ status: 410 });
    await expect(p.getPrice('M-1', 'IN')).rejects.toMatchObject({ status: 404 });
    await expect(p.getInventory('M-9')).rejects.toMatchObject({ status: 410 });
    await expect(new ManualSupplierProvider('ghost', () => 72).getPrice('M-1', 'US')).rejects.toThrow(/Unknown supplier/);
    await expect(p.createOrder({} as never)).rejects.toThrow(/no ordering API/);
    expect(await p.cancelOrder()).toMatchObject({ cancelled: false });
    expect(await p.healthCheck()).toMatchObject({ ok: true });
    expect(await p.getSupplierRating()).toMatchObject({ trackingAvailable: true });
  });

  it('reports orders and tracking exactly as the operator recorded them', async () => {
    await expect(p.getOrder('missing')).rejects.toMatchObject({ status: 404 });
    expect(await p.getTracking('missing')).toMatchObject({ available: false, status: 'CREATED' });
    await Shipment.create({ orderId: oid(), lineKey: 'edge1', supplierId, idempotencyKey: `edge-${Math.random()}`, supplierOrderId: 'MAN-1', status: 'PENDING_CREATE' });
    expect((await p.getOrder('MAN-1')).status).toBe('CREATED');
    expect(await p.getTracking('MAN-1')).toMatchObject({ available: false });
    await Shipment.updateOne({ supplierOrderId: 'MAN-1' }, { $set: { status: 'IN_TRANSIT', trackingNumber: 'TRK1', carrier: 'DHL' } });
    expect(await p.getTracking('MAN-1')).toMatchObject({ available: true, trackingNumber: 'TRK1', carrier: 'DHL', status: 'IN_TRANSIT' });
    expect((await p.getOrder('MAN-1')).trackingNumber).toBe('TRK1');
  });
});

describe('marketing: tracking, trends, abandoned carts, promotions', () => {
  it('counts product views and derives trend scores from behavioural velocity', async () => {
    const prod = (await Product.findOne({ state: 'PUBLISHED' }).select('_id stats').lean())!;
    const before = prod.stats?.views ?? 0;
    await trackEvent(ctx, { type: 'product_view', sessionId: 's1', productId: String(prod._id), country: 'US' });
    await trackEvent(ctx, { type: 'page_view', sessionId: 's1', country: 'US' });
    expect((await Product.findById(prod._id).select('stats').lean())!.stats!.views).toBe(before + 1);
    const day = 86_400_000;
    const other = (await Product.findOne({ state: 'PUBLISHED', _id: { $ne: prod._id } }).select('_id').lean())!;
    await AnalyticsEvent.insertMany([
      { type: 'purchase', sessionId: 'a', productId: prod._id, ts: new Date(Date.now() - day) },
      { type: 'add_to_cart', sessionId: 'a', productId: prod._id, ts: new Date(Date.now() - 2 * day) },
      { type: 'product_view', sessionId: 'b', productId: prod._id, ts: new Date(Date.now() - 10 * day) },
      { type: 'product_view', sessionId: 'c', productId: other._id, ts: new Date(Date.now() - 12 * day) },
      { type: 'product_view', sessionId: 'd', productId: other._id, ts: new Date(Date.now() - 1 * day) },
    ]);
    const r = await refreshTrends(ctx);
    expect(r.updated).toBeGreaterThanOrEqual(2);
    const a = (await Product.findById(prod._id).select('stats').lean())!.stats!.trendScore!;
    const b = (await Product.findById(other._id).select('stats').lean())!.stats!.trendScore!;
    expect(a).toBeGreaterThan(b);
  });

  it('abandoned-cart sequence: waits, escalates through 3 stages, issues a one-time code only in AUTOMATIC promo mode, and stops after a purchase', async () => {
    const prod = (await Product.findOne({ state: 'PUBLISHED' }).select('_id').lean())!;
    const mkCart = (email: string, extra: Record<string, unknown> = {}) => Cart.create({ token: `tok-${Math.random()}`, email, country: 'US', marketingConsent: true, items: [{ productId: prod._id, sku: 'X', quantity: 1 }], lastActivityAt: new Date(), ...extra });
    const fresh = await mkCart('fresh@example.com');
    const noConsent = await mkCart('noconsent@example.com', { marketingConsent: false, lastActivityAt: new Date(Date.now() - 100 * HOUR) });
    const cart = await mkCart('stage@example.com');
    const real = ctx.now;
    const at = (h: number) => { ctx.now = () => new Date(real().getTime() + h * HOUR); };
    await ctx.settings.setAutomationMode('abandoned_cart', 'AUTOMATIC', 't');
    await ctx.settings.setAutomationMode('promotion_optimization', 'AUTOMATIC', 't');
    try {
      expect((await runAbandonedCarts(ctx)).sent).toBe(0); // nothing is old enough yet
      at(2);
      expect((await runAbandonedCarts(ctx)).sent).toBeGreaterThanOrEqual(1);
      expect((await Cart.findById(cart._id).lean())!.abandonment!.stage).toBe(1);
      at(30); await runAbandonedCarts(ctx);
      expect((await Cart.findById(cart._id).lean())!.abandonment!.stage).toBe(2);
      at(120); await runAbandonedCarts(ctx);
      expect((await Cart.findById(cart._id).lean())!.abandonment!.stage).toBe(3);
      expect(await Promotion.countDocuments({ recommendedBy: 'abandoned-cart', countries: 'US' })).toBeGreaterThanOrEqual(1);
      at(400); await runAbandonedCarts(ctx);
      expect((await Cart.findById(cart._id).lean())!.abandonment!.stage).toBe(3); // sequence is capped
      expect((await Cart.findById(noConsent._id).lean())!.abandonment?.stage ?? 0).toBe(0); // no consent → never contacted
      expect((await Cart.findById(fresh._id).lean())!.abandonment!.stage).toBeGreaterThanOrEqual(1);
      // a purchase by the same shopper stops the sequence permanently
      const bought = await mkCart('bought@example.com');
      await Order.collection.insertOne({ orderNumber: `AB-${Math.random()}`, idempotencyKey: `ab-${Math.random()}`, email: 'bought@example.com', country: 'US', currency: 'USD', status: 'PAID', payment: { status: 'succeeded' }, createdAt: new Date(Date.now() + 1000), items: [], amounts: { total: 100 } });
      const r = await runAbandonedCarts(ctx);
      expect(r.stopped).toBeGreaterThanOrEqual(1);
      expect((await Cart.findById(bought._id).lean())!.abandonment!.stopped).toBe(true);
      await ctx.settings.setAutomationMode('abandoned_cart', 'OFF', 't');
      expect(await runAbandonedCarts(ctx)).toEqual({ sent: 0, stopped: 0 });
    } finally {
      ctx.now = real;
      await ctx.settings.setAutomationMode('abandoned_cart', 'AUTOMATIC', 't');
      await ctx.settings.setAutomationMode('promotion_optimization', 'ASSISTED', 't');
    }
  });

  it('the create_promotion executor enforces discount limits and audits creation', async () => {
    await expect(executeNow(ctx, 'create_promotion', { country: 'CA', percent: 0.9 }, SYSTEM)).rejects.toThrow(/exceeds the configured discount limits/);
    const ok = (await executeNow(ctx, 'create_promotion', { country: 'CA', percent: 0.1 }, SYSTEM)) as { code: string };
    expect(ok.code).toBe('FIRST10CA');
  });
});

describe('discovery', () => {
  it('scans every active supplier catalogue, scores candidates, and only proposes (ASSISTED) — never auto-imports', async () => {
    await ctx.settings.setAutomationMode('product_discovery', 'ASSISTED', 't');
    const before = await Product.countDocuments();
    const s = await runDiscovery(ctx, { perSupplier: 12 });
    expect(s.suppliersScanned).toBeGreaterThan(0);
    expect(s.candidates).toBe(s.rejected + s.watch + s.proposed + s.imported);
    expect(s.imported).toBe(0);
    expect(await Product.countDocuments()).toBe(before);
  });

  it('records a scan error for a supplier whose adapter cannot be built and keeps scanning the rest', async () => {
    await Supplier.create({ code: 'edge-broken', name: 'Broken', provider: 'doesnotexist', servesCountries: ['US'], active: true });
    const s = await runDiscovery(ctx, { perSupplier: 3 });
    expect(s.errors.some((e) => e.startsWith('edge-broken'))).toBe(true);
    expect(s.suppliersScanned).toBeGreaterThan(0);
  });
});
