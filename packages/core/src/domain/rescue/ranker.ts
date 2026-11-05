/**
 * Offer ranking for rescue alternatives. Pure. The interface exists so the Fair Deal ranking (trust workstream)
 * can be swapped in at merge time with `setOfferRanker()`; the default ranks locally and deterministically.
 */
export interface AltOffer {
  supplierId: string;
  supplierName: string;
  supplierCode: string;
  externalId: string;
  sku?: string;
  /** Whole-line landed cost in order-currency minor units (product x qty + shipping + duties). */
  landedCost: number;
  minDays: number;
  maxDays: number;
  stock: number;
  available: boolean;
  reliability: number; // 0-100
  rating: number; // 0-5
  trackingAvailable: boolean;
}

export interface RankInput {
  quantity: number;
  /** Cost of the original plan (for the price component). */
  originalCost: number;
}

export interface RankedAlt extends AltOffer {
  score: number;
  /** Per-factor 0-100, shown to staff so the ranking is explainable. */
  breakdown: { price: number; delivery: number; reliability: number; stock: number; tracking: number };
  eligible: boolean;
  ineligibleReason?: string;
}

export interface OfferRanker {
  readonly name: string;
  rank(offers: AltOffer[], input: RankInput): RankedAlt[];
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

export const LocalOfferRanker: OfferRanker = {
  name: 'local-v1',
  rank(offers, input) {
    const w = { price: 0.3, delivery: 0.3, reliability: 0.25, stock: 0.1, tracking: 0.05 };
    const positive = offers.map((o) => o.landedCost).filter((n) => n > 0);
    const base = Math.max(1, input.originalCost || (positive.length ? Math.min(...positive) : 1));
    const ranked = offers.map((o): RankedAlt => {
      const eligible = o.available && o.stock >= input.quantity;
      const reason = !o.available ? 'supplier reports the product unavailable' : o.stock < input.quantity ? `only ${o.stock} in stock, need ${input.quantity}` : undefined;
      const price = clamp(100 - ((o.landedCost - base) / base) * 100);
      const delivery = clamp(100 - ((o.maxDays - 5) / 25) * 100);
      const stock = clamp((o.stock / Math.max(1, input.quantity * 5)) * 100);
      const breakdown = { price: Math.round(price), delivery: Math.round(delivery), reliability: Math.round(o.reliability), stock: Math.round(stock), tracking: o.trackingAvailable ? 100 : 0 };
      const score = Math.round(breakdown.price * w.price + breakdown.delivery * w.delivery + breakdown.reliability * w.reliability + breakdown.stock * w.stock + breakdown.tracking * w.tracking);
      return { ...o, score, breakdown, eligible, ineligibleReason: reason };
    });
    // deterministic: eligible first, then score desc, then cheaper, then supplierId
    return ranked.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || a.landedCost - b.landedCost || a.supplierId.localeCompare(b.supplierId));
  },
};

let active: OfferRanker = LocalOfferRanker;
export const getOfferRanker = (): OfferRanker => active;
export function setOfferRanker(r: OfferRanker): void {
  active = r;
}
