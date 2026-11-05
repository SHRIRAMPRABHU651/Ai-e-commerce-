import { describe, expect, it } from 'vitest';
import type { FairDealOfferInput } from '@orvia/types';
import { aggregateProductRows, aggregateSupplierInputs } from '../../packages/core/src/domain/trust/aggregate';
import type { SupplierRows } from '../../packages/core/src/domain/trust/aggregate';
import { deliveryBand } from '../../packages/core/src/domain/trust/delivery';
import { SubstitutionConsentError, fairDealForCustomer, normaliseWeights, rankOffersByFairValue } from '../../packages/core/src/domain/trust/fairDeal';
import { AiClaimError, assertNoAiClaims, findLeaks, guardedField, stripUnsafeClaims, toCustomerSafe } from '../../packages/core/src/domain/trust/guard';
import { buildConfidenceReport, buildPassport } from '../../packages/core/src/domain/trust/passport';
import type { PassportInputs } from '../../packages/core/src/domain/trust/passport';
import { priorsFromGlobal, scoreProductRisk, scoreSupplierTrust } from '../../packages/core/src/domain/trust/scoring';
import type { SupplierTrustInputs } from '../../packages/core/src/domain/trust/scoring';
import { dataConfidence, freshness, shrunkRate, statusFor, wilsonLower } from '../../packages/core/src/domain/trust/stats';

const now = new Date('2026-06-01T00:00:00Z');

const inputs = (n: number, p = 1, over: Partial<SupplierTrustInputs> = {}): SupplierTrustInputs => {
  const ok = Math.round(n * p);
  return {
    now, destination: null,
    shipments: { resolved: n, delivered: ok, failed: n - ok, cancelled: 0, returned: 0 },
    onTime: { eligible: n, onTime: ok },
    stock: { orders: n, issues: 0 },
    returns: { delivered: ok, returns: 0, defects: 0 },
    refunds: { count: 0, medianHours: null },
    satisfaction: { ratings: n, positive: ok },
    disputes: { orders: n, disputes: 0 },
    offers: { count: 3, newestSyncAt: new Date(now.getTime() - 3_600_000), availableCount: 3 },
    ...over,
  };
};

describe('small-sample statistics', () => {
  it('shrinkage is monotone in sample size for a perfect record and never exceeds the data', () => {
    let prev = 0;
    for (const n of [0, 1, 2, 5, 10, 30, 100, 1000]) {
      const v = shrunkRate(n, n, 0.8);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
    expect(shrunkRate(0, 0, 0.8)).toBeCloseTo(0.8);
    expect(shrunkRate(2, 2, 0.8)).toBeLessThan(shrunkRate(200, 200, 0.8));
  });
  it('is monotone in successes and confidence grows with n', () => {
    expect(shrunkRate(8, 10, 0.9)).toBeGreaterThan(shrunkRate(7, 10, 0.9));
    expect(dataConfidence(0)).toBe(0);
    expect(dataConfidence(100)).toBeGreaterThan(dataConfidence(10));
    expect(wilsonLower(3, 3)).toBeLessThan(wilsonLower(300, 300));
    expect(wilsonLower(0, 0)).toBe(0);
  });
  it('freshness decays with age and is zero after expiry', () => {
    const a = freshness(new Date(now.getTime() - 3_600_000), now, 72);
    const b = freshness(new Date(now.getTime() - 10 * 86_400_000), now, 72);
    expect(a).toBeGreaterThan(b);
    expect(freshness(new Date(now.getTime() - 72 * 3_600_000), now, 72)).toBeCloseTo(0.5, 2);
    expect(freshness(now, now, 72, new Date(now.getTime() - 1))).toBe(0);
    expect(freshness(null, now, 72)).toBe(0);
  });
  it('gates status by sample size', () => {
    expect(statusFor(4, 0.99)).toBe('insufficient_data');
    expect(statusFor(10, 0.99)).toBe('provisional');
    expect(statusFor(29, 0.99)).toBe('provisional');
    expect(statusFor(30, 0.9)).toBe('established');
    expect(statusFor(30, 0.9, { stale: true })).toBe('provisional');
    expect(statusFor(500, 0.2)).toBe('provisional');
  });
});

describe('supplier trust scoring', () => {
  it('shows no numeric score with insufficient data and says what is known', () => {
    const r = scoreSupplierTrust(inputs(3));
    expect(r.status).toBe('insufficient_data');
    expect(r.score).toBeNull();
    expect(r.range).toBeNull();
    expect(r.known.join(' ')).toMatch(/3 resolved shipments/);
    expect(r.caveats.join(' ')).toMatch(/Not enough delivery history/);
  });
  it('a supplier with no history at all is insufficient with a clear message', () => {
    const r = scoreSupplierTrust(inputs(0, 1, { offers: { count: 0, newestSyncAt: null, availableCount: 0 }, onTime: { eligible: 0, onTime: 0 }, satisfaction: { ratings: 0, positive: 0 }, disputes: { orders: 0, disputes: 0 }, stock: { orders: 0, issues: 0 }, returns: { delivered: 0, returns: 0, defects: 0 } }));
    expect(r.status).toBe('insufficient_data');
    expect(r.score).toBeNull();
    expect(r.known[0]).toMatch(/No completed shipments/);
  });
  it('is provisional with a range between 5 and 29 shipments and established at 30+', () => {
    const p = scoreSupplierTrust(inputs(12));
    expect(p.status).toBe('provisional');
    expect(p.score).not.toBeNull();
    expect(p.range!.low).toBeLessThan(p.score!);
    expect(p.range!.high).toBeGreaterThanOrEqual(p.score!);
    const e = scoreSupplierTrust(inputs(60));
    expect(e.status).toBe('established');
  });
  it('a perfect record with few samples scores below the same record with many, and trust improves as transactions accumulate', () => {
    const scores = [6, 12, 30, 60, 200].map((n) => scoreSupplierTrust(inputs(n)).score as number);
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]!);
  });
  it('a bad record scores below a good one at the same sample size', () => {
    expect(scoreSupplierTrust(inputs(40, 0.6)).score!).toBeLessThan(scoreSupplierTrust(inputs(40, 0.97)).score!);
  });
  it('stale offer data prevents "established"', () => {
    const r = scoreSupplierTrust(inputs(60, 1, { offers: { count: 3, newestSyncAt: new Date(now.getTime() - 40 * 86_400_000), availableCount: 3 } }));
    expect(r.status).toBe('provisional');
    expect(r.caveats.join(' ')).toMatch(/stale/);
  });
  it('destination slice shrinks toward the supplier global value, not the generic prior', () => {
    const global = scoreSupplierTrust(inputs(60, 0.5));
    const dest = scoreSupplierTrust({ ...inputs(6, 1), destination: 'CA', priors: priorsFromGlobal(global) });
    const naive = scoreSupplierTrust({ ...inputs(6, 1), destination: 'CA' });
    expect(dest.destination).toBe('CA');
    expect(dest.score!).toBeLessThan(naive.score!);
    expect(dest.caveats.join(' ')).toMatch(/deliveries to CA/);
  });
  it('returns, defects and slow refunds lower the score', () => {
    const base = scoreSupplierTrust(inputs(50)).score!;
    const bad = scoreSupplierTrust(inputs(50, 1, { returns: { delivered: 50, returns: 20, defects: 15 }, refunds: { count: 20, medianHours: 400 } })).score!;
    expect(bad).toBeLessThan(base);
  });
});

describe('aggregation and attribution', () => {
  const d = (x: string) => new Date(x);
  const rows: SupplierRows = {
    shipments: [
      { orderId: 'o1', sku: 'A', status: 'DELIVERED', estimatedDelivery: d('2026-05-10'), deliveredAt: d('2026-05-09'), destination: 'US' },
      { orderId: 'o2', sku: 'A', status: 'DELIVERED', estimatedDelivery: d('2026-05-10'), deliveredAt: d('2026-05-20'), destination: 'US' },
      { orderId: 'o3', sku: 'B', status: 'FAILED', lastError: 'Out of stock', destination: 'CA' },
      { orderId: 'o4', sku: 'B', status: 'CANCELLED', destination: 'CA' },
      { orderId: 'o5', sku: 'B', status: 'IN_TRANSIT', destination: 'CA' },
    ],
    returns: [{ orderId: 'o1', reason: 'damaged', itemSkus: ['A'], status: 'approved' }, { orderId: 'o2', reason: 'changed_mind', itemSkus: ['Z'] }, { orderId: 'o2', reason: 'not_delivered', itemSkus: ['A'] }, { orderId: 'zz', reason: 'damaged' }],
    refunds: [{ orderId: 'o1', hours: 10 }, { orderId: 'o3', hours: 30 }],
    reviews: [{ orderId: 'o1', rating: 5 }, { orderId: 'o2', rating: 2 }, { orderId: 'other', rating: 1 }],
    exceptions: [{ orderId: 'o2', kind: 'CHARGEBACK' }, { orderId: 'o3', kind: 'STALE_STOCK' }],
    offers: [{ destination: 'US', syncedAt: d('2026-05-30'), available: true }, { destination: 'CA', syncedAt: d('2026-05-01'), available: false }],
  };
  it('counts resolved shipments, on-time vs ETA, attributed returns, defects, stock and disputes', () => {
    const g = aggregateSupplierInputs(rows, now, null);
    expect(g.shipments).toEqual({ resolved: 4, delivered: 2, failed: 1, cancelled: 1, returned: 0 });
    expect(g.onTime).toEqual({ eligible: 2, onTime: 1 });
    expect(g.returns).toEqual({ delivered: 2, returns: 1, defects: 1 }); // not_delivered, foreign SKU and foreign order excluded
    expect(g.stock.issues).toBe(1);
    expect(g.disputes.disputes).toBe(1);
    expect(g.satisfaction).toEqual({ ratings: 2, positive: 1 });
    expect(g.refunds.count).toBe(2);
  });
  it('scopes to a destination', () => {
    const ca = aggregateSupplierInputs(rows, now, 'CA');
    expect(ca.shipments.resolved).toBe(2);
    expect(ca.shipments.delivered).toBe(0);
    expect(ca.offers.count).toBe(1);
    expect(ca.offers.availableCount).toBe(0);
  });
  it('aggregates product history including observed delivery days', () => {
    const h = aggregateProductRows({
      shipments: [{ orderId: 'a', status: 'DELIVERED', destination: 'US', orderCreatedAt: d('2026-05-01'), deliveredAt: d('2026-05-08') }, { orderId: 'b', status: 'FAILED', destination: 'US' }],
      returns: [{ orderId: 'a', reason: 'wrong_item' }], reviews: [{ rating: 5, verified: true }, { rating: 3 }],
    }, 'US');
    expect(h.history.deliveredDays).toEqual([7]);
    expect(h.feedback.defects).toBe(1);
    expect(h.reviewSummary).toMatchObject({ count: 2, avg: 4, verified: 1 });
  });
});

describe('product risk', () => {
  const base = {
    now, destination: 'US' as string | null,
    evidence: [{ key: 'a', label: 'A', present: true, provenance: 'supplier_provided' as const }, { key: 'b', label: 'B', present: false, provenance: null }],
    compliance: { status: 'passed' as const, flags: [] as string[] },
    suppliers: [] as { name: string; score: number | null; status: 'insufficient_data' | 'provisional' | 'established'; confidence: number; sampleSize: number }[],
    shipping: { resolved: 0, delivered: 0, failed: 0, onTimeEligible: 0, onTime: 0 },
    feedback: { ratings: 0, positive: 0, delivered: 0, returns: 0, defects: 0 },
    restrictions: { restricted: false, reasons: [] as string[] },
  };
  it('is insufficient with no transaction history and unscored suppliers, but states what is known', () => {
    const r = scoreProductRisk({ ...base, suppliers: [{ name: 'S', score: null, status: 'insufficient_data', confidence: 0, sampleSize: 2 }] });
    expect(r.status).toBe('insufficient_data');
    expect(r.score).toBeNull();
    expect(r.level).toBe('unknown');
    expect(r.known.length).toBeGreaterThan(1);
  });
  it('a restricted destination or failed compliance is high risk regardless of sample size', () => {
    expect(scoreProductRisk({ ...base, restrictions: { restricted: true, reasons: ['Not sold in US'] } }).level).toBe('high');
    expect(scoreProductRisk({ ...base, compliance: { status: 'failed', flags: ['WEAPON'] } }).level).toBe('high');
  });
  it('risk falls as a good history accumulates', () => {
    const sup = [{ name: 'S', score: 90, status: 'established' as const, confidence: 0.8, sampleSize: 80 }];
    const few = scoreProductRisk({ ...base, suppliers: sup, shipping: { resolved: 6, delivered: 6, failed: 0, onTimeEligible: 6, onTime: 6 }, feedback: { ratings: 3, positive: 3, delivered: 6, returns: 0, defects: 0 } });
    const many = scoreProductRisk({ ...base, suppliers: sup, shipping: { resolved: 60, delivered: 60, failed: 0, onTimeEligible: 60, onTime: 60 }, feedback: { ratings: 40, positive: 40, delivered: 60, returns: 1, defects: 0 } });
    expect(few.status).toBe('provisional');
    expect(many.status).toBe('established');
    expect(many.score!).toBeLessThan(few.score!);
  });
});

describe('delivery band', () => {
  it('without history widens the supplier estimate and never guarantees', () => {
    const b = deliveryBand({ observedDays: [], promised: { minDays: 5, maxDays: 10 } });
    expect(b.basis).toBe('promised_only');
    expect(b.maxDays!).toBeGreaterThan(10);
    expect(b.statement).toMatch(/not a guarantee/i);
    expect(deliveryBand({ observedDays: [], promised: null }).minDays).toBeNull();
  });
  it('with history uses observed quantiles and a widened tail', () => {
    const days = [6, 7, 7, 8, 8, 9, 9, 10, 11, 14];
    const b = deliveryBand({ observedDays: days, promised: { minDays: 5, maxDays: 10 } });
    expect(b.basis).toBe('observed');
    expect(b.sampleSize).toBe(10);
    expect(b.maxDays!).toBeGreaterThanOrEqual(11);
    expect(b.onTimeRateLow!).toBeLessThan(0.8);
    expect(b.confidence).toBeGreaterThan(deliveryBand({ observedDays: [], promised: { minDays: 5, maxDays: 10 } }).confidence);
  });
});

describe('AI claim guard', () => {
  it('strips safety, certification and compliance sentences from AI text', () => {
    const r = stripUnsafeClaims('Soft and cosy bed for cats. CE certified and non-toxic. Fits most spaces! Meets EN71 standards.');
    expect(r.text).toBe('Soft and cosy bed for cats. Fits most spaces!');
    expect(r.removed).toHaveLength(2);
  });
  it('rejects ai_suggested content in claim positions and strips it in descriptive ones', () => {
    expect(() => guardedField({ kind: 'claim', value: 'Safe for children', provenance: 'ai_suggested', source: 'x' })).toThrow(AiClaimError);
    expect(guardedField({ kind: 'descriptive', value: 'FDA approved and food safe.', provenance: 'ai_suggested', source: 'x' })).toBeNull();
    expect(guardedField({ kind: 'claim', value: 'EN71', provenance: 'supplier_provided', source: 'x' })?.provenance).toBe('supplier_provided');
    expect(() => assertNoAiClaims([{ provenance: 'ai_suggested', title: 'CE' }])).toThrow(AiClaimError);
  });
});

describe('no-leak serializer', () => {
  it('drops cost, margin and supplier ids and detects leaks', () => {
    const dirty = { price: 10, productCost: 5, nested: { supplierId: 'abc', ok: 1, list: [{ landedCost: 3, name: 'x' }] }, margin: 0.4 };
    expect(findLeaks(dirty)).toEqual(expect.arrayContaining(['$.productCost', '$.margin', '$.nested.supplierId', '$.nested.list[0].landedCost']));
    const clean = toCustomerSafe(dirty);
    expect(clean).toEqual({ price: 10, nested: { ok: 1, list: [{ name: 'x' }] } });
    expect(findLeaks(clean)).toEqual([]);
    expect(findLeaks({ a: '507f1f77bcf86cd799439011' }, ['507f1f77bcf86cd799439011'])).toHaveLength(1);
  });
});

describe('passport and confidence', () => {
  const pin = (over: Partial<PassportInputs> = {}): PassportInputs => ({
    now, country: 'US',
    product: { slug: 's', title: 'Snuffle Mat', brand: 'Orvia', description: 'A cosy mat. Certified non-toxic and CE approved. Great fun.', state: 'PUBLISHED', attributes: { Material: 'Felt', Weight: '300 g', Colour: 'Grey' }, safetyStandards: ['EN71'], certificateUrl: 'https://x.test/c.pdf', organic: [{ claim: 'organic', verified: false, type: 'supplier_statement' }], marketEnabled: true, price: 1999, currency: 'USD', compareAtPrice: 2999, promised: { minDays: 5, maxDays: 9 }, shipsFrom: 'CN' },
    evidence: [{ subject: 'product', kind: 'material', key: 'material', value: 'Wool felt (lab confirmed)', provenance: 'verified', source: 'Lab report 12', observedAt: now }, { subject: 'product', kind: 'certificate', key: 'EN71', value: 'EN71', provenance: 'ai_suggested', source: 'AI' }],
    supplierDisplayName: 'Acme Pet Supply',
    images: [{ url: 'https://img/1.jpg', source: 'supplier', license: 'unknown' }],
    offer: { newestSyncAt: new Date(now.getTime() - 200 * 3_600_000), manual: false, available: true },
    history: { deliveredDays: [], resolved: 0, delivered: 0, failed: 0, returns: 0, defects: 0 },
    risk: scoreProductRisk({ now, destination: 'US', evidence: [], compliance: { status: 'pending', flags: [] }, suppliers: [], shipping: { resolved: 0, delivered: 0, failed: 0, onTimeEligible: 0, onTime: 0 }, feedback: { ratings: 0, positive: 0, delivered: 0, returns: 0, defects: 0 }, restrictions: { restricted: false, reasons: [] } }),
    reviews: { avg: null, count: 0, verified: 0, distribution: {} },
    alternatives: [], restrictions: { restricted: false, reasons: [] },
    ...over,
  });
  it('labels provenance honestly: only verified evidence is verified, AI never appears as a claim', () => {
    const p = buildPassport(pin());
    expect(p.materials.find((m) => m.value.includes('Wool'))?.provenance).toBe('verified');
    expect(p.dimensions[0]?.field.provenance).toBe('supplier_provided');
    const en71 = p.documents.find((d) => d.title === 'EN71')!;
    expect(en71.provenance).toBe('supplier_provided'); // AI evidence did not verify it
    expect(p.documents.some((d) => d.provenance === 'ai_suggested')).toBe(false);
    expect(p.documents.find((d) => d.kind === 'organic_claim')?.provenance).toBe('supplier_provided');
    expect(p.summary?.provenance).toBe('ai_suggested');
    expect(p.summary?.value).not.toMatch(/certified|CE|non-toxic/i);
    expect(p.stock.freshness).toBe('stale');
    expect(p.priceHistory.available).toBe(false);
    expect(p.delivery.actual.basis).toBe('promised_only');
    expect(p.quality.status).toBe('insufficient_data');
    expect(p.images[0]!.usageRights).toMatch(/not confirmed/);
  });
  it('expired verified evidence is downgraded', () => {
    const p = buildPassport(pin({ evidence: [{ subject: 'product', kind: 'certificate', key: 'EN71', value: 'EN71', provenance: 'verified', source: 'Lab', expiresAt: new Date(now.getTime() - 1) }] }));
    expect(p.documents.find((d) => d.title === 'EN71')?.provenance).toBe('supplier_provided');
  });
  it('contains no internal keys', () => {
    expect(findLeaks(buildPassport(pin()))).toEqual([]);
  });
  it('confidence report states uncertainty when history is missing and leaks nothing', () => {
    const r = buildConfidenceReport({
      now, country: 'US', quantity: 2, product: { slug: 's', title: 'T', available: true, promised: { minDays: 5, maxDays: 9 }, shipsFrom: 'CN' },
      checklist: [{ key: 'a', label: 'Materials', present: false, provenance: null }, { key: 'b', label: 'Specs', present: true, provenance: 'supplier_provided' }],
      supplier: null, deliveredDays: [], estimateLabel: null, returnWindowDays: 30, pricing: null, restrictions: { restricted: false, reasons: [] }, risk: pin().risk, offerStale: true,
    });
    expect(r.supplierReliability.label).toBe('Not enough delivery history yet');
    expect(r.uncertainty.join(' ')).toMatch(/not yet confirmed by real deliveries/);
    expect(r.uncertainty.join(' ')).toMatch(/Tax is an estimate/);
    expect(r.knownLimitations.join(' ')).toMatch(/Missing product information: Materials/);
    expect(r.infoCompleteness.verifiedShare).toBe(0);
    expect(findLeaks(r)).toEqual([]);
  });
});

describe('Fair Deal Engine', () => {
  const offer = (id: string, over: Partial<FairDealOfferInput> = {}): FairDealOfferInput => ({
    offerId: id, productId: 'p1', supplierRef: `sup-${id}`, supplierDisplayName: `Supplier ${id}`, available: true, totalDeliveredPrice: 2000, currency: 'USD', evidenceCompleteness: 0.6,
    supplierTrust: { score: 85, status: 'established', confidence: 0.8 }, delivery: { minDays: 4, maxDays: 8, confidence: 0.7, basis: 'observed' }, returnWindowDays: 30, warrantyMonths: null, ...over,
  });
  it('is not cheapest-only: a slightly dearer reliable offer beats a cheap unknown one', () => {
    const r = rankOffersByFairValue([
      offer('cheap', { totalDeliveredPrice: 1800, supplierTrust: null, delivery: { minDays: 10, maxDays: 25, confidence: 0.1, basis: 'promised_only' }, returnWindowDays: 7 }),
      offer('good', { totalDeliveredPrice: 2000 }),
    ]);
    expect(r.ranked[0]!.offerId).toBe('good');
    expect(r.ranked.find((x) => x.offerId === 'cheap')!.isCheapest).toBe(true);
    expect(r.ranked[1]!.unknowns).toContain('supplier_reliability');
    expect(r.ranked[0]!.dimensions).toHaveLength(6);
  });
  it('customer preference weights change the order', () => {
    const offers = [offer('cheap', { totalDeliveredPrice: 1500, supplierTrust: { score: 55, status: 'provisional', confidence: 0.3 } }), offer('good', { totalDeliveredPrice: 2600 })];
    expect(rankOffersByFairValue(offers, { weights: { price: 10 } }).ranked[0]!.offerId).toBe('cheap');
    expect(rankOffersByFairValue(offers, { weights: { price: 0, supplier_reliability: 10 } }).ranked[0]!.offerId).toBe('good');
  });
  it('excludes unavailable offers, is deterministic, and normalises weights', () => {
    const r = rankOffersByFairValue([offer('a'), offer('b'), offer('c', { available: false })]);
    expect(r.excluded).toEqual([{ offerId: 'c', reason: 'Not available' }]);
    expect(r.ranked.map((x) => x.offerId)).toEqual(['a', 'b']);
    const w = normaliseWeights({ price: 5 });
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2);
  });
  it('refuses silent substitution without consent and flags substitutes with it', () => {
    const offers = [offer('a'), offer('x', { productId: 'p2' })];
    expect(() => rankOffersByFairValue(offers)).toThrow(SubstitutionConsentError);
    const r = rankOffersByFairValue(offers, { allowSubstitution: true });
    expect(r.ranked.find((x) => x.offerId === 'x')!.substitute).toBe(true);
    expect(r.ranked.find((x) => x.offerId === 'a')!.substitute).toBe(false);
  });
  it('customer projection hides internal references', () => {
    const c = fairDealForCustomer(rankOffersByFairValue([offer('a')]));
    expect(findLeaks(c)).toEqual([]);
    expect(JSON.stringify(c)).not.toContain('sup-a');
  });
});
