import { clamp, calcPaymentFee, contributionProfit } from './economics';
import type { PaymentFeeModel } from './economics';

export const PRICING_STRATEGIES = [
  'cost_plus',
  'target_margin',
  'competitor_based',
  'dynamic_demand',
  'ai_optimized',
] as const;
export type PricingStrategy = (typeof PRICING_STRATEGIES)[number];

export interface PricingGuardrails {
  minMarginPct: number; // fraction e.g. 0.2
  maxDiscountPct: number; // max single-step drop vs current price, fraction
  minSellingPrice: number; // minor units
  targetProfitPerOrder: number; // minor units
  targetRoas?: number;
}

export interface PricingInput {
  strategy: PricingStrategy;
  currency: 'USD' | 'CAD' | 'INR';
  landedCost: number;
  paymentFee: PaymentFeeModel;
  refundRate: number;
  adCostPerOrder: number;
  otherVariable?: number;
  competitorPrices?: number[];
  /** 0..1 */
  demandIndex?: number;
  conversionRate?: number;
  cpc?: number;
  trendScore?: number;
  currentPrice?: number;
  targetMarginPct?: number;
  markup?: number;
  aiSuggestedPrice?: number;
  promotionDiscountPct?: number;
  guardrails: PricingGuardrails;
}

export interface PricingResult {
  price: number;
  strategy: PricingStrategy;
  contributionProfit: number;
  contributionMargin: number;
  floorPrice: number;
  ceilingPrice: number | null;
  adjustments: string[];
  explanation: string;
}

/** Price that yields `margin` contribution margin given price-proportional and fixed costs. */
export function priceForMargin(i: PricingInput, margin: number): number {
  const fixed = i.landedCost + i.paymentFee.fixed + i.adCostPerOrder + (i.otherVariable ?? 0);
  const variablePct = i.paymentFee.pct + i.refundRate + margin;
  if (variablePct >= 1) return Number.POSITIVE_INFINITY;
  return fixed / (1 - variablePct);
}

export function priceForProfit(i: PricingInput, profit: number): number {
  const fixed = i.landedCost + i.paymentFee.fixed + i.adCostPerOrder + (i.otherVariable ?? 0) + profit;
  const variablePct = i.paymentFee.pct + i.refundRate;
  return fixed / (1 - variablePct);
}

export function evaluatePrice(i: PricingInput, price: number): { profit: number; margin: number } {
  const profit = contributionProfit({
    sellingPrice: price,
    landedCost: i.landedCost,
    paymentFee: calcPaymentFee(price, i.paymentFee),
    expectedRefundCost: Math.round(price * i.refundRate),
    adCost: i.adCostPerOrder,
    otherVariable: i.otherVariable,
  });
  return { profit, margin: price > 0 ? profit / price : 0 };
}

/** Psychological rounding that never rounds below the floor. USD/CAD -> x.99, INR -> ...9 rupees. */
export function charmPrice(minor: number, currency: 'USD' | 'CAD' | 'INR', floor = 0): number {
  const ceil = (n: number) => Math.ceil(n);
  let p: number;
  if (currency === 'INR') {
    const rupees = Math.round(minor / 100);
    let r = rupees - (rupees % 10) + 9;
    if (r < rupees - 5) r += 10;
    p = r * 100;
  } else {
    const dollars = Math.floor(minor / 100);
    p = dollars * 100 + 99;
    if (p < minor - 50) p += 100;
  }
  while (p < floor) p += currency === 'INR' ? 1000 : 100;
  return ceil(p);
}

function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return Math.round(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo));
}

export function computePrice(i: PricingInput): PricingResult {
  const g = i.guardrails;
  const adjustments: string[] = [];
  const comps = [...(i.competitorPrices ?? [])].filter((n) => n > 0).sort((a, b) => a - b);
  const targetMargin = i.targetMarginPct ?? Math.max(g.minMarginPct + 0.1, 0.35);

  const floorByMargin = priceForMargin(i, g.minMarginPct);
  const floorByProfit = g.targetProfitPerOrder > 0 ? priceForProfit(i, g.targetProfitPerOrder) : 0;
  const floorRaw = Math.max(floorByMargin, floorByProfit, g.minSellingPrice, i.landedCost);
  const floor = Number.isFinite(floorRaw) ? Math.ceil(floorRaw) : Number.MAX_SAFE_INTEGER;
  const ceiling = comps.length ? Math.round(comps[comps.length - 1]! * 1.05) : null;

  let raw: number;
  let strategyNote = '';
  switch (i.strategy) {
    case 'cost_plus':
      raw = i.landedCost * (i.markup ?? 3);
      strategyNote = `cost-plus ×${i.markup ?? 3}`;
      break;
    case 'target_margin':
      raw = priceForMargin(i, targetMargin);
      strategyNote = `target margin ${(targetMargin * 100).toFixed(0)}%`;
      break;
    case 'competitor_based':
      if (comps.length) {
        raw = percentile(comps, 0.25) * 0.99;
        strategyNote = `just under competitor 25th percentile (${comps.length} competitors)`;
      } else {
        raw = priceForMargin(i, targetMargin);
        strategyNote = 'no competitor data, fell back to target margin';
      }
      break;
    case 'dynamic_demand': {
      const base = priceForMargin(i, targetMargin);
      const demand = clamp(i.demandIndex ?? 0.5, 0, 1);
      let factor = 1 + (demand - 0.5) * 0.3;
      if (i.conversionRate !== undefined && i.conversionRate < 0.012) factor -= 0.05;
      raw = base * factor;
      strategyNote = `demand index ${demand.toFixed(2)} → ×${factor.toFixed(3)}`;
      break;
    }
    case 'ai_optimized': {
      // Maximise expected profit per click under an explicit price-elasticity model.
      const refPrice = comps.length ? percentile(comps, 0.5) : (i.currentPrice ?? priceForMargin(i, targetMargin));
      const baseCvr = i.conversionRate && i.conversionRate > 0 ? i.conversionRate : 0.02;
      const cpc = i.cpc ?? Math.max(1, i.adCostPerOrder * baseCvr);
      const elasticity = 1.6;
      const lo = Math.max(floor, 1);
      const hi = Math.max(lo, ceiling ?? Math.round(Math.max(refPrice * 1.15, lo * 1.5)));
      const candidates = new Set<number>();
      const steps = 60;
      for (let s = 0; s <= steps; s++) candidates.add(Math.round(lo + ((hi - lo) * s) / steps));
      if (i.aiSuggestedPrice && i.aiSuggestedPrice >= lo && i.aiSuggestedPrice <= hi) candidates.add(i.aiSuggestedPrice);
      let best = lo;
      let bestVal = -Infinity;
      for (const p of candidates) {
        const cvr = clamp(baseCvr * Math.pow(refPrice / p, elasticity), 0.0005, 0.25);
        const perOrderNoAd = evaluatePrice({ ...i, adCostPerOrder: 0 }, p).profit;
        const perClick = cvr * perOrderNoAd - cpc;
        if (perClick > bestVal) {
          bestVal = perClick;
          best = p;
        }
      }
      raw = best;
      strategyNote = 'maximised expected profit per click under a price-elasticity model';
      break;
    }
  }

  let price = raw;
  if (i.promotionDiscountPct) {
    price = price * (1 - clamp(i.promotionDiscountPct, 0, 0.9));
    adjustments.push(`promotion −${(i.promotionDiscountPct * 100).toFixed(0)}%`);
  }
  if (ceiling !== null && price > ceiling && i.strategy !== 'cost_plus') {
    price = ceiling;
    adjustments.push('capped near top competitor price');
  }
  if (i.currentPrice && i.currentPrice > 0) {
    const maxDrop = Math.round(i.currentPrice * (1 - g.maxDiscountPct));
    if (price < maxDrop) {
      price = maxDrop;
      adjustments.push(`limited by max discount ${(g.maxDiscountPct * 100).toFixed(0)}%`);
    }
  }
  if (price < floor) {
    price = floor;
    adjustments.push('raised to margin / minimum-price floor');
  }
  let final = charmPrice(price, i.currency, floor);
  if (!Number.isFinite(final) || final >= Number.MAX_SAFE_INTEGER / 2) final = floor;
  const ev = evaluatePrice(i, final);
  return {
    price: final,
    strategy: i.strategy,
    contributionProfit: ev.profit,
    contributionMargin: ev.margin,
    floorPrice: floor,
    ceilingPrice: ceiling,
    adjustments,
    explanation:
      `${strategyNote}; ${adjustments.length ? adjustments.join('; ') + '; ' : ''}` +
      `expected contribution margin ${(ev.margin * 100).toFixed(1)}%`,
  };
}
