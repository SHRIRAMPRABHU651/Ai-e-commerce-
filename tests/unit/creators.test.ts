import { describe, expect, it } from 'vitest';
import { DEFAULT_COMMISSION_RULES, DEFAULT_LOYALTY_RULES, validateHandle, validateSocialUrl } from '@orvia/types';
import { computeCommission, holdUntil, netGoodsBase, reconcileDelta, shouldEscalateHold, isReleasable } from '../../packages/core/src/domain/creators/commission';
import type { CommissionOrder } from '../../packages/core/src/domain/creators/commission';
import { decideAttribution, newerTouch } from '../../packages/core/src/domain/creators/attribution';
import { evaluateCreatorOrder, hashSignal, normalizeEmail, referralAbuse } from '../../packages/core/src/domain/creators/fraudRules';
import { computeTier, consumeFifo, expirable, maxSafeDiscount, planRedemption, pointsForNet } from '../../packages/core/src/domain/creators/loyaltyRules';
import { buildStatement, statementCsv, statementHtml } from '../../packages/core/src/domain/creators/statement';

const R = DEFAULT_COMMISSION_RULES;
const base: CommissionOrder = { currency: 'USD', lines: [{ category: 'desk-gadgets', gross: 6000 }, { category: 'accessories', gross: 4000 }], subtotal: 10000, discount: 1000, shipping: 500, tax: 720, total: 10220, taxInclusive: false, refunded: 0, knownCosts: 5000 };

describe('handle validation', () => {
  it('accepts good handles and normalises', () => { expect(validateHandle('  @Jane_Doe-1 ')).toEqual({ ok: true, handle: 'jane_doe-1' }); });
  it('rejects reserved, short, malformed and blocked handles', () => {
    expect(validateHandle('admin')).toMatchObject({ ok: false, reason: 'reserved' });
    expect(validateHandle('ab')).toMatchObject({ ok: false, reason: 'length' });
    expect(validateHandle('a--b')).toMatchObject({ ok: false, reason: 'format' });
    expect(validateHandle('-abc')).toMatchObject({ ok: false, reason: 'format' });
    expect(validateHandle('has space')).toMatchObject({ ok: false, reason: 'format' });
    expect(validateHandle('x'.repeat(31))).toMatchObject({ ok: false, reason: 'length' });
    expect(validateHandle('nazi-shop')).toMatchObject({ ok: false, reason: 'profanity' });
  });
  it('validates social URLs', () => {
    expect(validateSocialUrl('instagram', 'https://instagram.com/jane')).toBeTruthy();
    expect(validateSocialUrl('instagram', 'http://instagram.com/jane')).toBeNull();
    expect(validateSocialUrl('instagram', 'https://evil.com/jane')).toBeNull();
    expect(validateSocialUrl('website', 'https://user:pw@example.com')).toBeNull();
    expect(validateSocialUrl('website', 'https://127.0.0.1/x')).toBeNull();
    expect(validateSocialUrl('website', 'javascript:alert(1)')).toBeNull();
  });
});

describe('commission math', () => {
  it('uses the net base (after discount, ex tax and shipping), never GMV', () => {
    expect(netGoodsBase(base)).toBe(9000);
    const r = computeCommission(base, R, { orders90d: 0 });
    expect(r.netBase).toBe(9000);
    expect(r.commission).toBe(450); // 5% of 9000, not of 10220
    expect(r.lines.reduce((a, l) => a + l.net, 0)).toBe(9000);
  });
  it('strips embedded tax in inclusive markets', () => {
    const o = { ...base, taxInclusive: true, tax: 1000, total: 9500, currency: 'INR' };
    expect(netGoodsBase(o)).toBe(9000 - Math.round((1000 * 9000) / 9500));
  });
  it('reduces by refunds pro rata and zeroes on full refund', () => {
    expect(computeCommission({ ...base, refunded: 5110 }, R, { orders90d: 0 }).netBase).toBe(4500);
    const full = computeCommission({ ...base, refunded: 10220 }, R, { orders90d: 0 });
    expect(full.commission).toBe(0);
    expect(full.reasons).toContain('fully_refunded');
  });
  it('applies category rates, creator override and tier bonus with precedence', () => {
    const rules = { ...R, categoryRates: { 'desk-gadgets': 0.1 } };
    expect(computeCommission(base, rules, { orders90d: 0 }).commission).toBe(Math.round(5400 * 0.1) + Math.round(3600 * 0.05));
    expect(computeCommission(base, rules, { orders90d: 0, rateOverride: 0.2 }).commission).toBe(1800);
    expect(computeCommission(base, rules, { orders90d: 0, rateOverride: 0.2, categoryRateOverrides: { accessories: 0.01 } }).commission).toBe(Math.round(5400 * 0.2) + Math.round(3600 * 0.01));
    expect(computeCommission(base, R, { orders90d: 120 }).commission).toBe(Math.round(9000 * 0.06)); // Partner tier +1%
  });
  it('enforces minimum order, order cap and contribution share', () => {
    expect(computeCommission({ ...base, subtotal: 1500, discount: 0, lines: [{ category: 'x', gross: 1500 }], total: 1500, tax: 0, shipping: 0 }, { ...R, minOrderNet: { USD: 2000 } }, { orders90d: 0 }).reasons).toContain('below_minimum_order');
    const capped = computeCommission(base, { ...R, defaultRate: 0.5, maxPerOrder: { USD: 1000 } }, { orders90d: 0 });
    expect(capped.commission).toBe(1000);
    expect(capped.capped).toContain('max_per_order');
    const thin = computeCommission({ ...base, knownCosts: 9000 }, { ...R, defaultRate: 0.2 }, { orders90d: 0 });
    expect(thin.capped).toContain('contribution_share');
    expect(thin.commission).toBeLessThanOrEqual(Math.floor((10220 - 720 - 9000) * R.maxShareOfContribution));
    expect(computeCommission(base, R, { orders90d: 0 }).commission).toBeGreaterThan(0);
  });
  it('never pays more than half the net base', () => {
    const r = computeCommission({ ...base, knownCosts: null }, { ...R, defaultRate: 0.5, maxPerOrder: { USD: 0 } }, { orders90d: 0, rateOverride: 0.5 });
    expect(r.commission).toBeLessThanOrEqual(4500);
  });
});

describe('hold and clawback', () => {
  it('hold = delivery + return window + buffer (+ escalation)', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    expect(holdUntil(d, 30, R, false).toISOString().slice(0, 10)).toBe('2026-02-07');
    expect(holdUntil(d, 30, R, true).toISOString().slice(0, 10)).toBe('2026-02-28');
  });
  it('escalates only with a meaningful sample and high refund rate', () => {
    expect(shouldEscalateHold(3, 4, R)).toBe(false);
    expect(shouldEscalateHold(3, 10, R)).toBe(true);
    expect(shouldEscalateHold(2, 10, R)).toBe(false);
  });
  it('releases only past hold and not blocked', () => {
    const now = new Date('2026-03-01');
    expect(isReleasable({ status: 'accrued', holdUntil: new Date('2026-02-01') }, now, false)).toBe(true);
    expect(isReleasable({ status: 'accrued', holdUntil: new Date('2026-04-01') }, now, false)).toBe(false);
    expect(isReleasable({ status: 'accrued', holdUntil: new Date('2026-02-01') }, now, true)).toBe(false);
    expect(isReleasable({ status: 'payable', holdUntil: new Date('2026-02-01') }, now, false)).toBe(false);
  });
  it('clawback delta is target minus ledger and idempotent once booked', () => {
    expect(reconcileDelta(0, 450)).toBe(-450);
    expect(reconcileDelta(225, 450)).toBe(-225);
    expect(reconcileDelta(225, 225)).toBe(0);
    expect(reconcileDelta(0, 450 - 450)).toBe(0);
  });
});

describe('attribution precedence', () => {
  const now = new Date('2026-02-01');
  const touch = { creatorId: 'c1', handle: 'jane', capturedAt: new Date('2026-01-20'), expiresAt: new Date('2026-02-19') };
  const creator = { userId: 'u-creator', normalizedEmail: 'jane@gmail.com', status: 'approved' };
  const buyer = { userId: 'u-buyer', normalizedEmail: 'bob@example.com' };
  it('pays on a valid last touch', () => { expect(decideAttribution({ touch, orderCreatedAt: now, referralCouponApplied: false, buyer, creator })).toEqual({ payable: true, creatorId: 'c1', reason: 'creator_last_touch' }); });
  it('expires outside the window', () => { expect(decideAttribution({ touch: { ...touch, expiresAt: new Date('2026-01-25') }, orderCreatedAt: now, referralCouponApplied: false, buyer, creator })).toMatchObject({ payable: false, reason: 'expired' }); });
  it('referral coupon beats creator', () => { expect(decideAttribution({ touch, orderCreatedAt: now, referralCouponApplied: true, buyer, creator })).toMatchObject({ payable: false, reason: 'referral_precedence' }); });
  it('excludes self attribution by user and by email alias', () => {
    expect(decideAttribution({ touch, orderCreatedAt: now, referralCouponApplied: false, buyer: { userId: 'u-creator', normalizedEmail: 'x@y.com' }, creator })).toMatchObject({ reason: 'self_attribution' });
    expect(decideAttribution({ touch, orderCreatedAt: now, referralCouponApplied: false, buyer: { normalizedEmail: normalizeEmail('J.a.n.e+shop@googlemail.com') }, creator })).toMatchObject({ reason: 'self_attribution' });
  });
  it('requires an approved creator and a touch', () => {
    expect(decideAttribution({ touch, orderCreatedAt: now, referralCouponApplied: false, buyer, creator: { ...creator, status: 'suspended' } })).toMatchObject({ reason: 'creator_not_approved' });
    expect(decideAttribution({ orderCreatedAt: now, referralCouponApplied: false, buyer })).toMatchObject({ reason: 'none' });
  });
  it('last touch wins', () => {
    const later = { ...touch, creatorId: 'c2', capturedAt: new Date('2026-01-25') };
    expect(newerTouch(touch, later).creatorId).toBe('c2');
    expect(newerTouch(later, touch).creatorId).toBe('c2');
  });
});

describe('alias normalisation and referral abuse', () => {
  it('normalises gmail dots, plus tags and googlemail', () => {
    expect(normalizeEmail('J.o.h.n+promo@Gmail.com')).toBe('john@gmail.com');
    expect(normalizeEmail('john@googlemail.com')).toBe('john@gmail.com');
    expect(normalizeEmail('a.b+x@example.com')).toBe('a.b@example.com');
  });
  const party = (e: string, extra: Partial<{ a: string[]; p: string[]; i: string[] }> = {}) => ({ normalizedEmail: normalizeEmail(e), addressHashes: extra.a ?? [], phoneHashes: extra.p ?? [], ipHashes: extra.i ?? [] });
  const input = (referee: ReturnType<typeof party>, over = {}) => ({ referrer: party('ref@gmail.com', { a: ['A1'], p: ['P1'], i: ['I1'] }), referee, priorRefereeEmails: [], referrerRewards30d: 0, maxRewards30d: 10, ...over });
  it('detects each abuse class', () => {
    expect(referralAbuse(input(party('r.e.f+1@gmail.com')))).toBe('self_referral_alias');
    expect(referralAbuse(input(party('f@x.com'), { priorRefereeEmails: ['f@x.com'] }))).toBe('duplicate_referee');
    expect(referralAbuse(input(party('f@x.com', { a: ['A1'] })))).toBe('shared_address');
    expect(referralAbuse(input(party('f@x.com', { p: ['P1'] })))).toBe('shared_phone');
    expect(referralAbuse(input(party('f@x.com', { i: ['I1'] })))).toBe('shared_network');
    expect(referralAbuse(input(party('f@x.com'), { referrerRewards30d: 10 }))).toBe('velocity_cap');
    expect(referralAbuse(input(party('f@x.com', { a: ['Z'] })))).toBeNull();
  });
  it('hashes are salted and stable', () => {
    expect(hashSignal('s1', 'ip', '1.2.3.4')).toBe(hashSignal('s1', 'ip', '1.2.3.4'));
    expect(hashSignal('s1', 'ip', '1.2.3.4')).not.toBe(hashSignal('s2', 'ip', '1.2.3.4'));
    expect(hashSignal('s1', 'ip', '1.2.3.4')).not.toContain('1.2.3.4');
  });
});

describe('creator order fraud signals', () => {
  const lim = { maxOrdersPerHour: 10, maxOrdersPerDay: 40, clusterBuyers: 3, refundRateHold: 0.25 };
  const f = { ordersLastHour: 0, ordersLastDay: 0, creatorIpHashes: ['h1'], buyersSameIp: 1, creatorRefundRate: 0, creatorOrderSample: 0 };
  it('flags ip match, clusters, velocity, refund rate and risky orders', () => {
    expect(evaluateCreatorOrder(f, lim)).toEqual([]);
    expect(evaluateCreatorOrder({ ...f, buyerIpHash: 'h1' }, lim).map((x) => x.kind)).toContain('ip_cluster');
    expect(evaluateCreatorOrder({ ...f, buyersSameIp: 3 }, lim).map((x) => x.kind)).toContain('buyer_cluster');
    expect(evaluateCreatorOrder({ ...f, ordersLastHour: 10 }, lim).map((x) => x.kind)).toContain('velocity');
    expect(evaluateCreatorOrder({ ...f, creatorRefundRate: 0.4, creatorOrderSample: 10 }, lim).map((x) => x.kind)).toContain('refund_rate');
    expect(evaluateCreatorOrder({ ...f, buyerFraudLevel: 'high' }, lim).map((x) => x.kind)).toContain('suspicious_order');
  });
});

describe('loyalty', () => {
  const L = DEFAULT_LOYALTY_RULES;
  it('computes tiers from trailing spend', () => {
    expect(computeTier(0, L).tier.name).toBe('Member');
    expect(computeTier(30000, L).tier.name).toBe('Silver');
    expect(computeTier(29999, L).next).toEqual({ name: 'Silver', spendRemainingUsd: 1 });
    expect(computeTier(500000, L).next).toBeNull();
  });
  it('earns on net value with the tier multiplier, rounding down', () => {
    expect(pointsForNet(9999, L, 1)).toBe(99);
    expect(pointsForNet(10000, L, 1.25)).toBe(125);
    expect(pointsForNet(-5, L, 1)).toBe(0);
  });
  it('clamps redemption', () => {
    const ok = planRedemption({ points: 1000, balance: 2000, redeemedLast30d: 0, rules: L });
    expect(ok).toMatchObject({ ok: true, valueUsd: 1000, minSubtotalUsd: 3000 });
    expect(planRedemption({ points: 100, balance: 2000, redeemedLast30d: 0, rules: L })).toMatchObject({ ok: false, reason: 'below_minimum' });
    expect(planRedemption({ points: 3000, balance: 2000, redeemedLast30d: 0, rules: L })).toMatchObject({ reason: 'insufficient_points' });
    expect(planRedemption({ points: 6000, balance: 9000, redeemedLast30d: 0, rules: L })).toMatchObject({ reason: 'above_per_redemption_cap' });
    expect(planRedemption({ points: 5000, balance: 9000, redeemedLast30d: 6000, rules: L })).toMatchObject({ reason: 'above_30d_cap' });
    expect(planRedemption({ points: 505, balance: 9000, redeemedLast30d: 0, rules: L })).toMatchObject({ reason: 'not_whole_value' });
  });
  it('margin clamp never goes below landed cost + 5% or above 50%', () => {
    expect(maxSafeDiscount(10000, 2000)).toBe(5000);
    expect(maxSafeDiscount(10000, 8000)).toBe(1600);
    expect(maxSafeDiscount(10000, 9800)).toBe(0);
  });
  it('consumes FIFO by earliest expiry and expires whole rows', () => {
    const rows = [{ id: 'b', remaining: 50, expiresAt: new Date('2026-06-01') }, { id: 'a', remaining: 30, expiresAt: new Date('2026-03-01') }];
    expect(consumeFifo(rows, 60)).toEqual([{ id: 'a', take: 30 }, { id: 'b', take: 30 }]);
    expect(consumeFifo(rows, 100)).toBeNull();
    expect(expirable(rows, new Date('2026-04-01'))).toEqual([{ id: 'a', points: 30 }]);
  });
});

describe('payout statements', () => {
  const entries = [
    { id: '1', kind: 'commission' as const, status: 'payable', amount: 450, currency: 'USD', orderRef: '#AAAA11', deliveredAt: new Date('2026-01-10'), netBase: 9000, rate: 0.05 },
    { id: '2', kind: 'commission' as const, status: 'payable', amount: 300, currency: 'USD', orderRef: '#BBBB22', deliveredAt: new Date('2026-01-11'), netBase: 6000, rate: 0.05 },
    { id: '3', kind: 'clawback' as const, status: 'payable', amount: -150, currency: 'USD', orderRef: '#BBBB22', note: '=cmd|evil' },
    { id: '4', kind: 'commission' as const, status: 'reversed', amount: 999, currency: 'USD', orderRef: '#CCCC33' },
    { id: '5', kind: 'commission' as const, status: 'payable', amount: 77, currency: 'INR', orderRef: '#DDDD44' },
  ];
  it('totals reconcile to the ledger and the payout amount', () => {
    const s = buildStatement({ handle: 'jane', currency: 'USD', period: 'x', payoutAmount: 600, entries, disclosure: 'd' });
    expect(s.totals).toEqual({ commissions: 750, clawbacks: -150, adjustments: 0, net: 600 });
    expect(s.reconciles).toBe(true);
    expect(buildStatement({ handle: 'jane', currency: 'USD', period: 'x', payoutAmount: 601, entries, disclosure: 'd' }).reconciles).toBe(false);
  });
  it('renders csv (formula-safe) and escaped html', () => {
    const s = buildStatement({ handle: 'jane', currency: 'USD', period: 'x', entries, disclosure: 'd' });
    const csv = statementCsv(s);
    expect(csv).toContain("'=cmd|evil");
    expect(csv.trim().split('\r\n').length).toBe(s.lines.length + 2);
    expect(statementHtml({ ...s, creatorHandle: '<b>' })).toContain('&lt;b&gt;');
  });
});
