import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExceptionModel, Order, Product, ProductVariant, Shipment, Supplier, SupplierOffer } from '@orvia/database';
import { fulfillmentModeOf, invalidateSearchIndex, refreshProductMarkets, runSupplierHealthChecks, syncProductOffers } from '@orvia/core';
import { capabilitiesForSupplier } from '@orvia/suppliers';
import { DEFAULT_RANK_WEIGHTS, paymentFeeModelFor, rankSupplierOffers } from '@orvia/analytics';
import { DEFAULT_COUNTRIES } from '@orvia/types';
import type { Ctx } from '@orvia/core';
import { closeCtx, testCtx } from '../helpers/ctx';
import { Client, startApi } from '../helpers/client';
import { fakeSupplier, restMapping } from '../helpers/fakeSupplier';
import { pay, placeOrder } from '../helpers/shop';
import { runSeed } from '../../scripts/lib/seed';

const A = fakeSupplier('keyA', 'https://cdn.a.example', 47831, { cost: 3.5, min: 6, max: 10 });
const B = fakeSupplier('keyB', 'https://cdn.b.example', 47832, { cost: 2.0, min: 3, max: 6 });
let ctx: Ctx; let admin: Client; let api: () => Client;
let supA = ''; let supB = ''; let productId = ''; let slug = '';

beforeAll(async () => {
  await A.start(); await B.start();
  ctx = await testCtx('supops');
  await runSeed(ctx, { withHistory: false });
  api = (await startApi(ctx)).client;
  admin = api();
  expect((await admin.post('/api/v1/auth/admin/login', { email: 'owner@orvia.test', password: 'Orvia-Demo-2026!' })).status).toBe(200);
  const mk = async (code: string, port: number, key: string) => (await admin.post('/api/v1/admin/suppliers', { code, name: code, provider: 'rest', servesCountries: ['US'], country: 'US', credentials: { apiKey: key }, config: restMapping(`http://localhost:${port}`, 'US') })).body.id as string;
  supA = await mk('ops-supplier-a', 47831, 'keyA');
  supB = await mk('ops-supplier-b', 47832, 'keyB');
  const imp = await admin.post('/api/v1/admin/products/import', { supplierId: supA, externalId: 'P100' });
  productId = imp.body.productId;
  await admin.post(`/api/v1/admin/products/${productId}/link-supplier`, { supplierId: supB, externalId: 'P100' });
  await Product.updateOne({ _id: productId }, { $set: { state: 'PUBLISHED', 'markets.$[].price': 400000 } });
  slug = (await Product.findById(productId).lean())!.slug;
  await syncProductOffers(ctx, productId);
  await refreshProductMarkets(ctx, productId);
  invalidateSearchIndex();
}, 180_000);
afterAll(async () => { await A.stop(); await B.stop(); await closeCtx(); });

const checkout = async () => {
  const c = api();
  const { co } = await placeOrder(c, { country: 'US', products: [{ id: productId, slug }] });
  expect(co.status).toBe(201);
  await pay(c, co.body.payment.intentId);
  await ctx.queue.drain(40);
  return String(co.body.order.id ?? (await Order.findOne({ orderNumber: co.body.order.orderNumber }).lean())!._id);
};

describe('capability registry and fulfilment modes', () => {
  it('derives REST capabilities from the supplier mapping and never claims more', async () => {
    const full = capabilitiesForSupplier({ provider: 'rest', config: restMapping('http://x.example', 'US') })!;
    expect(full.capabilities).toMatchObject({ catalog: 'supported', createOrder: 'supported', tracking: 'supported', cancelOrder: 'unsupported', returns: 'unsupported', videos: 'unsupported' });
    const noOrders = capabilitiesForSupplier({ provider: 'rest', config: { ...restMapping('http://x.example', 'US'), endpoints: { ...restMapping('http://x.example', 'US').endpoints, createOrder: undefined } } });
    expect(noOrders!.capabilities.createOrder).not.toBe('supported');
    expect(capabilitiesForSupplier({ provider: 'manual' })!.capabilities.createOrder).toBe('unsupported');
    expect(capabilitiesForSupplier({ provider: 'nope' })).toBeNull();
    expect(capabilitiesForSupplier({ provider: 'cj' })!.integrationStatus).toBe('implemented_unverified');
  });

  it('new API suppliers start ASSISTED; mock stays AUTOMATED; AUTOMATED needs passed validation', async () => {
    expect(fulfillmentModeOf({ provider: 'rest' })).toBe('ASSISTED');
    expect(fulfillmentModeOf({ provider: 'mock' })).toBe('AUTOMATED');
    expect(fulfillmentModeOf({ provider: 'manual', fulfillmentMode: 'AUTOMATED' })).toBe('MANUAL');
    const r = await admin.put(`/api/v1/admin/suppliers/${supA}/fulfillment-mode`, { mode: 'AUTOMATED' });
    expect(r.status).toBe(409);
    expect(r.body.error.details.missing).toContain('connection');
  });

  it('the order test never runs without an explicit operator confirmation', async () => {
    const r = await admin.post(`/api/v1/admin/suppliers/${supA}/test/order`, { params: { externalId: 'P100' } });
    expect(r.body.status).toBe('skipped');
    expect(A.seen.filter((x) => x === 'POST /orders')).toHaveLength(0);
    const live = await admin.post(`/api/v1/admin/suppliers/${supA}/test/order`, { params: { externalId: 'P100', confirm: 'PLACE TEST ORDER', address: { fullName: 'T', line1: '1', city: 'c', region: 'CA', postalCode: '94105', country: 'US' } } });
    expect(live.body.status).toBe('skipped'); // no sandbox: must also acknowledge a real order
    expect(A.seen.filter((x) => x === 'POST /orders')).toHaveLength(0);
  });
});

describe('ASSISTED supplier: a human approves, then the API order is placed exactly once', () => {
  it('holds the order with a MANUAL_FULFILLMENT task and does not call the supplier', async () => {
    A.seen.length = 0; B.seen.length = 0;
    const orderId = await checkout();
    expect(A.seen.concat(B.seen).filter((x) => x === 'POST /orders')).toHaveLength(0);
    const ex = await ExceptionModel.findOne({ orderId, kind: 'MANUAL_FULFILLMENT' }).lean();
    expect(ex).toBeTruthy();
    expect(ex!.issue).toMatch(/ASSISTED/);
    expect((await Order.findById(orderId).lean())!.status).toBe('EXCEPTION');
    // approve → API order placed once, even if the approval is clicked twice
    expect((await admin.post(`/api/v1/admin/exceptions/${String(ex!._id)}/action`, { action: 'approve_fulfillment' })).status).toBe(200);
    await ctx.queue.drain(40);
    await admin.post(`/api/v1/admin/orders/${orderId}/retry-fulfillment`, { force: true });
    await ctx.queue.drain(40);
    expect(Shipment.countDocuments({ orderId })).resolves.toBe(1);
    expect(A.seen.concat(B.seen).filter((x) => x === 'POST /orders')).toHaveLength(1);
  });
});

describe('supplier health monitor and failover', () => {
  it('marks a failing supplier FAILING after repeated checks, excludes it from new orders and recovers', async () => {
    await Supplier.updateOne({ _id: supA }, { $set: { fulfillmentMode: 'AUTOMATED' } });
    await Supplier.updateOne({ _id: supB }, { $set: { fulfillmentMode: 'AUTOMATED' } });
    B.state.failing = true;
    for (let i = 0; i < 3; i++) await runSupplierHealthChecks(ctx);
    const b = await Supplier.findById(supB).lean();
    expect(b!.healthState).toBe('FAILING');
    expect((await Supplier.findById(supA).lean())!.healthState).toBe('HEALTHY');
    expect(await ExceptionModel.countDocuments({ kind: 'SUPPLIER_FAILURE', dedupeKey: `health:${supB}`, status: 'open' })).toBe(1);
    // a new order is routed away from the failing supplier
    A.seen.length = 0; B.seen.length = 0;
    await ctx.settings.invalidate();
    await checkout();
    expect(B.seen.filter((x) => x === 'POST /orders')).toHaveLength(0);
    expect(A.seen.filter((x) => x === 'POST /orders')).toHaveLength(1);
    // recovery
    B.state.failing = false;
    await runSupplierHealthChecks(ctx);
    expect((await Supplier.findById(supB).lean())!.healthState).toBe('HEALTHY');
    expect(await ExceptionModel.countDocuments({ dedupeKey: `health:${supB}`, status: 'open' })).toBe(0);
  });

  it('fails over to the next supplier when the chosen one refuses the order, without double-ordering', async () => {
    // B is cheaper/faster so it wins; make it reject the order definitively, A must take it
    A.seen.length = 0; B.seen.length = 0;
    const origQuote = B.state.stock;
    B.state.stock = 120;
    B.server.removeAllListeners('request');
    B.server.on('request', (req, res) => { res.statusCode = req.method === 'POST' && req.url === '/orders' ? 422 : 200; res.setHeader('content-type', 'application/json'); res.end(req.method === 'POST' ? '{"error":"out of stock"}' : JSON.stringify({ id: 'P100', title: 'Spiral Slow Feeder Dog Bowl', description: 'A durable bowl with a spiral maze that slows down fast eaters.', price: 2.0, stock: 120, images: [], shipping: { cost: 2, minDays: 3, maxDays: 6 } })); if (req.method === 'POST') B.seen.push('POST /orders'); });
    const orderId = await checkout();
    const ships = await Shipment.find({ orderId }).lean();
    expect(ships.filter((s) => s.status !== 'FAILED')).toHaveLength(1);
    expect(A.seen.filter((x) => x === 'POST /orders')).toHaveLength(1);
    expect(ships.some((s) => s.status === 'FAILED' || String(s.supplierId) === supA)).toBe(true);
    B.state.stock = origQuote;
  });
});

describe('manual (no-API) supplier', () => {
  let manual = ''; let orderId = '';
  it('uses operator-entered offers that expire, and never fabricates stock', async () => {
    manual = (await admin.post('/api/v1/admin/suppliers', { code: 'ops-manual', name: 'Local workshop', provider: 'manual', servesCountries: ['US'], country: 'US' })).body.id;
    expect((await admin.put(`/api/v1/admin/suppliers/${manual}/fulfillment-mode`, { mode: 'AUTOMATED' })).status).toBe(422);
    // make the manual supplier the only option for a fresh product
    const bare = await Product.create({ slug: 'manual-lamp', sku: 'MAN-1', title: 'Handmade lamp', description: 'A handmade lamp made in a small workshop.', state: 'PUBLISHED', images: [{ url: '/art/manual-lamp?v=1' }], imageStatus: 'READY', compliance: { status: 'passed', flags: [] }, markets: [{ country: 'US', enabled: true, currency: 'USD', price: 400000, stock: 0, expectedMargin: 0.5 }] });
    const r = await admin.post(`/api/v1/admin/products/${String(bare._id)}/manual-offer`, { supplierId: manual, countries: ['US'], currency: 'USD', productCost: 2500, shippingCost: 500, stock: 4, minDays: 5, maxDays: 9, warehouseCountry: 'US', images: [] });
    expect(r.status).toBe(200);
    const offer = await SupplierOffer.findOne({ productId: bare._id, supplierId: manual }).lean();
    expect(offer).toMatchObject({ source: 'manual', stock: 4, available: true });
    // an expired offer becomes unavailable on the next sync (we never refresh manual data by ourselves)
    await SupplierOffer.updateOne({ _id: offer!._id }, { $set: { confirmedAt: new Date(Date.now() - 100 * 3_600_000) } });
    const sync = await syncProductOffers(ctx, String(bare._id));
    expect(sync.failures.map((f) => f.error).join(' ')).toMatch(/expired|no manual offer/i);
    expect((await SupplierOffer.findOne({ _id: offer!._id }).lean())!.available).toBe(false);
    productId = String(bare._id);
    await ProductVariant.create({ productId: bare._id, sku: 'MANUAL-LAMP-STD', label: 'Standard', options: {}, active: true });
  });

  it('a paid order creates a MANUAL task; recording the supplier order id continues the pipeline', async () => {
    // re-confirm the offer, then order
    await admin.post(`/api/v1/admin/products/${productId}/manual-offer`, { supplierId: manual, countries: ['US'], currency: 'USD', productCost: 2500, shippingCost: 500, stock: 4, minDays: 5, maxDays: 9, warehouseCountry: 'US' });
    await Product.updateOne({ _id: productId }, { $set: { 'markets.$[].price': 400000, 'markets.$[].stock': 4 } });
    invalidateSearchIndex();
    const c = api();
    const { co } = await placeOrder(c, { country: 'US', products: [{ id: productId, slug: 'manual-lamp' }] });
    expect(co.status).toBe(201);
    await pay(c, co.body.payment.intentId);
    await ctx.queue.drain(40);
    const order = await Order.findOne({ orderNumber: co.body.order.orderNumber }).lean();
    orderId = String(order!._id);
    const ex = await ExceptionModel.findOne({ orderId, kind: 'MANUAL_FULFILLMENT' }).lean();
    expect(ex).toBeTruthy();
    expect(await Shipment.countDocuments({ orderId })).toBe(0);
    const rec = await admin.post(`/api/v1/admin/orders/${orderId}/manual-fulfillment`, { supplierId: manual, supplierOrderId: 'WORKSHOP-77', trackingNumber: 'TRK-123', carrier: 'USPS' });
    expect(rec.status).toBe(200);
    const dup = await admin.post(`/api/v1/admin/orders/${orderId}/manual-fulfillment`, { supplierId: manual, supplierOrderId: 'WORKSHOP-78' });
    expect(dup.status).toBe(422); // every line already has a supplier order — no duplicates
    const ship = await Shipment.findOne({ orderId }).lean();
    expect(ship).toMatchObject({ supplierOrderId: 'WORKSHOP-77', trackingNumber: 'TRK-123', status: 'CREATED' });
    expect(await ExceptionModel.countDocuments({ orderId, status: 'open' })).toBe(0);
  });
});

describe('configurable supplier ranking', () => {
  const base = { rating: 4, returnPolicyDays: 14, trackingAvailable: true, available: true, stock: 50, minDays: 5, maxDays: 8 };
  const offers = [
    { ...base, supplierId: 'cheap-overseas', supplierName: 'Cheap overseas', warehouseCountry: 'CN', productCost: 800, shippingCost: 300, reliability: 70, maxDays: 20, minDays: 12 },
    { ...base, supplierId: 'local', supplierName: 'Local', warehouseCountry: 'US', productCost: 1100, shippingCost: 400, reliability: 85 },
  ];
  const ctxR = { sellingPrice: 4000, quantity: 1, country: DEFAULT_COUNTRIES.US, paymentFee: paymentFeeModelFor('US'), baseRefundRate: 0.05, adCostPerOrder: 500, minMargin: 0 };
  it('prefers the local warehouse when the margin is still acceptable (destination fit + delivery), and exposes the reasoning', () => {
    const r = rankSupplierOffers(offers, ctxR);
    expect(r[0]!.supplierId).toBe('local');
    expect(r[0]!.breakdown.destinationFit).toBe(100);
    expect(r[1]!.breakdown.destinationFit).toBe(40);
  });
  it('weights are configurable: a profit-only profile flips the winner', () => {
    const r = rankSupplierOffers(offers, { ...ctxR, weights: { ...Object.fromEntries(Object.keys(DEFAULT_RANK_WEIGHTS).map((k) => [k, 0])), profit: 1 } });
    expect(r[0]!.supplierId).toBe('cheap-overseas');
  });
  it('stale data lowers stock confidence', () => {
    const fresh = rankSupplierOffers([{ ...offers[1]!, freshnessMs: 0 }], ctxR)[0]!;
    const stale = rankSupplierOffers([{ ...offers[1]!, freshnessMs: 24 * 3_600_000 }], ctxR)[0]!;
    expect(stale.stale).toBe(true);
    expect(stale.breakdown.stockConfidence).toBeLessThan(fresh.breakdown.stockConfidence);
  });
});
