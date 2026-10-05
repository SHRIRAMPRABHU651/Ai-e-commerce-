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
  profitWeight?: number; // default 0.6
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
  const pw = ctx.profitWeight ?? 0.6;
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
      finalScore: Math.round((profitScore * pw + cx * (1 - pw)) * 10) / 10,
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
