/**
 * ORVIA Find: product comparison matrix and deterministic "best for" summary. PURE.
 * Only real fields appear. A "best for" is one measured attribute (price, delivery, rating), never an overall verdict.
 */
import type { CompareResponse, CompareRow } from '@orvia/types';
import { MIN_RATING_COUNT } from './ranking';
import type { FindCandidate } from './ranking';

export interface CompareProduct extends FindCandidate {
  delivered: number;
  returnWindowDays: number | null;
  shipsFrom: string | null;
  safetyStandards: string[];
  available: boolean;
}

const fmt = (minor: number, cur: string) =>
  new Intl.NumberFormat(cur === 'INR' ? 'en-IN' : cur === 'CAD' ? 'en-CA' : 'en-US', { style: 'currency', currency: cur, maximumFractionDigits: minor % 100 === 0 ? 0 : 2 }).format(minor / 100);

const windowLabel = (p: CompareProduct): string | null => {
  if (p.minDays === null && p.maxDays === null) return null;
  const lo = p.minDays ?? p.maxDays!;
  const hi = p.maxDays ?? p.minDays!;
  return lo === hi ? `${lo} days` : `${lo}-${hi} days`;
};
const ratingLabel = (p: CompareProduct): string =>
  p.rating.count >= MIN_RATING_COUNT ? `${p.rating.avg.toFixed(1)} / 5 (${p.rating.count} reviews)` : p.rating.count > 0 ? `Not enough reviews yet (${p.rating.count})` : 'No reviews yet';

const differs = (vals: (string | null)[]): boolean => new Set(vals.map((v) => (v === null ? '\u0000' : v.toLowerCase()))).size > 1;

/** The unique minimum by `key`; null if fewer than 2 comparable values or the minimum is tied. */
function uniqueBest<T>(items: T[], key: (t: T) => number | null, dir: 'min' | 'max'): { item: T; value: number } | null {
  const vals = items.map((i) => ({ item: i, v: key(i) })).filter((x): x is { item: T; v: number } => x.v !== null);
  if (vals.length < 2) return null;
  const best = dir === 'min' ? Math.min(...vals.map((x) => x.v)) : Math.max(...vals.map((x) => x.v));
  const top = vals.filter((x) => x.v === best);
  return top.length === 1 ? { item: top[0]!.item, value: best } : null;
}

export function buildComparison(products: CompareProduct[], country: string): CompareResponse {
  const cur = products[0]?.currency ?? '';
  const rows: CompareRow[] = [];
  const add = (key: string, label: string, values: (string | null)[]) => rows.push({ key, label, values, differs: differs(values) });

  add('price', 'Price', products.map((p) => fmt(p.price, p.currency)));
  add('delivered', 'Estimated delivered price (before tax)', products.map((p) => fmt(p.delivered, p.currency)));
  add('delivery', 'Estimated delivery window', products.map(windowLabel));
  add('rating', 'Customer rating', products.map(ratingLabel));
  add('returns', 'Return window', products.map((p) => (p.returnWindowDays ? `${p.returnWindowDays} days` : null)));
  add('availability', 'Availability', products.map((p) => (p.available ? 'In stock' : 'Unavailable in your country')));
  add('ships', 'Ships from', products.map((p) => p.shipsFrom));
  add('brand', 'Brand', products.map((p) => p.brand || null));
  add('category', 'Category', products.map((p) => p.category.replace(/-/g, ' ') || null));
  add('age', 'Listed age range', products.map((p) => p.ageRange ?? null));
  add('safety', 'Safety standards listed', products.map((p) => (p.safetyStandards.length ? p.safetyStandards.join(', ') : null)));
  const attrKeys = [...new Set(products.flatMap((p) => Object.keys(p.attributes)))].sort();
  for (const k of attrKeys) add(`attr:${k}`, k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, ' '), products.map((p) => p.attributes[k] ?? null));
  // drop rows with nothing to show for anyone
  const shown = rows.filter((r) => r.values.some((v) => v !== null));

  const keyDifferences: string[] = [];
  const sorted = [...products].sort((a, b) => a.delivered - b.delivered);
  if (products.length >= 2 && sorted[0]!.delivered !== sorted.at(-1)!.delivered) {
    const diff = sorted.at(-1)!.delivered - sorted[0]!.delivered;
    keyDifferences.push(`${sorted[0]!.title} is ${fmt(diff, cur)} cheaper (estimated delivered) than ${sorted.at(-1)!.title}.`);
  }
  const dRow = shown.find((r) => r.key === 'delivery');
  if (dRow?.differs) keyDifferences.push(`Delivery windows differ: ${products.map((p, i) => `${p.title}: ${dRow.values[i] ?? 'not available'}`).join('; ')}.`);
  const rRow = shown.find((r) => r.key === 'returns');
  if (rRow?.differs) keyDifferences.push(`Return windows differ: ${products.map((p, i) => `${p.title}: ${rRow.values[i] ?? 'not available'}`).join('; ')}.`);
  for (const r of shown.filter((x) => x.key.startsWith('attr:') && x.differs).slice(0, 4)) {
    keyDifferences.push(`${r.label}: ${products.map((p, i) => `${p.title} (${r.values[i] ?? 'not listed'})`).join(' vs ')}.`);
  }
  const catRow = shown.find((r) => r.key === 'category');
  if (catRow?.differs) keyDifferences.push('These products are in different categories, so they may not be direct substitutes.');
  const rated = products.filter((p) => p.rating.count >= MIN_RATING_COUNT);
  if (rated.length < products.length) keyDifferences.push(`Ratings are only compared for products with at least ${MIN_RATING_COUNT} reviews.`);

  const bestFor: CompareResponse['bestFor'] = [];
  const cheapest = uniqueBest(products, (p) => p.delivered, 'min');
  if (cheapest) bestFor.push({ label: 'Lowest price', productId: cheapest.item.id, detail: `${fmt(cheapest.value, cur)} estimated delivered, before tax` });
  const fastest = uniqueBest(products, (p) => (p.maxDays === null && p.minDays === null ? null : (p.maxDays ?? p.minDays!) * 100 + (p.minDays ?? p.maxDays!)), 'min');
  if (fastest) bestFor.push({ label: 'Fastest estimated delivery', productId: fastest.item.id, detail: `${windowLabel(fastest.item)} (an estimate, not a guarantee)` });
  const topRated = rated.length >= 2 ? uniqueBest(rated, (p) => p.rating.avg, 'max') : null;
  if (topRated) bestFor.push({ label: 'Highest rated', productId: topRated.item.id, detail: `${topRated.item.rating.avg.toFixed(1)} / 5 from ${topRated.item.rating.count} reviews` });

  return {
    country,
    currency: cur,
    products: products.map((p) => ({ id: p.id, slug: p.slug, title: p.title, image: p.image, price: p.price, deliveredEstimate: p.delivered, available: p.available })),
    rows: shown,
    keyDifferences,
    bestFor,
    note: 'Each “best for” compares a single measured attribute. It is not an overall recommendation. Estimated delivered price is the item price plus standard shipping for one item, before tax or duty.',
  };
}
