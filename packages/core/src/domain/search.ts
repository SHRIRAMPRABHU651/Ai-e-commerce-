import { Product } from '@orvia/database';
import { SELLABLE_STATES } from '@orvia/types';
import type { CountryCode, SearchQuery } from '@orvia/types';
import type { StoreProduct } from './catalog';
import { toStoreProduct } from './catalog';
import { getCountry } from '../infra/countries';

interface IndexDoc {
  id: string;
  slug: string;
  title: string;
  tokens: string[];
  category: string;
  topCategory: string;
  brand: string;
  tags: string[];
  state: string;
  createdAt: number;
  sold: number;
  trend: number;
  rating: number;
  prices: Partial<Record<CountryCode, { price: number; stock: number }>>;
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s-]/g, ' ');
export const tokenize = (s: string): string[] => norm(s).split(/[\s-]+/).filter((t) => t.length > 1);

/** Damerau-Levenshtein with early exit (typo tolerance). */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 0; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
      rowMin = Math.min(rowMin, d[i]![j]!);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length]![b.length]!;
}

let index: { at: number; docs: IndexDoc[]; vocab: Set<string> } | null = null;
const TTL = 30_000;
const MAX_DOCS = 5000; // bounded; above this scale use Atlas Search (documented)

export function invalidateSearchIndex(): void {
  index = null;
}

async function getIndex() {
  if (index && Date.now() - index.at < TTL) return index;
  const rows = await Product.find({ state: { $in: SELLABLE_STATES } })
    .select('title slug seo tags category topCategory brand state createdAt stats markets')
    .limit(MAX_DOCS)
    .lean();
  const docs: IndexDoc[] = rows.map((p) => ({
    id: String(p._id),
    slug: p.slug,
    title: p.title,
    tokens: tokenize([p.title, ...(p.tags ?? []), ...(p.seo?.keywords ?? []), p.category ?? '', p.topCategory ?? '', p.brand ?? ''].join(' ')),
    category: p.category ?? '',
    topCategory: p.topCategory ?? '',
    brand: p.brand ?? '',
    tags: p.tags ?? [],
    state: p.state,
    createdAt: (p as unknown as { createdAt: Date }).createdAt?.getTime() ?? 0,
    sold: p.stats?.soldCount ?? 0,
    trend: p.stats?.trendScore ?? 0,
    rating: p.stats?.ratingAvg ?? 0,
    prices: Object.fromEntries(p.markets.filter((m) => m.enabled).map((m) => [m.country, { price: m.price, stock: m.stock }])),
  }));
  const vocab = new Set(docs.flatMap((d) => d.tokens));
  index = { at: Date.now(), docs, vocab };
  return index;
}

function scoreDoc(d: IndexDoc, qTokens: string[], vocab: Set<string>): number {
  let score = 0;
  const title = norm(d.title);
  for (const t of qTokens) {
    let best = 0;
    if (title.startsWith(t) || title.includes(` ${t}`)) best = 10;
    else if (d.tokens.includes(t)) best = 6;
    else if (d.tokens.some((x) => x.startsWith(t) && t.length >= 3)) best = 4;
    else if (t.length >= 4) {
      // typo tolerance: allow 1 edit for 4-6 chars, 2 for longer
      const max = t.length >= 7 ? 2 : 1;
      if (d.tokens.some((x) => editDistance(t, x, max) <= max)) best = 3;
    }
    if (!best && !vocab.has(t) && t.length < 3) best = 0;
    if (!best) return 0; // every query term must match something (AND semantics)
    score += best;
  }
  return score;
}

export interface SearchResult {
  items: StoreProduct[];
  total: number;
  page: number;
  pageSize: number;
  correctedQuery?: string;
  facets: { categories: { slug: string; count: number }[]; priceRange: { min: number; max: number } | null };
}

export async function searchProducts(q: SearchQuery, country: CountryCode): Promise<SearchResult> {
  const cfg = await getCountry(country);
  const idx = await getIndex();
  const qTokens = tokenize(q.q ?? '');
  let corrected: string | undefined;
  let docs = idx.docs.filter((d) => d.prices[country]?.price);
  if (q.category) docs = docs.filter((d) => d.category === q.category || d.topCategory === q.category || (q.category === 'trending' && d.trend >= 40));
  if (q.brand) docs = docs.filter((d) => d.brand.toLowerCase() === q.brand!.toLowerCase());
  if (q.inStock) docs = docs.filter((d) => (d.prices[country]?.stock ?? 0) > 0);
  if (q.minRating) docs = docs.filter((d) => d.rating >= q.minRating!);
  if (q.minPrice !== undefined) docs = docs.filter((d) => d.prices[country]!.price >= q.minPrice! * 100);
  if (q.maxPrice !== undefined) docs = docs.filter((d) => d.prices[country]!.price <= q.maxPrice! * 100);
  const scored = qTokens.length ? docs.map((d) => ({ d, s: scoreDoc(d, qTokens, idx.vocab) })).filter((x) => x.s > 0) : docs.map((d) => ({ d, s: 0 }));
  if (qTokens.length && scored.length) {
    const exact = qTokens.every((t) => idx.vocab.has(t));
    if (!exact) {
      corrected = qTokens.map((t) => (idx.vocab.has(t) ? t : [...idx.vocab].filter((v) => editDistance(t, v, 2) <= 2).sort((a, b) => editDistance(t, a) - editDistance(t, b))[0] ?? t)).join(' ');
    }
  }
  const sorted = scored.sort((a, b) => {
    switch (q.sort) {
      case 'price_asc': return a.d.prices[country]!.price - b.d.prices[country]!.price;
      case 'price_desc': return b.d.prices[country]!.price - a.d.prices[country]!.price;
      case 'rating': return b.d.rating - a.d.rating || b.d.sold - a.d.sold;
      case 'trending': return b.d.trend - a.d.trend;
      case 'newest': return b.d.createdAt - a.d.createdAt;
      case 'bestselling': return b.d.sold - a.d.sold;
      default: return b.s - a.s || b.d.trend - a.d.trend || b.d.sold - a.d.sold;
    }
  });
  const total = sorted.length;
  const pageDocs = sorted.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
  const full = await Product.find({ _id: { $in: pageDocs.map((x) => x.d.id) } }).lean();
  const byId = new Map(full.map((p) => [String(p._id), p]));
  const items = pageDocs.map((x) => byId.get(x.d.id)).filter((p): p is NonNullable<typeof p> => !!p).map((p) => toStoreProduct(p, country, cfg.returnWindowDays));
  const catCounts = new Map<string, number>();
  for (const x of sorted) catCounts.set(x.d.category, (catCounts.get(x.d.category) ?? 0) + 1);
  const prices = sorted.map((x) => x.d.prices[country]!.price);
  return {
    items, total, page: q.page, pageSize: q.pageSize, correctedQuery: corrected && corrected !== qTokens.join(' ') ? corrected : undefined,
    facets: { categories: [...catCounts.entries()].map(([slug, count]) => ({ slug, count })).sort((a, b) => b.count - a.count), priceRange: prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null },
  };
}

export async function suggest(prefix: string, country: CountryCode, limit = 8): Promise<{ type: 'product' | 'category'; label: string; slug?: string }[]> {
  const idx = await getIndex();
  const t = tokenize(prefix);
  if (!t.length) return [];
  const docs = idx.docs.filter((d) => d.prices[country]?.price).map((d) => ({ d, s: scoreDoc(d, t, idx.vocab) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || b.d.sold - a.d.sold).slice(0, limit);
  return docs.map((x) => ({ type: 'product' as const, label: x.d.title, slug: x.d.slug }));
}
