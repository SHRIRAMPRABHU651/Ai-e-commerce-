import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import mongoose from 'mongoose';
import {
  AdAccount, AdCreative, AdMetric, AiDecision, AiTask, AnalyticsEvent, AuditLog, Campaign, ExceptionModel, Order, Payment, Product, Promotion, Report, Refund, ReturnRequest, Review, Shipment, Supplier, SupportTicket, User, RoleModel,
} from '@orvia/database';
import {
  AGENTS, adsOverview, agentCatalog, approveDecision, approveRefund, askCopilot, automationOverview, cancelOrder, countryAnalytics, decideReturn, DEFAULT_SCHEDULES, effectiveSchedules, DomainError, executeNow, financials,
  generateDailyBrief, getCountryConfigs, notFound, notify, parseRange, productPerformance, recomputeRating, refundOrder, rejectDecision, resolveException, retrySupplierOrder, runNamedAgent, saveCountry, syncTracking, timeseries, createStaffUser,
  analyzeProductReviews, audit, launchCampaign, invalidateSearchIndex,
} from '@orvia/core';
import type { AgentName, Ctx, PricingSettings, OpsSettings } from '@orvia/core';
import { ROLE_PERMISSIONS } from '@orvia/auth';
import { AUTOMATION_KEYS, AUTOMATION_MODES, COUNTRY_CODES, ROLES, countrySchema, emailSchema, objectId, paginationSchema, passwordSchema } from '@orvia/types';
import type { AutomationKey } from '@orvia/types';
import { integrationStatus } from '@orvia/config';
import { route } from '../http';
import { escapeRegex, paginate } from '../util';

const rangeSchema = z.object({ preset: z.enum(['today', '7d', '30d', '90d', 'custom']).default('30d'), from: z.string().optional(), to: z.string().optional() });
const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;

export function adminOpsRoutes(app: FastifyInstance, ctx: Ctx): void {
  const A = 'staff' as const;

  // -------------------------------------------------------------- analytics
  route(app, ctx, {
    method: 'GET', url: '/admin/analytics', summary: 'Analytics bundle (financials, series, countries, products, funnel, categories)', tags: ['Admin'], auth: A, permission: 'analytics:read', query: rangeSchema,
    handler: async ({ query }) => {
      const range = parseRange(query.preset, query.from, query.to, ctx.now());
      const [fin, series, countries, products] = await Promise.all([financials(ctx, range), timeseries(ctx, range), countryAnalytics(ctx, range), productPerformance(ctx, range, 10)]);
      const funnelRows = await AnalyticsEvent.aggregate<{ _id: string; n: number }>([
        { $match: { ts: { $gte: range.from, $lte: range.to }, sessionId: { $ne: null } } }, { $group: { _id: { t: '$type', s: '$sessionId' } } }, { $group: { _id: '$_id.t', n: { $sum: 1 } } },
      ]);
      const fm = new Map(funnelRows.map((f) => [f._id, f.n]));
      const funnel = [
        { step: 'Sessions', count: (await AnalyticsEvent.distinct('sessionId', { ts: { $gte: range.from, $lte: range.to }, sessionId: { $ne: null } })).length },
        { step: 'Product views', count: fm.get('product_view') ?? 0 }, { step: 'Added to cart', count: fm.get('add_to_cart') ?? 0 }, { step: 'Checkout started', count: fm.get('checkout_start') ?? 0 }, { step: 'Purchased', count: fin.orders },
      ];
      const cat = await Order.aggregate<{ _id: string; revenue: number; units: number }>([
        { $match: { 'payment.paidAt': { $gte: range.from, $lte: range.to } } }, { $unwind: '$items' },
        { $lookup: { from: 'products', localField: 'items.productId', foreignField: '_id', as: 'p' } }, { $unwind: '$p' },
        { $group: { _id: '$p.topCategory', revenue: { $sum: { $multiply: ['$items.unitPrice', '$items.quantity'] } }, units: { $sum: '$items.quantity' } } }, { $limit: 20 },
      ]);
      const ads = await AdMetric.aggregate<{ _id: null; spend: number; revenue: number; clicks: number; impressions: number; purchases: number }>([
        { $match: { date: { $gte: new Date(range.from.toISOString().slice(0, 10)), $lte: range.to } } }, { $group: { _id: null, spend: { $sum: '$spend' }, revenue: { $sum: '$revenue' }, clicks: { $sum: '$clicks' }, impressions: { $sum: '$impressions' }, purchases: { $sum: '$purchases' } } },
      ]);
      return { range, financials: fin, series, countries: countries.countries, countryRecommendation: countries.recommendation, products, funnel, categories: cat.map((c) => ({ category: c._id, revenue: c.revenue, units: c.units })), advertising: ads[0] ?? { spend: 0, revenue: 0, clicks: 0, impressions: 0, purchases: 0 } };
    },
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/financials', summary: 'Financial dashboard', tags: ['Admin'], auth: A, permission: 'analytics:read', query: rangeSchema,
    handler: async ({ query }) => {
      const range = parseRange(query.preset, query.from, query.to, ctx.now());
      return { range, financials: await financials(ctx, range), series: await timeseries(ctx, range) };
    },
  });

  // -------------------------------------------------------------- marketing
  route(app, ctx, {
    method: 'GET', url: '/admin/marketing', summary: 'Marketing dashboard: campaigns, per-country/product/creative metrics', tags: ['Admin'], auth: A, permission: 'marketing:read', query: rangeSchema,
    handler: async ({ query }) => {
      const range = parseRange(query.preset, query.from, query.to, ctx.now());
      const rows = await adsOverview(ctx, range.from, range.to);
      const accounts = ctx.ads.status();
      const camps = await Campaign.find({}).sort({ createdAt: -1 }).limit(100).select('name platform status country dailyBudget spent recommendation test failureReason productId').lean();
      const creatives = await AdMetric.aggregate<{ _id: mongoose.Types.ObjectId; impressions: number; clicks: number; spend: number; purchases: number; revenue: number }>([
        { $match: { date: { $gte: new Date(range.from.toISOString().slice(0, 10)), $lte: range.to }, creativeId: { $ne: null } } },
        { $group: { _id: '$creativeId', impressions: { $sum: '$impressions' }, clicks: { $sum: '$clicks' }, spend: { $sum: '$spend' }, purchases: { $sum: '$purchases' }, revenue: { $sum: '$revenue' } } }, { $sort: { revenue: -1 } }, { $limit: 30 },
      ]);
      const cr = new Map((await AdCreative.find({ _id: { $in: creatives.map((c) => c._id) } }).select('concept headline status campaignId').lean()).map((c) => [String(c._id), c]));
      const group = (key: 'country' | 'product') => Object.values(rows.reduce<Record<string, { key: string; spend: number; revenue: number; purchases: number; clicks: number; impressions: number }>>((m, r) => {
        const k = key === 'country' ? r.country : r.product;
        const o = (m[k] ??= { key: k, spend: 0, revenue: 0, purchases: 0, clicks: 0, impressions: 0 });
        o.spend += r.spend; o.revenue += r.revenue; o.purchases += r.purchases; o.clicks += r.clicks; o.impressions += r.impressions;
        return m;
      }, {})).map((o) => ({ ...o, roas: o.spend ? o.revenue / o.spend : 0, cpa: o.purchases ? o.spend / o.purchases : null, ctr: o.impressions ? o.clicks / o.impressions : 0 }));
      const total = rows.reduce((a, r) => ({ spend: a.spend + r.spend, revenue: a.revenue + r.revenue, purchases: a.purchases + r.purchases, clicks: a.clicks + r.clicks, impressions: a.impressions + r.impressions }), { spend: 0, revenue: 0, purchases: 0, clicks: 0, impressions: 0 });
      return {
        range, mode: ctx.cfg.ADS_MODE, accounts, rows, campaigns: camps, byCountry: group('country'), byProduct: group('product'),
        totals: { ...total, roas: total.spend ? total.revenue / total.spend : 0, cpa: total.purchases ? total.spend / total.purchases : null, ctr: total.impressions ? total.clicks / total.impressions : 0, cpc: total.clicks ? total.spend / total.clicks : 0, cpm: total.impressions ? (total.spend / total.impressions) * 1000 : 0 },
        creatives: creatives.map((c) => ({ id: String(c._id), concept: cr.get(String(c._id))?.concept, headline: cr.get(String(c._id))?.headline, status: cr.get(String(c._id))?.status, ...c, roas: c.spend ? c.revenue / c.spend : 0, ctr: c.impressions ? c.clicks / c.impressions : 0 })),
        accountsDb: await AdAccount.find({}).select('platform accountId status dailyLimit monthlyLimit').lean(),
      };
    },
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/marketing/campaigns/:id', summary: 'Campaign detail with creatives', tags: ['Admin'], auth: A, permission: 'marketing:read',
    handler: async ({ req }) => {
      const c = await Campaign.findById(idOf(req)).lean();
      if (!c) throw notFound('Campaign');
      return { campaign: c, creatives: await AdCreative.find({ campaignId: c._id }).limit(10).lean(), product: await Product.findById(c.productId).select('title slug').lean() };
    },
  });
  route(app, ctx, { method: 'POST', url: '/admin/marketing/campaigns/:id/launch', summary: 'Launch a drafted campaign (budget caps + compliance enforced)', tags: ['Admin'], auth: A, permission: 'ads:write', handler: async ({ req }) => { const c = await launchCampaign(ctx, idOf(req), req.actor); return { status: c.status, externalId: c.externalId }; } });
  route(app, ctx, {
    method: 'POST', url: '/admin/marketing/campaigns/:id/action', summary: 'Pause / resume / change budget (applied on the ad platform first)', tags: ['Admin'], auth: A, permission: 'ads:write',
    body: z.object({ action: z.enum(['PAUSE', 'RESUME', 'SCALE', 'REDUCE']), dailyBudget: z.number().int().positive().optional(), reason: z.string().max(300).default('manual') }),
    handler: async ({ req, body }) => executeNow(ctx, 'ad_action', { campaignId: idOf(req), action: body.action, newDailyBudget: body.dailyBudget, reason: body.reason }, req.actor),
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/marketing/content', summary: 'Generate marketing content (email / blog / push / social) from source product data', tags: ['Admin'], auth: A, permission: 'marketing:write', body: z.object({ productId: objectId, kind: z.enum(['email', 'blog', 'push', 'instagram', 'tiktok', 'facebook', 'google_ad']) }),
    handler: async ({ body }) => {
      const p = await Product.findById(body.productId).lean();
      if (!p) throw notFound('Product');
      const attrs = p.attributes ? Object.entries(p.attributes as unknown as Record<string, string>).filter(([k]) => k !== 'Top category') : [];
      const src = { title: p.title, description: p.description ?? '', category: p.category ?? '', attributes: Object.fromEntries(attrs), tags: p.tags, safetyStandards: p.compliance?.safetyInfo?.standards ?? [], variants: [] };
      const c = await ctx.ai.productContent(src);
      const d = c.data;
      const text: Record<string, string> = {
        email: `Subject: ${d.adCopy.headline}\n\n${d.description}\n\n${d.bullets.map((b) => `• ${b}`).join('\n')}\n\n${d.adCopy.cta}`,
        blog: `# ${d.seoTitle}\n\n${d.description}\n\n## Why it stands out\n${d.benefits.map((b) => `- ${b}`).join('\n')}\n\n## Details\n${d.features.map((b) => `- ${b}`).join('\n')}\n\n## FAQ\n${d.faqs.map((f) => `**${f.q}**\n${f.a}`).join('\n\n')}`,
        push: `${d.adCopy.headline} — ${d.adCopy.description}`.slice(0, 120),
        instagram: d.social.instagram, tiktok: d.social.tiktokScript, facebook: d.social.facebookAd,
        google_ad: `Headline: ${d.adCopy.headline}\nDescription: ${d.adCopy.primaryText}`,
      };
      return { kind: body.kind, text: text[body.kind], source: c.source, notes: c.notes, grounded: 'Built only from the product record; specs not in the source are rejected.' };
    },
  });

  // ------------------------------------------------------------- promotions
  const promoBody = z.object({
    name: z.string().min(2).max(80), type: z.enum(['percentage', 'fixed', 'free_shipping', 'bxgy', 'first_order', 'cart', 'flash_sale', 'seasonal']), code: z.string().regex(/^[A-Za-z0-9_-]{3,30}$/).optional(),
    countries: z.array(countrySchema).default([]), percent: z.number().min(0).max(0.9).default(0), fixedAmount: z.record(z.number().int().min(0)).optional(), minSubtotal: z.record(z.number().int().min(0)).optional(),
    bxgy: z.object({ buy: z.number().int().min(1).max(5), get: z.number().int().min(1).max(5) }).optional(), startsAt: z.string().datetime().optional(), endsAt: z.string().datetime().optional(),
    usageLimit: z.number().int().min(0).default(0), perUserLimit: z.number().int().min(0).default(1), active: z.boolean().default(true),
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/promotions', summary: 'Promotions + AI recommendations awaiting approval', tags: ['Admin'], auth: A, permission: 'promotions:read',
    handler: async () => ({ items: await Promotion.find({}).sort({ createdAt: -1 }).limit(100).lean(), recommendations: await AiDecision.find({ kind: 'create_promotion', status: 'proposed' }).limit(20).lean() }),
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/promotions', summary: 'Create promotion', tags: ['Admin'], auth: A, permission: 'promotions:write', body: promoBody,
    handler: async ({ req, body, reply }) => {
      if (body.percent > 0.5) throw new DomainError('Discounts above 50% are not allowed', 'LIMIT', 422);
      const p = await Promotion.create({ ...body, startsAt: body.startsAt ? new Date(body.startsAt) : undefined, endsAt: body.endsAt ? new Date(body.endsAt) : undefined, recommendedBy: req.actor.id });
      await audit(ctx, req.actor, { action: 'promotion.created', resource: 'promotion', resourceId: String(p._id), newValue: body });
      return reply.status(201).send(p);
    },
  });
  route(app, ctx, {
    method: 'PATCH', url: '/admin/promotions/:id', summary: 'Enable/disable or end a promotion', tags: ['Admin'], auth: A, permission: 'promotions:write', body: z.object({ active: z.boolean().optional(), endsAt: z.string().datetime().optional() }),
    handler: async ({ req, body }) => (await Promotion.updateOne({ _id: idOf(req) }, { $set: { ...(body.active !== undefined ? { active: body.active } : {}), ...(body.endsAt ? { endsAt: new Date(body.endsAt) } : {}) } }), { ok: true }),
  });

  // ------------------------------------------------------------ copilot/brief
  route(app, ctx, {
    method: 'POST', url: '/admin/copilot', summary: 'Ask the business copilot (answers come from database queries)', tags: ['Admin'], auth: A, permission: 'copilot:use', body: z.object({ question: z.string().trim().min(2).max(500), confirm: z.boolean().default(false) }),
    rateLimit: { max: 30, timeWindow: '1 minute' },
    handler: async ({ req, body }) => askCopilot(ctx, { question: body.question, confirm: body.confirm && req.user?.role !== 'ANALYST', actor: req.actor }),
  });
  route(app, ctx, { method: 'GET', url: '/admin/brief', summary: 'Latest daily brief', tags: ['Admin'], auth: A, permission: 'overview:read', handler: async () => ({ items: await Report.find({ kind: 'daily_brief' }).sort({ date: -1 }).limit(7).lean() }) });
  route(app, ctx, { method: 'POST', url: '/admin/brief/generate', summary: 'Generate a brief now', tags: ['Admin'], auth: A, permission: 'copilot:use', body: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), handler: async ({ body }) => generateDailyBrief(ctx, body.date) });

  // ------------------------------------------------------------- automation
  route(app, ctx, {
    method: 'GET', url: '/admin/automation', summary: 'Automation Center', tags: ['Admin'], auth: A, permission: 'automation:read',
    handler: async () => ({ automations: await automationOverview(ctx), agents: agentCatalog(), schedules: await effectiveSchedules(), queue: await ctx.queue.stats(), integrations: integrationStatus(ctx.cfg), environment: ctx.cfg.APP_ENV, llm: ctx.ai.llmConfigured ? 'gemini' : 'template-fallback' }),
  });
  route(app, ctx, {
    method: 'PUT', url: '/admin/automation/:key', summary: 'Set automation mode OFF / ASSISTED / AUTOMATIC', tags: ['Admin'], auth: A, permission: 'automation:write', body: z.object({ mode: z.enum(AUTOMATION_MODES) }),
    handler: async ({ req, body }) => {
      const key = (req.params as { key: string }).key as AutomationKey;
      if (!AUTOMATION_KEYS.includes(key)) throw notFound('Automation');
      const prev = await ctx.settings.automationMode(key);
      await ctx.settings.setAutomationMode(key, body.mode, req.actor.id);
      await audit(ctx, req.actor, { action: 'automation.mode', resource: 'automation', resourceId: key, previousValue: prev, newValue: body.mode, reason: 'admin changed automation mode' });
      return { key, mode: body.mode };
    },
  });
  route(app, ctx, {
    method: 'PUT', url: '/admin/automation/schedules/:name', summary: 'Customize a schedule interval / enable', tags: ['Admin'], auth: A, permission: 'automation:write', body: z.object({ everyMinutes: z.number().int().min(1).max(10080).optional(), enabled: z.boolean().optional() }),
    handler: async ({ req, body }) => {
      const name = (req.params as { name: string }).name;
      if (!DEFAULT_SCHEDULES.some((s) => s.name === name)) throw notFound('Schedule');
      const { SystemSetting } = await import('@orvia/database');
      const doc = await SystemSetting.findOne({ key: 'schedule_overrides' }).lean();
      const cur = { ...((doc?.value ?? {}) as Record<string, unknown>) };
      cur[name] = { ...(cur[name] as object), ...(body.everyMinutes ? { everyMs: body.everyMinutes * 60_000 } : {}), ...(body.enabled !== undefined ? { enabled: body.enabled } : {}) };
      await SystemSetting.updateOne({ key: 'schedule_overrides' }, { $set: { value: cur, updatedBy: req.actor.id } }, { upsert: true });
      await audit(ctx, req.actor, { action: 'automation.schedule', resource: 'schedule', resourceId: name, newValue: body });
      return { ok: true };
    },
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/automation/decisions', summary: 'AI decisions (proposed / executed)', tags: ['Admin'], auth: A, permission: 'automation:read', query: paginationSchema.extend({ status: z.enum(['proposed', 'approved', 'rejected', 'executed', 'auto_executed', 'failed', 'expired']).optional() }),
    handler: async ({ query }) => paginate(AiDecision, query.status ? { status: query.status } : {}, query),
  });
  route(app, ctx, { method: 'POST', url: '/admin/automation/decisions/:id/approve', summary: 'Approve + execute a proposed decision', tags: ['Admin'], auth: A, permission: 'automation:write', handler: async ({ req }) => approveDecision(ctx, idOf(req), req.actor) });
  route(app, ctx, { method: 'POST', url: '/admin/automation/decisions/:id/reject', summary: 'Reject a proposed decision', tags: ['Admin'], auth: A, permission: 'automation:write', body: z.object({ reason: z.string().max(300).default('rejected') }), handler: async ({ req, body }) => rejectDecision(ctx, idOf(req), req.actor, body.reason) });
  route(app, ctx, {
    method: 'POST', url: '/admin/automation/agents/:name/run', summary: 'Run an agent now', tags: ['Admin'], auth: A, permission: 'ai:write', body: z.object({ input: z.record(z.unknown()).default({}) }),
    handler: async ({ req, body }) => {
      const name = (req.params as { name: string }).name as AgentName;
      if (!(name in AGENTS)) throw notFound('Agent');
      return runNamedAgent(ctx, name, body.input);
    },
  });
  route(app, ctx, { method: 'GET', url: '/admin/automation/ai-tasks', summary: 'Agent run history', tags: ['Admin'], auth: A, permission: 'automation:read', query: paginationSchema, handler: async ({ query }) => paginate(AiTask, {}, { ...query, select: 'agent status summary confidence durationMs attempts error provider createdAt' }) });

  // -------------------------------------------------------------- countries
  route(app, ctx, {
    method: 'GET', url: '/admin/countries', summary: 'Country configs + performance', tags: ['Admin'], auth: A, permission: 'countries:read',
    handler: async () => ({ configs: Object.values(await getCountryConfigs(true)), analytics: await countryAnalytics(ctx, parseRange('30d')) }),
  });
  route(app, ctx, {
    method: 'PUT', url: '/admin/countries/:code', summary: 'Update country configuration', tags: ['Admin'], auth: A, permission: 'countries:write',
    body: z.object({ enabled: z.boolean().optional(), defaultTaxRate: z.number().min(0).max(0.5).optional(), returnWindowDays: z.number().int().min(0).max(120).optional(), legalNotice: z.string().max(600).optional(), fxPerUsd: z.number().positive().optional(), paymentMethods: z.array(z.string().max(30)).max(10).optional(), regionTaxRates: z.record(z.number().min(0).max(0.5)).optional(),
      shippingMethods: z.array(z.object({ code: z.string().max(20), label: z.string().max(40), fee: z.number().int().min(0), freeOver: z.number().int().min(0).nullable(), minDays: z.number().int().min(0).max(60), maxDays: z.number().int().min(0).max(90) })).max(5).optional() }),
    handler: async ({ req, body }) => {
      const code = (req.params as { code: string }).code;
      if (!COUNTRY_CODES.includes(code as never)) throw notFound('Country');
      const next = await saveCountry(code as (typeof COUNTRY_CODES)[number], body);
      await audit(ctx, req.actor, { action: 'country.updated', resource: 'country', resourceId: code, newValue: body });
      return next;
    },
  });

  // --------------------------------------------------------------- payments
  route(app, ctx, {
    method: 'GET', url: '/admin/payments', summary: 'Payments', tags: ['Admin'], auth: A, permission: 'payments:read', query: paginationSchema.extend({ status: z.enum(['pending', 'succeeded', 'failed', 'refunded', 'partially_refunded']).optional() }),
    handler: async ({ query }) => {
      const r = await paginate(Payment, query.status ? { status: query.status } : {}, query);
      const orders = new Map((await Order.find({ _id: { $in: r.items.map((p) => p.orderId) } }).select('orderNumber email').lean()).map((o) => [String(o._id), o]));
      const refunds = await Refund.find({ status: { $in: ['pending_approval', 'failed'] } }).limit(20).lean();
      return { ...r, items: r.items.map((p) => ({ ...p, orderNumber: orders.get(String(p.orderId))?.orderNumber, email: orders.get(String(p.orderId))?.email })), pendingRefunds: refunds, mode: ctx.cfg.PAYMENT_MODE, providers: { stripe: integrationStatus(ctx.cfg)['stripe'], razorpay: integrationStatus(ctx.cfg)['razorpay'] } };
    },
  });
  route(app, ctx, { method: 'POST', url: '/admin/refunds/:id/approve', summary: 'Approve a high-value refund', tags: ['Admin'], auth: A, permission: 'refunds:approve', handler: async ({ req }) => approveRefund(ctx, idOf(req), req.actor) });

  // --------------------------------------------------------------- shipping
  route(app, ctx, {
    method: 'GET', url: '/admin/shipping', summary: 'Shipments', tags: ['Admin'], auth: A, permission: 'shipping:read', query: paginationSchema.extend({ status: z.string().max(30).optional() }),
    handler: async ({ query }) => {
      const r = await paginate(Shipment, query.status ? { status: query.status } : {}, { ...query, sort: { updatedAt: -1 } });
      const orders = new Map((await Order.find({ _id: { $in: r.items.map((s) => s.orderId) } }).select('orderNumber country address.fullName').lean()).map((o) => [String(o._id), o]));
      const sups = new Map((await Supplier.find({ _id: { $in: r.items.map((s) => s.supplierId) } }).select('name').lean()).map((s) => [String(s._id), s.name]));
      return { ...r, items: r.items.map((s) => ({ ...s, orderNumber: orders.get(String(s.orderId))?.orderNumber, country: orders.get(String(s.orderId))?.country, customer: orders.get(String(s.orderId))?.address?.fullName, supplierName: sups.get(String(s.supplierId)) })) };
    },
  });
  route(app, ctx, { method: 'POST', url: '/admin/shipping/sync', summary: 'Sync tracking now', tags: ['Admin'], auth: A, permission: 'orders:write', handler: async () => syncTracking(ctx, { limit: 100 }) });

  // ---------------------------------------------------------------- returns
  route(app, ctx, {
    method: 'GET', url: '/admin/returns', summary: 'Return requests', tags: ['Admin'], auth: A, permission: 'returns:read', query: paginationSchema.extend({ status: z.enum(['requested', 'approved', 'rejected', 'received', 'refunded']).optional() }),
    handler: async ({ query }) => {
      const r = await paginate(ReturnRequest, query.status ? { status: query.status } : {}, query);
      const orders = new Map((await Order.find({ _id: { $in: r.items.map((x) => x.orderId) } }).select('orderNumber amounts currency').lean()).map((o) => [String(o._id), o]));
      return { ...r, items: r.items.map((x) => ({ ...x, orderNumber: orders.get(String(x.orderId))?.orderNumber, total: orders.get(String(x.orderId))?.amounts?.total, currency: orders.get(String(x.orderId))?.currency })) };
    },
  });
  route(app, ctx, { method: 'POST', url: '/admin/returns/:id/decision', summary: 'Approve / reject / refund a return', tags: ['Admin'], auth: A, permission: 'returns:write', body: z.object({ decision: z.enum(['approve', 'reject', 'refund']), note: z.string().max(300).default('') }), handler: async ({ req, body }) => decideReturn(ctx, idOf(req), body.decision, req.actor, body.note) });

  // ---------------------------------------------------------------- reviews
  route(app, ctx, {
    method: 'GET', url: '/admin/reviews', summary: 'Reviews for moderation', tags: ['Admin'], auth: A, permission: 'reviews:read', query: paginationSchema.extend({ status: z.enum(['published', 'pending', 'rejected']).optional(), maxRating: z.coerce.number().int().min(1).max(5).optional() }),
    handler: async ({ query }) => {
      const f: Record<string, unknown> = {};
      if (query.status) f['status'] = query.status;
      if (query.maxRating) f['rating'] = { $lte: query.maxRating };
      const r = await paginate(Review, f, query);
      const prods = new Map((await Product.find({ _id: { $in: r.items.map((x) => x.productId) } }).select('title slug').lean()).map((p) => [String(p._id), p]));
      return { ...r, items: r.items.map((x) => ({ ...x, productTitle: prods.get(String(x.productId))?.title })) };
    },
  });
  route(app, ctx, {
    method: 'PATCH', url: '/admin/reviews/:id', summary: 'Moderate a review', tags: ['Admin'], auth: A, permission: 'reviews:write', body: z.object({ status: z.enum(['published', 'rejected']) }),
    handler: async ({ req, body }) => {
      const r = await Review.findByIdAndUpdate(idOf(req), { $set: { status: body.status } }, { new: true });
      if (!r) throw notFound('Review');
      await recomputeRating(String(r.productId));
      invalidateSearchIndex();
      return { ok: true };
    },
  });
  route(app, ctx, { method: 'GET', url: '/admin/reviews/analysis/:id', summary: 'AI review analysis for a product', tags: ['Admin'], auth: A, permission: 'reviews:read', handler: async ({ req }) => analyzeProductReviews(ctx, idOf(req)) });

  // ---------------------------------------------------------------- support
  route(app, ctx, {
    method: 'GET', url: '/admin/support/tickets', summary: 'Support tickets', tags: ['Admin'], auth: A, permission: 'support:read', query: paginationSchema.extend({ status: z.enum(['open', 'pending', 'escalated', 'resolved']).optional() }),
    handler: async ({ query }) => paginate(SupportTicket, query.status ? { status: query.status } : {}, { ...query, sort: { updatedAt: -1 }, select: 'email subject status priority orderId updatedAt messages' }),
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/support/tickets/:id', summary: 'Ticket', tags: ['Admin'], auth: A, permission: 'support:read',
    handler: async ({ req }) => {
      const t = await SupportTicket.findById(idOf(req)).lean();
      if (!t) throw notFound('Ticket');
      return { ticket: t, order: t.orderId ? await Order.findById(t.orderId).select('orderNumber status amounts currency').lean() : null };
    },
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/support/tickets/:id/reply', summary: 'Reply to a customer (emails them)', tags: ['Admin'], auth: A, permission: 'support:write', body: z.object({ text: z.string().trim().min(2).max(3000), resolve: z.boolean().default(false) }),
    handler: async ({ req, body }) => {
      const t = await SupportTicket.findById(idOf(req));
      if (!t) throw notFound('Ticket');
      t.messages.push({ from: 'agent', text: body.text, at: new Date() } as never);
      t.status = body.resolve ? 'resolved' : 'pending';
      await t.save();
      if (t.email) await notify(ctx, { template: 'custom', to: t.email, data: { subject: `Re: ${t.subject ?? 'Your request'}`, message: body.text }, dedupeKey: `ticket:${t._id}:${t.messages.length}` });
      await audit(ctx, req.actor, { action: 'support.reply', resource: 'ticket', resourceId: String(t._id) });
      return { ok: true };
    },
  });

  // ------------------------------------------------------------- exceptions
  route(app, ctx, {
    method: 'GET', url: '/admin/exceptions', summary: 'Exception queue', tags: ['Admin'], auth: A, permission: 'exceptions:read', query: paginationSchema.extend({ status: z.enum(['open', 'in_progress', 'resolved', 'dismissed']).default('open'), kind: z.string().max(30).optional() }),
    handler: async ({ query }) => {
      const f: Record<string, unknown> = { status: query.status === 'open' ? { $in: ['open', 'in_progress'] } : query.status };
      if (query.kind) f['kind'] = query.kind;
      const r = await paginate(ExceptionModel, f, { ...query, sort: { createdAt: -1 } });
      const orders = new Map((await Order.find({ _id: { $in: r.items.map((e) => e.orderId).filter(Boolean) } }).select('orderNumber').lean()).map((o) => [String(o._id), o.orderNumber]));
      const order = { critical: 0, high: 1, medium: 2, low: 3 } as Record<string, number>;
      return { ...r, items: r.items.map((e) => ({ ...e, orderNumber: e.orderId ? orders.get(String(e.orderId)) : undefined })).sort((a, b) => (order[a.priority] ?? 9) - (order[b.priority] ?? 9)) };
    },
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/exceptions/:id/action', summary: 'Execute the suggested action or resolve/dismiss', tags: ['Admin'], auth: A, permission: 'exceptions:write',
    body: z.object({ action: z.enum(['retry_supplier_order', 'approve_fulfillment', 'cancel_order', 'refund_order', 'approve_refund', 'resolve', 'dismiss']), note: z.string().max(300).default('') }),
    handler: async ({ req, body }) => {
      const ex = await ExceptionModel.findById(idOf(req));
      if (!ex) throw notFound('Exception');
      const orderId = ex.orderId ? String(ex.orderId) : undefined;
      const need = () => { if (!orderId) throw new DomainError('This exception has no order', 'BAD_ACTION', 422); return orderId; };
      switch (body.action) {
        case 'retry_supplier_order': await retrySupplierOrder(ctx, need(), req.actor); break;
        case 'approve_fulfillment': await retrySupplierOrder(ctx, need(), req.actor, { force: true }); break;
        case 'cancel_order': await cancelOrder(ctx, need(), req.actor, body.note || 'Cancelled from exception queue'); break;
        case 'refund_order': await refundOrder(ctx, need(), { actor: req.actor, reason: body.note || 'Refund from exception queue' }); break;
        case 'approve_refund': { const rid = (ex.details as { refundId?: string } | undefined)?.refundId; if (!rid) throw new DomainError('No pending refund', 'BAD_ACTION', 422); await approveRefund(ctx, rid, req.actor); break; }
        default: break;
      }
      if (body.action === 'dismiss') await resolveException(ctx, idOf(req), req.actor, body.note || 'Dismissed', 'dismissed');
      else if (!['retry_supplier_order', 'approve_fulfillment', 'cancel_order'].includes(body.action)) await resolveException(ctx, idOf(req), req.actor, body.note || body.action);
      else await ExceptionModel.updateOne({ _id: ex._id, status: 'open' }, { $set: { status: 'in_progress', resolution: `Action ${body.action} by ${req.actor.id}` } });
      return { ok: true };
    },
  });

  // --------------------------------------------------------------- settings
  route(app, ctx, {
    method: 'GET', url: '/admin/settings', summary: 'System settings (no secrets)', tags: ['Admin'], auth: A, permission: 'settings:read',
    handler: async () => ({ pricing: await ctx.settings.get('pricing'), ads: await ctx.settings.get('ads'), ops: await ctx.settings.get('ops'), automation: await ctx.settings.get('automation'), integrations: integrationStatus(ctx.cfg), environment: ctx.cfg.APP_ENV, modes: { supplier: ctx.cfg.SUPPLIER_MODE, payment: ctx.cfg.PAYMENT_MODE, ads: ctx.cfg.ADS_MODE, notify: ctx.cfg.NOTIFY_MODE } }),
  });
  const cur = z.object({ USD: z.number().int().min(0), CAD: z.number().int().min(0), INR: z.number().int().min(0) });
  route(app, ctx, {
    method: 'PUT', url: '/admin/settings/pricing', summary: 'Update pricing guardrails', tags: ['Admin'], auth: A, permission: 'settings:write',
    body: z.object({ minMarginPct: z.number().min(0).max(0.9).optional(), maxDiscountPct: z.number().min(0).max(0.9).optional(), minSellingPrice: cur.optional(), targetProfitPerOrder: cur.optional(), targetRoas: z.number().min(0.5).max(20).optional(), defaultStrategy: z.enum(['cost_plus', 'target_margin', 'competitor_based', 'dynamic_demand', 'ai_optimized']).optional(), targetMarginPct: z.number().min(0.05).max(0.9).optional(), baseRefundRate: z.number().min(0).max(0.5).optional(), assumedAdCostPct: z.number().min(0).max(0.8).optional(), minPriceChangePct: z.number().min(0).max(0.5).optional() }),
    handler: async ({ req, body }) => { const prev = await ctx.settings.get('pricing'); const next = await ctx.settings.set('pricing', body as Partial<PricingSettings>, req.actor.id); await audit(ctx, req.actor, { action: 'settings.pricing', resource: 'settings', previousValue: prev, newValue: next }); return next; },
  });
  route(app, ctx, {
    method: 'PUT', url: '/admin/settings/ads', summary: 'Update ad budget rules (safe mode default)', tags: ['Admin'], auth: A, permission: 'settings:write',
    body: z.object({ safeMode: z.boolean().optional(), minImpressions: z.number().int().min(100).optional(), minClicks: z.number().int().min(5).optional(), pauseNoPurchaseSpend: z.number().int().min(0).optional(), targetCpa: z.number().int().min(1).optional(), cpaReduceFactor: z.number().min(0.3).max(0.95).optional(), targetRoas: z.number().min(0.5).max(20).optional(), scaleStep: z.number().min(0.05).max(0.5).optional(), maxDailyBudget: z.number().int().min(100).optional(), minDailyBudget: z.number().int().min(100).optional(), maxRefundRate: z.number().min(0.01).max(0.5).optional(), negativeProfitMinSpend: z.number().int().min(0).optional(), dailyLimit: z.number().int().min(100).optional(), monthlyLimit: z.number().int().min(100).optional() }),
    handler: async ({ req, body }) => { const prev = await ctx.settings.get('ads'); const next = await ctx.settings.set('ads', body, req.actor.id); await audit(ctx, req.actor, { action: 'settings.ads', resource: 'settings', previousValue: prev, newValue: next }); return next; },
  });
  route(app, ctx, {
    method: 'PUT', url: '/admin/settings/ops', summary: 'Update operational thresholds', tags: ['Admin'], auth: A, permission: 'settings:write',
    body: z.object({ lowStockThreshold: z.number().int().min(0).optional(), supplierPriceSpikePct: z.number().min(0.01).max(1).optional(), fraudHighScore: z.number().int().min(30).max(100).optional(), fraudMediumScore: z.number().int().min(10).max(90).optional(), highValueOrderUsd: z.number().int().min(1000).optional(), fulfillmentMaxAttempts: z.number().int().min(1).max(10).optional() }),
    handler: async ({ req, body }) => { const prev = await ctx.settings.get('ops'); const next = await ctx.settings.set('ops', body as Partial<OpsSettings>, req.actor.id); await audit(ctx, req.actor, { action: 'settings.ops', resource: 'settings', previousValue: prev, newValue: next }); return next; },
  });

  // ------------------------------------------------------------------ audit
  route(app, ctx, {
    method: 'GET', url: '/admin/audit', summary: 'Audit logs', tags: ['Admin'], auth: A, permission: 'audit:read', query: paginationSchema.extend({ actor: z.string().max(80).optional(), action: z.string().max(80).optional(), resource: z.string().max(40).optional(), actorType: z.enum(['user', 'ai', 'system', 'webhook', 'anonymous']).optional() }),
    handler: async ({ query }) => {
      const f: Record<string, unknown> = {};
      if (query.actor) f['actor'] = query.actor;
      if (query.actorType) f['actorType'] = query.actorType;
      if (query.resource) f['resource'] = query.resource;
      if (query.action) f['action'] = new RegExp('^' + escapeRegex(query.action));
      return paginate(AuditLog, f, { ...query, sort: { timestamp: -1 } });
    },
  });

  // ------------------------------------------------------------------ users
  route(app, ctx, { method: 'GET', url: '/admin/users', summary: 'Staff users + roles matrix', tags: ['Admin'], auth: A, permission: 'users:manage', handler: async () => ({ users: await User.find({ role: { $ne: 'CUSTOMER' } }).select('email name role disabled lastLoginAt emailVerified').limit(100).lean(), roles: ROLES.map((r) => ({ name: r, permissions: ROLE_PERMISSIONS[r] })), stored: await RoleModel.find({}).limit(20).lean() }) });
  route(app, ctx, {
    method: 'POST', url: '/admin/users', summary: 'Create a staff user', tags: ['Admin'], auth: A, permission: 'users:manage', body: z.object({ email: emailSchema, name: z.string().min(1).max(80), password: passwordSchema, role: z.enum(ROLES).refine((r) => r !== 'CUSTOMER') }),
    handler: async ({ req, body, reply }) => reply.status(201).send(await createStaffUser(ctx, body, req.actor)),
  });
  route(app, ctx, {
    method: 'PATCH', url: '/admin/users/:id', summary: 'Change role / disable a staff user', tags: ['Admin'], auth: A, permission: 'users:manage', body: z.object({ role: z.enum(ROLES).optional(), disabled: z.boolean().optional() }),
    handler: async ({ req, body }) => {
      if (idOf(req) === req.user!.id) throw new DomainError('You cannot change your own role or status', 'FORBIDDEN', 403);
      const prev = await User.findById(idOf(req)).select('role disabled').lean();
      await User.updateOne({ _id: idOf(req) }, { $set: body });
      if (body.disabled) { const { revokeAllSessions } = await import('@orvia/core'); await revokeAllSessions(idOf(req)); }
      await audit(ctx, req.actor, { action: 'user.updated', resource: 'user', resourceId: idOf(req), previousValue: prev, newValue: body });
      return { ok: true };
    },
  });
}
