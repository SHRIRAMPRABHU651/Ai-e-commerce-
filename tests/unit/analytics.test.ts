import { describe, expect, it } from 'vitest';
import {
  computePrice,
  contributionProfit,
  estimateDuties,
  landedCost,
  paymentFeeModelFor,
  productEconomics,
  rankSupplierOffers,
  recommendSupplier,
  scoreOpportunity,
  summarizeFinancials,
  computeTax,
  charmPrice,
} from '@orvia/analytics';
import type { RankableOffer } from '@orvia/analytics';
import { DEFAULT_COUNTRIES } from '@orvia/types';

describe('economics', () => {
  it('computes landed cost and contribution profit without confusing revenue and profit', () => {
    const landed = landedCost({ productCost: 520, shippingCost: 310, duties: 0, fulfillmentFee: 0 });
    expect(landed).toBe(830);
    const e = productEconomics({
      supplierCost: 520, shippingCost: 310, sellingPrice: 2999, paymentFee: paymentFeeModelFor('US'),
      refundRate: 0.05, cpc: 100, conversionRate: 0.02,
    });
    expect(e.landed_cost).toBe(830);
    expect(e.payment_fee).toBe(Math.round(2999 * 0.029 + 30));
    expect(e.estimated_ad_cost).toBe(5000); // $1.00 CPC / 2% CVR = $50? -> 100/0.02 = 5000 minor
    expect(e.expected_profit).toBeLessThan(e.selling_price);
    expect(e.break_even_ROAS).toBeGreaterThan(1);
    expect(e.ROAS).toBeCloseTo(2999 / 5000, 4);
    expect(contributionProfit({ sellingPrice: 1000, landedCost: 400, paymentFee: 59, expectedRefundCost: 50, adCost: 200 })).toBe(291);
  });

  it('only charges duties for cross-border shipments above de minimis', () => {
    const us = DEFAULT_COUNTRIES.US;
    expect(estimateDuties('US', us, 5000)).toBe(0);
    expect(estimateDuties('CN', us, 50000)).toBe(0); // under $800
    expect(estimateDuties('CN', us, 100000)).toBe(10000);
    expect(estimateDuties('CN', DEFAULT_COUNTRIES.IN, 100000)).toBe(20000);
  });

  it('handles inclusive (IN) and exclusive (US/CA) tax', () => {
    expect(computeTax(DEFAULT_COUNTRIES.IN, '', 11800)).toEqual({ tax: 1800, rate: 0.18 });
    expect(computeTax(DEFAULT_COUNTRIES.CA, 'ON', 10000).tax).toBe(1300);
    expect(computeTax(DEFAULT_COUNTRIES.US, 'OR', 10000).tax).toBe(0);
  });

  it('financial summary separates revenue from profit tiers', () => {
    const s = summarizeFinancials({ grossRevenue: 100000, discounts: 5000, refunds: 3000, supplierCost: 30000, shippingCost: 8000, duties: 0, paymentFees: 3000, adSpend: 20000 });
    expect(s.netRevenue).toBe(92000);
    expect(s.grossProfit).toBe(54000);
    expect(s.contributionProfit).toBe(31000);
    expect(s.contributionProfit).toBeLessThan(s.grossProfit);
    expect(s.grossProfit).toBeLessThan(s.netRevenue);
  });
});

const offer = (o: Partial<RankableOffer> & Pick<RankableOffer, 'supplierId'>): RankableOffer => ({
  supplierName: o.supplierId, warehouseCountry: 'US', productCost: 520, shippingCost: 310, minDays: 7, maxDays: 10, stock: 1200, rating: 4.5,
  reliability: 94, returnPolicyDays: 30, trackingAvailable: true, ...o,
});

describe('supplier ranking', () => {
  const ctx = { sellingPrice: 2999, quantity: 1, country: DEFAULT_COUNTRIES.US, paymentFee: paymentFeeModelFor('US'), baseRefundRate: 0.04, adCostPerOrder: 800, minMargin: 0.15 };

  it('does not simply pick the cheapest product — reliability + delivery + profit win (spec example)', () => {
    const ranked = rankSupplierOffers(
      [
        offer({ supplierId: 'A', productCost: 520, shippingCost: 310, minDays: 7, maxDays: 10, stock: 1200, reliability: 94 }),
        offer({ supplierId: 'B', productCost: 480, shippingCost: 790, minDays: 12, maxDays: 18, stock: 400, reliability: 79, rating: 4.0, returnPolicyDays: 14 }),
        offer({ supplierId: 'C', productCost: 620, shippingCost: 200, minDays: 4, maxDays: 7, stock: 800, reliability: 97, rating: 4.8 }),
      ],
      ctx,
    );
    const { best, reason } = recommendSupplier(ranked);
    expect(best?.supplierId).toBe('C');
    expect(reason).toMatch(/fastest delivery|reliability|profit/);
    const cheapestProduct = [...ranked].sort((a, b) => a.productCost - b.productCost)[0]!;
    expect(cheapestProduct.supplierId).toBe('B');
    expect(ranked[0]!.supplierId).not.toBe(cheapestProduct.supplierId);
  });

  it('excludes suppliers with insufficient stock or margin below minimum', () => {
    const ranked = rankSupplierOffers(
      [offer({ supplierId: 'low', stock: 0 }), offer({ supplierId: 'thin', productCost: 2500, shippingCost: 400 }), offer({ supplierId: 'ok' })],
      ctx,
    );
    expect(ranked[0]!.supplierId).toBe('ok');
    expect(ranked.find((r) => r.supplierId === 'low')!.eligible).toBe(false);
    expect(ranked.find((r) => r.supplierId === 'thin')!.ineligibleReason).toBe('Below minimum margin');
    expect(recommendSupplier(rankSupplierOffers([offer({ supplierId: 'x', stock: 0 })], ctx)).best).toBeNull();
  });

  it('adds duties for cross-border offers', () => {
    const [r] = rankSupplierOffers([offer({ supplierId: 'cn', warehouseCountry: 'CN', productCost: 50000, shippingCost: 55000 })], { ...ctx, sellingPrice: 200000 });
    expect(r!.duties).toBe(Math.round(105000 * 0.1));
  });
});

describe('pricing engine', () => {
  const base = {
    currency: 'USD' as const, landedCost: 900, paymentFee: paymentFeeModelFor('US'), refundRate: 0.05, adCostPerOrder: 700,
    guardrails: { minMarginPct: 0.2, maxDiscountPct: 0.15, minSellingPrice: 999, targetProfitPerOrder: 0 },
  };

  it('prices competitor-based at a charm price near the spec example ($29.99)', () => {
    const r = computePrice({ ...base, strategy: 'competitor_based', competitorPrices: [2900, 3100, 3500] });
    expect(r.price).toBe(2999);
    expect(r.contributionMargin).toBeGreaterThan(0.2);
  });

  it('never goes below the minimum margin floor, even when competitors are cheaper', () => {
    const r = computePrice({ ...base, strategy: 'competitor_based', competitorPrices: [1000, 1100, 1200] });
    expect(r.contributionMargin).toBeGreaterThanOrEqual(0.2 - 1e-9);
    expect(r.price).toBeGreaterThanOrEqual(r.floorPrice);
    expect(r.adjustments.join(' ')).toMatch(/floor/);
  });

  it('respects max discount vs current price', () => {
    const r = computePrice({ ...base, strategy: 'competitor_based', competitorPrices: [2000, 2100, 2200], currentPrice: 3999 });
    expect(r.price).toBeGreaterThanOrEqual(Math.round(3999 * 0.85));
  });

  it('supports all strategies and returns finite prices', () => {
    for (const strategy of ['cost_plus', 'target_margin', 'competitor_based', 'dynamic_demand', 'ai_optimized'] as const) {
      const r = computePrice({ ...base, strategy, competitorPrices: [2900, 3100, 3500], demandIndex: 0.8, conversionRate: 0.02, cpc: 60 });
      expect(Number.isFinite(r.price)).toBe(true);
      expect(r.price % 100).toBe(99);
      expect(r.contributionMargin).toBeGreaterThanOrEqual(0.2 - 1e-9);
    }
  });

  it('ai_optimized maximises expected profit and honours an AI suggestion only inside guardrails', () => {
    const r = computePrice({ ...base, strategy: 'ai_optimized', competitorPrices: [2900, 3100, 3500], conversionRate: 0.02, cpc: 60, aiSuggestedPrice: 100 });
    expect(r.price).toBeGreaterThan(r.floorPrice - 1);
  });

  it('charm pricing for INR ends in 9 rupees and never rounds below the floor', () => {
    expect(charmPrice(124500, 'INR') % 1000).toBe(900);
    expect(charmPrice(1234, 'USD', 1300)).toBeGreaterThanOrEqual(1300);
  });
});

describe('opportunity scoring', () => {
  const c = { demand: 92, trendVelocity: 88, competition: 61, supplierCost: 91, shipping: 94, profitMargin: 87, videoPotential: 95, repeatPurchase: 62, supplierReliability: 89, compliance: 97 };
  it('scores the spec example as TEST', () => {
    const s = scoreOpportunity(c);
    expect(s.finalScore).toBeGreaterThan(85);
    expect(s.action).toBe('TEST');
  });
  it('hard-rejects low compliance regardless of other scores', () => {
    expect(scoreOpportunity({ ...c, compliance: 30 }).action).toBe('REJECT');
  });
  it('downgrades TEST to WATCH when margin is too thin', () => {
    expect(scoreOpportunity({ ...c, profitMargin: 20 }).action).not.toBe('TEST');
  });
});
