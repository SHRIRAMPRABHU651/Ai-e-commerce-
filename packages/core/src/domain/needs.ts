import { Product } from '@orvia/database';
import { NEEDS, SELLABLE_STATES, needBySlug } from '@orvia/types';
import type { CountryCode, NeedDef } from '@orvia/types';
import { DomainError } from '../infra/context';
import { listableImageFilter } from './images';
import { toStoreProduct } from './catalog';

const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Sellable, imaged, in-stock products in this country that satisfy the need's catalogue rules. */
function needFilter(need: NeedDef, country: CountryCode): Record<string, unknown> {
  const or: Record<string, unknown>[] = [];
  if (need.match.categories?.length) or.push({ category: { $in: need.match.categories } });
  if (need.match.keywords?.length) {
    const rx = new RegExp(`\\b(${need.match.keywords.map(esc).join('|')})\\b`, 'i');
    or.push({ tags: rx }, { title: rx });
  }
  return {
    state: { $in: SELLABLE_STATES },
    $and: [listableImageFilter(), { $or: or.length ? or : [{ _id: null }] }],
    markets: { $elemMatch: { country, enabled: true, price: { $gt: 0 }, stock: { $gt: 0 } } },
  };
}

export interface NeedSummary {
  slug: string;
  name: string;
  tagline: string;
  promise: string;
  count: number;
  image?: string;
  imageAlt?: string;
}

/** Needs that currently have products for the country (empty needs are hidden, never shown as dead ends). */
export async function listNeeds(country: CountryCode): Promise<NeedSummary[]> {
  const rows = await Promise.all(
    NEEDS.map(async (n) => {
      const f = needFilter(n, country);
      const [count, top] = await Promise.all([Product.countDocuments(f), Product.findOne(f).sort({ 'stats.trendScore': -1, 'stats.soldCount': -1 }).select('title images').lean()]);
      return { slug: n.slug, name: n.name, tagline: n.tagline, promise: n.promise, count, image: top?.images?.[0]?.url ?? undefined, imageAlt: top?.title };
    }),
  );
  return rows.filter((r) => r.count > 0);
}

export async function productsForNeed(slug: string, country: CountryCode, page = 1, pageSize = 24) {
  const need = needBySlug(slug);
  if (!need) throw new DomainError('Not found', 'NOT_FOUND', 404);
  const f = needFilter(need, country);
  const size = Math.min(Math.max(pageSize, 1), 48);
  const [total, rows] = await Promise.all([
    Product.countDocuments(f),
    Product.find(f).sort({ 'stats.trendScore': -1, 'stats.soldCount': -1, createdAt: -1 }).skip((Math.max(page, 1) - 1) * size).limit(size).lean(),
  ]);
  return {
    need: { slug: need.slug, name: need.name, tagline: need.tagline, promise: need.promise },
    items: (rows as never as Parameters<typeof toStoreProduct>[0][]).map((p) => toStoreProduct(p, country)),
    total, page: Math.max(page, 1), pageSize: size,
  };
}
