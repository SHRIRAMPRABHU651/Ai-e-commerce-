import { describe, expect, it } from 'vitest';
import { DEFAULT_RESCUE_POLICY } from '@orvia/types';
import type { RescuePolicy } from '@orvia/types';
import { classifyOrder, isPlausibleTracking, severityFor } from '../../packages/core/src/domain/rescue/classifier';
import type { ClassifierOrder, ClassifierShipment } from '../../packages/core/src/domain/rescue/classifier';
import { generateOptions } from '../../packages/core/src/domain/rescue/options';
import type { OptionsInput } from '../../packages/core/src/domain/rescue/options';
import { authorize, readyToExecute, resolvePolicy } from '../../packages/core/src/domain/rescue/policy';
import { LocalOfferRanker } from '../../packages/core/src/domain/rescue/ranker';
import type { AltOffer } from '../../packages/core/src/domain/rescue/ranker';
import { consentTransition, emailSubject, hashToken, signConsentToken, termsHash, verifyConsentToken } from '../../packages/core/src/domain/rescue/consent';
import { actionKey, caseDedupeKey, duplicateOrderGuard, supplierOrderKey } from '../../packages/core/src/domain/rescue/guard';
import { decideRetry, retryDelayMs } from '../../packages/core/src/domain/rescue/retry';

const DAY = 86_400_000;
const NOW = new Date('2026-06-30T12:00:00Z');
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);
const P: RescuePolicy = DEFAULT_RESCUE_POLICY;

const ship = (o: Partial<ClassifierShipment> = {}): ClassifierShipment => ({ id: 's1', lineKey: 'L1', status: 'IN_TRANSIT', supplierId: 'sup1', supplierOrderId: 'SO1', trackingNumber: 'TRK123456789', estimatedDelivery: ago(-5), createdAt: ago(3), events: [{ status: 'IN_TRANSIT', description: 'Departed facility', at: ago(1) }], ...o });
const order = (o: Partial<ClassifierOrder> = {}, ships: ClassifierShipment[] = [ship()]): ClassifierOrder => ({
  orderId: 'o1', orderNumber: 'ORV-1', status: 'IN_TRANSIT', paymentStatus: 'succeeded', paidAt: ago(3), currency: 'USD', country: 'US',
  items: [{ lineKey: 'L1', title: 'Widget', quantity: 1, unitPrice: 2500, productId: 'p1', sku: 'W1' }], shipments: ships, ...o,
});
const kinds = (o: ClassifierOrder) => classifyOrder(o, P, NOW).map((d) => d.kind);

describe('classifier', () => {
  it('finds nothing for a healthy shipment', () => expect(kinds(order())).toEqual([]));
  it('ignores unpaid, cancelled and refunded orders', () => {
    expect(kinds(order({ status: 'CANCELLED' }, []))).toEqual([]);
    expect(kinds(order({ status: 'PENDING_PAYMENT' }, []))).toEqual([]);
    expect(kinds(order({ paymentStatus: 'pending' }, []))).toEqual([]);
  });
  it('supplier acceptance failure after grace, with evidence', () => {
    const o = order({ status: 'PAID', paidAt: ago(1), fulfillmentState: 'failed', fulfillmentLastError: 'API 500', openExceptions: [{ kind: 'SUPPLIER_FAILURE', issue: 'No supplier could fulfil' }] }, []);
    const d = classifyOrder(o, P, NOW);
    expect(d).toHaveLength(1);
    expect(d[0]!.kind).toBe('supplier_acceptance_failure');
    expect(d[0]!.evidence.map((e) => e.code)).toContain('no_supplier_order');
    expect(d[0]!.lineValue).toBe(2500);
  });
  it('does not flag a fresh paid order inside the grace window', () => {
    expect(kinds(order({ status: 'PAID', paidAt: new Date(NOW.getTime() - 10 * 60_000), fulfillmentState: 'failed' }, []))).toEqual([]);
  });
  it('stock shortage from supplier error beats acceptance failure', () => {
    const o = order({ status: 'PAID', paidAt: ago(1), openExceptions: [{ kind: 'SUPPLIER_FAILURE', issue: 'Suppliers rejected "Widget": out of stock' }] }, [ship({ status: 'FAILED', lastError: 'Out of stock at warehouse' })]);
    const d = classifyOrder(o, P, NOW);
    expect(d[0]!.kind).toBe('stock_shortage');
    expect(d[0]!.alsoDetected).toContain('supplier_acceptance_failure');
  });
  it('supplier cancellation when the only supplier order is CANCELLED but the order is live', () => {
    expect(kinds(order({ status: 'SUPPLIER_PROCESSING' }, [ship({ status: 'CANCELLED' })]))).toEqual(['supplier_cancellation']);
  });
  it('shipment delay respects the grace period', () => {
    expect(kinds(order({}, [ship({ estimatedDelivery: ago(1) })]))).toEqual([]);
    expect(kinds(order({}, [ship({ estimatedDelivery: ago(4), events: [{ status: 'IN_TRANSIT', at: ago(1) }] })]))).toEqual(['shipment_delay']);
  });
  it('uses a labelled policy fallback when no ETA exists', () => {
    const d = classifyOrder(order({}, [ship({ estimatedDelivery: null, createdAt: ago(30), events: [{ status: 'IN_TRANSIT', at: ago(1) }] })]), P, NOW);
    expect(d[0]!.kind).toBe('shipment_delay');
    expect(d[0]!.evidence[0]!.detail).toContain('policy-assumed');
    expect(d[0]!.evidence[0]!.provenance).toBe('verified');
  });
  it('invalid / missing tracking after the grace days', () => {
    expect(kinds(order({}, [ship({ trackingNumber: null, createdAt: ago(5) })]))).toEqual(['invalid_tracking']);
    expect(kinds(order({}, [ship({ trackingNumber: 'N/A', createdAt: ago(5) })]))).toEqual(['invalid_tracking']);
    expect(kinds(order({}, [ship({ trackingNumber: null, createdAt: ago(1) })]))).toEqual([]);
  });
  it('plausible tracking heuristics', () => {
    expect(isPlausibleTracking('1Z999AA10123456784')).toBe(true);
    for (const bad of [undefined, '', 'abc', '00000000', 'pending', 'AAAAAAAAAA', 'has space 12345', 'x'.repeat(50)]) expect(isPlausibleTracking(bad as string)).toBe(false);
  });
  it('carrier exception from the latest event', () => {
    expect(kinds(order({}, [ship({ events: [{ status: 'IN_TRANSIT', description: 'Customs hold - documents required', at: ago(1) }] })]))).toEqual(['carrier_exception']);
  });
  it('failed delivery beats carrier exception', () => {
    const d = classifyOrder(order({}, [ship({ events: [{ status: 'OUT_FOR_DELIVERY', description: 'Delivery attempt failed - recipient not available', at: ago(0.2) }] })]), P, NOW);
    expect(d[0]!.kind).toBe('failed_delivery');
  });
  it('suspected lost: idle too long, or far past ETA', () => {
    expect(kinds(order({}, [ship({ events: [{ status: 'IN_TRANSIT', at: ago(12) }], estimatedDelivery: ago(-2) })]))).toEqual(['suspected_lost']);
    const d = classifyOrder(order({}, [ship({ estimatedDelivery: ago(12), events: [{ status: 'IN_TRANSIT', at: ago(2) }] })]), P, NOW);
    expect(d[0]!.kind).toBe('suspected_lost');
    expect(d[0]!.alsoDetected).toContain('shipment_delay');
  });
  it('unusual delivery pattern: delivered minutes after creation, advisory severity', () => {
    const s = ship({ status: 'DELIVERED', createdAt: ago(1), events: [{ status: 'DELIVERED', description: 'Delivered', at: new Date(ago(1).getTime() + 10 * 60_000) }] });
    const d = classifyOrder(order({ status: 'DELIVERED' }, [s]), P, NOW);
    expect(d[0]!.kind).toBe('unusual_delivery_pattern');
    expect(['low', 'medium']).toContain(d[0]!.severity);
  });
  it('one detection per line, even when several lines fail independently', () => {
    const o = order({ items: [{ lineKey: 'L1', title: 'A', quantity: 1, unitPrice: 1000, productId: 'p1', sku: 'a' }, { lineKey: 'L2', title: 'B', quantity: 2, unitPrice: 500, productId: 'p2', sku: 'b' }] }, [ship({ estimatedDelivery: ago(5) }), ship({ id: 's2', lineKey: 'L2', status: 'CANCELLED' })]);
    const d = classifyOrder(o, P, NOW);
    expect(d.map((x) => [x.lineKey, x.kind])).toEqual([['L1', 'shipment_delay'], ['L2', 'supplier_cancellation']]);
    expect(d[1]!.lineValue).toBe(1000);
  });
  it('is deterministic', () => {
    const o = order({}, [ship({ estimatedDelivery: ago(5) })]);
    expect(classifyOrder(o, P, NOW)).toEqual(classifyOrder(o, P, NOW));
  });
  it('severity grows with lateness and value', () => {
    expect(severityFor('shipment_delay', 0, 1000)).toBe('low');
    expect(severityFor('shipment_delay', 8, 1000)).toBe('medium');
    expect(severityFor('shipment_delay', 8, 20_000)).toBe('high');
    expect(severityFor('suspected_lost', 22, 20_000)).toBe('critical');
    expect(severityFor('unusual_delivery_pattern', 30, 99_999)).toBe('medium');
  });
});

const alt = (o: Partial<AltOffer> = {}): AltOffer => ({ supplierId: 'a1', supplierName: 'Alt One', supplierCode: 'alt1', externalId: 'X1', landedCost: 1000, minDays: 5, maxDays: 9, stock: 20, available: true, reliability: 90, rating: 4.5, trackingAvailable: true, ...o });
const optInput = (o: Partial<OptionsInput> = {}): OptionsInput => ({
  kind: 'supplier_cancellation', severity: 'high', currency: 'USD', title: 'Widget', quantity: 1, lineValue: 2500, orderRefundable: 3000, orderIsSingleLine: true,
  original: { hasLiveShipment: false, status: null, supplierId: 'sup1', cost: 1200, costKnown: true, cancelPath: 'not_placed' },
  promiseAt: new Date(NOW.getTime() + 10 * DAY), now: NOW,
  alternatives: LocalOfferRanker.rank([alt()], { quantity: 1, originalCost: 1200 }), replacements: [], guard: { allow: true, cancelFirst: null, overrideUsed: false, reason: 'ok' }, policy: P, ...o,
});
const byKind = (set: ReturnType<typeof generateOptions>, k: string) => set.options.filter((x) => x.kind === k);

describe('ranker', () => {
  it('puts eligible, better-scoring offers first and is deterministic', () => {
    const r = LocalOfferRanker.rank([alt({ supplierId: 'z', available: false }), alt({ supplierId: 'b', landedCost: 1500, maxDays: 20 }), alt({ supplierId: 'a' })], { quantity: 1, originalCost: 1200 });
    expect(r.map((x) => x.supplierId)).toEqual(['a', 'b', 'z']);
    expect(r[2]!.eligible).toBe(false);
  });
  it('marks insufficient stock ineligible', () => {
    const r = LocalOfferRanker.rank([alt({ stock: 1 })], { quantity: 3, originalCost: 1000 });
    expect(r[0]!.eligible).toBe(false);
    expect(r[0]!.ineligibleReason).toContain('only 1');
  });
});

describe('option generation', () => {
  it('same-product reorder within promise has no material change and zero customer cost', () => {
    const set = generateOptions(optInput());
    const r = byKind(set, 'reorder_same_product_alt_supplier')[0]!;
    expect(r.feasible).toBe(true);
    expect(r.materialChange).toBe(false);
    expect(r.requiresCustomerConsent).toBe(false);
    expect(r.impact.extraCost).toBe(1000 - 1200 + 0); // original not placed: cost recovered semantics
    expect(set.recommendedId).toBe(r.id);
  });
  it('later delivery beyond the threshold is a material change needing consent', () => {
    const set = generateOptions(optInput({ promiseAt: new Date(NOW.getTime() + 2 * DAY), alternatives: LocalOfferRanker.rank([alt({ maxDays: 12 })], { quantity: 1, originalCost: 1200 }) }));
    const r = byKind(set, 'reorder_same_product_alt_supplier')[0]!;
    expect(r.eta.worseningDays).toBe(10);
    expect(r.materialChange).toBe(true);
    expect(r.requiresCustomerConsent).toBe(true);
    expect(r.materialReasons[0]).toContain('10 days');
  });
  it('dispatched original means its cost is sunk', () => {
    const set = generateOptions(optInput({ kind: 'suspected_lost', original: { hasLiveShipment: true, status: 'IN_TRANSIT', supplierId: 's', cost: 1200, costKnown: true, cancelPath: 'dispatched' }, guard: { allow: false, code: 'goods_in_transit', reason: 'x' } }));
    const r = byKind(set, 'reorder_same_product_alt_supplier')[0]!;
    expect(r.needsDuplicateAck).toBe(true);
    expect(r.impact.sunkCost).toBe(1200);
    expect(r.impact.extraCost).toBe(1000);
  });
  it('a replacement is a different product, always material, only when same product unavailable', () => {
    const rep = { productId: 'p9', title: 'Other', sku: 'O1', supplierId: 's9', supplierName: 'S9', externalId: 'E9', landedCost: 1100, unitPrice: 2400, minDays: 6, maxDays: 10, stock: 5 };
    const noAlt = generateOptions(optInput({ alternatives: [], replacements: [rep] }));
    const r = byKind(noAlt, 'offer_equivalent_replacement')[0]!;
    expect(r.feasible).toBe(true);
    expect(r.materialChange).toBe(true);
    expect(r.requiresCustomerConsent).toBe(true);
    expect(r.customerText).toContain('different but similar product');
    expect(noAlt.recommendedId).toBe(r.id);
    const withAlt = generateOptions(optInput({ replacements: [rep] }));
    expect(byKind(withAlt, 'offer_equivalent_replacement')[0]!.feasible).toBe(false);
  });
  it('delay on a moving parcel: continue for low severity, partial refund bounded by policy', () => {
    const base = optInput({ kind: 'shipment_delay', severity: 'low', original: { hasLiveShipment: true, status: 'IN_TRANSIT', supplierId: 's', cost: 1200, costKnown: true, cancelPath: 'dispatched' }, guard: { allow: false, code: 'goods_in_transit', reason: 'x' } });
    const s = generateOptions(base);
    expect(s.recommendedId).toBe('continue_shipment');
    const p = byKind(s, 'offer_partial_refund')[0]!;
    expect(p.impact.refund).toBe(500);
    expect(p.requiresCustomerConsent).toBe(true);
    const capped = generateOptions({ ...base, policy: { ...P, defaultPartialRefundPct: 0.9, maxPartialRefundPct: 0.3 } });
    expect(byKind(capped, 'offer_partial_refund')[0]!.impact.refund).toBe(750);
    expect(generateOptions({ ...base, severity: 'high', alternatives: [] }).recommendedId).toBe('offer_partial_refund');
  });
  it('full refund when nothing else works; consent waived only when truly unfulfillable', () => {
    const s = generateOptions(optInput({ alternatives: [], replacements: [] }));
    const f = byKind(s, 'offer_full_refund')[0]!;
    expect(s.recommendedId).toBe(f.id);
    expect(f.impact.refund).toBe(3000);
    expect(f.requiresCustomerConsent).toBe(false);
    const lost = generateOptions(optInput({ kind: 'carrier_exception', severity: 'high', alternatives: [], original: { hasLiveShipment: true, status: 'IN_TRANSIT', supplierId: 's', cost: 1200, costKnown: true, cancelPath: 'dispatched' } }));
    expect(byKind(lost, 'offer_full_refund')[0]!.requiresCustomerConsent).toBe(true);
  });
  it('unusual patterns and failed deliveries go to a human', () => {
    expect(generateOptions(optInput({ kind: 'unusual_delivery_pattern', severity: 'low' })).recommendedId).toBe('escalate_human');
    expect(generateOptions(optInput({ kind: 'failed_delivery', original: { hasLiveShipment: true, status: 'OUT_FOR_DELIVERY', supplierId: 's', cost: 1, costKnown: true, cancelPath: 'dispatched' } })).recommendedId).toBe('escalate_human');
  });
  it('a refused guard makes reorder infeasible', () => {
    const r = byKind(generateOptions(optInput({ guard: { allow: false, code: 'maybe_with_supplier', reason: 'supplier may hold it' } })), 'reorder_same_product_alt_supplier')[0]!;
    expect(r.feasible).toBe(false);
    expect(r.infeasibleReason).toContain('may hold');
  });
});

describe('authorization policy', () => {
  const reorder = (o: Partial<OptionsInput> = {}) => byKind(generateOptions(optInput(o)), 'reorder_same_product_alt_supplier')[0]!;
  const usage = { autoCostUsd: 0, autoActions: 0 };
  const approved: RescuePolicy = { ...P, autoExecuteEnabled: true, preApprovedSupplierIds: ['a1'] };
  it('defaults are safe: reorder needs staff, monitoring is automatic', () => {
    expect(authorize({ option: reorder(), policy: P, usage, exposureUsd: 0, originalCost: 1200 }).mode).toBe('staff_approval');
    const cont = byKind(generateOptions(optInput({ kind: 'shipment_delay', severity: 'low', original: { hasLiveShipment: true, status: 'IN_TRANSIT', supplierId: 's', cost: 1, costKnown: true, cancelPath: 'dispatched' } })), 'continue_shipment')[0]!;
    expect(authorize({ option: cont, policy: P, usage, exposureUsd: 0, originalCost: 0 }).mode).toBe('auto');
  });
  it('pre-approved supplier within tolerance and limits auto-executes', () => {
    const d = authorize({ option: reorder(), policy: approved, usage, exposureUsd: 0, originalCost: 1200 });
    expect(d.mode).toBe('auto');
    expect(d.autoEligible).toBe(true);
  });
  it('cost tolerance, per-case limit, daily budget and daily count each block automation', () => {
    expect(authorize({ option: reorder({ alternatives: LocalOfferRanker.rank([alt({ landedCost: 1700 })], { quantity: 1, originalCost: 1200 }) }), policy: approved, usage, exposureUsd: 0, originalCost: 1200 }).mode).toBe('staff_approval');
    expect(authorize({ option: reorder(), policy: approved, usage, exposureUsd: approved.maxCostPerCaseUsd + 1, originalCost: 1200 }).mode).toBe('staff_approval');
    expect(authorize({ option: reorder(), policy: approved, usage: { autoCostUsd: approved.maxCostPerDayUsd, autoActions: 0 }, exposureUsd: 10, originalCost: 1200 }).mode).toBe('staff_approval');
    expect(authorize({ option: reorder(), policy: approved, usage: { autoCostUsd: 0, autoActions: approved.maxAutoActionsPerDay }, exposureUsd: 0, originalCost: 1200 }).mode).toBe('staff_approval');
    expect(authorize({ option: reorder(), policy: approved, usage, exposureUsd: 0, originalCost: 0 }).mode).toBe('staff_approval'); // unknown original cost
  });
  it('unapproved supplier or switched-off automation never auto-executes', () => {
    expect(authorize({ option: reorder(), policy: { ...approved, preApprovedSupplierIds: [] }, usage, exposureUsd: 0, originalCost: 1200 }).autoEligible).toBe(false);
    expect(authorize({ option: reorder(), policy: { ...approved, autoExecuteEnabled: false }, usage, exposureUsd: 0, originalCost: 1200 }).autoEligible).toBe(false);
  });
  it('material change always needs the customer, even if every limit passes', () => {
    const late = reorder({ promiseAt: new Date(NOW.getTime() + 1 * DAY), alternatives: LocalOfferRanker.rank([alt({ maxDays: 20 })], { quantity: 1, originalCost: 1200 }) });
    const d = authorize({ option: late, policy: approved, usage, exposureUsd: 0, originalCost: 1200 });
    expect(d.mode).toBe('customer_consent');
    expect(d.autoEligible).toBe(false);
    expect(readyToExecute(d, { consentAccepted: false, staffApproved: true }).ready).toBe(false);
    expect(readyToExecute(d, { consentAccepted: true, staffApproved: false }).ready).toBe(true);
  });
  it('refunds, replacements and humans can never be auto-capable', () => {
    const everything = { ...approved, autoActions: ['offer_full_refund', 'offer_partial_refund', 'offer_equivalent_replacement', 'escalate_human', 'reorder_same_product_alt_supplier', 'continue_shipment'] as RescuePolicy['autoActions'] };
    const s = generateOptions(optInput({ alternatives: [], replacements: [] }));
    const f = byKind(s, 'offer_full_refund')[0]!;
    expect(authorize({ option: f, policy: everything, usage, exposureUsd: 0, originalCost: 1 }).autoEligible).toBe(false);
    expect(authorize({ option: f, policy: everything, usage, exposureUsd: 0, originalCost: 1 }).requiresStaffApproval).toBe(true);
  });
  it('duplicate-risk reorders require staff', () => {
    const o = reorder({ kind: 'suspected_lost', original: { hasLiveShipment: true, status: 'IN_TRANSIT', supplierId: 's', cost: 1200, costKnown: true, cancelPath: 'dispatched' }, guard: { allow: false, code: 'goods_in_transit', reason: 'x' } });
    const d = authorize({ option: o, policy: approved, usage, exposureUsd: 0, originalCost: 1200 });
    expect(d.requiresStaffApproval).toBe(true);
    expect(d.autoEligible).toBe(false);
  });
  it('infeasible options are blocked', () => {
    expect(authorize({ option: byKind(generateOptions(optInput()), 'offer_partial_refund')[0]!, policy: P, usage, exposureUsd: 0, originalCost: 0 }).mode).toBe('blocked');
  });
  it('resolvePolicy falls back to defaults on garbage and merges partial values', () => {
    expect(resolvePolicy(undefined)).toEqual(P);
    expect(resolvePolicy({ maxCostPerCaseUsd: -5 })).toEqual(P);
    expect(resolvePolicy({ maxCostPerCaseUsd: 99, detection: { delayGraceDays: 4 } }).detection.lostAfterIdleDays).toBe(P.detection.lostAfterIdleDays);
    expect(resolvePolicy({ maxCostPerCaseUsd: 99 }).maxCostPerCaseUsd).toBe(99);
  });
});

describe('consent tokens', () => {
  const secret = 's3cret-key';
  const claims = { caseId: 'c1', round: 2, exp: NOW.getTime() + 3600_000, sub: emailSubject('A@x.com') };
  it('round-trips and binds case, round and recipient', () => {
    const t = signConsentToken(claims, secret);
    expect(verifyConsentToken(t, secret, NOW, { caseId: 'c1', round: 2, email: 'a@x.com' }).ok).toBe(true);
    expect(verifyConsentToken(t, secret, NOW, { caseId: 'c2', round: 2 })).toEqual({ ok: false, reason: 'wrong_case' });
    expect(verifyConsentToken(t, secret, NOW, { caseId: 'c1', round: 3 })).toEqual({ ok: false, reason: 'stale_round' });
    expect(verifyConsentToken(t, secret, NOW, { caseId: 'c1', round: 2, email: 'b@x.com' })).toEqual({ ok: false, reason: 'wrong_recipient' });
  });
  it('rejects expiry, tampering, wrong secret and junk', () => {
    const t = signConsentToken(claims, secret);
    expect(verifyConsentToken(t, secret, new Date(claims.exp + 1), { caseId: 'c1', round: 2 })).toEqual({ ok: false, reason: 'expired' });
    const [b, s] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims, caseId: 'c9' })).toString('base64url');
    expect(verifyConsentToken(`${forged}.${s}`, secret, NOW, { caseId: 'c9', round: 2 })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyConsentToken(t, 'other', NOW, { caseId: 'c1', round: 2 })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyConsentToken('nope', secret, NOW, { caseId: 'c1', round: 2 })).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyConsentToken(`${b}.`, secret, NOW, { caseId: 'c1', round: 2 })).toEqual({ ok: false, reason: 'malformed' });
  });
  it('tokens are unique and stored only as hashes', () => {
    const a = signConsentToken(claims, secret), b = signConsentToken(claims, secret);
    expect(a).not.toBe(b);
    expect(hashToken(a)).toMatch(/^[a-f0-9]{64}$/);
  });
  it('consent state machine is single-use', () => {
    expect(consentTransition('pending', 'accept', false)).toEqual({ ok: true, next: 'accepted' });
    expect(consentTransition('pending', 'decline', false)).toEqual({ ok: true, next: 'declined' });
    expect(consentTransition('pending', 'accept', true)).toEqual({ ok: false, reason: 'expired' });
    for (const s of ['accepted', 'declined', 'expired', 'revoked'] as const) expect(consentTransition(s, 'accept', false)).toEqual({ ok: false, reason: 'already_decided' });
  });
  it('terms hash changes when terms change', () => {
    const t = { optionId: 'o', kind: 'offer_partial_refund', refund: 500, extraCost: 0, etaMaxDays: null, currency: 'USD' };
    expect(termsHash(t)).toBe(termsHash({ ...t }));
    expect(termsHash(t)).not.toBe(termsHash({ ...t, refund: 600 }));
  });
});

describe('idempotency keys and duplicate-order guard', () => {
  it('keys are stable, scoped and differ by target', () => {
    expect(actionKey('c1', 'reorder_same_product_alt_supplier', 'opt:a')).toBe(actionKey('c1', 'reorder_same_product_alt_supplier', 'opt:a'));
    expect(actionKey('c1', 'reorder_same_product_alt_supplier', 'opt:a')).not.toBe(actionKey('c1', 'reorder_same_product_alt_supplier', 'opt:b'));
    expect(actionKey('c1', 'x')).not.toBe(actionKey('c2', 'x'));
    expect(supplierOrderKey('c1', 'o1', 'L1')).toBe('rescue-ship:o1:L1:c1');
    expect(caseDedupeKey('o1', 'L1')).toBe('rescue:o1:L1');
  });
  const key = supplierOrderKey('c1', 'o1', 'L1');
  const g = (shipments: { id: string; status: string; supplierOrderId?: string; idempotencyKey?: string }[], ack = false) => duplicateOrderGuard({ supplierOrderKeyForCase: key, shipments, staffAcknowledgedDuplicateRisk: ack });
  it('allows when nothing is live', () => {
    expect(g([]).allow).toBe(true);
    expect(g([{ id: '1', status: 'FAILED' }, { id: '2', status: 'CANCELLED' }]).allow).toBe(true);
  });
  it('refuses a second reorder for the same case (restart / duplicate trigger)', () => {
    const d = g([{ id: '9', status: 'CREATED', supplierOrderId: 'S', idempotencyKey: key }]);
    expect(d).toMatchObject({ allow: false, code: 'already_reordered' });
  });
  it('refuses when the supplier may already hold a pending order', () => {
    expect(g([{ id: '1', status: 'PENDING_CREATE' }])).toMatchObject({ allow: false, code: 'maybe_with_supplier' });
  });
  it('requires cancel-first for a placed, undispatched supplier order', () => {
    const d = g([{ id: '1', status: 'CREATED', supplierOrderId: 'SO' }]);
    expect(d).toMatchObject({ allow: true });
    expect(d.allow && d.cancelFirst?.id).toBe('1');
  });
  it('refuses over a dispatched parcel unless staff acknowledge the risk', () => {
    expect(g([{ id: '1', status: 'IN_TRANSIT', supplierOrderId: 'SO' }])).toMatchObject({ allow: false, code: 'goods_in_transit' });
    expect(g([{ id: '1', status: 'IN_TRANSIT', supplierOrderId: 'SO' }], true)).toMatchObject({ allow: true, overrideUsed: true });
  });
  it('never over a delivered shipment; ambiguity refuses', () => {
    expect(g([{ id: '1', status: 'DELIVERED' }])).toMatchObject({ allow: false, code: 'delivered' });
    expect(g([{ id: '1', status: 'CREATED', supplierOrderId: 'a' }, { id: '2', status: 'SHIPPED', supplierOrderId: 'b' }])).toMatchObject({ allow: false, code: 'unconfirmed' });
    expect(g([{ id: '1', status: 'CREATED' }])).toMatchObject({ allow: false, code: 'maybe_with_supplier' });
  });
});

describe('retry', () => {
  it('backs off exponentially with a cap', () => {
    expect([1, 2, 3, 4].map((n) => retryDelayMs(n))).toEqual([60_000, 120_000, 240_000, 480_000]);
    expect(retryDelayMs(20)).toBe(3_600_000);
  });
  it('stops at the attempt cap or on non-retryable errors', () => {
    expect(decideRetry(1, 4, true)).toEqual({ retry: true, delayMs: 60_000 });
    expect(decideRetry(4, 4, true)).toEqual({ retry: false, reason: 'attempts_exhausted' });
    expect(decideRetry(1, 4, false)).toEqual({ retry: false, reason: 'non_retryable' });
  });
});
