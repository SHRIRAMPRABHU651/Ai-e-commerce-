import { describe, expect, it } from 'vitest';
import { feedConfigSchema, slaDefinitionSchema } from '@orvia/types';
import { mapFeedRow, parseCsv, parseFeed, parseMoney, FeedSupplierProvider } from '@orvia/suppliers';
import { ROLE_PERMISSIONS, can } from '@orvia/auth';
import { STAFF_ROLES } from '@orvia/types';
import {
  canActOnSupplier, checkTransition, computeSlaMetrics, decideDemotion, disputableAmount, effectiveStepStatus, evaluateBreaches, evaluatePriceAccuracy, evaluateReadiness, evaluateStockAccuracy,
  extractMeasures, intersectOwned, isValidTrackingNumber, normalizeGtin, parseStatementCsv, portalAddress, preProbationReadiness, reconcileStatement, redactValue, requiredStepKinds, routingEligibility,
  scoreMatch, titleSimilarity, validateManualEvidence, validUntilFor, canDisputeTransition, dHashFromGray9x8,
} from '../../packages/core/src/domain/suppliernet/pure';
import type { StepLike } from '../../packages/core/src/domain/suppliernet/pure';

const now = new Date('2026-06-01T00:00:00Z');
const day = 86_400_000;
const passed = (kind: StepLike['kind'], ageDays = 1): StepLike => { const at = new Date(now.getTime() - ageDays * day); return { kind, required: true, status: 'passed', passedAt: at, validUntil: validUntilFor(kind, at), evidence: [{ outcome: 'pass' }] }; };
const ALL = ['catalogue_availability', 'price_quote_accuracy', 'stock_accuracy_sample', 'test_order_placement', 'cancellation', 'shipment_tracking', 'delivery_observed'] as const;

describe('verification gating', () => {
  it('is ready only when every required step passed with evidence inside its window', () => {
    const steps = ALL.map((k) => passed(k));
    expect(evaluateReadiness(steps, now).ready).toBe(true);
    expect(evaluateReadiness(steps.slice(1), now)).toMatchObject({ ready: false, missing: ['catalogue_availability'] });
  });
  it('"API responds" alone is not production ready: a passed step with no passing evidence does not count', () => {
    const noEv: StepLike = { ...passed('catalogue_availability'), evidence: [{ outcome: 'info' }] };
    expect(effectiveStepStatus(noEv, now)).toBe('no_evidence');
    expect(evaluateReadiness([noEv], now, ['catalogue_availability']).ready).toBe(false);
  });
  it('expires steps after their validity window', () => {
    const old = passed('catalogue_availability', 91);
    expect(effectiveStepStatus(old, now)).toBe('expired');
    const r = evaluateReadiness([old, ...ALL.slice(1).map((k) => passed(k))], now);
    expect(r.ready).toBe(false);
    expect(r.expired).toEqual(['catalogue_availability']);
  });
  it('returns step is required only when the supplier accepts returns', () => {
    expect(requiredStepKinds({ returnsAccepted: false })).not.toContain('return_refund_handling');
    expect(requiredStepKinds({ returnsAccepted: true })).toContain('return_refund_handling');
    const steps = [...ALL.map((k) => passed(k)), { ...passed('return_refund_handling'), status: 'not_started' as const, passedAt: null, validUntil: null, evidence: [] }];
    expect(evaluateReadiness(steps, now).missing).toEqual(['return_refund_handling']);
  });
  it('a failed required step blocks and is reported', () => {
    const steps = [...ALL.slice(1).map((k) => passed(k)), { kind: 'catalogue_availability' as const, required: true, status: 'failed' as const, evidence: [{ outcome: 'fail' as const }] }];
    expect(evaluateReadiness(steps, now).failed).toEqual(['catalogue_availability']);
  });
  it('pre-probation set excludes delivery', () => {
    const steps = ALL.filter((k) => k !== 'delivery_observed').map((k) => passed(k));
    expect(preProbationReadiness(steps, now).ready).toBe(true);
    expect(evaluateReadiness(steps, now).ready).toBe(false);
  });
});

describe('production routing guard', () => {
  const future = new Date(now.getTime() + day);
  it('does nothing when enforcement is off (dev/test default)', () => expect(routingEligibility({}, false, now).ok).toBe(true));
  it('requires approved + production_ready + unexpired when enforced', () => {
    expect(routingEligibility({ network: { state: 'approved', productionReady: true, productionReadyUntil: future } }, true, now).ok).toBe(true);
    expect(routingEligibility({}, true, now).ok).toBe(false);
    expect(routingEligibility({ network: { state: 'probation', productionReady: true, productionReadyUntil: future } }, true, now).ok).toBe(false);
    expect(routingEligibility({ network: { state: 'approved', productionReady: false, productionReadyUntil: future } }, true, now).ok).toBe(false);
    expect(routingEligibility({ network: { state: 'approved', productionReady: true, productionReadyUntil: new Date(now.getTime() - 1) } }, true, now).reason).toMatch(/expired/);
    expect(routingEligibility({ network: { state: 'suspended', productionReady: true, productionReadyUntil: future } }, true, now).ok).toBe(false);
  });
  it('demotes an approved supplier on a critical SLA breach only', () => {
    expect(decideDemotion('approved', 'critical')).toMatchObject({ demote: true, to: 'probation' });
    expect(decideDemotion('approved', 'warning').demote).toBe(false);
    expect(decideDemotion('probation', 'critical').demote).toBe(false);
  });
});

describe('onboarding transitions', () => {
  const base = { from: 'invited' as const, to: 'profile_submitted' as const, profileComplete: true, requiredDocsVerified: false, integrationReady: false, preProbationPassed: false, productionReady: false, minProbationDays: 7, now };
  it('enforces order and gates', () => {
    expect(checkTransition(base).ok).toBe(true);
    expect(checkTransition({ ...base, profileComplete: false }).ok).toBe(false);
    expect(checkTransition({ ...base, from: 'invited', to: 'approved' }).ok).toBe(false);
    expect(checkTransition({ ...base, from: 'documents', to: 'technical_integration' }).blockers.join()).toMatch(/documents/);
    expect(checkTransition({ ...base, from: 'documents', to: 'technical_integration', requiredDocsVerified: true }).ok).toBe(true);
    expect(checkTransition({ ...base, from: 'technical_integration', to: 'verification' }).ok).toBe(false);
    expect(checkTransition({ ...base, from: 'verification', to: 'probation', requiredDocsVerified: true }).ok).toBe(false);
  });
  it('approval needs production_ready and a minimum probation', () => {
    const f = { ...base, from: 'probation' as const, to: 'approved' as const, requiredDocsVerified: true, preProbationPassed: true, productionReady: true };
    expect(checkTransition({ ...f, probationStartedAt: new Date(now.getTime() - 8 * day) }).ok).toBe(true);
    expect(checkTransition({ ...f, probationStartedAt: new Date(now.getTime() - 2 * day) }).ok).toBe(false);
    expect(checkTransition({ ...f, productionReady: false, probationStartedAt: new Date(now.getTime() - 8 * day) }).ok).toBe(false);
  });
  it('suspension needs a reason; reinstatement never goes straight to approved', () => {
    expect(checkTransition({ ...base, from: 'approved', to: 'suspended' }).ok).toBe(false);
    expect(checkTransition({ ...base, from: 'approved', to: 'suspended', reason: 'repeated late shipping' }).ok).toBe(true);
    expect(checkTransition({ ...base, from: 'suspended', to: 'approved', productionReady: true, requiredDocsVerified: true }).ok).toBe(false);
  });
});

describe('evidence rules', () => {
  it('manual attestation needs a concrete reference', () => {
    expect(validateManualEvidence('catalogue_availability', { summary: 'looked fine to me', outcome: 'pass' }).length).toBeGreaterThan(0);
    expect(validateManualEvidence('test_order_placement', { summary: 'placed through supplier portal', outcome: 'pass', externalReference: 'x' }).join()).toMatch(/supplier order id/);
    expect(validateManualEvidence('test_order_placement', { summary: 'placed through supplier portal', outcome: 'pass', supplierOrderId: 'SO-1' })).toEqual([]);
    expect(validateManualEvidence('price_quote_accuracy', { summary: 'compared invoice and quote', outcome: 'pass', supplierOrderId: 'SO-1' }).join()).toMatch(/quotedMinor/);
  });
  it('price accuracy and stock accuracy are computed, not asserted', () => {
    expect(evaluatePriceAccuracy(1000, 1010).ok).toBe(true);
    expect(evaluatePriceAccuracy(1000, 1100).ok).toBe(false);
    expect(evaluatePriceAccuracy(1000, 900).ok).toBe(true);
    expect(evaluateStockAccuracy([{ claimed: 10, observed: 10 }]).ok).toBe(false); // sample too small
    const good = Array.from({ length: 10 }, () => ({ claimed: 100, observed: 98 }));
    expect(evaluateStockAccuracy(good).ok).toBe(true);
    expect(evaluateStockAccuracy([...good.slice(0, 5), ...Array.from({ length: 5 }, () => ({ claimed: 20, observed: 0 }))]).ok).toBe(false);
  });
  it('redacts secrets and PII from evidence', () => {
    const r = redactValue({ apiKey: 'sk_live_123', headers: { Authorization: 'Bearer abc' }, to: { fullName: 'Jane Roe', line1: '1 Main St', country: 'US' }, note: 'mail a@b.com ref 1234567890123' }) as Record<string, any>;
    expect(JSON.stringify(r)).not.toMatch(/sk_live|Bearer|Jane|Main St|a@b\.com|1234567890123/);
    expect(r.to.country).toBe('US');
  });
});

describe('product matching', () => {
  it('normalises titles and measures', () => {
    expect(titleSimilarity('Spiral Slow Feeder Dog Bowl', 'slow-feeder DOG bowl spiral')).toBeGreaterThan(0.85);
    expect(titleSimilarity('Dog Bowl', 'Laptop Stand')).toBeLessThan(0.3);
    expect(extractMeasures('Water Bottle 1.5L').volumeMl).toEqual([1500]);
    expect(extractMeasures('Bottle 500 ml').volumeMl).toEqual([500]);
  });
  it('validates GTIN check digits', () => {
    expect(normalizeGtin('4006381333931')).toBe('04006381333931');
    expect(normalizeGtin('4006381333932')).toBeNull();
  });
  it('identical valid GTIN is high confidence even with different titles', () => {
    const r = scoreMatch({ title: 'Acme Pet Bowl', gtin: '4006381333931' }, { title: 'Stainless dish for dogs by Acme', gtin: '4006381333931' });
    expect(r.confidence).toBe('high');
    expect(r.score).toBeGreaterThanOrEqual(0.92);
    expect(r.reasons.some((x) => x.kind === 'gtin')).toBe(true);
  });
  it('different GTINs cap the score; different sizes and colours are conflicts', () => {
    expect(scoreMatch({ title: 'Acme Bottle 500ml', gtin: '4006381333931' }, { title: 'Acme Bottle 500ml', gtin: '5012345678900' }).score).toBeLessThanOrEqual(0.2);
    const size = scoreMatch({ title: 'Acme Water Bottle 500ml' }, { title: 'Acme Water Bottle 1L' });
    expect(size.conflicts.join()).toMatch(/volumeMl/);
    expect(size.confidence).not.toBe('high');
    expect(scoreMatch({ title: 'Mug', attributes: { color: 'Red' } }, { title: 'Mug', attributes: { color: 'Blue' } }).conflicts.join()).toMatch(/color/);
  });
  it('MPN + brand and image hashes add evidence with reasons', () => {
    const r = scoreMatch({ title: 'X-200 Trimmer', brand: 'Vox', mpn: 'X-200', imageHashes: ['ffff000000000000'] }, { title: 'Vox trimmer X200', brand: 'VOX', mpn: 'x200', imageHashes: ['ffff000000000001'] });
    expect(r.reasons.map((x) => x.kind)).toEqual(expect.arrayContaining(['mpn', 'brand', 'image']));
    expect(r.score).toBeGreaterThan(0.85);
  });
  it('dHash is deterministic', () => {
    const gray = Array.from({ length: 72 }, (_, i) => (i % 9) * 10);
    expect(dHashFromGray9x8(gray)).toBe('0000000000000000');
    expect(dHashFromGray9x8([...gray].reverse())).toBe('ffffffffffffffff');
  });
});

describe('SLA computation', () => {
  const def = slaDefinitionSchema.parse({});
  const facts = { windowDays: 30, assigned: 100, shipped: 97, failed: 1, cancelled: 2, overdueUnshipped: 0, deliveredWithEta: 80, deliveredOnTime: 76, delivered: 90, refunds: 3, defects: 1, stockChecks: 20, stockAccurate: 19, avgResponseMs: 900 };
  it('computes rates with sample sizes', () => {
    const m = computeSlaMetrics(facts, def);
    expect(m.fulfilmentRate.value).toBeCloseTo(97 / 98);
    expect(m.onTimeRate.value).toBeCloseTo(0.95);
    expect(m.cancellationRate.value).toBeCloseTo(0.02);
    expect(m.stockAccuracy.value).toBeCloseTo(0.95);
    expect(evaluateBreaches(m, def).worst).toBe('ok');
  });
  it('reports insufficient data instead of a score for small samples', () => {
    const m = computeSlaMetrics({ ...facts, assigned: 3, shipped: 3, cancelled: 0, deliveredWithEta: 2, deliveredOnTime: 0, delivered: 2, stockChecks: 0, stockAccurate: 0, avgResponseMs: null }, def);
    expect(m.fulfilmentRate.value).toBeNull();
    expect(m.onTimeRate.value).toBeNull();
    expect(evaluateBreaches(m, def).worst).toBe('insufficient_data');
  });
  it('distinguishes warning from critical breaches', () => {
    const warn = evaluateBreaches(computeSlaMetrics({ ...facts, deliveredOnTime: 70 }, def), def);
    expect(warn.breaches.find((b) => b.metric === 'onTimeRate')?.severity).toBe('warning');
    expect(warn.worst).toBe('warning');
    const crit = evaluateBreaches(computeSlaMetrics({ ...facts, shipped: 60 }, def), def);
    expect(crit.worst).toBe('critical');
  });
});

describe('statement reconciliation', () => {
  const rec = [
    { shipmentId: 's1', orderId: 'o1', orderNumber: 'ORV-1', supplierOrderId: 'SO-1', costMinor: 1000, fxConverted: false },
    { shipmentId: 's2', orderId: 'o2', orderNumber: 'ORV-2', supplierOrderId: 'SO-2', costMinor: 2000, fxConverted: false },
    { shipmentId: 's3', orderId: 'o3', orderNumber: 'ORV-3', supplierOrderId: 'SO-3', costMinor: 3000, fxConverted: true },
  ];
  it('matches, flags differences, unknown orders, duplicates and missing lines', () => {
    const r = reconcileStatement([
      { supplierOrderId: 'so-1', amountMinor: 1000 }, { supplierOrderId: 'SO-2', amountMinor: 2300 }, { supplierOrderId: 'SO-9', amountMinor: 500 }, { supplierOrderId: 'SO-1', amountMinor: 1000 },
    ], rec);
    expect(r.lines.map((l) => l.match)).toEqual(['matched', 'amount_difference', 'unknown_order', 'duplicate']);
    expect(r.lines[1]!.diffMinor).toBe(300);
    expect(r.missing.map((m) => m.supplierOrderId)).toEqual(['SO-3']);
    expect(r.status).toBe('discrepancies');
    expect(disputableAmount(r)).toBe(300 + 500 + 1000);
  });
  it('matches by order reference and tolerates FX rounding only on converted costs', () => {
    const r = reconcileStatement([{ orderRef: 'orv-3', amountMinor: 3050 }, { orderRef: 'ORV-1', amountMinor: 1005 }], rec);
    expect(r.lines[0]!.match).toBe('matched');
    expect(r.lines[1]!.match).toBe('amount_difference');
  });
  it('a clean statement is matched', () => {
    expect(reconcileStatement(rec.map((x) => ({ supplierOrderId: x.supplierOrderId, amountMinor: x.costMinor })), rec).status).toBe('matched');
  });
  it('parses statement CSV including credits and bad rows', () => {
    const p = parseStatementCsv('Supplier Order ID,Amount,Description\nSO-1,"$1,000.00",widget\nSO-2,(5.00),credit\nSO-3,abc,bad\n,5.00,noid');
    expect(p.lines).toEqual([{ supplierOrderId: 'SO-1', amountMinor: 100000, description: 'widget', orderRef: undefined }, { supplierOrderId: 'SO-2', amountMinor: -500, description: 'credit', orderRef: undefined }]);
    expect(p.errors.length).toBe(2);
    expect(parseStatementCsv('a,b\n1,2').lines).toEqual([]);
  });
});

describe('feed adapter mapping', () => {
  const cfg = feedConfigSchema.parse({ url: 'https://s.example/feed.csv', format: 'csv', fields: { id: 'sku', title: 'name', price: 'price', stock: 'qty', images: 'imgs', gtin: 'ean', shippingCost: 'ship' } });
  const csv = 'sku,name,price,qty,imgs,ean,ship\nA1,"Bowl, steel",$12.50,40,https://c.example/1.jpg|http://x/2.jpg,4006381333931,3.00\nA2,Broken,abc,5,,,\nA3,No stock,5,x,,,\n,NoId,1,1,,,';
  it('parses CSV with quotes, money and image filtering; rejects bad rows with reasons', () => {
    const r = parseFeed(csv, cfg);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ externalId: 'A1', title: 'Bowl, steel', priceMinor: 1250, stock: 40, shippingMinor: 300, gtin: '4006381333931', images: ['https://c.example/1.jpg'] });
    expect(r.errors.length).toBe(3);
  });
  it('maps JSON feeds with nested paths', () => {
    const c = feedConfigSchema.parse({ url: 'https://s.example/f.json', format: 'json', listPath: 'data.items', fields: { id: 'id', title: 'info.title', price: 'cost', stock: 'stock' } });
    const r = parseFeed(JSON.stringify({ data: { items: [{ id: 7, info: { title: 'Lamp' }, cost: 19.99, stock: 3 }] } }), c);
    expect(r.items[0]).toMatchObject({ externalId: '7', title: 'Lamp', priceMinor: 1999, stock: 3 });
  });
  it('money parsing is strict', () => {
    expect(parseMoney('19,99', 'major')).toBe(1999);
    expect(parseMoney('1,299.50', 'major')).toBe(129950);
    expect(parseMoney('-5', 'major')).toBeNull();
    expect(parseMoney('free', 'major')).toBeNull();
    expect(mapFeedRow({ sku: 'x', name: 'y', price: '1', qty: '-1' }, cfg).error).toMatch(/stock/);
  });
  it('provider is read-only, uses the injected (SSRF-safe) fetcher, caches, and never invents data', async () => {
    let calls = 0;
    const p = new FeedSupplierProvider('f', cfg, undefined, { fetchText: async () => { calls++; return { status: 200, text: csv }; } });
    expect((await p.getInventory('A1')).total).toBe(40);
    expect((await p.getPrice('A1', 'US')).productCost).toBe(1250);
    expect(calls).toBe(1);
    await expect(p.createOrder({} as never)).rejects.toThrow(/read-only/);
    await expect(p.getInventory('NOPE')).rejects.toThrow(/not in the feed/);
    const bad = new FeedSupplierProvider('f', cfg, undefined, { fetchText: async () => ({ status: 500, text: '' }) });
    expect((await bad.healthCheck()).ok).toBe(false);
    const priv = new FeedSupplierProvider('f', cfg, undefined, { fetchText: async () => { throw new Error('URL resolves to a private or reserved address'); } });
    expect((await priv.healthCheck()).message).toMatch(/private/);
    expect(() => new FeedSupplierProvider('f', { url: 'nope' }, undefined, { fetchText: async () => ({ status: 200, text: '' }) })).toThrow(/invalid feed mapping/);
  });
  it('csv parser handles CRLF, BOM and escaped quotes', () => {
    const r = parseCsv('﻿a,b\r\n"x ""q""",2\r\n');
    expect(r.rows).toEqual([{ a: 'x "q"', b: '2' }]);
  });
});

describe('tenant isolation predicates', () => {
  const supA = { _id: 'a', userIds: ['u1'] };
  const supB = { _id: 'b', userIds: ['u2'] };
  it('a supplier user may only act on suppliers linked to them', () => {
    expect(canActOnSupplier({ id: 'u1', role: 'SUPPLIER' }, supA)).toBe(true);
    expect(canActOnSupplier({ id: 'u1', role: 'SUPPLIER' }, supB)).toBe(false);
    expect(canActOnSupplier(null, supA)).toBe(false);
    expect(canActOnSupplier({ id: 'u1', role: 'SUPPLIER' }, { _id: 'c' })).toBe(false);
  });
  it('staff and customers never qualify, even when listed', () => {
    for (const role of ['ADMIN', 'SUPER_ADMIN', 'OPERATIONS', 'CUSTOMER']) expect(canActOnSupplier({ id: 'u1', role }, supA)).toBe(false);
  });
  it('requested ids are intersected with owned ids', () => {
    expect(intersectOwned(['a', 'b'], ['a'])).toEqual(['a']);
    expect(intersectOwned(['b'], ['a'])).toEqual([]);
  });
  it('portal address omits anything but shipping fields; tracking numbers are validated', () => {
    expect(portalAddress({ fullName: 'A', line1: 'x', email: 'a@b.c', cardLast4: '1' })).toEqual({ fullName: 'A', line1: 'x' });
    expect(isValidTrackingNumber('1Z999AA10123456784')).toBe(true);
    expect(isValidTrackingNumber('<script>')).toBe(false);
    expect(isValidTrackingNumber('ab')).toBe(false);
    expect(isValidTrackingNumber('abc def ghi')).toBe(false);
  });
});

describe('SUPPLIER role RBAC', () => {
  it('supplier holds only supplierportal permissions; staff roles never hold them; supplier is not staff', () => {
    expect(ROLE_PERMISSIONS.SUPPLIER).toEqual(['supplierportal:read', 'supplierportal:write']);
    for (const r of ['SUPER_ADMIN', 'ADMIN', 'OPERATIONS', 'SUPPORT', 'ANALYST', 'MARKETING'] as const) {
      expect(can(r, 'supplierportal:read')).toBe(false);
      expect(can(r, 'supplierportal:write')).toBe(false);
    }
    expect(can('SUPPLIER', 'suppliers:read')).toBe(false);
    expect(can('SUPPLIER', 'orders:read')).toBe(false);
    expect(STAFF_ROLES).not.toContain('SUPPLIER');
  });
});

describe('dispute state machine', () => {
  it('only allows defined transitions', () => {
    expect(canDisputeTransition('open', 'awaiting_supplier')).toBe(true);
    expect(canDisputeTransition('open', 'closed')).toBe(false);
    expect(canDisputeTransition('closed', 'open')).toBe(false);
    expect(canDisputeTransition('resolved_credit', 'closed')).toBe(true);
  });
});
