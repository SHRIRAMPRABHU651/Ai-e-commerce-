/**
 * Adapter: rank rescue alternatives with the TrustGraph Fair Deal engine instead of the local heuristic.
 * Alternatives are the SAME product from other suppliers (substitution is a separate, consent-gated option), so a single
 * synthetic product id is used and `allowSubstitution` stays false.
 */
import { rankOffersByFairValue } from '../trust/fairDeal';
import { LocalOfferRanker } from './ranker';
import type { OfferRanker, RankedAlt } from './ranker';

export const fairDealRanker: OfferRanker = {
  name: 'fair-deal-v1',
  rank(offers, input) {
    const local = LocalOfferRanker.rank(offers, input); // eligibility + explainable breakdown
    const eligible = local.filter((o) => o.eligible && o.landedCost > 0);
    if (!eligible.length) return local;
    const fair = rankOffersByFairValue(
      eligible.map((o) => ({
        offerId: o.supplierId, productId: 'same-product', supplierRef: o.supplierId, supplierDisplayName: o.supplierName, available: true,
        totalDeliveredPrice: o.landedCost, currency: 'ORDER', evidenceCompleteness: null,
        // reliability is the supplier's recorded 0-100 stat, not a TrustGraph snapshot: treat it as provisional
        supplierTrust: { score: o.reliability, status: 'provisional' as const, confidence: 0.5 },
        delivery: { minDays: o.minDays, maxDays: o.maxDays, confidence: 0.5, basis: 'promised_only' as const },
        returnWindowDays: null, warrantyMonths: null,
      })),
    );
    const byId = new Map(fair.ranked.map((r) => [r.offerId, r.fairValueScore]));
    const scored = local.map((o): RankedAlt => (byId.has(o.supplierId) ? { ...o, score: Math.round(byId.get(o.supplierId)!) } : o));
    return scored.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || a.landedCost - b.landedCost || a.supplierId.localeCompare(b.supplierId));
  },
};
