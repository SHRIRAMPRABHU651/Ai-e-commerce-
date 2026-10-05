/**
 * DEV / STAGING-DEMO ONLY seed. Uses the real domain flows (import, pricing, checkout, payment webhook,
 * fulfilment, tracking, ads) against the mock providers, then back-dates records so dashboards have history.
 * Refuses to run in production.
 */
import { hashPassword } from '@orvia/auth';
import { Campaign, Cart, Customer, Order, Product, ProductVariant, Promotion, Review, RoleModel, Shipment, Supplier, SupplierProduct, User, Warehouse, MockStore, AdMetric, syncIndexes } from '@orvia/database';
import { MOCK_CATALOG, MOCK_PROFILES } from '@orvia/suppliers';
import { MockPaymentProvider } from '@orvia/payments';
import { ROLE_PERMISSIONS } from '@orvia/auth';
import type { Ctx } from '@orvia/core';
import { MongoKVStore, SYSTEM, canPublish, createOrderFromCart, createTestPlan, ensureCategories, generateDailyBrief, handlePaymentWebhook, importProduct, launchCampaign, publishProduct, refreshProductMarkets, recomputeOrderStatus, syncAdMetrics, syncProductOffers, recomputeRating } from '@orvia/core';
import { ROLES } from '@orvia/types';
import type { CountryCode } from '@orvia/types';

export const SEED_PASSWORD = 'Orvia-Demo-2026!';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export interface SeedOptions {
  orders?: number;
  withHistory?: boolean;
  log?: (m: string) => void;
}

export async function runSeed(ctx: Ctx, opts: SeedOptions = {}) {
  if (ctx.cfg.isProduction || ctx.cfg.APP_ENV === 'production') throw new Error('Refusing to seed: APP_ENV=production');
  if (ctx.cfg.SUPPLIER_MODE !== 'mock' || ctx.cfg.PAYMENT_MODE !== 'mock') throw new Error('Seed requires mock supplier/payment modes');
  const log = opts.log ?? (() => undefined);
  const rand = rng(42);
  await syncIndexes();
  await ensureCategories();
  for (const r of ROLES) await RoleModel.updateOne({ name: r }, { $set: { description: `${r} role`, permissions: ROLE_PERMISSIONS[r] as string[] } }, { upsert: true });

  // staff + customers
  const hash = await hashPassword(SEED_PASSWORD, { fast: ctx.cfg.isTest });
  const staff = [
    ['owner@orvia.test', 'Olivia Owner', 'SUPER_ADMIN'], ['admin@orvia.test', 'Adam Admin', 'ADMIN'], ['marketing@orvia.test', 'Maya Marketing', 'MARKETING'],
    ['ops@orvia.test', 'Omar Ops', 'OPERATIONS'], ['support@orvia.test', 'Sana Support', 'SUPPORT'], ['analyst@orvia.test', 'Ana Analyst', 'ANALYST'],
  ] as const;
  for (const [email, name, role] of staff) await User.updateOne({ email }, { $set: { name, role, passwordHash: hash, emailVerified: true, isDemo: true } }, { upsert: true });
  const demoUsers: { id: string; email: string; name: string; country: CountryCode }[] = [];
  const names = ['Ava Johnson', 'Liam Smith', 'Noah Brown', 'Emma Wilson', 'Priya Sharma', 'Arjun Mehta', 'Chloe Tremblay', 'Ethan Roy', 'Sofia Patel', 'Mason Clark', 'Isla Campbell', 'Rohan Iyer'];
  const countries: CountryCode[] = ['US', 'US', 'US', 'US', 'IN', 'IN', 'CA', 'CA', 'IN', 'US', 'CA', 'IN'];
  for (let i = 0; i < names.length; i++) {
    const email = `customer${i + 1}@demo.orvia.test`;
    const u = await User.findOneAndUpdate({ email }, { $set: { name: names[i]!, role: 'CUSTOMER', passwordHash: hash, emailVerified: true, isDemo: true, country: countries[i] } }, { upsert: true, new: true });
    await Customer.updateOne({ email }, { $set: { name: names[i]!, userId: u._id, country: countries[i], isDemo: true, marketingConsent: i % 2 === 0 } }, { upsert: true });
    demoUsers.push({ id: String(u._id), email, name: names[i]!, country: countries[i]! });
  }
  log(`users: ${staff.length} staff, ${demoUsers.length} customers`);

  // suppliers (mock adapters)
  const supplierDocs = [];
  for (const p of MOCK_PROFILES) {
    const s = await Supplier.findOneAndUpdate(
      { code: p.code },
      { $set: { name: p.name, provider: 'mock', country: ['US', 'CA', 'IN'].includes(p.warehouseCountry) ? p.warehouseCountry : undefined, servesCountries: Object.keys(p.routes), rating: p.rating, reliability: p.reliability, returnPolicyDays: p.returnPolicyDays, trackingAvailable: true, active: true, apiStatus: 'ok', isDemo: true } },
      { upsert: true, new: true },
    );
    await Warehouse.updateOne({ supplierId: s._id, code: `${p.warehouseCountry}-1` }, { $set: { name: `${p.warehouseCountry} main warehouse`, country: p.warehouseCountry } }, { upsert: true });
    supplierDocs.push(s);
  }
  log(`suppliers: ${supplierDocs.length}`);

  // products via the real import flow, linked to every supplier
  const primary = supplierDocs[0]!;
  let published = 0, held = 0, banned = 0;
  for (const item of MOCK_CATALOG) {
    const res = await importProduct(ctx, { supplierId: String(primary._id), externalId: item.externalId }, SYSTEM);
    if (res.state === 'BANNED') {
      banned++;
      continue;
    }
    for (const s of supplierDocs.slice(1)) {
      await SupplierProduct.updateOne({ supplierId: s._id, externalId: item.externalId }, { $set: { productId: res.productId, title: item.title, images: item.images, category: item.category, variants: item.variants, cost: item.baseCostUsd, currency: 'USD', importStatus: 'imported', lastSyncAt: new Date() } }, { upsert: true });
    }
    await syncProductOffers(ctx, res.productId);
    await refreshProductMarkets(ctx, res.productId, { forcePrice: true });
    const gate = await canPublish(ctx, res.productId);
    if (gate.ok) {
      await publishProduct(ctx, res.productId, SYSTEM, 'seed publish');
      published++;
    } else held++;
  }
  log(`products: ${published} published, ${held} held for review, ${banned} rejected by compliance`);

  // promotions
  await Promotion.deleteMany({ recommendedBy: 'seed' });
  await Promotion.insertMany([
    { name: 'Welcome 10%', type: 'first_order', code: 'WELCOME10', percent: 0.1, perUserLimit: 1, active: true, recommendedBy: 'seed' },
    { name: 'Free shipping over threshold', type: 'free_shipping', code: 'SHIPFREE', minSubtotal: { US: 3000, CA: 4000, IN: 30000 }, active: true, recommendedBy: 'seed' },
    { name: 'Summer flash sale', type: 'flash_sale', percent: 0.05, endsAt: new Date(Date.now() + 5 * 86_400_000), startsAt: new Date(Date.now() - 86_400_000), active: true, recommendedBy: 'seed' },
    { name: 'Buy 2 get 1', type: 'bxgy', code: 'BUY2GET1', bxgy: { buy: 2, get: 1, productIds: [] }, active: true, recommendedBy: 'seed' },
  ]);

  if (opts.withHistory === false) return { published };

  // orders through the real checkout + payment webhook + fulfilment + tracking path, then back-dated
  const payments = new MockPaymentProvider(ctx.cfg.MOCK_PAYMENT_WEBHOOK_SECRET, new MongoKVStore());
  const sellable = await Product.find({ state: 'PUBLISHED' }).select('_id slug markets').lean();
  const total = opts.orders ?? 70;
  const addrFor = (c: CountryCode, name: string) =>
    c === 'US' ? { fullName: name, line1: '1600 Market Street', line2: '', city: 'San Francisco', region: 'CA', postalCode: '94102', country: c, phone: '4155550100' }
    : c === 'CA' ? { fullName: name, line1: '100 King Street West', line2: '', city: 'Toronto', region: 'ON', postalCode: 'M5X 1A9', country: c, phone: '4165550100' }
    : { fullName: name, line1: '12 MG Road, Indiranagar', line2: '', city: 'Bengaluru', region: 'KA', postalCode: '560038', country: c, phone: '9876543210' };
  let made = 0;
  for (let i = 0; i < total; i++) {
    const u = demoUsers[Math.floor(rand() * demoUsers.length)]!;
    const country = rand() < 0.15 ? (['US', 'CA', 'IN'] as CountryCode[])[Math.floor(rand() * 3)]! : u.country;
    const pool = sellable.filter((p) => p.markets.some((m) => m.country === country && m.stock > 0 && m.price > 0));
    if (!pool.length) continue;
    const nItems = rand() < 0.7 ? 1 : 2;
    const items = new Set<string>();
    while (items.size < nItems) items.add(String(pool[Math.floor(Math.pow(rand(), 1.6) * pool.length)]!._id));
    const token = `seed-${i}-${Math.floor(rand() * 1e9)}`;
    const lines = [];
    for (const pid of items) {
      const v = await ProductVariant.findOne({ productId: pid }).select('sku').lean();
      lines.push({ productId: pid, sku: v!.sku, quantity: rand() < 0.8 ? 1 : 2 });
    }
    await Cart.create({ token, userId: u.id, country, email: u.email, items: lines, lastActivityAt: new Date() });
    try {
      const r = await createOrderFromCart(ctx, { cartToken: token, userId: u.id, ip: `203.0.113.${(i % 200) + 1}`, ipCountry: country, actor: { id: u.id, type: 'user' } }, { email: u.email, address: addrFor(country, u.name), shippingMethod: 'standard', idempotencyKey: `seed-order-${i}-${Date.now()}` });
      if (!r.payment) continue;
      const sim = await payments.simulate(r.payment.intentId, 'succeeded');
      await handlePaymentWebhook(ctx, 'mock', sim.body, sim.headers);
      await ctx.queue.drain(50);
      made++;
    } catch (e) {
      log(`order ${i} skipped: ${(e as Error).message}`);
    }
  }
  // back-date: spread over ~40 days; older orders are delivered
  const orders = await Order.find({ isDemo: true }).sort({ createdAt: 1 }).lean();
  const day = 86_400_000;
  for (let i = 0; i < orders.length; i++) {
    const o = orders[i]!;
    const ageDays = Math.floor((1 - Math.pow(i / Math.max(1, orders.length - 1), 0.75)) * 40);
    const created = new Date(Date.now() - ageDays * day - Math.floor(rand() * 12) * 3_600_000);
    const paid = new Date(created.getTime() + 60_000);
    const delivered = ageDays >= 9;
    await Order.collection.updateOne({ _id: o._id }, { $set: { createdAt: created, updatedAt: created, 'payment.paidAt': paid, ...(delivered ? { deliveredAt: new Date(created.getTime() + 6 * day), status: 'DELIVERED' } : {}) } });
    await Shipment.collection.updateMany({ orderId: o._id }, { $set: { createdAt: created, ...(delivered ? { status: 'DELIVERED', trackingNumber: undefined } : {}) } });
    await (await import('@orvia/database')).AnalyticsEvent.insertMany(Array.from({ length: 6 + Math.floor(rand() * 10) }, (_, k) => ({ type: k % 3 === 0 ? 'product_view' : 'page_view', sessionId: `sess-${i}-${k}`, country: o.country, ts: new Date(created.getTime() - Math.floor(rand() * 3_600_000)), productId: o.items[0]?.productId })));
  }
  // extra anonymous sessions so conversion rates are < 100%
  const { AnalyticsEvent } = await import('@orvia/database');
  const evs = [];
  for (let k = 0; k < 900; k++) evs.push({ type: 'page_view', sessionId: `anon-${k}`, country: (['US', 'US', 'US', 'CA', 'IN'] as CountryCode[])[k % 5], ts: new Date(Date.now() - Math.floor(rand() * 40 * day)) });
  await AnalyticsEvent.insertMany(evs);
  await Order.updateMany({ isDemo: true }, { $set: { 'timeline.0.at': new Date() } });
  for (const o of orders) await recomputeOrderStatus(String(o._id), 'seed');
  log(`orders: ${made} created through checkout → webhook → fulfilment`);

  // reviews
  const rv = await Product.find({ state: 'PUBLISHED' }).select('_id').lean();
  const bodies = [
    ['Does exactly what it says', 'Arrived on time, well made and my dog loves it. Would recommend.', 5], ['Good quality for the price', 'Sturdy and works well. Shipping was fast.', 5], ['Nice but smaller than expected', 'Quality is good, just a bit small for what I wanted.', 4],
    ['Solid purchase', 'Easy to use and great quality.', 4], ['Okay', 'Does the job. Packaging was a bit damaged but the item was fine.', 3], ['Took a while to arrive', 'Product is fine but delivery was slow and tracking was late.', 3], ['Not as described', 'Arrived late and the colour was different. Disappointed.', 2],
  ] as const;
  for (const p of rv) {
    const n = 2 + Math.floor(rand() * 5);
    const pool = [...demoUsers].sort(() => rand() - 0.5).slice(0, n);
    for (const u of pool) {
      const b = bodies[Math.floor(Math.pow(rand(), 0.7) * bodies.length)]!;
      await Review.updateOne({ productId: p._id, userId: u.id }, { $set: { authorName: u.name.split(' ')[0], rating: b[2], title: b[0], body: b[1], verifiedPurchase: rand() < 0.7, status: 'published', sentiment: b[2] >= 4 ? 'positive' : b[2] <= 2 ? 'negative' : 'neutral', isDemo: true, helpfulVotes: Math.floor(rand() * 8) } }, { upsert: true });
    }
    await recomputeRating(String(p._id));
  }

  // ad campaigns via mock ad network, back-dated so metrics have history
  const top = await Product.find({ state: 'PUBLISHED' }).sort({ 'opportunity.finalScore': -1 }).limit(6).lean();
  for (const [i, p] of top.entries()) {
    const m = p.markets.find((x) => x.enabled && x.stock > 0)!;
    const plan = await createTestPlan(ctx, String(p._id), m.country as CountryCode, (['meta', 'tiktok', 'google'] as const)[i % 3]!, SYSTEM);
    await launchCampaign(ctx, plan.campaignId, SYSTEM);
    const c = await Campaign.findById(plan.campaignId);
    if (c?.externalId) {
      const rec = await MockStore.findOne({ kind: 'ad_campaign', key: c.externalId });
      const d = rec?.data as { activeFrom?: string } | undefined;
      if (rec && d) await MockStore.updateOne({ _id: rec._id }, { $set: { 'data.activeFrom': new Date(Date.now() - (10 - i) * day).toISOString().slice(0, 10) } });
      await Campaign.updateOne({ _id: c._id }, { $set: { launchedAt: new Date(Date.now() - (10 - i) * day) } });
    }
  }
  await syncAdMetrics(ctx, 14);
  log(`campaigns: ${top.length}, ad metric rows: ${await AdMetric.countDocuments()}`);
  await generateDailyBrief(ctx);
  return { published, orders: made };
}
