import { clamp, calcPaymentFee, contributionProfit, estimateDuties, landedCost } from './economics';
import type { PaymentFeeModel } from './economics';
import type { CountryConfig } from '@orvia/types';

export interface RankableOffer {
  supplierId: string;
  supplierName: string;
  warehouseCountry: string;
  /** all money in the destination market currency, minor units */
  productCost: number;
  shippingCost: number;
  fulfillmentFee?: number;
  minDays: number;
  maxDays: number;
  stock: number;
  rating: number; // 0-5
  reliability: number; // 0-100
  returnPolicyDays: number;
  trackingAvailable: boolean;
  available?: boolean;
  /** Historical share of this supplier's orders that failed (0-1). */
  failureRate?: number;
  /** Typical API/response latency in ms (optional). */
  responseMs?: number;
  /** Age of the price/stock data in ms (live quotes are ~0). */
  freshnessMs?: number;
}

/** Configurable weights (normalised to sum 1). Profit and customer-experience factors are all explicit. */
export interface RankWeights {
  profit: number;
  delivery: number;
  reliability: number;
  stockConfidence: number;
  tracking: number;
  returns: number;
  destinationFit: number;
  risk: number;
}
export const DEFAULT_RANK_WEIGHTS: RankWeights = { profit: 0.45, delivery: 0.15, reliability: 0.12, stockConfidence: 0.07, tracking: 0.04, returns: 0.04, destinationFit: 0.09, risk: 0.04 };
export function normaliseWeights(w?: Partial<RankWeights>): RankWeights {
  const m = { ...DEFAULT_RANK_WEIGHTS, ...(w ?? {}) };
  const sum = Object.values(m).reduce((a, b) => a + Math.max(0, b), 0) || 1;
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Math.max(0, v) / sum])) as unknown as RankWeights;
}

/** Warehouse in the customer's country is best; neighbours next; overseas lowest. */
export function destinationFit(warehouse: string, destination: string): number {
  if (warehouse === destination) return 100;
  const near = [['US', 'CA'], ['CA', 'US']];
  if (near.some(([a, b]) => a === warehouse && b === destination)) return 70;
  return 40;
}

export interface RankContext {
  sellingPrice: number;
  quantity: number;
  country: Pick<CountryConfig, 'code' | 'duty'>;
  paymentFee: PaymentFeeModel;
  baseRefundRate: number;
  adCostPerOrder: number;
  otherVariable?: number;
  /** Minimum acceptable contribution margin (fraction). Offers below are ineligible. */
  minMargin: number;
  /** @deprecated use weights. Kept so older callers keep the profit/experience blend. */
  profitWeight?: number;
  weights?: Partial<RankWeights>;
  /** Stock/price data older than this is treated as unreliable (default 6h). */
  staleAfterMs?: number;
}

export interface RankedOffer extends RankableOffer {
  duties: number;
  landedCost: number;
  paymentFeeAmount: number;
  refundRate: number;
  expectedRefundCost: number;
  expectedProfit: number;
  margin: number;
  cxScore: number;
  profitScore: number;
  /** 0-100 per factor, so admins can see exactly why a supplier won. */
  breakdown: Record<keyof RankWeights, number>;
  stale: boolean;
  finalScore: number;
  eligible: boolean;
  ineligibleReason?: string;
}

/** Per-supplier refund likelihood: base rate, worse with low reliability and slow delivery. */
export function supplierRefundRate(base: number, reliability: number, maxDays: number): number {
  return clamp(base + ((100 - reliability) / 100) * 0.08 + Math.max(0, maxDays - 10) * 0.002, 0, 0.6);
}

export function customerExperienceScore(o: RankableOffer): number {
  const delivery = clamp(100 - ((o.maxDays - 5) / 20) * 100, 0, 100);
  const ret = clamp((o.returnPolicyDays / 30) * 100, 0, 100);
  return Math.round(
    delivery * 0.35 + o.reliability * 0.35 + o.rating * 20 * 0.15 + ret * 0.1 + (o.trackingAvailable ? 100 : 0) * 0.05,
  );
}

export function rankSupplierOffers(offers: RankableOffer[], ctx: RankContext): RankedOffer[] {
  const w = normaliseWeights(ctx.weights ?? (ctx.profitWeight !== undefined ? { profit: ctx.profitWeight, delivery: (1 - ctx.profitWeight) * 0.35, reliability: (1 - ctx.profitWeight) * 0.35, returns: (1 - ctx.profitWeight) * 0.1, tracking: (1 - ctx.profitWeight) * 0.05, stockConfidence: 0, destinationFit: 0, risk: (1 - ctx.profitWeight) * 0.15 } : undefined));
  const staleAfter = ctx.staleAfterMs ?? 6 * 3_600_000;
  const ranked = offers.map((o): RankedOffer => {
    const declared = (o.productCost + o.shippingCost) * ctx.quantity;
    const duties = estimateDuties(o.warehouseCountry, ctx.country, declared);
    const landed = landedCost({
      productCost: o.productCost * ctx.quantity,
      shippingCost: o.shippingCost,
      duties,
      fulfillmentFee: o.fulfillmentFee,
    });
    const revenue = ctx.sellingPrice * ctx.quantity;
    const fee = calcPaymentFee(revenue, ctx.paymentFee);
    const rr = supplierRefundRate(ctx.baseRefundRate, o.reliability, o.maxDays);
    const refundCost = Math.round(revenue * rr);
    const profit = contributionProfit({
      sellingPrice: revenue,
      landedCost: landed,
      paymentFee: fee,
      expectedRefundCost: refundCost,
      adCost: ctx.adCostPerOrder,
      otherVariable: ctx.otherVariable,
    });
    const margin = revenue > 0 ? profit / revenue : 0;
    const cx = customerExperienceScore(o);
    const profitScore = clamp((margin / 0.5) * 100, 0, 100);
    const stale = (o.freshnessMs ?? 0) > staleAfter;
    const freshness = stale ? 0.3 : 1 - Math.min(0.5, (o.freshnessMs ?? 0) / staleAfter / 2);
    const breakdown: Record<keyof RankWeights, number> = {
      profit: Math.round(profitScore),
      delivery: Math.round(clamp(100 - ((o.maxDays - 5) / 20) * 100, 0, 100)),
      reliability: Math.round(o.reliability),
      stockConfidence: Math.round(clamp(Math.min(100, (o.stock / Math.max(1, ctx.quantity)) * 20) * freshness, 0, 100)),
      tracking: o.trackingAvailable ? 100 : 0,
      returns: Math.round(clamp((o.returnPolicyDays / 30) * 100, 0, 100)),
      destinationFit: destinationFit(o.warehouseCountry, ctx.country.code),
      risk: Math.round(clamp(100 - (o.failureRate ?? 0) * 200 - Math.min(20, (o.responseMs ?? 0) / 500), 0, 100)),
    };
    const finalScore = (Object.keys(w) as (keyof RankWeights)[]).reduce((a, k) => a + w[k] * breakdown[k], 0);
    let ineligibleReason: string | undefined;
    if (o.available === false) ineligibleReason = 'Supplier unavailable';
    else if (o.stock < ctx.quantity) ineligibleReason = 'Insufficient stock';
    else if (margin < ctx.minMargin) ineligibleReason = 'Below minimum margin';
    return {
      ...o,
      duties,
      landedCost: landed,
      paymentFeeAmount: fee,
      refundRate: rr,
      expectedRefundCost: refundCost,
      expectedProfit: profit,
      margin,
      cxScore: cx,
      profitScore: Math.round(profitScore),
      breakdown,
      stale,
      finalScore: Math.round(finalScore * 10) / 10,
      eligible: !ineligibleReason,
      ineligibleReason,
    };
  });
  return ranked.sort(
    (a, b) =>
      Number(b.eligible) - Number(a.eligible) ||
      b.finalScore - a.finalScore ||
      b.expectedProfit - a.expectedProfit,
  );
}

export function recommendSupplier(ranked: RankedOffer[]): { best: RankedOffer | null; reason: string } {
  const best = ranked.find((r) => r.eligible) ?? null;
  if (!best) return { best: null, reason: 'No eligible supplier: ' + [...new Set(ranked.map((r) => r.ineligibleReason))].join(', ') };
  const parts: string[] = [];
  const eligible = ranked.filter((r) => r.eligible);
  const fastest = Math.min(...eligible.map((r) => r.maxDays));
  const mostReliable = Math.max(...eligible.map((r) => r.reliability));
  const topProfit = Math.max(...eligible.map((r) => r.expectedProfit));
  if (best.maxDays === fastest) parts.push('fastest delivery');
  if (best.reliability === mostReliable) parts.push('highest reliability');
  if (best.expectedProfit === topProfit) parts.push('highest contribution profit');
  const reason = parts.length
    ? `Best combination of ${parts.join(', ')}.`
    : 'Best balance of delivery time, reliability and contribution profit.';
  return { best, reason };
}
