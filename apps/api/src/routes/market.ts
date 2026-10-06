import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AnalyticsEvent, MarketDocument, MarketSource, MarketTopic } from '@orvia/database';
import { MARKET_SOURCE_TYPES } from '@orvia/database';
import { DomainError, assertPublicUrl, audit, crawlSource, explainTopic, notFound, recomputeTrends, similarity, SAME_ENTITY_THRESHOLD } from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { countrySchema, paginationSchema } from '@orvia/types';
import { route } from '../http';

const A = 'staff' as const;
const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const sourceBody = z.object({
  name: z.string().min(2).max(80),
  type: z.enum(MARKET_SOURCE_TYPES),
  baseUrl: z.string().url().max(500).optional(),
  country: countrySchema.optional(),
  category: z.string().max(60).optional(),
  enabled: z.boolean().default(true),
  crawlIntervalMinutes: z.number().int().min(15).max(7 * 24 * 60).default(360),
  robotsRequired: z.boolean().default(true),
  parserConfig: z.record(z.unknown()).optional(),
  fetchProductPages: z.number().int().min(0).max(100).default(0),
});

export function marketRoutes(app: FastifyInstance, ctx: Ctx): void {
  const publicOnly = async (url?: string) => { if (url) await assertPublicUrl(url, ctx.cfg.ALLOW_PRIVATE_FETCH).catch((e) => { throw new DomainError(`Source URL rejected: ${(e as Error).message}`, 'VALIDATION', 422); }); };

  route(app, ctx, {
    method: 'GET', url: '/admin/market/sources', summary: 'Market sources with crawl health', tags: ['Market'], auth: A, permission: 'market:read',
    handler: async () => {
      const rows = await MarketSource.find().sort({ name: 1 }).limit(200).lean();
      return { items: rows.map((s) => ({ id: String(s._id), name: s.name, type: s.type, baseUrl: s.baseUrl, country: s.country, category: s.category, enabled: s.enabled, crawlIntervalMinutes: s.crawlIntervalMinutes, robotsRequired: s.robotsRequired, parserConfig: s.parserConfig, fetchProductPages: s.fetchProductPages, lastCrawledAt: s.lastCrawledAt, lastSuccessAt: s.lastSuccessAt, lastFailureAt: s.lastFailureAt, lastError: s.lastError, failureCount: s.failureCount, documentsCollected: s.documentsCollected, healthStatus: s.healthStatus, robotsStatus: s.robotsStatus, successRate: s.successRate })), types: MARKET_SOURCE_TYPES };
    },
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/market/sources', summary: 'Add a public market source', tags: ['Market'], auth: A, permission: 'market:write', body: sourceBody,
    handler: async ({ req, body, reply }) => {
      if (['RSS', 'ATOM', 'SITEMAP', 'HTML_LISTING', 'HTML_PRODUCT', 'JSON_PUBLIC'].includes(body.type) && !body.baseUrl) throw new DomainError('A URL is required for this source type', 'VALIDATION', 422);
      await publicOnly(body.baseUrl);
      const s = await MarketSource.create(body);
      await audit(ctx, req.actor, { action: 'market.source_created', resource: 'market_source', resourceId: String(s._id), newValue: body });
      return reply.status(201).send({ id: String(s._id) });
    },
  });
  route(app, ctx, {
    method: 'PATCH', url: '/admin/market/sources/:id', summary: 'Edit/enable/disable a market source', tags: ['Market'], auth: A, permission: 'market:write', body: sourceBody.partial(),
    handler: async ({ req, body }) => {
      await publicOnly(body.baseUrl);
      const set: Record<string, unknown> = { ...body };
      if (body.enabled === true) { set['failureCount'] = 0; set['healthStatus'] = 'NEW'; }
      if (body.enabled === false) set['healthStatus'] = 'DISABLED';
      if (body.baseUrl) { set['etag'] = null; set['robotsCheckedAt'] = null; }
      const r = await MarketSource.updateOne({ _id: idOf(req) }, { $set: set });
      if (!r.matchedCount) throw notFound('Source');
      await audit(ctx, req.actor, { action: 'market.source_updated', resource: 'market_source', resourceId: idOf(req), newValue: body });
      return { ok: true };
    },
  });
  route(app, ctx, {
    method: 'DELETE', url: '/admin/market/sources/:id', summary: 'Delete a market source and its observations', tags: ['Market'], auth: A, permission: 'market:write',
    handler: async ({ req }) => {
      await MarketDocument.deleteMany({ sourceId: idOf(req) });
      const r = await MarketSource.deleteOne({ _id: idOf(req) });
      if (!r.deletedCount) throw notFound('Source');
      await audit(ctx, req.actor, { action: 'market.source_deleted', resource: 'market_source', resourceId: idOf(req) });
      return { ok: true };
    },
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/market/sources/:id/crawl', summary: 'Test / crawl a source now (robots-aware)', tags: ['Market'], auth: A, permission: 'market:write', rateLimit: { max: 20, timeWindow: '1 minute' },
    handler: async ({ req }) => {
      const r = await crawlSource(ctx, idOf(req));
      await audit(ctx, req.actor, { action: 'market.source_crawled', resource: 'market_source', resourceId: idOf(req), newValue: r });
      return r;
    },
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/market/recompute', summary: 'Recompute trend scores now', tags: ['Market'], auth: A, permission: 'market:write',
    handler: async ({ req }) => { const r = await recomputeTrends(ctx); await audit(ctx, req.actor, { action: 'market.recomputed', resource: 'market', newValue: r }); return r; },
  });

  route(app, ctx, {
    method: 'GET', url: '/admin/market/topics', summary: 'Trend topics with score, confidence and evidence', tags: ['Market'], auth: A, permission: 'market:read',
    query: paginationSchema.extend({ status: z.enum(['TRENDING', 'RISING', 'STABLE', 'DECLINING', 'INSUFFICIENT_DATA']).optional(), country: countrySchema.optional(), category: z.string().max(60).optional(), q: z.string().trim().max(60).optional(), sort: z.enum(['score', 'confidence', 'recent', 'growth']).default('score') }),
    handler: async ({ query }) => {
      const f: Record<string, unknown> = {};
      if (query.status) f['status'] = query.status;
      if (query.country) f['country'] = query.country;
      if (query.category) f['category'] = query.category;
      if (query.q) f['normalizedName'] = new RegExp(escapeRegex(query.q.toLowerCase()), 'i');
      const sort = query.sort === 'confidence' ? { confidence: -1 } : query.sort === 'recent' ? { lastSeen: -1 } : query.sort === 'growth' ? { growthPct: -1 } : { trendScore: -1 };
      const [items, total] = await Promise.all([MarketTopic.find(f).sort(sort as never).skip((query.page - 1) * query.pageSize).limit(query.pageSize).lean(), MarketTopic.countDocuments(f)]);
      return { total, page: query.page, pageSize: query.pageSize, items: items.map((t) => ({ id: String(t._id), name: t.displayName ?? t.normalizedName, status: t.status, trendScore: t.trendScore, confidence: t.confidence, growthPct: t.growthPct, sourceCount: t.sourceCount, observationCount: t.observationCount, firstSeen: t.firstSeen, lastSeen: t.lastSeen, country: t.country, category: t.category, price: t.price, matchedProducts: t.matchedProductIds?.length ?? 0, computedAt: t.computedAt })) };
    },
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/market/topics/:id', summary: 'Topic detail: components, windows, evidence and an evidence-only explanation', tags: ['Market'], auth: A, permission: 'market:read',
    handler: async ({ req }) => {
      const t = await MarketTopic.findById(idOf(req)).lean();
      if (!t) throw notFound('Topic');
      const docs = await MarketDocument.find({ topicId: t._id }).sort({ observedAt: -1 }).limit(25).select('source sourceUrl title observedAt price currency availability rank').lean();
      return { topic: t, explanation: explainTopic(t as never), documents: docs };
    },
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/market/overview', summary: 'Dashboard: trending, rising, declining, source health, internal demand, price movement', tags: ['Market'], auth: A, permission: 'market:read',
    handler: async () => {
      const [counts, sources, sample] = await Promise.all([
        MarketTopic.aggregate<{ _id: string; n: number }>([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
        MarketSource.find().select('name enabled healthStatus robotsStatus lastSuccessAt failureCount documentsCollected successRate').lean(),
        MarketDocument.estimatedDocumentCount(),
      ]);
      const now = Date.now();
      const searches = await AnalyticsEvent.aggregate<{ _id: string; recent: number; prior: number; results: number }>([
        { $match: { type: 'search', ts: { $gte: new Date(now - 14 * 86_400_000) }, 'meta.q': { $exists: true } } },
        { $group: { _id: '$meta.q', recent: { $sum: { $cond: [{ $gte: ['$ts', new Date(now - 7 * 86_400_000)] }, 1, 0] } }, prior: { $sum: { $cond: [{ $lt: ['$ts', new Date(now - 7 * 86_400_000)] }, 1, 0] } }, results: { $avg: { $ifNull: ['$meta.results', 0] } } } },
        { $sort: { recent: -1 } }, { $limit: 15 },
      ]);
      const movers = await MarketTopic.find({ 'price.n': { $gte: 3 }, 'price.velocityPct': { $exists: true } }).sort({ 'price.velocityPct': -1 }).limit(10).select('displayName normalizedName price').lean();
      return {
        statusCounts: Object.fromEntries(counts.map((c) => [c._id, c.n])), documents: sample,
        sources: { total: sources.length, enabled: sources.filter((s) => s.enabled).length, healthy: sources.filter((s) => s.healthStatus === 'HEALTHY').length, blocked: sources.filter((s) => s.healthStatus === 'BLOCKED').length, failing: sources.filter((s) => ['FAILING', 'DEGRADED'].includes(s.healthStatus)).length },
        internalDemand: searches.map((s) => ({ query: s._id, last7d: s.recent, previous7d: s.prior, noResults: s.results < 1 })),
        priceMovement: movers.map((m) => ({ name: m.displayName ?? m.normalizedName, median: (m.price as { median: number }).median, velocityPct: (m.price as { velocityPct: number }).velocityPct, currency: 'USD' })),
        note: 'Everything here comes from configured public sources and Orvia’s own analytics. With no sources configured it stays empty — there is no fake data.',
      };
    },
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/market/match', summary: 'Which topic does a product name match?', tags: ['Market'], auth: A, permission: 'market:read', query: z.object({ title: z.string().min(2).max(160) }),
    handler: async ({ query }) => {
      const cands = await MarketTopic.find().sort({ trendScore: -1 }).limit(500).lean();
      const best = cands.map((t) => ({ t, sim: similarity(query.title, t.displayName ?? t.normalizedName) })).filter((x) => x.sim >= SAME_ENTITY_THRESHOLD).sort((a, b) => b.sim - a.sim)[0];
      return best ? { match: { id: String(best.t._id), name: best.t.displayName, similarity: Math.round(best.sim * 100) / 100, status: best.t.status, trendScore: best.t.trendScore, confidence: best.t.confidence } } : { match: null };
    },
  });
}
