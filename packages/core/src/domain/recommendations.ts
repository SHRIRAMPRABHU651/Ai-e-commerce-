import { AnalyticsEvent, Order, Product } from '@orvia/database';
import { SELLABLE_STATES } from '@orvia/types';
import type { CountryCode } from '@orvia/types';
import { toStoreProduct } from './catalog';
import type { StoreProduct } from './catalog';

/** Rules/behavioural recommender. Designed so an ML ranker can replace `rank` later. */
export interface RecContext {
  country: CountryCode;
  userId?: string;
  sessionId?: string;
  viewedIds?: string[];
}

const baseFilter = (country: CountryCode, extra: Record<string, unknown> = {}) => ({ state: { $in: SELLABLE_STATES }, markets: { $elemMatch: { country, enabled: true, price: { $gt: 0 }, stock: { $gt: 0 } } }, ...extra });
const project = (rows: Awaited<ReturnType<typeof Product.find>>, country: CountryCode): StoreProduct[] => (rows as never as Parameters<typeof toStoreProduct>[0][]).map((p) => toStoreProduct(p, country));

export async function trending(country: CountryCode, limit = 12, category?: string) {
  const rows = await Product.find(baseFilter(country, category ? { $or: [{ category }, { topCategory: category }] } : {})).sort({ 'stats.trendScore': -1, 'stats.soldCount': -1 }).limit(limit).lean();
  return project(rows as never, country);
}
export async function newArrivals(country: CountryCode, limit = 12) {
  return project((await Product.find(baseFilter(country)).sort({ createdAt: -1 }).limit(limit).lean()) as never, country);
}
export async function bestSellers(country: CountryCode, limit = 12) {
  return project((await Product.find(baseFilter(country)).sort({ 'stats.soldCount': -1, 'stats.ratingAvg': -1 }).limit(limit).lean()) as never, country);
}
export async function deals(country: CountryCode, limit = 12) {
  const rows = await Product.find(baseFilter(country)).limit(200).lean();
  const withDiscount = rows.map((p) => ({ p, d: (() => { const m = p.markets.find((x) => x.country === country); return m && m.compareAtPrice > m.price ? 1 - m.price / m.compareAtPrice : 0; })() })).filter((x) => x.d > 0).sort((a, b) => b.d - a.d).slice(0, limit);
  return project(withDiscount.map((x) => x.p) as never, country);
}
export async function similar(productId: string, country: CountryCode, limit = 8) {
  const p = await Product.findById(productId).select('category topCategory tags').lean();
  if (!p) return [];
  const rows = await Product.find(baseFilter(country, { _id: { $ne: productId }, $or: [{ category: p.category }, { tags: { $in: p.tags ?? [] } }] })).sort({ 'stats.soldCount': -1 }).limit(limit).lean();
  return project(rows as never, country);
}
export async function frequentlyBoughtTogether(productId: string, country: CountryCode, limit = 4) {
  const orders = await Order.find({ 'items.productId': productId, 'payment.status': 'succeeded' }).select('items.productId').limit(500).lean();
  const counts = new Map<string, number>();
  for (const o of orders) for (const it of o.items) if (String(it.productId) !== productId) counts.set(String(it.productId), (counts.get(String(it.productId)) ?? 0) + 1);
  const ids = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);
  if (!ids.length) return similar(productId, country, limit);
  const rows = await Product.find(baseFilter(country, { _id: { $in: ids } })).lean();
  return project(rows as never, country);
}
export async function recommendedForYou(ctx: RecContext, limit = 12) {
  const viewed = ctx.viewedIds ?? [];
  let seeds = viewed;
  if (!seeds.length && ctx.userId) {
    const ev = await AnalyticsEvent.find({ userId: ctx.userId, productId: { $exists: true } }).sort({ ts: -1 }).limit(20).select('productId').lean();
    seeds = ev.map((e) => String(e.productId));
  }
  if (!seeds.length) return trending(ctx.country, limit);
  const seedProducts = await Product.find({ _id: { $in: seeds } }).select('category topCategory').lean();
  const cats = [...new Set(seedProducts.map((s) => s.category).filter(Boolean))];
  const tops = [...new Set(seedProducts.map((s) => s.topCategory).filter(Boolean))];
  const rows = await Product.find(baseFilter(ctx.country, { _id: { $nin: seeds }, $or: [{ category: { $in: cats } }, { topCategory: { $in: tops } }] })).sort({ 'stats.trendScore': -1, 'stats.soldCount': -1 }).limit(limit).lean();
  const out = project(rows as never, ctx.country);
  return out.length >= 4 ? out : [...out, ...(await trending(ctx.country, limit))].slice(0, limit);
}
export async function recentlyViewed(ids: string[], country: CountryCode) {
  if (!ids.length) return [];
  const rows = await Product.find({ _id: { $in: ids.slice(0, 12) }, state: { $in: SELLABLE_STATES } }).lean();
  const order = new Map(ids.map((id, i) => [id, i]));
  return project(rows.sort((a, b) => order.get(String(a._id))! - order.get(String(b._id))!) as never, country);
}
export async function countryTrending(country: CountryCode, limit = 8) {
  const since = new Date(Date.now() - 14 * 86_400_000);
  const ev = await AnalyticsEvent.aggregate<{ _id: string; n: number }>([{ $match: { country, type: { $in: ['purchase', 'add_to_cart'] }, ts: { $gte: since }, productId: { $exists: true } } }, { $group: { _id: '$productId', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: limit }]);
  if (!ev.length) return trending(country, limit);
  const rows = await Product.find(baseFilter(country, { _id: { $in: ev.map((e) => e._id) } })).lean();
  return project(rows as never, country);
}
