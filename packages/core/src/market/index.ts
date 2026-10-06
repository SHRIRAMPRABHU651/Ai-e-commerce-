import { AnalyticsEvent, MarketDocument, MarketTopic, Product } from '@orvia/database';
import { DEFAULT_COUNTRIES, convertMinor } from '@orvia/types';
import type { CountryCode, Currency, FxTable } from '@orvia/types';
import type { Ctx } from '../infra/context';
import { SAME_ENTITY_THRESHOLD, keywordsOf, normalizeProductName, similarity } from './normalize';
import { priceStats, scoreTopic } from './trend';
import type { InternalSignals, PriceStats, TrendResult } from './trend';

export * from './robots';
export * from './normalize';
export * from './parsers';
export * from './fetcher';
export * from './indexer';
export * from './trend';

const DAY = 86_400_000;

async function internalSearchBuckets(now: number): Promise<Map<string, { q: string; recent: number; prior: number; results: number }>> {
  const rows = await AnalyticsEvent.aggregate<{ _id: string; recent: number; prior: number; results: number }>([
    { $match: { type: 'search', ts: { $gte: new Date(now - 14 * DAY) }, 'meta.q': { $exists: true } } },
    { $group: { _id: '$meta.q', recent: { $sum: { $cond: [{ $gte: ['$ts', new Date(now - 7 * DAY)] }, 1, 0] } }, prior: { $sum: { $cond: [{ $lt: ['$ts', new Date(now - 7 * DAY)] }, 1, 0] } }, results: { $sum: { $ifNull: ['$meta.results', 0] } } } },
    { $limit: 5000 },
  ]);
  return new Map(rows.map((r) => [String(r._id), { q: String(r._id), recent: r.recent, prior: r.prior, results: r.results }]));
}

async function productEventBuckets(now: number): Promise<Map<string, Omit<InternalSignals, 'searchRecent' | 'searchPrior'>>> {
  const rows = await AnalyticsEvent.aggregate<{ _id: { p: unknown; t: string; recent: boolean }; n: number }>([
    { $match: { productId: { $exists: true }, ts: { $gte: new Date(now - 14 * DAY) }, type: { $in: ['product_view', 'add_to_cart', 'purchase'] } } },
    { $group: { _id: { p: '$productId', t: '$type', recent: { $gte: ['$ts', new Date(now - 7 * DAY)] } }, n: { $sum: 1 } } },
  ]);
  const m = new Map<string, Omit<InternalSignals, 'searchRecent' | 'searchPrior'>>();
  for (const r of rows) {
    const id = String(r._id.p);
    const cur = m.get(id) ?? { viewsRecent: 0, viewsPrior: 0, cartsRecent: 0, cartsPrior: 0, purchasesRecent: 0, purchasesPrior: 0 };
    const key = r._id.t === 'product_view' ? 'views' : r._id.t === 'add_to_cart' ? 'carts' : 'purchases';
    (cur as Record<string, number>)[`${key}${r._id.recent ? 'Recent' : 'Prior'}`]! += r.n;
    m.set(id, cur);
  }
  return m;
}

export interface RecomputeSummary { topics: number; scored: number; trending: number; rising: number; insufficient: number; productsLinked: number }

/**
 * Recompute every active topic: observations (public sources) + Orvia behaviour → score, confidence, status, evidence,
 * competitor price stats; then link matching Orvia products so pricing/discovery can use the evidence.
 */
export async function recomputeTrends(ctx: Ctx): Promise<RecomputeSummary> {
  const now = ctx.now();
  const settings = await ctx.settings.get('market');
  const ops = await ctx.settings.get('ops');
  const topics = await MarketTopic.find({ lastSeen: { $gte: new Date(now.getTime() - 60 * DAY) } }).limit(3000);
  const searches = await internalSearchBuckets(now.getTime());
  const events = await productEventBuckets(now.getTime());
  const products = await Product.find({ state: { $nin: ['BANNED', 'ARCHIVED'] } }).select('title').limit(5000).lean();
  const out: RecomputeSummary = { topics: topics.length, scored: 0, trending: 0, rising: 0, insufficient: 0, productsLinked: 0 };
  for (const t of topics) {
    const docs = await MarketDocument.find({ topicId: t._id, observedAt: { $gte: new Date(now.getTime() - 45 * DAY) } }).select('sourceId source observedAt day price currency availability sourceUrl').limit(4000).lean();
    const name = t.displayName ?? t.normalizedName;
    // Orvia behaviour matched to this topic
    const matched = products.filter((p) => similarity(p.title, name) >= SAME_ENTITY_THRESHOLD);
    const internal: InternalSignals = { searchRecent: 0, searchPrior: 0, viewsRecent: 0, viewsPrior: 0, cartsRecent: 0, cartsPrior: 0, purchasesRecent: 0, purchasesPrior: 0 };
    for (const s of searches.values()) if (similarity(s.q, name) >= SAME_ENTITY_THRESHOLD) { internal.searchRecent += s.recent; internal.searchPrior += s.prior; }
    for (const p of matched) { const e = events.get(String(p._id)); if (e) for (const k of Object.keys(e) as (keyof typeof e)[]) internal[k] += e[k]; }
    const result = scoreTopic({
      observations: docs.map((d) => ({ sourceId: String(d.sourceId), source: d.source ?? 'source', observedAt: d.observedAt, day: d.day, price: d.price, availability: d.availability, url: d.sourceUrl })),
      internal, weights: settings.weights, now, minConfidence: settings.minConfidence, minInternalSample: settings.minInternalSample,
    });
    // competitor prices → USD (FX source is the static rate table in settings; recorded with the stats)
    const toUsd = (price: number, cur?: string | null) => (cur && cur in ops.fx ? convertMinor(price, cur as Currency, 'USD', ops.fx) : null);
    const priceRows = docs.filter((d) => d.price && d.sourceUrl).map((d) => { const usd = toUsd(d.price!, d.currency); return usd ? { url: d.sourceUrl!, host: safeHost(d.sourceUrl!), price: usd, observedAt: d.observedAt } : null; }).filter((x): x is NonNullable<typeof x> => !!x);
    const prior = priceRows.filter((r) => now.getTime() - r.observedAt.getTime() > 7 * DAY).map((r) => r.price);
    const ps = priceStats(priceRows, { now, staleDays: settings.priceStaleDays, currency: 'USD', prior });
    t.trendScore = result.trendScore;
    t.confidence = result.confidence;
    t.status = result.status;
    t.growthPct = result.growthPct;
    t.components = result.components;
    t.windows = result.windows;
    t.evidence = { ...result.evidence, reasons: result.reasons, warnings: result.warnings };
    t.price = ps ? { ...ps, fxSource: 'configured static rates (settings.ops.fx)', fxAsOf: now.toISOString() } : undefined;
    t.observationCount = docs.length;
    t.sourceCount = new Set(docs.map((d) => String(d.sourceId))).size;
    t.internal = internal;
    t.matchedProductIds = matched.map((p) => p._id) as never;
    t.computedAt = now;
    await t.save();
    out.scored++;
    if (result.status === 'TRENDING') out.trending++;
    else if (result.status === 'RISING') out.rising++;
    else if (result.status === 'INSUFFICIENT_DATA') out.insufficient++;
    for (const p of matched) {
      out.productsLinked++;
      await linkProduct(ctx, String(p._id), { ...result, price: ps, topicId: String(t._id), minConfidence: settings.minConfidence, ops });
    }
  }
  return out;
}

const safeHost = (u: string) => { try { return new URL(u).host; } catch { return u; } };

async function linkProduct(ctx: Ctx, productId: string, r: TrendResult & { price: PriceStats | null; topicId: string; minConfidence: number; ops: { fx: FxTable } }): Promise<void> {
  const set: Record<string, unknown> = { 'intel.source': 'market-index', 'intel.topicId': r.topicId, 'intel.confidence': r.confidence, 'intel.status': r.status, 'intel.computedAt': ctx.now() };
  const usable = r.confidence >= r.minConfidence && r.status !== 'INSUFFICIENT_DATA';
  if (usable) { set['intel.trend'] = r.trendScore; set['intel.demand'] = r.trendScore; set['stats.trendScore'] = r.trendScore; }
  if (r.price && r.price.confidence !== 'LOW') {
    const prices: Record<string, number[]> = {};
    for (const c of Object.values(DEFAULT_COUNTRIES)) prices[c.code] = [r.price.low, r.price.median, r.price.high].map((u) => convertMinor(u, 'USD', c.currency, r.ops.fx));
    set['intel.competitorPrices'] = prices;
    set['intel.competition'] = Math.max(10, 100 - r.price.n * 8);
  }
  set['intel.competitorConfidence'] = r.price?.confidence ?? 'LOW';
  await Product.updateOne({ _id: productId }, { $set: set });
}

export interface ResolvedIntel {
  source: 'market-index' | 'mock';
  demand?: number; trend?: number; competition?: number; video?: boolean; competitorPricesUsd: number[];
  confidence: number; competitorConfidence: 'LOW' | 'MEDIUM' | 'HIGH'; status?: string; topicId?: string; evidence?: string[];
}

/** Evidence for a product name from the market index (no data ⇒ null; the caller then uses neutral priors, never invented numbers). */
export async function intelFromIndex(ctx: Ctx, title: string, country?: CountryCode): Promise<ResolvedIntel | null> {
  const settings = await ctx.settings.get('market');
  const kws = keywordsOf(title);
  if (!kws.length) return null;
  const cands = await MarketTopic.find({ keywords: { $in: kws }, ...(country ? { $or: [{ country }, { country: null }, { country: { $exists: false } }] } : {}) }).limit(30).lean();
  let best: { t: (typeof cands)[number]; sim: number } | null = null;
  for (const c of cands) { const sim = similarity(title, c.displayName ?? c.normalizedName); if (sim >= SAME_ENTITY_THRESHOLD && (!best || sim > best.sim)) best = { t: c, sim }; }
  if (!best) return null;
  const t = best.t;
  const price = t.price as PriceStats | undefined;
  const usable = (t.confidence ?? 0) >= settings.minConfidence && t.status !== 'INSUFFICIENT_DATA';
  return {
    source: 'market-index', topicId: String(t._id), status: t.status, confidence: t.confidence ?? 0,
    trend: usable ? t.trendScore : undefined, demand: usable ? t.trendScore : undefined,
    competition: price && price.confidence !== 'LOW' ? Math.max(10, 100 - price.n * 8) : undefined,
    competitorPricesUsd: price && price.confidence !== 'LOW' ? [price.low, price.median, price.high] : [],
    competitorConfidence: price?.confidence ?? 'LOW', evidence: ((t.evidence as { reasons?: string[] } | undefined)?.reasons ?? []).slice(0, 5),
  };
}

export { normalizeProductName };

/** Human-readable, evidence-only explanation. Never states anything that is not in the stored evidence. */
export function explainTopic(t: { displayName?: string | null; normalizedName: string; trendScore: number; confidence: number; status: string; growthPct?: number | null; sourceCount: number; observationCount: number; country?: string | null; category?: string | null; evidence?: unknown; price?: unknown; internal?: unknown; components?: unknown }): { evidence: string[]; warnings: string[]; text: string } {
  const ev = (t.evidence ?? {}) as { sources?: { source: string; recent: number; prior: number; growthPct: number; firstSeen: string; lastSeen: string }[]; reasons?: string[]; warnings?: string[]; firstSeen?: string; lastSeen?: string; spanDays?: number; internal?: Record<string, number> };
  const lines: string[] = [];
  for (const s of ev.sources ?? []) lines.push(`Source "${s.source}": observed ${s.recent}× in the last 7 days vs ${s.prior}× in the 7 days before (${s.growthPct > 0 ? '+' : ''}${s.growthPct}%); first seen ${s.firstSeen.slice(0, 10)}, last seen ${s.lastSeen.slice(0, 10)}.`);
  const i = ev.internal;
  if (i?.searchGrowthPct !== undefined) lines.push(`Orvia search: ${i.searchRecent} searches in the last 7 days vs ${i.searchPrior} before (${i.searchGrowthPct > 0 ? '+' : ''}${i.searchGrowthPct}%).`);
  if (i?.conversionGrowthPct !== undefined) lines.push(`Orvia customer activity (views/carts/purchases, weighted): ${i.conversionGrowthPct > 0 ? '+' : ''}${i.conversionGrowthPct}% vs the previous week.`);
  const p = t.price as PriceStats | undefined;
  if (p) lines.push(`Competitor prices: ${p.n} observation(s) from ${p.hosts} site(s), median $${(p.median / 100).toFixed(2)} (low $${(p.low / 100).toFixed(2)}, high $${(p.high / 100).toFixed(2)}), confidence ${p.confidence}.`);
  const head = `${t.displayName ?? t.normalizedName}: ${t.status.replace('_', ' ')} — score ${t.trendScore}/100, confidence ${Math.round(t.confidence * 100)}%, ${t.sourceCount} source(s), ${t.observationCount} observation(s).`;
  const text = t.status === 'INSUFFICIENT_DATA' ? `${head} There is not enough evidence to call this a trend.` : `${head}\nEvidence:\n${lines.map((l) => `• ${l}`).join('\n')}`;
  return { evidence: lines, warnings: ev.warnings ?? [], text };
}
