/**
 * ORVIA Find: "equivalent products" logic for (a) the better-verified-offer notice and (b) alternatives for unavailable
 * products. PURE. Equivalence is deliberately strict and explained; we never claim two products are "the same" beyond
 * the attributes we actually hold for both.
 */
import { MIN_RATING_COUNT, deliveredEstimate } from './ranking';
import type { FindCandidate, ShippingFee } from './ranking';
import { stem } from './intent';

/** Attributes that define "the same kind of product" when both listings state them. */
export const KEY_ATTRIBUTES = ['material', 'size', 'capacity', 'color', 'colour', 'type', 'age_range', 'pack_size', 'quantity'] as const;

const tokenSet = (s: string): Set<string> => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length > 2).map(stem));
export function titleSimilarity(a: string, b: string): number {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();

/** Shared key attributes and whether any of them conflicts. */
export function compareKeyAttributes(a: FindCandidate, b: FindCandidate): { shared: string[]; conflicts: string[] } {
  const shared: string[] = [];
  const conflicts: string[] = [];
  for (const k of KEY_ATTRIBUTES) {
    const va = norm(a.attributes[k]);
    const vb = norm(b.attributes[k]);
    if (!va || !vb) continue;
    (va === vb ? shared : conflicts).push(k);
  }
  return { shared, conflicts };
}

export interface BetterOffer {
  cand: FindCandidate;
  delivered: number;
  saving: number;
  savingPct: number;
  reasons: string[];
}

/**
 * Another sellable product is a "better verified offer" only if ALL hold: same category and top category, no conflicting
 * key attribute (and either a shared key attribute or title similarity >= 0.45), in stock, comparable ratings backed by
 * at least MIN_RATING_COUNT reviews on both sides, and a lower estimated delivered price by at least `minSavingPct`.
 */
export function findBetterOffers(base: FindCandidate, others: FindCandidate[], ship: ShippingFee | null, o: { minSavingPct?: number; ratingTolerance?: number; limit?: number } = {}): BetterOffer[] {
  const minSaving = o.minSavingPct ?? 5;
  const tol = o.ratingTolerance ?? 0.3;
  if (base.rating.count < MIN_RATING_COUNT) return []; // cannot assert comparable ratings
  const baseDelivered = deliveredEstimate(base.price, ship);
  const out: BetterOffer[] = [];
  for (const c of others) {
    if (c.id === base.id || c.stock <= 0 || c.price <= 0) continue;
    if (c.category !== base.category || c.topCategory !== base.topCategory) continue;
    const { shared, conflicts } = compareKeyAttributes(base, c);
    if (conflicts.length) continue;
    const sim = titleSimilarity(base.title, c.title);
    if (!shared.length && sim < 0.45) continue;
    if (c.rating.count < MIN_RATING_COUNT || c.rating.avg < base.rating.avg - tol) continue;
    const d = deliveredEstimate(c.price, ship);
    const saving = baseDelivered - d;
    const pct = (saving / baseDelivered) * 100;
    if (saving <= 0 || pct < minSaving) continue;
    out.push({
      cand: c,
      delivered: d,
      saving,
      savingPct: Math.round(pct * 10) / 10,
      reasons: [
        `Same category (${c.category.replace(/-/g, ' ')})`,
        ...(shared.length ? [`Same ${shared.join(', ')}`] : [`Similar listing title`]),
        `Rated ${c.rating.avg.toFixed(1)} from ${c.rating.count} reviews (yours: ${base.rating.avg.toFixed(1)} from ${base.rating.count})`,
      ],
    });
  }
  return out.sort((a, b) => b.saving - a.saving).slice(0, o.limit ?? 3);
}

export interface Alternative {
  cand: FindCandidate;
  delivered: number;
  score: number;
  reasons: string[];
}

/** Alternatives for an out-of-stock / unavailable product: same top category required, same sub-category and attributes preferred. */
export function rankAlternatives(base: FindCandidate, others: FindCandidate[], ship: ShippingFee | null, limit = 6): Alternative[] {
  const out: Alternative[] = [];
  for (const c of others) {
    if (c.id === base.id || c.stock <= 0 || c.price <= 0 || c.topCategory !== base.topCategory) continue;
    const reasons: string[] = [];
    let score = 0;
    if (c.category === base.category) { score += 10; reasons.push(`Same category (${c.category.replace(/-/g, ' ')})`); }
    else reasons.push(`Same range (${c.topCategory})`);
    const { shared, conflicts } = compareKeyAttributes(base, c);
    if (shared.length) { score += shared.length * 3; reasons.push(`Same ${shared.join(', ')}`); }
    score -= conflicts.length * 2;
    const sim = titleSimilarity(base.title, c.title);
    if (sim > 0.15) { score += sim * 8; reasons.push('Similar listing'); }
    if (base.price > 0) {
      const rel = Math.abs(c.price - base.price) / base.price;
      if (rel <= 0.25) { score += 4 * (1 - rel / 0.25); reasons.push('Within 25% of the price'); }
    }
    if (c.rating.count >= MIN_RATING_COUNT) score += Math.max(0, c.rating.avg - 3) * 0.8;
    if (c.category !== base.category && !shared.length && sim <= 0.15) continue; // too loosely related to suggest
    out.push({ cand: c, delivered: deliveredEstimate(c.price, ship), score, reasons });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
