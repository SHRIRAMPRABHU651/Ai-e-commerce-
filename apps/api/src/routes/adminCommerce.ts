import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AuditLog, Customer, ExceptionModel, Inventory, Order, Payment, Product, Refund, Shipment, Supplier, SupplierOffer, SupplierProduct, ProductScore, Campaign, AiDecision, Warehouse } from '@orvia/database';
import {
  changeSupplier, cancelOrder, compareSuppliers, DomainError, importProduct, insights, financials, notFound, notify, parseRange, productPerformance, publishProduct, refreshProductMarkets,
  refundOrder, retrySupplierOrder, countryAnalytics, liveStats, setManualPrice, supplierHealth, syncInventory, syncProductOffers, timeseries, transitionProduct, createTestPlan, planMarket, automationOverview, scoreProduct, invalidateSearchIndex, launchCampaign,
} from '@orvia/core';
import { PRODUCT_STATES, ORDER_STATUSES, countrySchema, objectId, paginationSchema } from '@orvia/types';
import type { CountryCode } from '@orvia/types';
import type { Ctx } from '@orvia/core';
import { route } from '../http';
import { escapeRegex, paginate } from '../util';

const rangeSchema = z.object({ preset: z.enum(['today', '7d', '30d', '90d', 'custom']).default('today'), from: z.string().optional(), to: z.string().optional() });
const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;

export function adminCommerceRoutes(app: FastifyInstance, ctx: Ctx): void {
  const A = 'staff' as const;

  route(app, ctx, {
    method: 'GET', url: '/admin/overview', summary: 'Dashboard overview (today vs yesterday, live, insights)', tags: ['Admin'], auth: A, permission: 'overview:read', query: rangeSchema,
    handler: async ({ query }) => {
      const range = parseRange(query.preset, query.from, query.to, ctx.now());
      const prevSpan = range.to.getTime() - range.from.getTime();
      const prev = { from: new Date(range.from.getTime() - prevSpan - 1), to: new Date(range.from.getTime() - 1) };
      const [f, fp, live, ins, perf, countries, suppliers, series, exceptions, decisions, autos] = await Promise.all([
        financials(ctx, range), financials(ctx, prev), liveStats(ctx), insights(ctx), productPerformance(ctx, parseRange('30d'), 5), countryAnalytics(ctx, parseRange('30d')), supplierHealth(),
        timeseries(ctx, range.to.getTime() - range.from.getTime() < 2 * 86_400_000 ? parseRange('7d') : range),
        ExceptionModel.find({ status: { $in: ['open', 'in_progress'] } }).sort({ createdAt: -1 }).limit(5).lean(), AiDecision.countDocuments({ status: 'proposed' }), automationOverview(ctx),
      ]);
      return { range, current: f, previous: fp, live, insights: ins, winners: perf.winners, losers: perf.losers, countries: countries.countries, countryRecommendation: countries.recommendation, suppliers, series, exceptions, pendingDecisions: decisions, automations: autos.map((a) => ({ key: a.key, name: a.name, mode: a.mode, successRate: a.successRate })) };
    },
  });

  // ---------------------------------------------------------------- orders
  route(app, ctx, {
    method: 'GET', url: '/admin/orders', summary: 'Orders table', tags: ['Admin'], auth: A, permission: 'orders:read',
    query: paginationSchema.extend({ status: z.enum(ORDER_STATUSES).optional(), country: countrySchema.optional(), q: z.string().trim().max(60).optional(), exception: z.coerce.boolean().optional() }),
    handler: async ({ query }) => {
      const filter: Record<string, unknown> = {};
      if (query.status) filter['status'] = query.status;
      if (query.country) filter['country'] = query.country;
      if (query.exception) filter['exceptionOpen'] = true;
      if (query.q) filter['$or'] = [{ orderNumber: new RegExp('^' + escapeRegex(query.q), 'i') }, { email: new RegExp('^' + escapeRegex(query.q), 'i') }];
      const r = await paginate(Order, filter, { ...query, select: 'orderNumber email country currency items amounts status payment.status fulfillment.state profit.contribution costs exceptionOpen createdAt address.fullName fraud.level' });
      const ids = r.items.map((o) => o._id);
      const ships = await Shipment.find({ orderId: { $in: ids } }).select('orderId supplierId trackingNumber carrier status').lean();
      const sups = new Map((await Supplier.find({ _id: { $in: ships.map((s) => s.supplierId) } }).select('name code').lean()).map((s) => [String(s._id), s]));
      return {
        ...r,
        items: r.items.map((o) => {
          const sh = ships.filter((s) => String(s.orderId) === String(o._id));
          return { id: String(o._id), orderNumber: o.orderNumber, customer: o.address?.fullName ?? o.email, email: o.email, country: o.country, currency: o.currency, product: o.items[0]?.title + (o.items.length > 1 ? ` +${o.items.length - 1}` : ''), total: o.amounts?.total ?? 0, supplier: [...new Set(sh.map((s) => sups.get(String(s.supplierId))?.name).filter(Boolean))].join(', ') || null, paymentStatus: o.payment?.status, fulfillment: o.fulfillment?.state, tracking: sh.find((s) => s.trackingNumber)?.trackingNumber ?? null, profit: o.fulfillment?.state === 'placed' ? (o.profit?.contribution ?? 0) : null, status: o.status, fraud: o.fraud?.level, exceptionOpen: o.exceptionOpen, createdAt: (o as unknown as { createdAt: Date }).createdAt };
        }),
      };
    },
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/orders/:id', summary: 'Order detail with costs, shipments, exceptions, audit', tags: ['Admin'], auth: A, permission: 'orders:read',
    handler: async ({ req }) => {
      const o = await Order.findById(idOf(req)).lean();
      if (!o) throw notFound('Order');
      const [ships, ex, pay, refunds, audit] = await Promise.all([
        Shipment.find({ orderId: o._id }).lean(), ExceptionModel.find({ orderId: o._id }).sort({ createdAt: -1 }).limit(20).lean(), Payment.findOne({ orderId: o._id }).lean(), Refund.find({ orderId: o._id }).lean(),
        AuditLog.find({ resource: 'order', resourceId: String(o._id) }).sort({ timestamp: -1 }).limit(50).lean(),
      ]);
      const sups = new Map((await Supplier.find({ _id: { $in: ships.map((s) => s.supplierId) } }).select('name code').lean()).map((s) => [String(s._id), s]));
      return { order: o, shipments: ships.map((s) => ({ ...s, supplierName: sups.get(String(s.supplierId))?.name })), exceptions: ex, payment: pay, refunds, audit };
    },
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/orders/:id/cancel', summary: 'Cancel order (cancels at supplier, refunds if paid)', tags: ['Admin'], auth: A, permission: 'orders:write', body: z.object({ reason: z.string().trim().min(3).max(300) }),
    handler: async ({ req, body }) => (await cancelOrder(ctx, idOf(req), req.actor, body.reason), { ok: true }),
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/orders/:id/refund', summary: 'Refund order (full or partial)', tags: ['Admin'], auth: A, permission: 'refunds:write', body: z.object({ amount: z.number().int().positive().optional(), reason: z.string().trim().min(3).max(300) }),
    handler: async ({ req, body }) => refundOrder(ctx, idOf(req), { actor: req.actor, amount: body.amount, reason: body.reason }),
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/orders/:id/retry-fulfillment', summary: 'Retry supplier order (idempotent)', tags: ['Admin'], auth: A, permission: 'orders:write', body: z.object({ force: z.boolean().default(false) }),
    handler: async ({ req, body }) => (await retrySupplierOrder(ctx, idOf(req), req.actor, { force: body.force }), { queued: true }),
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/orders/:id/change-supplier', summary: 'Cancel at current supplier and re-place with the next best', tags: ['Admin'], auth: A, permission: 'orders:write', body: z.object({ lineKey: z.string().max(120) }),
    handler: async ({ req, body }) => (await changeSupplier(ctx, idOf(req), body.lineKey, req.actor), { queued: true }),
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/orders/:id/contact', summary: 'Email the customer about this order', tags: ['Admin'], auth: A, permission: 'orders:write', body: z.object({ subject: z.string().trim().min(3).max(120), message: z.string().trim().min(3).max(2000) }),
    handler: async ({ req, body }) => {
      const o = await Order.findById(idOf(req)).lean();
      if (!o) throw notFound('Order');
      const id = await notify(ctx, { template: 'custom', to: o.email, orderId: String(o._id), data: { name: o.address?.fullName ?? undefined, subject: body.subject, message: body.message, url: `${ctx.cfg.WEB_URL}/orders/${o.orderNumber}` }, dedupeKey: `contact:${o._id}:${Date.now()}` });
      return { queued: !!id };
    },
  });

  // -------------------------------------------------------------- products
  route(app, ctx, {
    method: 'GET', url: '/admin/products', summary: 'Products table', tags: ['Admin'], auth: A, permission: 'products:read',
    query: paginationSchema.extend({ state: z.enum(PRODUCT_STATES).optional(), q: z.string().trim().max(60).optional(), category: z.string().max(80).optional() }),
    handler: async ({ query }) => {
      const filter: Record<string, unknown> = {};
      if (query.state) filter['state'] = query.state;
      if (query.category) filter['$or'] = [{ category: query.category }, { topCategory: query.category }];
      if (query.q) filter['title'] = new RegExp(escapeRegex(query.q), 'i');
      const r = await paginate(Product, filter, { ...query, select: 'title slug state category topCategory images markets stats opportunity compliance.status createdAt' });
      return { ...r, items: r.items.map((p) => ({ id: String(p._id), title: p.title, slug: p.slug, state: p.state, category: p.category, image: p.images?.[0]?.url, opportunity: p.opportunity?.finalScore ?? null, action: p.opportunity?.action ?? null, compliance: p.compliance?.status, sold: p.stats?.soldCount ?? 0, rating: p.stats?.ratingAvg ?? 0, markets: p.markets.map((m) => ({ country: m.country, price: m.price, currency: m.currency, margin: m.expectedMargin, profit: m.expectedProfit, stock: m.stock })) })) };
    },
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/products/:id', summary: 'Product detail: economics, supplier comparison, scores, campaigns', tags: ['Admin'], auth: A, permission: 'products:read',
    handler: async ({ req }) => {
      const p = await Product.findById(idOf(req)).lean();
      if (!p) throw notFound('Product');
      const enabled = p.markets.filter((m) => m.enabled).map((m) => m.country as CountryCode);
      const comparisons = await Promise.all(enabled.map((c) => compareSuppliers(ctx, String(p._id), c)));
      const plans = await Promise.all(enabled.map((c) => planMarket(ctx, String(p._id), c).then((pl) => ({ country: c, economics: pl.economics, pricing: pl.pricing, strategy: pl.strategy, competitorPrices: pl.competitorPrices })).catch(() => ({ country: c, economics: null, pricing: null, strategy: '', competitorPrices: [] }))));
      const [scores, camps, decisions, exceptions] = await Promise.all([
        ProductScore.find({ productId: p._id }).sort({ computedAt: -1 }).limit(5).lean(), Campaign.find({ productId: p._id }).sort({ createdAt: -1 }).limit(10).lean(),
        AiDecision.find({ resourceId: String(p._id), status: 'proposed' }).limit(10).lean(), ExceptionModel.find({ productId: p._id, status: { $in: ['open', 'in_progress'] } }).limit(10).lean(),
      ]);
      return { product: p, comparisons, plans, scores, campaigns: camps, decisions, exceptions };
    },
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/suppliers/:id/catalog', summary: 'Search a supplier catalogue (for import)', tags: ['Admin'], auth: A, permission: 'products:write', query: z.object({ q: z.string().max(60).optional(), cursor: z.string().max(40).optional() }),
    handler: async ({ req, query }) => {
      const s = await Supplier.findById(idOf(req));
      if (!s) throw notFound('Supplier');
      const res = await ctx.suppliers.resolve({ provider: s.provider, code: s.code }).searchProducts({ query: query.q, cursor: query.cursor, limit: 20 });
      const linked = await SupplierProduct.find({ supplierId: s._id, externalId: { $in: res.items.map((i) => i.externalId) } }).select('externalId productId importStatus').lean();
      const lm = new Map(linked.map((l) => [l.externalId, l]));
      return { items: res.items.map((i) => ({ externalId: i.externalId, title: i.title, category: i.category, image: i.images[0], baseCostUsd: i.baseCostUsd, imported: !!lm.get(i.externalId)?.productId, importStatus: lm.get(i.externalId)?.importStatus ?? null })), nextCursor: res.nextCursor };
    },
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/products/import', summary: 'Import a supplier product (AI content + compliance + pricing)', tags: ['Admin'], auth: A, permission: 'products:write', body: z.object({ supplierId: objectId, externalId: z.string().min(1).max(120) }),
    handler: async ({ req, body, reply }) => {
      const r = await importProduct(ctx, body, req.actor);
      invalidateSearchIndex();
      return reply.status(201).send(r);
    },
  });
  route(app, ctx, {
    method: 'PATCH', url: '/admin/products/:id', summary: 'Edit product content / pricing config', tags: ['Admin'], auth: A, permission: 'products:write',
    body: z.object({ title: z.string().min(3).max(200).optional(), description: z.string().max(5000).optional(), bullets: z.array(z.string().max(300)).max(10).optional(), tags: z.array(z.string().max(40)).max(20).optional(), pricingStrategy: z.enum(['cost_plus', 'target_margin', 'competitor_based', 'dynamic_demand', 'ai_optimized']).optional(), targetMarginPct: z.number().min(0.05).max(0.9).optional() }),
    handler: async ({ req, body }) => {
      const p = await Product.findById(idOf(req));
      if (!p) throw notFound('Product');
      const prev = { title: p.title, strategy: p.pricingConfig?.strategy };
      if (body.title) p.title = body.title;
      if (body.description !== undefined) p.description = body.description;
      if (body.bullets) p.bullets = body.bullets;
      if (body.tags) p.tags = body.tags;
      if (body.pricingStrategy) p.pricingConfig = { ...(p.pricingConfig as object), strategy: body.pricingStrategy, targetMarginPct: body.targetMarginPct ?? p.pricingConfig?.targetMarginPct ?? 0.4 } as never;
      else if (body.targetMarginPct) p.pricingConfig = { ...(p.pricingConfig as object), targetMarginPct: body.targetMarginPct } as never;
      await p.save();
      invalidateSearchIndex();
      const { audit } = await import('@orvia/core');
      await audit(ctx, req.actor, { action: 'product.edited', resource: 'product', resourceId: String(p._id), previousValue: prev, newValue: body });
      return { ok: true };
    },
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/products/:id/transition', summary: 'Change lifecycle state', tags: ['Admin'], auth: A, permission: 'products:write', body: z.object({ to: z.enum(PRODUCT_STATES), reason: z.string().trim().min(3).max(300) }),
    handler: async ({ req, body }) => (await transitionProduct(ctx, idOf(req), body.to, req.actor, body.reason), invalidateSearchIndex(), { ok: true }),
  });
  route(app, ctx, { method: 'POST', url: '/admin/products/:id/publish', summary: 'Publish (runs compliance + margin gates)', tags: ['Admin'], auth: A, permission: 'products:write', handler: async ({ req }) => (await publishProduct(ctx, idOf(req), req.actor, 'manual publish'), invalidateSearchIndex(), { ok: true }) });
  route(app, ctx, {
    method: 'POST', url: '/admin/products/:id/price', summary: 'Manually set a price (cannot go below the margin floor)', tags: ['Admin'], auth: A, permission: 'products:write', body: z.object({ country: countrySchema, price: z.number().int().positive() }),
    handler: async ({ req, body }) => (await setManualPrice(ctx, idOf(req), body.country, body.price, req.actor), invalidateSearchIndex(), { ok: true }),
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/products/:id/refresh', summary: 'Sync supplier offers, recompute markets and score', tags: ['Admin'], auth: A, permission: 'products:write',
    handler: async ({ req }) => {
      const sync = await syncProductOffers(ctx, idOf(req));
      const markets = await refreshProductMarkets(ctx, idOf(req));
      const score = await scoreProduct(ctx, idOf(req));
      invalidateSearchIndex();
      return { sync, markets, score: { finalScore: score.finalScore, action: score.action } };
    },
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/products/:id/competitor-prices', summary: 'Enter competitor prices for a country (minor units)', tags: ['Admin'], auth: A, permission: 'products:write', body: z.object({ country: countrySchema, prices: z.array(z.number().int().positive()).min(1).max(10) }),
    handler: async ({ req, body }) => (await Product.updateOne({ _id: idOf(req) }, { $set: { [`intel.competitorPrices.${body.country}`]: body.prices, 'intel.source': 'manual' } }), { ok: true }),
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/products/:id/start-test', summary: 'Create an ad test plan (budget, creatives, criteria); optionally launch', tags: ['Admin'], auth: A, permission: 'ads:write', body: z.object({ country: countrySchema, platform: z.enum(['meta', 'tiktok', 'google']), launch: z.boolean().default(false) }),
    handler: async ({ req, body }) => {
      const plan = await createTestPlan(ctx, idOf(req), body.country, body.platform, req.actor);
      if (body.launch) await launchCampaign(ctx, plan.campaignId, req.actor);
      return plan;
    },
  });

  // ------------------------------------------------------------- suppliers
  route(app, ctx, { method: 'GET', url: '/admin/suppliers', summary: 'Supplier dashboard', tags: ['Admin'], auth: A, permission: 'suppliers:read', handler: async () => ({ items: await supplierHealth(), adapters: ctx.suppliers.adapters() }) });
  route(app, ctx, {
    method: 'POST', url: '/admin/suppliers', summary: 'Add a supplier', tags: ['Admin'], auth: A, permission: 'suppliers:write',
    body: z.object({ code: z.string().regex(/^[a-z0-9-]{3,40}$/), name: z.string().min(2).max(80), provider: z.enum(['cj', 'mock']), country: countrySchema.optional(), returnPolicyDays: z.number().int().min(0).max(120).default(14) }),
    handler: async ({ req, body, reply }) => {
      if (body.provider === 'mock' && ctx.cfg.isProduction) throw new DomainError('Mock suppliers are not allowed in production', 'FORBIDDEN', 403);
      const s = await Supplier.create({ ...body, apiStatus: 'unconfigured', active: true });
      const { audit } = await import('@orvia/core');
      await audit(ctx, req.actor, { action: 'supplier.created', resource: 'supplier', resourceId: String(s._id), newValue: body });
      return reply.status(201).send(s);
    },
  });
  route(app, ctx, {
    method: 'PATCH', url: '/admin/suppliers/:id', summary: 'Update supplier settings', tags: ['Admin'], auth: A, permission: 'suppliers:write',
    body: z.object({ active: z.boolean().optional(), name: z.string().min(2).max(80).optional(), returnPolicyDays: z.number().int().min(0).max(120).optional(), rating: z.number().min(0).max(5).optional() }),
    handler: async ({ req, body }) => (await Supplier.updateOne({ _id: idOf(req) }, { $set: body }), { ok: true }),
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/suppliers/:id/check', summary: 'Run an API health check', tags: ['Admin'], auth: A, permission: 'suppliers:write',
    handler: async ({ req }) => {
      const s = await Supplier.findById(idOf(req));
      if (!s) throw notFound('Supplier');
      try {
        const h = await ctx.suppliers.resolve({ provider: s.provider, code: s.code }).healthCheck();
        s.apiStatus = h.ok ? 'ok' : 'down';
        s.apiStatusMessage = h.message;
      } catch (e) {
        s.apiStatus = 'unconfigured';
        s.apiStatusMessage = (e as Error).message;
      }
      await s.save();
      return { apiStatus: s.apiStatus, message: s.apiStatusMessage };
    },
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/suppliers/:id/offers', summary: 'Stored offers for a supplier', tags: ['Admin'], auth: A, permission: 'suppliers:read', query: paginationSchema,
    handler: async ({ req, query }) => {
      const r = await paginate(SupplierOffer, { supplierId: idOf(req) }, { ...query, sort: { syncedAt: -1 } });
      const prods = new Map((await Product.find({ _id: { $in: r.items.map((i) => i.productId) } }).select('title').lean()).map((p) => [String(p._id), p.title]));
      return { ...r, items: r.items.map((o) => ({ ...o, productTitle: prods.get(String(o.productId)) })), warehouses: await Warehouse.find({ supplierId: idOf(req) }).lean() };
    },
  });

  // ------------------------------------------------------------- inventory
  route(app, ctx, {
    method: 'GET', url: '/admin/inventory', summary: 'Inventory statuses', tags: ['Admin'], auth: A, permission: 'inventory:read', query: paginationSchema.extend({ status: z.enum(['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'SUPPLIER_UNAVAILABLE', 'PRICE_CHANGED']).optional(), country: countrySchema.optional() }),
    handler: async ({ query }) => {
      const filter: Record<string, unknown> = {};
      if (query.status) filter['status'] = query.status;
      if (query.country) filter['country'] = query.country;
      const r = await paginate(Inventory, filter, { ...query, sort: { status: 1, available: 1 } });
      const prods = new Map((await Product.find({ _id: { $in: r.items.map((i) => i.productId) } }).select('title state').lean()).map((p) => [String(p._id), p]));
      const sups = new Map((await Supplier.find({ _id: { $in: r.items.map((i) => i.bestSupplierId).filter(Boolean) } }).select('name').lean()).map((s) => [String(s._id), s.name]));
      const counts = await Inventory.aggregate<{ _id: string; n: number }>([{ $group: { _id: '$status', n: { $sum: 1 } } }]);
      return { ...r, items: r.items.map((i) => ({ ...i, productTitle: prods.get(String(i.productId))?.title, productState: prods.get(String(i.productId))?.state, bestSupplier: i.bestSupplierId ? sups.get(String(i.bestSupplierId)) : null })), counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) };
    },
  });
  route(app, ctx, { method: 'POST', url: '/admin/inventory/sync', summary: 'Run an inventory/price sync now', tags: ['Admin'], auth: A, permission: 'inventory:write', handler: async () => { const r = await syncInventory(ctx, 60); invalidateSearchIndex(); return r; } });

  // ------------------------------------------------------------- customers
  route(app, ctx, {
    method: 'GET', url: '/admin/customers', summary: 'Customers', tags: ['Admin'], auth: A, permission: 'customers:read', query: paginationSchema.extend({ q: z.string().trim().max(60).optional() }),
    handler: async ({ query }) => paginate(Customer, query.q ? { $or: [{ email: new RegExp('^' + escapeRegex(query.q), 'i') }, { name: new RegExp('^' + escapeRegex(query.q), 'i') }] } : {}, { ...query, sort: { lifetimeValue: -1 }, select: 'email name country ordersCount lifetimeValue lastOrderAt marketingConsent riskFlags createdAt' }),
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/customers/:id', summary: 'Customer detail', tags: ['Admin'], auth: A, permission: 'customers:read',
    handler: async ({ req }) => {
      const c = await Customer.findById(idOf(req)).lean();
      if (!c) throw notFound('Customer');
      return { customer: c, orders: await Order.find({ email: c.email }).sort({ createdAt: -1 }).limit(25).select('orderNumber status amounts currency createdAt country').lean() };
    },
  });
}
