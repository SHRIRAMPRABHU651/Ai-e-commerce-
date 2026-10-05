import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Order, Product, Shipment, Notification, WebhookEvent, Payment, Job } from '@orvia/database';
import { syncTracking } from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { closeCtx, testCtx } from '../helpers/ctx';
import { address, ageMockOrders, startApi } from '../helpers/client';
import type { Client } from '../helpers/client';
import { runSeed } from '../../scripts/lib/seed';

let ctx: Ctx;
let mk: (h?: Record<string, string>) => Client;
beforeAll(async () => {
  ctx = await testCtx('shop');
  await runSeed(ctx, { withHistory: false });
  mk = (await startApi(ctx)).client;
}, 180_000);
afterAll(closeCtx);

const pickProduct = async (c: Client) => {
  const r = await c.get('/api/v1/products?pageSize=24&country=US');
  expect(r.status).toBe(200);
  const p = r.body.items.find((x: any) => x.available && x.title.includes('Snuffle')) ?? r.body.items[0];
  return p;
};

describe('customer journey: discover → cart → checkout → pay → fulfil → track → deliver', () => {
  const buyer = mk ? undefined : undefined;
  void buyer;
  it('runs end to end with real money-path safeguards', async () => {
    const c = mk();
    // discover
    const meta = await c.get('/api/v1/meta');
    expect(meta.body.countries.map((x: any) => x.code).sort()).toEqual(['CA', 'IN', 'US']);
    expect(meta.body.payment.mode).toBe('mock');
    const home = await c.get('/api/v1/home?country=US');
    expect(home.status).toBe(200);
    expect(home.body.trending.length).toBeGreaterThan(0);
    const search = await c.get('/api/v1/products?q=snufle%20mat&country=US'); // typo
    expect(search.body.items[0].title).toMatch(/Snuffle/);
    expect(search.body.correctedQuery).toBeTruthy();
    const p = await pickProduct(c);
    // product page
    const detail = await c.get(`/api/v1/products/${p.slug}?country=US`);
    expect(detail.status).toBe(200);
    expect(detail.body.product.price).toBeGreaterThan(0);
    expect(detail.body.product.currency).toBe('USD');
    expect(JSON.stringify(detail.body)).not.toMatch(/landedCost|supplierCost|bestSupplierId|expectedMargin/); // no cost leakage
    // country-specific pricing
    const inDetail = await c.get(`/api/v1/products/${p.slug}?country=IN`);
    expect(inDetail.body.product.currency).toBe('INR');
    // cart
    const add = await c.post('/api/v1/cart/items', { productId: p.id, variantSku: detail.body.variants[0].sku, quantity: 2 }, {});
    expect(add.status).toBe(200);
    expect(add.body.itemCount).toBe(2);
    expect(add.body.totals.total).toBe(add.body.subtotal - add.body.discount + add.body.totals.shipping + add.body.totals.tax);
    expect(add.body.promotions.some((x: any) => x.type === 'flash_sale')).toBe(true); // automatic flash sale applies
    // coupon
    const bad = await c.post('/api/v1/cart/coupon', { code: 'NOPE' });
    expect(bad.body.couponError).toMatch(/invalid/i);
    const good = await c.post('/api/v1/cart/coupon', { code: 'WELCOME10' });
    expect(good.body.discount).toBeGreaterThan(0);
    // checkout validation: bad address
    const key = `test-key-${Date.now()}`;
    const badAddr = await c.post('/api/v1/checkout', { email: 'buyer@example.com', address: { ...address.US, postalCode: 'ABC' }, idempotencyKey: key });
    expect(badAddr.status).toBe(422);
    // checkout
    const co = await c.post('/api/v1/checkout', { email: 'buyer@example.com', address: address.US, shippingMethod: 'standard', idempotencyKey: key });
    expect(co.status).toBe(201);
    expect(co.body.payment.provider).toBe('mock');
    expect(co.body.order.status).toBe('PENDING_PAYMENT');
    // double submit with same idempotency key -> same order
    const again = await c.post('/api/v1/checkout', { email: 'buyer@example.com', address: address.US, shippingMethod: 'standard', idempotencyKey: key });
    expect(again.status).toBe(200);
    expect(again.body.order.id).toBe(co.body.order.id);
    expect(await Order.countDocuments({ idempotencyKey: key })).toBe(1);
    // browser cannot mark an order paid: there is no such endpoint, and the order is still pending
    expect((await c.get(`/api/v1/orders/lookup?orderNumber=${co.body.order.orderNumber}&email=buyer@example.com`)).body.status).toBe('PENDING_PAYMENT');
    // pay (dev simulate → signed webhook → verified)
    const intent = co.body.payment.intentId;
    const paid = await c.post(`/api/v1/dev/payments/${intent}/simulate`, { outcome: 'succeeded' });
    expect(paid.body.outcome).toBe('processed');
    expect(paid.body.order.status).toBe('PAID');
    // duplicate webhook delivery is a no-op
    const dup = await c.post(`/api/v1/dev/payments/${intent}/simulate`, { outcome: 'succeeded' });
    expect(['duplicate', 'processed']).toContain(dup.body.outcome);
    expect(await Shipment.countDocuments({ orderId: co.body.order.id })).toBe(0); // not yet processed by worker
    // worker processes the fulfilment job
    await ctx.queue.drain(20);
    const order = await Order.findById(co.body.order.id).lean();
    expect(order!.status).toBe('SUPPLIER_PROCESSING');
    expect(order!.fulfillment!.state).toBe('placed');
    const ships = await Shipment.find({ orderId: order!._id }).lean();
    expect(ships).toHaveLength(1);
    expect(ships[0]!.supplierOrderId).toMatch(/^MS-/);
    expect(order!.costs!.supplierCost).toBeGreaterThan(0);
    expect(order!.profit!.contribution).toBeLessThan(order!.amounts!.total);
    // running fulfilment again (retry / duplicate job) never creates a second supplier order
    const { fulfillOrder } = await import('@orvia/core');
    await fulfillOrder(ctx, String(order!._id));
    expect(await Shipment.countDocuments({ orderId: order!._id })).toBe(1);
    // tracking honesty: supplier has not shipped yet → no tracking number invented
    await syncTracking(ctx, { orderId: String(order!._id) });
    let view = (await c.get(`/api/v1/orders/lookup?orderNumber=${order!.orderNumber}&email=buyer@example.com`)).body;
    expect(view.shipments[0].trackingNumber ?? null).toBeNull();
    // supplier ships; tracking syncs; customer notified exactly once per milestone
    await ageMockOrders(3);
    await syncTracking(ctx, { orderId: String(order!._id) });
    await syncTracking(ctx, { orderId: String(order!._id) });
    view = (await c.get(`/api/v1/orders/lookup?orderNumber=${order!.orderNumber}&email=buyer@example.com`)).body;
    expect(view.shipments[0].trackingNumber).toMatch(/^MOCK/);
    expect(['SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY']).toContain(view.status === 'DELIVERED' ? 'IN_TRANSIT' : view.status);
    await ageMockOrders(30);
    await syncTracking(ctx, { orderId: String(order!._id) });
    await ctx.queue.drain(20);
    view = (await c.get(`/api/v1/orders/lookup?orderNumber=${order!.orderNumber}&email=buyer@example.com`)).body;
    expect(view.status).toBe('DELIVERED');
    const mails = await Notification.find({ orderId: order!._id }).select('template status').lean();
    const templates = mails.map((m) => m.template);
    expect(templates.filter((t) => t === 'order_confirmation')).toHaveLength(1);
    expect(templates.filter((t) => t === 'delivered')).toHaveLength(1);
    expect(templates).toContain('shipped');
    expect(mails.every((m) => ['logged_dev', 'sent'].includes(m.status))).toBe(true); // dev log provider never claims "sent"
    expect(mails.some((m) => m.status === 'sent')).toBe(false);
    expect(await WebhookEvent.countDocuments({ provider: 'mock' })).toBeGreaterThanOrEqual(1);
    expect(await Payment.countDocuments({ orderId: order!._id })).toBe(1);
    expect(await Job.countDocuments({ status: 'dead' })).toBe(0);
  }, 120_000);

  it('rejects forged webhooks and never trusts the payload amount', async () => {
    const c = mk();
    const p = await pickProduct(c);
    const d = await c.get(`/api/v1/products/${p.slug}`);
    await c.post('/api/v1/cart/items', { productId: p.id, variantSku: d.body.variants[0].sku, quantity: 1 });
    const co = await c.post('/api/v1/checkout', { email: 'forge@example.com', address: address.US, idempotencyKey: `forge-${Date.now()}` });
    const forged = await c.post('/api/v1/webhooks/payments/mock', { id: 'evt_forged', type: 'payment.succeeded', intentId: co.body.payment.intentId, amount: 1, currency: 'USD' }, { 'x-mock-signature': 't=1,v1=deadbeef' });
    expect(forged.status).toBe(400);
    expect((await Order.findById(co.body.order.id).lean())!.status).toBe('PENDING_PAYMENT');
    // unsigned
    expect((await c.post('/api/v1/webhooks/payments/mock', { id: 'x' })).status).toBe(400);
  });

  it('handles inventory changing during checkout', async () => {
    const c = mk();
    const p = await pickProduct(c);
    const d = await c.get(`/api/v1/products/${p.slug}`);
    await c.post('/api/v1/cart/items', { productId: p.id, variantSku: d.body.variants[0].sku, quantity: 1 });
    await Product.updateOne({ _id: p.id, 'markets.country': 'US' }, { $set: { 'markets.$.stock': 0 } });
    const co = await c.post('/api/v1/checkout', { email: 'late@example.com', address: address.US, idempotencyKey: `inv-${Date.now()}` });
    expect(co.status).toBe(409);
    expect(co.body.error.code).toBe('CART_CHANGED');
    await Product.updateOne({ _id: p.id, 'markets.country': 'US' }, { $set: { 'markets.$.stock': 50 } });
  });

  it('prices India with INR + inclusive GST and Canada with CAD + provincial tax', async () => {
    const ci = mk();
    const p = await pickProduct(ci);
    const slug = (await ci.get(`/api/v1/products/${p.slug}?country=IN`)).body;
    const add = await ci.post('/api/v1/cart/items?country=IN', { productId: p.id, variantSku: slug.variants[0].sku, quantity: 1 }, {});
    expect(add.body.currency).toBe('INR');
    expect(add.body.totals.taxInclusive).toBe(true);
    const cartIn = (await ci.get('/api/v1/cart?country=IN&region=KA')).body;
    expect(cartIn.totals.total).toBe(cartIn.subtotal - cartIn.discount + cartIn.totals.shipping);
    const cc = mk();
    await cc.post('/api/v1/cart/items?country=CA', { productId: p.id, variantSku: slug.variants[0].sku, quantity: 1 });
    const cartCa = (await cc.get('/api/v1/cart?country=CA&region=ON')).body;
    expect(cartCa.currency).toBe('CAD');
    expect(cartCa.totals.tax).toBeGreaterThan(0);
    expect(cartCa.totals.total).toBe(cartCa.subtotal - cartCa.discount + cartCa.totals.shipping + cartCa.totals.tax);
  });
});
