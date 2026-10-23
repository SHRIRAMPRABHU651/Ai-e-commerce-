import { describe, expect, it } from 'vitest';
import { breakEvenCacPct, evaluateCacScenarios, rankSupplierOffers } from '@orvia/analytics';
import { provisionalMarkup } from '@orvia/core';

const fractions = { optimistic: 0.15, expected: 0.26, pessimistic: 0.4 };
const fee = { pct: 0.029, fixed: 30 };
const base = { sellingPrice: 10_000, landedCost: 4_500, paymentFee: fee, refundRate: 0.05 };

describe('CAC scenario band', () => {
  it('evaluates three CAC levels as fractions of price', () => {
    const s = evaluateCacScenarios(base, fractions);
    expect([s.optimistic.cac, s.expected.cac, s.pessimistic.cac]).toEqual([1500, 2600, 4000]);
    // pre-CAC contribution = 10000 - 4500 - 320 - 500 = 4680
    expect(s.optimistic.profit).toBe(4680 - 1500);
    expect(s.expected.profit).toBe(4680 - 2600);
    expect(s.pessimistic.profit).toBe(4680 - 4000);
    expect(s.optimistic.margin).toBeGreaterThan(s.expected.margin);
    expect(s.expected.margin).toBeGreaterThan(s.pessimistic.margin);
  });

  it('a product can pass at 15% CAC and fail at 40% — the band shows both', () => {
    const s = evaluateCacScenarios(base, fractions);
    expect(s.optimistic.margin).toBeGreaterThanOrEqual(0.2);
    expect(s.expected.margin).toBeGreaterThanOrEqual(0.2);
    expect(s.pessimistic.margin).toBeLessThan(0.2);
  });

  it('a measured CAC becomes the expected case and the band widens to include it', () => {
    const s = evaluateCacScenarios(base, fractions, 5_000); // measured 50% of price: worse than the pessimistic assumption
    expect(s.expected.cac).toBe(5_000);
    expect(s.pessimistic.cac).toBe(5_000);
    expect(s.optimistic.cac).toBe(1_500);
    const low = evaluateCacScenarios(base, fractions, 1_000);
    expect(low.expected.cac).toBe(1_000);
    expect(low.optimistic.cac).toBe(1_000);
    expect(low.pessimistic.cac).toBe(4_000);
  });

  it('break-even CAC equals pre-CAC margin minus the minimum margin', () => {
    expect(breakEvenCacPct(base, 0.2)).toBeCloseTo(0.468 - 0.2, 4);
    // the documented 45/4/5 structure leaves ~46% to pay for CAC and margin: 0.46 - 0.2 = 0.26
    expect(breakEvenCacPct({ sellingPrice: 100_000, landedCost: 45_000, paymentFee: { pct: 0.04, fixed: 0 }, refundRate: 0.05 }, 0.2)).toBeCloseTo(0.26, 6);
  });
});

describe('provisional markup is derived, not invented', () => {
  it('equals 1 ÷ (1 − margin − ads − payment − refunds) and is bounded', () => {
    expect(provisionalMarkup({ targetMarginPct: 0.4, assumedAdCostPct: 0.2, paymentPct: 0.029, baseRefundRate: 0.05 })).toBeCloseTo(1 / 0.321, 6);
    expect(provisionalMarkup({ targetMarginPct: 0.8, assumedAdCostPct: 0.2, paymentPct: 0.03, baseRefundRate: 0.05 })).toBe(10);
  });
});

describe('measured refund rate overrides the estimate and is labelled', () => {
  const offer = { supplierId: 's1', supplierName: 'S', warehouseCountry: 'US', productCost: 2000, shippingCost: 500, minDays: 3, maxDays: 7, stock: 10, rating: 4, reliability: 90, returnPolicyDays: 30, trackingAvailable: true };
  const ctx = { sellingPrice: 10_000, quantity: 1, country: { code: 'US', duty: { deMinimis: 80_000, rate: 0 } } as never, paymentFee: fee, baseRefundRate: 0.05, adCostPerOrder: 2000, minMargin: 0 };
  it('uses estimated by default', () => {
    const [r] = rankSupplierOffers([offer], ctx);
    expect(r!.refundSource).toBe('estimated');
    expect(r!.refundSampleSize).toBe(0);
  });
  it('uses the measured rate when orders back it', () => {
    const [r] = rankSupplierOffers([{ ...offer, measuredRefundRate: 0.17, measuredRefundSample: 25 }], ctx);
    expect(r!.refundSource).toBe('measured');
    expect(r!.refundRate).toBe(0.17);
    expect(r!.refundSampleSize).toBe(25);
  });
});
