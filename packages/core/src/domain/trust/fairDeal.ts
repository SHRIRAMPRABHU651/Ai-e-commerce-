/**
 * Fair Deal Engine (pure). Ranks supplier OFFERS FOR THE SAME PRODUCT by overall value, not by price alone.
 *
 * Substitution rule: this function never swaps one product for another. Offers for a different product are
 * rejected with SubstitutionConsentError unless the caller passes `allowSubstitution: true`, which a caller
 * may do ONLY after the customer has explicitly consented; such offers are then flagged `substitute: true`.
 * Reused by delivery rescue and the shopping assistant. Deterministic code ranks; no LLM involved.
 */
import { FAIR_DEAL_DIMENSIONS } from '@orvia/types';
import type { FairDealDimension, FairDealDimensionScore, FairDealOfferInput, FairDealRanked, FairDealResult, FairDealWeights } from '@orvia/types';
import { clamp, round3 } from './stats';

export const DEFAULT_FAIR_DEAL_WEIGHTS: FairDealWeights = {
  price: 0.3,
  quality_evidence: 0.15,
  supplier_reliability: 0.25,
  delivery_confidence: 0.15,
  return_conditions: 0.1,
  warranty: 0.05,
};

/** Score given to a dimension whose data is missing: deliberately below neutral, so unknown never beats known-good. */
export const UNKNOWN_DIMENSION_SCORE = 0.4;

export class SubstitutionConsentError extends Error {
  constructor() {
    super('Offers are for different products. Ranking across products is a substitution and requires explicit customer consent (allowSubstitution).');
    this.name = 'SubstitutionConsentError';
  }
}

export interface FairDealOptions {
  /** Customer preference weights; any subset. Non-negative; normalised to sum to 1. */
  weights?: Partial<FairDealWeights>;
  /** The product the customer asked for (defaults to the first offer's product). */
  requestedProductId?: string;
  /** Set true only when the customer has consented to substitutes. */
  allowSubstitution?: boolean;
}

export function normaliseWeights(w?: Partial<FairDealWeights>): FairDealWeights {
  const merged = { ...DEFAULT_FAIR_DEAL_WEIGHTS };
  if (w) for (const d of FAIR_DEAL_DIMENSIONS) { const v = w[d]; if (typeof v === 'number' && Number.isFinite(v) && v >= 0) merged[d] = v; }
  const sum = FAIR_DEAL_DIMENSIONS.reduce((a, d) => a + merged[d], 0);
  if (sum <= 0) return { ...DEFAULT_FAIR_DEAL_WEIGHTS };
  return Object.fromEntries(FAIR_DEAL_DIMENSIONS.map((d) => [d, round3(merged[d] / sum)])) as FairDealWeights;
}

const money = (minor: number, currency: string) => `${(minor / 100).toFixed(2)} ${currency}`;

function scoreDimensions(o: FairDealOfferInput, cheapest: number, w: FairDealWeights): FairDealDimensionScore[] {
  const mk = (dimension: FairDealDimension, score: number, known: boolean, note: string): FairDealDimensionScore => ({ dimension, score: round3(clamp(score)), weight: w[dimension], contribution: round3(clamp(score) * w[dimension]), known, note });
  const out: FairDealDimensionScore[] = [];

  out.push(mk('price', cheapest / o.totalDeliveredPrice, true, o.totalDeliveredPrice === cheapest ? `Lowest total delivered price (${money(o.totalDeliveredPrice, o.currency)})` : `${money(o.totalDeliveredPrice, o.currency)} total delivered, ${Math.round(((o.totalDeliveredPrice - cheapest) / cheapest) * 100)}% above the cheapest`));

  out.push(o.evidenceCompleteness === null
    ? mk('quality_evidence', UNKNOWN_DIMENSION_SCORE, false, 'Product evidence not assessed')
    : mk('quality_evidence', o.evidenceCompleteness, true, `${Math.round(o.evidenceCompleteness * 100)}% of product facts evidenced`));

  const t = o.supplierTrust;
  if (!t || t.score === null || t.status === 'insufficient_data') out.push(mk('supplier_reliability', UNKNOWN_DIMENSION_SCORE, false, 'Not enough delivery history yet for this supplier'));
  else {
    const s = t.score / 100;
    const v = t.status === 'established' ? s : s * t.confidence + 0.5 * (1 - t.confidence);
    out.push(mk('supplier_reliability', v, true, `${t.status === 'established' ? 'Established' : 'Provisional'} reliability ${Math.round(t.score)}/100`));
  }

  if (!o.delivery) out.push(mk('delivery_confidence', UNKNOWN_DIMENSION_SCORE, false, 'No delivery estimate'));
  else {
    const speed = 1 - clamp((o.delivery.maxDays - 3) / 27);
    out.push(mk('delivery_confidence', speed * (0.5 + 0.5 * clamp(o.delivery.confidence)), true, `${o.delivery.minDays}-${o.delivery.maxDays} days (${o.delivery.basis === 'observed' ? 'observed history' : 'supplier estimate, unconfirmed'})`));
  }

  out.push(o.returnWindowDays === null
    ? mk('return_conditions', UNKNOWN_DIMENSION_SCORE, false, 'Return terms unknown')
    : mk('return_conditions', o.returnWindowDays / 30, true, `${o.returnWindowDays}-day return window`));

  out.push(o.warrantyMonths === null
    ? mk('warranty', UNKNOWN_DIMENSION_SCORE, false, 'No warranty terms on record')
    : mk('warranty', o.warrantyMonths / 12, true, `${o.warrantyMonths}-month warranty`));
  return out;
}

function summarise(d: FairDealDimensionScore[], isCheapest: boolean, rank: number): string {
  const strong = d.filter((x) => x.known && x.score >= 0.8 && x.weight >= 0.1).map((x) => x.dimension.replace(/_/g, ' '));
  const unknown = d.filter((x) => !x.known).map((x) => x.dimension.replace(/_/g, ' '));
  const parts = [`#${rank}${isCheapest ? ', cheapest' : ''}`];
  if (strong.length) parts.push(`strong on ${strong.join(', ')}`);
  if (unknown.length) parts.push(`unknown: ${unknown.join(', ')}`);
  return parts.join('; ');
}

export function rankOffersByFairValue(offers: FairDealOfferInput[], opts: FairDealOptions = {}): FairDealResult {
  const weights = normaliseWeights(opts.weights);
  const requested = opts.requestedProductId ?? offers[0]?.productId;
  const excluded: FairDealResult['excluded'] = [];
  const candidates: FairDealOfferInput[] = [];
  for (const o of offers) {
    if (o.productId !== requested && !opts.allowSubstitution) throw new SubstitutionConsentError();
    if (!o.available) { excluded.push({ offerId: o.offerId, reason: 'Not available' }); continue; }
    if (!(o.totalDeliveredPrice > 0)) { excluded.push({ offerId: o.offerId, reason: 'No valid price' }); continue; }
    candidates.push(o);
  }
  const currencies = new Set(candidates.map((c) => c.currency));
  if (currencies.size > 1) throw new Error('Offers must share one currency to be ranked');
  const cheapest = candidates.length ? Math.min(...candidates.map((c) => c.totalDeliveredPrice)) : 0;

  const scored = candidates.map((o) => {
    const dims = scoreDimensions(o, cheapest, weights);
    const fair = Math.round(dims.reduce((a, d) => a + d.contribution, 0) * 1000) / 10;
    return { o, dims, fair };
  });
  scored.sort((a, b) => b.fair - a.fair || a.o.totalDeliveredPrice - b.o.totalDeliveredPrice || a.o.offerId.localeCompare(b.o.offerId));

  const ranked: FairDealRanked[] = scored.map(({ o, dims, fair }, idx) => {
    const isCheapest = o.totalDeliveredPrice === cheapest;
    return {
      rank: idx + 1, offerId: o.offerId, supplierRef: o.supplierRef, supplierDisplayName: o.supplierDisplayName, totalDeliveredPrice: o.totalDeliveredPrice, currency: o.currency,
      fairValueScore: fair, isCheapest, substitute: o.productId !== requested, dimensions: dims, unknowns: dims.filter((d) => !d.known).map((d) => d.dimension), summary: summarise(dims, isCheapest, idx + 1),
    };
  });
  return { ranked, excluded, weights, note: 'Ranks offers for the same product by overall value. Missing information scores below neutral. A different product is a substitution and needs the customer\'s consent.' };
}

/** Customer-safe projection: drops internal supplier references and offer ids. */
export function fairDealForCustomer(r: FairDealResult): { ranked: Omit<FairDealRanked, 'supplierRef' | 'offerId'>[]; note: string } {
  return { ranked: r.ranked.map(({ supplierRef: _s, offerId: _o, ...rest }) => rest), note: r.note };
}
